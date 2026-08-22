import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __testing,
  downloadVideo,
  normalizeYouTubeUrl,
  prepareSource,
  ytDlpProxyEnabled,
} from "../src/lib/ytdlp.js";

const {
  abortAwareDelay,
  buildPrivateConfig,
  canonicalizeYouTubeUrl,
  commonArgs,
  loadProxyUrl,
  minimalChildEnvironment,
  outputFormat,
  parseMetadata,
  redactSensitiveText,
  rotateIproyalSession,
  runYtDlp,
  sessionEnvironment,
  sourceArtifactBytesSync,
  validateDownloadedPath,
  limits,
} = __testing;

async function temporaryDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vod-clipper-ytdlp-test-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function executableFixture(t, source) {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "fake-yt-dlp");
  await fs.promises.writeFile(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return file;
}

test("canonicalizes supported individual YouTube URL shapes", () => {
  const id = "dQw4w9WgXcQ";
  for (const value of [
    `https://www.youtube.com/watch?list=PL123&v=${id}&t=2`,
    `https://m.youtube.com/watch?t=2&v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) {
    assert.equal(normalizeYouTubeUrl(value), `https://www.youtube.com/watch?v=${id}`);
  }
  assert.deepEqual(canonicalizeYouTubeUrl(`https://youtu.be/${id}`), {
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
  });
});

test("rejects arbitrary hosts, credentials, ports, playlists, and malformed IDs", () => {
  const invalid = [
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://evil.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/playlist?list=PL123",
    "https://youtu.be/not-long-enough",
    "file:///etc/passwd",
    "not a URL",
    `https://youtube.com/watch?v=dQw4w9WgXcQ&padding=${"x".repeat(2_100)}`,
  ];
  for (const value of invalid) assert.throws(() => normalizeYouTubeUrl(value), /valid public YouTube/);
});

test("validates residential proxy variables and the legacy alias", () => {
  const proxy = "http://proxy-user:proxy-pass@geo.iproyal.com:12321";
  assert.equal(loadProxyUrl({ RESIDENTIAL_PROXY_URL: proxy }), proxy);
  assert.equal(loadProxyUrl({ MEDIA_PROXY_URL: `${proxy}/` }), proxy);
  assert.equal(ytDlpProxyEnabled({ RESIDENTIAL_PROXY_URL: proxy }), true);
  assert.equal(ytDlpProxyEnabled({}), false);

  assert.throws(
    () => loadProxyUrl({ RESIDENTIAL_PROXY_URL: proxy, MEDIA_PROXY_URL: "http://other:pass@127.0.0.1:8080" }),
    /different proxies/
  );
  for (const value of ["socks5://user:pass@127.0.0.1:1080", `${proxy}/path`, "not-a-url"]) {
    assert.throws(() => loadProxyUrl({ RESIDENTIAL_PROXY_URL: value }), /Invalid residential/);
  }
});

test("rotates an IPRoyal sticky session without changing its account or routing options", () => {
  const proxy =
    "http://proxy-user:base-secret_country-us_session-OldId123_lifetime-30m@geo.iproyal.com:12321";
  const rotated = rotateIproyalSession(proxy, "NewId456");
  assert.equal(rotated.rotated, true);
  const parsed = new URL(rotated.proxyUrl);
  assert.equal(parsed.username, "proxy-user");
  assert.match(
    decodeURIComponent(parsed.password),
    /base-secret_country-us_session-NewId456_lifetime-30m/
  );
  assert.doesNotMatch(decodeURIComponent(parsed.password), /_streaming-1/);
  assert.doesNotMatch(decodeURIComponent(parsed.password), /OldId123/);

  const session = sessionEnvironment(
    { RESIDENTIAL_PROXY_URL: proxy, MEDIA_PROXY_URL: `${proxy}/` },
    "Same1234"
  );
  assert.equal(session.rotated, true);
  assert.equal(session.environment.RESIDENTIAL_PROXY_URL, session.environment.MEDIA_PROXY_URL);
  assert.match(decodeURIComponent(new URL(session.environment.RESIDENTIAL_PROXY_URL).password), /session-Same1234/);
  assert.doesNotMatch(
    decodeURIComponent(new URL(session.environment.RESIDENTIAL_PROXY_URL).password),
    /_streaming-1/
  );

  const generated = rotateIproyalSession(
    "http://proxy-user:base-secret@geo.iproyal.com:12321",
    "Fresh123"
  );
  assert.match(
    decodeURIComponent(new URL(generated.proxyUrl).password),
    /base-secret_session-Fresh123_lifetime-30m/
  );

  const streaming = sessionEnvironment(
    { RESIDENTIAL_PROXY_URL: proxy, YTDLP_IPROYAL_STREAMING: "true" },
    "Video123"
  );
  assert.match(
    decodeURIComponent(new URL(streaming.environment.RESIDENTIAL_PROXY_URL).password),
    /_session-Video123_lifetime-30m_streaming-1/
  );

  assert.deepEqual(rotateIproyalSession("http://user:pass@proxy.example:8080", "Other123"), {
    proxyUrl: "http://user:pass@proxy.example:8080",
    rotated: false,
  });
});

test("keeps proxy credentials in the private stdin config, not the child environment", () => {
  const secret = "proxy:password";
  const proxy = `http://${encodeURIComponent("user@example.com")}:${encodeURIComponent(secret)}@geo.iproyal.com:12321`;
  const environment = {
    PATH: process.env.PATH,
    GROQ_API_KEY: "must-not-reach-child",
    STRIPE_SECRET_KEY: "must-not-reach-child-either",
    RESIDENTIAL_PROXY_URL: proxy,
    YTDLP_COOKIES_FILE: "/run/secrets/youtube cookies.txt",
  };
  const config = buildPrivateConfig(environment);
  assert.equal(config.proxyEnabled, true);
  assert.match(config.text, /--proxy=/);
  assert.match(config.text, /--cookies=/);
  assert.ok(config.text.includes(proxy));

  const child = minimalChildEnvironment(environment);
  assert.equal(child.GROQ_API_KEY, undefined);
  assert.equal(child.STRIPE_SECRET_KEY, undefined);
  assert.equal(child.RESIDENTIAL_PROXY_URL, undefined);
  assert.equal(child.PATH, process.env.PATH);
});

test("enables the Node JS runtime and bounds the selected source format", () => {
  const args = commonArgs();
  assert.ok(args.includes("--no-plugin-dirs"));
  assert.equal(args[args.indexOf("--js-runtimes") + 1], "node");
  const formats = outputFormat().split("/");
  assert.match(formats[0], /vcodec\^=avc1/);
  assert.match(formats[0], /\+ba\[ext=m4a\]/);
  assert.ok(formats.every((format) => format.includes("height<=720")));
  assert.equal(formats.includes("b"), false);
  assert.deepEqual(limits, {
    maxDurationSec: 4 * 60 * 60,
    maxSourceBytes: 2 * 1024 * 1024 * 1024,
  });
});

test("parses bounded, non-live metadata and rejects unsafe responses", () => {
  const id = "dQw4w9WgXcQ";
  assert.deepEqual(
    parseMetadata(JSON.stringify({ id, title: "  Fixture  ", duration: 42, thumbnail: "https://img.test/x.jpg" }), id),
    { videoId: id, title: "Fixture", durationSec: 42, thumbnail: "https://img.test/x.jpg" }
  );
  assert.throws(() => parseMetadata("not-json", id), /invalid video metadata/);
  assert.throws(() => parseMetadata(JSON.stringify({ id: "aaaaaaaaaaa", title: "Wrong", duration: 42 }), id), /mismatched/);
  assert.throws(() => parseMetadata(JSON.stringify({ id, title: "Live", duration: 42, is_live: true }), id), /Live streams/);
  assert.throws(() => parseMetadata(JSON.stringify({ id, title: "Too long", duration: 4 * 60 * 60 + 1 }), id), /configured limit/);
});

test("redacts proxy URLs, credentials, and authorization headers", () => {
  const proxy = "http://user:super-secret@geo.iproyal.com:12321";
  const safe = redactSensitiveText(
    `failed through ${proxy}\nProxy-Authorization: Basic abc123\nhttp://other:password@proxy.test:8080`,
    [proxy, "super-secret"]
  );
  assert.doesNotMatch(safe, /super-secret|abc123|other:password/);
  assert.match(safe, /\[REDACTED\]/);
});

test("spawns without a shell and exposes secrets only through stdin", async (t) => {
  const binary = await executableFixture(
    t,
    `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  input,
  leakedGroq: process.env.GROQ_API_KEY || null,
  leakedProxy: process.env.RESIDENTIAL_PROXY_URL || null
})));`
  );
  const proxy = "http://user:private-password@geo.iproyal.com:12321";
  const stdout = await runYtDlp(["--fixture-option", "value with spaces"], {
    binary,
    environment: { PATH: process.env.PATH, GROQ_API_KEY: "groq-secret", RESIDENTIAL_PROXY_URL: proxy },
    timeoutMs: 10_000,
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.argv.slice(0, 3), ["--ignore-config", "--config-locations", "-"]);
  assert.ok(result.argv.includes("value with spaces"));
  assert.ok(result.input.includes(proxy));
  assert.equal(result.argv.join(" ").includes(proxy), false);
  assert.equal(result.leakedGroq, null);
  assert.equal(result.leakedProxy, null);
});

test("redacts a proxy even if yt-dlp echoes its private stdin config", async (t) => {
  const binary = await executableFixture(
    t,
    `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => { process.stderr.write("failed " + input); process.exit(1); });`
  );
  const proxy = "http://user:private-password@geo.iproyal.com:12321";
  await assert.rejects(
    runYtDlp([], {
      binary,
      environment: { PATH: process.env.PATH, RESIDENTIAL_PROXY_URL: proxy },
      timeoutMs: 10_000,
    }),
    (error) => {
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /private-password|http:\/\/user:/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("redacts private values from progress callbacks", async (t) => {
  const binary = await executableFixture(
    t,
    `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => { process.stderr.write(input + "\\n"); process.exit(0); });`
  );
  const proxy = "http://user:private-password@geo.iproyal.com:12321";
  const progress = [];
  await runYtDlp([], {
    binary,
    environment: { PATH: process.env.PATH, RESIDENTIAL_PROXY_URL: proxy },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
  });
  assert.ok(progress.length > 0);
  assert.doesNotMatch(progress.join("\n"), /private-password|http:\/\/user:/);
});

test("buffers stderr lines so split proxy secrets never reach progress callbacks", async (t) => {
  const binary = await executableFixture(
    t,
    `process.stdin.resume();
process.stderr.write("proxy failed through http://user:private-");
setTimeout(() => {
  process.stderr.write("password@geo.iproyal.com:12321");
  process.exit(0);
}, 25);`
  );
  const proxy = "http://user:private-password@geo.iproyal.com:12321";
  const progress = [];
  await runYtDlp([], {
    binary,
    environment: { PATH: process.env.PATH, RESIDENTIAL_PROXY_URL: proxy },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
  });
  assert.equal(progress.length, 1);
  assert.doesNotMatch(progress.join("\n"), /private-password|http:\/\/user:/);
  assert.match(progress[0], /\[REDACTED\]/);
});

test("retry backoff can be aborted promptly", async () => {
  const controller = new AbortController();
  const pending = abortAwareDelay(5_000, controller.signal);
  controller.abort("cancel retry");
  await assert.rejects(pending, (error) => error.name === "AbortError" && /cancel retry/.test(error.message));
});

test("terminates a yt-dlp process that exceeds its deadline", async (t) => {
  const binary = await executableFixture(t, `process.stdin.resume(); setInterval(() => {}, 1_000);`);
  const startedAt = Date.now();
  await assert.rejects(
    runYtDlp([], { binary, environment: { PATH: process.env.PATH }, timeoutMs: 100 }),
    (error) => error.code === "ETIMEDOUT" && /deadline/.test(error.message)
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("accepts only real output files contained by the job directory", async (t) => {
  const root = await temporaryDirectory(t);
  const jobDir = path.join(root, "job");
  await fs.promises.mkdir(jobDir);
  const source = path.join(jobDir, "source.mp4");
  await fs.promises.writeFile(source, "media");
  assert.equal(await validateDownloadedPath(jobDir, source), await fs.promises.realpath(source));

  const outside = path.join(root, "outside.mp4");
  await fs.promises.writeFile(outside, "outside");
  await assert.rejects(validateDownloadedPath(jobDir, outside), /outside the job directory/);

  const symlink = path.join(jobDir, "source-link.mp4");
  await fs.promises.symlink(outside, symlink);
  await assert.rejects(validateDownloadedPath(jobDir, symlink), /resolved outside/);
});

test("downloads to the reported path and cleans partial source files on failure", async (t) => {
  const binary = await executableFixture(
    t,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
fs.writeFileSync(output, "fixture-media");
process.stdout.write(output + "\\n");`
  );
  const jobDir = await temporaryDirectory(t);
  const progress = [];
  const source = await downloadVideo("https://youtu.be/dQw4w9WgXcQ", jobDir, (line) => progress.push(line), {
    binary,
    environment: { PATH: process.env.PATH },
    timeoutMs: 10_000,
  });
  assert.equal(path.dirname(source), await fs.promises.realpath(jobDir));
  assert.equal(await fs.promises.readFile(source, "utf8"), "fixture-media");

  const failing = await executableFixture(
    t,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "part");
fs.writeFileSync(output, "partial");
process.exit(1);`
  );
  await assert.rejects(
    downloadVideo("https://youtu.be/dQw4w9WgXcQ", jobDir, null, {
      binary: failing,
      environment: { PATH: process.env.PATH },
      timeoutMs: 10_000,
    }),
    /yt-dlp exited/
  );
  assert.deepEqual((await fs.promises.readdir(jobDir)).filter((name) => /^source\./.test(name)), []);
});

test("terminates a download when aggregate source working files exceed the byte budget", async (t) => {
  const binary = await executableFixture(
    t,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4.part");
fs.writeFileSync(output, Buffer.alloc(8 * 1024));
process.stdin.resume();
setInterval(() => {}, 1_000);`
  );
  const jobDir = await temporaryDirectory(t);
  assert.equal(sourceArtifactBytesSync(jobDir), 0);
  await assert.rejects(
    downloadVideo("https://youtu.be/dQw4w9WgXcQ", jobDir, null, {
      binary,
      environment: { PATH: process.env.PATH },
      maximumDirectoryBytes: 1_024,
      storagePollMs: 25,
      timeoutMs: 10_000,
    }),
    (error) => error.code === "ERR_YTDLP_SOURCE_TOO_LARGE"
  );
  assert.equal(sourceArtifactBytesSync(jobDir), 0);
});

test("prepares metadata and a local source through the same yt-dlp wrapper", async (t) => {
  const binary = await executableFixture(
    t,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  process.stdout.write(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Fixture video", duration: 30 }));
} else {
  const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
  fs.writeFileSync(output, "fixture-media");
  process.stdout.write(output + "\\n");
}`
  );
  const jobDir = await temporaryDirectory(t);
  const prepared = await prepareSource("https://youtube.com/watch?v=dQw4w9WgXcQ", jobDir, null, {
    binary,
    environment: { PATH: process.env.PATH },
    timeoutMs: 10_000,
  });
  assert.equal(prepared.info.title, "Fixture video");
  assert.equal(prepared.info.durationSec, 30);
  assert.equal(await fs.promises.readFile(prepared.sourcePath, "utf8"), "fixture-media");
});

test("uses one overall prepare deadline across metadata and download", async (t) => {
  const binary = await executableFixture(
    t,
    `const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  setTimeout(() => process.stdout.write(JSON.stringify({
    id: "dQw4w9WgXcQ", title: "Slow fixture", duration: 30
  })), 100);
} else {
  process.stdin.resume();
  setInterval(() => {}, 1_000);
}`
  );
  const jobDir = await temporaryDirectory(t);
  const startedAt = Date.now();
  await assert.rejects(
    prepareSource("https://youtu.be/dQw4w9WgXcQ", jobDir, null, {
      binary,
      environment: { PATH: process.env.PATH },
      timeoutMs: 200,
    }),
    (error) => error.code === "ETIMEDOUT"
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 150, `expected the deadline to last about 200ms, got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 300, `metadata and download received separate deadlines (${elapsedMs}ms)`);
});
