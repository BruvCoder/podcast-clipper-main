import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { groqPostWithRetry, requireGroqKey } from "./groqClient.js";

// Whisper (hosted on Groq) derives word timestamps from actual acoustic
// alignment against the audio, rather than estimating them the way a
// general-purpose multimodal model does. That distinction is the whole
// reason this module exists: repeated attempts to correct estimated timing
// after the fact never converged, because the underlying numbers were never
// measurements to begin with.
const MODEL = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3";

// Chunking here is only about staying under the API's per-file size limit
// and parallelising long episodes — NOT about timing accuracy, which is why
// these chunks can be far larger than the 45s the estimated-timing approach
// needed. At 64kbps mono mp3 (~0.48 MB/min), 600s is ~4.8MB, comfortably
// under Groq's 25MB free-tier limit.
const CHUNK_SEC = positiveInteger(process.env.TRANSCRIBE_CHUNK_SEC, 600);
const TRANSCRIBE_CONCURRENCY = positiveInteger(process.env.TRANSCRIBE_CONCURRENCY, 3);
const TRANSCRIBE_TIMEOUT_MS = positiveInteger(process.env.GROQ_TRANSCRIBE_TIMEOUT_MS, 180_000);
const MAX_ATTEMPTS = positiveInteger(process.env.GROQ_TRANSCRIBE_ATTEMPTS, 4);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Cuts [startSec, startSec+durationSec) out of audioPath into outPath. */
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

/** Sends one audio chunk to Groq's Whisper endpoint, retrying transient failures. */
async function transcribeChunk(chunkPath) {
  const data = await groqPostWithRetry(
    "/audio/transcriptions",
    async () => {
      // Rebuilt per attempt: a FormData body can only be consumed once.
      const buffer = await fs.promises.readFile(chunkPath);
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "audio/mpeg" }), path.basename(chunkPath));
      form.append("model", MODEL);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      return form;
    },
    { attempts: MAX_ATTEMPTS, timeoutMs: TRANSCRIBE_TIMEOUT_MS, label: "Transcription chunk" }
  );

  // verbose_json with word granularity returns a flat `words` array. Fall
  // back to segment-level timing only if words are unavailable, so a partial
  // response degrades instead of throwing away the chunk.
  if (Array.isArray(data.words) && data.words.length) return data.words;
  if (Array.isArray(data.segments)) {
    return data.segments.map((s) => ({ word: String(s.text || "").trim(), start: s.start, end: s.end }));
  }
  return [];
}

// Whisper smears a word's START backward across a preceding silence: a word
// spoken right after a long pause can be reported as beginning when the
// *previous* speech ended. Verified directly against a synthetic file with
// speech at known positions — a word truly starting at 20.0s came back as
// start=5.62, end=20.28. The end time is accurate; only the start is wrong.
// Left uncorrected this is highly visible, because captions are grouped a
// few words at a time, so one smeared start drags a whole caption early.
//
// Real speech rarely exceeds ~1s for a single word, so any word claiming a
// much longer span is this artifact. Trust the end (which is accurate) and
// re-derive a plausible start from the word's length.
const MAX_PLAUSIBLE_WORD_SEC = positiveInteger(process.env.MAX_WORD_SEC_X100, 200) / 100;
const SEC_PER_CHAR = 0.08;
const MIN_WORD_SEC = 0.12;
const MAX_ESTIMATED_WORD_SEC = 1.0;

function estimateWordDuration(word) {
  const raw = word.replace(/[^\p{L}\p{N}]/gu, "").length * SEC_PER_CHAR;
  return Math.min(MAX_ESTIMATED_WORD_SEC, Math.max(MIN_WORD_SEC, raw));
}

function repairSmearedStarts(words) {
  return words.map((w) => {
    if (w.end - w.start <= MAX_PLAUSIBLE_WORD_SEC) return w;
    const start = Math.max(0, w.end - estimateWordDuration(w.word));
    return { ...w, start };
  });
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
 * Transcribes an audio file with word-level timestamps using Whisper hosted
 * on Groq. Returns the shape the rest of the pipeline expects:
 *   [{ word: "hello", start: 0.12, end: 0.34 }, ...]
 *
 * Note there is deliberately no timestamp "correction" pass here. Whisper's
 * timings are measured against the audio, so the only adjustment applied is
 * adding each chunk's start offset. Rescaling accurate timestamps to fill a
 * chunk's full duration would actively introduce error — a chunk ending in
 * silence legitimately has its last word finish before the chunk does.
 */
export async function transcribeAudio(audioPath) {
  requireGroqKey();
  const totalDurationSec = await probeDurationSec(audioPath);

  const chunkStarts = [];
  for (let t = 0; t < totalDurationSec; t += CHUNK_SEC) chunkStarts.push(t);
  if (!chunkStarts.length) chunkStarts.push(0);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "groq-transcribe-"));
  try {
    const chunkWords = new Array(chunkStarts.length);

    await mapWithConcurrency(chunkStarts, TRANSCRIBE_CONCURRENCY, async (start, i) => {
      const duration = Math.min(CHUNK_SEC, totalDurationSec - start);
      const chunkPath = path.join(tmpDir, `chunk_${i}.mp3`);
      try {
        await cutChunk(audioPath, start, duration, chunkPath);
        const words = await transcribeChunk(chunkPath);
        const normalized = words
          .map((w) => ({
            word: String(w.word ?? "").trim(),
            start: Math.max(0, Number(w.start) || 0),
            end: Math.max(0, Number(w.end) || 0),
          }))
          .filter((w) => w.word && w.end > w.start);
        chunkWords[i] = repairSmearedStarts(normalized).map((w) => ({
          ...w,
          start: start + w.start,
          end: start + w.end,
        }));
      } finally {
        await fs.promises.rm(chunkPath, { force: true }).catch(() => {});
      }
    });

    return chunkWords.flat();
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
