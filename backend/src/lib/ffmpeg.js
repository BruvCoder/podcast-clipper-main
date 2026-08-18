import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { buildFfmpegHeaderString } from "./rapidapi.js";

// ffmpeg/libx264 auto-detect thread count from the host's reported CPU count,
// which in a container can be the physical host's full core count rather
// than the container's actual cgroup-limited share — leading to wildly
// over-threaded encodes that spike memory and get OOM-killed. Cap explicitly.
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || "2";

// Each render now reads its video input directly from a remote URL (see
// createClip below), so unlike a purely-local ffmpeg pass this can hang on
// a stalled network read. Bound it well below the job's overall timeouts —
// a single short clip has no legitimate reason to take this long.
const FFMPEG_RENDER_TIMEOUT_MS =
  Number.parseInt(process.env.FFMPEG_RENDER_TIMEOUT_MS, 10) || 5 * 60_000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, FFMPEG_RENDER_TIMEOUT_MS);
    timer.unref?.();

    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${cmd}. Is it installed? (${err.message})`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${Math.round(FFMPEG_RENDER_TIMEOUT_MS / 1000)}s`));
      } else if (code !== 0) {
        reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Cuts a segment [startSec, endSec) from the source, reframes to 9:16, and
 * burns in styled ASS subtitles — all in a single ffmpeg pass.
 *
 * The video comes straight from a remote URL (ffmpeg seeks to startSec and
 * only reads that window over the network — the full source video is never
 * downloaded), while the audio comes from the local track already fetched
 * for transcription. `videoSource` is `{ url, headers }` from
 * `rapidapi.js`'s `prepareSources`.
 */
export async function createClip(
  videoSource,
  audioPath,
  words,
  startSec,
  endSec,
  outPath,
  { cropMode = "pad", subtitleColor = "#FFFFFF" } = {}
) {
  const duration = Math.max(0.5, endSec - startSec);
  const assPath = outPath.replace(/\.mp4$/, ".ass");
  buildAssSubtitles(words, startSec, endSec, assPath, subtitleColor);
  const escapedAssPath = escapeForFilterPath(assPath);

  let vf;
  if (cropMode === "crop") {
    // Tighter, "zoomed in" center-crop. Cuts off anything outside a 9:16
    // center slice — only looks right on a single, centered speaker.
    vf = `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920,ass='${escapedAssPath}'`;
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

  const videoInputArgs = [];
  if (videoSource.headers && Object.keys(videoSource.headers).length) {
    videoInputArgs.push("-headers", buildFfmpegHeaderString(videoSource.headers));
  }
  videoInputArgs.push(
    // Auto-retry a dropped/stalled connection instead of failing the whole
    // render over a transient network hiccup.
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-ss",
    String(startSec),
    "-i",
    videoSource.url
  );

  await run("ffmpeg", [
    "-y",
    ...videoInputArgs,
    "-ss",
    String(startSec),
    "-i",
    audioPath,
    "-t",
    String(duration),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
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
    outPath,
  ]);

  fs.unlinkSync(assPath);
  return outPath;
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
 * uppercase word-chunk captions (~3 real words at a time, from Gemini's
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