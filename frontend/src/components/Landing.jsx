import Waveform from "./Waveform.jsx";

const FEATURES = [
  {
    title: "Paste a link",
    text: "Drop in any YouTube podcast episode — that's the whole input.",
  },
  {
    title: "AI finds the moments",
    text: "Gemini reads the full transcript and picks the strongest, most self-contained hooks.",
  },
  {
    title: "Ready to post",
    text: "Reframed to 9:16, captioned, and rendered — download and post straight away.",
  },
];

export default function Landing({ onGetStarted }) {
  return (
    <div className="landing">
      <div className="landing-header">
        <div className="brand">
          <Waveform className="brand-mark" bars={5} />
          <span className="brand-name">
            Podcast<span className="brand-accent">Clipper</span>
          </span>
        </div>
        <button className="btn-ghost" onClick={onGetStarted}>
          Sign in
        </button>
      </div>

      <div className="landing-hero">
        <Waveform className="hero-waveform" bars={40} />
        <span className="landing-eyebrow">AI-powered podcast clipping</span>
        <h1 className="landing-title">Turn long podcasts into scroll-stopping clips</h1>
        <p className="landing-subtitle">
          Paste a YouTube episode and get back a set of ranked, captioned, vertical clips —
          picked automatically for what's actually worth posting.
        </p>
        <button className="btn-primary landing-cta" onClick={onGetStarted}>
          Get started
        </button>
      </div>

      <div className="feature-grid">
        {FEATURES.map((f, i) => (
          <div className="feature-card" key={f.title}>
            <span className="feature-index">{String(i + 1).padStart(2, "0")}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
