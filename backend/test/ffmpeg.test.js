import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClip } from "../src/lib/ffmpeg.js";

test("renders video and audio from one local yt-dlp-style source", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-clipper-ffmpeg-test-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.mp4");
  const output = path.join(directory, "clip.mp4");

  const generated = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=24:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(generated.status, 0, generated.stderr);

  await createClip(
    source,
    [
      { word: "local", start: 0.2, end: 0.7 },
      { word: "source", start: 0.75, end: 1.4 },
    ],
    0,
    3,
    output,
    { cropMode: "pad", subtitleColor: "#FFFFFF" }
  );

  const probed = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(probed.status, 0, probed.stderr);
  const streamTypes = JSON.parse(probed.stdout).streams.map((stream) => stream.codec_type);
  assert.ok(streamTypes.includes("video"));
  assert.ok(streamTypes.includes("audio"));
  assert.equal(fs.existsSync(output.replace(/\.mp4$/, ".partial.mp4")), false);
});

test("aborting a render stops ffmpeg promptly and removes its subtitle temp file", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-clipper-ffmpeg-abort-test-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.mp4");
  const output = path.join(directory, "cancelled.mp4");

  const generated = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=8",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(generated.status, 0, generated.stderr);

  const controller = new AbortController();
  const startedAt = Date.now();
  const rendering = createClip(
    source,
    [{ word: "cancel", start: 0, end: 7 }],
    0,
    8,
    output,
    { signal: controller.signal }
  );
  setTimeout(
    () => controller.abort(new DOMException("Job deleted.", "AbortError")),
    20
  );

  await assert.rejects(rendering, (error) => error?.name === "AbortError");
  assert.ok(Date.now() - startedAt < 5_000, "ffmpeg did not stop promptly after abort");
  assert.equal(fs.existsSync(output.replace(/\.mp4$/, ".ass")), false);
  assert.equal(fs.existsSync(output.replace(/\.mp4$/, ".partial.mp4")), false);
  assert.equal(fs.existsSync(output), false);
});
