import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTES,
  currentRoute,
  navigate,
  parseRoute,
  routePath,
  routePattern,
  subscribeToRoute,
} from "../src/router.js";

const JOB_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** Minimal window: history + event target, enough to drive the router. */
function fakeWindow(pathname = "/") {
  const listeners = new Map();
  const location = { pathname, origin: "https://vod-clipper.com" };
  return {
    location,
    history: {
      pushed: [],
      replaced: [],
      // Real pushState updates location; the router relies on that to detect
      // a redundant navigation.
      pushState(_state, _title, url) {
        this.pushed.push(url);
        location.pathname = url;
      },
      replaceState(_state, _title, url) {
        this.replaced.push(url);
        location.pathname = url;
      },
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

test("the four real routes parse", () => {
  assert.deepEqual(parseRoute("/"), { name: "landing" });
  assert.deepEqual(parseRoute("/signin"), { name: "signin" });
  assert.deepEqual(parseRoute("/overview"), { name: "overview" });
  assert.deepEqual(parseRoute(`/clips/${JOB_ID}`), { name: "clip", jobId: JOB_ID });
});

test("trailing and duplicated slashes do not create separate routes", () => {
  assert.deepEqual(parseRoute("/overview/"), { name: "overview" });
  assert.deepEqual(parseRoute("//overview"), { name: "overview" });
  assert.deepEqual(parseRoute(`/clips/${JOB_ID}/`), { name: "clip", jobId: JOB_ID });
  // "/" must survive the trailing-slash trim rather than becoming "".
  assert.deepEqual(parseRoute("/"), { name: "landing" });
});

test("only a real job id is accepted as a clip route", () => {
  // Everything here would otherwise become a backend request for a path
  // chosen by whoever wrote the link.
  assert.equal(parseRoute("/clips/not-a-uuid").name, "notFound");
  assert.equal(parseRoute("/clips/../../etc/passwd").name, "notFound");
  assert.equal(parseRoute("/clips/").name, "notFound");
  assert.equal(parseRoute(`/clips/${JOB_ID}/extra`).name, "notFound");
  // A malformed percent-escape throws inside decodeURIComponent.
  assert.equal(parseRoute("/clips/%E0%A4%A").name, "notFound");
});

test("unknown paths are notFound rather than silently landing", () => {
  assert.equal(parseRoute("/beta").name, "notFound");
  assert.equal(parseRoute("/admin").name, "notFound");
  assert.equal(parseRoute(undefined).name, "landing");
});

test("routePath round-trips every route", () => {
  for (const path of [ROUTES.landing, ROUTES.signin, ROUTES.overview, `/clips/${JOB_ID}`]) {
    assert.equal(routePath(parseRoute(path)), path);
  }
});

test("the analytics pattern collapses the job id out", () => {
  assert.equal(routePattern(parseRoute(`/clips/${JOB_ID}`)), "/clips/:id");
  assert.equal(routePattern(parseRoute("/overview")), "/overview");
  assert.equal(routePattern(parseRoute("/nope")), "/not-found");
});

test("navigate pushes, and replace is used for corrections", () => {
  const win = fakeWindow("/");
  assert.equal(navigate("/overview", { win }), true);
  assert.deepEqual(win.history.pushed, ["/overview"]);

  navigate("/signin", { replace: true, win });
  assert.deepEqual(win.history.replaced, ["/signin"]);
});

test("normalising a path preserves the query string", () => {
  const win = fakeWindow("/");
  win.location.search = "?youtube=connected&role=clips";

  // The YouTube OAuth callback returns to "/?youtube=connected". Rewriting the
  // path to /overview without this would drop the result before it is read,
  // and the user would silently never see that the channel connected.
  navigate("/overview", { replace: true, preserveQuery: true, win });
  assert.deepEqual(win.history.replaced, ["/overview?youtube=connected&role=clips"]);
});

test("an ordinary navigation does not drag the old query string along", () => {
  const win = fakeWindow("/");
  win.location.search = "?youtube=connected";
  navigate("/overview", { win });
  assert.deepEqual(win.history.pushed, ["/overview"]);
});

test("navigating to the current path is a no-op", () => {
  const win = fakeWindow("/overview");
  // Without this, a redirect effect that re-runs would stack duplicate history
  // entries and trap the back button.
  assert.equal(navigate("/overview", { win }), false);
  assert.deepEqual(win.history.pushed, []);
});

test("subscribers hear both back/forward and in-app navigation", () => {
  const win = fakeWindow("/");
  const seen = [];
  const unsubscribe = subscribeToRoute((route) => seen.push(route.name), win);

  // pushState does not fire popstate, so in-app moves need their own signal.
  navigate("/overview", { win });
  assert.deepEqual(seen, ["overview"]);

  win.location.pathname = "/signin";
  win.dispatchEvent(new win.Event("popstate"));
  assert.deepEqual(seen, ["overview", "signin"]);

  unsubscribe();
  assert.equal(win.listenerCount("popstate"), 0);
  assert.equal(win.listenerCount("routechange"), 0);
});

test("currentRoute reads the live location", () => {
  assert.deepEqual(currentRoute(fakeWindow(`/clips/${JOB_ID}`)), { name: "clip", jobId: JOB_ID });
  // No window at all (SSR, tests) must not throw.
  assert.deepEqual(currentRoute(undefined), { name: "landing" });
});
