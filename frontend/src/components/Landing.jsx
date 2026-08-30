import { useEffect, useState } from "react";
import { isValidYouTubeUrl } from "../youtube.js";
import Waveform from "./Waveform.jsx";

const FEATURES = [
  {
    label: "Built for your channel",
    title: "Every upload has more to give",
    text: "Give Ravi a new main-channel video and turn one upload into a full set of short-form opportunities.",
  },
  {
    label: "Find the moment",
    title: "Engaging clips, made for you",
    text: "Ravi finds the strongest hooks, reframes them for 9:16, and adds polished captions without a timeline to edit.",
  },
  {
    label: "Ready to publish",
    title: "Ready for your clips channel",
    text: "Finished clips come back ready for your clips channel, so every main-channel upload keeps working after publish day.",
  },
];

const STEPS = [
  ["01", "Paste your latest upload", "Give Ravi any public video from your main channel."],
  ["02", "Choose the output", "Set the clip count, length, and style you want."],
  ["03", "Ravi gets to work", "The best moments are selected, reframed, captioned, and packaged."],
  ["04", "Publish your clips", "Download polished vertical videos ready for your clips channel."],
];

function ArrowIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4 9h10M10 5l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 8.2 2.3 2.3L12 5.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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

function LinkForm({ url, setUrl, touched, setTouched, onStart, onUrlEdit }) {
  const normalizedUrl = url.trim();
  const isValid = isValidYouTubeUrl(normalizedUrl);
  const showError = touched && !isValid;

  function handleSubmit(event) {
    event.preventDefault();
    setTouched(true);
    if (isValid) onStart(normalizedUrl);
  }

  return (
    <form className="landing-url-form" onSubmit={handleSubmit} noValidate>
      <div className={`landing-url-control ${showError ? "has-error" : ""}`}>
        <span className="landing-url-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M8.1 11.9 11.9 8M6.4 13.6 5.2 14.8a3.4 3.4 0 0 1-4.8-4.8l3-3a3.4 3.4 0 0 1 4.8 0M13.6 6.4l1.2-1.2A3.4 3.4 0 1 1 19.6 10l-3 3a3.4 3.4 0 0 1-4.8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <label className="sr-only" htmlFor="landing-youtube-url">YouTube video URL</label>
        <input
          id="landing-youtube-url"
          className="landing-url-input"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="Paste a YouTube video link to try Ravi"
          value={url}
          aria-invalid={showError}
          aria-describedby={showError ? "landing-url-error" : "landing-url-help"}
          onChange={(event) => {
            setUrl(event.target.value);
            onUrlEdit?.(event.target.value);
          }}
          onBlur={() => setTouched(true)}
        />
        <button className="landing-url-submit" type="submit">
          <span>Let Ravi clip it</span>
          <span className="landing-submit-arrow"><ArrowIcon /></span>
        </button>
      </div>
      <div className="landing-form-message" aria-live="polite">
        {showError ? (
          <span id="landing-url-error" className="landing-url-error">
            {normalizedUrl ? "Enter a valid YouTube video link to continue." : "Paste a YouTube video link to continue."}
          </span>
        ) : (
          <span id="landing-url-help">Try Ravi now with any public video. You’ll choose the output next.</span>
        )}
      </div>
    </form>
  );
}

export default function Landing({ initialUrl = "", onStart, onSignIn, onUrlEdit }) {
  const [url, setUrl] = useState(initialUrl);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

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
            Give Ravi a video from your main channel. Your clipping partner finds the strongest moments, creates engaging vertical clips, and gets them ready for your clips channel while you focus on the next upload.
          </p>

          <LinkForm
            url={url}
            setUrl={setUrl}
            touched={touched}
            setTouched={setTouched}
            onStart={onStart}
            onUrlEdit={onUrlEdit}
          />

          <div className="landing-trust-row" aria-label="Product highlights">
            <span><CheckIcon /> Made for every upload</span>
            <span><CheckIcon /> Creates engaging clips</span>
            <span><CheckIcon /> Ready for your clips channel</span>
          </div>
        </section>

        <ExampleTransformation />

        <section className="landing-section landing-features" id="features">
          <div className="landing-section-head">
            <h2>A clipping partner for every upload.</h2>
            <p>You focus on the main channel. Ravi handles the repetitive work that turns every video into a steady short-form presence.</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((feature, index) => (
              <article className="feature-card" key={feature.title}>
                <div className="feature-card-top">
                  <span className="feature-index">0{index + 1}</span>
                  <Waveform className="feature-waveform" bars={index === 1 ? 14 : 10} />
                </div>
                <span className="feature-label">{feature.label}</span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-steps" id="how-it-works">
          <div className="landing-section-head compact">
            <h2>Give Ravi a video. Keep your clips channel moving.</h2>
          </div>
          <div className="steps-row">
            {STEPS.map(([number, title, text]) => (
              <article className="step-card" key={number}>
                <span className="step-number">{number}</span>
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
          <h2>Give Ravi a video. Get your best clips back.</h2>
          <button type="button" onClick={() => document.getElementById("landing-youtube-url")?.focus()}>
            Try Ravi with a link <ArrowIcon />
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
