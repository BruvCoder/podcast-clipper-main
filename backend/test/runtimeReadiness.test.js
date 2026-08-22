import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testing, inspectRuntimeReadiness } from "../src/lib/runtimeReadiness.js";

const { minimalProbeEnvironment, probeBinary } = __testing;

async function fakeRuntime(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "podcast-runtime-test-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

  const fixtures = {
    "fake-yt-dlp": "2026.08.19",
    ffmpeg: "ffmpeg version 7.1 Copyright fake",
    ffprobe: "ffprobe version 7.1 Copyright fake",
  };
  await Promise.all(
    Object.entries(fixtures).map(([name, output]) =>
      fs.promises.writeFile(
        path.join(directory, name),
        `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
        { mode: 0o755 }
      )
    )
  );
  return directory;
}

test("reports working yt-dlp, ffmpeg, and ffprobe versions without leaking configuration", async (t) => {
  const directory = await fakeRuntime(t);
  const secret = "do-not-expose-this-proxy-password";
  const result = inspectRuntimeReadiness({
    PATH: directory,
    NODE_ENV: "production",
    RESIDENTIAL_PROXY_URL: `http://user:${secret}@geo.iproyal.com:12321`,
    STRIPE_SECRET_KEY: "sk_secret",
    YTDLP_BINARY: path.join(directory, "fake-yt-dlp"),
  });

  assert.deepEqual(result, {
    ok: true,
    ytDlp: { ok: true, version: "2026.08.19" },
    ffmpeg: { ok: true, version: "7.1" },
    ffprobe: { ok: true, version: "7.1" },
    proxy: { configured: true, required: true },
    faceDetection: { ok: false },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|${directory}|sk_secret`));
});

test("reports unavailable binaries with only sanitized status", () => {
  const result = inspectRuntimeReadiness({
    PATH: "/definitely-not-a-real-binary-directory",
    YTDLP_BINARY: "/secret/path/with-a-secret/fake-yt-dlp",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ytDlp, { ok: false, version: null });
  assert.deepEqual(result.ffmpeg, { ok: false, version: null });
  assert.deepEqual(result.ffprobe, { ok: false, version: null });
  assert.doesNotMatch(JSON.stringify(result), /secret|path|fake-yt-dlp/);
});

test("requires a proxy by default in production and allows an explicit opt-out", async (t) => {
  const directory = await fakeRuntime(t);
  const base = { PATH: directory, YTDLP_BINARY: path.join(directory, "fake-yt-dlp") };

  const production = inspectRuntimeReadiness({ ...base, NODE_ENV: "production" });
  assert.equal(production.ok, false);
  assert.deepEqual(production.proxy, { configured: false, required: true });

  const optedOut = inspectRuntimeReadiness({
    ...base,
    NODE_ENV: "production",
    YTDLP_REQUIRE_PROXY: "false",
  });
  assert.equal(optedOut.ok, true);
  assert.deepEqual(optedOut.proxy, { configured: false, required: false });

  const local = inspectRuntimeReadiness(base);
  assert.equal(local.ok, true);
  assert.deepEqual(local.proxy, { configured: false, required: false });
});

test("binary probes use a minimal environment, no shell, and a bounded timeout", () => {
  const environment = {
    PATH: "/usr/bin",
    LANG: "C",
    RESIDENTIAL_PROXY_URL: "http://user:secret@example.com:8080",
    STRIPE_SECRET_KEY: "sk_secret",
  };
  let observed;
  const result = probeBinary("yt-dlp", ["--version"], "yt-dlp", environment, (...args) => {
    observed = args;
    return { status: 0, stdout: "2026.08.19\n", stderr: "" };
  });

  assert.deepEqual(result, { ok: true, version: "2026.08.19" });
  assert.equal(observed[0], "yt-dlp");
  assert.deepEqual(observed[1], ["--version"]);
  assert.equal(observed[2].shell, false);
  assert.equal(observed[2].timeout, 45_000);
  assert.deepEqual(observed[2].env, { PATH: "/usr/bin", LANG: "C", NO_COLOR: "1" });
  assert.deepEqual(minimalProbeEnvironment(environment), observed[2].env);
});
