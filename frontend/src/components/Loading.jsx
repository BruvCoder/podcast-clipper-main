import Waveform from "./Waveform.jsx";

export default function Loading({ stage }) {
  return (
    <div className="card loading-wrap">
      <Waveform active className="loading-waveform" />
      <h1>Working on your clips</h1>
      <p className="stage-text">{stage || "Starting..."}</p>
    </div>
  );
}