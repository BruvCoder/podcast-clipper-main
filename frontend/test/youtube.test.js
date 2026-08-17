import test from "node:test";
import assert from "node:assert/strict";

import { extractYouTubeVideoId, isValidYouTubeUrl } from "../src/youtube.js";

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
