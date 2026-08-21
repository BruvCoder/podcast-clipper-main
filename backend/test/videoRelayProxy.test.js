import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

async function startHttpServer(handler) {
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
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function startProxy() {
  const blockedPorts = new Set();
  const connections = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const port = Number(target.port || 80);
    connections.push({ authorization: req.headers["proxy-authorization"], port });
    if (blockedPorts.has(port)) return;

    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(target, { headers, method: req.method }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    req.pipe(upstream);
    res.once("close", () => upstream.destroy());
    upstream.once("error", () => res.destroy());
  });

  server.on("connect", (req, clientSocket, head) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || "");
    if (!match) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = match[1].replace(/^\[|\]$/g, "");
    const port = Number(match[2]);
    connections.push({ authorization: req.headers["proxy-authorization"], port });
    if (blockedPorts.has(port)) return;

    const upstream = net.connect(port, host);
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstream.destroy());
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    blockedPorts,
    connections,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function importRelay(proxyUrl) {
  const names = [
    "RESIDENTIAL_PROXY_URL",
    "MEDIA_PROXY_URL",
    "VIDEO_RELAY_CHUNK_BYTES",
    "VIDEO_RELAY_READ_AHEAD",
    "VIDEO_RELAY_CHUNK_ATTEMPTS",
    "VIDEO_RELAY_CONNECT_TIMEOUT_MS",
    "VIDEO_RELAY_HEADERS_TIMEOUT_MS",
    "VIDEO_RELAY_BODY_TIMEOUT_MS",
    "VIDEO_RELAY_TOTAL_TIMEOUT_MS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    RESIDENTIAL_PROXY_URL: proxyUrl,
    VIDEO_RELAY_CHUNK_BYTES: "16",
    VIDEO_RELAY_READ_AHEAD: "1",
    VIDEO_RELAY_CHUNK_ATTEMPTS: "3",
    VIDEO_RELAY_CONNECT_TIMEOUT_MS: "150",
    VIDEO_RELAY_HEADERS_TIMEOUT_MS: "250",
    VIDEO_RELAY_BODY_TIMEOUT_MS: "200",
    VIDEO_RELAY_TOTAL_TIMEOUT_MS: "1000",
  });
  delete process.env.MEDIA_PROXY_URL;

  try {
    return await import(`../src/lib/videoRelay.js?proxy-deadlines-${randomUUID()}`);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

test("relay deadlines and consumer cancellation stop stalled proxied requests", async (t) => {
  const relayErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => relayErrors.push(args.map(String).join(" "));
  t.after(() => {
    console.error = originalConsoleError;
  });
  const proxy = await startProxy();
  t.after(proxy.close);
  const username = "relay-user";
  const password = "relay-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const proxyUrl = `http://${username}:${password}@127.0.0.1:${proxy.port}`;
  const { relayUrl, releaseRelay } = await importRelay(proxyUrl);

  const connectTarget = await startHttpServer((_req, res) => res.end("unused"));
  t.after(connectTarget.close);
  proxy.blockedPorts.add(connectTarget.port);
  const stalledConnect = await relayUrl(`https://127.0.0.1:${connectTarget.port}/video`);
  t.after(() => releaseRelay(stalledConnect.token));

  const connectStartedAt = Date.now();
  const connectResponse = await fetch(stalledConnect.url);
  assert.equal(connectResponse.status, 502);
  assert.match(await connectResponse.text(), /headers exceeded the 250ms deadline/);
  assert.ok(Date.now() - connectStartedAt < 1_500);

  let nonRetryableChunkRequests = 0;
  const notFoundTarget = await startHttpServer((req, res) => {
    if (req.headers.range === "bytes=0-0") {
      res.writeHead(206, {
        "Content-Length": "1",
        "Content-Range": "bytes 0-0/16",
      });
      res.end("x");
      return;
    }
    nonRetryableChunkRequests += 1;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  t.after(notFoundTarget.close);
  const notFoundRelay = await relayUrl(`${notFoundTarget.url}/video`);
  t.after(() => releaseRelay(notFoundRelay.token));
  await assert.rejects(async () => {
    const response = await fetch(notFoundRelay.url);
    await response.arrayBuffer();
  }, /terminated|aborted|fetch failed/i);
  assert.equal(nonRetryableChunkRequests, 1);

  let closedBodies = 0;
  let startedBodies = 0;
  const bodyTarget = await startHttpServer((req, res) => {
    const range = String(req.headers.range || "");
    if (range === "bytes=0-0") {
      res.writeHead(206, {
        "Content-Length": "1",
        "Content-Range": "bytes 0-0/16",
      });
      res.end("x");
      return;
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    const from = Number(match?.[1] || 0);
    const to = Number(match?.[2] || 15);
    res.writeHead(206, {
      "Content-Length": String(to - from + 1),
      "Content-Range": `bytes ${from}-${to}/16`,
    });
    res.write("x");
    startedBodies += 1;
    res.once("close", () => {
      closedBodies += 1;
    });
  });
  t.after(bodyTarget.close);

  const stalledBody = await relayUrl(`${bodyTarget.url}/video`, {
    "Proxy-Authorization": "Basic caller-supplied-secret",
  });
  t.after(() => releaseRelay(stalledBody.token));
  await assert.rejects(async () => {
    const bodyResponse = await fetch(stalledBody.url);
    await bodyResponse.arrayBuffer();
  }, /terminated|aborted|fetch failed/i);
  assert.equal(await waitFor(() => closedBodies >= 1), true);

  const consumerAbort = await relayUrl(`${bodyTarget.url}/video`);
  t.after(() => releaseRelay(consumerAbort.token));
  const downstreamRequest = http.get(consumerAbort.url);
  downstreamRequest.on("error", () => {});
  assert.equal(await waitFor(() => startedBodies >= 2), true);
  downstreamRequest.destroy();
  assert.equal(await waitFor(() => closedBodies >= 2), true);

  assert.ok(proxy.connections.length >= 4);
  assert.ok(proxy.connections.every((entry) => entry.authorization === authorization));
  assert.ok(relayErrors.some((message) => message.includes("body was idle for 200ms")));
});
