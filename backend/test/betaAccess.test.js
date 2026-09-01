import assert from "node:assert/strict";
import test from "node:test";

import {
  betaFacingError,
  clientKey,
  constantTimeEquals,
  createBetaAccess,
  loadBetaAccessConfig,
  __testing,
} from "../src/lib/betaAccess.js";

const CODE = "letmeclip-2026";

function responseSpy() {
  const sent = { status: null, body: null, headers: {} };
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
    set(name, value) {
      sent.headers[name] = value;
      return this;
    },
  };
}

function request({ code, body = {} } = {}) {
  const headers = code == null ? {} : { "x-beta-code": code };
  return {
    headers,
    body,
    get(name) {
      return headers[name.toLowerCase()];
    },
    socket: { remoteAddress: "10.0.0.1" },
  };
}

test("a missing code leaves the beta page disabled", () => {
  const config = loadBetaAccessConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.tooShort, false);
});

test("a short code is refused rather than quietly accepted", () => {
  const config = loadBetaAccessConfig({ BETA_ACCESS_CODE: "abc123" });
  assert.equal(config.enabled, false);
  assert.equal(config.tooShort, true);
});

test("a usable code enables the page and carries the caps", () => {
  const config = loadBetaAccessConfig({
    BETA_ACCESS_CODE: CODE,
    BETA_MAX_JOBS_PER_DAY: "4",
    BETA_IP_COOLDOWN_MS: "5000",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.maxJobsPerDay, 4);
  assert.equal(config.cooldownMs, 5000);
});

test("the daily cap defaults low, since each run costs proxy bandwidth", () => {
  const config = loadBetaAccessConfig({ BETA_ACCESS_CODE: CODE });
  assert.equal(config.maxJobsPerDay, 8);
});

test("constantTimeEquals handles unequal lengths without throwing", () => {
  // timingSafeEqual itself throws on a length mismatch, which would turn the
  // code's length into an oracle. Hashing first is what avoids that.
  assert.equal(constantTimeEquals("short", "a-much-longer-value"), false);
  assert.equal(constantTimeEquals(CODE, CODE), true);
});

test("requireCode rejects a wrong code and admits the right one", () => {
  const access = createBetaAccess({ config: loadBetaAccessConfig({ BETA_ACCESS_CODE: CODE }) });

  const denied = responseSpy();
  access.requireCode(request({ code: "wrong-code-here" }), denied, () => {
    assert.fail("next() must not run for a wrong code");
  });
  assert.equal(denied.sent.status, 403);
  assert.equal(denied.sent.body.code, "invalid_beta_code");

  let passed = false;
  access.requireCode(request({ code: CODE }), responseSpy(), () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("requireCode refuses everything while the page is disabled", () => {
  const access = createBetaAccess({ config: loadBetaAccessConfig({}) });
  const res = responseSpy();
  access.requireCode(request({ code: "anything" }), res, () => {
    assert.fail("a disabled page must not admit anyone");
  });
  assert.equal(res.sent.status, 503);
  assert.equal(res.sent.body.code, "beta_disabled");
});

test("the daily cap bounds total runs and reports when it resets", () => {
  let clock = 1_000;
  const access = createBetaAccess({
    config: loadBetaAccessConfig({
      BETA_ACCESS_CODE: CODE,
      BETA_MAX_JOBS_PER_DAY: "2",
      BETA_IP_COOLDOWN_MS: "1",
    }),
    now: () => clock,
  });

  assert.equal(access.reserveRun("a").ok, true);
  clock += 10;
  assert.equal(access.reserveRun("b").ok, true);
  clock += 10;

  const blocked = access.reserveRun("c");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "beta_daily_limit");
  assert.ok(blocked.retryAfterSec > 0);

  // The window is a rolling 24h, so a later day frees the cap again.
  clock += 24 * 60 * 60 * 1000;
  assert.equal(access.reserveRun("c").ok, true);
});

test("the cooldown spaces out repeat runs from one caller", () => {
  let clock = 0;
  const access = createBetaAccess({
    config: loadBetaAccessConfig({ BETA_ACCESS_CODE: CODE, BETA_IP_COOLDOWN_MS: "10000" }),
    now: () => clock,
  });

  assert.equal(access.reserveRun("caller").ok, true);
  const tooSoon = access.reserveRun("caller");
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.code, "beta_cooldown");

  // A different caller is unaffected.
  assert.equal(access.reserveRun("other").ok, true);

  clock += 10_000;
  assert.equal(access.reserveRun("caller").ok, true);
});

test("releasing a reservation gives back the daily slot and the cooldown", () => {
  let clock = 0;
  const access = createBetaAccess({
    config: loadBetaAccessConfig({
      BETA_ACCESS_CODE: CODE,
      BETA_MAX_JOBS_PER_DAY: "1",
      BETA_IP_COOLDOWN_MS: "10000",
    }),
    now: () => clock,
  });

  const reservation = access.reserveRun("caller");
  assert.equal(reservation.ok, true);
  // Without the release, a job that failed to start would burn the only run
  // of the day and strand the tester behind the cooldown.
  reservation.release();

  assert.equal(access.reserveRun("caller").ok, true);
});

test("status never leaks the code", () => {
  const access = createBetaAccess({
    config: loadBetaAccessConfig({ BETA_ACCESS_CODE: CODE, BETA_MAX_JOBS_PER_DAY: "5" }),
  });
  access.reserveRun("caller");
  const status = access.status();
  assert.equal(status.includes(CODE), false);
  assert.match(status, /^enabled\(1\/5 today\)$/);

  assert.equal(createBetaAccess({ config: loadBetaAccessConfig({}) }).status(), "disabled");
  assert.equal(
    createBetaAccess({ config: loadBetaAccessConfig({ BETA_ACCESS_CODE: "tiny" }) }).status(),
    "code_too_short"
  );
});

test("clientKey prefers the forwarded address and falls back to the socket", () => {
  assert.equal(
    clientKey({ headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.18" }, socket: {} }),
    "203.0.113.9"
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
  assert.equal(clientKey({}), "unknown");
});

test("betaFacingError never passes internal pipeline text through", () => {
  // The exact string a local run produced before this was added.
  const raw =
    'yt-dlp exited with code 1: Traceback (most recent call last):\n  File "<frozen runpy>", ' +
    "line 198, in _run_module_as_main\nModuleNotFoundError: No module named 'yt_dlp'";
  const shown = betaFacingError(raw);
  assert.equal(shown, __testing.GENERIC_BETA_ERROR);
  for (const leak of ["yt-dlp", "Traceback", "runpy", "ModuleNotFound"]) {
    assert.equal(shown.includes(leak), false, `"${leak}" must not reach a beta tester`);
  }
});

test("betaFacingError explains the failures a tester can actually act on", () => {
  assert.match(
    betaFacingError("HTTP Error 429: Too Many Requests"),
    /rate-limiting/
  );
  assert.match(
    betaFacingError("ERROR: Private video. Sign in if you've been granted access"),
    /can’t be downloaded/
  );
  assert.match(
    betaFacingError("Downloaded source exceeds the 2 GB limit."),
    /too long or too large/
  );
  assert.match(betaFacingError("Transcription returned no words."), /any speech/);
});

test("betaFacingError reports no error at all when the job has none", () => {
  assert.equal(betaFacingError(null), null);
  assert.equal(betaFacingError(""), null);
  assert.equal(betaFacingError("   "), null);
});
