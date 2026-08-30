import { useState } from "react";
import ClipDetail from "./ClipDetail.jsx";
import { resolveMediaUrl } from "../api.js";

export default function Results({ job, onRestart }) {
  const clips = job.clips || [];
  const [openIndex, setOpenIndex] = useState(null);

  function uploadFor(clip, index) {
    const upload = (job.uploads || job.youtubeUploads || []).find((item) =>
      item.clipIndex === clip.index || item.index === clip.index || item.clipIndex === index + 1,
    ) || {};
    return {
      url: clip.youtubeUrl || clip.uploadedYoutubeUrl || upload.url || upload.youtubeUrl || null,
      status: clip.uploadStatus || upload.status || job.uploadStatus || null,
    };
  }

  return (
    <div className="card wide">
      <div className="top-bar">
        <div>
          <h1>Ravi’s clip set</h1>
          <p className="subtitle">
            {job.sourceTitle ? `From “${job.sourceTitle}”` : "Created from your latest main-channel upload"}
          </p>
        </div>
        <button className="btn-secondary" onClick={onRestart}>
          Back to overview
        </button>
      </div>

      {job.uploadStatus && (
        <div className={`results-upload-summary status-${job.uploadStatus}`}>
          <span />
          {job.uploadStatus === "done" || job.uploadStatus === "published"
            ? "Posted to your clips channel"
            : job.uploadStatus === "error"
            ? "One or more clips could not be posted"
            : job.uploadStatus === "reconcile_required"
            ? "Check your clips channel before retrying — YouTube may have received the upload"
            : "Posting to your clips channel"}
        </div>
      )}
      {job.uploadError && <div className="error-box">{job.uploadError}</div>}

      <div className="results-grid">
        {clips.map((clip, i) => {
          const upload = uploadFor(clip, i);
          return (
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
              {(upload.status || upload.url) && (
                <div className="clip-upload-row">
                  <span className={`clip-upload-status status-${upload.status || "published"}`}>
                    {upload.url
                      ? "Published"
                      : upload.status === "error"
                      ? "Upload failed"
                      : upload.status === "reconcile_required"
                      ? "Check YouTube"
                      : "Uploading"}
                  </span>
                  {upload.url && (
                    <a href={upload.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                      View on YouTube ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
          );
        })}
      </div>

      {openIndex !== null && clips[openIndex] && (
        <ClipDetail clip={clips[openIndex]} rank={openIndex + 1} onClose={() => setOpenIndex(null)} />
      )}
    </div>
  );
}
