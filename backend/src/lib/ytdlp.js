import { spawn } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Flags shared by every yt-dlp invocation, aimed at avoiding YouTube's bot
 * checks ("Sign in to confirm you're not a bot" / HTTP 429):
 *  - Cookies from a real logged-in browser session, if configured, so
 *    requests look like a signed-in user instead of an anonymous script.
 *  - A couple of alternate player clients, since YouTube's checks target
 *    specific clients (e.g. web_safari) and android/web are often unaffected.
 *  - A small delay between requests so a batch of calls doesn't itself look
 *    automated.
 */
function commonArgs() {
  const args = [];

  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    // e.g. "chrome", "firefox", "edge", "chrome:Default" (profile name after the colon)
    args.push("--cookies-from-browser", process.env.YTDLP_COOKIES_FROM_BROWSER);
  } else if (process.env.YTDLP_COOKIES_FILE) {
    args.push("--cookies", process.env.YTDLP_COOKIES_FILE);
  }

  args.push("--extractor-args", "youtube:player_client=android,web,web_safari");
  args.push("--sleep-requests", "1");

  return args;
}

function friendlyError(rawStderr, exitCode) {
  if (/Sign in to confirm you.?re not a bot/i.test(rawStderr)) {
    return new Error(
      `YouTube is blocking this download as a bot request (exit ${exitCode}).\n` +
        `Fix: set YTDLP_COOKIES_FROM_BROWSER in backend/.env to a browser you're logged into ` +
        `YouTube with, e.g.:\n` +
        `  YTDLP_COOKIES_FROM_BROWSER=chrome\n` +
        `(Close that browser fully before starting the backend — yt-dlp can't read its cookie ` +
        `store while the browser has it open/locked, especially on Windows.) Then restart the backend.\n\n` +
        rawStderr.slice(-1200)
    );
  }
  if (/429|Too Many Requests/i.test(rawStderr)) {
    return new Error(
      `YouTube rate-limited this request (HTTP 429, exit ${exitCode}). This usually clears up after ` +
        `a short wait, and setting YTDLP_COOKIES_FROM_BROWSER (see backend/.env.example) makes it far ` +
        `less likely to happen again.\n\n${rawStderr.slice(-1200)}`
    );
  }
  return new Error(`yt-dlp exited with code ${exitCode}: ${rawStderr.slice(-2000)}`);
}

/** Spawns yt-dlp with the given args, retrying once on a transient rate-limit error. */
function runYtDlp(args, { onProgress, retries = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft) => {
      const proc = spawn("yt-dlp", args);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
        if (onProgress) onProgress(data.toString().trim());
      });
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("error", (err) => {
        reject(new Error(`Failed to start yt-dlp. Is it installed and on your PATH? (${err.message})`));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const isTransient = /429|Too Many Requests/i.test(stderr);
        if (isTransient && retriesLeft > 0) {
          setTimeout(() => attempt(retriesLeft - 1), 5000);
          return;
        }
        reject(friendlyError(stderr, code));
      });
    };

    attempt(retries);
  });
}

/**
 * Downloads a YouTube video as an mp4 into `jobDir/source.mp4`.
 * Requires yt-dlp to be installed and on PATH: https://github.com/yt-dlp/yt-dlp
 * Keep yt-dlp up to date (`pip install -U yt-dlp` or `yt-dlp -U`) — YouTube
 * changes things often enough that an old version is a common cause of
 * download failures on its own.
 */
export async function downloadVideo(youtubeUrl, jobDir, onProgress) {
  const outputTemplate = path.join(jobDir, "source.%(ext)s");

  const args = [
    youtubeUrl,
    "-f",
    "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--no-playlist",
    "--newline",
    ...commonArgs(),
  ];

  await runYtDlp(args, { onProgress });

  const finalPath = path.join(jobDir, "source.mp4");
  if (!fs.existsSync(finalPath)) {
    throw new Error("yt-dlp finished but source.mp4 was not found.");
  }
  return finalPath;
}

/**
 * Fetches basic metadata (title, duration) without downloading the video.
 */
export async function getVideoInfo(youtubeUrl) {
  const stdout = await runYtDlp([youtubeUrl, "--dump-json", "--no-playlist", ...commonArgs()]);
  try {
    const info = JSON.parse(stdout);
    return {
      title: info.title,
      durationSec: info.duration,
      thumbnail: info.thumbnail,
    };
  } catch (e) {
    throw new Error("Could not parse yt-dlp metadata output.");
  }
}