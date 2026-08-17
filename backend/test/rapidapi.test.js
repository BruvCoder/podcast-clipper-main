import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { __testing } from "../src/lib/rapidapi.js";

const {
  assertValidMedia,
  downloadToFile,
  durationToleranceSec,
  extractVideoId,
  rankVideoFormats,
  withVideoFormatFallbacks,
} = __testing;

test("caps audio/video duration tolerance for long sources", () => {
  assert.equal(durationToleranceSec(18), 5);
  assert.equal(durationToleranceSec(1_130), 11.3);
  assert.equal(durationToleranceSec(7_200), 15);
});

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function temporaryDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "podcast-clipper-test-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("extracts supported YouTube URL shapes regardless of query order or subdomain", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(extractVideoId(`https://www.youtube.com/watch?list=PL123&v=${id}&t=2`), id);
  assert.equal(extractVideoId(`https://m.youtube.com/watch?t=2&v=${id}`), id);
  assert.equal(extractVideoId(`https://youtu.be/${id}?si=abc`), id);
  assert.equal(extractVideoId(`https://youtube.com/shorts/${id}`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/embed/${id}`), id);
});

test("rejects non-YouTube hosts and malformed video IDs", () => {
  assert.throws(
    () => extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ"),
    /Could not extract/
  );
  assert.throws(() => extractVideoId("https://youtube.com/watch?v=too-short"), /Could not extract/);
  assert.throws(() => extractVideoId("not a URL"), /Could not extract/);
});

test("ranks a direct 720p H.264 video-only format ahead of AV1 and oversized formats", () => {
  const url = "https://cdn.example.test/media";
  const ranked = rankVideoFormats([
    {
      format_id: "hls-with-audio",
      url,
      protocol: "m3u8_native",
      width: 1280,
      height: 720,
      vcodec: "avc1.4d401f",
      acodec: "mp4a.40.2",
      ext: "mp4",
    },
    {
      format_id: "398",
      url,
      protocol: "https",
      width: 1280,
      height: 720,
      vcodec: "av01.0.05M.08",
      acodec: "none",
      ext: "mp4",
    },
    {
      format_id: "137",
      url,
      protocol: "https",
      width: 1920,
      height: 1080,
      vcodec: "avc1.640028",
      acodec: "none",
      ext: "mp4",
    },
    {
      format_id: "135",
      url,
      protocol: "https",
      width: 854,
      height: 480,
      vcodec: "avc1.4d401e",
      acodec: "none",
      ext: "mp4",
    },
    {
      format_id: "136",
      url,
      protocol: "https",
      width: 1280,
      height: 720,
      vcodec: "avc1.4d401f",
      acodec: "none",
      ext: "mp4",
    },
    {
      format_id: "progressive",
      url,
      protocol: "https",
      width: 640,
      height: 360,
      vcodec: "avc1.42001e",
      acodec: "mp4a.40.2",
      ext: "mp4",
    },
  ]);

  assert.deepEqual(
    ranked.map((format) => format.format_id),
    ["136", "135", "137", "398"]
  );
});

test("treats a portrait 720p format by its short edge", () => {
  const ranked = rankVideoFormats([
    {
      format_id: "portrait-720",
      url: "https://cdn.example.test/portrait",
      protocol: "https",
      width: 720,
      height: 1280,
      vcodec: "h264",
      acodec: "none",
      ext: "mp4",
    },
    {
      format_id: "landscape-480",
      url: "https://cdn.example.test/landscape",
      protocol: "https",
      width: 854,
      height: 480,
      vcodec: "h264",
      acodec: "none",
      ext: "mp4",
    },
  ]);

  assert.equal(ranked[0].format_id, "portrait-720");
});

test("falls through duration and mux/final failures before selecting a candidate", async () => {
  const candidates = [
    { format_id: "duration-mismatch", format_note: "720p", vcodec: "h264" },
    { format_id: "mux-failure", format_note: "480p", vcodec: "h264" },
    { format_id: "working", format_note: "360p", vcodec: "h264" },
  ];
  const attempts = [];
  const progress = [];

  const selected = await withVideoFormatFallbacks(
    candidates,
    async (candidate) => {
      attempts.push(candidate.format_id);
      if (candidate.format_id === "duration-mismatch") {
        throw new Error("Downloaded streams do not match");
      }
      if (candidate.format_id === "mux-failure") throw new Error("ffmpeg mux failed");
      return candidate;
    },
    { onProgress: (line) => progress.push(line) }
  );

  assert.equal(selected.format_id, "working");
  assert.deepEqual(attempts, ["duration-mismatch", "mux-failure", "working"]);
  assert.ok(progress.some((line) => line.includes("Downloaded streams do not match")));
  assert.ok(progress.some((line) => line.includes("ffmpeg mux failed")));
});

test("stops format fallback immediately for machine-wide failures", async () => {
  const candidates = [
    { format_id: "first", format_note: "720p", vcodec: "h264" },
    { format_id: "second", format_note: "480p", vcodec: "h264" },
  ];
  const attempts = [];

  await assert.rejects(
    withVideoFormatFallbacks(candidates, async (candidate) => {
      attempts.push(candidate.format_id);
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    }),
    /No space left on device/
  );

  assert.deepEqual(attempts, ["first"]);
});

test("downloads through a relative redirect and reports byte progress", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "media.bin");
  const body = Buffer.from("a complete media response");
  const progress = [];
  const fixture = await startServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/media" });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  });
  t.after(fixture.close);

  await downloadToFile(`${fixture.url}/start`, destination, {
    label: "Fixture",
    onProgress: (line) => progress.push(line),
  });

  assert.deepEqual(await fs.promises.readFile(destination), body);
  assert.ok(progress.some((line) => line.includes("100%")));
});

test("drops credentials and Range across a cross-origin redirect", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "media.bin");
  let receivedHeaders;
  const target = await startServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end("safe");
  });
  const source = await startServer((req, res) => {
    res.writeHead(302, { Location: `${target.url}/media` });
    res.end();
  });
  t.after(source.close);
  t.after(target.close);

  await downloadToFile(`${source.url}/start`, destination, {
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      Range: "bytes=0-10",
      "User-Agent": "podcast-clipper-test",
    },
  });

  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(receivedHeaders.cookie, undefined);
  assert.equal(receivedHeaders.range, undefined);
  assert.equal(receivedHeaders["user-agent"], "podcast-clipper-test");
});

test("rejects non-200 and text error responses without leaving partial files", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "media.bin");
  const fixture = await startServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "provider is busy" }));
  });
  t.after(fixture.close);

  await assert.rejects(
    downloadToFile(fixture.url, destination, { label: "Fixture" }),
    /HTTP 503.*provider is busy/
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("rejects an aborted response stream and cleans up its partial file", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "media.bin");
  const fixture = await startServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": 10_000,
    });
    res.write(Buffer.alloc(100));
    res.socket.destroy();
  });
  t.after(fixture.close);

  await assert.rejects(
    downloadToFile(fixture.url, destination, { label: "Fixture" }),
    /Fixture failed/
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("honors AbortSignal cancellation and cleans up its partial file", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "media.bin");
  const fixture = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const timer = setInterval(() => res.write(Buffer.alloc(1_024)), 10);
    res.on("close", () => clearInterval(timer));
  });
  t.after(fixture.close);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("test cancellation")), 40);

  await assert.rejects(
    downloadToFile(fixture.url, destination, {
      label: "Fixture",
      signal: controller.signal,
    }),
    /test cancellation|aborted/i
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("rejects a readable but implausibly short video", async (t) => {
  const directory = await temporaryDirectory(t);
  const videoPath = path.join(directory, "short.mp4");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-t",
      "0.25",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  assert.ok((await fs.promises.stat(videoPath)).size > 4_096);

  await assert.rejects(assertValidMedia(videoPath, "video", "Fixture"), /expected at least 1s/);
});
