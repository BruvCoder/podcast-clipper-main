import { useState } from "react";
import { resolveMediaUrl } from "../api.js";

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ScoreRing({ score }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="score-ring">
      <svg viewBox="0 0 72 72" width="72" height="72">
        <circle className="score-ring-track" cx="36" cy="36" r={radius} />
        <circle
          className="score-ring-value"
          cx="36"
          cy="36"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="score-ring-label">
        <span className="score-ring-number">{score}</span>
      </div>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M4.5 7 8 10.5 11.5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.5 13h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function ClipDetail({ clip, rank, onClose }) {
  const [wordsOnly, setWordsOnly] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // A plain <a download> is silently ignored by browsers when the URL is
  // cross-origin (frontend and backend live on different Railway domains),
  // so it just navigates to the video instead of saving it. Fetching the
  // clip as a blob and downloading that always triggers a real save.
  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(resolveMediaUrl(clip.url));
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${(clip.title || "clip").replace(/[^\w\- ]+/g, "").trim() || "clip"}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="clip-detail-overlay" onClick={onClose}>
      <div className="clip-detail" onClick={(e) => e.stopPropagation()}>
        <button className="clip-detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="clip-detail-media">
          <video src={resolveMediaUrl(clip.url)} controls autoPlay preload="metadata" />
          <span className="clip-detail-duration">{formatTime(clip.durationSec)}</span>
        </div>

        <div className="clip-detail-info">
          <div className="clip-detail-scroll">
            <div className="clip-detail-top">
              <div>
                <span className="clip-detail-eyebrow">
                  Clip {String(rank).padStart(2, "0")} · {clip.durationSec}s
                </span>
                <h2>{clip.title}</h2>
              </div>
              <ScoreRing score={clip.viralityScore} />
            </div>

            {clip.hook && (
              <div className="hook-quote">
                <span className="hook-mark">“</span>
                <p>{clip.hook}</p>
              </div>
            )}

            <div className="detail-section">
              <span className="detail-section-label">Why this clip</span>
              <p className="clip-detail-reason">{clip.reason}</p>
            </div>

            <div className="detail-section transcript-section">
              <div className="transcript-header">
                <span className="detail-section-label">Transcript</span>
                <label className="pill-toggle">
                  <input type="checkbox" checked={wordsOnly} onChange={(e) => setWordsOnly(e.target.checked)} />
                  <span className="pill-toggle-track">
                    <span className="pill-toggle-thumb" />
                  </span>
                  Hide timestamps
                </label>
              </div>

              <div className="transcript-timeline">
                {(clip.transcript || []).map((cue, i) => (
                  <div className="transcript-row" key={i}>
                    {!wordsOnly && <span className="transcript-time">{formatTime(cue.start)}</span>}
                    <span className="transcript-text">{cue.text}</span>
                  </div>
                ))}
                {!clip.transcript?.length && (
                  <p className="cue-empty">No transcript available for this clip.</p>
                )}
              </div>
            </div>
          </div>

          <div className="clip-detail-actions">
            <button className="btn-primary download-btn" onClick={handleDownload} disabled={downloading}>
              <DownloadIcon />
              {downloading ? "Preparing download…" : "Download clip"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
