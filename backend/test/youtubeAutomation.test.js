import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createYoutubeAutomationService,
  loadYoutubeAutomationConfig,
} from "../src/lib/youtubeAutomationService.js";
import { FileYoutubeAutomationStore } from "../src/lib/youtubeAutomationStore.js";

const UID = "user-1";
const MAIN_PROFILE_ID = "profile-main";
const CLIPS_PROFILE_ID = "profile-clips";
const MAIN_ACCOUNT_ID = "zernio-main-account";
const CLIPS_ACCOUNT_ID = "zernio-clips-account";
const SAME_CHANNEL_ACCOUNT_ID = "zernio-same-channel-account";
const BASELINE_VIDEO_ID = "abcdefghijk";
const NEW_VIDEO_ID = "zyxwvutsrqp";
const ZERNIO_VIDEO_ID = "zernio00001";
const RACE_VIDEO_ID = "racevideo01";

function configured(overrides = {}) {
  return {
    ...loadYoutubeAutomationConfig({
      ZERNIO_API_KEY: "zernio-test-key",
      APP_URL: "https://ravi.example",
      YOUTUBE_PUBLIC_API_URL: "https://api.ravi.example",
    }),
    ...overrides,
  };
}

async function createStore(t) {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-zernio-test-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  return new FileYoutubeAutomationStore(rootDir);
}

function silentLogger() {
  return { warn() {}, error() {}, info() {} };
}

function account(accountId, overrides = {}) {
  const isMain = accountId === MAIN_ACCOUNT_ID;
  return {
    _id: accountId,
    profileId: isMain ? MAIN_PROFILE_ID : CLIPS_PROFILE_ID,
    platform: "youtube",
    username: isMain ? "@ravi-main" : "@ravi-clips",
    displayName: isMain ? "Ravi Main" : "Ravi Clips",
    profileUrl: `https://www.youtube.com/${isMain ? "@ravi-main" : "@ravi-clips"}`,
    isActive: true,
    ...overrides,
  };
}

function externalPost({
  videoId,
  title,
  publishedAt,
  accountId = MAIN_ACCOUNT_ID,
} = {}) {
  return {
    _id: `external-${videoId}`,
    accountId,
    platform: "youtube",
    source: "external",
    platformPostId: videoId,
    platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    content: title,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

function zernioAuthoredPost({
  videoId,
  title,
  publishedAt,
  accountId = MAIN_ACCOUNT_ID,
} = {}) {
  return {
    _id: `zernio-${videoId}`,
    source: "zernio",
    title,
    content: title,
    createdAt: new Date(publishedAt - 5_000).toISOString(),
    platforms: [{
      platform: "youtube",
      accountId: { _id: accountId },
      status: "published",
      platformPostId: videoId,
      platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: new Date(publishedAt).toISOString(),
    }],
  };
}

function createFakeZernio(overrides = {}) {
  const calls = {
    createProfile: [],
    connect: [],
    findAccount: [],
    health: [],
    sync: [],
    listExternal: [],
    listPosts: [],
    presign: [],
    upload: [],
    createPost: [],
    getPost: [],
    disconnect: [],
  };
  let externalPosts = [];
  let zernioPosts = [];
  let fetchedPost = null;

  const api = {
    async createProfile(name, description, options) {
      calls.createProfile.push({ name, description, options });
      const profileId = name.endsWith("-main") ? MAIN_PROFILE_ID : CLIPS_PROFILE_ID;
      return { profile: { _id: profileId, name } };
    },
    async listProfiles(options = {}) {
      const name = options.name || "";
      const profileId = name.endsWith("-main") ? MAIN_PROFILE_ID : CLIPS_PROFILE_ID;
      return { profiles: [{ _id: profileId, name }] };
    },
    async getConnectUrl(profileId, redirectUrl) {
      calls.connect.push({ profileId, redirectUrl });
      return {
        authUrl: `https://zernio.example/connect/youtube?profileId=${encodeURIComponent(profileId)}`,
      };
    },
    async findAccountById(accountId, options) {
      calls.findAccount.push({ accountId, options });
      return account(accountId);
    },
    async getAccountHealth(accountId) {
      calls.health.push({ accountId });
      return {
        status: "healthy",
        tokenStatus: { valid: true },
        permissions: { canPost: true },
      };
    },
    async syncExternalPosts(accountId) {
      calls.sync.push({ accountId });
      return { posts: structuredClone(externalPosts) };
    },
    async listExternalYoutubePosts(accountId, options) {
      calls.listExternal.push({ accountId, options });
      return { posts: structuredClone(externalPosts) };
    },
    async listYoutubePosts(accountId, options = {}) {
      calls.listPosts.push({ accountId, options: structuredClone(options) });
      const posts = options.source === "zernio" ? zernioPosts : externalPosts;
      return { posts: structuredClone(posts) };
    },
    async createMediaPresign(filename) {
      calls.presign.push({ filename });
      return {
        uploadUrl: "https://storage.example/upload?signature=test",
        publicUrl: "https://media.example/clip-1.mp4",
      };
    },
    async uploadFile(uploadUrl, filePath, signal) {
      calls.upload.push({ uploadUrl, filePath, signal });
      return { uploaded: true, status: 204 };
    },
    async createYoutubePost(payload) {
      calls.createPost.push(structuredClone({ ...payload, signal: undefined }));
      return {
        post: {
          _id: "zernio-post-1",
          status: "publishing",
          platforms: [{ platform: "youtube", status: "publishing" }],
        },
      };
    },
    async getPost(postId) {
      calls.getPost.push({ postId });
      return {
        post: fetchedPost || {
          _id: postId,
          status: "publishing",
          platforms: [{ platform: "youtube", status: "publishing" }],
        },
      };
    },
    async disconnectAccount(accountId) {
      calls.disconnect.push({ accountId });
      return { message: "disconnected" };
    },
    ...overrides,
  };

  return {
    api,
    calls,
    setExternalPosts(posts) {
      externalPosts = structuredClone(posts);
    },
    setZernioPosts(posts) {
      zernioPosts = structuredClone(posts);
    },
    setFetchedPost(post) {
      fetchedPost = structuredClone(post);
    },
  };
}

function createService({
  store,
  zernio,
  enqueueJob = async () => "job-unused",
  now = () => Date.now(),
  onPublicationUpdate = async () => {},
  config = configured(),
} = {}) {
  return createYoutubeAutomationService({
    config,
    store,
    zernioApi: zernio.api,
    enqueueJob,
    now,
    onPublicationUpdate,
    logger: silentLogger(),
  });
}

async function connectRole(service, zernio, role, accountId) {
  const started = await service.startOauth(UID, role);
  const connectCall = zernio.calls.connect.at(-1);
  const callback = new URL(connectCall.redirectUrl);
  assert.equal(callback.searchParams.get("state"), started.state);
  assert.equal(callback.searchParams.get("role"), role);
  return service.completeOauth({
    state: started.state,
    cookieState: started.state,
    connected: "youtube",
    profileId: connectCall.profileId,
    accountId,
  });
}

async function seedConnectedChannels(store, overrides = {}) {
  await store.update(UID, (record) => {
    Object.assign(record, {
      zernioProfiles: {
        main: MAIN_PROFILE_ID,
        clips: CLIPS_PROFILE_ID,
      },
      enabled: false,
      status: "paused",
      sourceChannel: {
        id: MAIN_ACCOUNT_ID,
        title: "Ravi Main",
        username: "@ravi-main",
        provider: "zernio",
        needsReauth: false,
      },
      clipsChannel: {
        id: CLIPS_ACCOUNT_ID,
        title: "Ravi Clips",
        username: "@ravi-clips",
        provider: "zernio",
        needsReauth: false,
      },
      settings: {
        numClips: 3,
        clipLengthSec: 45,
        cropMode: "pad",
        subtitleColor: "#FFFFFF",
        privacyStatus: "private",
        madeForKids: false,
      },
      certifications: {
        ownsSourceContent: true,
        acceptsCommunityGuidelines: true,
      },
      events: {},
      ...overrides,
    });
    return record;
  });
}

test("file automation store serializes updates and consumes OAuth state once", async (t) => {
  const store = await createStore(t);

  await Promise.all(
    Array.from({ length: 8 }, () =>
      store.update(UID, async (record) => {
        await Promise.resolve();
        record.counter = (record.counter || 0) + 1;
        return record;
      })
    )
  );
  assert.equal((await store.get(UID)).counter, 8);

  await store.createOauthState("oauth-state", { uid: UID, expiresAt: 1234 });
  await assert.rejects(
    store.createOauthState("oauth-state", { uid: "other-user" }),
    /already exists/
  );
  assert.deepEqual(await store.consumeOauthState("oauth-state"), {
    uid: UID,
    expiresAt: 1234,
  });
  assert.equal(await store.consumeOauthState("oauth-state"), null);
});

test("Zernio API key and public callback settings are required", async (t) => {
  const store = await createStore(t);
  const config = loadYoutubeAutomationConfig({
    APP_URL: "https://ravi.example",
    YOUTUBE_PUBLIC_API_URL: "https://api.ravi.example",
  });
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ["ZERNIO_API_KEY"]);
  assert.equal(
    config.callbackUrl,
    "https://api.ravi.example/api/youtube/oauth/callback"
  );
  assert.equal(config.missing.some((name) => name.startsWith("GOOGLE_")), false);

  const zernio = createFakeZernio();
  const service = createService({ store, zernio, config });
  const status = await service.status(UID);
  assert.equal(status.available, false);
  assert.equal(status.connectionProvider, "zernio");
  await assert.rejects(
    service.startOauth(UID, "main"),
    (error) => error?.code === "zernio_not_configured" && error?.status === 503
  );
});

test("separate Zernio profiles connect distinct main and clips YouTube accounts", async (t) => {
  const store = await createStore(t);
  const zernio = createFakeZernio();
  const service = createService({ store, zernio });

  const main = await connectRole(service, zernio, "main", MAIN_ACCOUNT_ID);
  const clips = await connectRole(service, zernio, "clips", CLIPS_ACCOUNT_ID);

  assert.equal(main.role, "main");
  assert.equal(main.channel.id, MAIN_ACCOUNT_ID);
  assert.equal(clips.role, "clips");
  assert.equal(clips.channel.id, CLIPS_ACCOUNT_ID);
  assert.equal(zernio.calls.createProfile.length, 2);
  assert.match(zernio.calls.createProfile[0].name, /^ravi-[0-9a-f]+-main$/);
  assert.match(zernio.calls.createProfile[1].name, /^ravi-[0-9a-f]+-clips$/);
  assert.notEqual(zernio.calls.createProfile[0].name, zernio.calls.createProfile[1].name);
  assert.match(zernio.calls.createProfile[0].options.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(zernio.calls.createProfile[1].options.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.notEqual(
    zernio.calls.createProfile[0].options.idempotencyKey,
    zernio.calls.createProfile[1].options.idempotencyKey
  );
  assert.deepEqual(
    zernio.calls.connect.map((call) => call.profileId),
    [MAIN_PROFILE_ID, CLIPS_PROFILE_ID]
  );

  const stored = await store.get(UID);
  assert.deepEqual(stored.zernioProfiles, {
    main: MAIN_PROFILE_ID,
    clips: CLIPS_PROFILE_ID,
  });
  assert.equal("zernioProfileId" in stored, false);
  assert.equal(stored.sourceChannel.id, MAIN_ACCOUNT_ID);
  assert.equal(stored.clipsChannel.id, CLIPS_ACCOUNT_ID);
  assert.equal(stored.enabled, false);
  assert.equal(stored.status, "paused");

  const status = await service.status(UID);
  assert.equal(status.sourceChannel.provider, "zernio");
  assert.equal(status.clipsChannel.provider, "zernio");
  assert.equal("token" in status.sourceChannel, false);
  assert.equal("apiKey" in status, false);
});

test("OAuth completion rejects using the same Zernio account for both roles", async (t) => {
  const store = await createStore(t);
  const zernio = createFakeZernio();
  const originalFindAccount = zernio.api.findAccountById;
  zernio.api.findAccountById = async (accountId, options) => {
    const found = await originalFindAccount(accountId, options);
    return { ...found, profileId: options.profileId };
  };
  const service = createService({ store, zernio });

  await connectRole(service, zernio, "main", MAIN_ACCOUNT_ID);
  await assert.rejects(
    connectRole(service, zernio, "clips", MAIN_ACCOUNT_ID),
    (error) => error?.code === "same_channel" && error?.status === 409
  );

  const stored = await store.get(UID);
  assert.equal(stored.sourceChannel.id, MAIN_ACCOUNT_ID);
  assert.equal(stored.clipsChannel, null);
  assert.equal(stored.enabled, false);
});

test("OAuth completion rejects distinct Zernio accounts for the same YouTube channel", async (t) => {
  const store = await createStore(t);
  const zernio = createFakeZernio();
  const originalFindAccount = zernio.api.findAccountById;
  zernio.api.findAccountById = async (accountId, options) => {
    if (accountId === SAME_CHANNEL_ACCOUNT_ID) {
      return account(accountId, {
        profileId: options.profileId,
        username: "@ravi-main",
        displayName: "Ravi Main (second connection)",
        profileUrl: "https://www.youtube.com/@ravi-main/",
      });
    }
    return originalFindAccount(accountId, options);
  };
  const service = createService({ store, zernio });

  await connectRole(service, zernio, "main", MAIN_ACCOUNT_ID);
  await assert.rejects(
    connectRole(service, zernio, "clips", SAME_CHANNEL_ACCOUNT_ID),
    (error) => error?.code === "same_channel" && error?.status === 409
  );

  const stored = await store.get(UID);
  assert.equal(stored.sourceChannel.id, MAIN_ACCOUNT_ID);
  assert.equal(stored.clipsChannel, null);
  assert.equal(stored.enabled, false);
});

test("a failed rejected-account cleanup is persisted and retried before reconnecting", async (t) => {
  const store = await createStore(t);
  const zernio = createFakeZernio();
  const originalFindAccount = zernio.api.findAccountById;
  zernio.api.findAccountById = async (accountId, options) => {
    if (accountId === SAME_CHANNEL_ACCOUNT_ID) {
      return account(accountId, {
        profileId: options.profileId,
        username: "@ravi-main",
        displayName: "Ravi Main (rejected duplicate)",
        profileUrl: "https://www.youtube.com/@ravi-main/",
      });
    }
    return originalFindAccount(accountId, options);
  };
  const service = createService({ store, zernio });
  await connectRole(service, zernio, "main", MAIN_ACCOUNT_ID);

  const sequence = [];
  const originalGetConnectUrl = zernio.api.getConnectUrl;
  zernio.api.getConnectUrl = async (...args) => {
    sequence.push("connect-url");
    return originalGetConnectUrl(...args);
  };
  let cleanupAttempts = 0;
  zernio.api.disconnectAccount = async (accountId) => {
    zernio.calls.disconnect.push({ accountId });
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) {
      sequence.push("disconnect-failed");
      const error = new Error("Temporary rejected-account cleanup failure");
      error.status = 503;
      error.retryable = true;
      throw error;
    }
    sequence.push("disconnect-succeeded");
    return { message: "disconnected" };
  };

  await assert.rejects(
    connectRole(service, zernio, "clips", SAME_CHANNEL_ACCOUNT_ID),
    (error) => error?.code === "zernio_cleanup_pending" && error?.status === 503
  );

  let stored = await store.get(UID);
  assert.equal(stored.clipsChannel, null);
  assert.equal(stored.sourceChannel.id, MAIN_ACCOUNT_ID);
  assert.deepEqual(
    {
      accountId: stored.pendingConnectionCleanup.clips.accountId,
      profileId: stored.pendingConnectionCleanup.clips.profileId,
    },
    {
      accountId: SAME_CHANNEL_ACCOUNT_ID,
      profileId: CLIPS_PROFILE_ID,
    }
  );
  assert.equal(stored.status, "error");
  assert.equal(stored.enabled, false);

  const restarted = await service.startOauth(UID, "clips");

  assert.match(restarted.url, /zernio\.example\/connect\/youtube/);
  assert.deepEqual(sequence, [
    "connect-url",
    "disconnect-failed",
    "disconnect-succeeded",
    "connect-url",
  ]);
  assert.deepEqual(zernio.calls.disconnect, [
    { accountId: SAME_CHANNEL_ACCOUNT_ID },
    { accountId: SAME_CHANNEL_ACCOUNT_ID },
  ]);
  stored = await store.get(UID);
  assert.equal(stored.pendingConnectionCleanup.clips, null);
  assert.equal(zernio.calls.connect.at(-1).profileId, CLIPS_PROFILE_ID);
});

test("partial automation updates preserve omitted settings and certifications", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store);
  const zernio = createFakeZernio();
  const service = createService({ store, zernio });

  await service.update(UID, {
    settings: {
      numClips: 5,
      clipLengthSec: 70,
      cropMode: "crop",
      subtitleColor: "#12abEF",
      privacyStatus: "public",
      madeForKids: true,
    },
    certifications: {
      ownsSourceContent: true,
      acceptsCommunityGuidelines: true,
    },
  });
  const status = await service.update(UID, {
    settings: { numClips: 2 },
    certifications: { ownsSourceContent: false },
  });

  assert.deepEqual(status.settings, {
    numClips: 2,
    clipLengthSec: 70,
    cropMode: "crop",
    subtitleColor: "#12ABEF",
    privacyStatus: "public",
    madeForKids: true,
  });
  assert.deepEqual(status.certifications, {
    ownsSourceContent: false,
    acceptsCommunityGuidelines: true,
  });
  assert.equal("notificationPreference" in status.settings, false);
});

test("enabling baselines existing posts and enqueues each later external post once", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store);
  const zernio = createFakeZernio();
  const baseTime = Date.parse("2026-08-30T12:00:00Z");
  let clock = baseTime;
  const oldPost = externalPost({
    videoId: BASELINE_VIDEO_ID,
    title: "Already published before Ravi was enabled",
    publishedAt: baseTime - 60_000,
  });
  zernio.setExternalPosts([oldPost]);
  const enqueued = [];
  const service = createService({
    store,
    zernio,
    now: () => clock,
    enqueueJob: async (payload) => {
      enqueued.push(structuredClone(payload));
      return "job-new-upload";
    },
  });

  const enabled = await service.update(UID, { enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enqueued.length, 0);
  assert.equal((await store.get(UID)).events[BASELINE_VIDEO_ID].status, "baseline");

  const newPublishedAt = baseTime + 1_000;
  const newPost = externalPost({
    videoId: NEW_VIDEO_ID,
    title: "A newly published main-channel video",
    publishedAt: newPublishedAt,
  });
  zernio.setExternalPosts([oldPost, newPost]);
  clock = baseTime + 2_000;
  await service.pollUser(UID, { force: true });
  await service.pollUser(UID, { force: true });

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    uid: UID,
    youtubeUrl: `https://www.youtube.com/watch?v=${NEW_VIDEO_ID}`,
    settings: {
      numClips: 3,
      clipLengthSec: 45,
      cropMode: "pad",
      subtitleColor: "#FFFFFF",
      privacyStatus: "private",
      madeForKids: false,
    },
    trigger: "channel",
    sourceVideoId: NEW_VIDEO_ID,
    sourceTitle: "A newly published main-channel video",
    sourcePublishedAt: newPublishedAt,
  });
  const stored = await store.get(UID);
  assert.equal(stored.events[NEW_VIDEO_ID].status, "processing");
  assert.equal(stored.events[NEW_VIDEO_ID].jobId, "job-new-upload");
  assert.equal(stored.lastDetectedVideo.id, NEW_VIDEO_ID);
});

test("polling detects both native and Zernio-authored main-channel uploads", async (t) => {
  const store = await createStore(t);
  const baseTime = Date.parse("2026-08-30T12:00:00Z");
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: baseTime,
  });
  const zernio = createFakeZernio();
  zernio.setExternalPosts([externalPost({
    videoId: NEW_VIDEO_ID,
    title: "A native YouTube upload",
    publishedAt: baseTime + 1_000,
  })]);
  zernio.setZernioPosts([zernioAuthoredPost({
    videoId: ZERNIO_VIDEO_ID,
    title: "An upload published through Zernio",
    publishedAt: baseTime + 2_000,
  })]);
  const enqueued = [];
  const service = createService({
    store,
    zernio,
    now: () => baseTime + 3_000,
    enqueueJob: async (payload) => {
      enqueued.push(structuredClone(payload));
      return `job-${payload.sourceVideoId}`;
    },
  });

  await service.pollUser(UID, { force: true });

  assert.deepEqual(
    enqueued.map((payload) => payload.sourceVideoId),
    [NEW_VIDEO_ID, ZERNIO_VIDEO_ID]
  );
  assert.equal(
    enqueued.find((payload) => payload.sourceVideoId === ZERNIO_VIDEO_ID)?.youtubeUrl,
    `https://www.youtube.com/watch?v=${ZERNIO_VIDEO_ID}`
  );
  assert.equal(
    enqueued.find((payload) => payload.sourceVideoId === ZERNIO_VIDEO_ID)?.sourceTitle,
    "An upload published through Zernio"
  );
  assert.deepEqual(
    zernio.calls.listPosts.map((call) => ({
      accountId: call.accountId,
      source: call.options.source,
      status: call.options.status,
    })),
    [
      { accountId: MAIN_ACCOUNT_ID, source: "external", status: undefined },
      { accountId: MAIN_ACCOUNT_ID, source: "zernio", status: "published" },
    ]
  );
});

test("an upload at the activation cutoff is not baselined and is queued on the next poll", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store);
  const activationTime = Date.parse("2026-08-30T12:00:00Z");
  const zernio = createFakeZernio();
  zernio.setExternalPosts([externalPost({
    videoId: RACE_VIDEO_ID,
    title: "Published while Ravi was turning on",
    publishedAt: activationTime,
  })]);
  const enqueued = [];
  const service = createService({
    store,
    zernio,
    now: () => activationTime,
    enqueueJob: async (payload) => {
      enqueued.push(structuredClone(payload));
      return "job-activation-race";
    },
  });

  await service.update(UID, { enabled: true });
  let stored = await store.get(UID);
  assert.equal(stored.enabledAt, activationTime);
  assert.equal(stored.events[RACE_VIDEO_ID], undefined);
  assert.equal(enqueued.length, 0);

  await service.pollUser(UID, { force: true });

  stored = await store.get(UID);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sourceVideoId, RACE_VIDEO_ID);
  assert.equal(stored.events[RACE_VIDEO_ID].status, "processing");
  assert.notEqual(stored.events[RACE_VIDEO_ID].status, "baseline");
});

test("a detected upload keeps its snapshotted YouTube publication settings", async (t) => {
  const store = await createStore(t);
  const baseTime = Date.parse("2026-08-30T12:00:00Z");
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: baseTime,
    settings: {
      numClips: 1,
      clipLengthSec: 45,
      cropMode: "pad",
      subtitleColor: "#FFFFFF",
      privacyStatus: "private",
      madeForKids: false,
    },
  });
  const zernio = createFakeZernio();
  zernio.setExternalPosts([externalPost({
    videoId: NEW_VIDEO_ID,
    title: "A source with snapshotted settings",
    publishedAt: baseTime + 1_000,
  })]);
  const service = createService({
    store,
    zernio,
    now: () => baseTime + 2_000,
    enqueueJob: async () => "job-snapshotted-settings",
  });

  await service.pollUser(UID, { force: true });
  let stored = await store.get(UID);
  assert.equal(stored.events[NEW_VIDEO_ID].settings.privacyStatus, "private");
  assert.equal(stored.events[NEW_VIDEO_ID].settings.madeForKids, false);

  await service.update(UID, {
    settings: {
      privacyStatus: "public",
      madeForKids: true,
    },
  });
  stored = await store.get(UID);
  assert.equal(stored.settings.privacyStatus, "public");
  assert.equal(stored.settings.madeForKids, true);
  assert.equal(stored.events[NEW_VIDEO_ID].settings.privacyStatus, "private");
  assert.equal(stored.events[NEW_VIDEO_ID].settings.madeForKids, false);

  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-settings-snapshot-test-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(jobDir, "clips"), { recursive: true });
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.mp4"), "rendered-video");
  await service.publishJob({
    uid: UID,
    jobDir,
    job: {
      id: "job-snapshotted-settings",
      sourceVideoId: NEW_VIDEO_ID,
      sourceTitle: "A source with snapshotted settings",
      clips: [{ index: 1, title: "Settings snapshot clip" }],
    },
  });

  assert.equal(zernio.calls.createPost.length, 1);
  assert.equal(zernio.calls.createPost[0].visibility, "private");
  assert.equal(zernio.calls.createPost[0].madeForKids, false);
});

test("a revoked live sync is not masked by successful cached post listings", async (t) => {
  const store = await createStore(t);
  const baseTime = Date.parse("2026-08-30T12:00:00Z");
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: baseTime,
  });
  const zernio = createFakeZernio();
  zernio.setExternalPosts([externalPost({
    videoId: NEW_VIDEO_ID,
    title: "A cached native post",
    publishedAt: baseTime + 1_000,
  })]);
  zernio.setZernioPosts([zernioAuthoredPost({
    videoId: ZERNIO_VIDEO_ID,
    title: "A cached Zernio-authored post",
    publishedAt: baseTime + 2_000,
  })]);
  zernio.api.syncExternalPosts = async (accountId) => {
    zernio.calls.sync.push({ accountId });
    const error = new Error("The YouTube account was disconnected");
    error.status = 401;
    error.code = "ACCOUNT_DISCONNECTED";
    throw error;
  };
  const enqueued = [];
  const service = createService({
    store,
    zernio,
    now: () => baseTime + 3_000,
    enqueueJob: async (payload) => {
      enqueued.push(structuredClone(payload));
      return "job-should-not-start";
    },
  });

  await service.pollUser(UID, { force: true });

  const stored = await store.get(UID);
  assert.equal(stored.enabled, false);
  assert.equal(stored.status, "reauth_required");
  assert.equal(stored.sourceChannel.needsReauth, true);
  assert.equal(stored.clipsChannel.needsReauth, false);
  assert.match(stored.lastError, /Reconnect the main channel/i);
  assert.equal(enqueued.length, 0);
  assert.deepEqual(zernio.calls.sync, [{ accountId: MAIN_ACCOUNT_ID }]);
});

test("a failed Zernio disconnect preserves the local channel and automation state", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: Date.parse("2026-08-30T12:00:00Z"),
    events: {
      [NEW_VIDEO_ID]: {
        status: "processing",
        sourceVideoId: NEW_VIDEO_ID,
        jobId: "job-in-flight",
      },
    },
  });
  const before = await store.get(UID);
  const zernio = createFakeZernio();
  zernio.api.disconnectAccount = async (accountId) => {
    zernio.calls.disconnect.push({ accountId });
    const error = new Error("Zernio disconnect failed");
    error.status = 503;
    error.retryable = true;
    throw error;
  };
  const service = createService({ store, zernio });

  await assert.rejects(service.disconnect(UID, "main"), /Zernio disconnect failed/);

  const after = await store.get(UID);
  assert.deepEqual(after, before);
  assert.deepEqual(zernio.calls.disconnect, [{ accountId: MAIN_ACCOUNT_ID }]);
  assert.equal(after.sourceChannel.id, MAIN_ACCOUNT_ID);
  assert.equal(after.enabled, true);
  assert.equal(after.events[NEW_VIDEO_ID].jobId, "job-in-flight");
});

test("publishing uploads media through Zernio and reconciles the YouTube link", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: Date.parse("2026-08-30T12:00:00Z"),
    settings: {
      numClips: 1,
      clipLengthSec: 45,
      cropMode: "pad",
      subtitleColor: "#FFFFFF",
      privacyStatus: "unlisted",
      madeForKids: false,
    },
    events: {
      [NEW_VIDEO_ID]: {
        status: "processing",
        sourceVideoId: NEW_VIDEO_ID,
        sourceTitle: "A strong source video",
        jobId: "job-1",
      },
    },
  });
  const zernio = createFakeZernio();
  const publicationUpdates = [];
  const service = createService({
    store,
    zernio,
    onPublicationUpdate: async (update) => {
      publicationUpdates.push(structuredClone(update));
    },
  });
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-publish-test-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(jobDir, "clips"), { recursive: true });
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.mp4"), "rendered-video");
  const job = {
    id: "job-1",
    sourceVideoId: NEW_VIDEO_ID,
    sourceTitle: "A strong source video",
    clips: [{ index: 1, title: "The strongest moment" }],
  };

  const submitted = await service.publishJob({
    uid: UID,
    job,
    jobDir,
    signal: new AbortController().signal,
  });
  assert.equal(submitted.complete, false);
  assert.equal(submitted.published[0].zernioPostId, "zernio-post-1");
  assert.equal(submitted.published[0].youtubeUrl, null);
  assert.equal(zernio.calls.presign[0].filename, `ravi-${NEW_VIDEO_ID}-clip-1.mp4`);
  assert.equal(
    zernio.calls.upload[0].filePath,
    path.join(jobDir, "clips", "clip_1.mp4")
  );
  assert.equal(zernio.calls.createPost.length, 1);
  assert.deepEqual(
    {
      accountId: zernio.calls.createPost[0].accountId,
      mediaUrl: zernio.calls.createPost[0].mediaUrl,
      title: zernio.calls.createPost[0].title,
      visibility: zernio.calls.createPost[0].visibility,
      madeForKids: zernio.calls.createPost[0].madeForKids,
      containsSyntheticMedia: zernio.calls.createPost[0].containsSyntheticMedia,
    },
    {
      accountId: CLIPS_ACCOUNT_ID,
      mediaUrl: "https://media.example/clip-1.mp4",
      title: "The strongest moment",
      visibility: "unlisted",
      madeForKids: false,
      containsSyntheticMedia: false,
    }
  );
  assert.match(
    zernio.calls.createPost[0].description,
    new RegExp(`youtube\\.com/watch\\?v=${NEW_VIDEO_ID}$`)
  );
  assert.match(
    zernio.calls.createPost[0].description,
    /^Created by Ravi from "A strong source video"\./
  );
  assert.match(zernio.calls.createPost[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal((await store.get(UID)).events[NEW_VIDEO_ID].status, "publishing");

  zernio.setFetchedPost({
    _id: "zernio-post-1",
    status: "published",
    platforms: [{
      platform: "youtube",
      status: "published",
      platformPostId: "published01",
      platformPostUrl: "https://www.youtube.com/watch?v=published01",
      publishedAt: "2026-08-30T12:05:00Z",
    }],
  });
  await service.pollAll();

  const stored = await store.get(UID);
  assert.equal(stored.events[NEW_VIDEO_ID].status, "done");
  assert.equal(
    stored.events[NEW_VIDEO_ID].uploads["1"].youtubeUrl,
    "https://www.youtube.com/watch?v=published01"
  );
  assert.equal(zernio.calls.getPost.at(-1).postId, "zernio-post-1");
  assert.equal(publicationUpdates.at(-1).status, "done");
  assert.equal(
    publicationUpdates.at(-1).publications[0].youtubeUrl,
    "https://www.youtube.com/watch?v=published01"
  );
});

test("a posting error keeps reconciling an earlier accepted Zernio post", async (t) => {
  const store = await createStore(t);
  const originalError = "The second clip could not be submitted.";
  await seedConnectedChannels(store, {
    enabled: false,
    status: "error",
    lastError: originalError,
    events: {
      [NEW_VIDEO_ID]: {
        status: "posting_error",
        error: originalError,
        sourceVideoId: NEW_VIDEO_ID,
        sourceTitle: "Partially posted source",
        jobId: "job-partial-posting-error",
        expectedClipCount: 2,
        publishingWorkerId: "previous-worker",
        uploads: {
          "1": {
            clipIndex: 1,
            zernioPostId: "zernio-post-still-publishing",
            youtubeUrl: null,
            privacyStatus: "private",
            status: "publishing",
          },
          "2": {
            clipIndex: 2,
            zernioPostId: null,
            youtubeUrl: null,
            privacyStatus: "private",
            status: "failed",
            error: originalError,
          },
        },
      },
    },
  });
  const zernio = createFakeZernio();
  zernio.setFetchedPost({
    _id: "zernio-post-still-publishing",
    status: "published",
    platforms: [{
      platform: "youtube",
      status: "published",
      platformPostId: "lateclip001",
      platformPostUrl: "https://www.youtube.com/watch?v=lateclip001",
      publishedAt: "2026-08-30T12:10:00Z",
    }],
  });
  const publicationUpdates = [];
  const service = createService({
    store,
    zernio,
    onPublicationUpdate: async (update) => {
      publicationUpdates.push(structuredClone(update));
    },
  });

  await service.pollAll();

  const stored = await store.get(UID);
  const event = stored.events[NEW_VIDEO_ID];
  assert.equal(event.status, "posting_error");
  assert.equal(event.error, originalError);
  assert.equal(stored.lastError, originalError);
  assert.equal(event.completedAt, undefined);
  assert.equal(
    event.uploads["1"].youtubeUrl,
    "https://www.youtube.com/watch?v=lateclip001"
  );
  assert.equal(event.uploads["1"].status, "published");
  assert.equal(event.uploads["2"].status, "failed");
  assert.equal(zernio.calls.getPost.length, 1);
  assert.equal(zernio.calls.getPost[0].postId, "zernio-post-still-publishing");
  assert.equal(publicationUpdates.at(-1).status, "posting_error");
  assert.equal(publicationUpdates.at(-1).error, originalError);
  assert.equal(
    publicationUpdates.at(-1).publications[0].youtubeUrl,
    "https://www.youtube.com/watch?v=lateclip001"
  );
});

test("poll recovery requeues a dead worker's incomplete multi-clip publication", async (t) => {
  const store = await createStore(t);
  const baseTime = Date.parse("2026-08-30T12:00:00Z");
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    enabledAt: baseTime,
    events: {
      [NEW_VIDEO_ID]: {
        status: "publishing",
        sourceVideoId: NEW_VIDEO_ID,
        sourceTitle: "Interrupted multi-clip source",
        sourceUrl: `https://www.youtube.com/watch?v=${NEW_VIDEO_ID}`,
        publishedAt: baseTime + 1_000,
        jobId: "job-dead-worker",
        expectedClipCount: 3,
        publishingWorkerId: "dead-worker-id",
        uploads: {
          "1": {
            clipIndex: 1,
            zernioPostId: "zernio-post-only-one",
            privacyStatus: "private",
            status: "publishing",
          },
        },
      },
    },
  });
  const zernio = createFakeZernio();
  zernio.setExternalPosts([externalPost({
    videoId: NEW_VIDEO_ID,
    title: "Interrupted multi-clip source",
    publishedAt: baseTime + 1_000,
  })]);
  zernio.setFetchedPost({
    _id: "zernio-post-only-one",
    status: "published",
    platforms: [{
      platform: "youtube",
      status: "published",
      platformPostId: "onlyclip001",
      platformPostUrl: "https://www.youtube.com/watch?v=onlyclip001",
    }],
  });
  const enqueued = [];
  const service = createService({
    store,
    zernio,
    now: () => baseTime + 2_000,
    enqueueJob: async (payload) => {
      enqueued.push(structuredClone(payload));
      return "job-requeued-after-bootstrap";
    },
  });

  await service.pollAll();

  const event = (await store.get(UID)).events[NEW_VIDEO_ID];
  assert.notEqual(event.status, "done");
  assert.equal(event.status, "processing");
  assert.equal(event.expectedClipCount, 3);
  assert.equal(Object.keys(event.uploads).length, 1);
  assert.equal(
    event.uploads["1"].youtubeUrl,
    "https://www.youtube.com/watch?v=onlyclip001"
  );
  assert.equal(event.jobId, "job-requeued-after-bootstrap");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sourceVideoId, NEW_VIDEO_ID);
  assert.equal(zernio.calls.getPost.length, 1);
  assert.equal(zernio.calls.createPost.length, 0);
});

test("a posting retry reuses the uploaded media URL instead of uploading a duplicate", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    events: {
      [NEW_VIDEO_ID]: {
        status: "processing",
        sourceVideoId: NEW_VIDEO_ID,
        sourceTitle: "Retry-safe source",
        jobId: "job-retry",
      },
    },
  });
  const zernio = createFakeZernio();
  let postAttempt = 0;
  zernio.api.createYoutubePost = async (payload) => {
    zernio.calls.createPost.push(structuredClone({ ...payload, signal: undefined }));
    postAttempt += 1;
    if (postAttempt === 1) {
      const error = new Error("Temporary Zernio failure");
      error.retryable = true;
      throw error;
    }
    return {
      post: {
        _id: "zernio-post-retried",
        status: "published",
        platforms: [{
          platform: "youtube",
          status: "published",
          platformPostId: "retried0001",
          platformPostUrl: "https://www.youtube.com/watch?v=retried0001",
        }],
      },
    };
  };
  const service = createService({ store, zernio });
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-publish-retry-test-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(jobDir, "clips"), { recursive: true });
  await fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.mp4"), "rendered-video");
  const job = {
    id: "job-retry",
    sourceVideoId: NEW_VIDEO_ID,
    sourceTitle: "Retry-safe source",
    clips: [{ index: 1, title: "A retry-safe clip" }],
  };

  await assert.rejects(service.publishJob({ uid: UID, job, jobDir }));
  assert.equal((await store.get(UID)).events[NEW_VIDEO_ID].uploads["1"].mediaUrl,
    "https://media.example/clip-1.mp4");

  const retried = await service.publishJob({ uid: UID, job, jobDir });
  assert.equal(retried.complete, true);
  assert.equal(zernio.calls.presign.length, 1);
  assert.equal(zernio.calls.upload.length, 1);
  assert.equal(zernio.calls.createPost.length, 2);
  assert.equal(zernio.calls.createPost[0].mediaUrl, zernio.calls.createPost[1].mediaUrl);
});

test("a multi-clip retry resumes after the accepted clip and later reconciles it", async (t) => {
  const store = await createStore(t);
  await seedConnectedChannels(store, {
    enabled: true,
    status: "watching",
    events: {
      [NEW_VIDEO_ID]: {
        status: "processing",
        sourceVideoId: NEW_VIDEO_ID,
        sourceTitle: "Multi-clip recovery source",
        jobId: "job-multi-retry",
      },
    },
  });
  const zernio = createFakeZernio();
  let postAttempt = 0;
  zernio.api.createMediaPresign = async (filename) => {
    zernio.calls.presign.push({ filename });
    const clipIndex = filename.match(/clip-(\d+)\.mp4$/)?.[1] || "unknown";
    return {
      uploadUrl: `https://storage.example/upload-${clipIndex}?signature=test`,
      publicUrl: `https://media.example/clip-${clipIndex}.mp4`,
    };
  };
  zernio.api.createYoutubePost = async (payload) => {
    zernio.calls.createPost.push(structuredClone({ ...payload, signal: undefined }));
    postAttempt += 1;
    if (postAttempt === 2) {
      const error = new Error("Temporary failure after the first clip was accepted");
      error.retryable = true;
      throw error;
    }
    const isFirstClip = payload.mediaUrl.endsWith("clip-1.mp4");
    return {
      post: {
        _id: isFirstClip ? "zernio-post-clip-1" : "zernio-post-clip-2",
        status: isFirstClip ? "publishing" : "published",
        platforms: [{
          platform: "youtube",
          status: isFirstClip ? "publishing" : "published",
          ...(isFirstClip ? {} : {
            platformPostId: "clip2video1",
            platformPostUrl: "https://www.youtube.com/watch?v=clip2video1",
          }),
        }],
      },
    };
  };
  const service = createService({ store, zernio });
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravi-multi-retry-test-"));
  t.after(() => fs.promises.rm(jobDir, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(jobDir, "clips"), { recursive: true });
  await Promise.all([
    fs.promises.writeFile(path.join(jobDir, "clips", "clip_1.mp4"), "first-render"),
    fs.promises.writeFile(path.join(jobDir, "clips", "clip_2.mp4"), "second-render"),
  ]);
  const job = {
    id: "job-multi-retry",
    sourceVideoId: NEW_VIDEO_ID,
    sourceTitle: "Multi-clip recovery source",
    clips: [
      { index: 1, title: "First accepted clip" },
      { index: 2, title: "Second retrying clip" },
    ],
  };

  await assert.rejects(service.publishJob({ uid: UID, job, jobDir }));
  let event = (await store.get(UID)).events[NEW_VIDEO_ID];
  assert.equal(event.uploads["1"].zernioPostId, "zernio-post-clip-1");
  assert.equal(event.uploads["2"].mediaUrl, "https://media.example/clip-2.mp4");
  assert.equal(event.uploads["2"].zernioPostId, undefined);

  const retried = await service.publishJob({ uid: UID, job, jobDir });
  assert.equal(retried.complete, false);
  assert.equal(zernio.calls.presign.length, 2);
  assert.equal(zernio.calls.upload.length, 2);
  assert.equal(zernio.calls.createPost.length, 3);
  assert.equal(
    zernio.calls.createPost.filter((call) => call.mediaUrl.endsWith("clip-1.mp4")).length,
    1
  );
  assert.equal(
    zernio.calls.createPost.filter((call) => call.mediaUrl.endsWith("clip-2.mp4")).length,
    2
  );

  zernio.setFetchedPost({
    _id: "zernio-post-clip-1",
    status: "published",
    platforms: [{
      platform: "youtube",
      status: "published",
      platformPostId: "clip1video1",
      platformPostUrl: "https://www.youtube.com/watch?v=clip1video1",
    }],
  });
  await service.pollAll();

  event = (await store.get(UID)).events[NEW_VIDEO_ID];
  assert.equal(event.status, "done");
  assert.equal(
    event.uploads["1"].youtubeUrl,
    "https://www.youtube.com/watch?v=clip1video1"
  );
  assert.equal(
    event.uploads["2"].youtubeUrl,
    "https://www.youtube.com/watch?v=clip2video1"
  );
});
