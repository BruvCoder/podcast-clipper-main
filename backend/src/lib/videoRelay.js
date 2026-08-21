import http from "http";
import { randomBytes } from "crypto";
import { createMediaRequestScope } from "./mediaProxy.js";

// YouTube's CDN refuses large or open-ended range requests on these URLs.
// Measured directly against a real URL:
//   no Range               -> 403
//   Range: bytes=0-        -> 403   (what ffmpeg always sends)
//   Range: bytes=0-2000    -> 206
//   Range: bytes=0-<eof>   -> 403   (bounded, but too big)
// So it isn't IP-, User-Agent-, or TLS-based blocking: it's an anti-bulk
// -download limit that only serves small, bounded chunks. ffmpeg has no
// option to chunk its reads that way, which is why every format 403'd.
//
// This relay sits on loopback and does the chunking: ffmpeg makes its
// normal open-ended request here, and Node satisfies it by fetching a
// sequence of small bounded ranges upstream and streaming them back as one
// continuous response. Seeking still works — ffmpeg's start offset is
// honoured, so only a clip's own window is transferred.
//
// Bound to loopback with an unguessable per-source token, so this is not an
// open proxy: only URLs this process registered can be reached through it.

// Upstream applies a cumulative throttle, not a flat size cap. Measured on a
// real URL: from a cold start any size up to 1MB is served, but after ~7MB
// has been delivered, 256KB+ requests start returning 403 while 64-128KB
// requests keep succeeding. 128KB therefore keeps working for the whole of a
// long read, where 512KB dies partway through and corrupts the render.
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const CHUNK_BYTES = positiveInteger(process.env.VIDEO_RELAY_CHUNK_BYTES, 128 * 1024);
// How many chunk requests to keep in flight. Upstream latency dominates, so
// this is the main lever on render speed — but too many at once gets
// rate-limited, so it trades against reliability.
const READ_AHEAD = positiveInteger(process.env.VIDEO_RELAY_READ_AHEAD, 6);
const CHUNK_ATTEMPTS = positiveInteger(process.env.VIDEO_RELAY_CHUNK_ATTEMPTS, 4);
const CONNECT_TIMEOUT_MS = positiveInteger(process.env.VIDEO_RELAY_CONNECT_TIMEOUT_MS, 10_000);
const HEADERS_TIMEOUT_MS = positiveInteger(process.env.VIDEO_RELAY_HEADERS_TIMEOUT_MS, 15_000);
const BODY_TIMEOUT_MS = positiveInteger(process.env.VIDEO_RELAY_BODY_TIMEOUT_MS, 20_000);
const TOTAL_TIMEOUT_MS = positiveInteger(process.env.VIDEO_RELAY_TOTAL_TIMEOUT_MS, 5 * 60_000);
const MAX_REDIRECTS = positiveInteger(process.env.VIDEO_RELAY_MAX_REDIRECTS, 5);
const RETRYABLE_CHUNK_STATUS = new Set([403, 408, 429, 500, 502, 503, 504]);

const relay = {
  server: null,
  port: null,
  sources: new Map(), // token -> { url, headers, totalBytes }
};

function abortError(signal, fallbackMessage = "upstream request was cancelled") {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : fallbackMessage);
  error.name = "AbortError";
  return error;
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function createUpstreamContext() {
  const controller = new AbortController();
  const requestScope = createMediaRequestScope({ connectTimeoutMs: CONNECT_TIMEOUT_MS });
  let requestScopeDestroyed = false;

  const abort = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason || "relay aborted"));
    if (!controller.signal.aborted) controller.abort(error);
    if (requestScope && !requestScopeDestroyed) {
      requestScopeDestroyed = true;
      requestScope.destroy(error).catch(() => {});
    }
  };

  const totalTimer = setTimeout(() => {
    abort(new Error(`upstream relay exceeded its ${TOTAL_TIMEOUT_MS}ms total deadline`));
  }, TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();

  return {
    abort,
    requestScope,
    signal: controller.signal,
    async close() {
      clearTimeout(totalTimer);
      if (requestScope && !requestScopeDestroyed) {
        await requestScope.close().catch(() => {});
      }
    },
  };
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value == null ? null : String(value);
}

async function cancelUpstreamBody(response, { drain = false } = {}) {
  const body = response?.body;
  if (!body) return;
  try {
    if (drain && typeof body.dump === "function") {
      await body.dump({ limit: 64 * 1024 });
    } else if (typeof body.cancel === "function") {
      await body.cancel();
    } else if (typeof body.destroy === "function") {
      body.on?.("error", () => {});
      body.destroy();
    } else if (typeof body.resume === "function") {
      body.resume();
    }
  } catch {
    // Cancellation is cleanup; the original status/request error is clearer.
  }
}

async function requestUpstream(context, url, headers) {
  let currentUrl;
  try {
    currentUrl = new URL(url);
  } catch {
    throw new Error("upstream media URL is invalid");
  }
  if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
    throw new Error(`upstream media URL uses unsupported protocol ${currentUrl.protocol}`);
  }
  if (currentUrl.username || currentUrl.password) {
    throw new Error("upstream media URL must not contain credentials");
  }
  const blockedRequestHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "proxy-authorization",
    "transfer-encoding",
  ]);
  let currentHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(
      ([name, value]) => value != null && !blockedRequestHeaders.has(name.toLowerCase())
    )
  );

  for (let redirectCount = 0; ; redirectCount++) {
    const headerTimer = setTimeout(() => {
      context.abort(new Error(`upstream headers exceeded the ${HEADERS_TIMEOUT_MS}ms deadline`));
    }, HEADERS_TIMEOUT_MS);
    headerTimer.unref?.();

    let response;
    try {
      const requestPromise = context.requestScope
        ? context.requestScope
            .request(currentUrl, {
              method: "GET",
              headers: currentHeaders,
              signal: context.signal,
              headersTimeout: HEADERS_TIMEOUT_MS,
              bodyTimeout: BODY_TIMEOUT_MS,
            })
            .then(({ body, headers: responseHeaders, statusCode }) => ({
              body,
              headers: responseHeaders,
              status: statusCode,
            }))
        : fetch(currentUrl, {
            headers: currentHeaders,
            redirect: "manual",
            signal: context.signal,
          }).then((directResponse) => ({
            body: directResponse.body,
            headers: directResponse.headers,
            status: directResponse.status,
          }));
      response = await raceWithSignal(requestPromise, context.signal);
    } finally {
      clearTimeout(headerTimer);
    }

    if (response.status < 300 || response.status >= 400) return response;
    const location = headerValue(response.headers, "location");
    await cancelUpstreamBody(response);
    if (!location) throw new Error(`upstream redirect HTTP ${response.status} omitted Location`);
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(`upstream exceeded the ${MAX_REDIRECTS}-redirect limit`);
    }

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error("upstream redirect Location is invalid");
    }
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new Error(`upstream redirect uses unsupported protocol ${nextUrl.protocol}`);
    }
    if (nextUrl.username || nextUrl.password) {
      throw new Error("upstream redirect must not contain credentials");
    }
    if (nextUrl.origin !== currentUrl.origin) {
      const sensitive = new Set(["authorization", "cookie", "proxy-authorization"]);
      currentHeaders = Object.fromEntries(
        Object.entries(currentHeaders).filter(([name]) => !sensitive.has(name.toLowerCase()))
      );
    }
    currentUrl = nextUrl;
  }
}

async function readUpstreamBody(context, response, expectedBytes) {
  const chunks = [];
  let received = 0;
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      context.abort(new Error(`upstream body was idle for ${BODY_TIMEOUT_MS}ms`));
    }, BODY_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const onAbort = () => {
    const error = abortError(context.signal);
    if (typeof response.body?.destroy === "function") response.body.destroy(error);
    else response.body?.cancel?.(error).catch?.(() => {});
  };

  context.signal.addEventListener("abort", onAbort, { once: true });
  resetIdleTimer();
  try {
    for await (const chunk of response.body) {
      if (context.signal.aborted) throw abortError(context.signal);
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > expectedBytes) {
        throw new Error(
          `upstream returned more than ${expectedBytes} bytes for a bounded range request`
        );
      }
      chunks.push(buffer);
      resetIdleTimer();
    }
  } finally {
    clearTimeout(idleTimer);
    context.signal.removeEventListener("abort", onAbort);
  }

  if (received !== expectedBytes) {
    throw new Error(`upstream range ended at ${received} bytes; expected ${expectedBytes}`);
  }
  return Buffer.concat(chunks, received);
}

function waitWithSignal(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Asks upstream for one byte to learn the resource's total length. */
async function fetchTotalBytes(source, context) {
  if (source.totalBytes != null) return source.totalBytes;
  const response = await requestUpstream(context, source.url, {
    ...source.headers,
    Range: "bytes=0-0",
  });
  if (response.status !== 200 && response.status !== 206) {
    await cancelUpstreamBody(response);
    throw new Error(`upstream probe failed with HTTP ${response.status}`);
  }
  const contentRange = headerValue(response.headers, "content-range") || "";
  await cancelUpstreamBody(response, { drain: true });
  const match = /\/(\d+)\s*$/.exec(contentRange);
  source.totalBytes = match ? Number(match[1]) : null;
  if (source.totalBytes == null) throw new Error("upstream did not report a total size");
  return source.totalBytes;
}

/** Parses a Range header into [start, end] (inclusive), clamped to total. */
function parseRange(rangeHeader, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader || "").trim());
  if (!m) return { start: 0, end: total - 1, hadRange: false };
  const [, rawStart, rawEnd] = m;
  if (rawStart === "") {
    // Suffix form: last N bytes.
    const len = Number(rawEnd || 0);
    return { start: Math.max(0, total - len), end: total - 1, hadRange: true };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  return { start, end, hadRange: true };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const token = (req.url || "").split("?")[0].replace(/^\//, "");
      const source = relay.sources.get(token);
      if (!source) {
        res.writeHead(404).end("unknown source");
        return;
      }

      const upstreamContext = createUpstreamContext();
      let consumerClosed = false;
      const onConsumerClose = () => {
        if (res.writableEnded) return;
        consumerClosed = true;
        upstreamContext.abort(new Error("relay consumer closed the connection"));
      };
      res.once("close", onConsumerClose);

      try {
        const total = await fetchTotalBytes(source, upstreamContext);
        const { start, end, hadRange } = parseRange(req.headers.range, total);

        if (start >= total || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
          return;
        }

        const length = end - start + 1;
        const headers = {
          "Content-Length": String(length),
          "Accept-Ranges": "bytes",
          "Content-Type": "video/mp4",
        };
        if (hadRange) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        res.writeHead(hadRange ? 206 : 200, headers);

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        // Walk the requested span in chunks small enough for upstream to
        // serve. Each chunk is its own HTTPS round trip, so fetching them
        // strictly one-at-a-time made renders unusably slow (a real render
        // blew past a 5-minute timeout). Keep several requests in flight and
        // write them out in order, so latency overlaps instead of stacking.
        const spans = [];
        for (let pos = start; pos <= end; pos += CHUNK_BYTES) {
          spans.push([pos, Math.min(pos + CHUNK_BYTES - 1, end)]);
        }

        // Upstream rate-limits when several chunk requests land at once, so a
        // chunk failing is expected occasionally rather than fatal. Retry it
        // before giving up — losing one chunk corrupts the whole stream.
        const fetchSpan = async ([from, to]) => {
          let lastErr;
          for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
            if (upstreamContext.signal.aborted) throw abortError(upstreamContext.signal);
            try {
              const upstream = await requestUpstream(upstreamContext, source.url, {
                ...source.headers,
                Range: `bytes=${from}-${to}`,
              });
              if (upstream.status === 206 || upstream.status === 200) {
                const expectedBytes = to - from + 1;
                const contentRange = headerValue(upstream.headers, "content-range") || "";
                if (upstream.status === 206) {
                  const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange);
                  if (!match || Number(match[1]) !== from || Number(match[2]) !== to) {
                    await cancelUpstreamBody(upstream);
                    throw new Error(
                      `upstream returned an invalid Content-Range for bytes ${from}-${to}`
                    );
                  }
                }
                try {
                  return await readUpstreamBody(upstreamContext, upstream, expectedBytes);
                } catch (error) {
                  await cancelUpstreamBody(upstream);
                  throw error;
                }
              }
              lastErr = new Error(`upstream chunk ${from}-${to} failed with HTTP ${upstream.status}`);
              await cancelUpstreamBody(upstream);
              if (!RETRYABLE_CHUNK_STATUS.has(upstream.status)) {
                lastErr.code = "ERR_NON_RETRYABLE_UPSTREAM_STATUS";
                throw lastErr;
              }
            } catch (err) {
              lastErr = err;
              if (err?.code === "ERR_NON_RETRYABLE_UPSTREAM_STATUS") throw err;
            }
            if (upstreamContext.signal.aborted) throw abortError(upstreamContext.signal);
            if (attempt < CHUNK_ATTEMPTS) {
              // Back off generously: these 403s are a throttle, so the useful
              // response is to wait it out rather than retry immediately.
              await waitWithSignal(
                500 * 2 ** (attempt - 1) + Math.random() * 250,
                upstreamContext.signal
              );
            }
          }
          throw lastErr;
        };

        const inFlight = new Map();
        const schedule = (index) => {
          if (index >= spans.length || upstreamContext.signal.aborted) return;
          const promise = fetchSpan(spans[index]);
          // Mark handled so an early abort can't surface an unhandled
          // rejection; awaiting the same promise below still throws.
          promise.catch(() => {});
          inFlight.set(index, promise);
        };
        for (let i = 0; i < Math.min(READ_AHEAD, spans.length); i++) schedule(i);

        for (let i = 0; i < spans.length && !upstreamContext.signal.aborted; i++) {
          const buf = await inFlight.get(i);
          inFlight.delete(i);
          schedule(i + READ_AHEAD);
          if (upstreamContext.signal.aborted) break;
          if (!res.write(buf)) {
            await raceWithSignal(
              new Promise((resolve) => res.once("drain", resolve)),
              upstreamContext.signal
            );
          }
        }
        res.end();
      } catch (err) {
        upstreamContext.abort(err);
        if (consumerClosed) return; // ffmpeg moved on; not an error worth surfacing
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`relay error: ${err.message}`);
          return;
        }
        // Headers (including Content-Length) are already sent, so ending
        // cleanly here would hand ffmpeg a silently truncated file — it then
        // renders an audio-only clip and still exits 0. Destroying the socket
        // makes ffmpeg treat it as the read error it actually is.
        console.error(`Video relay failed mid-stream: ${err.message}`);
        res.destroy(err);
      } finally {
        res.removeListener("close", onConsumerClose);
        await upstreamContext.close();
      }
    });

    server.on("error", reject);
    // Loopback only — never expose this to the network.
    server.listen(0, "127.0.0.1", () => {
      relay.server = server;
      relay.port = server.address().port;
      server.unref();
      resolve();
    });
  });
}

/**
 * Registers a remote media URL and returns a loopback URL that ffmpeg/ffprobe
 * can read instead. Optional `headers` are sent on the upstream requests.
 */
export async function relayUrl(url, headers = {}) {
  if (!relay.server) await startServer();
  const token = randomBytes(16).toString("hex");
  relay.sources.set(token, { url, headers, totalBytes: null });
  return { url: `http://127.0.0.1:${relay.port}/${token}`, token };
}

/** Drops a registered source once its job no longer needs it. */
export function releaseRelay(token) {
  if (token) relay.sources.delete(token);
}
