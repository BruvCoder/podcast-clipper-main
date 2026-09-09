import assert from "node:assert/strict";
import test from "node:test";

import { YoutubeChannelFeedError } from "../src/lib/youtubeChannelFeed.js";
import {
  fetchChannelUploads,
  parseUploadItems,
  uploadsPlaylistId,
} from "../src/lib/youtubeDataApi.js";

const CHANNEL_ID = "UC1234567890123456789012";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function item({
  videoId = "abcdefghijk",
  title = "An episode",
  videoPublishedAt = "2026-09-01T12:00:00Z",
  channelId = CHANNEL_ID,
} = {}) {
  return {
    snippet: {
      title,
      resourceId: { videoId },
      videoOwnerChannelId: channelId,
      publishedAt: "2026-08-01T00:00:00Z",
    },
    contentDetails: { videoPublishedAt },
  };
}

test("the uploads playlist is derived from the channel id", () => {
  // Deriving it avoids a channels.list call, which would spend a second quota
  // unit on every poll.
  assert.equal(uploadsPlaylistId(CHANNEL_ID), "UU1234567890123456789012");
});

test("uploads come back oldest first, using the real publish time", () => {
  const entries = parseUploadItems(
    [
      item({ videoId: "newnewnewne", videoPublishedAt: "2026-09-05T10:00:00Z", title: "Newer" }),
      item({ videoId: "oldoldoldol", videoPublishedAt: "2026-09-01T10:00:00Z", title: "Older" }),
    ],
    CHANNEL_ID
  );

  assert.deepEqual(entries.map((entry) => entry.title), ["Older", "Newer"]);
  assert.deepEqual(entries[0], {
    videoId: "oldoldoldol",
    channelId: CHANNEL_ID,
    title: "Older",
    publishedAt: Date.parse("2026-09-01T10:00:00Z"),
    url: "https://www.youtube.com/watch?v=oldoldoldol",
  });
});

test("the playlist-add time is not mistaken for the upload time", () => {
  // snippet.publishedAt is when the video entered the playlist, which is not
  // always when it went live; using it would misorder a set.
  const [entry] = parseUploadItems(
    [item({ videoPublishedAt: "2026-09-09T08:00:00Z" })],
    CHANNEL_ID
  );
  assert.equal(entry.publishedAt, Date.parse("2026-09-09T08:00:00Z"));
});

test("entries Ravi cannot use are skipped rather than queued", () => {
  const entries = parseUploadItems(
    [
      item({ videoId: "keepkeepkee" }),
      // Private and deleted uploads keep their playlist slot.
      item({ videoId: "privateprva", title: "Private video" }),
      item({ videoId: "deleteddelt", title: "Deleted video" }),
      item({ videoId: "short" }),
      // A different channel would seed a clip job from someone else's video.
      item({ videoId: "otherotherc", channelId: "UC9999999999999999999999" }),
      item({ videoId: "nodatenodat", videoPublishedAt: "not a date" }),
    ],
    CHANNEL_ID
  );
  assert.deepEqual(entries.map((entry) => entry.videoId), ["keepkeepkee"]);
});

test("a missing API key fails clearly and without retrying", async () => {
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, {
      apiKey: "",
      fetchImpl: async () => {
        throw new Error("must not call the API without a key");
      },
    }),
    (error) => error instanceof YoutubeChannelFeedError
      && error.code === "youtube_api_not_configured"
      && error.retryable === false
  );
});

test("the request asks for one page of the uploads playlist", async () => {
  let requested;
  await fetchChannelUploads(CHANNEL_ID, {
    apiKey: "test-key",
    fetchImpl: async (url) => {
      requested = new URL(url);
      return jsonResponse({ items: [item()] });
    },
  });

  assert.equal(requested.pathname, "/youtube/v3/playlistItems");
  assert.equal(requested.searchParams.get("playlistId"), "UU1234567890123456789012");
  assert.equal(requested.searchParams.get("part"), "snippet,contentDetails");
  assert.equal(requested.searchParams.get("key"), "test-key");
});

test("an exhausted quota is retryable but a bad key is not", async () => {
  const quota = jsonResponse(
    { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } },
    403
  );
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, { apiKey: "k", fetchImpl: async () => quota }),
    (error) => error.code === "youtube_api_quota_exceeded" && error.retryable === true
  );

  // Retrying a rejected key cannot help and would spend quota doing it.
  const badKey = jsonResponse(
    { error: { code: 400, message: "API key not valid", errors: [{ reason: "badRequest" }] } },
    400
  );
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, { apiKey: "k", fetchImpl: async () => badKey }),
    (error) => error.code === "youtube_api_unauthorized" && error.retryable === false
  );
});

test("a missing channel is not retried, but a server fault is", async () => {
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, {
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: { code: 404 } }, 404),
    }),
    (error) => error.code === "youtube_api_channel_not_found" && error.retryable === false
  );
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, {
      apiKey: "k",
      fetchImpl: async () => jsonResponse({}, 503),
    }),
    (error) => error.code === "youtube_api_http_503" && error.retryable === true
  );
});

test("an unreachable API is reported as retryable rather than crashing the poll", async () => {
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, {
      apiKey: "k",
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    }),
    (error) => error instanceof YoutubeChannelFeedError
      && error.code === "youtube_api_unreachable"
      && error.retryable === true
  );
});

test("a malformed response is not treated as an empty channel", async () => {
  // Reading this as "no uploads" would silently baseline the channel and skip
  // real videos.
  await assert.rejects(
    fetchChannelUploads(CHANNEL_ID, {
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ notItems: true }),
    }),
    (error) => error.code === "youtube_api_invalid"
  );
});
