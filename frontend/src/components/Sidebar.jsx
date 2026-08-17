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

export default function Sidebar({ jobs, activeJobId, onSelectJob, onNewClip, open, onClose }) {
  const { user, signOut } = useAuth();

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="brand">
            <Waveform className="brand-mark" bars={5} />
            <span className="brand-name">
              Podcast<span className="brand-accent">Clipper</span>
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
            <button
              key={j.id}
              className={`history-item ${j.id === activeJobId ? "active" : ""}`}
              onClick={() => onSelectJob(j.id)}
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
            </button>
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
