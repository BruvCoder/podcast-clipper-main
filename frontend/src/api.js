import { auth } from "./firebase.js";

// In local dev this stays empty and requests go through Vite's proxy
// (see vite.config.js). In production, set VITE_API_BASE_URL to the
// deployed backend's URL so the static frontend can reach it directly.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

// Clip URLs come back from the backend as paths like "/files/<id>/clips/clip_1.mp4".
// Those are relative to the backend's origin, not the frontend's, so in
// production (separate origins) they need the same base URL prefixed on.
export function resolveMediaUrl(url) {
  return url && !/^https?:\/\//.test(url) ? `${API_BASE_URL}${url}` : url;
}

async function authHeaders(forceRefresh = false) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken(forceRefresh) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJsonResponse(res, fallbackMessage) {
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Keep the fallback below useful when a proxy/server returns HTML or an
    // empty response instead of JSON.
  }
  if (!res.ok) {
    const error = new Error(data.error || fallbackMessage);
    error.status = res.status;
    error.code = data.code || null;
    error.details = data;
    throw error;
  }
  return data;
}

export async function createJob({ youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode }) {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode }),
  });
  const data = await readJsonResponse(res, "Failed to create job");
  return data.jobId;
}

export async function getJob(jobId) {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, { headers: await authHeaders() });
  return readJsonResponse(res, "Failed to fetch job");
}

export async function deleteJob(jobId) {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return readJsonResponse(res, "Failed to delete this clip");
}

export async function listJobs() {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, { headers: await authHeaders() });
  const data = await readJsonResponse(res, "Failed to fetch job history");
  return data.jobs;
}

export async function getYoutubeAutomation() {
  const res = await fetch(`${API_BASE_URL}/api/youtube/automation`, {
    headers: await authHeaders(),
    credentials: "include",
  });
  const data = await readJsonResponse(res, "Failed to load Ravi's YouTube setup");
  return data.automation ?? data;
}

export async function startYoutubeOAuth(role, platform = "youtube") {
  const res = await fetch(`${API_BASE_URL}/api/youtube/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify({ role, platform }),
  });
  const data = await readJsonResponse(res, `Failed to connect your ${role} channel`);
  if (!data.url) throw new Error("The channel connection did not return a URL");
  return data.url;
}

export async function disconnectDestination(platform) {
  const res = await fetch(`${API_BASE_URL}/api/youtube/destination/${platform}`, {
    method: "DELETE",
    headers: await authHeaders(),
    credentials: "include",
  });
  const data = await readJsonResponse(res, "Failed to disconnect that destination");
  return data.automation ?? data;
}

/**
 * Sends the file as the request body.
 *
 * XMLHttpRequest rather than fetch, because fetch cannot report upload
 * progress and these files run to hundreds of megabytes — without a progress
 * bar a long upload is indistinguishable from a hung one.
 */
export async function uploadVideo(file, { onProgress, signal } = {}) {
  const headers = await authHeaders();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/uploads`);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    // Header values must be Latin-1, so a filename with an accent or an emoji
    // would throw here. The server decodes it.
    xhr.setRequestHeader("X-Upload-Filename", encodeURIComponent(file.name || "video"));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // A proxy can return HTML; the fallback message below stays useful.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data.jobId);
        return;
      }
      const error = new Error(data.error || "Your video could not be uploaded");
      error.status = xhr.status;
      error.code = data.code || null;
      reject(error);
    };
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    xhr.onabort = () => {
      const error = new Error("Upload cancelled");
      error.code = "upload_cancelled";
      reject(error);
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export async function setYoutubeSourceChannel(url) {
  const res = await fetch(`${API_BASE_URL}/api/youtube/source-channel`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify({ url }),
  });
  const data = await readJsonResponse(res, "Ravi could not save that main channel");
  return data.automation ?? data;
}

export async function updateYoutubeAutomation(updates) {
  const res = await fetch(`${API_BASE_URL}/api/youtube/automation`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  const data = await readJsonResponse(res, "Failed to update Ravi's YouTube setup");
  return data.automation ?? data;
}

export async function disconnectYoutube(role) {
  const res = await fetch(`${API_BASE_URL}/api/youtube/connection/${role}`, {
    method: "DELETE",
    headers: await authHeaders(),
    credentials: "include",
  });
  const data = await readJsonResponse(res, `Failed to disconnect your ${role} channel`);
  return data.automation ?? data;
}

export async function checkYoutubeNow() {
  const res = await fetch(`${API_BASE_URL}/api/youtube/check-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify({}),
  });
  const data = await readJsonResponse(res, "Ravi could not check your channel right now");
  return data.automation ?? data;
}

export async function getBillingStatus({ forceRefresh = false } = {}) {
  const res = await fetch(`${API_BASE_URL}/api/billing/status`, {
    headers: await authHeaders(forceRefresh),
  });
  return readJsonResponse(res, "Failed to check your subscription");
}

export async function createBillingCheckout() {
  const res = await fetch(`${API_BASE_URL}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({}),
  });
  const data = await readJsonResponse(res, "Failed to start checkout");
  if (!data.url) throw new Error("Checkout did not return a redirect URL");
  return data.url;
}

export async function createBillingPortal() {
  const res = await fetch(`${API_BASE_URL}/api/billing/portal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({}),
  });
  const data = await readJsonResponse(res, "Failed to open billing settings");
  if (!data.url) throw new Error("Billing settings did not return a redirect URL");
  return data.url;
}
