// Shared transport for the two Groq-backed features (transcription and clip
// selection): key handling, request timeouts, and retry-with-backoff on the
// transient failures these APIs actually return.

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export function requireGroqKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new Error(
      "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys " +
        "and add it to backend/.env (or the host's environment variables)."
    );
  }
  return key;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * POSTs to a Groq endpoint with auth, an explicit timeout, and retries on
 * transient failures. `buildBody` is a function so each attempt gets a fresh
 * body (a FormData/stream can only be consumed once).
 */
export async function groqPostWithRetry(
  endpoint,
  buildBody,
  { attempts = 4, timeoutMs = 120_000, extraHeaders = {}, label = "Groq request" } = {}
) {
  const apiKey = requireGroqKey();
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const res = await fetch(`${GROQ_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: await buildBody(),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`${label} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const retryable = err.name === "AbortError" || RETRYABLE_STATUS.has(err.status);
      if (attempt === attempts || !retryable) throw err;
      const delay = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
      console.warn(
        `${label} failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(delay)}ms: ${err.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
