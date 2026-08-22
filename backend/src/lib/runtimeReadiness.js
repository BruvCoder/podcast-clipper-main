import { spawnSync } from "node:child_process";

// Official yt-dlp standalone bundles can take several seconds to unpack on a
// cold filesystem (especially under macOS Gatekeeper). Railway allows a
// 300-second deploy health window, so prefer a conservative startup probe over
// falsely rejecting an otherwise healthy pinned binary.
const PROBE_TIMEOUT_MS = 45_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

function minimalProbeEnvironment(environment = process.env) {
  const child = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]) {
    if (environment[key]) child[key] = environment[key];
  }
  child.NO_COLOR = "1";
  return child;
}

function safeVersion(output, kind) {
  const text = String(output || "");
  if (kind === "yt-dlp") {
    return text.match(/\b\d{4}\.\d{1,2}\.\d{1,2}(?:[A-Za-z0-9._+-]*)?\b/)?.[0] || null;
  }

  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escapedKind} version\\s+([A-Za-z0-9._+-]{1,80})`, "i"));
  return match?.[1] || null;
}

function probeBinary(binary, args, kind, environment, spawn = spawnSync) {
  try {
    const result = spawn(binary, args, {
      encoding: "utf8",
      env: minimalProbeEnvironment(environment),
      maxBuffer: MAX_PROBE_OUTPUT_BYTES,
      shell: false,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = safeVersion(result.stdout, kind) || safeVersion(result.stderr, kind);
    return { ok: result.status === 0 && Boolean(version), version };
  } catch {
    return { ok: false, version: null };
  }
}

function proxyRequirement(environment = process.env) {
  const explicit = String(environment.YTDLP_REQUIRE_PROXY || "").trim().toLowerCase();
  const required = explicit ? explicit !== "false" : environment.NODE_ENV === "production";
  const configured = Boolean(
    String(environment.RESIDENTIAL_PROXY_URL || environment.MEDIA_PROXY_URL || "").trim()
  );
  return { configured, required };
}

/**
 * Reports whether face-guided cropping is usable: the Python interpreter, the
 * cv2 import, and the model file all have to be present. Never gates overall
 * readiness — the renderer falls back to a centre crop, so a missing detector
 * degrades clip framing rather than breaking the service.
 */
function faceDetectionAvailability(environment = process.env, spawn = spawnSync) {
  const python =
    String(environment.PYTHON_BIN || "").trim() || (process.platform === "win32" ? "python" : "python3");
  const model =
    String(environment.FACE_MODEL_PATH || "").trim() || "/usr/local/share/vod-clipper/yunet.onnx";
  try {
    const result = spawn(
      python,
      ["-c", `import cv2,os,sys; sys.exit(0 if os.path.exists(${JSON.stringify(model)}) else 1)`],
      {
        encoding: "utf8",
        // Inherits the environment on purpose, unlike the media-binary probes
        // above: faceCrop.js spawns Python the same way, and a probe run under
        // a different environment measures something the renderer never does.
        // Stripping it here made cv2 unimportable while real detection worked.
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      }
    );
    return { ok: result.status === 0 };
  } catch {
    return { ok: false };
  }
}

/**
 * Probe external media binaries once during startup and cache the returned
 * object in the server. The result deliberately contains no command paths,
 * stderr, environment values, or other potentially sensitive diagnostics.
 */
export function inspectRuntimeReadiness(environment = process.env) {
  const ytDlpBinary = String(environment.YTDLP_BINARY || "").trim() || "yt-dlp";
  const ytDlp = probeBinary(ytDlpBinary, ["--version"], "yt-dlp", environment);
  const ffmpeg = probeBinary("ffmpeg", ["-version"], "ffmpeg", environment);
  const ffprobe = probeBinary("ffprobe", ["-version"], "ffprobe", environment);
  const proxy = proxyRequirement(environment);
  const faceDetection = faceDetectionAvailability(environment);

  return {
    // faceDetection is intentionally absent from this expression.
    ok: ytDlp.ok && ffmpeg.ok && ffprobe.ok && (!proxy.required || proxy.configured),
    ytDlp,
    ffmpeg,
    ffprobe,
    proxy,
    faceDetection,
  };
}

export const __testing = {
  minimalProbeEnvironment,
  probeBinary,
  proxyRequirement,
  safeVersion,
};
