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
  { attempts = 4, timeoutMs = 120_000, extraHeaders = {}, label = "Groq request", signal } = {}
) {
  const apiKey = requireGroqKey();
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new DOMException(`${label} timed out.`, "TimeoutError")),
      timeoutMs
    );
    timer.unref?.();

    try {
      const res = await fetch(`${GROQ_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: await buildBody(),
        signal: requestSignal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`${label} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      // User/job cancellation is terminal. In particular, never turn DELETE
      // into multiple retry attempts or an uninterruptible backoff sleep.
      if (signal?.aborted) throw signal.reason;
      lastErr = err;
      const retryable = controller.signal.aborted || RETRYABLE_STATUS.has(err.status);
      if (attempt === attempts || !retryable) throw err;
      const delay = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
      console.warn(
        `${label} failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(delay)}ms: ${err.message}`
      );
      await abortableDelay(delay, signal);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function abortableDelay(delayMs, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
