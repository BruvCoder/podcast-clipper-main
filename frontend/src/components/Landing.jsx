import Waveform from "./Waveform.jsx";

const FEATURES = [
  {
    title: "AI-picked moments",
    text: "AI reads the full transcript and finds the handful of moments that actually hook — not just anything that sounds relevant.",
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
    text: "AI reads the transcript and picks the strongest, self-contained hooks.",
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
          <span className="landing-eyebrow">Before &amp; after</span>
          <h2>The same second of footage, reframed</h2>
          <p className="landing-section-sub">
            A widescreen episode goes in. A vertical, captioned clip comes out — cropped to the
            speaker, with the spoken word highlighted as it lands.
          </p>
        </div>

        <div className="ba-row">
          <figure className="ba-item ba-before">
            <div className="ba-frame ba-frame-wide">
              <img
                src="/demo-before.jpg"
                alt="A frame from the original widescreen podcast episode"
                loading="lazy"
                width="960"
                height="540"
              />
            </div>
            <figcaption>
              <span className="ba-tag">Before</span>
              <span className="ba-meta">16:9 source</span>
            </figcaption>
          </figure>

          <div className="ba-arrow" aria-hidden="true">
            <svg viewBox="0 0 40 24" fill="none">
              <path
                d="M2 12h33M27 4l8 8-8 8"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <figure className="ba-item ba-after">
            <div className="ba-frame ba-frame-tall">
              <img
                src="/demo-after.jpg"
                alt="The same frame as a vertical clip with a burned-in caption"
                loading="lazy"
                width="540"
                height="960"
              />
            </div>
            <figcaption>
              <span className="ba-tag ba-tag-accent">After</span>
              <span className="ba-meta">9:16, captioned</span>
            </figcaption>
          </figure>
        </div>

        <p className="ba-note">Generated by VOD Clipper from a publicly available YouTube episode.</p>
      </section>

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

      <section className="landing-section landing-close">
        <div className="close-panel">
          <Waveform className="close-mark" bars={5} />
          <h2>Ready to clip your first episode?</h2>
          <p>
            Sign in to get started — paste a YouTube link and your first set of ranked, captioned
            clips is minutes away.
          </p>
          <button className="btn-primary close-cta" onClick={onGetStarted}>
            Sign in to get started
          </button>
          {/* Deliberately not a pricing claim — billing can be switched on
              without anyone remembering to edit this line. */}
          <span className="close-note">Works with any public YouTube episode</span>
        </div>
      </section>
    </div>
  );
}
