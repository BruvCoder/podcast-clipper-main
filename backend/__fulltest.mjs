import "dotenv/config";
import fs from "fs";
import { spawnSync } from "child_process";
import { prepareSources } from "./src/lib/rapidapi.js";
import { createClip, ensureDir } from "./src/lib/ffmpeg.js";
import { releaseRelay } from "./src/lib/videoRelay.js";

const url = process.argv[2];
const dir = "./__fulltest";
ensureDir(dir);
ensureDir(`${dir}/clips`);

const t0 = Date.now();
const src = await prepareSources(url, dir, (line) => {
  if (typeof line === "string" && !/%|MB received/.test(line)) console.log("  ·", line.slice(0, 100));
});
console.log(`prepareSources: ${((Date.now() - t0) / 1000).toFixed(1)}s | audio ${(fs.statSync(src.audioPath).size / 1024 / 1024).toFixed(1)}MB`);
console.log("");

// Render two clips at different offsets, mimicking a real job.
const targets = [
  [120, 40],
  [600, 40],
];
let pass = 0;
for (const [start, len] of targets) {
  const out = `${dir}/clips/clip_${start}.mp4`;
  const words = [
    { word: "one", start: start + 0.3, end: start + 0.8 },
    { word: "two", start: start + 1.0, end: start + 1.5 },
  ];
  const t = Date.now();
  try {
    await createClip({ url: src.videoUrl, headers: src.videoHeaders }, src.audioPath, words, start, start + len, out, {
      cropMode: "pad",
      subtitleColor: "#FFFFFF",
    });
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", out],
      { encoding: "utf8" }
    );
    const info = JSON.parse(probe.stdout);
    const kinds = (info.streams || []).map((s) => s.codec_type).join("+");
    console.log(`clip @${start}s: ${((Date.now() - t) / 1000).toFixed(1)}s | ${(fs.statSync(out).size / 1024).toFixed(0)}KB | streams: ${kinds} | dur ${Number(info.format.duration).toFixed(1)}s => PASS`);
    pass++;
  } catch (e) {
    console.log(`clip @${start}s: ${((Date.now() - t) / 1000).toFixed(1)}s => FAIL: ${e.message.slice(0, 160)}`);
  }
}
releaseRelay(src.videoRelayToken);
console.log("");
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s | ${pass}/${targets.length} clips OK`);
process.exit(pass === targets.length ? 0 : 1);
