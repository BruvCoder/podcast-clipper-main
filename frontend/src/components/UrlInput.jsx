import { useState } from "react";
import Waveform from "./Waveform.jsx";
import { isValidYouTubeUrl } from "../youtube.js";

export default function UrlInput({ onNext }) {
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  const isValid = isValidYouTubeUrl(url);

  return (
    <div className="card hero-card">
      <Waveform className="hero-waveform" />
      <h1>Turn any podcast into clips</h1>
      <p className="subtitle">Paste a YouTube video link to get started.</p>

      <input
        type="url"
        placeholder="https://www.youtube.com/watch?v=..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => setTouched(true)}
        onKeyDown={(e) => e.key === "Enter" && isValid && onNext(url.trim())}
      />
      {touched && !isValid && url.length > 0 && (
        <div className="error-box">That doesn't look like a valid YouTube URL.</div>
      )}

      <button className="btn-primary" disabled={!isValid} onClick={() => onNext(url.trim())}>
        Next
      </button>
    </div>
  );
}
