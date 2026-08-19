import { useState } from "react";
import Waveform from "./Waveform.jsx";
import { useAuth } from "../AuthContext.jsx";

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function Sidebar({ jobs, activeJobId, onSelectJob, onNewClip, onDeleteJob, open, onClose }) {
  const { user, signOut } = useAuth();
  // Two-step delete: the trash icon arms, a second click confirms. Avoids a
  // modal for a small action while still not deleting on a stray click.
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  async function handleDelete(e, id) {
    e.stopPropagation();
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setDeletingId(id);
    try {
      await onDeleteJob(id);
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="brand">
            <Waveform className="brand-mark" bars={5} />
            <span className="brand-name">
              VOD<span className="brand-accent">Clipper</span>
            </span>
          </div>
        </div>

        <button className="new-clip-btn" onClick={onNewClip}>
          <span className="new-clip-plus">+</span> New clip
        </button>

        <div className="sidebar-history">
          <span className="sidebar-label">History</span>
          {jobs.length === 0 && <p className="sidebar-empty">Your clipped episodes will show up here.</p>}
          {jobs.map((j) => (
            <div
              key={j.id}
              className={`history-item ${j.id === activeJobId ? "active" : ""}`}
              onClick={() => onSelectJob(j.id)}
              onMouseLeave={() => confirmingId === j.id && setConfirmingId(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectJob(j.id);
                }
              }}
              title={j.sourceTitle || "Untitled"}
            >
              <span className={`history-dot status-${j.status}`} />
              <span className="history-text">
                <span className="history-title">{j.sourceTitle || "Untitled episode"}</span>
                <span className="history-meta">
                  {j.status === "done"
                    ? `${j.clipCount} clip${j.clipCount === 1 ? "" : "s"}`
                    : j.status === "error"
                    ? "Failed"
                    : "Processing…"}
                  {" · "}
                  {timeAgo(j.createdAt)}
                </span>
              </span>
              <button
                className={`history-delete ${confirmingId === j.id ? "confirming" : ""}`}
                onClick={(e) => handleDelete(e, j.id)}
                disabled={deletingId === j.id}
                aria-label={confirmingId === j.id ? "Confirm delete" : "Delete this clip set"}
                title={confirmingId === j.id ? "Click again to delete" : "Delete"}
              >
                {confirmingId === j.id ? "Delete?" : <TrashIcon />}
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-account">
          <div className="account-avatar">{(user?.email || "?")[0].toUpperCase()}</div>
          <span className="account-email">{user?.email || "Signed in"}</span>
          <button className="account-signout" onClick={signOut} title="Sign out" aria-label="Sign out">
            <SignOutIcon />
          </button>
        </div>
      </aside>
    </>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M6 4V2.8c0-.44.36-.8.8-.8h2.4c.44 0 .8.36.8.8V4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M3.8 4l.5 8.3c.03.5.45.9.95.9h5.5c.5 0 .92-.4.95-.9L12.2 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.6 6.7v4M9.4 6.7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M10.5 11.5L14 8l-3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
