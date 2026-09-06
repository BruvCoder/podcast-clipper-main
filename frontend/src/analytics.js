// Google Analytics 4, loaded through gtag.js.
//
// The measurement ID is a public identifier, not a secret: it ships inside the
// JS bundle no matter where it is stored, and anyone can read it off the live
// site. So it lives here rather than in deployment config — Vite inlines VITE_*
// at BUILD time, which means an env var would have to be present before
// `npm run build`, and a missing one would fail silently as "no analytics".
//
// VITE_GA_MEASUREMENT_ID still overrides it, for pointing a staging build at a
// separate property.

const SCRIPT_ID = "ga4-gtag";
const DEFAULT_MEASUREMENT_ID = "G-EYDJRPBBQ4";
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,}$/i;
// Development traffic would otherwise land in the same property as real
// visitors, and there is no way to separate it out afterwards.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

// GA4's terms forbid sending personally identifying data, and this app handles
// exactly that: account emails, Firebase uids, and channel URLs are all one
// careless trackEvent call away from being shipped to Google. Rather than
// trusting every future caller, params are filtered here.
const BLOCKED_KEYS = new Set([
  "email",
  "user_email",
  "mail",
  "uid",
  "user_id",
  "userid",
  "firebase_uid",
  "name",
  "display_name",
  "displayname",
  "username",
  "phone",
  "address",
  "password",
  "token",
  "id_token",
  "api_key",
  "code",
]);
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_VALUE_LENGTH = 100;

export function loadAnalyticsConfig(env) {
  // import.meta.env is undefined outside Vite (tests run on bare Node).
  const source = env || (typeof import.meta === "undefined" ? null : import.meta.env) || {};
  const override = String(source.VITE_GA_MEASUREMENT_ID || "").trim();
  const measurementId = override || DEFAULT_MEASUREMENT_ID;
  return {
    enabled: MEASUREMENT_ID_PATTERN.test(measurementId),
    measurementId,
  };
}

/** True for local development, where hits must not reach the real property. */
export function isLocalHost(win = globalThis.window) {
  const hostname = win?.location?.hostname;
  if (typeof hostname !== "string") return false;
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Drops anything that could identify a person before it reaches Google.
 * Objects and arrays are dropped too: GA4 flattens them unpredictably, so a
 * nested `{ user: { email } }` would otherwise slip past the key check.
 */
export function sanitizeEventParams(params) {
  const clean = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (BLOCKED_KEYS.has(String(key).toLowerCase())) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      clean[key] = value;
      continue;
    }
    if (typeof value !== "string") continue;
    if (EMAIL_LIKE.test(value)) continue;
    clean[key] = value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
  }
  return clean;
}

/**
 * Injects gtag.js. Returns whether it actually installed, so callers can tell
 * "not configured" from "already running".
 */
export function initAnalytics({
  config = loadAnalyticsConfig(),
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  if (!config.enabled || !doc || !win) return false;
  if (isLocalHost(win)) return false;
  // React StrictMode double-invokes effects in development, and a second
  // gtag.js would double every hit.
  if (doc.getElementById(SCRIPT_ID)) return false;

  win.dataLayer = win.dataLayer || [];
  function gtag() {
    // Must push `arguments` itself; gtag.js reads the Arguments object.
    win.dataLayer.push(arguments);
  }
  win.gtag = gtag;

  const script = doc.createElement("script");
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
    config.measurementId
  )}`;
  doc.head.appendChild(script);

  gtag("js", new Date());
  // send_page_view is off because this is a single-URL SPA: the automatic hit
  // would be the only one ever recorded, and every view change after it would
  // be invisible. trackPageView drives them instead.
  gtag("config", config.measurementId, { send_page_view: false });
  return true;
}

/**
 * Analytics must never break the product, so a missing gtag — no measurement
 * ID, or an ad blocker that ate the script — is a silent no-op, not a throw.
 */
export function trackEvent(name, params = {}, win = globalThis.window) {
  if (typeof win?.gtag !== "function") return false;
  win.gtag("event", name, sanitizeEventParams(params));
  return true;
}

/** Records a view change as a page_view against a virtual path. */
export function trackPageView(viewName, win = globalThis.window) {
  const view = String(viewName || "").trim();
  if (!view) return false;
  return trackEvent(
    "page_view",
    {
      page_title: view,
      page_path: `/${view}`,
      // Real location minus any query string, which is where checkout results
      // and OAuth callbacks park identifiers we do not want recorded.
      page_location: win?.location ? `${win.location.origin}/${view}` : undefined,
    },
    win
  );
}

export const __testing = { SCRIPT_ID, BLOCKED_KEYS, MAX_VALUE_LENGTH };
