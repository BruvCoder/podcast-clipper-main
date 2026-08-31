import assert from "node:assert/strict";
import test from "node:test";

import {
  __testing,
  fetchYoutubeChannelFeed,
  normalizeYoutubeChannelId,
  parseYoutubeChannelFeed,
  YoutubeChannelFeedError,
} from "../src/lib/youtubeChannelFeed.js";

const CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const FIRST_VIDEO_ID = "aaaaaaaaaaa";
const SECOND_VIDEO_ID = "bbbbbbbbbbb";

function feed(entries = "", channelId = CHANNEL_ID) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>${channelId.slice(2)}</yt:channelId>
  <title>Fixture channel</title>
  ${entries}
</feed>`;
}

function entry({
  videoId = FIRST_VIDEO_ID,
  channelId = CHANNEL_ID,
  title = "Fixture video",
  published = "2026-08-30T12:00:00Z",
} = {}) {
  return `<entry>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>${title}</title>
    <published>${published}</published>
  </entry>`;
}

test("accepts only immutable UC YouTube channel IDs", () => {
  assert.equal(normalizeYoutubeChannelId(`  ${CHANNEL_ID}  `), CHANNEL_ID);
  for (const value of [
    "",
    "@GoogleDevelopers",
    "https://youtube.com/@GoogleDevelopers",
    CHANNEL_ID.slice(2),
    `${CHANNEL_ID}extra`,
    "UC<script>alert(1)</script>",
  ]) {
    assert.throws(
      () => normalizeYoutubeChannelId(value),
      (error) =>
        error instanceof YoutubeChannelFeedError &&
        error.code === "invalid_youtube_channel_id" &&
        error.status === 400 &&
        error.retryable === false
    );
  }
});

test("parses, decodes, deduplicates, and chronologically sorts Atom entries", () => {
  const xml = feed([
    entry({
      videoId: SECOND_VIDEO_ID,
      title: "Second &amp; stronger &#x1F680;",
      published: "2026-08-30T12:02:00Z",
    }),
    entry({
      videoId: FIRST_VIDEO_ID,
      title: "<![CDATA[First <moment>]]>",
      published: "2026-08-30T12:01:00Z",
    }),
    entry({
      videoId: SECOND_VIDEO_ID,
      title: "Second &amp; stronger &#128640;",
      published: "2026-08-30T12:02:00Z",
    }),
  ].join("\n"));

  assert.deepEqual(parseYoutubeChannelFeed(xml, CHANNEL_ID), [
    {
      videoId: FIRST_VIDEO_ID,
      channelId: CHANNEL_ID,
      title: "First <moment>",
      publishedAt: Date.parse("2026-08-30T12:01:00Z"),
      url: `https://www.youtube.com/watch?v=${FIRST_VIDEO_ID}`,
    },
    {
      videoId: SECOND_VIDEO_ID,
      channelId: CHANNEL_ID,
      title: "Second & stronger 🚀",
      publishedAt: Date.parse("2026-08-30T12:02:00Z"),
      url: `https://www.youtube.com/watch?v=${SECOND_VIDEO_ID}`,
    },
  ]);
});

test("rejects mismatched, malformed, and unverifiable feeds", () => {
  const otherChannelId = "UCaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(
    () => parseYoutubeChannelFeed(feed(entry({ channelId: otherChannelId })), CHANNEL_ID),
    (error) => error?.code === "youtube_channel_feed_mismatch" && error?.retryable === false
  );
  assert.throws(
    () => parseYoutubeChannelFeed("<html>not a feed</html>", CHANNEL_ID),
    (error) => error?.code === "youtube_channel_feed_invalid"
  );
  assert.throws(
    () => parseYoutubeChannelFeed(
      feed(entry({ videoId: "bad", title: "", published: "not-a-date" })),
      CHANNEL_ID
    ),
    (error) => error?.code === "youtube_channel_feed_invalid"
  );
  assert.throws(
    () => parseYoutubeChannelFeed(
      "<?xml version=\"1.0\"?><feed xmlns:yt=\"urn:youtube\"></feed>",
      CHANNEL_ID
    ),
    (error) => error?.code === "youtube_channel_feed_invalid"
  );
  assert.deepEqual(parseYoutubeChannelFeed(feed(), CHANNEL_ID), []);
});

test("fetches only YouTube's fixed Atom endpoint with bounded request options", async () => {
  const calls = [];
  const xml = feed(entry({
    title: "A fetched upload",
    published: "2026-08-30T12:01:00Z",
  }));
  const result = await fetchYoutubeChannelFeed(CHANNEL_ID, {
    timeoutMs: 1_000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(xml, {
        status: 200,
        headers: { "content-type": "application/atom+xml" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.match(calls[0].options.headers.Accept, /application\/atom\+xml/);
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(result[0].videoId, FIRST_VIDEO_ID);
});

test("rejects HTTP failures and declared or streamed oversized feeds", async () => {
  await assert.rejects(
    fetchYoutubeChannelFeed(CHANNEL_ID, {
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    (error) =>
      error?.code === "youtube_channel_feed_http_503" &&
      error?.status === 503 &&
      error?.retryable === true
  );

  await assert.rejects(
    fetchYoutubeChannelFeed(CHANNEL_ID, {
      fetchImpl: async () => new Response("small", {
        status: 200,
        headers: { "content-length": String(__testing.limits.maxFeedBytes + 1) },
      }),
    }),
    (error) => error?.code === "youtube_channel_feed_too_large"
  );

  await assert.rejects(
    fetchYoutubeChannelFeed(CHANNEL_ID, {
      fetchImpl: async () => new Response("x".repeat(__testing.limits.maxFeedBytes + 1)),
    }),
    (error) => error?.code === "youtube_channel_feed_too_large"
  );
});

test("enforces a timeout and respects caller cancellation", async () => {
  function waitForAbort(_url, { signal }) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    });
  }

  await assert.rejects(
    fetchYoutubeChannelFeed(CHANNEL_ID, { fetchImpl: waitForAbort, timeoutMs: 20 }),
    (error) => error?.code === "youtube_channel_feed_timeout" && error?.status === 504
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchYoutubeChannelFeed(CHANNEL_ID, {
      fetchImpl: waitForAbort,
      signal: controller.signal,
    }),
    (error) =>
      error?.code === "youtube_channel_feed_aborted" &&
      error?.status === 499 &&
      error?.retryable === false
  );
});
