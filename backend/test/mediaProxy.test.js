import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

async function importMediaProxy({ residential, legacy } = {}, scenario) {
  const previousResidential = process.env.RESIDENTIAL_PROXY_URL;
  const previousLegacy = process.env.MEDIA_PROXY_URL;
  delete process.env.RESIDENTIAL_PROXY_URL;
  delete process.env.MEDIA_PROXY_URL;
  if (residential !== undefined) process.env.RESIDENTIAL_PROXY_URL = residential;
  if (legacy !== undefined) process.env.MEDIA_PROXY_URL = legacy;

  try {
    return await import(`../src/lib/mediaProxy.js?${scenario}-${randomUUID()}`);
  } finally {
    if (previousResidential === undefined) delete process.env.RESIDENTIAL_PROXY_URL;
    else process.env.RESIDENTIAL_PROXY_URL = previousResidential;
    if (previousLegacy === undefined) delete process.env.MEDIA_PROXY_URL;
    else process.env.MEDIA_PROXY_URL = previousLegacy;
  }
}

async function importRapidApiWithProxy(
  value,
  { audioLinkProbeTimeoutMs, downloadTotalTimeoutMs } = {}
) {
  const previousResidential = process.env.RESIDENTIAL_PROXY_URL;
  const previousLegacy = process.env.MEDIA_PROXY_URL;
  const previousTotalTimeout = process.env.DOWNLOAD_TOTAL_TIMEOUT_MS;
  const previousLinkProbeTimeout = process.env.AUDIO_LINK_PROBE_TIMEOUT_MS;
  process.env.RESIDENTIAL_PROXY_URL = value;
  delete process.env.MEDIA_PROXY_URL;
  if (downloadTotalTimeoutMs != null) {
    process.env.DOWNLOAD_TOTAL_TIMEOUT_MS = String(downloadTotalTimeoutMs);
  }
  if (audioLinkProbeTimeoutMs != null) {
    process.env.AUDIO_LINK_PROBE_TIMEOUT_MS = String(audioLinkProbeTimeoutMs);
  }
  try {
    // rapidapi.js imports the canonical (unqueried) mediaProxy module. This
    // test file deliberately does not import that module before this point.
    return await import(`../src/lib/rapidapi.js?proxy-test-${randomUUID()}`);
  } finally {
    if (previousResidential === undefined) delete process.env.RESIDENTIAL_PROXY_URL;
    else process.env.RESIDENTIAL_PROXY_URL = previousResidential;
    if (previousLegacy === undefined) delete process.env.MEDIA_PROXY_URL;
    else process.env.MEDIA_PROXY_URL = previousLegacy;
    if (previousTotalTimeout === undefined) delete process.env.DOWNLOAD_TOTAL_TIMEOUT_MS;
    else process.env.DOWNLOAD_TOTAL_TIMEOUT_MS = previousTotalTimeout;
    if (previousLinkProbeTimeout === undefined) delete process.env.AUDIO_LINK_PROBE_TIMEOUT_MS;
    else process.env.AUDIO_LINK_PROBE_TIMEOUT_MS = previousLinkProbeTimeout;
  }
}

async function startHttpServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

async function startConnectProxy() {
  const connections = [];
  const blockedPorts = new Set();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }

    connections.push({
      authorization: req.headers["proxy-authorization"],
      host: target.hostname,
      port: Number(target.port || 80),
    });
    if (blockedPorts.has(Number(target.port || 80))) return;
    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(target, { headers, method: req.method }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.once("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("connect", (req, clientSocket, head) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || "");
    if (!match) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const host = match[1].replace(/^\[|\]$/g, "");
    const port = Number(match[2]);
    connections.push({
      authorization: req.headers["proxy-authorization"],
      host,
      port,
    });
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

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    blockedPorts,
    connections,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

test("keeps an unset proxy disabled for local development", async () => {
  const proxy = await importMediaProxy({}, "disabled");
  assert.equal(proxy.mediaProxyEnabled(), false);
  assert.equal(proxy.mediaDispatcher(), undefined);
  assert.equal(proxy.mediaAgent(), undefined);
});

test("rejects unsafe proxy configuration without echoing credentials", async () => {
  const secret = "do-not-print-this-password";
  const invalidValues = [
    `not-a-url-${secret}`,
    `socks5://proxy-user:${secret}@127.0.0.1:1080`,
    `http://proxy-user:${secret}@127.0.0.1:8080/path`,
    "   ",
  ];

  for (const [index, value] of invalidValues.entries()) {
    await assert.rejects(
      importMediaProxy({ residential: value }, `invalid-${index}`),
      (error) => {
        assert.equal(error.code, "ERR_MEDIA_PROXY_CONFIG");
        assert.match(error.message, /^Invalid residential media proxy configuration:/);
        assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, new RegExp(secret));
        return true;
      }
    );
  }
});

test("supports the legacy alias but rejects conflicting proxy variables", async () => {
  const legacy = await importMediaProxy(
    { legacy: "http://legacy-user:legacy-pass@127.0.0.1:8080" },
    "legacy-alias"
  );
  assert.equal(legacy.mediaProxyEnabled(), true);
  legacy.mediaAgent().destroy();
  await legacy.mediaDispatcher().close();

  const equivalent = await importMediaProxy(
    {
      residential: "http://same-user:same-pass@127.0.0.1:8080",
      legacy: "http://same-user:same-pass@127.0.0.1:8080/",
    },
    "equivalent-aliases"
  );
  assert.equal(equivalent.mediaProxyEnabled(), true);
  equivalent.mediaAgent().destroy();
  await equivalent.mediaDispatcher().close();

  const secret = "conflicting-secret";
  await assert.rejects(
    importMediaProxy(
      {
        residential: "http://preferred-user:preferred-pass@127.0.0.1:8080",
        legacy: `http://legacy-user:${secret}@127.0.0.1:8081`,
      },
      "conflicting-aliases"
    ),
    (error) => {
      assert.equal(error.code, "ERR_MEDIA_PROXY_CONFIG");
      assert.match(error.message, /resolve to different proxies/);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, new RegExp(secret));
      return true;
    }
  );
});

test("routes fetch and redirected downloads through an authenticated proxy", async (t) => {
  const received = [];
  const target = await startHttpServer((req, res) => {
    received.push({ host: "target", headers: req.headers, url: req.url });
    res.writeHead(200, {
      "Content-Length": "18",
      "Content-Type": "application/octet-stream",
    });
    res.end("proxied-media-body");
  });
  const source = await startHttpServer((req, res) => {
    received.push({ host: "source", headers: req.headers, url: req.url });
    const suffix = req.url === "/fetch-start" ? "fetch-final" : "download-final";
    res.writeHead(302, { Location: `${target.url}/${suffix}` });
    res.end();
  });
  const connectProxy = await startConnectProxy();
  t.after(connectProxy.close);
  t.after(source.close);
  t.after(target.close);

  const username = "proxy-user@example.com";
  const password = "proxy:password";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${connectProxy.port}`;

  const mediaProxy = await importMediaProxy(
    { residential: proxyUrl },
    "authenticated-routing"
  );
  const response = await mediaProxy.mediaFetch(`${source.url}/fetch-start`, {
    redirect: "follow",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxied-media-body");

  const rapidApi = await importRapidApiWithProxy(proxyUrl, {
    audioLinkProbeTimeoutMs: 250,
    downloadTotalTimeoutMs: 1_000,
  });
  const canonicalMediaProxy = await import("../src/lib/mediaProxy.js");
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "media-proxy-test-"));
  const destination = path.join(directory, "media.bin");
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  t.after(() => canonicalMediaProxy.mediaAgent()?.destroy());
  t.after(() => mediaProxy.mediaAgent()?.destroy());
  t.after(() => canonicalMediaProxy.mediaDispatcher()?.close());
  t.after(() => mediaProxy.mediaDispatcher()?.close());

  await rapidApi.__testing.downloadToFile(`${source.url}/download-start`, destination, {
    headers: { "Proxy-Authorization": "Basic caller-supplied-secret" },
    label: "Proxy fixture",
  });
  assert.equal(await fs.promises.readFile(destination, "utf8"), "proxied-media-body");

  const stalledTarget = await startHttpServer((_req, res) => res.end("unused"));
  t.after(stalledTarget.close);
  connectProxy.blockedPorts.add(stalledTarget.port);
  const stalledDestination = path.join(directory, "stalled.bin");
  await assert.rejects(
    rapidApi.__testing.downloadToFile(
      `https://127.0.0.1:${stalledTarget.port}/stalled-connect`,
      stalledDestination,
      { label: "Stalled proxy fixture" }
    ),
    /Download exceeded the 1-second limit/
  );
  assert.equal(fs.existsSync(stalledDestination), false);

  const readinessStartedAt = Date.now();
  assert.equal(await rapidApi.__testing.linkIsFetchable(stalledTarget.url), false);
  assert.ok(Date.now() - readinessStartedAt < 1_000);

  assert.ok(connectProxy.connections.length >= 4);
  assert.ok(connectProxy.connections.some(({ port }) => port === source.port));
  assert.ok(connectProxy.connections.some(({ port }) => port === target.port));
  assert.ok(
    connectProxy.connections.every(
      ({ authorization }) => authorization === expectedAuthorization
    )
  );
  assert.ok(received.length >= 4);
  assert.ok(received.every(({ headers }) => headers["proxy-authorization"] === undefined));

  const nodeAgent = mediaProxy.mediaAgent();
  assert.equal(nodeAgent.proxy.username, "");
  assert.equal(nodeAgent.proxy.password, "");
  assert.doesNotMatch(nodeAgent.proxy.href, /proxy-user|proxy%3Apassword/i);
});
