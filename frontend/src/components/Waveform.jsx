// A fixed set of organic bar heights (not a real waveform — just gives the
// motif a natural, non-repeating rhythm instead of a mechanical pattern).
// This is the app's recurring visual signature: appears ambiently in the
// background, as the wordmark, and as the loading indicator.
const BAR_HEIGHTS = [
  4, 7, 13, 11, 18, 18, 15, 22, 15, 21, 15, 14, 18, 21, 12, 12, 15, 17, 13, 11, 14, 8, 11, 8, 6, 6, 5,
  4, 5, 8, 10, 11, 15, 12, 13, 16, 24, 21, 19, 22, 18, 14, 15, 10, 5, 7, 10, 16, 18, 16, 26, 15, 20, 26,
  17, 22, 15, 24, 25, 22, 26, 18, 23, 21, 20, 18, 22, 22, 16, 16, 10, 13,
];

export default function Waveform({ className = "", active = false, bars, scale = 1 }) {
  const heights = bars ? BAR_HEIGHTS.slice(0, bars) : BAR_HEIGHTS;
  return (
    <div
      className={`waveform ${active ? "waveform-active" : ""} ${className}`}
      style={{ "--wf-scale": scale }}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className="waveform-bar"
          style={{ "--wf-h": `${h}px`, animationDelay: `${(i % 14) * 0.07}s` }}
        />
      ))}
    </div>
  );
}
