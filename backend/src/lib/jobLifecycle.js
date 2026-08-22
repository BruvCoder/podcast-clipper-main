import fs from "fs";
import path from "path";

/** Removes complete and partial yt-dlp source files left in a job directory. */
export function removeSourceArtifactsSync(jobDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(jobDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^source\./.test(entry.name)) continue;
    try {
      fs.rmSync(path.join(jobDir, entry.name), { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove stale source artifact ${entry.name}:`, error);
    }
  }

  // Clip renders publish atomically from these non-public working suffixes.
  // A hard kill can bypass their in-process finally cleanup.
  const clipsDir = path.join(jobDir, "clips");
  try {
    for (const entry of fs.readdirSync(clipsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^clip_[1-9][0-9]*\.(?:partial\.mp4|ass)$/.test(entry.name)) {
        continue;
      }
      fs.rmSync(path.join(clipsDir, entry.name), { force: true });
    }
  } catch {
    // Jobs without rendered clips do not have this directory yet.
  }
}

/** Sweeps process-crash leftovers from the container's ephemeral temp disk. */
export function removeEphemeralMediaWorkspacesSync(tempRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^(?:vod-source-|groq-transcribe-)/.test(entry.name)
    ) {
      continue;
    }
    try {
      fs.rmSync(path.join(tempRoot, entry.name), { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove stale media workspace ${entry.name}:`, error);
    }
  }
}

/**
 * Recovers one persisted job on startup. Work itself cannot be resumed, so an
 * interrupted state is made terminal and written back before clients poll it.
 */
export function recoverJobFromDiskSync(jobDir) {
  // Sweep first so even a legacy/unreadable job directory cannot retain a
  // multi-GB source file forever.
  removeSourceArtifactsSync(jobDir);

  const metaPath = path.join(jobDir, "job.json");
  const job = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  if (job.status === "running" || job.status === "queued") {
    job.status = "error";
    job.stage = "Failed";
    job.error = "Interrupted by a server restart. Please try again.";
    try {
      fs.writeFileSync(metaPath, JSON.stringify(job));
    } catch (error) {
      console.error(`Failed to persist interrupted job ${job.id}:`, error);
    }
  }
  return job;
}

/** Returns current global/per-user queue usage without exposing job details. */
export function inspectJobCapacity(jobExecutions, jobs, uid, { maxTotal, maxPerUser }) {
  if (![maxTotal, maxPerUser].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError("Job capacity limits must be positive integers.");
  }
  const total = jobExecutions.size;
  let forUser = 0;
  for (const jobId of jobExecutions.keys()) {
    if (jobs.get(jobId)?.uid === uid) forUser += 1;
  }
  return {
    available: total < maxTotal && forUser < maxPerUser,
    total,
    forUser,
  };
}

/** Cancels and joins a stable snapshot of queued/running job executions. */
export async function abortJobExecutions(jobExecutions, reason) {
  const executions = [...jobExecutions.values()];
  for (const execution of executions) execution.controller.abort(reason);
  await Promise.allSettled(executions.map((execution) => execution.promise));
}

/** A FIFO, abort-aware concurrency limiter. Each acquired slot returns a release function. */
export function createConcurrencyLimiter(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Concurrency limit must be a positive integer.");
  }

  let active = 0;
  const waiters = [];

  function dispatch() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      active += 1;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  }

  return {
    acquire(signal) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        waiters.push(waiter);
        dispatch();
      });
    },
  };
}
