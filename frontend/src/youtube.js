const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

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
