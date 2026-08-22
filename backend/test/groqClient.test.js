import assert from "node:assert/strict";
import test from "node:test";

import { groqPostWithRetry } from "../src/lib/groqClient.js";

test("external abort cancels a Groq request without retrying", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  });

  process.env.GROQ_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls += 1;
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const controller = new AbortController();
  const request = groqPostWithRetry("/test", () => "{}", {
    attempts: 4,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  controller.abort(new DOMException("Job deleted.", "AbortError"));

  await assert.rejects(request, (error) => error?.name === "AbortError");
  assert.equal(calls, 1);
});
