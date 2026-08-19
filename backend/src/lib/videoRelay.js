import http from "http";
import { randomBytes } from "crypto";
import { mediaFetch } from "./mediaProxy.js";

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
const CHUNK_BYTES = Number.parseInt(process.env.VIDEO_RELAY_CHUNK_BYTES, 10) || 128 * 1024;
// How many chunk requests to keep in flight. Upstream latency dominates, so
// this is the main lever on render speed — but too many at once gets
// rate-limited, so it trades against reliability.
const READ_AHEAD = Number.parseInt(process.env.VIDEO_RELAY_READ_AHEAD, 10) || 6;
const CHUNK_ATTEMPTS = Number.parseInt(process.env.VIDEO_RELAY_CHUNK_ATTEMPTS, 10) || 4;
const RETRYABLE_CHUNK_STATUS = new Set([403, 408, 429, 500, 502, 503, 504]);

const relay = {
  server: null,
  port: null,
  sources: new Map(), // token -> { url, headers, totalBytes }
};

/** Asks upstream for one byte to learn the resource's total length. */
async function fetchTotalBytes(source) {
  if (source.totalBytes != null) return source.totalBytes;
  const res = await mediaFetch(source.url, {
    headers: { ...source.headers, Range: "bytes=0-0" },
    redirect: "follow",
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`upstream probe failed with HTTP ${res.status}`);
  }
  res.body?.cancel?.();
  const match = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
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

      let aborted = false;
      res.on("close", () => {
        aborted = true;
      });

      try {
        const total = await fetchTotalBytes(source);
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
            if (aborted) throw new Error("client aborted");
            try {
              const upstream = await mediaFetch(source.url, {
                headers: { ...source.headers, Range: `bytes=${from}-${to}` },
                redirect: "follow",
              });
              if (upstream.status === 206 || upstream.status === 200) {
                return Buffer.from(await upstream.arrayBuffer());
              }
              lastErr = new Error(`upstream chunk ${from}-${to} failed with HTTP ${upstream.status}`);
              if (!RETRYABLE_CHUNK_STATUS.has(upstream.status)) throw lastErr;
            } catch (err) {
              lastErr = err;
            }
            if (attempt < CHUNK_ATTEMPTS) {
              // Back off generously: these 403s are a throttle, so the useful
              // response is to wait it out rather than retry immediately.
              await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1) + Math.random() * 250));
            }
          }
          throw lastErr;
        };

        const inFlight = new Map();
        const schedule = (index) => {
          if (index >= spans.length || aborted) return;
          const promise = fetchSpan(spans[index]);
          // Mark handled so an early abort can't surface an unhandled
          // rejection; awaiting the same promise below still throws.
          promise.catch(() => {});
          inFlight.set(index, promise);
        };
        for (let i = 0; i < Math.min(READ_AHEAD, spans.length); i++) schedule(i);

        for (let i = 0; i < spans.length && !aborted; i++) {
          const buf = await inFlight.get(i);
          inFlight.delete(i);
          schedule(i + READ_AHEAD);
          if (aborted) break;
          if (!res.write(buf)) {
            await new Promise((r) => res.once("drain", r));
          }
        }
        res.end();
      } catch (err) {
        if (aborted) return; // ffmpeg moved on; not an error worth surfacing
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
