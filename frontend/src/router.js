// Routing over the History API.
//
// Every view used to render from "/", which meant no bookmarking, no way to
// link a clip set, a back button that left the site, and a single
// undifferentiated page_view in analytics.
//
// The whole route table is four entries, so it lives here as pure functions
// rather than pulling in a router library. Parsing is the part with real edge
// cases, and keeping it free of React or the DOM lets it be tested directly.

// Job IDs come from randomUUID() on the backend. Validating the shape means a
// hand-typed or hostile /clips/<anything> never becomes an API request.
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ROUTES = Object.freeze({
  landing: "/",
  signin: "/signin",
  overview: "/overview",
});

export function parseRoute(pathname) {
  // Trailing slashes are equivalent, but "/" itself must survive the trim.
  const path = String(pathname || "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";

  if (path === ROUTES.landing) return { name: "landing" };
  if (path === ROUTES.signin) return { name: "signin" };
  if (path === ROUTES.overview) return { name: "overview" };

  const clip = /^\/clips\/([^/]+)$/.exec(path);
  if (clip) {
    let jobId;
    try {
      jobId = decodeURIComponent(clip[1]);
    } catch {
      // A malformed escape sequence throws rather than returning null.
      return { name: "notFound" };
    }
    if (JOB_ID_PATTERN.test(jobId)) return { name: "clip", jobId };
    return { name: "notFound" };
  }

  return { name: "notFound" };
}

/** The URL a route should occupy. */
export function routePath(route) {
  if (route?.name === "signin") return ROUTES.signin;
  if (route?.name === "overview") return ROUTES.overview;
  if (route?.name === "clip" && route.jobId) return `/clips/${encodeURIComponent(route.jobId)}`;
  return ROUTES.landing;
}

/**
 * The route as a shape rather than a specific URL, for analytics.
 * Sending the real /clips/<uuid> would put one row per job in GA4's reports
 * and ship a per-user identifier to Google, so the id is collapsed out.
 */
export function routePattern(route) {
  if (route?.name === "clip") return "/clips/:id";
  if (route?.name === "notFound") return "/not-found";
  return routePath(route);
}

export function currentRoute(win = globalThis.window) {
  return parseRoute(win?.location?.pathname);
}

/**
 * Moves to a path without a page load. `replace` is for corrections the user
 * should not have to press back through, such as normalising "/" to
 * "/overview" once signed in.
 *
 * `preserveQuery` keeps the existing query string, which such a correction
 * must do: the YouTube OAuth callback returns to "/?youtube=connected", and
 * rewriting the path alone would drop the result before it is read.
 */
export function navigate(
  path,
  { replace = false, preserveQuery = false, win = globalThis.window } = {}
) {
  if (!win?.history) return false;
  const base = String(path || ROUTES.landing);
  const target = preserveQuery ? `${base}${win.location?.search || ""}` : base;
  if (win.location?.pathname === base) return false;
  if (replace) win.history.replaceState(null, "", target);
  else win.history.pushState(null, "", target);
  // pushState does not fire popstate, so listeners are told directly.
  win.dispatchEvent?.(new win.Event("routechange"));
  return true;
}

/** Subscribes to back/forward and in-app navigation. Returns an unsubscribe. */
export function subscribeToRoute(onChange, win = globalThis.window) {
  if (!win?.addEventListener) return () => {};
  const handler = () => onChange(currentRoute(win));
  win.addEventListener("popstate", handler);
  win.addEventListener("routechange", handler);
  return () => {
    win.removeEventListener("popstate", handler);
    win.removeEventListener("routechange", handler);
  };
}

export const __testing = { JOB_ID_PATTERN };
