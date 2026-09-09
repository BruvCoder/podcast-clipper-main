import { YoutubeChannelFeedError, normalizeYoutubeChannelId } from "./youtubeChannelFeed.js";

// Upload detection through the official YouTube Data API.
//
// This replaces the Atom feed at /feeds/videos.xml, which YouTube retired: it
// now returns 404 for every channel, including ones that plainly exist, so
// nothing was ever detected and each poll only recorded an error.
//
// Errors are raised as YoutubeChannelFeedError so the polling code's existing
// retry and backoff behaviour applies unchanged — only the source of the data
// is different.
//
// Quota matters here in a way it did not for the feed. Each poll costs one
// unit against a default 10,000/day, and that budget is shared by every
// watching user, so the poll interval is now a spend decision (see
// YOUTUBE_WATCH_POLL_MS).

const API_BASE = "https://www.googleapis.com/youtube/v3/playlistItems";
const DEFAULT_MAX_RESULTS = 15;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 180;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Every channel's uploads live in a playlist whose id is the channel id with
 * UC swapped for UU. Deriving it costs nothing, where looking it up through
 * channels.list would spend a second quota unit on every poll.
 */
export function uploadsPlaylistId(channelId) {
  const normalized = normalizeYoutubeChannelId(channelId);
  return `UU${normalized.slice(2)}`;
}

function apiError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || "";
  const message = body?.error?.message || "";

  if (status === 403 && /quota/i.test(`${reason} ${message}`)) {
    // Retryable: the quota window rolls over, so this is temporary rather
    // than a configuration problem.
    return new YoutubeChannelFeedError("The YouTube API quota is used up for today.", {
      status,
      code: "youtube_api_quota_exceeded",
      retryable: true,
    });
  }
  if (status === 400 || status === 401 || status === 403) {
    // A bad or unauthorised key. Retrying cannot fix it and would burn quota.
    return new YoutubeChannelFeedError(
      "The YouTube API rejected Ravi's credentials. Check YOUTUBE_API_KEY.",
      { status, code: "youtube_api_unauthorized", retryable: false }
    );
  }
  if (status === 404) {
    return new YoutubeChannelFeedError("That YouTube channel has no uploads playlist.", {
      status,
      code: "youtube_api_channel_not_found",
      retryable: false,
    });
  }
  return new YoutubeChannelFeedError(`The YouTube API request failed (HTTP ${status}).`, {
    status,
    code: `youtube_api_http_${status}`,
    retryable: status === 429 || status >= 500,
  });
}

/**
 * Recent uploads for a channel, oldest first — the same shape the Atom feed
 * produced, so the polling code did not have to change.
 */
export async function fetchChannelUploads(
  channelId,
  { apiKey, fetchImpl = fetch, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}
) {
  const normalizedChannelId = normalizeYoutubeChannelId(channelId);
  if (!apiKey) {
    throw new YoutubeChannelFeedError(
      "Ravi cannot watch a channel until YOUTUBE_API_KEY is configured.",
      { status: 503, code: "youtube_api_not_configured", retryable: false }
    );
  }

  const url = new URL(API_BASE);
  // contentDetails carries the real upload time; snippet.publishedAt is when
  // the video was added to the playlist, which can differ.
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", uploadsPlaylistId(normalizedChannelId));
  url.searchParams.set("maxResults", String(Math.max(1, Math.min(50, maxResults))));
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    if (timedOut) {
      throw new YoutubeChannelFeedError("The YouTube API request timed out.", {
        status: 504,
        code: "youtube_api_timeout",
        retryable: true,
      });
    }
    if (signal?.aborted) {
      throw new YoutubeChannelFeedError("The YouTube API request was cancelled.", {
        status: 499,
        code: "youtube_api_cancelled",
        retryable: false,
      });
    }
    throw new YoutubeChannelFeedError("Ravi could not reach the YouTube API.", {
      status: 502,
      code: "youtube_api_unreachable",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) throw apiError(Number(response.status) || 502, body);
  if (!Array.isArray(body?.items)) {
    throw new YoutubeChannelFeedError("The YouTube API returned an unreadable response.", {
      status: 502,
      code: "youtube_api_invalid",
      retryable: true,
    });
  }

  return parseUploadItems(body.items, normalizedChannelId);
}

/** Turns API items into feed entries, skipping any that cannot be trusted. */
export function parseUploadItems(items, expectedChannelId) {
  const channelId = normalizeYoutubeChannelId(expectedChannelId);
  const entries = new Map();

  for (const item of items) {
    const snippet = item?.snippet || {};
    const videoId = String(snippet.resourceId?.videoId || "");
    if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) continue;

    // The playlist is derived from the channel id, so a mismatch means the
    // response is not what was asked for and must not seed a clip job.
    const itemChannelId = String(snippet.videoOwnerChannelId || snippet.channelId || "");
    if (itemChannelId && itemChannelId !== channelId) continue;

    // A private or deleted upload keeps its playlist slot but has no usable
    // title, and clipping it would fail later anyway.
    const title = String(snippet.title || "").replace(/\s+/g, " ").trim();
    if (!title || title === "Private video" || title === "Deleted video") continue;

    const publishedAt = Date.parse(
      item?.contentDetails?.videoPublishedAt || snippet.publishedAt || ""
    );
    if (!Number.isFinite(publishedAt)) continue;

    entries.set(videoId, {
      videoId,
      channelId,
      title: title.slice(0, MAX_TITLE_LENGTH),
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return [...entries.values()].sort((left, right) => left.publishedAt - right.publishedAt);
}

export const __testing = { API_BASE, DEFAULT_MAX_RESULTS };
