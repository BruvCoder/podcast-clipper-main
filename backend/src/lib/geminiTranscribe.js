import { GoogleGenAI } from "@google/genai";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

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

const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Long episodes are split into chunks before transcription: it keeps each
// request's audio (base64-inlined) and JSON response comfortably small, and
// short clips transcribe far more reliably than asking a model to hold
// word-accurate timing across a full hour in one pass.
const CHUNK_SEC = positiveInteger(process.env.TRANSCRIBE_CHUNK_SEC, 360);
const TRANSCRIBE_CONCURRENCY = positiveInteger(process.env.TRANSCRIBE_CONCURRENCY, 3);

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

/** Cuts [startSec, startSec+durationSec) out of audioPath into outPath without re-encoding. */
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
      "-c",
      "copy",
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

  const response = await ai.models.generateContent({
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
    },
  });

  const parsed = JSON.parse(response.text);
  return Array.isArray(parsed.words) ? parsed.words : [];
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
        const words = await transcribeChunk(chunkPath);
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
