import Waveform from "./Waveform.jsx";
import YouTubeIcon from "./YouTubeIcon.jsx";

const FEATURES = [
  {
    title: "Every upload starts the workflow",
    text: "Add your main channel once. Ravi watches for new public videos, so there is no link to paste and no job to start.",
  },
  {
    title: "Engaging clips, made for you",
    text: "Ravi finds the strongest hooks, reframes them for 9:16, and adds polished captions without a timeline to edit.",
  },
  {
    title: "Published to your clips channel",
    text: "Finished clips are uploaded to your connected clips channel automatically, with the visibility and style you choose.",
  },
];

const STEPS = [
  ["Add your main channel", "Share the public channel link Ravi should watch for new uploads."],
  ["Connect your clips channel", "Choose the YouTube channel where Ravi should publish."],
  ["Set your clip style", "Choose clip count, length, framing, captions, and visibility."],
];

function ArrowIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4 9h10M10 5l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExampleTransformation() {
  return (
    <section className="landing-transform-demo" aria-label="Example transformation from a main-channel video to a vertical clip">
      <figure className="demo-source">
        <div className="demo-landscape-frame">
          <img
            src="/podcast-demo-frame.jpg"
            alt="Two creators recording a long-form video"
            width="1672"
            height="941"
            decoding="async"
            fetchpriority="high"
          />
          <span className="demo-play" aria-hidden="true">▶</span>
          <span className="demo-time">1:24:18</span>
          <span className="demo-video-progress" aria-hidden="true"><i /></span>
        </div>
        <figcaption>
          <strong>Your latest upload</strong>
          <span>Main channel · 16:9</span>
        </figcaption>
      </figure>

      <div className="demo-transform-arrow" role="img" aria-label="Ravi selects and reframes the best moment">
        <span className="demo-arrow-line" aria-hidden="true" />
        <span className="demo-arrow-icon" aria-hidden="true"><ArrowIcon /></span>
        <p>Ravi picks &amp; reframes</p>
      </div>

      <figure className="demo-output">
        <div className="demo-phone-frame">
          <span className="demo-phone-speaker" aria-hidden="true" />
          <img
            src="/podcast-demo-frame.jpg"
            alt="The speaking host reframed into a vertical social clip"
            width="1672"
            height="941"
            decoding="async"
          />
          <span className="demo-phone-shade" aria-hidden="true" />
          <span className="demo-viral-score"><strong>94</strong> viral score</span>
          <span className="demo-play demo-phone-play" aria-hidden="true">▶</span>
          <span className="demo-caption">
            THE BEST IDEAS<br />
            <em>DESERVE A CLIP</em>
          </span>
          <span className="demo-video-progress demo-phone-progress" aria-hidden="true"><i /></span>
        </div>
        <figcaption>
          <strong>Your clips channel</strong>
          <span>9:16 · captioned &amp; ready</span>
        </figcaption>
      </figure>
    </section>
  );
}

function ConnectChannelCta({ onConnect }) {
  return (
    <div className="landing-connect-wrap">
      <button className="landing-connect-cta" type="button" onClick={onConnect}>
        <span className="landing-connect-icon">
          <YouTubeIcon />
        </span>
        <span>Connect your clips channel</span>
        <span className="landing-submit-arrow"><ArrowIcon /></span>
      </button>
      <span className="landing-connect-help">Sign in to connect the channel where Ravi publishes.</span>
    </div>
  );
}

export default function Landing({ onConnect, onSignIn }) {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="brand landing-brand" aria-label="Ravi home">
          <span className="landing-brand-mark"><Waveform className="brand-mark" bars={7} /></span>
          <span className="brand-name">Ra<span className="brand-accent">vi</span></span>
        </div>

        <nav className="landing-nav" aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How Ravi works</a>
          <button className="landing-signin" type="button" onClick={onSignIn}>
            Sign in <ArrowIcon />
          </button>
        </nav>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <h1 id="landing-title" className="landing-title">
            Meet Ravi. Your <em>personal clipping agent.</em>
          </h1>
          <p className="landing-subtitle">
            Ravi watches your main channel and posts the most viral-ready moments to your clips channel.
          </p>

          <ConnectChannelCta onConnect={onConnect} />

          <div className="landing-trust-row" aria-label="Product highlights">
            <span><img src="/ravi-watch.png" alt="" width="56" height="56" /> Watches every new upload</span>
            <span><img src="/ravi-create.png" alt="" width="56" height="56" /> Creates engaging clips</span>
            <span><img src="/ravi-grow.png" alt="" width="56" height="56" /> Posts to your clips channel</span>
          </div>
        </section>

        <ExampleTransformation />

        <section className="landing-section landing-features" id="features">
          <div className="landing-section-head">
            <h2>A clipping partner for every upload.</h2>
            <p>You focus on your next main-channel video. Ravi watches, clips, captions, and publishes after every new upload.</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((feature, index) => (
              <article className="feature-card" key={feature.title}>
                <div className="feature-card-top">
                  <Waveform className="feature-waveform" bars={index === 1 ? 14 : 10} />
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-steps" id="how-it-works">
          <div className="landing-section-head compact">
            <h2>Connect once. Keep your clips channel moving.</h2>
          </div>
          <div className="steps-row">
            {STEPS.map(([title, text]) => (
              <article className="step-card" key={title}>
                <div className="step-card-body">
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-bottom-cta">
          <Waveform className="bottom-cta-wave" bars={32} />
          <h2>Your next upload deserves its own clip campaign.</h2>
          <button type="button" onClick={onConnect}>
            Connect your clips channel <ArrowIcon />
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="brand landing-brand">
          <span className="landing-brand-mark"><Waveform className="brand-mark" bars={7} /></span>
          <span className="brand-name">Ra<span className="brand-accent">vi</span></span>
        </div>
        <span>Your personal clipping partner.</span>
        <span>© {new Date().getFullYear()} Ravi</span>
      </footer>
    </div>
  );
}
