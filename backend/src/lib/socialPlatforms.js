// The catalog of places a Ravi clip can be sent.
//
// Zernio brokers every platform through one API, so a new destination is a
// catalog entry here rather than an integration. What genuinely differs per
// platform is what a vertical clip needs in order to arrive intact: how long
// the caption may be, and which platform-specific fields are required.
//
// Only platforms that accept a short vertical video are listed. Zernio also
// covers messaging surfaces (Telegram, Discord, Slack, WhatsApp) and Google
// Business; those are deliberately out of scope for clip publishing, and
// adding one later is an entry in this object plus a test.

const ELLIPSIS = "…";

// Clips are captioned with their own short title, not a written-out post. One
// line under this length clears every platform's limit — X's 280 is the
// tightest — so fan-out never has to say different things in different places.
// It is 100 because that is also YouTube's title cap, letting the same string
// serve as the caption everywhere and as the video title.
export const SHORT_CAPTION_LIMIT = 100;

export const PLATFORMS = Object.freeze({
  youtube: {
    label: "YouTube",
    // The description. The title is separate and capped at 100 by YouTube.
    captionLimit: 5000,
    titleLimit: 100,
    needsTitle: true,
  },
  tiktok: {
    label: "TikTok",
    captionLimit: 2200,
    // privacyLevel must match what TikTok reports in creator_info, which is
    // per-creator, so it is left unset for Zernio to resolve.
    needsTitle: false,
  },
  instagram: {
    label: "Instagram",
    captionLimit: 2200,
    needsTitle: false,
    // A video with no contentType becomes a Reel, which is what a 9:16 clip
    // should be. Stories would need contentType: "story".
  },
  facebook: { label: "Facebook", captionLimit: 63206, needsTitle: false },
  twitter: {
    label: "X",
    // 280 including the ~24 characters X reserves for an attached media URL.
    captionLimit: 280,
    needsTitle: false,
  },
  linkedin: { label: "LinkedIn", captionLimit: 3000, needsTitle: false },
  threads: { label: "Threads", captionLimit: 500, needsTitle: false },
  bluesky: { label: "Bluesky", captionLimit: 300, needsTitle: false },
  pinterest: { label: "Pinterest", captionLimit: 500, needsTitle: true, titleLimit: 100 },
});

export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

export function isSupportedPlatform(platform) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, String(platform || ""));
}

/** Non-secret catalog for the frontend to render a connect list from. */
export function listPlatforms() {
  return PLATFORM_IDS.map((id) => ({
    id,
    label: PLATFORMS[id].label,
    captionLimit: PLATFORMS[id].captionLimit,
  }));
}

/**
 * Fits a caption to one platform's limit.
 *
 * Fan-out means one caption meets nine different limits, and X's 280 is far
 * below the others. Sending the full text would have the whole post rejected,
 * so it is trimmed at a word boundary rather than mid-word.
 */
export function captionForPlatform(platform, caption) {
  const text = String(caption ?? "").trim();
  const limit = PLATFORMS[platform]?.captionLimit;
  if (!limit || text.length <= limit) return text;

  const clipped = text.slice(0, limit - ELLIPSIS.length);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only honour the word boundary if it does not gut the caption.
  const body = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}${ELLIPSIS}`;
}

/**
 * Turns a clip's title into the caption used on every platform.
 *
 * Clip titles are written by the model that picks the moments, so they arrive
 * with the usual artefacts: wrapping quotes, stray newlines, doubled spaces.
 * Posting those verbatim looks careless, and a quoted caption reads as though
 * someone else said it.
 */
export function shortCaption(title) {
  const collapsed = String(title ?? "").replace(/\s+/g, " ").trim();
  // Strip matching quotes the model wrapped around the whole line, straight
  // and curly alike. Inner quotation is left alone.
  const unquoted = collapsed.replace(/^["'“”‘’«»]+/, "").replace(/["'“”‘’«»]+$/, "").trim();
  if (unquoted.length <= SHORT_CAPTION_LIMIT) return unquoted;

  const clipped = unquoted.slice(0, SHORT_CAPTION_LIMIT - ELLIPSIS.length);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > SHORT_CAPTION_LIMIT * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}${ELLIPSIS}`;
}

/** Fits a title to a platform's title limit, where it has one. */
export function titleForPlatform(platform, title) {
  const text = String(title ?? "").trim();
  const limit = PLATFORMS[platform]?.titleLimit;
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/**
 * Builds the `platforms` array for POST /v1/posts.
 *
 * Every target carries the same short title as its caption. captionForPlatform
 * stays in the path as a clamp: it should never fire for a title of this
 * length, but a platform limit is a hard failure, not a truncation, so it is
 * not left to chance.
 */
export function buildPlatformTargets({
  destinations = [],
  title = "",
  platformOptions = {},
} = {}) {
  const caption = shortCaption(title);
  const targets = [];
  for (const destination of destinations) {
    const platform = String(destination?.platform || "");
    const accountId = String(destination?.accountId || "");
    if (!isSupportedPlatform(platform) || !accountId) continue;

    const options = platformOptions[platform] || {};
    // YouTube's field is a description rather than a caption, so the caller
    // can supply a longer body there (attribution, source link) while every
    // social destination gets the short title.
    const body = options.content == null ? caption : String(options.content);

    const target = {
      platform,
      accountId,
      customContent: captionForPlatform(platform, body),
    };

    if (PLATFORMS[platform].needsTitle) {
      // Set explicitly rather than relying on YouTube's fallback to the first
      // line of the body, which would be the attribution sentence.
      target.platformSpecificData = { title: titleForPlatform(platform, caption) };
    }
    if (platform === "youtube") {
      target.platformSpecificData = {
        ...target.platformSpecificData,
        // Defaults only. A clip set to private must never be published public
        // because a default leaked through.
        visibility: options.visibility || "public",
        madeForKids: Boolean(options.madeForKids),
        // Sent explicitly rather than left to a remote default: YouTube treats
        // this as a disclosure, so the value should be ours, not Zernio's.
        containsSyntheticMedia: Boolean(options.containsSyntheticMedia),
      };
    }
    targets.push(target);
  }
  return targets;
}

export const __testing = { ELLIPSIS };
