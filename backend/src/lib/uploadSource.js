import fs from "node:fs";
import path from "node:path";

// Accepting a video file directly, rather than only a link.
//
// The request body is streamed straight to disk instead of being parsed as
// multipart. A browser can send a File as the body itself, so there is no
// boundary to parse, no parser dependency to add, and a large upload never
// sits in memory — which matters when the cap is measured in hundreds of
// megabytes and the container's RAM is not.
//
// Two limits exist for different reasons. Bytes bound what Railway moves and
// stores. Duration bounds what Groq transcribes, which is the slower and more
// expensive of the two and is not implied by file size: a heavily compressed
// three-hour recording can be smaller than a short high-bitrate one.

export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_SEC = 2 * 60 * 60;
const MAX_TITLE_LENGTH = 120;

export class UploadError extends Error {
  constructor(message, { status = 400, code = "invalid_upload" } = {}) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadUploadConfig(environment = process.env) {
  return {
    maxBytes: positiveInteger(environment.UPLOAD_MAX_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
    maxDurationSec: positiveInteger(environment.UPLOAD_MAX_DURATION_SEC, DEFAULT_MAX_UPLOAD_SEC),
  };
}

/**
 * Advisory only. A browser sends application/octet-stream for plenty of real
 * videos, so this rejects the obviously wrong early to save bandwidth; ffprobe
 * is what actually decides whether the bytes are a video.
 */
export function isAcceptedVideoType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!type) return false;
  return type.startsWith("video/") || type === "application/octet-stream";
}

/**
 * A human-readable title from the client's filename.
 *
 * The name is never used to build a path — the destination is always chosen by
 * the server — so this only has to be safe to display and store.
 */
export function displayTitleFromFilename(filename) {
  const raw = String(filename || "");
  // Take the last segment under either separator, so a full Windows or POSIX
  // path collapses to its basename rather than smuggling directories through.
  const base = raw.split(/[\\/]/).pop() || "";
  const withoutExtension = base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const cleaned = withoutExtension
    // Control characters would corrupt logs and job.json.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Uploaded video";
  return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH).trimEnd() : cleaned;
}

/**
 * Streams a request body to disk, stopping the moment it exceeds maxBytes.
 *
 * Content-Length is not trusted: it is client-supplied and a chunked upload
 * omits it entirely, so the running total is what enforces the cap. The
 * partial file is removed on any failure rather than left occupying the disk.
 */
export async function streamToFile(source, destPath, { maxBytes, signal } = {}) {
  const limit = positiveInteger(maxBytes, DEFAULT_MAX_UPLOAD_BYTES);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const handle = await fs.promises.open(destPath, "w");
  let bytesWritten = 0;

  try {
    const stream = handle.createWriteStream();
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        source.destroy?.();
        stream.destroy();
        reject(error);
      };
      const onAbort = () => fail(new UploadError("The upload was cancelled.", {
        status: 499,
        code: "upload_aborted",
      }));

      source.on("data", (chunk) => {
        bytesWritten += chunk.length;
        if (bytesWritten > limit) {
          // Stop reading immediately rather than after the whole body has
          // arrived, so an oversized upload costs only what has landed.
          fail(new UploadError(
            `That file is larger than the ${Math.round(limit / (1024 * 1024))} MB upload limit.`,
            { status: 413, code: "upload_too_large" }
          ));
          return;
        }
        if (!stream.write(chunk)) {
          source.pause?.();
          stream.once("drain", () => source.resume?.());
        }
      });
      source.on("error", fail);
      stream.on("error", fail);
      source.on("end", () => stream.end());
      stream.on("finish", resolve);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(destPath, { force: true }).catch(() => {});
    throw error;
  }

  await handle.close().catch(() => {});
  if (bytesWritten === 0) {
    await fs.promises.rm(destPath, { force: true }).catch(() => {});
    throw new UploadError("No file was received.", { status: 400, code: "empty_upload" });
  }
  return { bytesWritten };
}

/**
 * Turns an ffprobe result into the facts the pipeline needs, refusing anything
 * it could not clip. A file with no audio has nothing to transcribe, so the
 * moment picker would have nothing to work from.
 */
export function describeProbedSource(probe, { maxDurationSec } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const hasVideo = streams.some((stream) => stream?.codec_type === "video");
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const durationSec = Number.parseFloat(probe?.format?.duration);

  if (!hasVideo) {
    throw new UploadError("That file does not contain a video track.", {
      code: "upload_not_video",
    });
  }
  if (!hasAudio) {
    throw new UploadError("That video has no audio, so there is nothing to transcribe.", {
      code: "upload_no_audio",
    });
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new UploadError("Ravi could not read that video's length.", {
      code: "upload_unreadable",
    });
  }
  const limit = positiveInteger(maxDurationSec, DEFAULT_MAX_UPLOAD_SEC);
  if (durationSec > limit) {
    throw new UploadError(
      `That video is longer than the ${Math.round(limit / 60)} minute limit for uploads.`,
      { code: "upload_too_long" }
    );
  }
  return { durationSec, hasVideo, hasAudio };
}

export const __testing = { MAX_TITLE_LENGTH };
