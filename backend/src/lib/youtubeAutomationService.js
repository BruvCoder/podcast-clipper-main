import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createZernioApi, ZernioApiError } from "./zernioApi.js";
import { resolveYoutubeChannel } from "./ytdlp.js";
import { fetchYoutubeChannelFeed } from "./youtubeChannelFeed.js";
import { PLATFORMS, isSupportedPlatform, listPlatforms } from "./socialPlatforms.js";

const DEFAULT_SETTINGS = Object.freeze({
  numClips: 3,
  clipLengthSec: 45,
  cropMode: "pad",
  subtitleColor: "#FFFFFF",
  privacyStatus: "private",
  madeForKids: false,
});

const DEFAULT_CERTIFICATIONS = Object.freeze({
  ownsSourceContent: false,
  acceptsCommunityGuidelines: false,
});

const CONNECTION_ROLES = new Set(["clips"]);
const CHANNEL_ROLES = new Set(["main", "clips"]);
const MAX_AUTOMATION_ATTEMPTS = 3;
const MAX_STORED_EVENTS = 250;

export class YoutubeAutomationError extends Error {
  constructor(message, { status = 400, code = "youtube_automation_error", cause } = {}) {
    super(message, { cause });
    this.name = "YoutubeAutomationError";
    this.status = status;
    this.code = code;
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export function loadYoutubeAutomationConfig(env = process.env, { stateDir } = {}) {
  const apiKey = String(env.ZERNIO_API_KEY || "").trim();
  const appUrl = String(env.APP_URL || "").trim().replace(/\/$/, "");
  const publicApiUrl = String(env.YOUTUBE_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  const callbackUrl = String(
    env.YOUTUBE_OAUTH_REDIRECT_URI ||
      (publicApiUrl ? `${publicApiUrl}/api/youtube/oauth/callback` : "")
  ).trim();
  const required = {
    ZERNIO_API_KEY: apiKey,
    APP_URL: appUrl,
    YOUTUBE_PUBLIC_API_URL: publicApiUrl,
    YOUTUBE_OAUTH_REDIRECT_URI: callbackUrl,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return {
    configured: missing.length === 0,
    missing,
    apiKey,
    appUrl,
    publicApiUrl,
    callbackUrl,
    stateDir,
    zernioBaseUrl: String(env.ZERNIO_BASE_URL || "").trim() || undefined,
    requestTimeoutMs: boundedInteger(env.ZERNIO_REQUEST_TIMEOUT_MS, 20_000, 1_000, 120_000),
    uploadTimeoutMs: boundedInteger(env.ZERNIO_UPLOAD_TIMEOUT_MS, 900_000, 10_000, 3_600_000),
    pollIntervalMs: boundedInteger(env.YOUTUBE_WATCH_POLL_MS, 60_000, 60_000, 3_600_000),
    oauthStateTtlMs: boundedInteger(env.YOUTUBE_OAUTH_STATE_TTL_MS, 600_000, 60_000, 900_000),
    cookieSecure: /^https:/i.test(publicApiUrl),
  };
}

function defaultRecord(uid) {
  return {
    uid,
    version: 5,
    zernioProfiles: {
      main: null,
      clips: null,
    },
    pendingConnectionCleanup: {
      main: null,
      clips: null,
    },
    enabled: false,
    status: "setup",
    sourceChannel: null,
    clipsChannel: null,
    // Destinations beyond the YouTube clips channel: TikTok, Instagram, and
    // the rest. clipsChannel stays the YouTube one rather than folding into
    // this list, because the whole setup and validation path is built around
    // it and rewriting that would put a working publish flow at risk.
    destinations: [],
    settings: { ...DEFAULT_SETTINGS },
    certifications: { ...DEFAULT_CERTIFICATIONS },
    events: {},
    recentActivity: [],
    lastCheckedAt: null,
    lastDetectedVideo: null,
    lastPublishedAt: null,
    lastError: null,
  };
}

function withDefaults(record, uid) {
  const base = defaultRecord(uid);
  if (!record) return base;
  const {
    zernioProfileId: legacyProfileId,
    zernioProfileIds: legacyProfileIds,
    ...persisted
  } = record;
  const hasRoleProfiles = record.zernioProfiles && typeof record.zernioProfiles === "object";
  const zernioProfiles = {
    ...base.zernioProfiles,
    ...(legacyProfileIds && typeof legacyProfileIds === "object" ? legacyProfileIds : {}),
    ...(hasRoleProfiles ? record.zernioProfiles : {}),
  };

  // The pre-v3 draft used one profile for both roles. Zernio permits only one
  // account per platform in a profile, so retain that legacy profile only for
  // the role it could actually have represented.
  if (!hasRoleProfiles && legacyProfileId) {
    if (record.sourceChannel || !record.clipsChannel) zernioProfiles.main = legacyProfileId;
    else zernioProfiles.clips = legacyProfileId;
  }
  return {
    ...base,
    ...persisted,
    version: 5,
    zernioProfiles,
    destinations: sanitizeDestinations(record.destinations),
    pendingConnectionCleanup: {
      ...base.pendingConnectionCleanup,
      ...(record.pendingConnectionCleanup && typeof record.pendingConnectionCleanup === "object"
        ? record.pendingConnectionCleanup
        : {}),
    },
    settings: { ...base.settings, ...(record.settings || {}) },
    certifications: { ...base.certifications, ...(record.certifications || {}) },
    events: record.events && typeof record.events === "object" ? record.events : {},
    recentActivity: Array.isArray(record.recentActivity) ? record.recentActivity : [],
  };
}

/**
 * Normalises persisted destinations.
 *
 * A record written by an older build has no destinations at all, and one
 * hand-edited or half-written could carry anything. Entries without a platform
 * Ravi still supports, or without an account, are dropped rather than carried
 * forward into a publish call that would fail at Zernio.
 */
function sanitizeDestinations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const destinations = [];
  for (const entry of value) {
    const platform = String(entry?.platform || "");
    const id = String(entry?.accountId || entry?.id || "");
    if (!isSupportedPlatform(platform) || !id) continue;
    // Zernio allows one account per platform per profile, so a duplicate here
    // is corruption rather than a second legitimate account.
    const key = `${platform}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    destinations.push({
      platform,
      accountId: id,
      title: String(entry.title || PLATFORMS[platform].label),
      username: entry.username ? String(entry.username) : null,
      thumbnailUrl: entry.thumbnailUrl ? String(entry.thumbnailUrl) : null,
      url: entry.url ? String(entry.url) : null,
      connectedAt: Number.isFinite(entry.connectedAt) ? entry.connectedAt : null,
      needsReauth: Boolean(entry.needsReauth),
    });
  }
  return destinations;
}

function addActivity(record, activity, at = Date.now()) {
  record.recentActivity = [
    { at, ...activity },
    ...(record.recentActivity || []),
  ].slice(0, 20);
}

function pruneEvents(record) {
  const entries = Object.entries(record.events || {});
  if (entries.length <= MAX_STORED_EVENTS) return;
  const active = entries.filter(([, event]) =>
    ["queued", "processing", "pending", "retry", "publishing", "reconcile_required"].includes(event?.status)
  );
  const activeIds = new Set(active.map(([id]) => id));
  const terminal = entries
    .filter(([id]) => !activeIds.has(id))
    .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0));
  const keep = new Map(active);
  for (const [id, event] of terminal) {
    if (keep.size >= MAX_STORED_EVENTS) break;
    keep.set(id, event);
  }
  record.events = Object.fromEntries(keep);
}

function cleanMessage(error, fallback = "Ravi's channel connection needs attention.") {
  if (error instanceof YoutubeAutomationError || error instanceof ZernioApiError) {
    return error.message;
  }
  return fallback;
}

function publicChannel(channel) {
  if (!channel) return null;
  const provider = channel.provider === "public" ? "public" : "zernio";
  const result = {
    id: channel.id,
    title: channel.title,
    username: channel.username || null,
    thumbnailUrl: channel.thumbnailUrl || null,
    url: channel.url || null,
    connectedAt: channel.connectedAt || null,
    provider,
  };
  if (provider === "zernio") {
    result.accountId = channel.id;
    result.needsReauth = Boolean(channel.needsReauth);
  }
  return result;
}

function publicStatus(record, config) {
  const current = withDefaults(record, record?.uid || "");
  return {
    available: config.configured,
    configured: config.configured,
    connectionProvider: "zernio-clips",
    missing: config.missing,
    enabled: Boolean(current.enabled),
    status: current.status,
    sourceChannel: publicChannel(current.sourceChannel),
    clipsChannel: publicChannel(current.clipsChannel),
    destinations: current.destinations.map((destination) => ({
      platform: destination.platform,
      label: PLATFORMS[destination.platform]?.label || destination.platform,
      accountId: destination.accountId,
      title: destination.title,
      username: destination.username,
      thumbnailUrl: destination.thumbnailUrl,
      url: destination.url,
      connectedAt: destination.connectedAt,
      needsReauth: destination.needsReauth,
    })),
    availablePlatforms: listPlatforms(),
    settings: current.settings,
    certifications: current.certifications,
    lastCheckedAt: current.lastCheckedAt,
    lastDetectedVideo: current.lastDetectedVideo,
    lastPublishedAt: current.lastPublishedAt,
    recentActivity: current.recentActivity,
    lastError: current.lastError,
  };
}

function sanitizeSettings(input, current) {
  const next = { ...DEFAULT_SETTINGS, ...(current || {}) };
  if (!input || typeof input !== "object") return next;
  if (hasOwn(input, "numClips")) {
    next.numClips = boundedInteger(input.numClips, next.numClips, 1, 5);
  }
  if (hasOwn(input, "clipLengthSec")) {
    next.clipLengthSec = boundedInteger(input.clipLengthSec, next.clipLengthSec, 15, 90);
  }
  if (hasOwn(input, "cropMode")) next.cropMode = input.cropMode === "crop" ? "crop" : "pad";
  if (hasOwn(input, "subtitleColor") && /^#[0-9A-Fa-f]{6}$/.test(input.subtitleColor || "")) {
    next.subtitleColor = input.subtitleColor.toUpperCase();
  }
  if (hasOwn(input, "privacyStatus") && ["private", "unlisted", "public"].includes(input.privacyStatus)) {
    next.privacyStatus = input.privacyStatus;
  }
  if (hasOwn(input, "madeForKids")) next.madeForKids = input.madeForKids === true;
  delete next.notificationPreference;
  return next;
}

function sanitizeCertifications(input, current) {
  const next = { ...DEFAULT_CERTIFICATIONS, ...(current || {}) };
  if (!input || typeof input !== "object") return next;
  if (hasOwn(input, "ownsSourceContent")) {
    next.ownsSourceContent = input.ownsSourceContent === true;
  }
  if (hasOwn(input, "acceptsCommunityGuidelines")) {
    next.acceptsCommunityGuidelines = input.acceptsCommunityGuidelines === true;
  }
  return next;
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function stableUuid(value) {
  const bytes = createHash("sha256").update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function profileName(uid, role) {
  return `ravi-${createHash("sha256").update(String(uid)).digest("hex").slice(0, 20)}-${role}`;
}

function accountId(account) {
  return String(account?._id || account?.id || account?.accountId || "");
}

function profileIdOf(account) {
  return String(account?.profileId?._id || account?.profileId || "");
}

function normalizeChannelIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/^@/, "");
}

function channelIdentityCandidates(channel) {
  if (!channel) return [];
  return [
    channel.platformIdentity,
    channel.url,
    channel.username,
  ].map(normalizeChannelIdentity).filter(Boolean);
}

function sameYoutubeChannel(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  const rightIdentities = new Set(channelIdentityCandidates(right));
  return channelIdentityCandidates(left).some((identity) => rightIdentities.has(identity));
}

function channelFromAccount(account, role, connectedAt, health = null) {
  const id = accountId(account);
  if (!id) {
    throw new YoutubeAutomationError("Zernio did not return the connected YouTube channel.", {
      status: 502,
      code: "zernio_account_missing",
    });
  }
  const tokenValid = health?.tokenStatus?.valid;
  const canPost = health?.permissions?.canPost;
  const platformIdentity =
    account.metadata?.channelId ||
    account.metadata?.youtubeChannelId ||
    account.metadata?.youtube?.channelId ||
    null;
  return {
    id,
    title: account.displayName || account.username || "YouTube channel",
    username: account.username || null,
    thumbnailUrl:
      account.profilePicture ||
      account.thumbnailUrl ||
      account.profilePictureUrl ||
      account.profileImageUrl ||
      null,
    url: account.profileUrl || null,
    platformIdentity,
    connectedAt,
    needsReauth:
      account.isActive === false ||
      account.needsReconnection === true ||
      tokenValid === false ||
      (role === "clips" && canPost === false),
    provider: "zernio",
  };
}

/**
 * The same shape as channelFromAccount, for every platform that is not the
 * YouTube clips channel. Kept separate rather than generalising that function,
 * because it carries YouTube-specific identity fields the publish path relies
 * on and this runs against a live flow.
 */
function destinationFromAccount(account, platform, connectedAt, health = null) {
  const id = accountId(account);
  const label = PLATFORMS[platform]?.label || platform;
  if (!id) {
    throw new YoutubeAutomationError(`Zernio did not return the connected ${label} account.`, {
      status: 502,
      code: "zernio_account_missing",
    });
  }
  const tokenValid = health?.tokenStatus?.valid;
  const canPost = health?.permissions?.canPost;
  return {
    platform,
    accountId: id,
    title: account.displayName || account.username || label,
    username: account.username || null,
    thumbnailUrl:
      account.profilePicture ||
      account.thumbnailUrl ||
      account.profilePictureUrl ||
      account.profileImageUrl ||
      null,
    url: account.profileUrl || null,
    connectedAt,
    // A destination exists solely to be posted to, so no-post permission is
    // as disqualifying as an invalid token.
    needsReauth:
      account.isActive === false ||
      account.needsReconnection === true ||
      tokenValid === false ||
      canPost === false,
  };
}

function retryDelay(attempts) {
  return Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, attempts - 1)));
}

function postFromResponse(response) {
  return response?.post || response?.existingPost || response || null;
}

function publicationFromPost(post, clipIndex, privacyStatus) {
  const allTargets = post?.platforms || [];
  const target = allTargets.find((item) => item?.platform === "youtube") || {};
  const youtubeVideoId = target.platformPostId || post?.platformPostId || null;
  const youtubeUrl = target.platformPostUrl || post?.platformPostUrl ||
    (youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : null);
  return {
    clipIndex,
    zernioPostId: post?._id || post?.id || null,
    youtubeVideoId,
    youtubeUrl,
    privacyStatus,
    status: target.status || post?.status || (youtubeUrl ? "published" : "publishing"),
    publishedAt: Date.parse(target.publishedAt || post?.publishedAt || "") || null,
    // Where else this clip went. One platform failing leaves the others
    // published, so each carries its own status rather than a single verdict.
    destinations: allTargets
      .filter((item) => item?.platform && item.platform !== "youtube")
      .map((item) => ({
        platform: item.platform,
        status: item.status || "publishing",
        url: item.platformPostUrl || null,
      })),
  };
}

export function createYoutubeAutomationService({
  config,
  store,
  enqueueJob,
  zernioApi,
  resolveSourceChannel = resolveYoutubeChannel,
  fetchSourceFeed,
  fetchImpl = fetch,
  logger = console,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onPublicationUpdate = async () => {},
}) {
  const zernio = zernioApi || (config.configured
    ? createZernioApi({
        apiKey: config.apiKey,
        baseUrl: config.zernioBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        uploadTimeoutMs: config.uploadTimeoutMs,
        fetchImpl,
      })
    : null);
  const readSourceFeed = fetchSourceFeed || ((channel) =>
    fetchYoutubeChannelFeed(channel.id, {
      fetchImpl,
      timeoutMs: config.requestTimeoutMs,
    }));
  const workerId = randomBytes(16).toString("base64url");
  const polls = new Map();
  let pollAllPromise = null;
  let pollTimer = null;
  let bootstrapTimer = null;

  function requireConfigured() {
    if (!config.configured || !zernio) {
      throw new YoutubeAutomationError(
        "Zernio channel connections are not configured on this deployment yet.",
        { status: 503, code: "zernio_not_configured" }
      );
    }
  }

  async function getRecord(uid) {
    return withDefaults(await store.get(uid), uid);
  }

  async function status(uid) {
    return publicStatus(await getRecord(uid), config);
  }

  async function retryPendingConnectionCleanup(uid, role) {
    await store.update(uid, async (value) => {
      const next = withDefaults(value, uid);
      const pending = next.pendingConnectionCleanup[role];
      if (!pending?.accountId) return next;
      try {
        await zernio.disconnectAccount(pending.accountId);
      } catch (error) {
        if (error?.status !== 404) {
          throw new YoutubeAutomationError(
            `Ravi is still resetting the ${role} channel connection. Try again in a moment.`,
            { status: 503, code: "zernio_cleanup_pending", cause: error }
          );
        }
      }
      next.pendingConnectionCleanup[role] = null;
      if (next.lastError === `Ravi needs to finish resetting the ${role} channel connection.`) {
        next.lastError = null;
        next.status = next.enabled
          ? "watching"
          : next.sourceChannel && next.clipsChannel
            ? "paused"
            : "setup";
      }
      return next;
    });
  }

  async function cleanupRejectedConnection(uid, role, profileId, accountIdToRemove) {
    try {
      await zernio.disconnectAccount(accountIdToRemove);
      return;
    } catch (error) {
      if (error?.status === 404) return;
      await store.update(uid, (value) => {
        const next = withDefaults(value, uid);
        next.pendingConnectionCleanup[role] = {
          accountId: accountIdToRemove,
          profileId,
          createdAt: now(),
        };
        next.enabled = false;
        next.status = "error";
        next.lastError = `Ravi needs to finish resetting the ${role} channel connection.`;
        return next;
      });
      throw new YoutubeAutomationError(
        `Ravi could not reset the rejected ${role} channel connection. Try connecting again in a moment.`,
        { status: 503, code: "zernio_cleanup_pending", cause: error }
      );
    }
  }

  async function ensureProfile(uid, role) {
    let resolvedId = null;
    await store.update(uid, async (value) => {
      const next = withDefaults(value, uid);
      if (next.zernioProfiles[role]) {
        resolvedId = next.zernioProfiles[role];
        return next;
      }
      const name = profileName(uid, role);
      try {
        const created = await zernio.createProfile(name, `Ravi ${role}-channel connection`, {
          idempotencyKey: stableUuid(`ravi-profile:${uid}:${role}`),
        });
        resolvedId = created?.profile?._id || created?.profile?.id || null;
      } catch (error) {
        resolvedId = error?.details?.existingProfileId || null;
        if (!resolvedId) {
          const listed = await zernio.listProfiles({ name, limit: 2 });
          resolvedId = listed?.profiles?.find((profile) => profile?.name === name)?._id || null;
        }
        if (!resolvedId) throw error;
      }
      if (!resolvedId) {
        const listed = await zernio.listProfiles({ name, limit: 2 });
        resolvedId = listed?.profiles?.find((profile) => profile?.name === name)?._id || null;
      }
      if (!resolvedId) {
        throw new YoutubeAutomationError(`Zernio could not create Ravi's ${role}-channel profile.`, {
          status: 502,
          code: "zernio_profile_missing",
        });
      }
      next.zernioProfiles[role] = resolvedId;
      return next;
    });
    return resolvedId;
  }

  async function startOauth(uid, role = "clips", platform = "youtube") {
    requireConfigured();
    if (!CONNECTION_ROLES.has(role)) {
      throw new YoutubeAutomationError("Only the clips channel needs to be connected.", {
        status: 400,
        code: "invalid_channel_role",
      });
    }
    const normalizedPlatform = String(platform || "youtube");
    if (!isSupportedPlatform(normalizedPlatform)) {
      throw new YoutubeAutomationError("Ravi cannot post clips to that platform.", {
        status: 400,
        code: "unsupported_platform",
      });
    }
    await retryPendingConnectionCleanup(uid, role);
    // Every destination shares the clips profile. Zernio allows one account
    // per platform within a profile, so one profile holds YouTube, TikTok,
    // Instagram and the rest without collision.
    const zernioProfileId = await ensureProfile(uid, role);
    const state = randomBytes(32).toString("base64url");
    await store.sweepOauthStates(now());
    await store.createOauthState(state, {
      uid,
      role,
      platform: normalizedPlatform,
      zernioProfileId,
      createdAt: now(),
      expiresAt: now() + config.oauthStateTtlMs,
    });
    const callback = new URL(config.callbackUrl);
    callback.searchParams.set("state", state);
    callback.searchParams.set("role", role);
    try {
      const connection = await zernio.getConnectUrl(
        zernioProfileId,
        callback.toString(),
        normalizedPlatform
      );
      if (!connection?.authUrl) throw new Error("Missing Zernio authUrl.");
      return { url: connection.authUrl, state, role, platform: normalizedPlatform };
    } catch (error) {
      await store.consumeOauthState(state).catch(() => {});
      throw error;
    }
  }

  async function completeOauth({
    state,
    cookieState,
    connected,
    profileId,
    accountId: connectedAccountId,
    oauthError,
  }) {
    requireConfigured();
    if (!state || !sameSecret(state, cookieState)) {
      throw new YoutubeAutomationError(
        "This channel connection expired or came from another browser.",
        { status: 400, code: "invalid_oauth_state" }
      );
    }
    const pending = await store.consumeOauthState(state);
    if (!pending || pending.expiresAt <= now()) {
      throw new YoutubeAutomationError("This channel connection expired. Start again from Ravi.", {
        status: 400,
        code: "invalid_oauth_state",
      });
    }
    // States written before multi-platform destinations carry no platform.
    const pendingPlatform = pending.platform || "youtube";
    const platformLabel = PLATFORMS[pendingPlatform]?.label || pendingPlatform;
    if (oauthError || connected !== pendingPlatform) {
      throw new YoutubeAutomationError(`${platformLabel} access was not granted through Zernio.`, {
        status: 400,
        code: "zernio_oauth_denied",
      });
    }
    if (pending.role !== "clips") {
      // A main-channel OAuth flow may have been started before the clips-only
      // rollout and completed after it. Zernio has already allocated the
      // account by the time this callback arrives, so release the allocation
      // only when its callback profile matches the stored legacy flow. If Zernio is
      // temporarily unavailable, cleanupRejectedConnection records the exact
      // account for a later retry.
      if (
        pending.role === "main" &&
        connectedAccountId &&
        profileId === pending.zernioProfileId
      ) {
        try {
          await cleanupRejectedConnection(
            pending.uid,
            pending.role,
            pending.zernioProfileId,
            connectedAccountId
          );
        } catch (error) {
          if (error?.code !== "zernio_cleanup_pending") throw error;
        }
      }
      throw new YoutubeAutomationError("This clips-channel connection has an invalid role.", {
        status: 400,
        code: "invalid_channel_role",
      });
    }
    if (!connectedAccountId || profileId !== pending.zernioProfileId) {
      throw new YoutubeAutomationError("Zernio returned a channel for a different Ravi profile.", {
        status: 400,
        code: "zernio_profile_mismatch",
      });
    }
    const account = await zernio.findAccountById(connectedAccountId, {
      profileId: pending.zernioProfileId,
      platform: pendingPlatform,
    });
    if (!account || profileIdOf(account) !== pending.zernioProfileId) {
      throw new YoutubeAutomationError(`Ravi could not verify the connected ${platformLabel} account.`, {
        status: 400,
        code: "zernio_account_mismatch",
      });
    }
    const health = await zernio.getAccountHealth(connectedAccountId).catch(() => null);

    // Every destination other than the YouTube clips channel is stored in the
    // destinations list. The YouTube path below is left exactly as it was,
    // since the whole setup and same-channel validation hangs off it.
    if (pendingPlatform !== "youtube") {
      const destination = destinationFromAccount(account, pendingPlatform, now(), health);
      if (destination.needsReauth) {
        await cleanupRejectedConnection(
          pending.uid,
          pending.role,
          pending.zernioProfileId,
          destination.accountId
        );
        throw new YoutubeAutomationError(
          `This ${platformLabel} account did not grant the permissions Ravi needs.`,
          { status: 409, code: "zernio_channel_unhealthy" }
        );
      }
      const updated = await store.update(pending.uid, (value) => {
        value = withDefaults(value, pending.uid);
        if (value.zernioProfiles[pending.role] !== pending.zernioProfileId) {
          throw new YoutubeAutomationError("This connection no longer matches your Ravi profile.", {
            status: 409,
            code: "zernio_profile_mismatch",
          });
        }
        // Reconnecting the same platform replaces the old account rather than
        // accumulating a second entry Zernio would reject anyway.
        value.destinations = [
          ...value.destinations.filter((entry) => entry.platform !== pendingPlatform),
          destination,
        ];
        value.lastError = null;
        addActivity(value, {
          type: "connection",
          status: "success",
          message: `Connected ${platformLabel}: ${destination.title}`,
        }, now());
        return value;
      });
      return { role: pending.role, platform: pendingPlatform, record: updated };
    }

    const channel = channelFromAccount(account, pending.role, now(), health);
    if (channel.needsReauth) {
      await cleanupRejectedConnection(
        pending.uid,
        pending.role,
        pending.zernioProfileId,
        channel.id
      );
      throw new YoutubeAutomationError("This YouTube channel did not grant the permissions Ravi needs.", {
        status: 409,
        code: "zernio_channel_unhealthy",
      });
    }

    let previous = null;
    let shouldCleanupRejectedConnection = false;
    let next;
    try {
      next = await store.update(pending.uid, (value) => {
        value = withDefaults(value, pending.uid);
        if (value.zernioProfiles[pending.role] !== pending.zernioProfileId) {
          throw new YoutubeAutomationError("This channel connection no longer matches your Ravi profile.", {
            status: 409,
            code: "zernio_profile_mismatch",
          });
        }
        if (sameYoutubeChannel(value.sourceChannel, channel)) {
          shouldCleanupRejectedConnection = value.sourceChannel?.id !== channel.id;
          throw new YoutubeAutomationError(
            "The main and clips channels must be different so Ravi cannot clip its own posts.",
            { status: 409, code: "same_channel" }
          );
        }
        previous = value.clipsChannel;
        value.clipsChannel = channel;
        value.enabled = false;
        value.status = value.sourceChannel && value.clipsChannel ? "paused" : "setup";
        value.lastError = null;
        addActivity(value, {
          type: "connection",
          status: "success",
          message: `Connected clips channel: ${channel.title}`,
        }, now());
        return value;
      });
    } catch (error) {
      if (error?.code === "same_channel" && shouldCleanupRejectedConnection) {
        await cleanupRejectedConnection(
          pending.uid,
          pending.role,
          pending.zernioProfileId,
          channel.id
        );
      }
      throw error;
    }
    if (previous?.id && previous.id !== channel.id) {
      await zernio.disconnectAccount(previous.id).catch((error) => {
        if (error?.status !== 404) {
          logger.warn(
            `Zernio ${pending.role} channel replacement cleanup failed:`,
            error?.code || error?.message
          );
        }
      });
    }
    return { uid: pending.uid, role: pending.role, channel, status: publicStatus(next, config) };
  }

  async function fetchSourceEntries(record) {
    const source = record.sourceChannel;
    if (!source?.id) return [];
    if (source.provider !== "public") {
      throw new YoutubeAutomationError("Add your main channel link before Ravi starts watching.", {
        status: 409,
        code: "source_link_required",
      });
    }
    const rawEntries = await readSourceFeed(source);
    const entries = new Map();
    for (const entry of Array.isArray(rawEntries) ? rawEntries : []) {
      if (!entry || entry.channelId !== source.id) continue;
      if (!/^[A-Za-z0-9_-]{11}$/.test(String(entry.videoId || ""))) continue;
      if (!Number.isFinite(entry.publishedAt)) continue;
      entries.set(entry.videoId, {
        videoId: entry.videoId,
        channelId: source.id,
        title: String(entry.title || "New YouTube upload").trim().slice(0, 180),
        publishedAt: entry.publishedAt,
        url: entry.url || `https://www.youtube.com/watch?v=${entry.videoId}`,
      });
    }
    return [...entries.values()].sort((left, right) => left.publishedAt - right.publishedAt);
  }

  async function setSourceChannel(uid, url) {
    requireConfigured();
    let resolved;
    try {
      resolved = await resolveSourceChannel(url);
    } catch (error) {
      if (error instanceof YoutubeAutomationError) throw error;
      const invalidInput = error?.code === "ERR_YTDLP_CHANNEL_URL";
      throw new YoutubeAutomationError(
        invalidInput
          ? "Enter a valid public YouTube channel link or @handle."
          : "Ravi could not verify that YouTube channel right now. Try again.",
        {
          status: invalidInput ? 422 : 502,
          code: invalidInput ? "invalid_source_channel" : "source_channel_lookup_failed",
          cause: error,
        }
      );
    }

    // Older records may still have a rejected main-channel connection waiting
    // for removal. Resolve that allocation before replacing the local source;
    // the retry marker remains intact if the upstream disconnect fails.
    await retryPendingConnectionCleanup(uid, "main");

    const channel = {
      id: resolved.id,
      platformIdentity: resolved.id,
      title: resolved.title || resolved.username || "YouTube channel",
      username: resolved.username || null,
      thumbnailUrl: resolved.thumbnailUrl || null,
      url: resolved.url,
      connectedAt: now(),
      provider: "public",
    };

    const next = await store.update(uid, async (value) => {
      value = withDefaults(value, uid);
      if (sameYoutubeChannel(value.clipsChannel, channel)) {
        throw new YoutubeAutomationError(
          "Your main and clips channels must be different.",
          { status: 409, code: "same_channel" }
        );
      }

      const previous = value.sourceChannel;
      const changed = previous?.provider !== "public" || previous?.id !== channel.id;
      // A missing provider identifies a pre-v4 Zernio-backed source. Treat it
      // exactly like an explicit legacy provider so its account allocation is
      // not orphaned when the public channel link replaces it.
      if (changed && previous?.provider !== "public" && previous?.id) {
        try {
          await zernio.disconnectAccount(previous.id);
        } catch (error) {
          if (error?.status !== 404) throw error;
        }
      }

      value.sourceChannel = channel;
      value.lastError = null;
      if (changed) {
        value.enabled = false;
        value.status = value.clipsChannel ? "paused" : "setup";
        value.enabledAt = null;
        value.events = {};
        value.lastDetectedVideo = null;
        value.lastCheckedAt = null;
        addActivity(value, {
          type: "connection",
          status: "success",
          message: `Added main channel: ${channel.title}`,
        }, now());
      }
      return value;
    });
    return publicStatus(next, config);
  }

  async function update(uid, payload = {}) {
    requireConfigured();
    let current = await getRecord(uid);
    const settings = sanitizeSettings(payload.settings, current.settings);
    const certifications = sanitizeCertifications(payload.certifications, current.certifications);
    const requestedEnabled = payload.enabled === undefined ? current.enabled : payload.enabled === true;
    if (requestedEnabled) {
      if (!current.sourceChannel || current.sourceChannel.provider !== "public") {
        throw new YoutubeAutomationError("Add the main channel link Ravi should watch.", {
          status: 409,
          code: "source_channel_required",
        });
      }
      if (!current.clipsChannel) {
        throw new YoutubeAutomationError("Connect the clips channel where Ravi should post.", {
          status: 409,
          code: "clips_channel_required",
        });
      }
      if (!current.zernioProfiles.clips) {
        throw new YoutubeAutomationError("Reconnect your clips channel before turning Ravi on.", {
          status: 409,
          code: "zernio_profile_required",
        });
      }
      if (sameYoutubeChannel(current.sourceChannel, current.clipsChannel)) {
        throw new YoutubeAutomationError("The main and clips channels must be different.", {
          status: 409,
          code: "same_channel",
        });
      }
      if (current.clipsChannel.needsReauth) {
        throw new YoutubeAutomationError("Reconnect your clips channel before turning Ravi on.", {
          status: 409,
          code: "zernio_reauth_required",
        });
      }
      if (!certifications.ownsSourceContent || !certifications.acceptsCommunityGuidelines) {
        throw new YoutubeAutomationError(
          "Confirm your content rights and YouTube Community Guidelines responsibility before turning Ravi on.",
          { status: 422, code: "certification_required" }
        );
      }
    }

    const turningOn = requestedEnabled && !current.enabled;
    const activationCutoff = turningOn ? now() : null;
    const baselineEntries = turningOn ? await fetchSourceEntries(current) : [];
    current = await store.update(uid, (value) => {
      value = withDefaults(value, uid);
      if (requestedEnabled) {
        const setupChanged =
          value.sourceChannel?.id !== current.sourceChannel?.id ||
          value.clipsChannel?.id !== current.clipsChannel?.id ||
          value.zernioProfiles.clips !== current.zernioProfiles.clips;
        if (setupChanged || sameYoutubeChannel(value.sourceChannel, value.clipsChannel)) {
          throw new YoutubeAutomationError("The channel setup changed. Review both channels and try again.", {
            status: 409,
            code: "channel_setup_changed",
          });
        }
      }
      const actuallyTurningOn = requestedEnabled && !value.enabled;
      value.settings = settings;
      value.certifications = certifications;
      value.enabled = requestedEnabled;
      value.status = requestedEnabled
        ? "watching"
        : value.sourceChannel && value.clipsChannel
          ? "paused"
          : "setup";
      value.lastError = null;
      if (actuallyTurningOn) {
        value.enabledAt = activationCutoff;
        for (const entry of baselineEntries) {
          if (entry.publishedAt >= activationCutoff) continue;
          if (value.events[entry.videoId]) continue;
          value.events[entry.videoId] = {
            status: "baseline",
            sourceVideoId: entry.videoId,
            sourceTitle: entry.title,
            sourceUrl: entry.url,
            publishedAt: entry.publishedAt,
            updatedAt: now(),
          };
        }
      }
      addActivity(value, requestedEnabled
        ? { type: "automation", status: "success", message: `Ravi is watching ${value.sourceChannel.title}.` }
        : { type: "automation", status: "paused", message: "Ravi was paused." }, now());
      pruneEvents(value);
      return value;
    });
    return publicStatus(current, config);
  }

  async function claimEntry(record, entry) {
    let claimedSettings = null;
    await store.update(record.uid, (value) => {
      value = withDefaults(value, record.uid);
      if (!value.enabled || value.sourceChannel?.id !== entry.channelId) return value;
      const existing = value.events[entry.videoId];
      const interruptedWorker =
        existing &&
        ["queued", "processing"].includes(existing.status) &&
        existing.workerId !== workerId;
      if (existing && !["pending", "retry"].includes(existing.status) && !interruptedWorker) {
        return value;
      }
      if (existing?.nextAttemptAt > now()) return value;
      value.events[entry.videoId] = {
        ...existing,
        status: "queued",
        workerId,
        sourceVideoId: entry.videoId,
        sourceTitle: entry.title,
        sourceUrl: entry.url,
        publishedAt: entry.publishedAt,
        settings: existing?.settings || { ...value.settings },
        claimedAt: now(),
        updatedAt: now(),
      };
      value.lastDetectedVideo = {
        id: entry.videoId,
        title: entry.title,
        url: entry.url,
        publishedAt: entry.publishedAt,
        detectedAt: now(),
      };
      addActivity(value, {
        type: "detection",
        status: "processing",
        message: `New upload detected: ${entry.title}`,
        sourceVideoId: entry.videoId,
        sourceTitle: entry.title,
      }, now());
      claimedSettings = { ...value.events[entry.videoId].settings };
      return value;
    });
    return claimedSettings;
  }

  async function processEntries(record, entries) {
    const eligible = entries
      .filter((entry) => entry.channelId === record.sourceChannel?.id)
      .filter((entry) => entry.publishedAt >= (record.enabledAt || now()))
      .sort((left, right) => left.publishedAt - right.publishedAt);

    for (const entry of eligible) {
      const eventSettings = await claimEntry(record, entry);
      if (!eventSettings) continue;
      try {
        const jobId = await enqueueJob({
          uid: record.uid,
          youtubeUrl: entry.url,
          settings: eventSettings,
          trigger: "channel",
          sourceVideoId: entry.videoId,
          sourceTitle: entry.title,
          sourcePublishedAt: entry.publishedAt,
        });
        await store.update(record.uid, (value) => {
          value = withDefaults(value, record.uid);
          const event = value.events[entry.videoId];
          if (event) {
            event.status = "processing";
            event.jobId = jobId;
            event.workerId = workerId;
            event.updatedAt = now();
          }
          return value;
        });
      } catch (error) {
        await store.update(record.uid, (value) => {
          value = withDefaults(value, record.uid);
          const event = value.events[entry.videoId];
          if (event) {
            const attempts = (event.attempts || 0) + 1;
            const willRetry = error?.status === 429 || attempts < MAX_AUTOMATION_ATTEMPTS;
            event.status = error?.status === 429 ? "pending" : willRetry ? "retry" : "failed";
            event.error = cleanMessage(error, "Ravi could not start clipping this upload.");
            event.attempts = attempts;
            event.nextAttemptAt = willRetry ? now() + retryDelay(attempts) : null;
            event.updatedAt = now();
          }
          value.lastError = cleanMessage(error);
          addActivity(value, {
            type: "processing",
            status: "error",
            message: value.lastError,
            sourceVideoId: entry.videoId,
            sourceTitle: entry.title,
          }, now());
          return value;
        });
      }
    }
  }

  function connectionWasRevoked(error) {
    return [
      "ACCOUNT_DISCONNECTED",
      "ACCOUNT_RECONNECT_REQUIRED",
      "account_needs_reconnection",
      "zernio_account_disconnected",
    ].includes(error?.code);
  }

  async function doPollUser(uid, { force = false } = {}) {
    requireConfigured();
    let record = await getRecord(uid);
    if (!record.enabled || !record.sourceChannel) return publicStatus(record, config);
    if (!force && record.lastCheckedAt && now() - record.lastCheckedAt < config.pollIntervalMs) {
      return publicStatus(record, config);
    }
    try {
      const entries = await fetchSourceEntries(record);
      await store.update(uid, (value) => {
        value = withDefaults(value, uid);
        value.lastCheckedAt = now();
        value.status = "watching";
        value.lastError = null;
        return value;
      });
      record = await getRecord(uid);
      await processEntries(record, entries);
    } catch (error) {
      await store.update(uid, (value) => {
        value = withDefaults(value, uid);
        value.lastCheckedAt = now();
        value.status = "error";
        value.lastError = "Ravi could not check the main channel. It will try again automatically.";
        return value;
      });
    }
    return status(uid);
  }

  function pollUser(uid, options = {}) {
    if (polls.has(uid)) return polls.get(uid);
    const operation = doPollUser(uid, options).finally(() => {
      if (polls.get(uid) === operation) polls.delete(uid);
    });
    polls.set(uid, operation);
    return operation;
  }

  async function reconcilePublications(record) {
    for (const [sourceVideoId, rawEvent] of Object.entries(record.events || {})) {
      if (!["publishing", "posting_error"].includes(rawEvent?.status)) continue;
      const updates = [];
      let failedMessage = null;
      for (const [clipKey, rawPublication] of Object.entries(rawEvent.uploads || {})) {
        if (rawPublication.youtubeUrl || !rawPublication.zernioPostId) continue;
        try {
          const response = await zernio.getPost(rawPublication.zernioPostId);
          const publication = publicationFromPost(
            postFromResponse(response),
            Number(clipKey),
            rawPublication.privacyStatus
          );
          updates.push(publication);
          if (publication.status === "failed") {
            failedMessage = "Zernio could not publish one of the clips to YouTube.";
          }
        } catch (error) {
          if (!error?.retryable) failedMessage = cleanMessage(error, "A clip could not be published.");
        }
      }
      const nextRecord = await store.update(record.uid, (value) => {
        value = withDefaults(value, record.uid);
        const event = value.events[sourceVideoId];
        if (!event || !["publishing", "posting_error"].includes(event.status)) return value;
        const preservePostingError = event.status === "posting_error";
        event.uploads ||= {};
        for (const publication of updates) {
          event.uploads[String(publication.clipIndex)] = {
            ...event.uploads[String(publication.clipIndex)],
            ...publication,
          };
        }
        const publications = Object.values(event.uploads);
        const expectedClipCount = Number(event.expectedClipCount);
        const hasExpectedClipCount = Number.isSafeInteger(expectedClipCount) && expectedClipCount > 0;
        const allPublished =
          hasExpectedClipCount &&
          publications.length === expectedClipCount &&
          publications.every((item) => item.youtubeUrl);
        const allSubmitted =
          hasExpectedClipCount &&
          publications.length === expectedClipCount &&
          publications.every((item) => item.youtubeUrl || item.zernioPostId);
        const interruptedPublisher = event.publishingWorkerId !== workerId;
        if (preservePostingError) {
          // A later clip may have failed permanently after earlier clips were
          // accepted. Keep the overall error, but continue collecting final
          // YouTube URLs for every accepted Zernio post.
          if (!event.error && failedMessage) event.error = failedMessage;
          value.lastError ||= event.error || failedMessage;
        } else if (failedMessage) {
          event.status = "posting_error";
          event.error = failedMessage;
          value.lastError = failedMessage;
        } else if (allPublished) {
          event.status = "done";
          event.completedAt = now();
          event.error = null;
          value.lastPublishedAt = now();
          value.lastError = null;
          addActivity(value, {
            type: "publishing",
            status: "success",
            message: `Posted ${publications.length} clip${publications.length === 1 ? "" : "s"} to ${value.clipsChannel?.title || "the clips channel"}.`,
            jobId: event.jobId,
            sourceVideoId,
            sourceTitle: event.sourceTitle,
            publishedUrls: publications.map((item) => item.youtubeUrl).filter(Boolean),
          }, now());
        } else if (interruptedPublisher && !allSubmitted) {
          // The prior process stopped before every clip was submitted. Requeue
          // the source job; persisted media/post IDs and deterministic request
          // IDs make the publishing phase safe to resume without duplicates.
          event.status = "retry";
          event.nextAttemptAt = now();
          event.error = null;
          event.publishingWorkerId = null;
          value.status = value.enabled ? "watching" : "paused";
        } else if (interruptedPublisher) {
          // Every clip reached Zernio, so this process only needs to keep
          // reconciling the submitted post IDs.
          event.publishingWorkerId = workerId;
        }
        event.updatedAt = now();
        return value;
      });
      const updatedEvent = nextRecord.events[sourceVideoId];
      if (!updatedEvent || (
        !updates.length &&
        !failedMessage &&
        updatedEvent.status !== "done"
      )) continue;
      await onPublicationUpdate({
        jobId: updatedEvent?.jobId,
        publications: Object.values(updatedEvent?.uploads || {}),
        status: updatedEvent?.status,
        error: updatedEvent?.error || null,
      }).catch(() => {});
    }
  }

  function pollAll() {
    if (pollAllPromise) return pollAllPromise;
    pollAllPromise = (async () => {
      if (!config.configured) return;
      const records = (await store.list()).map((record) => withDefaults(record, record.uid));
      await Promise.allSettled(records.map((record) => reconcilePublications(record)));
      await Promise.allSettled(
        records.filter((record) => record.enabled).map((record) => pollUser(record.uid))
      );
    })().finally(() => {
      pollAllPromise = null;
    });
    return pollAllPromise;
  }

  async function publishJob({ uid, job, jobDir, onProgress, signal }) {
    requireConfigured();
    let record = await getRecord(uid);
    if (!record.enabled || !record.clipsChannel) {
      throw new YoutubeAutomationError("Ravi was paused before these clips were posted.", {
        status: 409,
        code: "automation_paused",
      });
    }
    const destinationId = record.clipsChannel.id;
    const publicationSettings = {
      ...record.settings,
      ...(record.events[job.sourceVideoId]?.settings || {}),
    };
    const clips = [...(job.clips || [])].sort((left, right) => left.index - right.index);
    if (!clips.length) {
      throw new YoutubeAutomationError("Ravi did not create any clips to publish.", {
        status: 422,
        code: "no_clips_to_publish",
      });
    }
    const publications = [];
    const privacyStatus = publicationSettings.privacyStatus;

    record = await store.update(uid, (value) => {
      value = withDefaults(value, uid);
      const nextEvent = value.events[job.sourceVideoId] || {
        sourceVideoId: job.sourceVideoId,
        sourceTitle: job.sourceTitle,
      };
      nextEvent.uploads ||= {};
      nextEvent.expectedClipCount = clips.length;
      nextEvent.publishingWorkerId = workerId;
      nextEvent.status = "publishing";
      nextEvent.jobId = job.id;
      nextEvent.error = null;
      nextEvent.nextAttemptAt = null;
      nextEvent.updatedAt = now();
      value.events[job.sourceVideoId] = nextEvent;
      return value;
    });
    const existingUploads = record.events[job.sourceVideoId]?.uploads || {};

    try {
      for (let index = 0; index < clips.length; index += 1) {
        signal?.throwIfAborted();
        record = await getRecord(uid);
        if (!record.enabled || record.clipsChannel?.id !== destinationId) {
          throw new YoutubeAutomationError("Ravi was paused or the clips channel changed before posting finished.", {
            status: 409,
            code: "automation_paused",
          });
        }
        const clip = clips[index];
        const uploadKey = String(clip.index);
        const already = existingUploads[uploadKey] || null;
        if (already?.youtubeUrl || already?.zernioPostId) {
          publications.push(already);
          continue;
        }
        onProgress?.(`Uploading ${clips.length} clip${clips.length === 1 ? "" : "s"} (${index + 1} of ${clips.length})`);
        const filePath = path.join(jobDir, "clips", `clip_${clip.index}.mp4`);
        let mediaUrl = already?.mediaUrl || null;
        if (!mediaUrl) {
          const presigned = await zernio.createMediaPresign(
            `ravi-${job.sourceVideoId}-clip-${clip.index}.mp4`
          );
          await zernio.uploadFile(presigned.uploadUrl, filePath, signal);
          mediaUrl = presigned.publicUrl;
          const uploadedMedia = {
            ...(already || {}),
            clipIndex: clip.index,
            mediaUrl,
            privacyStatus,
            status: "media_uploaded",
          };
          existingUploads[uploadKey] = uploadedMedia;
          await store.update(uid, (value) => {
            value = withDefaults(value, uid);
            const nextEvent = value.events[job.sourceVideoId] || {
              sourceVideoId: job.sourceVideoId,
              sourceTitle: job.sourceTitle,
            };
            nextEvent.uploads ||= {};
            nextEvent.uploads[uploadKey] = uploadedMedia;
            nextEvent.expectedClipCount = clips.length;
            nextEvent.publishingWorkerId = workerId;
            nextEvent.status = "publishing";
            nextEvent.jobId = job.id;
            nextEvent.updatedAt = now();
            value.events[job.sourceVideoId] = nextEvent;
            return value;
          });
        }
        const requestId = stableUuid(`ravi-post:${uid}:${job.sourceVideoId}:${clip.index}`);
        // One request covers every destination: Zernio's platforms array fans
        // a single post out, so the idempotency key stays per clip rather than
        // per clip per platform.
        const postDestinations = [
          { platform: "youtube", accountId: destinationId },
          ...record.destinations,
        ];
        let response;
        try {
          response = await zernio.createClipPost({
            destinations: postDestinations,
            mediaUrl,
            title: String(clip.title || `Clip ${clip.index}`),
            platformOptions: {
              youtube: {
                // YouTube's body is a description, not a caption, so it keeps
                // the attribution and source link the social captions omit.
                content: `Created by Ravi from "${job.sourceTitle || job.sourceTitleHint || "a main-channel upload"}".\n\nOriginal video: https://www.youtube.com/watch?v=${job.sourceVideoId}`,
                visibility: privacyStatus,
                madeForKids: publicationSettings.madeForKids,
                // Ravi reframes and captions existing footage; it does not
                // synthesise it. Stated rather than left to a default.
                containsSyntheticMedia: false,
              },
            },
            requestId,
            signal,
          });
        } catch (error) {
          const existingPostId = error?.details?.existingPostId;
          if (error?.status !== 409 || !existingPostId) throw error;
          response = await zernio.getPost(existingPostId);
        }
        const publication = publicationFromPost(
          postFromResponse(response),
          clip.index,
          privacyStatus
        );
        if (!publication.zernioPostId) {
          throw new YoutubeAutomationError("Zernio accepted a clip without returning its post ID.", {
            status: 502,
            code: "zernio_post_missing",
          });
        }
        const persistedPublication = { ...existingUploads[uploadKey], ...publication, mediaUrl };
        existingUploads[uploadKey] = persistedPublication;
        publications.push(persistedPublication);
        await store.update(uid, (value) => {
          value = withDefaults(value, uid);
          const nextEvent = value.events[job.sourceVideoId] || {
            sourceVideoId: job.sourceVideoId,
            sourceTitle: job.sourceTitle,
          };
          nextEvent.uploads ||= {};
          nextEvent.uploads[uploadKey] = {
            ...nextEvent.uploads[uploadKey],
            ...persistedPublication,
          };
          nextEvent.expectedClipCount = clips.length;
          nextEvent.publishingWorkerId = workerId;
          nextEvent.status = "publishing";
          nextEvent.jobId = job.id;
          nextEvent.updatedAt = now();
          value.events[job.sourceVideoId] = nextEvent;
          return value;
        });
      }

      const complete =
        publications.length === clips.length &&
        publications.every((item) => item.youtubeUrl);
      record = await store.update(uid, (value) => {
        value = withDefaults(value, uid);
        const nextEvent = value.events[job.sourceVideoId] || {
          sourceVideoId: job.sourceVideoId,
          sourceTitle: job.sourceTitle,
        };
        nextEvent.status = complete ? "done" : "publishing";
        nextEvent.expectedClipCount = clips.length;
        nextEvent.publishingWorkerId = workerId;
        nextEvent.completedAt = complete ? now() : null;
        nextEvent.updatedAt = now();
        nextEvent.error = null;
        nextEvent.nextAttemptAt = null;
        nextEvent.jobId = job.id;
        value.events[job.sourceVideoId] = nextEvent;
        if (complete) value.lastPublishedAt = now();
        value.status = value.enabled ? "watching" : "paused";
        value.lastError = null;
        addActivity(value, {
          type: "publishing",
          status: complete ? "success" : "processing",
          message: complete
            ? `Posted ${publications.length} clip${publications.length === 1 ? "" : "s"} to ${value.clipsChannel?.title || "the clips channel"}.`
            : `Sent ${publications.length} clip${publications.length === 1 ? "" : "s"} to Zernio for publishing.`,
          jobId: job.id,
          sourceVideoId: job.sourceVideoId,
          sourceTitle: job.sourceTitle,
          publishedUrls: publications.map((item) => item.youtubeUrl).filter(Boolean),
        }, now());
        pruneEvents(value);
        return value;
      });
      await onPublicationUpdate({
        jobId: job.id,
        publications,
        status: complete ? "done" : "publishing",
        error: null,
      }).catch(() => {});
      return { published: publications, privacyStatus, complete, status: publicStatus(record, config) };
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "zernio_request_aborted") throw error;
      const partialPublications = [];
      await store.update(uid, (value) => {
        value = withDefaults(value, uid);
        const nextEvent = value.events[job.sourceVideoId] || {
          sourceVideoId: job.sourceVideoId,
          sourceTitle: job.sourceTitle,
        };
        nextEvent.uploads ||= {};
        partialPublications.push(...Object.values(nextEvent.uploads));
        const postAttempts = (nextEvent.postAttempts || 0) + 1;
        const willRetry =
          error?.code !== "upload_reconcile_required" &&
          Boolean(error?.retryable) &&
          postAttempts < MAX_AUTOMATION_ATTEMPTS;
        nextEvent.status = error?.code === "upload_reconcile_required"
          ? "reconcile_required"
          : willRetry
            ? "retry"
            : "posting_error";
        nextEvent.error = cleanMessage(error, "Zernio could not post every clip to YouTube.");
        nextEvent.postAttempts = postAttempts;
        nextEvent.nextAttemptAt = willRetry ? now() + retryDelay(postAttempts) : null;
        nextEvent.updatedAt = now();
        value.events[job.sourceVideoId] = nextEvent;
        if (connectionWasRevoked(error) && value.clipsChannel) {
          value.clipsChannel.needsReauth = true;
          value.enabled = false;
          value.status = "reauth_required";
        } else {
          value.status = "error";
        }
        value.lastError = nextEvent.error;
        addActivity(value, {
          type: "publishing",
          status: "error",
          message: nextEvent.error,
          jobId: job.id,
          sourceVideoId: job.sourceVideoId,
          sourceTitle: job.sourceTitle,
          publishedUrls: partialPublications.map((item) => item.youtubeUrl).filter(Boolean),
        }, now());
        return value;
      });
      await onPublicationUpdate({
        jobId: job.id,
        publications: partialPublications,
        status: "posting_error",
        error: cleanMessage(error),
      }).catch(() => {});
      throw error;
    }
  }

  async function markJobFailed(job, error) {
    if (!job?.sourceVideoId || !job?.uid) return;
    await store.update(job.uid, (value) => {
      value = withDefaults(value, job.uid);
      const event = value.events[job.sourceVideoId] || {
        sourceVideoId: job.sourceVideoId,
        sourceTitle: job.sourceTitle,
      };
      const attempts = (event.attempts || 0) + 1;
      const willRetry = attempts < MAX_AUTOMATION_ATTEMPTS;
      event.status = willRetry ? "retry" : "failed";
      event.error = cleanMessage(error, "Ravi could not create clips from this upload.");
      event.attempts = attempts;
      event.nextAttemptAt = willRetry ? now() + retryDelay(attempts) : null;
      event.updatedAt = now();
      value.events[job.sourceVideoId] = event;
      value.lastError = event.error;
      addActivity(value, {
        type: "processing",
        status: "error",
        message: event.error,
        jobId: job.id,
        sourceVideoId: job.sourceVideoId,
        sourceTitle: job.sourceTitle,
      }, now());
      return value;
    });
  }

  async function markJobCancelled(job) {
    if (!job?.sourceVideoId || !job?.uid) return;
    await store.update(job.uid, (value) => {
      value = withDefaults(value, job.uid);
      const event = value.events[job.sourceVideoId] || { sourceVideoId: job.sourceVideoId };
      event.status = "cancelled";
      event.error = "This clip set was cancelled.";
      event.nextAttemptAt = null;
      event.updatedAt = now();
      value.events[job.sourceVideoId] = event;
      addActivity(value, {
        type: "processing",
        status: "paused",
        message: event.error,
        jobId: job.id,
        sourceVideoId: job.sourceVideoId,
        sourceTitle: job.sourceTitle,
      }, now());
      return value;
    });
  }

  /**
   * Removes one extra destination. Separate from disconnect(), which owns the
   * main and clips channels and tears down automation state with them —
   * dropping TikTok must not pause the whole pipeline.
   */
  async function disconnectDestination(uid, platform) {
    requireConfigured();
    const normalizedPlatform = String(platform || "");
    if (!isSupportedPlatform(normalizedPlatform) || normalizedPlatform === "youtube") {
      throw new YoutubeAutomationError("Choose a connected destination to remove.", {
        status: 400,
        code: "invalid_destination",
      });
    }
    const next = await store.update(uid, async (value) => {
      value = withDefaults(value, uid);
      const removed = value.destinations.find((entry) => entry.platform === normalizedPlatform);
      if (!removed) {
        throw new YoutubeAutomationError("That destination is not connected.", {
          status: 404,
          code: "destination_not_found",
        });
      }
      try {
        await zernio.disconnectAccount(removed.accountId);
      } catch (error) {
        // Already gone on Zernio's side is the desired end state.
        if (error?.status !== 404) throw error;
      }
      value.destinations = value.destinations.filter(
        (entry) => entry.platform !== normalizedPlatform
      );
      addActivity(value, {
        type: "connection",
        status: "paused",
        message: `Disconnected ${PLATFORMS[normalizedPlatform].label}.`,
      }, now());
      return value;
    });
    return publicStatus(next, config);
  }

  async function disconnect(uid, role) {
    requireConfigured();
    if (!CHANNEL_ROLES.has(role)) {
      throw new YoutubeAutomationError("Choose the main or clips channel to disconnect.", {
        status: 400,
        code: "invalid_channel_role",
      });
    }
    const key = role === "main" ? "sourceChannel" : "clipsChannel";
    const next = await store.update(uid, async (value) => {
      value = withDefaults(value, uid);
      const removed = value[key];
      const pending = value.pendingConnectionCleanup[role];
      const accountIds = [...new Set([
        removed?.provider === "public" ? null : removed?.id,
        pending?.accountId,
      ].filter(Boolean))];
      for (const accountIdToRemove of accountIds) {
        try {
          await zernio.disconnectAccount(accountIdToRemove);
        } catch (error) {
          if (error?.status !== 404) throw error;
        }
      }
      value[key] = null;
      value.pendingConnectionCleanup[role] = null;
      value.enabled = false;
      value.status = "setup";
      value.lastError = null;
      if (role === "main") {
        value.enabledAt = null;
        value.events = {};
        value.lastDetectedVideo = null;
        value.lastCheckedAt = null;
      }
      addActivity(value, {
        type: "connection",
        status: "paused",
        message: `Disconnected the ${role} channel.`,
      }, now());
      return value;
    });
    return publicStatus(next, config);
  }

  function start() {
    if (!config.configured || pollTimer) return;
    pollTimer = setIntervalFn(() => {
      pollAll().catch((error) => logger.error("Ravi channel watcher failed:", error));
    }, Math.min(60_000, config.pollIntervalMs));
    pollTimer.unref?.();
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      pollAll().catch(() => {});
    }, 2_000);
    bootstrapTimer.unref?.();
  }

  function stop() {
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
    if (bootstrapTimer) clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
  }

  function oauthSuccessRedirect(role) {
    const url = new URL(config.appUrl);
    url.searchParams.set("youtube", "connected");
    if (role === "clips") url.searchParams.set("role", role);
    return url.toString();
  }

  function oauthErrorRedirect(error) {
    const url = new URL(config.appUrl);
    url.searchParams.set("youtube", "error");
    url.searchParams.set("message", cleanMessage(error, error?.message).slice(0, 180));
    return url.toString();
  }

  return {
    config,
    status,
    startOauth,
    completeOauth,
    setSourceChannel,
    update,
    disconnect,
    disconnectDestination,
    pollUser,
    pollAll,
    publishJob,
    markJobFailed,
    markJobCancelled,
    start,
    stop,
    oauthSuccessRedirect,
    oauthErrorRedirect,
  };
}
