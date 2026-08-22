import Waveform from "./Waveform.jsx";
import { describeProgress } from "../progress.js";

export default function Loading({ stage }) {
  const { label, percent } = describeProgress(stage);
  const known = typeof percent === "number";

  return (
    <div className="card loading-wrap">
      <Waveform active className="loading-waveform" />
      <h1>Working on your clips</h1>

      <div className="progress-block">
        <div className="progress-row">
          <span className="stage-text">{label}</span>
          {known && <span className="progress-percent">{percent}%</span>}
        </div>
        <div
          className={`progress-track ${known ? "" : "indeterminate"}`}
          role="progressbar"
          aria-label="Clipping progress"
          aria-valuenow={known ? percent : undefined}
          aria-valuemin={known ? 0 : undefined}
          aria-valuemax={known ? 100 : undefined}
        >
          <div className="progress-fill" style={known ? { width: `${percent}%` } : undefined} />
        </div>
      </div>
    </div>
  );
}
