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

async function authHeaders() {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function createJob({ youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode }) {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ youtubeUrl, numClips, clipLengthSec, subtitleColor, cropMode }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to create job");
  return data.jobId;
}

export async function getJob(jobId) {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, { headers: await authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to fetch job");
  return data;
}

export async function listJobs() {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, { headers: await authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to fetch job history");
  return data.jobs;
}