import { useState } from "react";

const COLOR_PRESETS = [
  "#FFFFFF",
  "#FFD400",
  "#00E0FF",
  "#FF3366",
  "#7CFF6B",
  "#FF9F1C",
];

const CROP_MODES = [
  {
    value: "pad",
    label: "Fit (padded)",
    hint: "Never crops anything out — fills the frame with a blurred background. Safe for any shot.",
  },
  {
    value: "crop",
    label: "Zoomed crop",
    hint: "Tighter, center-cropped look. Only use if the source is a single, centered speaker.",
  },
];

export default function Options({ onBack, onSubmit }) {
  const [numClips, setNumClips] = useState(5);
  const [clipLengthSec, setClipLengthSec] = useState(45);
  const [subtitleColor, setSubtitleColor] = useState("#FFFFFF");
  const [cropMode, setCropMode] = useState("pad");

  return (
    <div className="card">
      <h1>Set your preferences</h1>
      <p className="subtitle">We'll pick the best moments and cut them to fit these settings.</p>

      <div className="field">
        <label>
          <span>Number of clips</span>
          <span>{numClips}</span>
        </label>
        <input
          type="range"
          min="1"
          max="10"
          value={numClips}
          onChange={(e) => setNumClips(Number(e.target.value))}
        />
      </div>

      <div className="field">
        <label>
          <span>Clip length</span>
          <span>{clipLengthSec}s</span>
        </label>
        <input
          type="range"
          min="15"
          max="90"
          step="5"
          value={clipLengthSec}
          onChange={(e) => setClipLengthSec(Number(e.target.value))}
        />
      </div>

      <div className="field">
        <label>
          <span>Frame style</span>
        </label>
        <div className="crop-mode-row">
          {CROP_MODES.map((mode) => (
            <button
              type="button"
              key={mode.value}
              className={`crop-mode-option ${cropMode === mode.value ? "selected" : ""}`}
              onClick={() => setCropMode(mode.value)}
            >
              <span className="crop-mode-label">{mode.label}</span>
              <span className="crop-mode-hint">{mode.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>
          <span>Subtitle color</span>
        </label>
        <div className="color-row">
          {COLOR_PRESETS.map((c) => (
            <div
              key={c}
              className={`swatch ${subtitleColor === c ? "selected" : ""}`}
              style={{ background: c, boxShadow: "0 0 0 1px var(--border-strong) inset" }}
              onClick={() => setSubtitleColor(c)}
            />
          ))}
          <input
            type="color"
            value={subtitleColor}
            onChange={(e) => setSubtitleColor(e.target.value)}
            style={{ width: 34, height: 34, padding: 0, border: "none", background: "none" }}
          />
        </div>
      </div>

      <button
        className="btn-primary"
        onClick={() => onSubmit({ numClips, clipLengthSec, subtitleColor, cropMode })}
      >
        Generate clips
      </button>
      <button className="btn-secondary" style={{ width: "100%", marginTop: 10 }} onClick={onBack}>
        Back
      </button>
    </div>
  );
}