import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import Stripe from "stripe";

import { normalizeYouTubeUrl, prepareSource, ytDlpProxyEnabled } from "./lib/ytdlp.js";
import { createClip, ensureDir } from "./lib/ffmpeg.js";
import { transcribeAudio } from "./lib/groqTranscribe.js";
import { pickClips } from "./lib/clipPicker.js";
import { groupWordsIntoPhrases, phrasesToPromptText } from "./lib/transcript.js";
import { getFirebaseAuth, requireAuth } from "./lib/firebaseAdmin.js";
import { createStripeBilling, loadStripeBillingConfig } from "./lib/stripeBilling.js";
import {
  abortJobExecutions,
  createConcurrencyLimiter,
  inspectJobCapacity,
  removeEphemeralMediaWorkspacesSync,
  recoverJobFromDiskSync,
} from "./lib/jobLifecycle.js";
import { inspectRuntimeReadiness } from "./lib/runtimeReadiness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, "..", "jobs");
ensureDir(JOBS_DIR);
removeEphemeralMediaWorkspacesSync(os.tmpdir());
const downloaderProxyEnabled = ytDlpProxyEnabled();
const runtimeReadiness = inspectRuntimeReadiness();
const JOB_PROCESS_CONCURRENCY = positiveInteger(process.env.JOB_PROCESS_CONCURRENCY, 1);
const MAX_OUTSTANDING_JOBS = positiveInteger(process.env.MAX_OUTSTANDING_JOBS, 10);
const MAX_OUTSTANDING_JOBS_PER_USER = positiveInteger(
  process.env.MAX_OUTSTANDING_JOBS_PER_USER,
  2
);
const jobLimiter = createConcurrencyLimiter(JOB_PROCESS_CONCURRENCY);

const billingConfig = loadStripeBillingConfig();
const stripe = billingConfig.enabled
  ? new Stripe(billingConfig.secretKey, { maxNetworkRetries: 2, timeout: 20_000 })
  : null;
const billing = createStripeBilling({
  stripe,
  getAuth: getFirebaseAuth,
  config: billingConfig,
});

// Node terminates the whole process on an unhandled promise rejection by
// default — meaning one bad rejection anywhere would take down every other
// in-flight job, not just the one that caused it. This is a backstop, not a
// substitute for handling errors at the source.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

const app = express();
app.use(cors());

// Stripe verifies the signature against the exact bytes it sent. Mount this
// before express.json(), which would otherwise mutate the request body.
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  billing.handleWebhook
);
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

// Unauthenticated health check that reports which build is actually running.
// Deploys here are triggered manually, so "did my change ship?" is otherwise
// unanswerable without dashboard access — this makes it checkable with curl.
const STARTED_AT = new Date().toISOString();
app.get("/api/health", (req, res) => {
  res.status(runtimeReadiness.ok ? 200 : 503).json({
    ok: runtimeReadiness.ok,
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || "unknown").slice(0, 7),
    branch: process.env.RAILWAY_GIT_BRANCH || "unknown",
    billing: billing.config.state,
    downloader: runtimeReadiness.ytDlp.ok ? "yt-dlp" : "unavailable",
    downloaderVersion: runtimeReadiness.ytDlp.version,
    ffmpeg: runtimeReadiness.ffmpeg.ok ? "configured" : "unavailable",
    ffprobe: runtimeReadiness.ffprobe.ok ? "configured" : "unavailable",
    residentialProxy: downloaderProxyEnabled
      ? "configured"
      : runtimeReadiness.proxy.required
        ? "required"
        : "disabled",
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get("/api/billing/status", requireAuth, billing.handleStatus);
app.post("/api/billing/checkout", requireAuth, billing.handleCheckout);
app.post("/api/billing/portal", requireAuth, billing.handlePortal);

// Jobs live in memory for fast access, backed by a job.json file per job dir
// so history survives backend restarts and is available to a user from any
// device (it's keyed by Firebase uid and served from this one backend).
const jobs = new Map();
// Runtime-only state is intentionally kept out of job.json. Controllers let a
// DELETE stop queued and running work, while promises let the route wait until
// every subprocess/file writer has actually stopped before removing the dir.
const jobExecutions = new Map();
const deletingJobIds = new Set();

function jobMetaPath(id) {
  return path.join(JOBS_DIR, id, "job.json");
}

function persistJob(job) {
  if (deletingJobIds.has(job.id)) return;
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
    const recoveredJobDir = path.join(JOBS_DIR, entry.name);
    try {
      const job = recoverJobFromDiskSync(recoveredJobDir);
      jobs.set(job.id, job);
    } catch {
      // No job.json (older job dir) or unreadable — skip it.
    }
  }
}

function updateJob(id, patch) {
  if (deletingJobIds.has(id)) return;
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  jobs.set(id, job);
  persistJob(job);
}

loadJobsFromDisk();

app.post("/api/jobs", requireAuth, billing.requireActiveSubscription, (req, res) => {
  if (shuttingDown) {
    return res
      .status(503)
      .set("Retry-After", "30")
      .json({ error: "The server is restarting. Please try again shortly." });
  }
  const { youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode } = req.body || {};

  let canonicalYoutubeUrl;
  try {
    canonicalYoutubeUrl = normalizeYouTubeUrl(youtubeUrl);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const capacity = inspectJobCapacity(jobExecutions, jobs, req.uid, {
    maxTotal: MAX_OUTSTANDING_JOBS,
    maxPerUser: MAX_OUTSTANDING_JOBS_PER_USER,
  });
  if (!capacity.available) {
    return res
      .status(429)
      .set("Retry-After", "120")
      .json({ error: "Too many jobs are already queued or running. Please try again later." });
  }

  const parsedNumClips = Number(numClips);
  const parsedClipLength = Number(clipLengthSec);
  const n = Math.max(
    1,
    Math.min(10, Number.isFinite(parsedNumClips) ? Math.trunc(parsedNumClips) : 5)
  );
  const len = Math.max(
    15,
    Math.min(90, Number.isFinite(parsedClipLength) ? Math.trunc(parsedClipLength) : 45)
  );
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

  // Fire and forget; client polls GET /api/jobs/:id for progress. Keep the
  // controller and settled promise so DELETE can cancel and join this work.
  const controller = new AbortController();
  const execution = { controller, promise: null };
  execution.promise = runPipeline(
    id,
    jobDir,
    {
      youtubeUrl: canonicalYoutubeUrl,
      numClips: n,
      clipLengthSec: len,
      subtitleColor: color,
      cropMode: crop,
    },
    controller.signal
  )
    .catch((err) => {
      if (deletingJobIds.has(id) && isAbortError(err)) return;
      console.error(`Job ${id} failed:`, err);
      updateJob(id, { status: "error", stage: "Failed", error: err.message || String(err) });
    })
    .finally(() => {
      if (jobExecutions.get(id) === execution) jobExecutions.delete(id);
    });
  jobExecutions.set(id, execution);
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

app.delete("/api/jobs/:id", requireAuth, async (req, res, next) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.uid !== req.uid) {
    return res.status(403).json({ error: "This job belongs to a different account." });
  }

  deletingJobIds.add(id);
  try {
    const execution = jobExecutions.get(id);
    if (execution) {
      execution.controller.abort(new DOMException("Job deleted.", "AbortError"));
      await execution.promise;
    }

    // Only forget the job after all work has stopped. Otherwise a late
    // progress update could recreate job.json after the directory is removed.
    jobs.delete(id);
    // Remove the rendered clips and job metadata too — otherwise deleting
    // from the sidebar would leave the files occupying the volume forever.
    // The id is a server-generated uuid, and resolve()/startsWith guards
    // against it ever escaping the jobs directory.
    const jobDir = path.resolve(JOBS_DIR, id);
    if (jobDir.startsWith(path.resolve(JOBS_DIR) + path.sep)) {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
    }
    res.json({ deleted: id });
  } catch (err) {
    next(err);
  } finally {
    deletingJobIds.delete(id);
  }
});

async function runPipeline(
  id,
  jobDir,
  { youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode },
  signal
) {
  let releaseJobSlot = null;
  let sourcePath = null;
  let sourceWorkDir = null;
  try {
    releaseJobSlot = await jobLimiter.acquire(signal);
    signal.throwIfAborted();
    // Keep multi-gigabyte temporary sources off the persistent job-history
    // volume. The OS temp filesystem is discarded with the container, while
    // only validated rendered clips and job.json remain durable.
    sourceWorkDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `vod-source-${id}-`));
    updateJob(id, { status: "running", stage: "Fetching video info with yt-dlp" });
    const prepared = await prepareSource(youtubeUrl, sourceWorkDir, (line) => {
      const stage =
        typeof line === "string" && line.trim() ? line.trim().slice(0, 160) : "Downloading source";
      updateJob(id, { stage });
    }, { signal });
    sourcePath = prepared.sourcePath;
    const { info } = prepared;
    signal.throwIfAborted();
    updateJob(id, { sourceTitle: info.title, stage: "Transcribing audio" });

    // Whisper reads the audio stream from the local merged source. yt-dlp is
    // the only component that talks to YouTube; every later stage is local.
    const words = await transcribeAudio(sourcePath, { signal });
    if (!words.length) throw new Error("Transcription returned no words.");

    const videoDurationSec = info.durationSec || words[words.length - 1].end;
    const phrases = groupWordsIntoPhrases(words);

    updateJob(id, { stage: "Selecting and ranking best moments" });
    const rawPicks = await pickClips(phrasesToPromptText(phrases), {
      numClips,
      clipLengthSec,
      videoDurationSec,
      signal,
    });
    // A transcript-timestamp anomaly (or a bad pick) could otherwise slip
    // through as a near-instant, unusable "clip" — reject those outright
    // rather than silently rendering a broken result.
    const MIN_CLIP_SEC = 3;
    const picks = rawPicks.filter((p) => p.end - p.start >= MIN_CLIP_SEC);
    if (!picks.length) {
      throw new Error(
        rawPicks.length
          ? `Every clip pick was shorter than ${MIN_CLIP_SEC}s — likely a transcription timing issue. Please try again.`
          : "Clip selection did not return any picks."
      );
    }

    signal.throwIfAborted();
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
      // word-level timing) from the local yt-dlp source in one ffmpeg pass.
      await createClip(sourcePath, words, pick.start, pick.end, finalPath, {
        cropMode,
        subtitleColor,
        signal,
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
    }, signal);

    signal.throwIfAborted();
    updateJob(id, {
      status: "done",
      stage: "Done",
      sourceTitle: info.title,
      clips: clipsOut.sort((a, b) => b.viralityScore - a.viralityScore),
    });
  } finally {
    // Job history serves only rendered clips. Remove the complete ephemeral
    // source workspace after success, failure, cancellation, or timeout.
    if (sourceWorkDir) {
      await fs.promises.rm(sourceWorkDir, { recursive: true, force: true }).catch(() => {});
    } else if (sourcePath) {
      await fs.promises.rm(sourcePath, { force: true }).catch(() => {});
    }
    releaseJobSlot?.();
  }
}

// Clip renders are independent ffmpeg processes, so running a few at once
// (instead of one at a time) is a straightforward way to cut total render
// time on any machine with more than one CPU core.
const CLIP_RENDER_CONCURRENCY =
  Number.parseInt(process.env.CLIP_RENDER_CONCURRENCY, 10) ||
  Math.max(1, Math.min(4, os.cpus().length - 1));

async function mapWithConcurrency(items, limit, worker, signal) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, run)
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error) {
  return error?.name === "AbortError";
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

const server = app.listen(PORT, () => {
  console.log(`VOD Clipper backend listening on http://localhost:${PORT}`);
  if (!runtimeReadiness.ok) {
    console.error("Downloader runtime is not ready; /api/health will return HTTP 503.");
  }
});

let shuttingDown = false;
async function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signalName} received; cancelling active media jobs before shutdown.`);
  server.close();

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown deadline exceeded; forcing exit.");
    process.exit(1);
  }, 15_000);

  await abortJobExecutions(
    jobExecutions,
    new DOMException("Server is shutting down.", "AbortError")
  );
  server.closeAllConnections?.();
  clearTimeout(forceExit);
  process.exit(0);
}

for (const signalName of ["SIGTERM", "SIGINT"]) {
  process.once(signalName, () => {
    shutdown(signalName).catch((error) => {
      console.error("Graceful shutdown failed:", error);
      process.exit(1);
    });
  });
}
