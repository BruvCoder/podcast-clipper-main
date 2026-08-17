import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "transcribe_whisper.py");
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

/**
 * Transcribes an audio file with real word-level timestamps by shelling out
 * to faster-whisper (see scripts/transcribe_whisper.py). Runs locally, no
 * API cost, and gives the tight per-word timing needed for punchy synced
 * captions.
 *
 * Returns: [{ word: "hello", start: 0.12, end: 0.34 }, ...]
 */
export async function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, audioPath], { env: process.env });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to start ${PYTHON_BIN}. Is Python 3 installed and on PATH? ` +
            `Set the PYTHON_BIN env var if it's under a different name (e.g. "python"). (${err.message})`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Whisper transcription failed (exit ${code}). ` +
              `Make sure faster-whisper is installed: pip install faster-whisper\n` +
              stderr.slice(-2000)
          )
        );
        return;
      }
      try {
        const words = JSON.parse(stdout.trim());
        if (!Array.isArray(words) || !words.length) {
          reject(new Error("Whisper returned no words. Check the audio file has speech in it."));
          return;
        }
        resolve(words);
      } catch (e) {
        reject(
          new Error(
            `Could not parse Whisper output as JSON: ${e.message}\n` +
              `Raw stdout (truncated): ${stdout.slice(0, 500)}`
          )
        );
      }
    });
  });
}
