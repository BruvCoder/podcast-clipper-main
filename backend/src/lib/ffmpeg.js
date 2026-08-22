import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { findCropCentre, cropOffsetX, cropWindow } from "./faceCrop.js";

// ffmpeg/libx264 auto-detect thread count from the host's reported CPU count,
// which in a container can be the physical host's full core count rather
// than the container's actual cgroup-limited share — leading to wildly
// over-threaded encodes that spike memory and get OOM-killed. Cap explicitly.
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || "2";

// Bound each render well below the job's overall timeout. A single short
// local-source clip has no legitimate reason to take this long.
const FFMPEG_RENDER_TIMEOUT_MS =
  Number.parseInt(process.env.FFMPEG_RENDER_TIMEOUT_MS, 10) || 5 * 60_000;
const FFPROBE_TIMEOUT_MS = Number.parseInt(process.env.FFPROBE_TIMEOUT_MS, 10) || 30_000;

function abortReason(signal, fallback = "Media processing was cancelled.") {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

function killProcessTree(proc) {
  if (!proc.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // It may have exited between the state check and kill.
    }
  }
}

function run(cmd, args, { signal, timeoutMs = FFMPEG_RENDER_TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: process.platform !== "win32" });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(proc);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, timeoutMs);
    timer.unref?.();

    proc.stderr.on("data", (d) => {
      stderr = `${stderr}${d}`.slice(-4000);
    });
    proc.on("error", (err) => {
      finish(reject, new Error(`Failed to start ${cmd}. Is it installed? (${err.message})`));
    });
    proc.on("close", (code) => {
      if (aborted) {
        finish(reject, abortReason(signal));
      } else if (timedOut) {
        finish(reject, new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
      } else if (code !== 0) {
        finish(reject, new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`));
      } else {
        finish(resolve);
      }
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Cuts a segment [startSec, endSec) from the source, reframes to 9:16, and
 * burns in styled ASS subtitles — all in a single ffmpeg pass.
 *
 * yt-dlp has already downloaded and merged the source locally. FFmpeg seeks
 * into that one file, then reframes and subtitles only this clip's window.
 */
export async function createClip(
  sourcePath,
  words,
  startSec,
  endSec,
  outPath,
  { cropMode = "pad", subtitleColor = "#FFFFFF", signal } = {}
) {
  signal?.throwIfAborted();
  const duration = Math.max(0.5, endSec - startSec);
  const assPath = outPath.replace(/\.mp4$/, ".ass");
  // The public file route only accepts clip_N.mp4. Render and validate under
  // a non-public name, then publish with one atomic rename so a failed or
  // interrupted ffmpeg process can never leave a corrupt downloadable clip.
  const temporaryOutPath = outPath.replace(/\.mp4$/, ".partial.mp4");
  await Promise.all([
    fs.promises.rm(outPath, { force: true }),
    fs.promises.rm(temporaryOutPath, { force: true }),
  ]);
  buildAssSubtitles(words, startSec, endSec, assPath, subtitleColor);
  const escapedAssPath = escapeForFilterPath(assPath);

  let vf;
  if (cropMode === "crop") {
    // A 9:16 window over a 16:9 frame is much narrower than the source, so
    // *where* it sits matters more than anything else about this mode. Look for
    // the speaker and centre on them; findCropCentre returns null whenever it
    // cannot tell, and then this falls back to the old centre crop.
    const detected = await findCropCentre(sourcePath, startSec, endSec, { signal });
    signal?.throwIfAborted();

    // Default expression keeps ffmpeg's own centring when nothing was detected.
    let cropExpr = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'";
    if (detected) {
      const { centreX, frameWidth, frameHeight } = detected;
      const { width, height } = cropWindow(frameWidth, frameHeight);
      const x = cropOffsetX(centreX, frameWidth, width);
      const y = Math.max(0, Math.round((frameHeight - height) / 2));
      cropExpr = `crop=${width}:${height}:${x}:${y}`;
    }
    vf = `${cropExpr},scale=1080:1920,ass='${escapedAssPath}'`;
  } else if (cropMode === "pad") {
    // Default: scales the full frame to fit (nothing cropped out), and fills
    // the empty top/bottom bars with a blurred, zoomed copy of the same
    // footage so the padding looks intentional instead of dead black space.
    // Safe for multi-person shots, slides, or anything with content near the edges.
    vf =
      "split[bg][fg];" +
      "[bg]scale=270:480:force_original_aspect_ratio=increase," +
      "crop=270:480,gblur=sigma=8,scale=1080:1920[bgblur];" +
      "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgscaled];" +
      `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,ass='${escapedAssPath}'`;
  } else {
    throw new Error(`Unknown cropMode: ${cropMode} (expected "pad" or "crop")`);
  }

  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        sourcePath,
        "-t",
        String(duration),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-threads",
        FFMPEG_THREADS,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        temporaryOutPath,
      ],
      { signal }
    );

    signal?.throwIfAborted();
    await assertRenderedClip(temporaryOutPath, duration, signal);
    signal?.throwIfAborted();
    await fs.promises.rename(temporaryOutPath, outPath);
    return outPath;
  } finally {
    await Promise.all([
      fs.promises.rm(assPath, { force: true }).catch(() => {}),
      fs.promises.rm(temporaryOutPath, { force: true }).catch(() => {}),
    ]);
  }
}

/** Reads a rendered file's stream types and duration via ffprobe. */
function probeRendered(filePath, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", filePath],
      { detached: process.platform !== "win32" }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(proc);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, FFPROBE_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => finish(reject, new Error(`Failed to start ffprobe: ${err.message}`)));
    proc.on("close", (code) => {
      if (aborted) return finish(reject, abortReason(signal));
      if (timedOut) return finish(reject, new Error("ffprobe timed out reading the rendered clip."));
      if (code !== 0) {
        return finish(reject, new Error(`ffprobe failed on the rendered clip: ${stderr.trim().slice(-300)}`));
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch (err) {
        finish(reject, new Error(`ffprobe returned invalid JSON for the rendered clip: ${err.message}`));
      }
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * ffmpeg can exit 0 having written a clip with no video in it — that is what
 * a truncated read from the video source produces, and it shipped an
 * audio-only "clip" to a user before this check existed. A render is only
 * finished if it actually contains both streams and is about as long as asked.
 */
async function assertRenderedClip(outPath, expectedDurationSec, signal) {
  const info = await probeRendered(outPath, signal);
  const kinds = new Set((info.streams || []).map((s) => s.codec_type));
  if (!kinds.has("video")) {
    throw new Error(
      "Rendered clip has no video stream — the video source was likely truncated mid-read. Please retry."
    );
  }
  if (!kinds.has("audio")) {
    throw new Error("Rendered clip has no audio stream.");
  }
  const actual = Number(info?.format?.duration);
  if (Number.isFinite(actual) && actual < expectedDurationSec * 0.5) {
    throw new Error(
      `Rendered clip is ${actual.toFixed(1)}s but ${expectedDurationSec.toFixed(1)}s was requested — the source read was cut short. Please retry.`
    );
  }
}

function secondsToAssTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = (clamped % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}

// Fixed pop color for the word currently being spoken, independent of the
// user's chosen base caption color — this two-tone "one word lights up at a
// time" look is the single biggest visual signature of popular podcast clip
// channels (Rogan clips, Hormozi-style captions, etc).
const HIGHLIGHT_HEX = "#3DDC84";

/**
 * Builds a .ass subtitle file for the given clip window: short, punchy
 * uppercase word-chunk captions (~3 real words at a time, from Whisper's
 * word-level timestamps), bold with a heavy black outline (no box) sitting
 * in the lower-middle safe zone, with the exact word being spoken lit up in
 * a highlight color and given a little scale "pop" — plus a centered
 * "Sub for more" CTA over the final 3 seconds.
 */
function buildAssSubtitles(words, clipStart, clipEnd, assPath, subtitleColorHex) {
  const primary = hexToAssColor(subtitleColorHex);
  const highlight = hexToAssColor(HIGHLIGHT_HEX);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,84,${primary},&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,7,0,2,50,50,460,1
Style: Outro,Arial Black,72,${primary},&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,2,50,50,140,1

[Events]
Format: Layer, Start, End, Style, Text
`;
  const lines = [header];

  const clipWords = words
    .filter((w) => w.start < clipEnd && w.end > clipStart)
    .map((w) => ({ word: w.word.replace(/[{}]/g, ""), start: w.start, end: w.end })); // strip ASS override-code characters

  const chunkSize = 3;
  for (let i = 0; i < clipWords.length; i += chunkSize) {
    const chunk = clipWords.slice(i, i + chunkSize).map((w) => ({
      word: w.word.toUpperCase(),
      start: Math.max(0, w.start - clipStart),
      end: Math.max(0, w.end - clipStart),
    }));
    const chunkStart = chunk[0].start;
    const chunkEnd = chunk[chunk.length - 1].end;

    // One dialogue event per word in the chunk: the whole chunk's text stays
    // on screen, but the currently-spoken word is recolored + briefly scaled
    // up, and the highlight hands off to the next word with no dead gap.
    for (let w = 0; w < chunk.length; w++) {
      const segStart = w === 0 ? chunkStart : chunk[w].start;
      const segEnd = w === chunk.length - 1 ? chunkEnd : chunk[w + 1].start;
      if (segEnd <= segStart) continue;

      const text = chunk
        .map((cw, idx) =>
          idx === w
            ? `{\\c${highlight}\\t(0,90,\\fscx112\\fscy112)\\t(90,180,\\fscx100\\fscy100)}${cw.word}{\\c${primary}\\fscx100\\fscy100}`
            : cw.word
        )
        .join(" ");

      lines.push(
        `Dialogue: 0,${secondsToAssTimestamp(segStart)},${secondsToAssTimestamp(segEnd)},Default,${text}`
      );
    }
  }

  const duration = clipEnd - clipStart;
  const outroStart = Math.max(0, duration - 3);
  lines.push(
    `Dialogue: 1,${secondsToAssTimestamp(outroStart)},${secondsToAssTimestamp(duration)},Outro,Sub for more`
  );

  fs.writeFileSync(assPath, lines.join("\n"), "utf-8");
  return assPath;
}

/** Escapes a filesystem path for use inside an ffmpeg filter argument (colons and backslashes are filter syntax). */
function escapeForFilterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** Converts "#RRGGBB" to ASS's &HAABBGGRR& format (ASS uses BGR order, AA=00 opaque). */
function hexToAssColor(hex) {
  const clean = hex.replace("#", "");
  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
