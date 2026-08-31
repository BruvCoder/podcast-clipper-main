const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_CHANNEL_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const MAX_YOUTUBE_URL_LENGTH = 2_048;
const HANDLE_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}._\-·]*[\p{L}\p{M}\p{N}])?$/u;

function validId(value) {
  return value && VIDEO_ID_PATTERN.test(value) ? value : null;
}

export function extractYouTubeVideoId(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "youtu.be") {
      return validId(url.pathname.split("/").filter(Boolean)[0]);
    }

    if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) {
      return null;
    }

    if (url.pathname === "/watch") {
      return validId(url.searchParams.get("v"));
    }

    const pathMatch = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/);
    return validId(pathMatch?.[1]);
  } catch {
    return null;
  }
}

export function isValidYouTubeUrl(value) {
  return extractYouTubeVideoId(value) !== null;
}

function decodeChannelSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || /[\s\u0000-\u001f\u007f/?#@]/u.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function normalizeHandle(value) {
  const handle = String(value || "").normalize("NFC");
  const length = [...handle].length;
  if (length < 1 || length > 30 || !HANDLE_PATTERN.test(handle)) return null;
  return handle;
}

function canonicalChannelPath(pathname) {
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (!path || path.includes("//")) return null;

  const parts = path.split("/").slice(1);
  if (["videos", "featured", "shorts", "streams", "live"].includes(parts.at(-1)) && parts.length > 1) {
    parts.pop();
  }
  if (parts.length === 1 && parts[0].startsWith("@")) {
    const handle = normalizeHandle(decodeChannelSegment(parts[0].slice(1)));
    return handle
      ? `/@${encodeURIComponent(handle)}`
      : null;
  }

  if (parts.length !== 2) return null;
  const [kind, encodedIdentifier] = parts;
  const identifier = decodeChannelSegment(encodedIdentifier);
  if (!identifier) return null;

  if (kind === "channel") {
    return CHANNEL_ID_PATTERN.test(identifier) ? `/channel/${identifier}` : null;
  }

  if ((kind === "c" || kind === "user") && /^[A-Za-z0-9._-]{1,100}$/.test(identifier)) {
    return `/${kind}/${encodeURIComponent(identifier)}`;
  }

  return null;
}

/**
 * Returns a canonical public YouTube channel URL, or null when the value is
 * not a supported channel reference. A bare @handle is accepted for a
 * friendlier dashboard input.
 */
export function normalizeYouTubeChannelUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_YOUTUBE_URL_LENGTH) return null;

  if (raw.startsWith("@")) {
    const handle = normalizeHandle(decodeChannelSegment(raw.slice(1)));
    return handle
      ? `https://www.youtube.com/@${encodeURIComponent(handle)}`
      : null;
  }

  // Inspect the raw authority as URL normalizes an explicit default :443 or
  // :80 port away before exposing url.port.
  const authority = raw.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes("@") || authority.includes(":")) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (!YOUTUBE_CHANNEL_HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = canonicalChannelPath(url.pathname);
  return path ? `https://www.youtube.com${path}` : null;
}

export function isValidYouTubeChannelUrl(value) {
  return normalizeYouTubeChannelUrl(value) !== null;
}
