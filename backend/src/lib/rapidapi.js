import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { relayUrl, releaseRelay } from "./videoRelay.js";

// Two providers, combined: one supplies a video stream and the other supplies
// audio. The video endpoint returns every available format; we rank
// candidates locally and prefer a modest H.264/mp4 format — not to avoid a
// transcode (we don't do one: only the audio track and short per-clip
// renders ever get downloaded), but because it's the most reliably
// seekable format for ffmpeg to read directly over the network later.
const VIDEO_HOST =
  process.env.VIDEO_RAPIDAPI_HOST || "cloud-api-hub-youtube-downloader.p.rapidapi.com";
const AUDIO_HOST = process.env.AUDIO_RAPIDAPI_HOST || "youtube-mp36.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const API_TIMEOUT_MS = positiveInteger(process.env.RAPIDAPI_TIMEOUT_MS, 30_000);
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = positiveInteger(
  process.env.DOWNLOAD_INACTIVITY_TIMEOUT_MS,
  45_000
);
const DOWNLOAD_TOTAL_TIMEOUT_MS = positiveInteger(
  process.env.DOWNLOAD_TOTAL_TIMEOUT_MS,
  30 * 60_000
);
const PROBE_TIMEOUT_MS = positiveInteger(process.env.PROBE_TIMEOUT_MS, 45_000);
const METADATA_TIMEOUT_MS = positiveInteger(process.env.METADATA_TIMEOUT_MS, 15_000);
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TARGET_SHORT_EDGE = 720;
const MIN_MEDIA_DURATION_SEC = 1;


function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireApiKey() {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      "RAPIDAPI_KEY is not set. Get a key from RapidAPI (subscribe to both " +
        '"Cloud API Hub - YouTube Downloader" and "YouTube MP3" under the same account) ' +
        "and add it to backend/.env."
    );
  }
}

function extractVideoId(youtubeUrl) {
  const invalid = () => new Error(`Could not extract a YouTube video ID from: ${youtubeUrl}`);
  if (typeof youtubeUrl !== "string") throw invalid();

  let url;
  try {
    url = new URL(youtubeUrl.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid();

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  let videoId = null;
  if (hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] || null;
  } else if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      videoId = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1] || null;
    }
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) throw invalid();
  return videoId;
}

function abortError(signal, fallbackMessage = "Operation was cancelled") {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : fallbackMessage);
  err.name = "AbortError";
  return err;
}

const FATAL_FORMAT_ERROR_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

function isFatalFormatAttemptError(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (FATAL_FORMAT_ERROR_CODES.has(current.code)) return true;
    const message = String(current.message || current);
    if (
      /failed to start ffmpeg|failed to start ffprobe|ffmpeg timed out|ffprobe timed out|no space left on device|disk quota exceeded|read-only file system|permission denied|cannot allocate memory|too many open files|unknown encoder/i.test(
        message
      )
    ) {
      return true;
    }
  }
  return false;
}

function emitProgress(onProgress, message) {
  if (!onProgress) return;
  try {
    onProgress(message);
  } catch (err) {
    // UI/status reporting must never corrupt an otherwise healthy download.
    console.warn("Download progress callback failed:", err);
  }
}

function providerErrorMessage(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return "empty response body";
  try {
    const data = JSON.parse(text);
    return data?.error || data?.message || data?.msg || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** GET a JSON response from a RapidAPI host, attaching the standard headers. */
function rapidApiGet(hostname, requestPath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    let settled = false;
    let req;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => req?.destroy(abortError(signal));

    req = https.request(
      {
        method: "GET",
        hostname,
        path: requestPath,
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": hostname,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        let received = 0;

        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > MAX_API_RESPONSE_BYTES) {
            res.destroy(
              new Error(`Response from ${hostname} exceeded ${MAX_API_RESPONSE_BYTES} bytes`)
            );
            return;
          }
          chunks.push(chunk);
        });
        res.once("aborted", () =>
          finish(new Error(`Response from ${hostname} was aborted before it completed`))
        );
        res.once("error", (err) =>
          finish(new Error(`Response error from ${hostname}: ${err.message}`, { cause: err }))
        );
        res.once("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return finish(
              new Error(
                `RapidAPI request to ${hostname} failed with HTTP ${res.statusCode}: ${providerErrorMessage(
                  body
                )}`
              )
            );
          }
          try {
            finish(null, JSON.parse(body.toString("utf8")));
          } catch (err) {
            finish(
              new Error(`Failed to parse JSON response from ${hostname}: ${err.message}`, {
                cause: err,
              })
            );
          }
        });
      }
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy(new Error(`RapidAPI request to ${hostname} timed out after ${API_TIMEOUT_MS}ms`));
    });
    req.once("error", (err) => finish(err));
    req.end();
  });
}

function validateDownloadUrl(value, baseUrl) {
  let parsed;
  try {
    parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    throw new Error(`Provider returned an invalid download URL: ${String(value).slice(0, 120)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing download URL with unsupported protocol ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Refusing a download URL containing embedded credentials");
  }
  return parsed;
}

function sanitizeRequestHeaders(headers) {
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "range",
    "transfer-encoding",
  ]);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name, value]) => {
      return value != null && !blocked.has(name.toLowerCase());
    })
  );
}

/** Formats a headers object as ffmpeg/ffprobe's `-headers` option expects. */
function buildFfmpegHeaderString(headers) {
  return Object.entries(headers || {})
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
}

function headersForRedirect(headers, previousUrl, nextUrl) {
  if (previousUrl.origin === nextUrl.origin) return headers;
  const sensitive = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-rapidapi-host",
    "x-rapidapi-key",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase()))
  );
}

function requestDownloadResponse(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    let req;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => req?.destroy(abortError(signal));

    req = client.get(url, { headers }, (res) => finish(null, res));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(DOWNLOAD_INACTIVITY_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Download connection was idle for ${DOWNLOAD_INACTIVITY_TIMEOUT_MS}ms`)
      );
    });
    req.once("error", (err) => finish(err));
  });
}

async function responseSnippet(res, limit = 64 * 1024) {
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of res) {
      const remaining = limit - received;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      received += Math.min(chunk.length, remaining);
      if (received >= limit) break;
    }
  } finally {
    res.destroy();
  }
  return Buffer.concat(chunks).toString("utf8").trim().slice(0, 300);
}

async function openDownloadResponse(initialUrl, { headers, signal, maxRedirects }) {
  let currentUrl = validateDownloadUrl(initialUrl);
  let currentHeaders = sanitizeRequestHeaders(headers);

  for (let redirectCount = 0; ; redirectCount++) {
    const res = await requestDownloadResponse(currentUrl, { headers: currentHeaders, signal });
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400;

    if (isRedirect) {
      const location = res.headers.location;
      // The redirect body is irrelevant. Stop it immediately so a provider
      // cannot make us drain an unbounded body before following Location.
      // Swallow any late socket error from the intentionally destroyed stream.
      res.on("error", () => {});
      res.destroy();
      if (!location) {
        throw new Error(`Download redirect (HTTP ${res.statusCode}) did not include a Location header`);
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`Download exceeded the ${maxRedirects}-redirect limit`);
      }
      const nextUrl = validateDownloadUrl(location, currentUrl);
      currentHeaders = headersForRedirect(currentHeaders, currentUrl, nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (res.statusCode !== 200) {
      const detail = await responseSnippet(res);
      throw new Error(
        `Download failed with HTTP ${res.statusCode}${detail ? `: ${detail}` : ""}`
      );
    }

    res.setTimeout(DOWNLOAD_INACTIVITY_TIMEOUT_MS, () => {
      res.destroy(new Error(`Download stream was idle for ${DOWNLOAD_INACTIVITY_TIMEOUT_MS}ms`));
    });
    return { res, finalUrl: currentUrl };
  }
}

function createByteProgress(label, onProgress) {
  let lastPercent = -1;
  let lastReportAt = 0;
  return (received, total) => {
    const now = Date.now();
    if (total) {
      const percent = Math.min(100, Math.floor((received / total) * 100));
      if (percent !== 100 && percent < lastPercent + 2 && now - lastReportAt < 2_000) return;
      lastPercent = percent;
      lastReportAt = now;
      emitProgress(
        onProgress,
        `${label}: ${percent}% (${(received / 1024 / 1024).toFixed(1)} of ${(
          total /
          1024 /
          1024
        ).toFixed(1)} MB)`
      );
      return;
    }
    if (now - lastReportAt >= 1_000) {
      lastReportAt = now;
      emitProgress(onProgress, `${label}: ${(received / 1024 / 1024).toFixed(1)} MB received`);
    }
  };
}

/**
 * Streams a direct CDN URL to a temporary file and atomically promotes it to
 * destPath. Redirects are resolved relative to the current URL, sensitive
 * headers are dropped across origins, and every error path removes the partial
 * file.
 */
async function downloadToFile(
  url,
  destPath,
  { headers = {}, onProgress, redirectsLeft = MAX_REDIRECTS, signal, label = "Downloading" } = {}
) {
  const partPath = `${destPath}.${randomUUID()}.part`;
  let activeResponse;
  const totalTimer = setTimeout(() => {
    activeResponse?.destroy(
      new Error(`Download exceeded the ${Math.round(DOWNLOAD_TOTAL_TIMEOUT_MS / 60_000)}-minute limit`)
    );
  }, DOWNLOAD_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();

  try {
    const opened = await openDownloadResponse(url, {
      headers,
      signal,
      maxRedirects: redirectsLeft,
    });
    activeResponse = opened.res;

    const contentType = String(activeResponse.headers["content-type"] || "").toLowerCase();
    if (contentType.startsWith("text/") || contentType.includes("application/json")) {
      const detail = await responseSnippet(activeResponse);
      throw new Error(
        `Provider returned ${contentType || "a non-media response"}${detail ? `: ${detail}` : ""}`
      );
    }

    const contentLength = Number.parseInt(activeResponse.headers["content-length"], 10);
    const total = Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
    const reportBytes = createByteProgress(label, onProgress);
    let received = 0;
    reportBytes(0, total);

    const counter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        reportBytes(received, total);
        callback(null, chunk);
      },
    });
    const file = fs.createWriteStream(partPath, { flags: "wx" });
    if (signal) await pipeline(activeResponse, counter, file, { signal });
    else await pipeline(activeResponse, counter, file);

    if (total != null && received !== total) {
      throw new Error(`Download ended at ${received} bytes; expected ${total} bytes`);
    }
    if (received === 0) throw new Error("Download returned an empty response body");

    await fs.promises.rm(destPath, { force: true });
    await fs.promises.rename(partPath, destPath);
    reportBytes(received, total || received);
    return destPath;
  } catch (err) {
    throw new Error(`${label} failed: ${err.message}`, { cause: err });
  } finally {
    clearTimeout(totalTimer);
    activeResponse?.destroy();
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
  }
}

function appendTail(current, next, limit = 12_000) {
  const combined = current + next;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

/**
 * Returns ffprobe's stream and container metadata for a media source —
 * either a local file path or a remote http(s) URL. For a remote URL,
 * ffprobe only fetches the metadata it needs (typically the container
 * header), not the whole file.
 */
function probeMedia(input, { headers, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error"];
    if (headers && Object.keys(headers).length) {
      args.push("-headers", buildFfmpegHeaderString(headers));
    }
    args.push(
      "-show_entries",
      "format=duration,size,format_name:stream=codec_type,codec_name,width,height,duration",
      "-of",
      "json",
      input
    );

    const proc = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(new Error(`ffprobe timed out while reading ${input}`));
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on("data", (data) => {
      stdout = appendTail(stdout, data.toString(), MAX_API_RESPONSE_BYTES);
    });
    proc.stderr.on("data", (data) => {
      stderr = appendTail(stderr, data.toString());
    });
    proc.once("error", (err) =>
      finish(new Error(`Failed to start ffprobe. Is it installed and on PATH? (${err.message})`))
    );
    proc.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        return finish(
          new Error(`ffprobe failed on ${input}: ${stderr.trim().slice(-1_000) || `exit code ${code}`}`)
        );
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch (err) {
        finish(new Error(`ffprobe returned invalid JSON for ${input}: ${err.message}`));
      }
    });
  });
}

function mediaDuration(info) {
  const containerDuration = Number(info?.format?.duration);
  if (Number.isFinite(containerDuration) && containerDuration > 0) return containerDuration;
  const streamDurations = (info?.streams || [])
    .map((stream) => Number(stream.duration))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  return streamDurations.length ? Math.max(...streamDurations) : null;
}

/**
 * Throws if a media source is empty/unreachable, truncated-looking, or
 * missing required streams. `input` may be a local file path (checked for
 * existence/size first) or a remote http(s) URL (probed directly, with
 * optional request `headers`).
 */
async function assertValidMedia(
  input,
  expectedTypes,
  label,
  { expectedH264 = false, maxShortEdge = null, headers, timeoutMs } = {}
) {
  const requiredTypes = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
  const isRemote = /^https?:\/\//i.test(input);

  if (!isRemote) {
    let stat;
    try {
      stat = await fs.promises.stat(input);
    } catch {
      throw new Error(`${label} download is missing (${input}). The provider link may have expired.`);
    }
    const minimumBytes = requiredTypes.includes("video") ? 4_096 : 1_024;
    if (!stat.isFile() || stat.size < minimumBytes) {
      throw new Error(
        `${label} download is implausibly small (${stat.size} bytes; expected at least ${minimumBytes}).`
      );
    }
  }

  let info;
  try {
    info = await probeMedia(input, { headers, timeoutMs });
  } catch (err) {
    throw new Error(
      `${label} ${isRemote ? "isn't reachable or readable" : "download isn't a readable media file"}: ${err.message}`,
      { cause: err }
    );
  }

  const streams = info.streams || [];
  for (const type of requiredTypes) {
    if (!streams.some((stream) => stream.codec_type === type)) {
      const found = [...new Set(streams.map((stream) => stream.codec_type).filter(Boolean))];
      throw new Error(
        `${label} doesn't contain a ${type} stream (found: ${found.join(", ") || "nothing"}). ` +
          "The provider may have returned the wrong file."
      );
    }
  }

  const durationSec = mediaDuration(info);
  if (!Number.isFinite(durationSec) || durationSec < MIN_MEDIA_DURATION_SEC) {
    throw new Error(
      `${label} duration is ${durationSec == null ? "missing" : `${durationSec.toFixed(2)}s`}; ` +
        `expected at least ${MIN_MEDIA_DURATION_SEC}s.`
    );
  }

  const videoStream = streams.find((stream) => stream.codec_type === "video");
  if (videoStream && (requiredTypes.includes("video") || expectedH264 || maxShortEdge)) {
    const width = Number(videoStream.width);
    const height = Number(videoStream.height);
    if (!(width > 0) || !(height > 0)) {
      throw new Error(`${label} video stream has invalid dimensions (${width}x${height}).`);
    }
    if (expectedH264 && !/^(h264|avc1)/i.test(videoStream.codec_name || "")) {
      throw new Error(
        `${label} was expected to be H.264 but ffprobe found ${videoStream.codec_name || "an unknown codec"}.`
      );
    }
    if (maxShortEdge && Math.min(width, height) > maxShortEdge) {
      throw new Error(
        `${label} is ${width}x${height}; expected its short edge to be at most ${maxShortEdge}px.`
      );
    }
  }

  return { ...info, durationSec, videoStream };
}

function normalizeVideoFormats(data) {
  const formats = Array.isArray(data)
    ? data
    : Array.isArray(data?.formats)
      ? data.formats
      : Array.isArray(data?.data)
        ? data.data
        : data?.url
          ? [data]
          : [];

  return formats.filter((format) => {
    if (!format || typeof format.url !== "string" || format.has_drm === true) return false;
    let url;
    try {
      url = validateDownloadUrl(format.url);
    } catch {
      return false;
    }
    const protocol = String(format.protocol || url.protocol.replace(":", "")).toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;

    const videoCodec = String(format.vcodec ?? format.videoCodec ?? "");
    if (format.hasVideo === false || videoCodec.toLowerCase() === "none") return false;

    const audioCodec = format.acodec ?? format.audioCodec;
    if (format.hasAudio === true) return false;
    if (audioCodec != null && String(audioCodec).toLowerCase() !== "none") return false;
    return true;
  });
}

function formatShortEdge(format) {
  const width = Number(format.width);
  const height = Number(format.height);
  if (width > 0 && height > 0) return Math.min(width, height);
  return height > 0 ? height : width > 0 ? width : Number.POSITIVE_INFINITY;
}

function isH264Format(format) {
  const codec = String(format.vcodec ?? format.videoCodec ?? format.codecs ?? format.mimeType ?? "");
  return /(?:^|[^a-z])(avc1|avc3|h264)/i.test(codec);
}

function isMp4Format(format) {
  return /mp4/i.test(
    [format.ext, format.video_ext, format.container, format.mimeType].filter(Boolean).join(" ")
  );
}

function videoFormatRank(format) {
  const shortEdge = formatShortEdge(format);
  const withinTarget = shortEdge <= TARGET_SHORT_EDGE;
  const h264 = isH264Format(format);
  const mp4 = isMp4Format(format);

  let group;
  if (h264 && mp4 && withinTarget) group = 0;
  else if (h264 && withinTarget) group = 1;
  else if (h264 && mp4) group = 2;
  else if (h264) group = 3;
  else if (withinTarget) group = 4;
  else group = 5;

  // Prefer the best resolution up to TARGET_SHORT_EDGE. If only larger
  // formats exist, prefer the smallest one — it's still the cheapest to
  // seek/decode per clip even though we no longer download it wholesale.
  const resolutionRank = withinTarget ? -shortEdge : shortEdge;
  const parsedBitrate = Number(format.tbr ?? format.bitrate);
  const bitrate = Number.isFinite(parsedBitrate) ? parsedBitrate : Number.POSITIVE_INFINITY;
  return [group, resolutionRank, bitrate];
}

function rankVideoFormats(data) {
  return normalizeVideoFormats(data).sort((left, right) => {
    const a = videoFormatRank(left);
    const b = videoFormatRank(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
}

function videoFormatLabel(format) {
  const resolution =
    format.format_note ||
    format.qualityLabel ||
    (Number.isFinite(formatShortEdge(format)) ? `${formatShortEdge(format)}p` : "unknown resolution");
  const codec = format.vcodec || format.videoCodec || "unknown codec";
  const id = format.format_id ?? format.itag;
  return `${resolution} ${codec}${id != null ? ` (format ${id})` : ""}`;
}

// The provider's `filter` values are not stable: `videoonly` returned a full
// format list for months, then began returning a single audio-only entry
// (HTTP 200, no error), which surfaced as "no usable formats" on every job.
// Try the known-good variants in order rather than trusting one of them.
const FORMAT_FILTERS = ["video", "videoonly", ""];

/** Requests the provider's video format list, tolerating filter changes. */
async function fetchVideoOnlyFormats(videoId, { signal } = {}) {
  let lastData = null;
  for (const filter of FORMAT_FILTERS) {
    const query = filter ? `&filter=${encodeURIComponent(filter)}` : "";
    let data;
    try {
      data = await rapidApiGet(VIDEO_HOST, `/download?id=${encodeURIComponent(videoId)}${query}`, {
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      continue; // try the next filter rather than failing the whole job
    }
    lastData = data;
    const formats = rankVideoFormats(data);
    if (formats.length) return formats;
  }

  const detail = lastData?.error || lastData?.message || lastData?.msg;
  throw new Error(detail || "Video provider returned no usable video formats.");
}

/** Requests the mp3 audio track, polling briefly since conversion happens server-side. */
async function fetchAudioTrack(videoId, { attempts = 6, intervalMs = 2_000, signal } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw abortError(signal);
    last = await rapidApiGet(AUDIO_HOST, `/dl?id=${encodeURIComponent(videoId)}`, { signal });
    if (last?.status === "ok" && last?.link) return last;
    if (last?.status === "processing") {
      await new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, intervalMs);
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          reject(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      continue;
    }
    throw new Error(last?.error || last?.msg || last?.message || "Audio provider failed to produce a link.");
  }
  throw new Error(
    `Audio conversion did not finish after ${attempts} attempts (last status: ${last?.status || "unknown"}).`
  );
}

/** Tries each ranked candidate in order, skipping to the next on a normal failure but stopping immediately on a machine-wide one (disk full, out of memory, etc). */
async function withVideoFormatFallbacks(formats, attempt, { onProgress } = {}) {
  const failures = [];

  for (let index = 0; index < formats.length; index++) {
    const format = formats[index];
    const label = videoFormatLabel(format);
    emitProgress(onProgress, `Trying video ${label} (${index + 1} of ${formats.length})`);

    try {
      return await attempt(format, index);
    } catch (err) {
      if (isFatalFormatAttemptError(err)) {
        emitProgress(onProgress, `Video processing stopped: ${err.message}`);
        throw err;
      }
      failures.push(`${label}: ${err.message}`);
      emitProgress(
        onProgress,
        index + 1 < formats.length
          ? `Video ${label} failed (${err.message}); trying the next format`
          : `Video ${label} failed (${err.message})`
      );
    }
  }

  const summary = failures.slice(-5).join(" | ");
  throw new Error(`All ${formats.length} video format attempts failed${summary ? `: ${summary}` : "."}`);
}

function assertCompatibleDurations(videoInfo, audioInfo) {
  const videoDuration = videoInfo.durationSec;
  const audioDuration = audioInfo.durationSec;
  const difference = Math.abs(videoDuration - audioDuration);
  const tolerance = durationToleranceSec(Math.min(videoDuration, audioDuration));
  if (difference > tolerance) {
    throw new Error(
      `Downloaded streams do not match: video is ${videoDuration.toFixed(1)}s and audio is ${
        audioDuration.toFixed(1)
      }s.`
    );
  }
}

function durationToleranceSec(durationSec) {
  return Math.min(15, Math.max(5, durationSec * 0.01));
}

/**
 * Downloads only the audio-only track locally (needed for transcription), and
 * validates a usable video-only source *without* downloading it. Clips are
 * rendered later by having ffmpeg seek directly into that remote URL for
 * just its own short time window — the full video is never downloaded or
 * stored, which is both far less data moved and far less time spent than
 * fetching the whole source video up front.
 */
export async function prepareSources(youtubeUrl, jobDir, onProgress) {
  requireApiKey();
  const videoId = extractVideoId(youtubeUrl);
  const audioPath = path.join(jobDir, "audio.mp3");

  try {
    emitProgress(onProgress, "Requesting available video formats and audio track");
    const metadataController = new AbortController();
    const formatTask = fetchVideoOnlyFormats(videoId, { signal: metadataController.signal });
    const audioMetadataTask = fetchAudioTrack(videoId, { signal: metadataController.signal });
    let formats;
    let audioMeta;
    try {
      [formats, audioMeta] = await Promise.all([formatTask, audioMetadataTask]);
    } catch (err) {
      metadataController.abort(new Error("Cancelling the other provider request after a failure"));
      await Promise.allSettled([formatTask, audioMetadataTask]);
      throw err;
    }
    emitProgress(onProgress, `Found ${formats.length} usable video format${formats.length === 1 ? "" : "s"}`);

    emitProgress(onProgress, "Downloading audio track");
    await downloadToFile(audioMeta.link, audioPath, { onProgress, label: "Audio track" });
    const audioInfo = await assertValidMedia(audioPath, "audio", "Audio");
    emitProgress(onProgress, "Audio ready");

    emitProgress(onProgress, "Selecting a usable video source");
    // Every candidate is probed (and later read) through the loopback relay:
    // ffprobe/ffmpeg get 403 from YouTube's CDN even where Node succeeds on
    // the identical URL, so Node has to be the one doing the upstream fetch.
    const attempted = [];
    const { format, info: videoInfo, relay } = await withVideoFormatFallbacks(
      formats,
      async (candidate) => {
        const headers = sanitizeRequestHeaders(candidate.http_headers || {});
        const relay = await relayUrl(candidate.url, headers);
        attempted.push(relay.token);
        const info = await assertValidMedia(relay.url, "video", videoFormatLabel(candidate));
        assertCompatibleDurations(info, audioInfo);
        return { format: candidate, info, relay };
      },
      { onProgress }
    );

    // Free the relay entries for candidates that lost, keeping only the winner.
    for (const token of attempted) {
      if (token !== relay.token) releaseRelay(token);
    }

    emitProgress(onProgress, `Selected video ${videoFormatLabel(format)}`);

    return {
      audioPath,
      videoUrl: relay.url,
      videoRelayToken: relay.token,
      videoHeaders: {},
      durationSec: Math.min(videoInfo.durationSec, audioInfo.durationSec),
    };
  } catch (err) {
    await fs.promises.rm(audioPath, { force: true }).catch(() => {});
    throw new Error(`Could not prepare this video: ${err.message}`, { cause: err });
  }
}

/** Fetches basic metadata via YouTube's public oEmbed endpoint. */
export async function getVideoInfo(youtubeUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Video metadata request timed out after ${METADATA_TIMEOUT_MS}ms`));
  }, METADATA_TIMEOUT_MS);
  timer.unref?.();

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      throw new Error(
        `Could not fetch video metadata (HTTP ${res.status}). Check that the URL is a valid, public YouTube video.`
      );
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`YouTube returned invalid metadata: ${err.message}`, { cause: err });
    }
    if (!data?.title || typeof data.title !== "string") {
      throw new Error("YouTube metadata did not include a video title.");
    }
    return { title: data.title, durationSec: null, thumbnail: data.thumbnail_url || null };
  } catch (err) {
    if (controller.signal.aborted) throw abortError(controller.signal, "Video metadata request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export { buildFfmpegHeaderString };

// Narrow test hooks for deterministic tests of provider ranking and transport
// failure handling. The public prepareSources/getVideoInfo contract is unchanged.
export const __testing = {
  assertValidMedia,
  downloadToFile,
  durationToleranceSec,
  extractVideoId,
  headersForRedirect,
  isFatalFormatAttemptError,
  normalizeVideoFormats,
  rankVideoFormats,
  videoFormatLabel,
  withVideoFormatFallbacks,
};
