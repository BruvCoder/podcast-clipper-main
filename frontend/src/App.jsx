import { useEffect, useRef, useState } from "react";
import Loading from "./components/Loading.jsx";
import Results from "./components/Results.jsx";
import Landing from "./components/Landing.jsx";
import Auth from "./components/Auth.jsx";
import Sidebar from "./components/Sidebar.jsx";
import AutomationDashboard from "./components/AutomationDashboard.jsx";
import { useAuth } from "./AuthContext.jsx";
import { trackEvent, trackPageView } from "./analytics.js";
import {
  ROUTES,
  currentRoute,
  navigate,
  routePattern,
  subscribeToRoute,
} from "./router.js";
import {
  checkYoutubeNow,
  deleteJob,
  disconnectYoutube,
  getJob,
  getYoutubeAutomation,
  listJobs,
  setYoutubeSourceChannel,
  startYoutubeOAuth,
  updateYoutubeAutomation,
} from "./api.js";

const THEME_KEY = "pc-theme";
const CONNECT_CHANNELS_INTENT_KEY = "ravi-connect-channels-intent";

function setConnectIntent(enabled) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (enabled) sessionStorage.setItem(CONNECT_CHANNELS_INTENT_KEY, "1");
    else sessionStorage.removeItem(CONNECT_CHANNELS_INTENT_KEY);
  } catch {
    // Browsers can disable session storage in privacy-restricted contexts.
  }
}

function consumeConnectIntent() {
  if (typeof sessionStorage === "undefined") return false;
  try {
    const enabled = sessionStorage.getItem(CONNECT_CHANNELS_INTENT_KEY) === "1";
    if (enabled) sessionStorage.removeItem(CONNECT_CHANNELS_INTENT_KEY);
    return enabled;
  } catch {
    return false;
  }
}

function getInitialTheme() {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  if (saved === "dark" || saved === "light") return saved;
  const prefersLight =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

function oauthReturn() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const status = params.get("youtube");
  if (!status) return null;
  return { status, role: params.get("role") || "", message: params.get("message") || "" };
}

function clearOauthReturn() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("youtube");
  url.searchParams.delete("role");
  url.searchParams.delete("message");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const { user } = useAuth();
  const authLoading = user === undefined;

  const [route, setRoute] = useState(currentRoute);
  const [theme, setTheme] = useState(getInitialTheme);
  // Only meaningful on a clip route: how far along that one job is.
  const [clipState, setClipState] = useState("loading");
  const [job, setJob] = useState(null);
  const [jobsList, setJobsList] = useState([]);
  const [jobError, setJobError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [automation, setAutomation] = useState(null);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationError, setAutomationError] = useState(null);
  const [automationNotice, setAutomationNotice] = useState(null);
  const [automationAction, setAutomationAction] = useState(null);

  const pollRef = useRef(null);
  const connectStartedRef = useRef(false);
  // user === null means both "never signed in" and "just signed out", and the
  // two need different handling for the URL.
  const hadUserRef = useRef(false);

  // The URL is the source of truth for which view is showing; the job id is
  // read back out of it rather than tracked separately.
  const activeJobId = route.name === "clip" ? route.jobId : null;
  const showingLanding = !authLoading && !user && route.name === "landing";

  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => subscribeToRoute(setRoute), []);

  useEffect(() => {
    if (user) hadUserRef.current = true;
  }, [user]);

  // Routes that cannot render as asked are corrected with replace(), so the
  // back button does not land the user right back on them.
  useEffect(() => {
    if (authLoading) return;
    if (user && (route.name === "landing" || route.name === "signin" || route.name === "notFound")) {
      // preserveQuery: the YouTube OAuth callback returns to "/?youtube=…",
      // and that result is read further down before being cleared.
      navigate(ROUTES.overview, { replace: true, preserveQuery: true });
    } else if (!user && route.name === "notFound") {
      navigate(ROUTES.landing, { replace: true });
    }
  }, [authLoading, user, route.name]);

  // Held back until auth resolves, otherwise every visit reports a spurious
  // hit before the session is known and the redirect above settles.
  const analyticsPath = authLoading ? null : routePattern(route);

  useEffect(() => {
    if (analyticsPath) trackPageView(analyticsPath);
  }, [analyticsPath]);

  // Loading a clip set is driven by the URL, so a sidebar click, a pasted
  // link, a refresh, and the back button all follow one path.
  useEffect(() => {
    if (authLoading || !user || route.name !== "clip") return undefined;

    const { jobId } = route;
    let cancelled = false;
    clearInterval(pollRef.current);
    setJobError(null);
    setJob(null);
    setClipState("loading");

    (async () => {
      try {
        const data = await getJob(jobId);
        if (cancelled) return;
        setJob(data);
        if (data.status === "done") setClipState("results");
        else if (data.status === "error") {
          setJobError(data.error);
          setClipState("error");
        } else pollJob(jobId);
      } catch (error) {
        if (cancelled) return;
        // Covers a deleted job and someone else's id alike: the backend scopes
        // jobs to the caller, so a valid-looking URL can still be a 404.
        setJobError(error.message);
        setClipState("error");
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [authLoading, user, route.name, route.jobId]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (!themeColor) return;
    themeColor.setAttribute(
      "content",
      showingLanding ? "#f8fbff" : theme === "dark" ? "#0a0e16" : "#f3f7fd",
    );
  }, [showingLanding, theme]);

  useEffect(() => {
    if (user !== null) return;
    clearInterval(pollRef.current);
    connectStartedRef.current = false;
    // Signing out of a clip route must not leave that URL in the bar. Arriving
    // signed out is different: the deep link is kept so that signing in
    // resumes where the visitor was headed.
    if (hadUserRef.current) {
      hadUserRef.current = false;
      navigate(ROUTES.landing, { replace: true });
    }
    setClipState("loading");
    setJob(null);
    setJobsList([]);
    setJobError(null);
    setAutomation(null);
    setAutomationError(null);
    setAutomationNotice(null);
    setAutomationAction(null);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function initialize() {
      setAutomationLoading(true);
      setAutomationError(null);
      const returned = oauthReturn();
      try {
        const [automationData] = await Promise.all([
          getYoutubeAutomation(),
          refreshJobsList(),
        ]);
        if (cancelled) return;
        setAutomation(automationData);

        if (returned?.status === "connected") {
          setAutomationNotice("Your clips channel is connected.");
        } else if (returned?.status === "error") {
          setAutomationError(returned.message || "Your clips channel could not be connected. Please try again.");
        }
        if (returned) clearOauthReturn();

        const shouldConnect = consumeConnectIntent();
        const nextConnectionRole = !automationData?.clipsChannel ? "clips" : null;
        if (shouldConnect && automationData?.available !== false && nextConnectionRole && !connectStartedRef.current) {
          connectStartedRef.current = true;
          setAutomationAction(`connecting-${nextConnectionRole}`);
          const url = await startYoutubeOAuth(nextConnectionRole);
          if (!cancelled) window.location.assign(url);
        }
      } catch (error) {
        if (!cancelled) setAutomationError(error.message);
      } finally {
        if (!cancelled) {
          setAutomationLoading(false);
          setAutomationAction(null);
        }
      }
    }

    initialize();
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (!user || !automation?.enabled) return undefined;
    const timer = setInterval(async () => {
      try {
        const data = await getYoutubeAutomation();
        setAutomation(data);
        refreshJobsList();
      } catch {
        // Keep the last good status. Explicit actions still surface failures.
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [user, automation?.enabled]);

  async function refreshJobsList() {
    try {
      const jobs = await listJobs();
      setJobsList(jobs || []);
    } catch {
      // Job history is secondary to channel automation. Keep the overview usable.
    }
  }

  function pollJob(id) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await getJob(id);
        setJob(data);
        if (data.status === "done") {
          clearInterval(pollRef.current);
          setClipState("results");
          refreshJobsList();
        } else if (data.status === "error") {
          clearInterval(pollRef.current);
          setJobError(data.error);
          setClipState("error");
          refreshJobsList();
        }
      } catch (error) {
        clearInterval(pollRef.current);
        setJobError(error.message);
        setClipState("error");
      }
    }, 2000);
  }

  function handleOverview() {
    setSidebarOpen(false);
    navigate(ROUTES.overview);
  }

  async function handleDeleteJob(id) {
    await deleteJob(id);
    setJobsList((previous) => previous.filter((item) => item.id !== id));
    if (id === activeJobId) handleOverview();
  }

  function handleSelectHistoryJob(id) {
    setSidebarOpen(false);
    // Navigation only. The route effect below does the loading, so a click, a
    // pasted link, and the back button all take exactly the same path.
    navigate(`/clips/${id}`);
  }

  function handleLandingConnect() {
    setConnectIntent(true);
    navigate(ROUTES.signin);
  }

  function handleLandingSignIn() {
    setConnectIntent(false);
    navigate(ROUTES.signin);
  }

  async function handleConnectYoutube(role) {
    setAutomationAction(`connecting-${role}`);
    setAutomationError(null);
    setAutomationNotice(null);
    try {
      const url = await startYoutubeOAuth(role);
      window.location.assign(url);
    } catch (error) {
      setAutomationError(error.message);
      setAutomationAction(null);
    }
  }

  async function handleSetSourceYoutube(url) {
    setAutomationAction("saving-source");
    setAutomationError(null);
    setAutomationNotice(null);
    try {
      const data = await setYoutubeSourceChannel(url);
      setAutomation(data);
      setAutomationNotice("Ravi is ready to watch your main channel.");
    } catch (error) {
      setAutomationError(error.message);
    } finally {
      setAutomationAction(null);
    }
  }

  async function handleUpdateAutomation(updates) {
    const wasEnabled = Boolean(automation?.enabled);
    setAutomationAction("saving");
    setAutomationError(null);
    setAutomationNotice(null);
    try {
      const data = await updateYoutubeAutomation(updates);
      setAutomation(data);
      // Activation, not a click: only fires when watching actually starts.
      if (data.enabled && !wasEnabled) trackEvent("automation_enabled");
      else if (!data.enabled && wasEnabled) trackEvent("automation_paused");
      setAutomationNotice(
        updates.enabled
          ? "Ravi is now watching for your next public upload."
          : wasEnabled
          ? "Ravi is paused. No new uploads will be processed."
          : "Your Ravi setup has been saved.",
      );
    } catch (error) {
      setAutomationError(error.message);
    } finally {
      setAutomationAction(null);
    }
  }

  async function handleCheckNow() {
    setAutomationAction("checking");
    setAutomationError(null);
    setAutomationNotice(null);
    try {
      const data = await checkYoutubeNow();
      setAutomation(data);
      setAutomationNotice("Ravi checked your main channel for new uploads.");
      refreshJobsList();
    } catch (error) {
      setAutomationError(error.message);
    } finally {
      setAutomationAction(null);
    }
  }

  async function handleDisconnectYoutube(role) {
    setAutomationAction(`disconnecting-${role}`);
    setAutomationError(null);
    setAutomationNotice(null);
    try {
      const data = await disconnectYoutube(role);
      setAutomation(data);
      setAutomationNotice(
        role === "main"
          ? "Your main channel link was removed and Ravi was paused."
          : "Your clips channel was disconnected and Ravi was paused.",
      );
    } catch (error) {
      setAutomationError(error.message);
    } finally {
      setAutomationAction(null);
    }
  }

  return (
    <div className="app">
      <div className="app-grain" />
      <div className="app-vignette" />

      {!authLoading && !showingLanding && (
        <button
          className="theme-toggle"
          onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      )}

      {/* Nothing renders while the session resolves. Firebase answers from
          local storage in well under a second, and a spinner that appears and
          vanishes in that window reads as a flash of broken layout. */}

      {!authLoading && !user && (
        <div className={`centered-shell ${showingLanding ? "landing-shell" : ""}`}>
          {showingLanding ? (
            <Landing onConnect={handleLandingConnect} onSignIn={handleLandingSignIn} />
          ) : (
            // /overview and /clips/<id> reached while signed out land here, and
            // the URL is left alone so signing in resumes where they aimed.
            <Auth onBack={() => navigate(ROUTES.landing)} />
          )}
        </div>
      )}

      {!authLoading && user && (
        <div className="app-shell">
          <Sidebar
            jobs={jobsList}
            activeJobId={activeJobId}
            onSelectJob={handleSelectHistoryJob}
            onOverview={handleOverview}
            onDeleteJob={handleDeleteJob}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />

          <main className="main-content">
            <div className="main-topbar">
              <button className="menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
            </div>

            <div className={`main-inner ${route.name === "overview" ? "overview" : ""}`}>
              {route.name === "overview" && (
                <AutomationDashboard
                  automation={automation}
                  loading={automationLoading}
                  error={automationError}
                  notice={automationNotice}
                  action={automationAction}
                  onConnect={handleConnectYoutube}
                  onSetSource={handleSetSourceYoutube}
                  onUpdate={handleUpdateAutomation}
                  onCheckNow={handleCheckNow}
                  onDisconnect={handleDisconnectYoutube}
                />
              )}
              {route.name === "clip" && clipState === "loading" && <Loading stage={job?.stage} />}
              {route.name === "clip" && clipState === "results" && job && (
                <Results job={job} onRestart={handleOverview} />
              )}
              {route.name === "clip" && clipState === "error" && (
                <div className="card error-view">
                  <h1>This clip set needs attention</h1>
                  <div className="error-box">{jobError}</div>
                  <button className="btn-primary" onClick={handleOverview}>Back to overview</button>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.15 1.15M4.25 11.75L3.1 12.9M12.9 12.9l-1.15-1.15M4.25 4.25L3.1 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M14 9.3A6.2 6.2 0 1 1 6.7 2a5 5 0 0 0 7.3 7.3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
