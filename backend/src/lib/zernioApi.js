import { randomUUID } from "node:crypto";
import fs from "node:fs";

import {
  PLATFORMS,
  buildPlatformTargets,
  isSupportedPlatform,
  shortCaption,
} from "./socialPlatforms.js";

export const DEFAULT_ZERNIO_BASE_URL = "https://zernio.com/api/v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_REQUEST_TIMEOUT_MS = 2 * 60_000;
const MAX_UPLOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_RESPONSE_CHARS = 1_000_000;

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export class ZernioApiError extends Error {
  constructor(
    message,
    {
      status = 502,
      code = "zernio_api_error",
      retryable = false,
      details = null,
      retryAfterMs = null,
    } = {}
  ) {
    super(message);
    this.name = "ZernioApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

function boundedTimeout(value, fallback, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${label} must be between 1 and ${maximum} milliseconds.`);
  }
  return Math.floor(parsed);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_ZERNIO_BASE_URL));
  } catch {
    throw new TypeError("Zernio baseUrl must be an absolute HTTP(S) URL.");
  }
  const isLocalHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new TypeError("Zernio baseUrl must be an absolute HTTP(S) URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requireString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ZernioApiError(`${label} is required.`, {
      status: 400,
      code: "invalid_zernio_request",
    });
  }
  return normalized;
}

function normalizeInteger(value, { label, fallback, min, max }) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ZernioApiError(`${label} must be an integer between ${min} and ${max}.`, {
      status: 400,
      code: "invalid_zernio_request",
    });
  }
  return parsed;
}

function safeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk_[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 300);
  return normalized || fallback;
}

function safeDetails(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const details = {};
  for (const key of ["type", "param", "platform", "reason"]) {
    if (typeof data[key] === "string") details[key] = safeText(data[key], "");
  }
  const nested = data.details;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const key of ["accountId", "platform", "existingPostId", "existingProfileId", "reason"]) {
      if (typeof nested[key] === "string") details[key] = safeText(nested[key], "");
    }
  }
  return Object.keys(details).length ? details : null;
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return {};
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new ZernioApiError("Zernio returned an unexpectedly large response.", {
      code: "zernio_response_too_large",
      retryable: true,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new ZernioApiError("Zernio returned an invalid response.", {
        code: "zernio_invalid_response",
        retryable: true,
      });
    }
    return { error: text };
  }
}

function httpFailure(response, data, fallbackMessage) {
  const status = Number(response.status) || 502;
  const upstreamCode = typeof data?.code === "string"
    ? data.code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100)
    : null;
  const message = safeText(data?.error || data?.message, fallbackMessage);
  return new ZernioApiError(message, {
    status,
    code: upstreamCode || `zernio_http_${status}`,
    retryable: RETRYABLE_STATUSES.has(status) || status >= 500,
    details: safeDetails(data),
    retryAfterMs: retryAfterMs(response),
  });
}

function externalAbortError() {
  return new ZernioApiError("The Zernio request was cancelled.", {
    status: 499,
    code: "zernio_request_aborted",
    retryable: false,
  });
}

function timeoutError(operation) {
  return new ZernioApiError(`${operation} timed out.`, {
    status: 504,
    code: "zernio_timeout",
    retryable: true,
  });
}

async function runWithTimeout(run, { timeoutMs, signal, operation }) {
  if (signal?.aborted) throw externalAbortError();

  const controller = new AbortController();
  let didTimeout = false;
  let didExternallyAbort = false;
  let rejectBoundary;
  const boundary = new Promise((_, reject) => {
    rejectBoundary = reject;
  });
  const onExternalAbort = () => {
    didExternallyAbort = true;
    controller.abort();
    rejectBoundary(externalAbortError());
  };
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
    rejectBoundary(timeoutError(operation));
  }, timeoutMs);

  const request = Promise.resolve().then(() => run(controller.signal));

  try {
    return await Promise.race([request, boundary]);
  } catch (error) {
    if (error instanceof ZernioApiError) throw error;
    if (didExternallyAbort || signal?.aborted) throw externalAbortError();
    if (didTimeout) throw timeoutError(operation);
    throw new ZernioApiError(`${operation} could not reach Zernio.`, {
      status: 502,
      code: "zernio_network_error",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Dependency-free Zernio REST client for Ravi's YouTube channel workflow.
 * All methods return the decoded Zernio response body.
 */
export function createZernioApi({
  apiKey = process.env.ZERNIO_API_KEY,
  baseUrl = process.env.ZERNIO_BASE_URL || DEFAULT_ZERNIO_BASE_URL,
  fetchImpl = fetch,
  requestTimeoutMs = process.env.ZERNIO_REQUEST_TIMEOUT_MS,
  uploadTimeoutMs = process.env.ZERNIO_UPLOAD_TIMEOUT_MS,
  idFactory = randomUUID,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const requestTimeout = boundedTimeout(
    requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs"
  );
  const uploadTimeout = boundedTimeout(
    uploadTimeoutMs,
    DEFAULT_UPLOAD_TIMEOUT_MS,
    MAX_UPLOAD_TIMEOUT_MS,
    "uploadTimeoutMs"
  );
  const normalizedApiKey = String(apiKey || "").trim();
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function.");

  function assertConfigured() {
    if (!normalizedApiKey) {
      throw new ZernioApiError("Zernio is not configured.", {
        status: 503,
        code: "zernio_not_configured",
      });
    }
  }

  function apiUrl(pathname, query = null) {
    const url = new URL(`${normalizedBaseUrl}${pathname}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  async function request(pathname, {
    method = "GET",
    query,
    body,
    headers,
    signal,
    operation = "The Zernio request",
  } = {}) {
    assertConfigured();
    const requestHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${normalizedApiKey}`,
      ...headers,
    };
    const init = { method, headers: requestHeaders };
    if (body !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return runWithTimeout(async (requestSignal) => {
      const response = await fetchImpl(apiUrl(pathname, query), {
        ...init,
        signal: requestSignal,
      });
      const data = await responseData(response);
      if (!response.ok) {
        throw httpFailure(response, data, `${operation} failed (HTTP ${response.status}).`);
      }
      return data;
    }, {
      timeoutMs: requestTimeout,
      signal,
      operation,
    });
  }

  async function createProfile(name, description, { idempotencyKey } = {}) {
    const profileName = requireString(name, "Profile name");
    const body = { name: profileName };
    if (description != null && String(description).trim()) {
      body.description = String(description).trim();
    }
    return request("/profiles", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": requireString(idempotencyKey || idFactory(), "Idempotency key") },
      operation: "Creating the Zernio profile",
    });
  }

  async function listProfiles({ name, limit, skip, includeOverLimit } = {}) {
    const query = {};
    if (name != null && String(name).trim()) query.name = String(name).trim();
    if (limit != null) {
      query.limit = normalizeInteger(limit, { label: "limit", fallback: 100, min: 1, max: 1000 });
    }
    if (skip != null) {
      query.skip = normalizeInteger(skip, { label: "skip", fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    }
    if (includeOverLimit != null) query.includeOverLimit = Boolean(includeOverLimit);
    return request("/profiles", { query, operation: "Listing Zernio profiles" });
  }

  /**
   * Starts an OAuth connection. The endpoint is per-platform by path, and on
   * return Zernio appends connected/platform/accountId/username to
   * redirectUrl, or error/platform if it failed.
   */
  async function getConnectUrl(profileId, redirectUrl, platform = "youtube") {
    const normalizedPlatform = requireString(platform, "Platform");
    if (!isSupportedPlatform(normalizedPlatform)) {
      throw new ZernioApiError(`${normalizedPlatform} is not a supported destination.`, {
        status: 400,
        code: "unsupported_platform",
      });
    }
    return request(`/connect/${encodeURIComponent(normalizedPlatform)}`, {
      query: {
        profileId: requireString(profileId, "Profile ID"),
        redirect_url: requireString(redirectUrl, "Redirect URL"),
      },
      operation: `Starting the ${PLATFORMS[normalizedPlatform].label} connection`,
    });
  }

  async function listAccounts(profileId, platform = "youtube") {
    return request("/accounts", {
      query: {
        profileId: profileId == null ? undefined : requireString(profileId, "Profile ID"),
        platform: requireString(platform, "Platform"),
      },
      operation: "Listing connected Zernio accounts",
    });
  }

  async function findAccountById(accountId, options = {}) {
    const profileId = typeof options === "string" ? options : options?.profileId;
    const platform = typeof options === "object" && options?.platform ? options.platform : "youtube";
    const wantedId = requireString(accountId, "Account ID");
    const data = await listAccounts(profileId, platform);
    return (Array.isArray(data?.accounts) ? data.accounts : []).find(
      (account) => account?._id === wantedId || account?.id === wantedId
    ) || null;
  }

  async function getAccountHealth(accountId) {
    const id = encodeURIComponent(requireString(accountId, "Account ID"));
    return request(`/accounts/${id}/health`, { operation: "Checking the connected channel" });
  }

  async function disconnectAccount(accountId) {
    const id = encodeURIComponent(requireString(accountId, "Account ID"));
    return request(`/accounts/${id}`, {
      method: "DELETE",
      operation: "Disconnecting the YouTube channel",
    });
  }

  async function syncExternalPosts(accountId) {
    return request("/posts/sync-external", {
      method: "POST",
      body: { accountId: requireString(accountId, "Account ID") },
      operation: "Refreshing the YouTube channel",
    });
  }

  async function listYoutubePosts(
    accountId,
    { source = "external", status, page = 1, limit = 50 } = {}
  ) {
    const normalizedSource = String(source || "external");
    if (!["external", "zernio"].includes(normalizedSource)) {
      throw new ZernioApiError("Post source must be external or zernio.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    const normalizedStatus = status == null ? undefined : String(status);
    if (normalizedStatus && !["draft", "scheduled", "published", "failed"].includes(normalizedStatus)) {
      throw new ZernioApiError("Post status is invalid.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    return request("/posts", {
      query: {
        source: normalizedSource,
        status: normalizedStatus,
        platform: "youtube",
        accountId: requireString(accountId, "Account ID"),
        page: normalizeInteger(page, { label: "page", fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER }),
        limit: normalizeInteger(limit, { label: "limit", fallback: 50, min: 1, max: 500 }),
      },
      operation: "Listing YouTube channel posts",
    });
  }

  function listExternalYoutubePosts(accountId, options = {}) {
    return listYoutubePosts(accountId, { ...options, source: "external" });
  }

  async function createMediaPresign(filename, size) {
    const body = {
      filename: requireString(filename, "Media filename"),
      contentType: "video/mp4",
    };
    if (size != null) {
      body.size = normalizeInteger(size, {
        label: "Media size",
        fallback: 1,
        min: 1,
        max: 5 * 1024 * 1024 * 1024,
      });
    }
    return request("/media/presign", {
      method: "POST",
      body,
      operation: "Preparing the clip upload",
    });
  }

  async function uploadFile(uploadUrl, filePath, signal) {
    const destination = requireString(uploadUrl, "Upload URL");
    const source = requireString(filePath, "Media file path");
    let parsedDestination;
    try {
      parsedDestination = new URL(destination);
    } catch {
      throw new ZernioApiError("Upload URL is invalid.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    const isLocalHttp = parsedDestination.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(parsedDestination.hostname);
    if (parsedDestination.protocol !== "https:" && !isLocalHttp) {
      throw new ZernioApiError("Upload URL is invalid.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }

    let stat;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      throw new ZernioApiError("The rendered clip could not be found for upload.", {
        status: 500,
        code: "zernio_upload_file_missing",
      });
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw new ZernioApiError("The rendered clip was empty.", {
        status: 500,
        code: "zernio_upload_file_missing",
      });
    }

    const stream = fs.createReadStream(source);
    try {
      return await runWithTimeout(async (requestSignal) => {
        const response = await fetchImpl(parsedDestination, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(stat.size),
          },
          body: stream,
          duplex: "half",
          signal: requestSignal,
        });
        if (!response.ok) {
          const data = await responseData(response);
          throw httpFailure(response, data, `Uploading the clip failed (HTTP ${response.status}).`);
        }
        // Presigned storage responses are normally empty and must never be parsed as Zernio JSON.
        return { uploaded: true, status: response.status };
      }, {
        timeoutMs: uploadTimeout,
        signal,
        operation: "Uploading the clip",
      });
    } finally {
      stream.destroy();
    }
  }

  async function createYoutubePost({
    accountId,
    mediaUrl,
    title,
    description = "",
    visibility = "public",
    madeForKids = false,
    containsSyntheticMedia = false,
    tags = [],
    requestId,
    signal,
  }) {
    const normalizedVisibility = String(visibility || "public");
    if (!["public", "private", "unlisted"].includes(normalizedVisibility)) {
      throw new ZernioApiError("YouTube visibility must be public, private, or unlisted.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    const normalizedTitle = requireString(title, "YouTube title");
    if (normalizedTitle.length > 100) {
      throw new ZernioApiError("YouTube title must be 100 characters or fewer.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    const normalizedDescription = String(description || "");
    if (normalizedDescription.length > 5000) {
      throw new ZernioApiError("YouTube description must be 5,000 characters or fewer.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }
    if (!Array.isArray(tags)) {
      throw new ZernioApiError("YouTube tags must be an array.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }

    const body = {
      content: normalizedDescription,
      mediaItems: [{ type: "video", url: requireString(mediaUrl, "Media URL") }],
      platforms: [{
        platform: "youtube",
        accountId: requireString(accountId, "Account ID"),
        platformSpecificData: {
          title: normalizedTitle,
          visibility: normalizedVisibility,
          madeForKids: Boolean(madeForKids),
          containsSyntheticMedia: Boolean(containsSyntheticMedia),
        },
      }],
      publishNow: true,
    };
    if (tags.length) body.tags = tags.map((tag) => String(tag).trim()).filter(Boolean);

    return request("/posts", {
      method: "POST",
      body,
      headers: { "x-request-id": requireString(requestId || idFactory(), "Request ID") },
      signal,
      operation: "Publishing the YouTube clip",
    });
  }

  /**
   * Publishes or schedules one clip to any number of destinations at once.
   *
   * Scheduling is Zernio's, not ours: passing scheduledFor hands it the timing,
   * so a pending post survives this process restarting. A queue held in memory
   * here would not — the container is redeployed regularly and jobs live in RAM.
   *
   * Omitting both scheduledFor and publishNow leaves the post as a draft, which
   * is Zernio's documented third mode.
   */
  async function createClipPost({
    destinations = [],
    mediaUrl,
    title = "",
    platformOptions = {},
    scheduledFor = null,
    timezone = null,
    tags = [],
    requestId,
    signal,
  }) {
    const platforms = buildPlatformTargets({ destinations, title, platformOptions });
    if (!platforms.length) {
      throw new ZernioApiError("At least one valid destination is required.", {
        status: 400,
        code: "invalid_zernio_request",
      });
    }

    const body = {
      // The clip's own short title is the caption, the same on every platform.
      content: shortCaption(title),
      mediaItems: [{ type: "video", url: requireString(mediaUrl, "Media URL") }],
      platforms,
    };

    if (scheduledFor) {
      const when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime())) {
        throw new ZernioApiError("Scheduled time must be a valid date.", {
          status: 400,
          code: "invalid_zernio_request",
        });
      }
      // A time already past would publish immediately on Zernio's side, which
      // is not what "schedule" means to someone who mistyped a date.
      if (when.getTime() <= Date.now()) {
        throw new ZernioApiError("Scheduled time must be in the future.", {
          status: 400,
          code: "invalid_zernio_request",
        });
      }
      body.scheduledFor = when.toISOString();
      if (timezone) body.timezone = String(timezone);
    } else {
      body.publishNow = true;
    }

    if (Array.isArray(tags) && tags.length) {
      body.tags = tags.map((tag) => String(tag).trim()).filter(Boolean);
    }

    return request("/posts", {
      method: "POST",
      body,
      headers: { "x-request-id": requireString(requestId || idFactory(), "Request ID") },
      signal,
      operation: scheduledFor ? "Scheduling the clip" : "Publishing the clip",
    });
  }

  async function getPost(postId) {
    const id = encodeURIComponent(requireString(postId, "Post ID"));
    return request(`/posts/${id}`, { operation: "Checking the published clip" });
  }

  return {
    createProfile,
    listProfiles,
    getConnectUrl,
    listAccounts,
    findAccountById,
    getAccountHealth,
    disconnectAccount,
    syncExternalPosts,
    listYoutubePosts,
    listExternalYoutubePosts,
    createMediaPresign,
    uploadFile,
    createYoutubePost,
    createClipPost,
    getPost,
  };
}
