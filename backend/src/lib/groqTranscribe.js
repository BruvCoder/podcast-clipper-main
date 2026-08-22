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
const MEDIA_PREP_TIMEOUT_MS = positiveInteger(process.env.TRANSCRIBE_MEDIA_TIMEOUT_MS, 5 * 60_000);
const PROBE_TIMEOUT_MS = positiveInteger(process.env.FFPROBE_TIMEOUT_MS, 30_000);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Transcription was cancelled.", "AbortError");
}

function killProcessTree(proc) {
  if (!proc.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // It may have exited between the state check and kill.
    }
  }
}

function runMediaProcess(cmd, args, { signal, timeoutMs, label }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(proc);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on("data", (d) => {
      stdout = `${stdout}${d}`.slice(-4000);
    });
    proc.stderr.on("data", (d) => {
      stderr = `${stderr}${d}`.slice(-4000);
    });
    proc.on("error", (err) => finish(reject, new Error(`Failed to start ${cmd}. Is it installed? (${err.message})`)));
    proc.on("close", (code) => {
      if (aborted) return finish(reject, abortReason(signal));
      if (timedOut) return finish(reject, new Error(`${label} timed out.`));
      if (code !== 0) return finish(reject, new Error(`${label} failed: ${stderr.trim().slice(-1000)}`));
      finish(resolve, { stdout, stderr });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cuts [startSec, startSec+durationSec) out of audioPath into outPath. */
async function cutChunk(audioPath, startSec, durationSec, outPath, signal) {
  await runMediaProcess(
    "ffmpeg",
    [
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
    ],
    { signal, timeoutMs: MEDIA_PREP_TIMEOUT_MS, label: "ffmpeg transcription chunk extraction" }
  );
  return outPath;
}

/** Returns a media file's duration in seconds via ffprobe. */
async function probeDurationSec(filePath, signal) {
  const { stdout } = await runMediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ],
    { signal, timeoutMs: PROBE_TIMEOUT_MS, label: "ffprobe duration check" }
  );
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ffprobe returned an invalid duration for ${filePath}: "${stdout.trim()}"`);
  }
  return value;
}

/** Sends one audio chunk to Groq's Whisper endpoint, retrying transient failures. */
async function transcribeChunk(chunkPath, signal) {
  const data = await groqPostWithRetry(
    "/audio/transcriptions",
    async () => {
      // Rebuilt per attempt: a FormData body can only be consumed once.
      const buffer = await fs.promises.readFile(chunkPath, { signal });
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "audio/mpeg" }), path.basename(chunkPath));
      form.append("model", MODEL);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      return form;
    },
    { attempts: MAX_ATTEMPTS, timeoutMs: TRANSCRIBE_TIMEOUT_MS, label: "Transcription chunk", signal }
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

async function mapWithConcurrency(items, limit, worker, signal) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, runWorker)
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
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
export async function transcribeAudio(audioPath, { signal } = {}) {
  signal?.throwIfAborted();
  requireGroqKey();
  const totalDurationSec = await probeDurationSec(audioPath, signal);

  const chunkStarts = [];
  for (let t = 0; t < totalDurationSec; t += CHUNK_SEC) chunkStarts.push(t);
  if (!chunkStarts.length) chunkStarts.push(0);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "groq-transcribe-"));
  try {
    signal?.throwIfAborted();
    const chunkWords = new Array(chunkStarts.length);

    await mapWithConcurrency(chunkStarts, TRANSCRIBE_CONCURRENCY, async (start, i) => {
      const duration = Math.min(CHUNK_SEC, totalDurationSec - start);
      const chunkPath = path.join(tmpDir, `chunk_${i}.mp3`);
      try {
        await cutChunk(audioPath, start, duration, chunkPath, signal);
        const words = await transcribeChunk(chunkPath, signal);
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
    }, signal);

    return chunkWords.flat();
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
