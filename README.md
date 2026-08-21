# VOD Clipper

VOD Clipper turns a public YouTube podcast into ranked, subtitled vertical clips. Users sign in with Firebase Authentication, subscribe through Stripe when billing is enabled, choose clip settings, and receive MP4 clips rendered locally by the backend.

> This repository is currently designed for local development. Read [Security and deployment limitations](#security-and-deployment-limitations) before exposing it to the internet.

## How it works

1. The frontend signs users in with Google or email/password through Firebase Authentication.
2. Authenticated API requests include a Firebase ID token. The backend verifies the token with Firebase Admin and keeps each user's jobs separate.
3. When billing is enabled, Stripe-hosted Checkout sells the server-configured subscription and the backend verifies the live subscription before accepting each new job. Stripe's Customer Portal handles payment updates and cancellation.
4. The backend uses two RapidAPI providers: it downloads the audio track in full, and validates (but does not download) a video-only stream URL. An optional residential HTTP(S) proxy can carry only these media transfers.
5. Whisper large-v3 (hosted on Groq) transcribes the local audio track, producing word-level timestamps derived from acoustic alignment against the audio.
6. A text model on Groq receives the timestamped transcript and selects, titles, and ranks the best moments.
7. For each selected moment, FFmpeg seeks into the remote video URL for only that time window, reframes it to 9:16, and burns in timed subtitles — the full source video is never downloaded or stored. The browser polls the job and displays the resulting clips.

The active downloader does not require `yt-dlp`.

## Requirements

- **Node.js 22.12 or newer** and npm. Vite 8 requires a current Node release.
- **FFmpeg and ffprobe** available on `PATH`.
- A **RapidAPI key** subscribed to both providers used by the backend:
  - Cloud API Hub - YouTube Downloader (`cloud-api-hub-youtube-downloader.p.rapidapi.com`)
  - YouTube MP3 (`youtube-mp36.p.rapidapi.com`)
- A **Groq API key** from [Groq Console](https://console.groq.com/keys). One key covers both transcription (Whisper) and clip selection.
- A **Firebase project** with a Web app, Firebase Authentication, and a Firebase Admin service account.
- A **Stripe account**, recurring Price, and webhook endpoint when subscription billing is enabled.
- An HTTP or HTTPS **residential proxy** whose provider permits the intended media traffic when the deployment's direct IP cannot reach the media CDNs.

Confirm the local tools before installing dependencies:

```bash
node --version
ffmpeg -version
ffprobe -version
```

## 1. Configure Firebase

### Enable sign-in methods

In the [Firebase console](https://console.firebase.google.com/):

1. Create or select a project and add a Web app.
2. Open **Authentication > Sign-in method**.
3. Enable **Google** and **Email/Password**.
4. Under **Authentication > Settings > Authorized domains**, make sure `localhost` is allowed for local development.

### Configure the frontend

Copy the frontend template:

```bash
cd frontend
cp .env.example .env
```

Open Firebase **Project settings > General > Your apps > SDK setup and configuration**, then copy the Web app configuration into `frontend/.env`:

```dotenv
VITE_FIREBASE_API_KEY=your_firebase_web_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id
```

Firebase Web configuration is included in the browser bundle and is not an Admin secret. Access control still depends on correctly configured Firebase Authentication and backend token verification.

### Configure Firebase Admin

The backend needs private credentials to verify Firebase ID tokens. For local development:

1. Open Firebase **Project settings > Service accounts**.
2. Choose **Generate new private key**.
3. Save the downloaded file as `backend/firebase-service-account.json`.
4. Set this in `backend/.env`:

```dotenv
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

The service-account file is gitignored. Never commit, share, or place its contents in frontend variables. For a deployment platform that stores secrets as environment variables, leave the path unset and set `FIREBASE_SERVICE_ACCOUNT_JSON` to the complete service-account JSON through that platform's secret manager instead.

## 2. Configure Stripe subscriptions

Billing is opt-in for local development. With `BILLING_ENABLED` unset or `false`, signed-in users can use the app without a paywall. With it set to `true`, missing or invalid Stripe configuration fails closed and new jobs require a live `active` or `trialing` subscription for the configured Price.

The selected live Stripe account (`acct_1TBHiwAun2WUinl2`) has one active subscription option:

- **VOD Clipper Yearly Access** — **$49 USD per year**
- Live Price ID: `price_1U6mzHAun2WUinl2owQSnjUX`

Use that Price ID with a live secret key from the same Stripe account. Stripe test-mode objects are separate, so local test-mode Checkout requires a matching test-mode copy of this annual Price rather than mixing the live Price with a test key.

1. In the [Stripe Dashboard](https://dashboard.stripe.com/test/products), create a Product with a recurring Price and copy its `price_...` ID.
2. Configure the [Stripe Customer Portal](https://dashboard.stripe.com/test/settings/billing/portal) so customers can update payment methods and cancel subscriptions.
3. Add a webhook endpoint ending in `/api/billing/webhook` and subscribe it to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`.
4. Put values from the same Stripe mode in `backend/.env`. For the live annual plan, use:

```dotenv
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_endpoint_signing_secret
STRIPE_PRICE_ID=price_1U6mzHAun2WUinl2owQSnjUX
APP_URL=http://localhost:5173
# STRIPE_ALLOW_PROMOTION_CODES=false
```

For local webhook testing, the Stripe CLI can forward signed events and print the matching `whsec_...` secret:

```bash
stripe listen --forward-to localhost:8787/api/billing/webhook
```

Checkout and the Customer Portal are hosted by Stripe and created by the backend, so this integration does not need a Stripe publishable key in the frontend. Never put `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` in a `VITE_...` variable.

## 3. Configure the residential media proxy

Set the IPRoyal residential HTTP(S) proxy URL in `backend/.env`:

```dotenv
RESIDENTIAL_PROXY_URL=http://username:password@geo.iproyal.com:12321
```

Percent-encode reserved characters in the username or password. `MEDIA_PROXY_URL` remains supported as a backwards-compatible alias; do not set both names to different values. Invalid proxy configuration fails closed instead of silently falling back to the server's datacenter IP.

Only the audio download and remote video range requests use this proxy. RapidAPI control requests, Groq, Firebase, Stripe, and other backend traffic stay direct. The URL is never returned to the browser or intentionally logged. Use a provider and plan that permit this traffic, and process only media you are authorized to download and reuse.

## 4. Configure and install the backend

From the repository root:

```bash
cd backend
npm ci
cp .env.example .env
```

Edit `backend/.env` and set:

```dotenv
RAPIDAPI_KEY=your_rapidapi_key_here
GROQ_API_KEY=your_groq_api_key_here
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

The remaining values have local defaults:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLIP_PICKER_MODEL` | Model used to select and rank clip moments | `openai/gpt-oss-120b` |
| `GROQ_TRANSCRIBE_MODEL` | Whisper model used to transcribe audio | `whisper-large-v3` |
| `PORT` | Backend HTTP port | `8787` |
| `TRANSCRIBE_CHUNK_SEC` | Seconds of audio per transcription request; sized for the API's file-size limit, not timing accuracy | `600` |
| `TRANSCRIBE_CONCURRENCY` | How many chunks to transcribe at once | `3` |
| `VIDEO_RAPIDAPI_HOST` | Override the video provider host | Built-in provider host |
| `AUDIO_RAPIDAPI_HOST` | Override the audio provider host | Built-in provider host |
| `RAPIDAPI_TIMEOUT_MS` | Provider API request timeout | `30000` |
| `DOWNLOAD_INACTIVITY_TIMEOUT_MS` | Maximum idle time while receiving media | `45000` |
| `DOWNLOAD_TOTAL_TIMEOUT_MS` | Maximum total time for the audio download | `1800000` |
| `PROBE_TIMEOUT_MS` | Maximum time to probe a (local or remote) media source | `45000` |
| `METADATA_TIMEOUT_MS` | YouTube metadata request timeout | `15000` |
| `RESIDENTIAL_PROXY_URL` | Optional authenticated HTTP(S) proxy for media transfers only | Direct connection |
| `BILLING_ENABLED` | Enforce a live Stripe subscription before creating a job | `false` |
| `APP_URL` | Browser origin/path used for Stripe return URLs | Required with billing |

## 5. Install the frontend

In the frontend directory, install its locked dependencies:

```bash
npm ci
```

If you have not already done so, copy `frontend/.env.example` to `frontend/.env` and fill in the Firebase Web configuration described above.

## 6. Run locally

Start the backend in the first terminal:

```bash
cd backend
npm run dev
```

The API listens on `http://localhost:8787`.

Start the frontend in a second terminal:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` and `/files` to the backend during local development.

Sign in with Google or create an email/password account, paste a supported public YouTube URL, select the clip options, and submit the job. Downloading, transcription, and video rendering can take several minutes for long sources.

## Tests and build checks

Run the Stripe billing, proxy transport, downloader validation, ranking, and fallback tests:

```bash
cd backend
npm test
```

Run the frontend URL, billing-state, and price-formatting tests:

```bash
cd frontend
npm test
```

Verify the production frontend bundle with:

```bash
cd frontend
npm run build
```

## Security and deployment limitations

- Never commit `.env` files, Firebase Admin service-account JSON, private keys, or provider credentials. The included templates contain placeholders only. Rotate any credential that is exposed.
- Stripe webhook signatures are verified against the raw request body. The live subscription is queried and matched against the server-selected Price before every new job; browser state and Firebase claims alone never grant paid access.
- Stripe billing mappings are cached in Firebase custom claims. Firebase replaces the complete custom-claims map on each write, so production deployments that also mutate roles or other claims need one coordinated claims writer (or should move canonical billing state to a database) to avoid concurrent read/merge/write races.
- Residential proxy credentials stay in the backend. The proxy provider can observe connection destinations and traffic volume, so use a provider you trust and keep its credentials in your host's secret manager.
- The authenticated `/api/jobs` routes verify Firebase ID tokens and restrict job metadata by Firebase user ID. Rendered `/files/<job>/clips/<clip>.mp4` URLs are intentionally shareable without authentication, but backend working files are not served. Anyone who obtains a clip URL can still fetch that rendered clip.
- CORS is currently open and there is no rate limiting, quota enforcement, or production hardening. Do not expose this backend directly to the public internet as-is.
- Job metadata is cached in memory and persisted to a `job.json` file per job directory, so history survives a restart. Multiple backend instances still do not share state, and history is only as durable as the volume holding `backend/jobs/`.
- Source media, extracted audio, and rendered clips are written under `backend/jobs/`. Files remain on that machine until removed, have no automatic retention policy, and are unsuitable for ephemeral or multi-instance hosting.
- Firebase Authentication does not make file storage private. A production version should move job state to a database, store media in private object storage, authorize every download, and add cleanup/retention jobs.
- RapidAPI receives the YouTube video ID and its providers supply the media streams. Groq receives the audio for transcription and the resulting timestamped transcript for clip selection. FFmpeg processing runs locally on the backend.
- Only process media you are authorized to download and reuse. You are responsible for complying with YouTube's terms, copyright law, and the terms and quotas of all configured API providers.

## Current product limitations

- The vertical reframe uses a center crop or padded layout; it does not track faces or active speakers.
- The virality score is the clip-selection model's relative judgment across the returned clips, not a trained prediction or guarantee of performance.
- Processing is CPU-, memory-, disk-, and network-intensive. Long videos substantially increase runtime, and transcription cost/time scales with episode length since it's billed per API call.
- The pipeline targets public YouTube video URL formats supported by its URL parser and external providers; private, restricted, unavailable, or provider-blocked videos will fail.

## Project structure

```text
backend/
  src/
    server.js              # authenticated API and job orchestration
    lib/
      firebaseAdmin.js     # Firebase ID-token verification and billing claim storage
      stripeBilling.js     # Checkout, Customer Portal, webhooks, and subscription gate
      mediaProxy.js        # credential-safe, media-only residential proxy transport
      rapidapi.js          # audio download and remote video-source selection
      ffmpeg.js            # per-clip remote-seek rendering, reframing, and subtitle burn-in
      groqTranscribe.js    # word-level-timestamped transcription via Whisper on Groq
      clipPicker.js        # clip selection and ranking through Groq
  jobs/                    # local per-job media and output (gitignored)
frontend/
  src/
    AuthContext.jsx        # Firebase sign-in state and actions
    api.js                 # authenticated API requests
    firebase.js            # Firebase Web configuration
    components/            # app screens and controls
  test/                    # Node test runner tests
```
