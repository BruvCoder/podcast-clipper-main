// Gemini occasionally returns a transient 503 ("high demand")/429 (rate
// limit) that has nothing to do with the request itself, or a request just
// stalls until our own httpOptions.timeout cuts it off — retrying after a
// short backoff usually succeeds either way. Without this, a single blip
// fails the whole job outright (and for transcription, one bad chunk out of
// many).
const RETRYABLE_PATTERN =
  /\b(503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate limit|timeout|timed out|deadline|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/i;

function isRetryableGeminiError(err) {
  const status = err?.status ?? err?.code;
  if (status === 503 || status === 429) return true;
  return RETRYABLE_PATTERN.test(String(err?.message || err));
}

/**
 * Runs `fn` and retries with exponential backoff (+ jitter) on a transient
 * Gemini error, up to `retries` additional attempts. Non-retryable errors
 * (bad request, auth, schema mismatch, etc.) are rethrown immediately.
 */
export async function withGeminiRetry(fn, { retries = 4, baseDelayMs = 1000, label = "Gemini request" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableGeminiError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 250;
      console.warn(
        `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${Math.round(delay)}ms: ${err.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
