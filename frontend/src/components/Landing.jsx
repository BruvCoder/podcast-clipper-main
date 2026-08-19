import Waveform from "./Waveform.jsx";

const FEATURES = [
  {
    title: "AI-picked moments",
    text: "Gemini reads the full transcript and finds the handful of moments that actually hook — not just anything that sounds relevant.",
  },
  {
    title: "Ranked by virality score",
    text: "Every clip gets a predicted engagement score, so you always know which one to post first.",
  },
  {
    title: "Auto vertical reframing",
    text: "Crops or pads to 9:16 automatically. Safe for any shot, no manual editing required.",
  },
  {
    title: "Word-by-word captions",
    text: "Bold, animated captions with the spoken word highlighted as it's said — the same style top clip channels use.",
  },
  {
    title: "Full transcript included",
    text: "Every clip comes with a synced, timestamped transcript for review or repurposing.",
  },
  {
    title: "One-click download",
    text: "Grab the finished MP4 straight from your browser, ready to post.",
  },
];

const STEPS = [
  {
    title: "Paste a link",
    text: "Drop in any YouTube podcast episode — that's the whole input.",
  },
  {
    title: "Set your preferences",
    text: "Choose how many clips, how long, and the caption style.",
  },
  {
    title: "AI finds the moments",
    text: "Gemini reads the transcript and picks the strongest, self-contained hooks.",
  },
  {
    title: "Download & post",
    text: "Reframed, captioned, and rendered — ready straight away.",
  },
];

function PhoneMock() {
  return (
    <div className="phone-mock" aria-hidden="true">
      <div className="phone-mock-badge">
        <span className="phone-mock-badge-number">94</span>
        <span className="phone-mock-badge-label">Score</span>
      </div>
      <div className="phone-mock-screen">
        <div className="phone-mock-scene" />
        <div className="phone-mock-play">▶</div>
        <div className="phone-mock-caption">
          <span>THIS IS THE</span> <span className="phone-mock-caption-hot">MOMENT</span>
          <br />
          <span>THAT HOOKS THEM</span>
        </div>
      </div>
    </div>
  );
}

export default function Landing({ onGetStarted }) {
  return (
    <div className="landing">
      <div className="landing-header">
        <div className="brand">
          <Waveform className="brand-mark" bars={5} />
          <span className="brand-name">
            VOD<span className="brand-accent">Clipper</span>
          </span>
        </div>
        <button className="btn-ghost" onClick={onGetStarted}>
          Sign in
        </button>
      </div>

      <div className="landing-hero">
        <div className="landing-hero-copy">
          <span className="landing-eyebrow">AI-powered podcast clipping</span>
          <h1 className="landing-title">Turn long podcasts into scroll-stopping clips</h1>
          <p className="landing-subtitle">
            Paste a YouTube episode and get back a set of ranked, captioned, vertical clips —
            picked automatically for what's actually worth posting.
          </p>
          <button className="btn-primary landing-cta" onClick={onGetStarted}>
            Get started
          </button>
          <div className="landing-trust-row">
            <span>No editing skills needed</span>
            <span aria-hidden="true">·</span>
            <span>Ranked by predicted engagement</span>
          </div>
        </div>

        <div className="landing-hero-visual">
          <PhoneMock />
        </div>
      </div>

      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-eyebrow">Features</span>
          <h2>Everything you need to go viral</h2>
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
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-eyebrow">How it works</span>
          <h2>From link to posted clip in minutes</h2>
        </div>
        <div className="steps-row">
          {STEPS.map((s, i) => (
            <div className="step-card" key={s.title}>
              <span className="step-number">{String(i + 1).padStart(2, "0")}</span>
              <div className="step-card-body">
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
