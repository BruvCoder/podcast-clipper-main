import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_URL_LENGTH = 2_048;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 2 * 1024 * 1024;
const YTDLP_BINARY = process.env.YTDLP_BINARY || "yt-dlp";
const DOWNLOAD_TIMEOUT_MS = positiveInteger(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS, 30 * 60_000);
const METADATA_TIMEOUT_MS = positiveInteger(process.env.YTDLP_METADATA_TIMEOUT_MS, 2 * 60_000);
const SOCKET_TIMEOUT_SEC = positiveInteger(process.env.YTDLP_SOCKET_TIMEOUT_SEC, 30);
const MAX_DURATION_SEC = positiveInteger(process.env.YTDLP_MAX_DURATION_SEC, 4 * 60 * 60);
const MAX_SOURCE_BYTES = positiveInteger(process.env.YTDLP_MAX_SOURCE_BYTES, 2 * 1024 * 1024 * 1024);
const MAX_HEIGHT = positiveInteger(process.env.YTDLP_MAX_HEIGHT, 720);
const CONCURRENT_FRAGMENTS = positiveInteger(process.env.YTDLP_CONCURRENT_FRAGMENTS, 4);
const MAX_PROGRESS_LINE_BYTES = 64 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function invalidYouTubeUrl() {
  return new Error("Enter a valid public YouTube video URL.");
}

/**
 * Accepts only individual YouTube video URLs and returns a canonical URL.
 * This prevents yt-dlp's generic extractor from turning the API into an SSRF
 * primitive for arbitrary hosts supplied by a client.
 */
function canonicalizeYouTubeUrl(value) {
  if (typeof value !== "string") throw invalidYouTubeUrl();
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) throw invalidYouTubeUrl();

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidYouTubeUrl();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidYouTubeUrl();
  if (url.username || url.password || url.port) throw invalidYouTubeUrl();

  const hostname = url.hostname.toLowerCase();
  let videoId = null;
  if (hostname === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) videoId = parts[0];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname)) {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      videoId = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1] || null;
    }
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) throw invalidYouTubeUrl();
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

export function normalizeYouTubeUrl(value) {
  return canonicalizeYouTubeUrl(value).url;
}

function invalidProxyConfiguration(detail) {
  const error = new Error(`Invalid residential yt-dlp proxy configuration: ${detail}`);
  error.code = "ERR_YTDLP_PROXY_CONFIG";
  return error;
}

function parseProxyUrl(value, variableName) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) throw invalidProxyConfiguration(`${variableName} is blank`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidProxyConfiguration(`${variableName} must be an absolute http:// or https:// URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidProxyConfiguration(`${variableName} must use http:// or https://`);
  }
  if (!parsed.hostname) throw invalidProxyConfiguration(`${variableName} requires a hostname`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw invalidProxyConfiguration(`${variableName} cannot contain a path, query string, or fragment`);
  }

  try {
    decodeURIComponent(parsed.username || "");
    decodeURIComponent(parsed.password || "");
  } catch {
    throw invalidProxyConfiguration(`${variableName} credentials use invalid percent-encoding`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function loadProxyUrl(environment = process.env) {
  const preferred = parseProxyUrl(environment.RESIDENTIAL_PROXY_URL, "RESIDENTIAL_PROXY_URL");
  const legacy = parseProxyUrl(environment.MEDIA_PROXY_URL, "MEDIA_PROXY_URL");
  if (preferred && legacy && preferred !== legacy) {
    throw invalidProxyConfiguration(
      "RESIDENTIAL_PROXY_URL and MEDIA_PROXY_URL resolve to different proxies"
    );
  }
  return preferred || legacy;
}

function rotateIproyalSession(
  proxyUrl,
  sessionId = randomBytes(4).toString("hex"),
  { streaming = false } = {}
) {
  if (!proxyUrl) return { proxyUrl, rotated: false };
  const parsed = new URL(proxyUrl);
  if (!/(^|\.)iproyal\.com$/i.test(parsed.hostname)) return { proxyUrl, rotated: false };

  let password;
  try {
    password = decodeURIComponent(parsed.password || "");
  } catch {
    return { proxyUrl, rotated: false };
  }
  const safeSessionId = String(sessionId).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  if (safeSessionId.length !== 8) throw new Error("IPRoyal session IDs must be 8 alphanumeric characters.");
  let configuredPassword = /_session-[A-Za-z0-9]{8}(?=_|$)/.test(password)
    ? password.replace(/(_session-)[A-Za-z0-9]{8}(?=_|$)/, `$1${safeSessionId}`)
    : `${password}_session-${safeSessionId}${/_lifetime-[^_]+/.test(password) ? "" : "_lifetime-30m"}`;
  if (streaming) {
    configuredPassword = /_streaming-[01](?=_|$)/.test(configuredPassword)
      ? configuredPassword.replace(/_streaming-[01](?=_|$)/, "_streaming-1")
      : `${configuredPassword}_streaming-1`;
  }
  parsed.password = configuredPassword;
  return { proxyUrl: parsed.toString().replace(/\/$/, ""), rotated: true };
}

function sessionEnvironment(environment = process.env, sessionId) {
  const proxyUrl = loadProxyUrl(environment);
  if (String(environment.YTDLP_ROTATE_IPROYAL_SESSION || "true").toLowerCase() === "false") {
    return { environment, rotated: false };
  }
  const streaming =
    String(environment.YTDLP_IPROYAL_STREAMING || "false").toLowerCase() === "true";
  const rotated = rotateIproyalSession(proxyUrl, sessionId, { streaming });
  if (!rotated.rotated) return { environment, rotated: false };

  const next = { ...environment };
  if (environment.RESIDENTIAL_PROXY_URL) next.RESIDENTIAL_PROXY_URL = rotated.proxyUrl;
  if (environment.MEDIA_PROXY_URL) next.MEDIA_PROXY_URL = rotated.proxyUrl;
  return { environment: next, rotated: true };
}

function redactionValues(proxyUrl) {
  if (!proxyUrl) return [];
  const values = new Set([proxyUrl]);
  try {
    const parsed = new URL(proxyUrl);
    for (const value of [parsed.username, parsed.password]) {
      if (!value) continue;
      values.add(value);
      try {
        values.add(decodeURIComponent(value));
      } catch {
        // Invalid encoding was already rejected by parseProxyUrl.
      }
    }
  } catch {
    // The proxy was already validated; this is only defense-in-depth.
  }
  return [...values].filter((value) => value.length >= 3).sort((a, b) => b.length - a.length);
}

function redactSensitiveText(value, secrets = []) {
  let safe = String(value || "");
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/(proxy-authorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]");
}

function quoteConfigValue(value) {
  return JSON.stringify(String(value));
}

/**
 * Proxy credentials are sent over stdin as an explicit yt-dlp config, not in
 * argv or the child environment. That keeps them out of process listings.
 */
function buildPrivateConfig(environment = process.env) {
  const proxyUrl = loadProxyUrl(environment);
  const lines = [];
  if (proxyUrl) lines.push(`--proxy=${quoteConfigValue(proxyUrl)}`);

  if (environment.YTDLP_COOKIES_FILE) {
    lines.push(`--cookies=${quoteConfigValue(environment.YTDLP_COOKIES_FILE)}`);
  } else if (environment.YTDLP_COOKIES_FROM_BROWSER) {
    const browser = String(environment.YTDLP_COOKIES_FROM_BROWSER).trim();
    if (!/^[A-Za-z0-9_-]+(?::[^\r\n]+)?$/.test(browser)) {
      throw new Error("YTDLP_COOKIES_FROM_BROWSER contains an invalid browser/profile value.");
    }
    lines.push(`--cookies-from-browser=${quoteConfigValue(browser)}`);
  }

  return {
    proxyEnabled: Boolean(proxyUrl),
    secrets: redactionValues(proxyUrl),
    text: `${lines.join("\n")}\n`,
  };
}

function minimalChildEnvironment(environment = process.env) {
  const child = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]) {
    if (environment[key]) child[key] = environment[key];
  }
  child.NO_COLOR = "1";
  return child;
}

function appendTail(current, chunk, maximumBytes) {
  const combined = current + chunk.toString("utf8");
  if (Buffer.byteLength(combined) <= maximumBytes) return combined;
  return combined.slice(-maximumBytes);
}

function terminateProcessTree(proc, signal = "SIGTERM") {
  if (!proc?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // It already exited.
    }
  }
}

function abortError(signal, fallback = "yt-dlp was cancelled") {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : fallback);
  error.name = "AbortError";
  return error;
}

function friendlyError(stderr, exitCode, secrets) {
  const safe = redactSensitiveText(stderr, secrets)
    .replace(/^Reading options from STDIN[^\r\n]*(?:\r?\n)?/gm, "")
    .trim();
  const tail = safe.slice(-2_000);
  if (/Sign in to confirm you.?re not a bot/i.test(safe)) {
    const error = new Error(
      `YouTube blocked the download as an automated request (yt-dlp exit ${exitCode}). ` +
        "Verify the residential proxy and, if needed, configure a server-side YTDLP_COOKIES_FILE." +
        (tail ? `\n\n${tail}` : "")
    );
    error.code = "ERR_YTDLP_ACCESS_BLOCKED";
    return error;
  }
  if (/429|Too Many Requests/i.test(safe)) {
    const error = new Error(
      `YouTube rate-limited the download (yt-dlp exit ${exitCode}). Try again shortly or rotate the residential proxy session.` +
        (tail ? `\n\n${tail}` : "")
    );
    error.code = "ERR_YTDLP_ACCESS_BLOCKED";
    return error;
  }
  if (/HTTP Error 403|HTTP 403|403 Forbidden/i.test(safe)) {
    const error = new Error(
      `YouTube rejected media access through this proxy IP (yt-dlp exit ${exitCode}).` +
        (tail ? `\n\n${tail}` : "")
    );
    error.code = "ERR_YTDLP_ACCESS_BLOCKED";
    return error;
  }
  return new Error(`yt-dlp exited with code ${exitCode}${tail ? `: ${tail}` : "."}`);
}

function runYtDlp(
  args,
  {
    binary = YTDLP_BINARY,
    environment = process.env,
    onProgress,
    signal,
    watchDirectory,
    maximumDirectoryBytes,
    storagePollMs = 100,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let privateConfig;
    try {
      privateConfig = buildPrivateConfig(environment);
    } catch (error) {
      reject(error);
      return;
    }

    const proc = spawn(binary, ["--ignore-config", "--config-locations", "-", ...args], {
      detached: process.platform !== "win32",
      env: minimalChildEnvironment(environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const progressDecoder = new StringDecoder("utf8");
    let progressRemainder = "";
    let progressLineOverflow = false;
    let settled = false;
    let timedOut = false;
    let storageLimitError = null;
    let killTimer = null;
    let storageTimer = null;
    let stopping = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (storageTimer) clearInterval(storageTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      terminateProcessTree(proc, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessTree(proc, "SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const reportProgressLine = (line) => {
      if (!onProgress || progressLineOverflow) return;
      const safe = redactSensitiveText(line.trim(), privateConfig.secrets);
      if (/^Reading options from STDIN\b/.test(safe) || !safe) return;
      try {
        onProgress(safe.slice(0, 240));
      } catch {
        // Status reporting must not fail the download.
      }
    };
    const consumeProgress = (text, flush = false) => {
      if (!onProgress) return;
      progressRemainder += text;
      let separatorIndex;
      while ((separatorIndex = progressRemainder.search(/[\r\n]/)) !== -1) {
        const line = progressRemainder.slice(0, separatorIndex);
        const firstSeparator = progressRemainder[separatorIndex];
        const separatorLength =
          firstSeparator === "\r" && progressRemainder[separatorIndex + 1] === "\n" ? 2 : 1;
        if (Buffer.byteLength(line) <= MAX_PROGRESS_LINE_BYTES) reportProgressLine(line);
        progressRemainder = progressRemainder.slice(separatorIndex + separatorLength);
        progressLineOverflow = false;
      }
      if (Buffer.byteLength(progressRemainder) > MAX_PROGRESS_LINE_BYTES) {
        // Do not emit fragments of an oversized line: a credential could span
        // the discarded boundary and become impossible to redact safely.
        progressRemainder = "";
        progressLineOverflow = true;
      }
      if (flush) {
        if (Buffer.byteLength(progressRemainder) <= MAX_PROGRESS_LINE_BYTES) {
          reportProgressLine(progressRemainder);
        }
        progressRemainder = "";
        progressLineOverflow = false;
      }
    };
    const onAbort = () => stop();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeoutTimer.unref?.();
    if (watchDirectory && positiveInteger(maximumDirectoryBytes, 0)) {
      storageTimer = setInterval(() => {
        if (stopping) return;
        const bytes = sourceArtifactBytesSync(watchDirectory);
        if (bytes <= maximumDirectoryBytes) return;
        storageLimitError = sourceSizeLimitError(maximumDirectoryBytes);
        stop();
      }, Math.max(25, positiveInteger(storagePollMs, 100)));
      storageTimer.unref?.();
    }

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk, MAX_OUTPUT_BYTES);
    });
    proc.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, MAX_ERROR_BYTES);
      consumeProgress(progressDecoder.write(chunk));
    });
    proc.once("error", (error) => {
      finish(
        reject,
        new Error(`Failed to start yt-dlp at ${binary}. Is it installed and executable? (${error.message})`)
      );
    });
    proc.once("close", (code) => {
      if (!settled) consumeProgress(progressDecoder.end(), true);
      if (storageLimitError) {
        finish(reject, storageLimitError);
      } else if (timedOut) {
        const error = new Error(`yt-dlp exceeded its ${Math.round(timeoutMs / 1_000)}-second deadline.`);
        error.code = "ETIMEDOUT";
        finish(reject, error);
      } else if (signal?.aborted) {
        finish(reject, abortError(signal));
      } else if (code !== 0) {
        finish(reject, friendlyError(stderr, code, privateConfig.secrets));
      } else {
        finish(resolve, stdout);
      }
    });

    proc.stdin.on("error", () => {});
    proc.stdin.end(privateConfig.text);
  });
}

function commonArgs() {
  return [
    "--no-plugin-dirs",
    "--no-playlist",
    "--js-runtimes",
    "node",
    "--socket-timeout",
    String(SOCKET_TIMEOUT_SEC),
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--extractor-retries",
    "3",
    "--retry-sleep",
    "http:linear=1:5:1",
    "--retry-sleep",
    "fragment:linear=1:5:1",
  ];
}

function parseMetadata(stdout, expectedVideoId) {
  let info;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new Error("yt-dlp returned invalid video metadata.");
  }

  if (!info || info.id !== expectedVideoId || typeof info.title !== "string" || !info.title.trim()) {
    throw new Error("yt-dlp returned incomplete or mismatched video metadata.");
  }
  if (info.is_live === true || info.live_status === "is_live") {
    throw new Error("Live streams are not supported. Use a completed public video.");
  }
  const durationSec = Number(info.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("yt-dlp could not determine this video's duration.");
  }
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `This video is ${Math.ceil(durationSec / 60)} minutes long; the configured limit is ${Math.floor(MAX_DURATION_SEC / 60)} minutes.`
    );
  }

  return {
    videoId: expectedVideoId,
    title: info.title.trim(),
    durationSec,
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : null,
  };
}

export async function getVideoInfo(youtubeUrl, options = {}) {
  const canonical = canonicalizeYouTubeUrl(youtubeUrl);
  const stdout = await runYtDlp(
    [
      ...commonArgs(),
      "--dump-single-json",
      "--skip-download",
      "--quiet",
      "--no-warnings",
      canonical.url,
    ],
    { ...options, timeoutMs: options.timeoutMs || METADATA_TIMEOUT_MS }
  );
  return { ...parseMetadata(stdout, canonical.videoId), canonicalUrl: canonical.url };
}

function outputFormat() {
  return [
    `bv[vcodec^=avc1][ext=mp4][height<=${MAX_HEIGHT}]+ba[ext=m4a]`,
    `b[vcodec^=avc1][ext=mp4][height<=${MAX_HEIGHT}][acodec^=mp4a]`,
    `bv[ext=mp4][height<=${MAX_HEIGHT}]+ba[ext=m4a]`,
    `b[ext=mp4][height<=${MAX_HEIGHT}]`,
    `bv[height<=${MAX_HEIGHT}]+ba`,
    `b[height<=${MAX_HEIGHT}]`,
  ].join("/");
}

function prepareDeadlineError(timeoutMs) {
  const error = new Error(
    `yt-dlp source preparation exceeded its ${Math.max(1, Math.ceil(timeoutMs / 1_000))}-second deadline.`
  );
  error.code = "ETIMEDOUT";
  return error;
}

function remainingDeadlineMs(deadlineAt, overallTimeoutMs, signal, now = Date.now) {
  if (signal?.aborted) throw abortError(signal);
  const remaining = Math.floor(deadlineAt - now());
  if (remaining <= 0) throw prepareDeadlineError(overallTimeoutMs);
  return remaining;
}

function retryBackoffMs(attempt, baseMs = 250) {
  return Math.min(2_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

function abortAwareDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sourceSizeLimitError(limitBytes) {
  const error = new Error(
    `yt-dlp source working files exceeded the ${Math.ceil(limitBytes / 1024 ** 2)} MB limit.`
  );
  error.code = "ERR_YTDLP_SOURCE_TOO_LARGE";
  return error;
}

function sourceArtifactBytesSync(jobDir) {
  function entryBytes(entryPath) {
    try {
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) return 0;
      if (stat.isFile()) return stat.size;
      if (!stat.isDirectory()) return 0;
      return fs
        .readdirSync(entryPath)
        .reduce((total, name) => total + entryBytes(path.join(entryPath, name)), 0);
    } catch {
      // yt-dlp can rename/delete fragment files while this snapshot runs.
      return 0;
    }
  }

  try {
    return fs
      .readdirSync(jobDir, { withFileTypes: true })
      .filter((entry) => /^source\./.test(entry.name))
      .reduce((total, entry) => total + entryBytes(path.join(jobDir, entry.name)), 0);
  } catch {
    return 0;
  }
}

async function removeSourceArtifacts(jobDir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(jobDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => /^source\./.test(entry.name))
      .map((entry) =>
        fs.promises.rm(path.join(jobDir, entry.name), { recursive: true, force: true })
      )
  );
}

async function validateDownloadedPath(jobDir, printedPath) {
  const resolvedRoot = path.resolve(jobDir);
  const candidate = path.resolve(String(printedPath || "").trim());
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("yt-dlp reported an output path outside the job directory.");
  }
  const root = await fs.promises.realpath(resolvedRoot);
  const real = await fs.promises.realpath(candidate);
  if (!real.startsWith(`${root}${path.sep}`)) {
    throw new Error("yt-dlp output resolved outside the job directory.");
  }
  const stat = await fs.promises.stat(real);
  if (!stat.isFile() || stat.size <= 0) throw new Error("yt-dlp produced an empty source file.");
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new Error(`Downloaded source exceeds the ${Math.ceil(MAX_SOURCE_BYTES / 1024 ** 3)} GB limit.`);
  }
  return real;
}

export async function downloadVideo(youtubeUrl, jobDir, onProgress, options = {}) {
  const canonical = canonicalizeYouTubeUrl(youtubeUrl);
  const outputTemplate = path.join(path.resolve(jobDir), "source.%(ext)s");
  await removeSourceArtifacts(jobDir);

  try {
    const stdout = await runYtDlp(
      [
        ...commonArgs(),
        "--format",
        outputFormat(),
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--max-filesize",
        String(MAX_SOURCE_BYTES),
        "--concurrent-fragments",
        String(CONCURRENT_FRAGMENTS),
        "--force-overwrites",
        "--newline",
        "--progress",
        "--progress-template",
        "download:Downloading source %(progress._percent_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s",
        "--print",
        "after_move:%(filepath)s",
        "--output",
        outputTemplate,
        canonical.url,
      ],
      {
        ...options,
        onProgress,
        watchDirectory: jobDir,
        maximumDirectoryBytes: positiveInteger(
          options.maximumDirectoryBytes,
          MAX_SOURCE_BYTES
        ),
      }
    );

    const printedPath = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!printedPath) throw new Error("yt-dlp completed without reporting the source path.");
    return await validateDownloadedPath(jobDir, printedPath);
  } catch (error) {
    await removeSourceArtifacts(jobDir);
    throw error;
  }
}

export async function prepareSource(youtubeUrl, jobDir, onProgress, options = {}) {
  const baseEnvironment = options.environment || process.env;
  const overallTimeoutMs = positiveInteger(options.timeoutMs, DOWNLOAD_TIMEOUT_MS);
  const deadlineAt = Date.now() + overallTimeoutMs;
  const backoffBaseMs = positiveInteger(
    options.retryBackoffMs || baseEnvironment.YTDLP_RETRY_BACKOFF_MS,
    250
  );
  const maximumAttempts = Math.min(
    5,
    positiveInteger(baseEnvironment.YTDLP_SESSION_ATTEMPTS, 3)
  );

  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const session = sessionEnvironment(baseEnvironment);
    const attemptOptions = { ...options, environment: session.environment };
    try {
      const metadataBudgetMs = Math.min(
        METADATA_TIMEOUT_MS,
        remainingDeadlineMs(deadlineAt, overallTimeoutMs, options.signal)
      );
      const info = await getVideoInfo(youtubeUrl, {
        ...attemptOptions,
        timeoutMs: metadataBudgetMs,
      });
      onProgress?.("Downloading source video with yt-dlp");
      const sourcePath = await downloadVideo(info.canonicalUrl, jobDir, onProgress, {
        ...attemptOptions,
        timeoutMs: remainingDeadlineMs(deadlineAt, overallTimeoutMs, options.signal),
      });
      return { info, sourcePath };
    } catch (error) {
      lastError = error;
      const canRotate = session.rotated && error?.code === "ERR_YTDLP_ACCESS_BLOCKED";
      if (!canRotate || attempt === maximumAttempts) throw error;
      onProgress?.(`YouTube rejected proxy session ${attempt}; rotating IPRoyal IP and retrying`);
      const remaining = remainingDeadlineMs(
        deadlineAt,
        overallTimeoutMs,
        options.signal
      );
      const backoff = retryBackoffMs(attempt, backoffBaseMs);
      if (backoff >= remaining) {
        await abortAwareDelay(remaining, options.signal);
        throw prepareDeadlineError(overallTimeoutMs);
      }
      await abortAwareDelay(backoff, options.signal);
    }
  }
  throw lastError || new Error("yt-dlp could not prepare the source video.");
}

export function ytDlpProxyEnabled(environment = process.env) {
  return Boolean(loadProxyUrl(environment));
}

export const __testing = {
  buildPrivateConfig,
  abortAwareDelay,
  canonicalizeYouTubeUrl,
  commonArgs,
  loadProxyUrl,
  minimalChildEnvironment,
  outputFormat,
  parseMetadata,
  remainingDeadlineMs,
  redactSensitiveText,
  retryBackoffMs,
  rotateIproyalSession,
  runYtDlp,
  sessionEnvironment,
  sourceArtifactBytesSync,
  validateDownloadedPath,
  limits: {
    maxDurationSec: MAX_DURATION_SEC,
    maxSourceBytes: MAX_SOURCE_BYTES,
  },
};
