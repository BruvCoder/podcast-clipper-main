import { useState } from "react";
import ClipDetail from "./ClipDetail.jsx";
import { resolveMediaUrl } from "../api.js";

export default function Results({ job, onRestart }) {
  const clips = job.clips || [];
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <div className="card wide">
      <div className="top-bar">
        <div>
          <h1>Your clips are ready</h1>
          <p className="subtitle">
            Ranked by predicted view potential{job.sourceTitle ? ` — from "${job.sourceTitle}"` : ""}
          </p>
        </div>
        <button className="btn-secondary" onClick={onRestart}>
          New video
        </button>
      </div>

      <div className="results-grid">
        {clips.map((clip, i) => (
          <div className="clip-card" key={clip.index} onClick={() => setOpenIndex(i)}>
            <div className="clip-card-video-wrap">
              <video src={resolveMediaUrl(clip.url)} preload="metadata" muted />
            </div>
            <div className="clip-meta">
              <span className="rank-badge">
                #{i + 1} · {clip.viralityScore}/100
              </span>
              <p className="clip-title">{clip.title}</p>
              <p className="clip-reason">{clip.reason}</p>
            </div>
          </div>
        ))}
      </div>

      {openIndex !== null && clips[openIndex] && (
        <ClipDetail clip={clips[openIndex]} rank={openIndex + 1} onClose={() => setOpenIndex(null)} />
      )}
    </div>
  );
}