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

export async function startYoutubeOAuth(role) {
  const res = await fetch(`${API_BASE_URL}/api/youtube/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify({ role }),
  });
  const data = await readJsonResponse(res, `Failed to connect your ${role} channel through Zernio`);
  if (!data.url) throw new Error("Zernio did not return a connection URL");
  return data.url;
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
