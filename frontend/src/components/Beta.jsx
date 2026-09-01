import { useEffect, useRef, useState } from "react";
import { createBetaJob, getBetaJob, resolveMediaUrl } from "../api.js";
import { describeProgress } from "../progress.js";
import { extractYouTubeVideoId } from "../youtube.js";

// Standalone recruiting page at /beta. It shares the pipeline with the real
// product but nothing else: no Firebase account, no channel connection, no
// sidebar. A tester pastes one link and gets three downloadable clips, which
// is the shortest path from "stranger" to "has seen the output".

const CODE_KEY = "ravi-beta-code";
const POLL_MS = 2000;

function readStoredCode() {
  try {
    return sessionStorage.getItem(CODE_KEY) || "";
  } catch {
    // Privacy modes can disable session storage; the tester just retypes it.
    return "";
  }
}

function storeCode(value) {
  try {
    if (value) sessionStorage.setItem(CODE_KEY, value);
    else sessionStorage.removeItem(CODE_KEY);
  } catch {
    // Not being able to remember the code is survivable.
  }
}

export default function Beta() {
  const [code, setCode] = useState(readStoredCode);
  const [codeDraft, setCodeDraft] = useState("");
  const [url, setUrl] = useState("");
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  function resetToCodeEntry(message) {
    clearInterval(pollRef.current);
    storeCode("");
    setCode("");
    setCodeDraft("");
    setJob(null);
    setBusy(false);
    setError(message);
  }

  function handleCodeSubmit(event) {
    event.preventDefault();
    const trimmed = codeDraft.trim();
    if (!trimmed) return;
    // The code is only proven right by the first real request, so accept it
    // here and let the API reject it if wrong.
    storeCode(trimmed);
    setCode(trimmed);
    setError(null);
  }

  function poll(jobId) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await getBetaJob({ betaCode: code, jobId });
        setJob(data);
        if (data.status === "done" || data.status === "error") {
          clearInterval(pollRef.current);
          setBusy(false);
          if (data.status === "error") setError(data.error || "Something went wrong.");
        }
      } catch (requestError) {
        clearInterval(pollRef.current);
        setBusy(false);
        if (requestError.code === "invalid_beta_code") {
          resetToCodeEntry("Your beta code is no longer valid. Please enter it again.");
          return;
        }
        setError(requestError.message);
      }
    }, POLL_MS);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!extractYouTubeVideoId(trimmed)) {
      setError("Please paste a link to a YouTube video, like https://youtube.com/watch?v=…");
      return;
    }

    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const jobId = await createBetaJob({ betaCode: code, youtubeUrl: trimmed });
      setJob({ id: jobId, status: "queued", stage: "Queued", clips: [] });
      poll(jobId);
    } catch (requestError) {
      setBusy(false);
      if (requestError.code === "invalid_beta_code") {
        resetToCodeEntry("That beta code is not valid. Please check it and try again.");
        return;
      }
      setError(requestError.message);
    }
  }

  function handleAnother() {
    clearInterval(pollRef.current);
    setJob(null);
    setUrl("");
    setError(null);
    setBusy(false);
  }

  if (!code) {
    return (
      <BetaShell>
        <p className="beta-lede">
          Paste one podcast episode. Ravi finds the three strongest moments, reframes them
          vertically, burns in captions, and hands you the files.
        </p>
        <form className="beta-form" onSubmit={handleCodeSubmit}>
          <input
            className="beta-input"
            type="text"
            value={codeDraft}
            onChange={(event) => setCodeDraft(event.target.value)}
            placeholder="Beta access code"
            aria-label="Beta access code"
            autoComplete="off"
            autoFocus
          />
          <button className="btn-primary" type="submit" disabled={!codeDraft.trim()}>
            Continue
          </button>
        </form>
        {error && <div className="error-box">{error}</div>}
        <p className="beta-note">Don’t have a code? Reply to the message that sent you here.</p>
      </BetaShell>
    );
  }

  const clips = job?.clips || [];
  const finished = job?.status === "done";
  const running = Boolean(job) && !finished && job.status !== "error";

  return (
    <BetaShell>
      {!job && (
        <>
          <p className="beta-lede">
            Paste a YouTube episode. You’ll get <strong>three vertical clips</strong> with captions,
            roughly 30 seconds each, ready to download.
          </p>
          <form className="beta-form" onSubmit={handleSubmit}>
            <input
              className="beta-input"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
              aria-label="YouTube video link"
              autoComplete="off"
              autoFocus
            />
            <button className="btn-primary" type="submit" disabled={busy || !url.trim()}>
              {busy ? "Starting…" : "Make my clips"}
            </button>
          </form>
          <p className="beta-note">
            A full episode takes a while — it gets transcribed end to end before the best moments
            can be picked. Keep this tab open.
          </p>
        </>
      )}

      {running && (
        <>
          <BetaProgress job={job} />
          {/* The wait is minutes, not seconds, and the bar sits still during
              transcription. Say so, or it reads as broken. */}
          <p className="beta-note">
            This takes a few minutes — the whole episode is transcribed before the best moments
            can be picked. Keep this tab open.
          </p>
        </>
      )}

      {finished && (
        <>
          <div className="beta-done-head">
            <h2>Your {clips.length === 1 ? "clip" : `${clips.length} clips`} are ready</h2>
            {job.sourceTitle && <p className="beta-source">From “{job.sourceTitle}”</p>}
          </div>
          <div className="beta-clips">
            {clips.map((clip, index) => (
              <figure className="beta-clip" key={clip.index ?? index}>
                <video
                  src={resolveMediaUrl(clip.url)}
                  controls
                  playsInline
                  preload="metadata"
                />
                <figcaption>
                  <span className="beta-rank">
                    #{index + 1} · {clip.viralityScore}/100
                  </span>
                  <p className="beta-clip-title">{clip.title}</p>
                  <a
                    className="btn-secondary beta-download"
                    href={`${resolveMediaUrl(clip.url)}?download=1`}
                  >
                    Download
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
          <button className="btn-secondary" onClick={handleAnother}>
            Try another video
          </button>
        </>
      )}

      {error && (
        <>
          <div className="error-box">{error}</div>
          {job && (
            <button className="btn-secondary" onClick={handleAnother}>
              Try another video
            </button>
          )}
        </>
      )}
    </BetaShell>
  );
}

function BetaProgress({ job }) {
  const { label, percent } = describeProgress(job.stage);
  return (
    <div className="beta-progress">
      <div className="beta-progress-track">
        <div
          className={`beta-progress-fill ${percent == null ? "indeterminate" : ""}`}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="beta-progress-label">
        {label}
        {percent != null && <span className="beta-progress-percent">{percent}%</span>}
      </p>
    </div>
  );
}

function BetaShell({ children }) {
  return (
    <div className="beta-page">
      <div className="beta-card">
        <header className="beta-header">
          <span className="beta-badge">Beta</span>
          <h1>Turn one episode into three clips</h1>
        </header>
        {children}
      </div>
    </div>
  );
}
