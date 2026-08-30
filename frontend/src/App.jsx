import { useEffect, useRef, useState } from "react";
import UrlInput from "./components/UrlInput.jsx";
import Options from "./components/Options.jsx";
import Loading from "./components/Loading.jsx";
import Results from "./components/Results.jsx";
import Landing from "./components/Landing.jsx";
import Auth from "./components/Auth.jsx";
import Sidebar from "./components/Sidebar.jsx";
import { isValidYouTubeUrl } from "./youtube.js";
import { useAuth } from "./AuthContext.jsx";
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
} from "./api.js";

const THEME_KEY = "pc-theme";
const PENDING_YOUTUBE_URL_KEY = "pc-pending-youtube-url";

function getPendingYouTubeState() {
  const empty = { url: "", ownerUid: "" };
  if (typeof sessionStorage === "undefined") return empty;
  try {
    const rawValue = sessionStorage.getItem(PENDING_YOUTUBE_URL_KEY);
    if (!rawValue) return empty;

    let stored;
    try {
      stored = JSON.parse(rawValue);
    } catch {
      stored = rawValue;
    }

    const url = (typeof stored === "string" ? stored : stored?.url)?.trim() || "";
    const ownerUid = typeof stored?.ownerUid === "string" ? stored.ownerUid : "";
    return isValidYouTubeUrl(url) ? { url, ownerUid } : empty;
  } catch {
    return empty;
  }
}

function getAnonymousPendingYouTubeUrl() {
  const pending = getPendingYouTubeState();
  return pending.ownerUid ? "" : pending.url;
}

function setPendingYouTubeUrl(value, ownerUid = "") {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) {
      sessionStorage.setItem(PENDING_YOUTUBE_URL_KEY, JSON.stringify({ url: value, ownerUid }));
    } else {
      sessionStorage.removeItem(PENDING_YOUTUBE_URL_KEY);
    }
  } catch {
    // Session storage can be unavailable in privacy-restricted browsers.
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

// signedOutView: "landing" | "auth"
// mainStep: "url" | "options" | "loading" | "results" | "error"
export default function App() {
  const { user } = useAuth();
  const authLoading = user === undefined;

  const [theme, setTheme] = useState(getInitialTheme);
  const [signedOutView, setSignedOutView] = useState("landing");
  const [mainStep, setMainStep] = useState(() => (getAnonymousPendingYouTubeUrl() ? "options" : "url"));
  const [youtubeUrl, setYoutubeUrl] = useState(getAnonymousPendingYouTubeUrl);
  const [job, setJob] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobsList, setJobsList] = useState([]);
  const [error, setError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pollRef = useRef(null);

  const showingLanding = !authLoading && !user && signedOutView === "landing";

  useEffect(() => {
    return () => clearInterval(pollRef.current);
  }, []);

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

  // Reset all app-local state on sign-out (user === null, as opposed to
  // undefined which just means auth is still loading).
  useEffect(() => {
    if (user === null) {
      const pendingYouTubeState = getPendingYouTubeState();
      const pendingYouTubeUrl = pendingYouTubeState.ownerUid ? "" : pendingYouTubeState.url;
      if (pendingYouTubeState.ownerUid) setPendingYouTubeUrl("");
      clearInterval(pollRef.current);
      setSignedOutView("landing");
      setMainStep(pendingYouTubeUrl ? "options" : "url");
      setYoutubeUrl(pendingYouTubeUrl);
      setJob(null);
      setActiveJobId(null);
      setJobsList([]);
      setError(null);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const pendingYouTubeState = getPendingYouTubeState();
    if (!pendingYouTubeState.url) return;
    if (pendingYouTubeState.ownerUid && pendingYouTubeState.ownerUid !== user.uid) {
      setPendingYouTubeUrl("");
      setYoutubeUrl("");
      setMainStep("url");
      return;
    }
    setPendingYouTubeUrl(pendingYouTubeState.url, user.uid);
    setYoutubeUrl(pendingYouTubeState.url);
    setMainStep("options");
  }, [user]);

  useEffect(() => {
    if (user) refreshJobsList();
  }, [user]);

  async function refreshJobsList() {
    try {
      setJobsList(await listJobs());
    } catch {
      // Non-fatal — history just won't show for now.
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
          setMainStep("results");
          refreshJobsList();
        } else if (data.status === "error") {
          clearInterval(pollRef.current);
          setError(data.error);
          setMainStep("error");
          refreshJobsList();
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
        setMainStep("error");
      }
    }, 2000);
  }

  async function handleDeleteJob(id) {
    await deleteJob(id);
    setJobsList((prev) => prev.filter((j) => j.id !== id));
    // Deleting whatever is on screen would leave it showing clips whose
    // files no longer exist, so send the user back to a clean state.
    if (id === activeJobId) handleNewClip();
  }

  function handleNewClip() {
    clearInterval(pollRef.current);
    setPendingYouTubeUrl("");
    setActiveJobId(null);
    setJob(null);
    setYoutubeUrl("");
    setError(null);
    setMainStep("url");
    setSidebarOpen(false);
  }

  function handleUrlNext(url) {
    const normalizedUrl = url.trim();
    if (!user) setPendingYouTubeUrl(normalizedUrl);
    else setPendingYouTubeUrl("");
    setYoutubeUrl(normalizedUrl);
    setMainStep("options");
  }

  function handleLandingStart(url) {
    handleUrlNext(url);
    setSignedOutView("auth");
  }

  function handleLandingUrlEdit(value) {
    if (value.trim() === youtubeUrl) return;
    setPendingYouTubeUrl("");
    setYoutubeUrl("");
    setMainStep("url");
  }

  function handleLandingSignIn() {
    setPendingYouTubeUrl("");
    setYoutubeUrl("");
    setMainStep("url");
    setSignedOutView("auth");
  }

  function handleOptionsBack() {
    setPendingYouTubeUrl("");
    setYoutubeUrl("");
    setMainStep("url");
  }

  async function handleSubmitOptions(options) {
    setPendingYouTubeUrl("");
    setError(null);
    setMainStep("loading");
    try {
      const jobId = await createJob({ youtubeUrl, ...options });
      setActiveJobId(jobId);
      refreshJobsList();
      pollJob(jobId);
    } catch (e) {
      setError(e.message);
      setMainStep("url");
    }
  }

  async function handleSelectHistoryJob(id) {
    setPendingYouTubeUrl("");
    setSidebarOpen(false);
    setActiveJobId(id);
    setError(null);
    clearInterval(pollRef.current);
    setMainStep("loading");
    try {
      const data = await getJob(id);
      setJob(data);
      if (data.status === "done") {
        setMainStep("results");
      } else if (data.status === "error") {
        setError(data.error);
        setMainStep("error");
      } else {
        pollJob(id);
      }
    } catch (e) {
      setError(e.message);
      setMainStep("error");
    }
  }

  return (
    <div className="app">
      <div className="app-grain" />
      <div className="app-vignette" />

      {!showingLanding && (
        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      )}

      {authLoading && (
        <div className="centered-shell">
          <span className="stage-text">Loading...</span>
        </div>
      )}

      {!authLoading && !user && (
        <div className={`centered-shell ${signedOutView === "landing" ? "landing-shell" : ""}`}>
          {signedOutView === "landing" ? (
            <Landing
              initialUrl={youtubeUrl}
              onSignIn={handleLandingSignIn}
              onStart={handleLandingStart}
              onUrlEdit={handleLandingUrlEdit}
            />
          ) : (
            <Auth onBack={() => setSignedOutView("landing")} />
          )}
        </div>
      )}

      {!authLoading && user && (
        <div className="app-shell">
          <Sidebar
            jobs={jobsList}
            activeJobId={activeJobId}
            onSelectJob={handleSelectHistoryJob}
            onNewClip={handleNewClip}
            onDeleteJob={handleDeleteJob}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />

          <main className="main-content">
            <div className="main-topbar">
              <button className="menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
                ☰
              </button>
            </div>

            <div className="main-inner">
              {mainStep === "url" && (
                <div style={{ width: "100%", maxWidth: 480 }}>
                  <UrlInput onNext={handleUrlNext} />
                  {error && (
                    <div className="error-box" style={{ maxWidth: 480, marginTop: 16 }}>
                      {error}
                    </div>
                  )}
                </div>
              )}
              {mainStep === "options" && (
                <Options onBack={handleOptionsBack} onSubmit={handleSubmitOptions} />
              )}
              {mainStep === "loading" && <Loading stage={job?.stage} />}
              {mainStep === "results" && job && <Results job={job} onRestart={handleNewClip} />}
              {mainStep === "error" && (
                <div className="card error-view">
                  <h1>Something went wrong</h1>
                  <div className="error-box">{error}</div>
                  <button className="btn-primary" onClick={handleNewClip}>
                    Start a new clip
                  </button>
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
      <path
        d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.15 1.15M4.25 11.75L3.1 12.9M12.9 12.9l-1.15-1.15M4.25 4.25L3.1 3.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M14 9.3A6.2 6.2 0 1 1 6.7 2a5 5 0 0 0 7.3 7.3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
