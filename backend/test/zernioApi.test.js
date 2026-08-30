import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createZernioApi,
  DEFAULT_ZERNIO_BASE_URL,
  ZernioApiError,
} from "../src/lib/zernioApi.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function testClient(fetchImpl, overrides = {}) {
  return createZernioApi({
    apiKey: "sk_test_key",
    baseUrl: "https://zernio.example/api/v1",
    fetchImpl,
    idFactory: () => "generated-request-id",
    ...overrides,
  });
}

test("Zernio client defaults to the documented API base and blocks missing configuration", async () => {
  assert.equal(DEFAULT_ZERNIO_BASE_URL, "https://zernio.com/api/v1");

  const api = createZernioApi({
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("must not fetch without an API key");
    },
  });
  await assert.rejects(
    api.listProfiles(),
    (error) => error instanceof ZernioApiError
      && error.status === 503
      && error.code === "zernio_not_configured"
      && error.retryable === false
  );
  assert.throws(
    () => createZernioApi({ apiKey: "key", requestTimeoutMs: 120_001 }),
    /requestTimeoutMs must be between/
  );
  assert.throws(
    () => createZernioApi({ apiKey: "key", uploadTimeoutMs: 3_600_001 }),
    /uploadTimeoutMs must be between/
  );
});

test("profile methods authenticate, create idempotently, and support exact-name recovery", async () => {
  const calls = [];
  const api = testClient(async (input, init) => {
    calls.push({ url: new URL(input), init });
    if (init.method === "POST") {
      return jsonResponse({ profile: { _id: "profile-1", name: "Ravi user-1" } }, { status: 201 });
    }
    return jsonResponse({ profiles: [{ _id: "profile-1", name: "Ravi user-1" }] });
  });

  const created = await api.createProfile(" Ravi user-1 ", " Ravi clipping automation ");
  const listed = await api.listProfiles({
    name: "Ravi user-1",
    limit: 1,
    skip: 0,
    includeOverLimit: true,
  });

  assert.equal(created.profile._id, "profile-1");
  assert.equal(listed.profiles[0]._id, "profile-1");
  assert.equal(calls[0].url.pathname, "/api/v1/profiles");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test_key");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "generated-request-id");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: "Ravi user-1",
    description: "Ravi clipping automation",
  });
  assert.equal(calls[1].url.searchParams.get("name"), "Ravi user-1");
  assert.equal(calls[1].url.searchParams.get("limit"), "1");
  assert.equal(calls[1].url.searchParams.get("skip"), "0");
  assert.equal(calls[1].url.searchParams.get("includeOverLimit"), "true");
});

test("channel connection, account discovery, health, and disconnect use YouTube account routes", async () => {
  const calls = [];
  const api = testClient(async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/connect/youtube")) {
      return jsonResponse({ authUrl: "https://zernio.example/oauth" });
    }
    if (url.pathname.endsWith("/accounts")) {
      return jsonResponse({ accounts: [
        { _id: "account-1", platform: "youtube", username: "@ravi" },
        { id: "account-2", platform: "youtube", username: "@clips" },
      ] });
    }
    if (url.pathname.endsWith("/health")) {
      return jsonResponse({ status: "healthy", permissions: { canPost: true } });
    }
    return jsonResponse({ message: "Account disconnected successfully" });
  });

  assert.equal(
    (await api.getConnectUrl("profile-1", "https://ravi.example/callback?from=setup")).authUrl,
    "https://zernio.example/oauth"
  );
  assert.equal((await api.listAccounts("profile-1")).accounts.length, 2);
  assert.equal((await api.findAccountById("account-2", "profile-1")).username, "@clips");
  assert.equal((await api.getAccountHealth("account-1")).status, "healthy");
  assert.match((await api.disconnectAccount("account-1")).message, /disconnected/);

  assert.equal(calls[0].url.pathname, "/api/v1/connect/youtube");
  assert.equal(calls[0].url.searchParams.get("profileId"), "profile-1");
  assert.equal(calls[0].url.searchParams.get("redirect_url"), "https://ravi.example/callback?from=setup");
  for (const index of [1, 2]) {
    assert.equal(calls[index].url.searchParams.get("profileId"), "profile-1");
    assert.equal(calls[index].url.searchParams.get("platform"), "youtube");
  }
  assert.equal(calls[3].url.pathname, "/api/v1/accounts/account-1/health");
  assert.equal(calls[4].url.pathname, "/api/v1/accounts/account-1");
  assert.equal(calls[4].init.method, "DELETE");
});

test("YouTube post listing supports external and Zernio sources with bounded filters", async () => {
  const calls = [];
  const api = testClient(async (input, init) => {
    calls.push({ url: new URL(input), init });
    return jsonResponse({ posts: [] });
  });

  await api.syncExternalPosts("account-1");
  await api.listYoutubePosts("account-main", {
    source: "external",
    status: "published",
    page: 3,
    limit: 75,
  });
  await api.listYoutubePosts("account-clips", {
    source: "zernio",
    status: "published",
    page: 2,
    limit: 500,
  });
  await api.listExternalYoutubePosts("account-legacy", {
    status: "published",
    page: 4,
    limit: 50,
  });

  assert.equal(calls[0].url.pathname, "/api/v1/posts/sync-external");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { accountId: "account-1" });

  assert.equal(calls[1].url.pathname, "/api/v1/posts");
  assert.equal(calls[1].url.searchParams.get("source"), "external");
  assert.equal(calls[1].url.searchParams.get("status"), "published");
  assert.equal(calls[1].url.searchParams.get("platform"), "youtube");
  assert.equal(calls[1].url.searchParams.get("accountId"), "account-main");
  assert.equal(calls[1].url.searchParams.get("page"), "3");
  assert.equal(calls[1].url.searchParams.get("limit"), "75");

  assert.equal(calls[2].url.pathname, "/api/v1/posts");
  assert.equal(calls[2].url.searchParams.get("source"), "zernio");
  assert.equal(calls[2].url.searchParams.get("status"), "published");
  assert.equal(calls[2].url.searchParams.get("platform"), "youtube");
  assert.equal(calls[2].url.searchParams.get("accountId"), "account-clips");
  assert.equal(calls[2].url.searchParams.get("page"), "2");
  assert.equal(calls[2].url.searchParams.get("limit"), "500");

  // The compatibility helper must continue forcing the external collection.
  assert.equal(calls[3].url.pathname, "/api/v1/posts");
  assert.equal(calls[3].url.searchParams.get("source"), "external");
  assert.equal(calls[3].url.searchParams.get("status"), "published");
  assert.equal(calls[3].url.searchParams.get("platform"), "youtube");
  assert.equal(calls[3].url.searchParams.get("accountId"), "account-legacy");
  assert.equal(calls[3].url.searchParams.get("page"), "4");
  assert.equal(calls[3].url.searchParams.get("limit"), "50");

  await assert.rejects(
    api.listYoutubePosts("account-1", { source: "other" }),
    (error) => error.code === "invalid_zernio_request" && error.status === 400
  );
  await assert.rejects(
    api.listYoutubePosts("account-1", { status: "processing" }),
    (error) => error.code === "invalid_zernio_request" && error.status === 400
  );
  await assert.rejects(
    api.listYoutubePosts("account-1", { limit: 501 }),
    (error) => error.code === "invalid_zernio_request" && error.status === 400
  );
  assert.equal(calls.length, 4);
});

test("media presign and immediate YouTube post match Zernio's documented payload", async () => {
  const calls = [];
  const api = testClient(async (input, init) => {
    calls.push({ url: new URL(input), init });
    if (new URL(input).pathname.endsWith("/media/presign")) {
      return jsonResponse({ uploadUrl: "https://storage.example/upload?signature=secret", publicUrl: "https://media.example/clip.mp4" });
    }
    if (init.method === "POST") return jsonResponse({ post: { _id: "post-1", status: "published" } }, { status: 201 });
    return jsonResponse({ post: { _id: "post-1", status: "published" } });
  });

  const presign = await api.createMediaPresign("clip.mp4", 1234);
  const published = await api.createYoutubePost({
    accountId: "account-1",
    mediaUrl: presign.publicUrl,
    title: "A strong moment",
    description: "Created automatically by Ravi.",
    visibility: "unlisted",
    madeForKids: false,
    containsSyntheticMedia: true,
    tags: ["Ravi", " clips "],
    requestId: "job-1:clip-1",
  });
  const fetched = await api.getPost(published.post._id);

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    filename: "clip.mp4",
    contentType: "video/mp4",
    size: 1234,
  });
  assert.equal(calls[1].init.headers["x-request-id"], "job-1:clip-1");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    content: "Created automatically by Ravi.",
    mediaItems: [{ type: "video", url: "https://media.example/clip.mp4" }],
    platforms: [{
      platform: "youtube",
      accountId: "account-1",
      platformSpecificData: {
        title: "A strong moment",
        visibility: "unlisted",
        madeForKids: false,
        containsSyntheticMedia: true,
      },
    }],
    publishNow: true,
    tags: ["Ravi", "clips"],
  });
  assert.equal(calls[2].url.pathname, "/api/v1/posts/post-1");
  assert.equal(fetched.post.status, "published");
});

test("presigned file upload streams MP4 bytes without exposing the Zernio API key", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-zernio-upload-"));
  const filePath = path.join(root, "clip.mp4");
  await fs.promises.writeFile(filePath, Buffer.from("rendered-clip-bytes"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  let uploadCall;
  const api = testClient(async (input, init) => {
    const chunks = [];
    for await (const chunk of init.body) chunks.push(chunk);
    uploadCall = { url: new URL(input), init, bytes: Buffer.concat(chunks) };
    return new Response(null, { status: 204 });
  });

  assert.deepEqual(
    await api.uploadFile("https://storage.example/upload?signature=top-secret", filePath),
    { uploaded: true, status: 204 }
  );
  assert.equal(uploadCall.init.method, "PUT");
  assert.equal(uploadCall.init.duplex, "half");
  assert.equal(uploadCall.init.headers["Content-Type"], "video/mp4");
  assert.equal(uploadCall.init.headers["Content-Length"], String(uploadCall.bytes.length));
  assert.equal(uploadCall.init.headers.Authorization, undefined);
  assert.equal(uploadCall.bytes.toString(), "rendered-clip-bytes");
  assert.ok(uploadCall.init.signal instanceof AbortSignal);
});

test("HTTP failures expose bounded retry metadata and redact credentials", async () => {
  const secret = `sk_${"a".repeat(64)}`;
  const api = createZernioApi({
    apiKey: secret,
    baseUrl: "https://zernio.example/api/v1",
    fetchImpl: async () => jsonResponse({
      error: `Bearer ${secret} failed at https://storage.example/file?signature=very-secret`,
      code: "RATE_LIMITED",
      type: "rate_limit_error",
      details: { platform: "youtube", existingPostId: "post-1", token: secret },
    }, { status: 429, headers: { "Retry-After": "2" } }),
  });

  await assert.rejects(api.getPost("post-1"), (error) => {
    assert.ok(error instanceof ZernioApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 2000);
    assert.deepEqual(error.details, {
      type: "rate_limit_error",
      platform: "youtube",
      existingPostId: "post-1",
    });
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(error.message, /very-secret/);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    return true;
  });
});

test("network failures, explicit timeouts, and caller cancellation have structured errors", async () => {
  const networkApi = testClient(async () => {
    throw new TypeError("fetch failed with secret internals");
  });
  await assert.rejects(
    networkApi.listProfiles(),
    (error) => error.code === "zernio_network_error"
      && error.status === 502
      && error.retryable === true
      && !error.message.includes("secret internals")
  );

  const timeoutApi = testClient(
    () => new Promise(() => {}),
    { requestTimeoutMs: 15 }
  );
  await assert.rejects(
    timeoutApi.listProfiles(),
    (error) => error.code === "zernio_timeout"
      && error.status === 504
      && error.retryable === true
  );

  const bodyTimeoutApi = testClient(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise(() => {}),
  }), { requestTimeoutMs: 15 });
  await assert.rejects(
    bodyTimeoutApi.listProfiles(),
    (error) => error.code === "zernio_timeout" && error.retryable === true
  );

  let called = false;
  const cancelledApi = testClient(async () => {
    called = true;
    return jsonResponse({});
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cancelledApi.createYoutubePost({
      accountId: "account-1",
      mediaUrl: "https://media.example/clip.mp4",
      title: "Clip",
      requestId: "job-1:clip-1",
      signal: controller.signal,
    }),
    (error) => error.code === "zernio_request_aborted"
      && error.status === 499
      && error.retryable === false
  );
  assert.equal(called, false);
});
