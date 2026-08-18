import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { prepareSources, getVideoInfo } from "./lib/rapidapi.js";
import { createClip, ensureDir } from "./lib/ffmpeg.js";
import { transcribeAudio } from "./lib/geminiTranscribe.js";
import { pickClips } from "./lib/gemini.js";
import { groupWordsIntoPhrases, phrasesToPromptText } from "./lib/transcript.js";
import { requireAuth } from "./lib/firebaseAdmin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, "..", "jobs");
ensureDir(JOBS_DIR);

// Node terminates the whole process on an unhandled promise rejection by
// default — meaning one bad rejection anywhere would take down every other
// in-flight job, not just the one that caused it. This is a backstop, not a
// substitute for handling errors at the source.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Only rendered clips are shareable by URL. Never expose source videos,
// extracted audio, partial downloads, or other per-job working files.
app.get("/files/:jobId/clips/:fileName", (req, res, next) => {
  const { jobId, fileName } = req.params;
  const validJobId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    jobId
  );
  const validClipName = /^clip_[1-9][0-9]*\.mp4$/.test(fileName);
  if (!validJobId || !validClipName) return res.status(404).json({ error: "Clip not found." });

  const clipPath = path.join(JOBS_DIR, jobId, "clips", fileName);
  res.sendFile(clipPath, { dotfiles: "deny" }, (err) => {
    if (!err) return;
    if (err.status === 404 || err.code === "ENOENT") {
      return res.status(404).json({ error: "Clip not found." });
    }
    next(err);
  });
});

// Jobs live in memory for fast access, backed by a job.json file per job dir
// so history survives backend restarts and is available to a user from any
// device (it's keyed by Firebase uid and served from this one backend).
const jobs = new Map();

function jobMetaPath(id) {
  return path.join(JOBS_DIR, id, "job.json");
}

function persistJob(job) {
  try {
    fs.writeFileSync(jobMetaPath(job.id), JSON.stringify(job));
  } catch (err) {
    console.error(`Failed to persist job ${job.id}:`, err);
  }
}

function loadJobsFromDisk() {
  let entries;
  try {
    entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(jobMetaPath(entry.name), "utf-8");
      const job = JSON.parse(raw);
      // A job that was still "running"/"queued" when the backend last
      // stopped will never finish now — surface that instead of leaving
      // the client polling a job that's silently dead forever.
      if (job.status === "running" || job.status === "queued") {
        job.status = "error";
        job.stage = "Failed";
        job.error = "Interrupted by a server restart. Please try again.";
      }
      jobs.set(job.id, job);
    } catch {
      // No job.json (older job dir) or unreadable — skip it.
    }
  }
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  jobs.set(id, job);
  persistJob(job);
}

loadJobsFromDisk();

app.post("/api/jobs", requireAuth, (req, res) => {
  const { youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode } = req.body || {};

  if (!youtubeUrl || typeof youtubeUrl !== "string") {
    return res.status(400).json({ error: "youtubeUrl is required." });
  }
  const n = Number(numClips) || 5;
  const len = Number(clipLengthSec) || 45;
  const color = /^#[0-9A-Fa-f]{6}$/.test(subtitleColor || "") ? subtitleColor : "#FFFFFF";
  const crop = cropMode === "crop" ? "crop" : "pad";

  const id = randomUUID();
  const jobDir = ensureDir(path.join(JOBS_DIR, id));

  const job = {
    id,
    uid: req.uid,
    status: "queued",
    stage: "Queued",
    error: null,
    clips: [],
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  persistJob(job);

  res.json({ jobId: id });

  // Fire and forget; client polls GET /api/jobs/:id for progress.
  runPipeline(id, jobDir, {
    youtubeUrl,
    numClips: n,
    clipLengthSec: len,
    subtitleColor: color,
    cropMode: crop,
  }).catch((err) => {
    console.error(`Job ${id} failed:`, err);
    updateJob(id, { status: "error", stage: "Failed", error: err.message || String(err) });
  });
});

app.get("/api/jobs", requireAuth, (req, res) => {
  const list = [...jobs.values()]
    .filter((j) => j.uid === req.uid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      id: j.id,
      status: j.status,
      stage: j.stage,
      sourceTitle: j.sourceTitle || null,
      createdAt: j.createdAt,
      clipCount: (j.clips || []).length,
    }));
  res.json({ jobs: list });
});

app.get("/api/jobs/:id", requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.uid !== req.uid) return res.status(403).json({ error: "This job belongs to a different account." });
  res.json(job);
});

async function runPipeline(id, jobDir, { youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode }) {
  updateJob(id, { status: "running", stage: "Fetching video info" });
  const info = await getVideoInfo(youtubeUrl);

  // Only the (small, fast) audio track gets downloaded here — the video is
  // validated but never fetched in full; each clip render seeks directly
  // into its remote URL for just its own time window later.
  const { audioPath, videoUrl, videoHeaders, durationSec } = await prepareSources(
    youtubeUrl,
    jobDir,
    (line) => {
      const stage = typeof line === "string" && line.trim() ? line.trim().slice(0, 160) : "Preparing sources";
      updateJob(id, { stage });
    }
  );

  // Real word-level timestamps from Gemini, used both for tight subtitle
  // sync and (grouped into phrases below) for the clip-selection prompt.
  updateJob(id, { stage: "Transcribing with Gemini" });
  const words = await transcribeAudio(audioPath);
  if (!words.length) throw new Error("Transcription returned no words.");

  const videoDurationSec = info.durationSec || durationSec || words[words.length - 1].end;
  const phrases = groupWordsIntoPhrases(words);

  updateJob(id, { stage: "Selecting and ranking best moments with Gemini" });
  const picks = await pickClips(phrasesToPromptText(phrases), {
    numClips,
    clipLengthSec,
    videoDurationSec,
  });
  if (!picks.length) throw new Error("Gemini did not return any clip picks.");

  const clipsOut = [];
  const clipsDir = ensureDir(path.join(jobDir, "clips"));

  updateJob(id, {
    stage: `Rendering ${picks.length} clip${picks.length === 1 ? "" : "s"} (0 of ${picks.length})`,
  });

  // Render several clips concurrently instead of one at a time — each is an
  // independent ffmpeg process, so this is a straightforward multi-core win.
  await mapWithConcurrency(picks, CLIP_RENDER_CONCURRENCY, async (pick, i) => {
    const finalPath = path.join(clipsDir, `clip_${i + 1}.mp4`);

    // Reframes to 9:16 and burns in punchy word-chunk captions (real
    // word-level timing) in one ffmpeg pass. Video is fetched directly from
    // videoUrl for just this clip's window; audio is the local track
    // already downloaded for transcription.
    await createClip({ url: videoUrl, headers: videoHeaders }, audioPath, words, pick.start, pick.end, finalPath, {
      cropMode,
      subtitleColor,
    });

    // Phrase-level transcript for this clip's window, for the "scene analysis" detail view.
    const clipPhrases = phrases
      .filter((p) => p.end > pick.start && p.start < pick.end)
      .map((p) => ({
        start: Math.max(0, p.start - pick.start),
        end: Math.max(0.1, p.end - pick.start),
        text: p.text,
      }));

    clipsOut.push({
      index: i + 1,
      title: pick.title,
      hook: pick.hook,
      viralityScore: Math.round(pick.viralityScore),
      reason: pick.reason,
      startSec: pick.start,
      endSec: pick.end,
      durationSec: Math.round(pick.end - pick.start),
      url: `/files/${id}/clips/clip_${i + 1}.mp4`,
      transcript: clipPhrases,
    });

    // Keep clients seeing progress incrementally as clips finish (order may
    // not match pick order since renders run in parallel).
    updateJob(id, {
      stage: `Rendering ${picks.length} clip${picks.length === 1 ? "" : "s"} (${clipsOut.length} of ${picks.length})`,
      clips: [...clipsOut].sort((a, b) => b.viralityScore - a.viralityScore),
    });
  });

  updateJob(id, {
    status: "done",
    stage: "Done",
    sourceTitle: info.title,
    clips: clipsOut.sort((a, b) => b.viralityScore - a.viralityScore),
  });
}

// Clip renders are independent ffmpeg processes, so running a few at once
// (instead of one at a time) is a straightforward way to cut total render
// time on any machine with more than one CPU core.
const CLIP_RENDER_CONCURRENCY =
  Number.parseInt(process.env.CLIP_RENDER_CONCURRENCY, 10) ||
  Math.max(1, Math.min(4, os.cpus().length - 1));

async function mapWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

const PORT = process.env.PORT || 8787;

// Safety net: any error that reaches here (thrown synchronously in a route,
// or passed to next(err)) gets a JSON response instead of Express's default
// HTML error page — the frontend always expects JSON from /api routes.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Podcast Clipper backend listening on http://localhost:${PORT}`);
});
