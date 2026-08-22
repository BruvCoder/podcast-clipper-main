import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  abortJobExecutions,
  createConcurrencyLimiter,
  inspectJobCapacity,
  recoverJobFromDiskSync,
  removeEphemeralMediaWorkspacesSync,
  removeSourceArtifactsSync,
} from "../src/lib/jobLifecycle.js";

test("shutdown cancellation aborts and joins every outstanding execution", async () => {
  const controllers = [new AbortController(), new AbortController()];
  const joined = [];
  const executions = new Map(
    controllers.map((controller, index) => [
      `job-${index}`,
      {
        controller,
        promise: new Promise((resolve) => {
          controller.signal.addEventListener("abort", () => {
            joined.push(index);
            resolve();
          }, { once: true });
        }),
      },
    ])
  );

  await abortJobExecutions(
    executions,
    new DOMException("Server is shutting down.", "AbortError")
  );
  assert.deepEqual(joined.sort(), [0, 1]);
  assert.ok(controllers.every((controller) => controller.signal.aborted));
});

test("queue capacity enforces both global and per-user outstanding-job limits", () => {
  const executions = new Map([
    ["job-1", {}],
    ["job-2", {}],
  ]);
  const jobs = new Map([
    ["job-1", { uid: "user-a" }],
    ["job-2", { uid: "user-b" }],
  ]);

  assert.deepEqual(inspectJobCapacity(executions, jobs, "user-a", {
    maxTotal: 3,
    maxPerUser: 2,
  }), { available: true, total: 2, forUser: 1 });
  assert.equal(inspectJobCapacity(executions, jobs, "user-a", {
    maxTotal: 2,
    maxPerUser: 2,
  }).available, false);
  assert.equal(inspectJobCapacity(executions, jobs, "user-a", {
    maxTotal: 3,
    maxPerUser: 1,
  }).available, false);
});

test("an aborted queued job leaves the single concurrency slot usable", async () => {
  const limiter = createConcurrencyLimiter(1);
  const releaseFirst = await limiter.acquire();

  const controller = new AbortController();
  const queued = limiter.acquire(controller.signal);
  controller.abort(new DOMException("Job deleted.", "AbortError"));
  await assert.rejects(queued, (error) => error?.name === "AbortError");

  releaseFirst();
  const releaseNext = await limiter.acquire();
  releaseNext();
});

test("startup recovery removes source fragments and persists interrupted status", async (t) => {
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-job-recovery-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));

  const job = { id: "job-1", uid: "user-1", status: "running", stage: "Downloading" };
  await fs.promises.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job));
  await fs.promises.writeFile(path.join(jobDir, "source.mp4"), "complete");
  await fs.promises.writeFile(path.join(jobDir, "source.mp4.part"), "partial");
  await fs.promises.writeFile(path.join(jobDir, "clip_1.mp4"), "keep");

  const recovered = recoverJobFromDiskSync(jobDir);
  assert.equal(recovered.status, "error");
  assert.equal(recovered.stage, "Failed");
  assert.match(recovered.error, /server restart/i);
  assert.equal(fs.existsSync(path.join(jobDir, "source.mp4")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "source.mp4.part")), false);
  assert.equal(fs.existsSync(path.join(jobDir, "clip_1.mp4")), true);

  const persisted = JSON.parse(await fs.promises.readFile(path.join(jobDir, "job.json"), "utf-8"));
  assert.equal(persisted.status, "error");
  assert.equal(persisted.stage, "Failed");
});

test("source sweep also cleans unreadable legacy job directories", async (t) => {
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-job-sweep-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(jobDir, "source.webm.part"), "partial");
  await fs.promises.writeFile(path.join(jobDir, "unrelated.txt"), "keep");
  await fs.promises.mkdir(path.join(jobDir, "clips"));
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.partial.mp4"), "partial");
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.ass"), "subtitles");
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.mp4"), "keep");

  removeSourceArtifactsSync(jobDir);
  assert.deepEqual((await fs.promises.readdir(jobDir)).sort(), ["clips", "unrelated.txt"]);
  assert.deepEqual(await fs.promises.readdir(path.join(jobDir, "clips")), ["clip_1.mp4"]);
});

test("startup sweeps only owned ephemeral media workspaces", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-temp-sweep-test-"));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  for (const name of ["vod-source-job-1", "groq-transcribe-fixture", "unrelated-cache"]) {
    await fs.promises.mkdir(path.join(tempRoot, name));
    await fs.promises.writeFile(path.join(tempRoot, name, "data"), "fixture");
  }

  removeEphemeralMediaWorkspacesSync(tempRoot);
  assert.deepEqual(await fs.promises.readdir(tempRoot), ["unrelated-cache"]);
});
