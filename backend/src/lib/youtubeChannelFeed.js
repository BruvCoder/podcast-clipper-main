const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_FEED_BYTES = 1_000_000;

export class YoutubeChannelFeedError extends Error {
  constructor(
    message,
    { status = 502, code = "youtube_channel_feed_error", retryable = true, cause } = {}
  ) {
    super(message, { cause });
    this.name = "YoutubeChannelFeedError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeYoutubeChannelId(value) {
  const channelId = String(value || "").trim();
  if (!YOUTUBE_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new YoutubeChannelFeedError("A valid YouTube channel ID is required.", {
      status: 400,
      code: "invalid_youtube_channel_id",
      retryable: false,
    });
  }
  return channelId;
}

function decodeXmlText(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|apos|gt|lt|quot));/g, (match, hex, decimal, name) => {
      if (name) return named[name];
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    });
}

function elementText(xml, tagName) {
  const match = String(xml || "").match(
    new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i")
  );
  return match ? decodeXmlText(match[1]).trim() : "";
}

export function parseYoutubeChannelFeed(xml, expectedChannelId) {
  const channelId = normalizeYoutubeChannelId(expectedChannelId);
  const document = String(xml || "");
  if (Buffer.byteLength(document) > MAX_FEED_BYTES) {
    throw new YoutubeChannelFeedError("YouTube returned an unexpectedly large channel feed.", {
      code: "youtube_channel_feed_too_large",
    });
  }
  if (!/^\s*(?:<\?xml\b[^?]*\?>\s*)?<feed(?:\s|>)/i.test(document)) {
    throw new YoutubeChannelFeedError("YouTube returned an invalid channel feed.", {
      code: "youtube_channel_feed_invalid",
    });
  }

  const firstEntryAt = document.search(/<entry(?:\s|>)/i);
  const feedHeader = firstEntryAt === -1 ? document : document.slice(0, firstEntryAt);
  const rootChannelId = elementText(feedHeader, "yt:channelId");
  if (
    rootChannelId &&
    rootChannelId !== channelId &&
    rootChannelId !== channelId.slice(2)
  ) {
    throw new YoutubeChannelFeedError("YouTube returned a feed for a different channel.", {
      code: "youtube_channel_feed_mismatch",
      retryable: false,
    });
  }

  const rawEntries = [...document.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)];
  const entries = new Map();
  for (const [, rawEntry] of rawEntries) {
    const entryChannelId = elementText(rawEntry, "yt:channelId");
    if (entryChannelId && entryChannelId !== channelId) {
      throw new YoutubeChannelFeedError("YouTube returned a feed entry for a different channel.", {
        code: "youtube_channel_feed_mismatch",
        retryable: false,
      });
    }
    const videoId = elementText(rawEntry, "yt:videoId");
    const title = elementText(rawEntry, "title").replace(/\s+/g, " ").trim();
    const publishedAt = Date.parse(elementText(rawEntry, "published"));
    if (
      !YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ||
      !title ||
      !Number.isFinite(publishedAt)
    ) {
      throw new YoutubeChannelFeedError("YouTube returned an unreadable channel feed entry.", {
        code: "youtube_channel_feed_invalid",
      });
    }
    entries.set(videoId, {
      videoId,
      channelId,
      title: title.slice(0, 180),
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  if (rawEntries.length > 0 && entries.size === 0) {
    throw new YoutubeChannelFeedError("YouTube returned an unreadable channel feed.", {
      code: "youtube_channel_feed_invalid",
    });
  }
  if (rawEntries.length === 0 && !rootChannelId) {
    throw new YoutubeChannelFeedError("YouTube returned an unverified empty channel feed.", {
      code: "youtube_channel_feed_invalid",
    });
  }

  return [...entries.values()].sort((left, right) => left.publishedAt - right.publishedAt);
}

async function readBoundedText(response, maximumBytes = MAX_FEED_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new YoutubeChannelFeedError("YouTube returned an unexpectedly large channel feed.", {
      code: "youtube_channel_feed_too_large",
    });
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw new YoutubeChannelFeedError("YouTube returned an unexpectedly large channel feed.", {
            code: "youtube_channel_feed_too_large",
          });
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) {
    throw new YoutubeChannelFeedError("YouTube returned an unexpectedly large channel feed.", {
      code: "youtube_channel_feed_too_large",
    });
  }
  return text;
}

function timeoutValue(value) {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return Math.floor(parsed);
}

export async function fetchYoutubeChannelFeed(
  channelIdValue,
  { fetchImpl = fetch, timeoutMs, signal } = {}
) {
  const channelId = normalizeYoutubeChannelId(channelIdValue);
  const deadlineMs = timeoutValue(timeoutMs);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = Boolean(signal?.aborted);
  const onAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  timer.unref?.();
  if (externallyAborted) controller.abort();

  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", channelId);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = Number(response?.status) || 502;
      throw new YoutubeChannelFeedError(
        `YouTube channel feed request failed (HTTP ${status}).`,
        {
          status,
          code: `youtube_channel_feed_http_${status}`,
          retryable: status === 429 || status >= 500,
        }
      );
    }
    const xml = await readBoundedText(response);
    return parseYoutubeChannelFeed(xml, channelId);
  } catch (error) {
    if (error instanceof YoutubeChannelFeedError) throw error;
    if (externallyAborted) {
      throw new YoutubeChannelFeedError("The YouTube channel feed request was cancelled.", {
        status: 499,
        code: "youtube_channel_feed_aborted",
        retryable: false,
        cause: error,
      });
    }
    if (timedOut) {
      throw new YoutubeChannelFeedError("The YouTube channel feed request timed out.", {
        status: 504,
        code: "youtube_channel_feed_timeout",
        cause: error,
      });
    }
    throw new YoutubeChannelFeedError("Ravi could not reach YouTube's channel feed.", {
      code: "youtube_channel_feed_network_error",
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export const __testing = {
  decodeXmlText,
  readBoundedText,
  limits: {
    maxFeedBytes: MAX_FEED_BYTES,
    maxTimeoutMs: MAX_TIMEOUT_MS,
  },
};
