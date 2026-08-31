import test from "node:test";
import assert from "node:assert/strict";

import {
  extractYouTubeVideoId,
  isValidYouTubeChannelUrl,
  isValidYouTubeUrl,
  normalizeYouTubeChannelUrl,
} from "../src/youtube.js";

const videoId = "tHOf1N1Q2Fg";

test("accepts supported YouTube URL shapes", () => {
  const urls = [
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}&feature=share`,
    `https://youtube.com/watch?feature=share&v=${videoId}`,
    `https://youtu.be/${videoId}?si=example`,
    `https://youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
  ];

  for (const url of urls) {
    assert.equal(isValidYouTubeUrl(url), true, url);
    assert.equal(extractYouTubeVideoId(url), videoId, url);
  }
});

test("rejects missing, malformed, and lookalike video IDs", () => {
  const urls = [
    "https://youtube.com/watch?v=",
    "https://youtube.com/watch?v=too-short",
    `https://notyoutube.com/watch?v=${videoId}`,
    `https://youtube.com.evil.example/watch?v=${videoId}`,
    "not a URL",
  ];

  for (const url of urls) {
    assert.equal(isValidYouTubeUrl(url), false, url);
    assert.equal(extractYouTubeVideoId(url), null, url);
  }
});

test("normalizes supported public YouTube channel references", () => {
  const channelId = "UC1234567890123456789012";
  const examples = new Map([
    ["@Ravi.Clips", "https://www.youtube.com/@Ravi.Clips"],
    ["@日本", "https://www.youtube.com/@%E6%97%A5%E6%9C%AC"],
    ["https://youtube.com/@ravi·clips", "https://www.youtube.com/@ravi%C2%B7clips"],
    ["https://youtube.com/@Ravi_Clips/", "https://www.youtube.com/@Ravi_Clips"],
    ["https://youtube.com/@Ravi_Clips/videos", "https://www.youtube.com/@Ravi_Clips"],
    [
      `http://m.youtube.com/channel/${channelId}?view_as=subscriber`,
      `https://www.youtube.com/channel/${channelId}`,
    ],
    [
      `https://www.youtube.com/channel/${channelId}/featured`,
      `https://www.youtube.com/channel/${channelId}`,
    ],
    ["https://www.youtube.com/c/RaviClips", "https://www.youtube.com/c/RaviClips"],
    ["https://youtube.com/user/RaviClips#videos", "https://www.youtube.com/user/RaviClips"],
  ]);

  for (const [value, expected] of examples) {
    assert.equal(normalizeYouTubeChannelUrl(value), expected, value);
    assert.equal(isValidYouTubeChannelUrl(value), true, value);
  }
});

test("rejects non-channel, unsafe, and lookalike YouTube channel URLs", () => {
  const invalid = [
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    "https://www.youtube.com/playlist?list=PL123",
    `https://www.youtube.com/embed/${videoId}`,
    `https://youtu.be/${videoId}`,
    "https://notyoutube.com/@RaviClips",
    "https://youtube.com.evil.example/@RaviClips",
    "https://user:password@youtube.com/@RaviClips",
    "https://youtube.com:8443/@RaviClips",
    "https://youtube.com:443/@RaviClips",
    "https://youtube.com/@RaviClips/videos/extra",
    "https://youtube.com/channel/UCtoo-short",
    "RaviClips",
    "@.ab",
    "@ab-",
    "not a URL",
  ];

  for (const value of invalid) {
    assert.equal(normalizeYouTubeChannelUrl(value), null, value);
    assert.equal(isValidYouTubeChannelUrl(value), false, value);
  }
});
