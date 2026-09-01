import { createHash, timingSafeEqual } from "node:crypto";

// The /beta page hands strangers a button that spends real money: every run
// pulls the complete source video through the metered residential proxy and
// burns Groq transcription minutes. A shared code is the only thing between
// that button and an open clip farm, and shared codes leak — testers paste
// them into group chats. So the guards here assume the code is already public
// and bound the damage anyway:
//
//   - a hard daily run cap, which is the number that actually limits spend;
//   - a per-client cooldown, which slows a single abuser but is best-effort
//     because the client key comes from a spoofable header (see clientKey).
//
// Only the daily cap is trustworthy. The cooldown is a speed bump.

const DAY_MS = 24 * 60 * 60 * 1000;
// Short codes are guessable, and this endpoint spends money on every success.
// A code below this length is refused rather than quietly accepted.
const MIN_CODE_LENGTH = 8;
// Deliberately low. Each run pulls a whole episode through the metered
// residential proxy, so this is a spend limit before it is a rate limit.
const DEFAULT_MAX_JOBS_PER_DAY = 8;
const DEFAULT_COOLDOWN_MS = 120_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadBetaAccessConfig(environment = process.env) {
  const code = String(environment.BETA_ACCESS_CODE || "").trim();
  const present = code.length > 0;
  const tooShort = present && code.length < MIN_CODE_LENGTH;
  return {
    // Absent or too-short codes both leave the page switched off. Failing
    // closed is the only safe default for a route that costs money.
    enabled: present && !tooShort,
    tooShort,
    code,
    maxJobsPerDay: positiveInteger(environment.BETA_MAX_JOBS_PER_DAY, DEFAULT_MAX_JOBS_PER_DAY),
    cooldownMs: positiveInteger(environment.BETA_IP_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
  };
}

/**
 * Compares two secrets without leaking their relationship through timing.
 * Both sides are hashed first so that unequal lengths compare in constant
 * time too — timingSafeEqual throws on a length mismatch, which would itself
 * be an oracle for the code's length.
 */
export function constantTimeEquals(a, b) {
  const left = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const right = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Best-effort caller identity for the cooldown.
 *
 * Railway terminates TLS ahead of this process, so the socket address is the
 * platform's, not the visitor's, and the real address only exists in
 * X-Forwarded-For. That header is attacker-controlled, so this key is
 * deliberately NOT used for anything that must hold — it only spaces out
 * repeat runs. The daily cap is what actually bounds cost.
 */
export function clientKey(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req?.socket?.remoteAddress || "unknown";
}

export function createBetaAccess({ config, now = Date.now } = {}) {
  if (!config) throw new TypeError("Beta access requires a config.");

  const lastRunByClient = new Map();
  let windowStartedAt = now();
  let runsInWindow = 0;

  function rollWindow() {
    const current = now();
    if (current - windowStartedAt >= DAY_MS) {
      windowStartedAt = current;
      runsInWindow = 0;
    }
  }

  // Without this the map would grow one entry per unique (spoofable) header
  // value forever, which is itself a cheap way to exhaust memory.
  function pruneCooldowns() {
    const current = now();
    for (const [key, at] of lastRunByClient) {
      if (current - at >= config.cooldownMs) lastRunByClient.delete(key);
    }
  }

  /** Express middleware: rejects anything without the right code. */
  function requireCode(req, res, next) {
    if (!config.enabled) {
      return res.status(503).json({
        error: "The beta page is not open right now.",
        code: "beta_disabled",
      });
    }
    const supplied =
      req.get?.("x-beta-code") || req.headers?.["x-beta-code"] || req.body?.betaCode || "";
    if (!supplied || !constantTimeEquals(supplied, config.code)) {
      return res.status(403).json({
        error: "That beta code is not valid.",
        code: "invalid_beta_code",
      });
    }
    return next();
  }

  /**
   * Claims one run against the daily cap and the caller cooldown.
   * Call `release()` if the job could not actually be started, so a failed
   * enqueue does not consume a tester's slot.
   */
  function reserveRun(key) {
    rollWindow();
    if (runsInWindow >= config.maxJobsPerDay) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStartedAt + DAY_MS - now()) / 1000));
      return {
        ok: false,
        status: 429,
        code: "beta_daily_limit",
        message: "The beta has used up today's clip runs. Please try again tomorrow.",
        retryAfterSec,
      };
    }

    pruneCooldowns();
    const previous = lastRunByClient.get(key);
    if (previous != null && now() - previous < config.cooldownMs) {
      const retryAfterSec = Math.max(1, Math.ceil((previous + config.cooldownMs - now()) / 1000));
      return {
        ok: false,
        status: 429,
        code: "beta_cooldown",
        message: `Please wait ${retryAfterSec}s before starting another clip run.`,
        retryAfterSec,
      };
    }

    runsInWindow += 1;
    lastRunByClient.set(key, now());
    return {
      ok: true,
      release() {
        runsInWindow = Math.max(0, runsInWindow - 1);
        lastRunByClient.delete(key);
      },
    };
  }

  /** Non-secret summary for /api/health. Never includes the code itself. */
  function status() {
    if (!config.enabled) return config.tooShort ? "code_too_short" : "disabled";
    rollWindow();
    return `enabled(${runsInWindow}/${config.maxJobsPerDay} today)`;
  }

  return { requireCode, reserveRun, status, config };
}

// Pipeline errors are written for operators and quote raw subprocess output —
// stack traces, binary names, proxy hosts. progress.js already keeps tool names
// out of the *stage* text shown to users, but nothing did the same for the
// failure message, so a beta tester saw "yt-dlp exited with code 1: Traceback
// ...". This maps failures to something a stranger can act on and, crucially,
// never falls through to the original string.
const BETA_ERROR_MESSAGES = [
  {
    match: /too many requests|rate ?limit|\b429\b/i,
    text: "YouTube is rate-limiting us at the moment. Please try again in a few minutes.",
  },
  {
    match: /private|members-only|unavailable|removed|age|sign in|confirm your age|not available in your country|geo/i,
    text: "That video can’t be downloaded. Private, members-only, age-restricted, and region-blocked videos won’t work.",
  },
  {
    match: /live|premiere/i,
    text: "Live streams and premieres can’t be clipped. Try a finished upload.",
  },
  {
    match: /duration|too long|exceeds the|\blimit\b|too large/i,
    text: "That video is too long or too large for the beta. Try a shorter episode.",
  },
  {
    match: /transcription returned no words|no speech|no audio/i,
    text: "We couldn’t find any speech in that video, so there was nothing to clip.",
  },
  {
    match: /clip selection|shorter than|timing issue/i,
    text: "We couldn’t pick good moments out of that episode. Please try another video.",
  },
  {
    match: /capacity|too many jobs/i,
    text: "The beta is busy right now. Please try again in a few minutes.",
  },
];

const GENERIC_BETA_ERROR =
  "Something went wrong while making your clips. Please try another video.";

/** Maps an internal pipeline error to a message that is safe to show publicly. */
export function betaFacingError(message) {
  const text = typeof message === "string" ? message : "";
  if (!text.trim()) return null;
  return BETA_ERROR_MESSAGES.find((entry) => entry.match.test(text))?.text || GENERIC_BETA_ERROR;
}

export const __testing = { DAY_MS, MIN_CODE_LENGTH, GENERIC_BETA_ERROR };
