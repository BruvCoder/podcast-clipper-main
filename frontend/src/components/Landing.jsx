import { useEffect, useState } from "react";
import { isValidYouTubeUrl } from "../youtube.js";
import Waveform from "./Waveform.jsx";

const FEATURES = [
  {
    label: "Find the hook",
    title: "AI-picked moments",
    text: "The full transcript is analyzed to surface sharp, self-contained moments people will actually watch.",
  },
  {
    label: "Polish the cut",
    title: "Captions and reframing",
    text: "Each clip is resized for 9:16 and finished with animated, word-by-word captions automatically.",
  },
  {
    label: "Post with confidence",
    title: "Ranked by potential",
    text: "A clear virality score helps you choose the strongest clip first, then download it ready to publish.",
  },
];

const STEPS = [
  ["01", "Paste a link", "Add any public YouTube video."],
  ["02", "Choose the output", "Set clip count, length, and style."],
  ["03", "Let AI find it", "We identify, crop, and caption the best moments."],
  ["04", "Download and post", "Get finished vertical MP4s, ready to share."],
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

function PhoneMock() {
  return (
    <div className="phone-mock" aria-hidden="true">
      <div className="phone-mock-badge">
        <span className="phone-mock-badge-number">94</span>
        <span className="phone-mock-badge-label">Viral score</span>
      </div>
      <div className="phone-mock-screen">
        <div className="phone-mock-scene" />
        <div className="phone-mock-speaker" />
        <div className="phone-mock-play">▶</div>
        <div className="phone-mock-caption">
          <span>THIS IS THE</span> <span className="phone-mock-caption-hot">MOMENT</span>
          <br />
          <span>THAT HOOKS THEM</span>
        </div>
        <div className="phone-mock-progress"><span /></div>
      </div>
    </div>
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
          placeholder="Paste a YouTube video link"
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
          <span>Create my clips</span>
          <span className="landing-submit-arrow"><ArrowIcon /></span>
        </button>
      </div>
      <div className="landing-form-message" aria-live="polite">
        {showError ? (
          <span id="landing-url-error" className="landing-url-error">
            {normalizedUrl ? "Enter a valid YouTube video link to continue." : "Paste a YouTube video link to continue."}
          </span>
        ) : (
          <span id="landing-url-help">Start here. You’ll choose clip length and style next.</span>
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
        <div className="brand landing-brand" aria-label="VOD Clipper home">
          <span className="landing-brand-mark"><Waveform className="brand-mark" bars={7} /></span>
          <span className="brand-name">VOD<span className="brand-accent">Clipper</span></span>
        </div>

        <nav className="landing-nav" aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <span className="landing-nav-price">$49 / year</span>
          <button className="landing-signin" type="button" onClick={onSignIn}>
            Sign in <ArrowIcon />
          </button>
        </nav>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-announcement">
            <span>New</span>
            <p>One link in. Ready-to-post clips out.</p>
            <ArrowIcon />
          </div>

          <h1 id="landing-title" className="landing-title">
            Turn long-form video into <em>clips people stop for.</em>
          </h1>
          <p className="landing-subtitle">
            VOD Clipper finds the strongest moments, reframes them for vertical, and adds polished captions—so you can go from podcast to post in minutes.
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
            <span><CheckIcon /> No editing required</span>
            <span><CheckIcon /> Public YouTube links</span>
            <span><CheckIcon /> One simple annual plan</span>
          </div>
        </section>

        <section className="landing-product-preview" aria-label="VOD Clipper product preview">
          <div className="preview-topbar">
            <div className="preview-window-controls" aria-hidden="true"><i /><i /><i /></div>
            <span>VOD Clipper workspace</span>
            <span className="preview-status"><i /> Ready to publish</span>
          </div>

          <div className="preview-canvas">
            <div className="preview-source-card">
              <span className="preview-card-kicker">Source video</span>
              <div className="preview-thumbnail">
                <div className="preview-thumbnail-play">▶</div>
                <Waveform className="preview-source-wave" bars={30} />
              </div>
              <strong>The full podcast episode</strong>
              <small>1:24:18 · Transcript analyzed</small>
            </div>

            <div className="preview-flow" aria-hidden="true">
              <Waveform className="preview-flow-wave" bars={18} />
              <span><ArrowIcon /></span>
            </div>

            <PhoneMock />

            <div className="preview-insight-card">
              <span className="preview-card-kicker">AI selection</span>
              <strong>“A clean, standalone hook”</strong>
              <p>High curiosity · Clear payoff</p>
              <div className="preview-score-line"><span style={{ width: "94%" }} /></div>
            </div>
          </div>
        </section>

        <section className="landing-section landing-features" id="features">
          <div className="landing-section-head">
            <span className="landing-eyebrow">Built for the whole workflow</span>
            <h2>From one long video to your best short-form content.</h2>
            <p>Everything tedious happens in the background. You stay focused on choosing what to publish.</p>
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
            <span className="landing-eyebrow">How it works</span>
            <h2>Four steps. Zero timeline editing.</h2>
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
          <span className="landing-eyebrow">Your next clip is already in the episode</span>
          <h2>Find it in minutes.</h2>
          <button type="button" onClick={() => document.getElementById("landing-youtube-url")?.focus()}>
            Paste your first link <ArrowIcon />
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="brand landing-brand">
          <span className="landing-brand-mark"><Waveform className="brand-mark" bars={7} /></span>
          <span className="brand-name">VOD<span className="brand-accent">Clipper</span></span>
        </div>
        <span>Long-form in. Short-form out.</span>
        <span>© {new Date().getFullYear()} VOD Clipper</span>
      </footer>
    </div>
  );
}
