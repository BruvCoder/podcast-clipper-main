import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Picks where a 9:16 crop should sit horizontally, instead of always taking the
// middle of the frame. A centre crop assumes the speaker is centred, and on a
// normal two-chair podcast set they are not: measured on a real frame, a centre
// crop put the speaker's face half outside the left edge while filling the
// right half with empty backdrop.
//
// Deliberately produces ONE offset for the whole clip rather than tracking per
// frame. A crop that slides around during a 40-second clip looks worse than a
// slightly imperfect static one, and picking a single well-placed window is
// most of the benefit.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "..", "scripts", "detect_faces.py");

const PYTHON = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const MODEL_PATH = process.env.FACE_MODEL_PATH || "/usr/local/share/vod-clipper/yunet.onnx";
const SAMPLE_COUNT = positiveInteger(process.env.FACE_SAMPLE_COUNT, 7);
const DETECT_TIMEOUT_MS = positiveInteger(process.env.FACE_DETECT_TIMEOUT_MS, 25_000);
// How far the crop may sit from centre, as a fraction of the slack available.
// 1 lets it reach the frame edge; staying just short of that avoids clinging to
// the very edge when one detection is an outlier.
const MAX_SHIFT_RATIO = 0.96;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Runs a child process to completion, resolving stdout. */
function run(command, args, { input, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    if (input != null) {
      // EPIPE here just means the child exited early; the close handler
      // already reports that properly.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) return reject(new Error(`${command} timed out`));
      if (code !== 0) return reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(-300)}`));
      resolve(stdout);
    });
  });
}

/** Grabs `count` evenly spaced stills from [startSec, endSec) as files. */
async function sampleFrames(sourcePath, startSec, endSec, count, directory, signal) {
  const span = Math.max(0.1, endSec - startSec);
  const written = [];
  // Skip the very start and end, which often land on a cut or a fade.
  for (let i = 0; i < count; i++) {
    const at = startSec + span * ((i + 0.5) / count);
    const outPath = path.join(directory, `sample_${i}.jpg`);
    try {
      await run(
        "ffmpeg",
        ["-y", "-v", "error", "-ss", String(at), "-i", sourcePath, "-frames:v", "1", "-q:v", "4", outPath],
        { timeoutMs: DETECT_TIMEOUT_MS, signal }
      );
      if (fs.existsSync(outPath)) written.push(outPath);
    } catch {
      // One bad sample is fine; the median only needs a few.
    }
  }
  return written;
}

/**
 * Chooses the horizontal centre for this clip's crop, in source pixels.
 * Returns null whenever anything is missing or nothing was detected, which
 * means "fall back to a centre crop" — never an exception, because a clip that
 * renders slightly off-centre beats a clip that fails to render.
 */
export async function findCropCentre(sourcePath, startSec, endSec, { signal } = {}) {
  if (!fs.existsSync(MODEL_PATH) || !fs.existsSync(SCRIPT)) return null;

  let directory;
  try {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-clipper-faces-"));
    const frames = await sampleFrames(sourcePath, startSec, endSec, SAMPLE_COUNT, directory, signal);
    if (!frames.length) return null;

    const raw = await run(PYTHON, [SCRIPT, MODEL_PATH], {
      input: frames.join("\n"),
      timeoutMs: DETECT_TIMEOUT_MS,
      signal,
    });

    return centreFromDetections(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Reduces per-frame detections to one x centre.
 *
 * Takes the largest face in each frame (on a two-person set, the speaker on
 * camera is usually the nearer and larger one) and then the median across
 * frames, so a single bad frame or a brief cutaway cannot drag the crop.
 */
export function centreFromDetections(payload) {
  const perFrame = [];
  let frameWidth = null;
  let frameHeight = null;

  for (const frame of payload?.frames || []) {
    const faces = frame.faces || [];
    if (!faces.length) continue;
    const largest = faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
    perFrame.push(largest.x + largest.w / 2);
    frameWidth = frameWidth ?? largest.frameWidth ?? null;
    frameHeight = frameHeight ?? largest.frameHeight ?? null;
  }

  // One lucky detection across a whole clip is not enough to move the crop.
  if (perFrame.length < 2 || !frameWidth || !frameHeight) return null;
  const centre = median(perFrame);
  return Number.isFinite(centre)
    ? { centreX: centre, frameWidth, frameHeight, samples: perFrame.length }
    : null;
}

/** The 9:16 window ffmpeg would cut from a frame of these dimensions. */
export function cropWindow(frameWidth, frameHeight) {
  const width = Math.min(frameWidth, Math.round((frameHeight * 9) / 16));
  const height = Math.min(frameHeight, Math.round((frameWidth * 16) / 9));
  return { width, height };
}

/**
 * Converts a face centre into the `x` offset for ffmpeg's crop filter, clamped
 * so the window stays inside the frame.
 */
export function cropOffsetX(centreX, frameWidth, cropWidth) {
  const slack = frameWidth - cropWidth;
  if (!(slack > 0)) return 0;
  // A non-finite centre would reach ffmpeg as `crop=...:NaN:0`, which fails the
  // whole render. Centre the window instead.
  if (!Number.isFinite(centreX)) return Math.round(slack / 2);
  const ideal = centreX - cropWidth / 2;
  const limit = slack * MAX_SHIFT_RATIO;
  const lower = (slack - limit) / 2;
  return Math.round(Math.min(Math.max(ideal, lower), slack - lower));
}

export const __testing = { median, MAX_SHIFT_RATIO };
