import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

async function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function importDirectRelay() {
  const names = [
    "RESIDENTIAL_PROXY_URL",
    "MEDIA_PROXY_URL",
    "VIDEO_RELAY_CHUNK_BYTES",
    "VIDEO_RELAY_READ_AHEAD",
    "VIDEO_RELAY_CHUNK_ATTEMPTS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.RESIDENTIAL_PROXY_URL;
  delete process.env.MEDIA_PROXY_URL;
  Object.assign(process.env, {
    VIDEO_RELAY_CHUNK_BYTES: "4",
    VIDEO_RELAY_READ_AHEAD: "1",
    VIDEO_RELAY_CHUNK_ATTEMPTS: "1",
  });

  try {
    return await import(`../src/lib/videoRelay.js?direct-relay-${randomUUID()}`);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("relay keeps direct mode working and strips credentials across redirects", async (t) => {
  const media = Buffer.from("abcdefgh");
  const receivedHeaders = [];
  const target = await startServer((req, res) => {
    receivedHeaders.push(req.headers);
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
    const from = Number(match?.[1] || 0);
    const to = Number(match?.[2] || media.length - 1);
    const body = media.subarray(from, to + 1);
    res.writeHead(206, {
      "Content-Length": String(body.length),
      "Content-Range": `bytes ${from}-${to}/${media.length}`,
    });
    res.end(body);
  });
  const redirect = await startServer((_req, res) => {
    res.writeHead(302, { Location: `${target.url}/media` });
    res.end();
  });
  t.after(redirect.close);
  t.after(target.close);

  const { relayUrl, releaseRelay } = await importDirectRelay();
  const relayed = await relayUrl(`${redirect.url}/start`, {
    Authorization: "Bearer media-origin-secret",
    Cookie: "session=media-origin-secret",
    "User-Agent": "relay-direct-test",
  });
  t.after(() => releaseRelay(relayed.token));

  const response = await fetch(relayed.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
  assert.ok(receivedHeaders.length >= 3);
  assert.ok(receivedHeaders.every((headers) => headers.authorization === undefined));
  assert.ok(receivedHeaders.every((headers) => headers.cookie === undefined));
  assert.ok(receivedHeaders.every((headers) => headers["user-agent"] === "relay-direct-test"));
});
