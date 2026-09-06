import assert from "node:assert/strict";
import test from "node:test";

import {
  initAnalytics,
  isLocalHost,
  loadAnalyticsConfig,
  sanitizeEventParams,
  trackEvent,
  trackPageView,
  __testing,
} from "../src/analytics.js";

const ID = "G-ABC1234567";

/** Minimal document/window pair: enough surface for gtag.js injection. */
function fakeBrowser() {
  const head = { children: [] };
  const doc = {
    head,
    getElementById(id) {
      return head.children.find((element) => element.id === id) || null;
    },
    createElement() {
      return {};
    },
  };
  doc.head.appendChild = (element) => head.children.push(element);
  const win = { location: { origin: "https://vod-clipper.com", hostname: "vod-clipper.com" } };
  return { doc, win, head };
}

test("the built-in property is used when no override is configured", () => {
  const config = loadAnalyticsConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.measurementId, "G-EYDJRPBBQ4");
  // An absent env var is the normal deployment path, so it must not disable
  // analytics the way a missing secret would.
  assert.equal(loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: "" }).measurementId, "G-EYDJRPBBQ4");
});

test("an override points a build at a different property", () => {
  const config = loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: ID });
  assert.equal(config.enabled, true);
  assert.equal(config.measurementId, ID);
});

test("a malformed override disables analytics instead of guessing", () => {
  // Pasting a Universal Analytics ID is a real mistake, and UA properties
  // stopped accepting data — silently collecting nothing is the bad outcome.
  assert.equal(loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: "UA-12345-1" }).enabled, false);
  assert.equal(loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: "not-an-id" }).enabled, false);
});

test("local development never reaches the real property", () => {
  assert.equal(isLocalHost({ location: { hostname: "localhost" } }), true);
  assert.equal(isLocalHost({ location: { hostname: "127.0.0.1" } }), true);
  assert.equal(isLocalHost({ location: { hostname: "app.localhost" } }), true);
  assert.equal(isLocalHost({ location: { hostname: "vod-clipper.com" } }), false);

  const { doc, win, head } = fakeBrowser();
  win.location.hostname = "localhost";
  assert.equal(initAnalytics({ config: loadAnalyticsConfig({}), doc, win }), false);
  assert.equal(head.children.length, 0);
  assert.equal(win.gtag, undefined);
});

test("init injects gtag once and suppresses the automatic page_view", () => {
  const { doc, win, head } = fakeBrowser();
  const config = loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: ID });

  assert.equal(initAnalytics({ config, doc, win }), true);
  assert.equal(head.children.length, 1);
  assert.match(head.children[0].src, /googletagmanager\.com\/gtag\/js\?id=G-ABC1234567$/);
  assert.equal(head.children[0].async, true);

  const configCall = win.dataLayer.find((args) => args[0] === "config");
  // Left on, the automatic hit would be the only page_view this SPA ever sent.
  assert.deepEqual(configCall[2], { send_page_view: false });

  // React StrictMode double-invokes effects; a second script would double
  // every hit for the rest of the session.
  assert.equal(initAnalytics({ config, doc, win }), false);
  assert.equal(head.children.length, 1);
});

test("init does nothing at all when the configured ID is unusable", () => {
  const { doc, win, head } = fakeBrowser();
  const config = loadAnalyticsConfig({ VITE_GA_MEASUREMENT_ID: "UA-12345-1" });
  assert.equal(initAnalytics({ config, doc, win }), false);
  assert.equal(head.children.length, 0);
  // No script, no gtag, and therefore no GA4 cookies at all.
  assert.equal(win.gtag, undefined);
});

test("tracking is a silent no-op when gtag never loaded", () => {
  // An ad blocker eating gtag.js must not throw inside a render effect.
  assert.equal(trackEvent("login", { method: "google" }, {}), false);
  assert.equal(trackPageView("landing", {}), false);
});

test("sanitizer strips identifying keys before they reach Google", () => {
  const clean = sanitizeEventParams({
    method: "google",
    email: "someone@example.com",
    user_id: "firebase-uid-123",
    display_name: "Real Person",
    token: "secret",
    clips: 3,
    enabled: true,
  });
  assert.deepEqual(clean, { method: "google", clips: 3, enabled: true });
});

test("sanitizer catches an email in a value under an innocent key", () => {
  // The key allowlist alone would let this through.
  const clean = sanitizeEventParams({ label: "invited someone@example.com", ok: "plain" });
  assert.deepEqual(clean, { ok: "plain" });
});

test("sanitizer drops nested objects rather than letting GA4 flatten them", () => {
  const clean = sanitizeEventParams({ user: { email: "a@b.com" }, tags: ["x"], keep: "yes" });
  assert.deepEqual(clean, { keep: "yes" });
});

test("sanitizer truncates long strings", () => {
  const clean = sanitizeEventParams({ title: "x".repeat(500) });
  assert.equal(clean.title.length, __testing.MAX_VALUE_LENGTH);
});

test("page views report a virtual path and never a real query string", () => {
  const win = {
    location: { origin: "https://vod-clipper.com", search: "?checkout=success&token=abc" },
    calls: [],
    gtag(...args) {
      win.calls.push(args);
    },
  };

  assert.equal(trackPageView("overview", win), true);
  const [type, name, params] = win.calls[0];
  assert.equal(type, "event");
  assert.equal(name, "page_view");
  assert.equal(params.page_path, "/overview");
  assert.equal(params.page_title, "overview");
  // Checkout results and OAuth callbacks park identifiers in the query string.
  assert.equal(params.page_location.includes("?"), false);
  assert.equal(params.page_location.includes("token"), false);
});

test("an empty view name is not reported", () => {
  const win = { gtag: () => assert.fail("must not send a nameless page_view") };
  assert.equal(trackPageView("", win), false);
  assert.equal(trackPageView(null, win), false);
});
