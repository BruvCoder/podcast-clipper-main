import { GoogleGenAI } from "@google/genai";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { withGeminiRetry } from "./geminiRetry.js";

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set. Copy backend/.env.example to backend/.env and fill it in.");
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// Transcription is a high-volume, mechanical task (many chunks per episode),
// so it defaults to a distinct low-latency model rather than reusing
// GEMINI_MODEL (which stays tuned for clip-selection's reasoning instead).
const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-flash-lite";

// Long episodes are split into chunks before transcription: it keeps each
// request's audio (base64-inlined) and JSON response comfortably small, and
// short clips transcribe far more reliably than asking a model to hold
// word-accurate timing across a full hour in one pass.
const CHUNK_SEC = positiveInteger(process.env.TRANSCRIBE_CHUNK_SEC, 360);
const TRANSCRIBE_CONCURRENCY = positiveInteger(process.env.TRANSCRIBE_CONCURRENCY, 3);
// Without an explicit timeout, a stalled request just hangs indefinitely —
// no error, no retry, the job sits on "Transcribing" forever. Cap it so a
// stuck request fails and gets picked up by withGeminiRetry instead.
const TRANSCRIBE_TIMEOUT_MS = positiveInteger(process.env.GEMINI_TRANSCRIBE_TIMEOUT_MS, 120_000);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const WORDS_SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word exactly as spoken, no surrounding punctuation." },
          start: { type: "number", description: "Start time in seconds, relative to the start of this clip." },
          end: { type: "number", description: "End time in seconds, relative to the start of this clip." },
        },
        required: ["word", "start", "end"],
      },
    },
  },
  required: ["words"],
};

const SYSTEM_INSTRUCTION = `You are a precise, verbatim speech-to-text transcription engine.

You will be given a short audio clip. Transcribe every word that is spoken, in the exact \
order spoken, including filler words ("um", "uh", "like"), false starts, and repeated words \
— do not clean up, summarize, or skip anything.

For every individual word, report:
- "word": the word exactly as spoken, lowercase, with no surrounding punctuation (an \
apostrophe inside a contraction like "don't" is fine).
- "start": the time in seconds this word begins, relative to the very start of THIS audio clip.
- "end": the time in seconds this word ends, relative to the very start of THIS audio clip.

Timestamps must be non-decreasing and non-overlapping across the sequence, with up to two \
decimal places. If the clip has no speech, return an empty "words" array.

Respond only with JSON matching the provided schema.`;

/**
 * Cuts [startSec, startSec+durationSec) out of audioPath into outPath.
 *
 * Deliberately re-encodes instead of stream-copying: ffmpeg's `-accurate_seek`
 * (on by default) only corrects a fast/approximate `-ss` seek down to the
 * exact requested timestamp when the output is decoded, not when it's a raw
 * stream copy. With `-c copy`, a chunk's *actual* start can silently drift
 * from `startSec` — and since every word timestamp Gemini reports for this
 * chunk gets offset by our assumed `startSec`, that drift would mislabel
 * every word in the chunk against the true audio.
 */
function cutChunk(audioPath, startSec, durationSec, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-ss",
      String(startSec),
      "-i",
      audioPath,
      "-t",
      String(durationSec),
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      outPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new Error(`Failed to start ffmpeg. Is it installed? (${err.message})`)));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg failed cutting a transcription chunk: ${stderr.trim().slice(-1000)}`));
      else resolve(outPath);
    });
  });
}

/** Returns a media file's duration in seconds via ffprobe. */
function probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new Error(`Failed to start ffprobe. Is it installed? (${err.message})`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed reading ${filePath}: ${stderr.trim()}`));
      const value = Number(stdout.trim());
      if (!Number.isFinite(value) || value <= 0) {
        return reject(new Error(`ffprobe returned an invalid duration for ${filePath}: "${stdout.trim()}"`));
      }
      resolve(value);
    });
  });
}

async function transcribeChunk(chunkPath) {
  const ai = getClient();
  const buffer = await fs.promises.readFile(chunkPath);

  const response = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "audio/mpeg", data: buffer.toString("base64") } },
              { text: "Transcribe this audio with word-level timestamps." },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: WORDS_SCHEMA,
          httpOptions: { timeout: TRANSCRIBE_TIMEOUT_MS },
        },
      }),
    { label: "Gemini transcription chunk" }
  );

  const parsed = JSON.parse(response.text);
  return Array.isArray(parsed.words) ? parsed.words : [];
}

// Despite being told timestamps "must be non-decreasing", Gemini's per-word
// timing occasionally resets partway through a chunk's response — the
// transcribed text stays correct and coherent, but the reported time jumps
// sharply backward (e.g. keeps transcribing forward in the audio while its
// self-reported clock resets close to zero). A small amount of backward
// jitter at natural word boundaries is normal; anything beyond that is this
// failure mode, and would otherwise poison offset math, clip selection, and
// ultimately produce clips that don't match their own captions.
const TIMESTAMP_REGRESSION_TOLERANCE_SEC = 1.5;

function findRegressionIndex(words) {
  let maxEnd = -Infinity;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start < maxEnd - TIMESTAMP_REGRESSION_TOLERANCE_SEC) return i;
    maxEnd = Math.max(maxEnd, words[i].end);
  }
  return -1;
}

// Separately from backward jumps, Gemini's self-reported per-word timing
// doesn't reliably calibrate to the clip's true wall-clock length — observed
// directly: a verified-exactly-20.000s chunk came back with its last word
// ending at 30.13s (~50% over), while staying perfectly internally
// monotonic the whole time, so the regression check above can't catch it.
// Since we know each chunk's true duration exactly (we cut it ourselves),
// ALWAYS rescale the reported timestamps to fit it — even a few percent of
// drift adds up to many real seconds over a multi-minute chunk (5% of a
// 360s chunk is 18s of unnoticed slop, which is exactly what let a subtler
// case of this same bug through the first version of this fix). Rescaling
// is a no-op on an already-accurate response, so there's no downside to
// applying it unconditionally.
function reportedMaxEnd(words) {
  return words.length ? Math.max(...words.map((w) => w.end)) : 0;
}

function rescaleToFitDuration(words, trueDurationSec) {
  const maxEnd = reportedMaxEnd(words);
  if (maxEnd <= 0) return words;
  const scale = trueDurationSec / maxEnd;
  return words.map((w) => ({ ...w, start: w.start * scale, end: w.end * scale }));
}

// If the reported span is wildly off from the true duration (not just
// mis-scaled but, say, only the first few words before giving up), a linear
// rescale would distort it further rather than recover it — retry instead.
const PLAUSIBLE_RATIO_MIN = 0.3;
const PLAUSIBLE_RATIO_MAX = 3.0;

function isImplausibleDuration(words, trueDurationSec) {
  const maxEnd = reportedMaxEnd(words);
  if (maxEnd <= 0) return true;
  const ratio = maxEnd / trueDurationSec;
  return ratio < PLAUSIBLE_RATIO_MIN || ratio > PLAUSIBLE_RATIO_MAX;
}

/**
 * Transcribes one chunk, retrying the whole chunk from scratch (a fresh
 * Gemini call is a fresh chance at clean timestamps) if a backward-jump
 * regression or an implausible overall duration is detected, then always
 * rescales the result to the chunk's true duration. If retries still won't
 * come back clean, uses the longest clean prefix seen rather than returning
 * corrupted timestamps — losing part of that chunk's transcript is far
 * better than mislabeling it.
 */
async function transcribeChunkReliably(chunkPath, trueDurationSec, { attempts = 3 } = {}) {
  let best = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const words = await transcribeChunk(chunkPath);
    const regressionAt = findRegressionIndex(words);
    const clean = regressionAt === -1 ? words : words.slice(0, regressionAt);

    const problems = [];
    if (regressionAt !== -1) problems.push(`a timestamp regression at word ${regressionAt} of ${words.length}`);
    if (isImplausibleDuration(clean, trueDurationSec)) {
      problems.push(`an implausible duration (reported ${reportedMaxEnd(clean).toFixed(1)}s for a ${trueDurationSec.toFixed(1)}s clip)`);
    }

    if (clean.length > best.length) best = clean;
    if (!problems.length) return rescaleToFitDuration(clean, trueDurationSec);

    console.warn(
      `Transcription chunk had ${problems.join(" and ")} (attempt ${attempt}/${attempts}), retrying`
    );
  }
  return rescaleToFitDuration(best, trueDurationSec);
}

async function mapWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
}

/**
 * Transcribes an audio file with word-level timestamps using Gemini's audio
 * understanding, chunked into ~CHUNK_SEC-second pieces for reliability and
 * request-size headroom. Returns the same shape faster-whisper used to:
 *   [{ word: "hello", start: 0.12, end: 0.34 }, ...]
 */
export async function transcribeAudio(audioPath) {
  const totalDurationSec = await probeDurationSec(audioPath);

  const chunkStarts = [];
  for (let t = 0; t < totalDurationSec; t += CHUNK_SEC) chunkStarts.push(t);
  if (!chunkStarts.length) chunkStarts.push(0);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gemini-transcribe-"));
  try {
    const chunkWords = new Array(chunkStarts.length);

    await mapWithConcurrency(chunkStarts, TRANSCRIBE_CONCURRENCY, async (start, i) => {
      const duration = Math.min(CHUNK_SEC, totalDurationSec - start);
      const chunkPath = path.join(tmpDir, `chunk_${i}.mp3`);
      try {
        await cutChunk(audioPath, start, duration, chunkPath);
        const words = await transcribeChunkReliably(chunkPath, duration);
        chunkWords[i] = words
          .map((w) => ({
            word: String(w.word || "").trim(),
            start: start + Math.max(0, Number(w.start) || 0),
            end: start + Math.max(0, Number(w.end) || 0),
          }))
          .filter((w) => w.word && w.end > w.start);
      } finally {
        await fs.promises.rm(chunkPath, { force: true }).catch(() => {});
      }
    });

    return chunkWords.flat();
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
