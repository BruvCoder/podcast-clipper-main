import assert from "node:assert/strict";
import test from "node:test";

import { describeProgress } from "../src/progress.js";

// The exact strings the backend emits today (server.js / ytdlp.js).
const REAL_STAGES = [
  "Queued",
  "Fetching video info with yt-dlp",
  "Downloading source video with yt-dlp",
  "Downloading source  45.2% at 1.20MiB/s ETA 00:30",
  "YouTube rejected proxy session 2; rotating IPRoyal IP and retrying",
  "Transcribing audio",
  "Selecting and ranking best moments",
  "Rendering 3 clips (1 of 3)",
  "Done",
];

// Anything that would tell a customer how the sausage is made.
const FORBIDDEN = /yt-?dlp|ffmpeg|ffprobe|groq|whisper|gpt|openai|iproyal|proxy|rapidapi|gemini|stripe|firebase/i;

test("never leaks an internal tool or vendor name into the label", () => {
  for (const stage of REAL_STAGES) {
    const { label } = describeProgress(stage);
    assert.doesNotMatch(label, FORBIDDEN, `leaked internals for stage: ${stage}`);
  }
});

test("an unrecognised stage falls back instead of being shown verbatim", () => {
  const { label } = describeProgress("Uploading to some-internal-service v4.2");
  assert.doesNotMatch(label, /some-internal-service/);
  assert.equal(label, "Working…");
});

test("progress advances monotonically across the real pipeline order", () => {
  const percents = REAL_STAGES
    // The proxy-retry line is a stall, not a step forward, so exclude it here.
    .filter((s) => !/rotating/i.test(s))
    .map((s) => describeProgress(s).percent);
  for (let i = 1; i < percents.length; i++) {
    assert.ok(
      percents[i] >= percents[i - 1],
      `percent went backwards: ${percents[i - 1]} -> ${percents[i]} (${REAL_STAGES[i]})`
    );
  }
});

test("uses the download percentage reported by the backend", () => {
  const low = describeProgress("Downloading source  10.0% at 1MiB/s");
  const high = describeProgress("Downloading source  90.0% at 1MiB/s");
  assert.equal(low.label, "Downloading video");
  assert.ok(high.percent > low.percent, "90% must map higher than 10%");
  assert.ok(high.percent < 50, "download must stay within its slice of the bar");
});

test("counts clips as they finish rendering", () => {
  const first = describeProgress("Rendering 4 clips (0 of 4)");
  const last = describeProgress("Rendering 4 clips (3 of 4)");
  assert.equal(first.label, "Creating your clips (1 of 4)");
  assert.equal(last.label, "Creating your clips (4 of 4)");
  assert.ok(last.percent > first.percent);
});

test("start and finish anchor the bar at 0 and 100", () => {
  assert.equal(describeProgress("Queued").percent, 0);
  assert.equal(describeProgress("Done").percent, 100);
  assert.equal(describeProgress("").percent, 0);
  assert.equal(describeProgress(undefined).percent, 0);
});
