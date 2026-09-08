import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_UPLOAD_SEC,
  UploadError,
  describeProbedSource,
  displayTitleFromFilename,
  isAcceptedVideoType,
  loadUploadConfig,
  streamToFile,
} from "../src/lib/uploadSource.js";

async function tempDir(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-upload-test-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

function probe({ streams = [], duration = "120.5" } = {}) {
  return { streams, format: { duration } };
}

const AUDIO_AND_VIDEO = [{ codec_type: "video" }, { codec_type: "audio" }];

test("upload limits fall back to conservative defaults", () => {
  const config = loadUploadConfig({});
  assert.equal(config.maxBytes, DEFAULT_MAX_UPLOAD_BYTES);
  assert.equal(config.maxDurationSec, DEFAULT_MAX_UPLOAD_SEC);

  const tuned = loadUploadConfig({ UPLOAD_MAX_BYTES: "1024", UPLOAD_MAX_DURATION_SEC: "60" });
  assert.equal(tuned.maxBytes, 1024);
  assert.equal(tuned.maxDurationSec, 60);

  // Nonsense must not disable the cap.
  const junk = loadUploadConfig({ UPLOAD_MAX_BYTES: "-5", UPLOAD_MAX_DURATION_SEC: "abc" });
  assert.equal(junk.maxBytes, DEFAULT_MAX_UPLOAD_BYTES);
  assert.equal(junk.maxDurationSec, DEFAULT_MAX_UPLOAD_SEC);
});

test("obviously wrong content types are rejected before any bytes move", () => {
  assert.equal(isAcceptedVideoType("video/mp4"), true);
  assert.equal(isAcceptedVideoType("video/quicktime; codecs=avc1"), true);
  // Browsers send this for plenty of real videos, so it has to be allowed and
  // left for ffprobe to judge.
  assert.equal(isAcceptedVideoType("application/octet-stream"), true);
  assert.equal(isAcceptedVideoType("text/html"), false);
  assert.equal(isAcceptedVideoType("image/png"), false);
  assert.equal(isAcceptedVideoType(""), false);
  assert.equal(isAcceptedVideoType(undefined), false);
});

test("a client filename becomes a title and never a path", () => {
  assert.equal(displayTitleFromFilename("My Podcast - Ep 12.mp4"), "My Podcast - Ep 12");
  // Directory components are dropped under either separator.
  assert.equal(displayTitleFromFilename("/var/data/episode.mov"), "episode");
  assert.equal(displayTitleFromFilename("C:\\Users\\me\\episode.mkv"), "episode");
  assert.equal(displayTitleFromFilename("../../etc/passwd"), "passwd");
  assert.equal(displayTitleFromFilename(""), "Uploaded video");
  assert.equal(displayTitleFromFilename(".mp4"), "Uploaded video");
});

test("a percent-encoded filename is decoded", () => {
  // HTTP header values are Latin-1, so the client encodes the name; an accent
  // or an emoji cannot be sent raw.
  assert.equal(displayTitleFromFilename("%C3%A9pisode%20deux.mp4"), "épisode deux");
  // A literal % that is not valid encoding must not throw or blank the title.
  assert.equal(displayTitleFromFilename("100%25 real.mp4"), "100% real");
  assert.equal(displayTitleFromFilename("50%off.mp4"), "50%off");
});

test("control characters are stripped from an uploaded title", () => {
  // These would corrupt logs and job.json if stored verbatim.
  assert.equal(displayTitleFromFilename("ep\u0000one\u001f.mp4"), "ep one");
  assert.equal(displayTitleFromFilename("line\nbreak.mp4"), "line break");
  assert.ok(displayTitleFromFilename(`${"n".repeat(500)}.mp4`).length <= 120);
});

test("a body is streamed to disk and its size reported", async (t) => {
  const dir = await tempDir(t);
  const dest = path.join(dir, "source.mp4");
  const { bytesWritten } = await streamToFile(Readable.from([Buffer.from("hello video")]), dest);

  assert.equal(bytesWritten, 11);
  assert.equal(await fs.promises.readFile(dest, "utf8"), "hello video");
});

test("an oversized upload is cut off and leaves nothing on disk", async (t) => {
  const dir = await tempDir(t);
  const dest = path.join(dir, "big.mp4");
  const chunks = Array.from({ length: 10 }, () => Buffer.alloc(100, 1));

  await assert.rejects(
    streamToFile(Readable.from(chunks), dest, { maxBytes: 250 }),
    (error) => error instanceof UploadError
      && error.code === "upload_too_large"
      && error.status === 413
  );
  // A partial file left behind would occupy the disk for nothing.
  assert.equal(fs.existsSync(dest), false);
});

test("an empty body is refused rather than queued as a job", async (t) => {
  const dir = await tempDir(t);
  const dest = path.join(dir, "empty.mp4");
  await assert.rejects(
    streamToFile(Readable.from([]), dest),
    (error) => error instanceof UploadError && error.code === "empty_upload"
  );
  assert.equal(fs.existsSync(dest), false);
});

test("a probed source reports its duration", () => {
  const described = describeProbedSource(probe({ streams: AUDIO_AND_VIDEO, duration: "95.25" }), {
    maxDurationSec: 600,
  });
  assert.equal(described.durationSec, 95.25);
});

test("files Ravi cannot clip are refused with a reason", () => {
  // Renaming a .txt to .mp4 gets this far; ffprobe is what catches it.
  assert.throws(
    () => describeProbedSource(probe({ streams: [] })),
    (error) => error instanceof UploadError && error.code === "upload_not_video"
  );
  // Nothing to transcribe means the moment picker has nothing to work from.
  assert.throws(
    () => describeProbedSource(probe({ streams: [{ codec_type: "video" }] })),
    (error) => error.code === "upload_no_audio"
  );
  assert.throws(
    () => describeProbedSource(probe({ streams: AUDIO_AND_VIDEO, duration: "N/A" })),
    (error) => error.code === "upload_unreadable"
  );
});

test("a video longer than the limit is refused before it reaches Groq", () => {
  // Duration is capped separately from bytes: a heavily compressed three-hour
  // recording can be smaller than a short high-bitrate one, and transcription
  // is charged by length.
  assert.throws(
    () => describeProbedSource(probe({ streams: AUDIO_AND_VIDEO, duration: "7300" }), {
      maxDurationSec: 7200,
    }),
    (error) => error instanceof UploadError && error.code === "upload_too_long"
  );
});
