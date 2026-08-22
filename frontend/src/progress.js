// The backend's `stage` strings are written for operators, not users: they name
// the tools involved ("Fetching video info with yt-dlp"), and a proxy retry
// even names the proxy vendor. This module is the single place that turns them
// into something a customer should see — a plain label and a percentage.
//
// Anything unrecognised falls back to a generic label rather than being shown
// verbatim, so a new backend stage can never leak an internal name into the UI
// by default.

const FALLBACK_LABEL = "Working…";

/** Ordered phases. `base`/`span` carve the 0-100 bar into weighted segments. */
const PHASES = [
  { match: /^queued/i, label: "Waiting to start", base: 0, span: 0 },
  { match: /fetching video info|reading video|video info/i, label: "Reading the video", base: 4, span: 4 },
  { match: /downloading source|downloading video/i, label: "Downloading video", base: 8, span: 37 },
  // A proxy/session retry is a normal hiccup; say so without naming anything.
  { match: /rotating|proxy session|retrying/i, label: "Reconnecting…", base: 8, span: 0 },
  { match: /transcrib/i, label: "Transcribing audio", base: 45, span: 22 },
  { match: /selecting|ranking|best moments/i, label: "Finding the best moments", base: 67, span: 8 },
  { match: /rendering/i, label: "Creating your clips", base: 75, span: 24 },
  { match: /^done/i, label: "Finished", base: 100, span: 0 },
  { match: /^failed/i, label: "Failed", base: 0, span: 0 },
];

/** Pulls "45.2%" out of a yt-dlp style progress line. */
function percentWithin(stage) {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(stage);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : null;
}

/** Pulls "(2 of 5)" out of the render stage. */
function ratioWithin(stage) {
  const m = /\((\d+)\s+of\s+(\d+)\)/i.exec(stage);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

/** Pulls the clip count so the label can say how many are being made. */
function clipCount(stage) {
  const m = /\((\d+)\s+of\s+(\d+)\)/i.exec(stage);
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * Maps a backend stage string to `{ label, percent }` for display.
 * `percent` is an integer 0-100.
 */
export function describeProgress(stage) {
  const text = typeof stage === "string" ? stage.trim() : "";
  if (!text) return { label: "Starting…", percent: 0 };

  const phase = PHASES.find((p) => p.match.test(text));
  if (!phase) return { label: FALLBACK_LABEL, percent: null };

  // Within a phase, use whatever sub-progress the stage carries.
  const fraction = percentWithin(text) ?? ratioWithin(text) ?? 0;
  const percent = Math.round(phase.base + phase.span * fraction);

  let label = phase.label;
  const count = clipCount(text);
  if (count && /rendering/i.test(text)) {
    label = `Creating your clips (${Math.min(count.done + 1, count.total)} of ${count.total})`;
  }

  return { label, percent: Math.min(100, Math.max(0, percent)) };
}
