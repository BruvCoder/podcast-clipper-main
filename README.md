# Ravi

Ravi is a personal YouTube clipping agent. A creator connects a **main channel** and a separate **clips channel** through [Zernio](https://zernio.com/). Ravi watches the main channel for new uploads, downloads each new source with `yt-dlp`, creates vertical captioned clips, and publishes them to the clips channel through Zernio.

Ravi does **not** accept individual video links. `POST /api/jobs` is intentionally disabled; connected-channel automation is the only way new clipping jobs are created.

## Product flow

1. The creator signs in to Ravi with Firebase Authentication.
2. Ravi creates two deterministic, role-specific Zernio profiles for that Firebase user: one for the **main channel** and one for the **clips channel**. The profile names are derived from a hash of the Firebase UID plus the role, so repeat setup is idempotent without exposing the UID.
3. The creator uses Zernio's hosted YouTube connection flow once through each role profile. Each profile contains one YouTube account, and the underlying main and clips channels must be different to prevent a posting loop.
4. The creator chooses clip count, clip length, framing, captions, upload privacy, and audience settings, then certifies that they control the source content and accept responsibility for YouTube Community Guidelines compliance.
5. When watching is turned on, Ravi reads the main channel's current published posts as a baseline. Existing videos are not backfilled; only uploads published at or after activation are eligible.
6. A periodic Zernio live sync merges uploads published directly on YouTube with posts published through Zernio. Persistent per-video event records deduplicate overlapping results and recover pending work after a restart.
7. For each new upload, the backend uses `yt-dlp` to retrieve a bounded source, Groq Whisper to transcribe it, a Groq text model to select the strongest moments, and FFmpeg to create vertical captioned MP4s.
8. Ravi obtains a Zernio media-upload URL, uploads each rendered MP4, and creates a YouTube post targeted at the connected clips account. It then reconciles Zernio's post status until the published YouTube URL is available.

The creator can pause watching, trigger a check immediately, change settings for future uploads, or disconnect either channel from the dashboard.

## Requirements

- **Node.js 22.12 or newer** and npm. Vite 8 requires a current Node release.
- **FFmpeg and ffprobe** on `PATH`.
- **yt-dlp** on `PATH`. Production uses the checksum-pinned official binary in `backend/Dockerfile`.
- A **Groq API key** for Whisper transcription and clip selection.
- A **Firebase project** with a Web app, Firebase Authentication, and a Firebase Admin service account.
- A **Zernio API key** with enough connected-account capacity for the users Ravi will serve.
- A public HTTPS backend URL in production for the Zernio connection return URL.
- An HTTP(S) residential proxy whose provider permits the intended traffic. It is optional locally and required by the production readiness check by default.

Confirm the local tools before installing dependencies:

```bash
node --version
yt-dlp --version
ffmpeg -version
ffprobe -version
```

## Local setup

### 1. Install dependencies

```bash
cd backend
npm ci
cp .env.example .env

cd ../frontend
npm ci
cp .env.example .env
```

### 2. Configure Firebase

In the [Firebase console](https://console.firebase.google.com/):

1. Create or select a project and add a Web app.
2. Open **Authentication > Sign-in method** and enable **Google** and **Email/Password**.
3. Under **Authentication > Settings > Authorized domains**, make sure `localhost` is allowed.
4. Copy the Web app configuration from **Project settings > General** into `frontend/.env`:

```dotenv
VITE_FIREBASE_API_KEY=your_firebase_web_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id
```

For Firebase Admin, open **Project settings > Service accounts**, generate a private key, save it as `backend/firebase-service-account.json`, and set:

```dotenv
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

The service-account file is gitignored. Never commit it or expose Admin credentials in a `VITE_...` variable. On a host that stores secrets as environment variables, leave the path unset and provide the complete JSON through `FIREBASE_SERVICE_ACCOUNT_JSON` instead.

### 3. Configure Zernio channel connections

Create a Zernio API key and add the following to `backend/.env`:

```dotenv
APP_URL=http://localhost:5173
ZERNIO_API_KEY=your_zernio_api_key
YOUTUBE_PUBLIC_API_URL=http://localhost:8787
YOUTUBE_OAUTH_REDIRECT_URI=http://localhost:8787/api/youtube/oauth/callback
```

`YOUTUBE_OAUTH_REDIRECT_URI` is optional when it is exactly `${YOUTUBE_PUBLIC_API_URL}/api/youtube/oauth/callback`. Despite its legacy name, this is Ravi's return endpoint for Zernio's hosted YouTube connection flow; Ravi does not store Google client secrets or YouTube refresh tokens.

Ravi creates two deterministic Zernio profiles per Firebase user: a `main` role profile and a `clips` role profile. Each profile contains exactly one YouTube account, which respects Zernio's one-account-per-platform-per-profile rule. The two profiles are named from a hash of the Firebase UID plus their role, and each role must connect a different underlying YouTube channel.

Zernio account capacity is shared at the Zernio workspace level. Zernio currently includes the first two connected accounts for free, which remains enough for one Ravi user: one main-channel account in the main profile and one clips-channel account in the clips profile. A multi-user production deployment needs a Zernio plan with enough additional connected-account capacity.

### 4. Configure Groq and the downloader

Add the Groq key to `backend/.env`:

```dotenv
GROQ_API_KEY=your_groq_api_key_here
```

For local direct YouTube access, no proxy variable is required. On a datacenter host, configure the IPRoyal residential endpoint:

```dotenv
RESIDENTIAL_PROXY_URL=http://username:password@geo.iproyal.com:12321
```

Percent-encode reserved characters in the username or password. `MEDIA_PROXY_URL` remains a backwards-compatible alias; if both variables are set, they must be identical. Invalid proxy configuration fails closed rather than silently falling back to the server's datacenter IP.

`yt-dlp` uses the proxy for YouTube extraction and the complete bounded source download. Groq, Firebase, Zernio media uploads and API requests, Stripe, and other backend traffic remain direct. Credentials are passed to `yt-dlp` through private stdin configuration rather than process arguments and are redacted from job progress and errors.

For IPRoyal, Ravi derives a fresh eight-character sticky session for each retry while leaving the base credential unchanged. IPRoyal's high-end streaming pool is plan-specific, so enable it only when the account supports it:

```dotenv
YTDLP_IPROYAL_STREAMING=true
```

Set `YTDLP_ROTATE_IPROYAL_SESSION=false` only when a fixed proxy session is intentional. Use a provider and plan that permit this traffic, and process only media you are authorized to download and reuse.

### 5. Run Ravi

Start the backend in one terminal:

```bash
cd backend
npm run dev
```

Start the frontend in another:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`, sign in, connect the main channel and a distinct clips channel through Zernio, confirm the certifications, and turn watching on. Vite proxies `/api` and `/files` to `http://localhost:8787` during local development.

## Zernio automation environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_URL` | Exact frontend origin used for connection return URLs and CORS | Required |
| `ZERNIO_API_KEY` | Backend-only Zernio API key used to manage profiles, connections, external posts, media, and posts | Required |
| `YOUTUBE_PUBLIC_API_URL` | Public backend origin used to build the channel-connection return URL | Required |
| `YOUTUBE_OAUTH_REDIRECT_URI` | Ravi endpoint to which Zernio returns after a channel connection | `${YOUTUBE_PUBLIC_API_URL}/api/youtube/oauth/callback` |
| `ZERNIO_BASE_URL` | Optional Zernio API base override | `https://zernio.com/api/v1` |
| `ZERNIO_REQUEST_TIMEOUT_MS` | Timeout for ordinary Zernio API requests | `20000` |
| `ZERNIO_UPLOAD_TIMEOUT_MS` | Timeout for uploading one rendered clip to Zernio's presigned URL | `900000` |
| `YOUTUBE_WATCH_POLL_MS` | External-post sync interval, constrained to 1–60 minutes | `60000` |
| `YOUTUBE_OAUTH_STATE_TTL_MS` | One-time channel-connection state lifetime, constrained to 1–15 minutes | `600000` |

Channel automation is reported as `setup_required` by `/api/health` until all required values are present. Secrets belong in the deployment platform's secret manager, never in the frontend or repository.

## Processing and downloader environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Backend HTTP port | `8787` |
| `CLIP_PICKER_MODEL` | Groq model used to select and rank moments | `openai/gpt-oss-120b` |
| `GROQ_TRANSCRIBE_MODEL` | Whisper transcription model | `whisper-large-v3` |
| `TRANSCRIBE_CHUNK_SEC` | Seconds of audio per transcription request | `600` |
| `TRANSCRIBE_CONCURRENCY` | Audio chunks transcribed concurrently | `3` |
| `YTDLP_METADATA_TIMEOUT_MS` | `yt-dlp` metadata deadline | `120000` |
| `YTDLP_DOWNLOAD_TIMEOUT_MS` | Overall source-preparation deadline | `1800000` |
| `YTDLP_SOCKET_TIMEOUT_SEC` | Per-socket timeout in seconds | `30` |
| `YTDLP_MAX_DURATION_SEC` | Maximum accepted source duration | `14400` |
| `YTDLP_MAX_SOURCE_BYTES` | Aggregate source/fragments/merge byte cap | `2147483648` |
| `YTDLP_MAX_HEIGHT` | Preferred maximum source height | `720` |
| `YTDLP_CONCURRENT_FRAGMENTS` | Concurrent DASH/HLS fragment downloads | `4` |
| `YTDLP_SESSION_ATTEMPTS` | Fresh proxy sessions tried after an IP block | `3` |
| `YTDLP_RETRY_BACKOFF_MS` | Initial delay between session attempts | `250` |
| `YTDLP_ROTATE_IPROYAL_SESSION` | Rotate the IPRoyal sticky-session ID per attempt | `true` |
| `YTDLP_IPROYAL_STREAMING` | Opt into IPRoyal's plan-specific streaming pool | `false` |
| `YTDLP_REQUIRE_PROXY` | Fail production readiness without a residential proxy | `true` in production |
| `JOB_PROCESS_CONCURRENCY` | Whole clipping jobs processed concurrently | `1` |
| `MAX_OUTSTANDING_JOBS` | Maximum queued/running jobs across the service | `10` |
| `MAX_OUTSTANDING_JOBS_PER_USER` | Maximum queued/running jobs per user | `2` |
| `YTDLP_COOKIES_FILE` | Optional secret-mounted Netscape cookies file | Unset |
| `RESIDENTIAL_PROXY_URL` | Authenticated HTTP(S) proxy used only by `yt-dlp` | Direct locally; required in production |

See `backend/.env.example` for additional timeout, rendering, cookie, and model overrides.

## Production deployment

The backend must have a stable public HTTPS origin. For the current production domains, use this exact Zernio return URL:

```text
https://api.vod-clipper.com/api/youtube/oauth/callback
```

Set at least:

```dotenv
NODE_ENV=production
APP_URL=https://vod-clipper.com
ZERNIO_API_KEY=your_production_zernio_api_key
YOUTUBE_PUBLIC_API_URL=https://api.vod-clipper.com
YOUTUBE_OAUTH_REDIRECT_URI=https://api.vod-clipper.com/api/youtube/oauth/callback
```

Provide Firebase, Groq, Zernio, and proxy secrets separately. Ravi sends the exact return URL, including a short-lived one-time state value and channel role, when it requests Zernio's hosted connection URL.

### Durable state and scaling

Mount a persistent volume at `/app/jobs` in production. The backend stores:

- rendered clips and per-job `job.json` files under `/app/jobs/<job-id>/`;
- per-user role-specific Zernio profile/account references, automation settings, deduplication events, publishing state, and one-time connection state under `/app/jobs/_ravi_automation/`.

The file-backed store uses atomic writes and in-process locking, but it is a **single-instance design**. Do not run multiple backend replicas against this implementation: instances do not share in-memory job execution state or cross-process locks. Moving to multiple replicas requires a shared database/queue plus coordinated workers and private object storage.

Without a persistent `/app/jobs` volume, automation state, deduplication history, job history, and rendered clips can disappear on redeploy. The Zernio connections themselves remain in Zernio, but Ravi may no longer know which profile/account belongs to a user and the user may need to reconnect.

## Dormant Stripe integration

Pricing is currently removed from Ravi and deployed environments should keep `BILLING_ENABLED=false`. The Stripe Checkout, Customer Portal, webhook, and subscription-gate code remains for a possible later reactivation. When billing is disabled, Stripe keys and a Price ID are not required.

The retained billing configuration has one plan only: **$49 USD per year** (`price_1U6mzHAun2WUinl2owQSnjUX`). If billing is re-enabled, keep that as the only tier and use its live Stripe account's Checkout/Portal settings and webhook secret. Never expose `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` in frontend variables or mix live and test-mode objects.

## API overview

Authenticated routes require a Firebase ID token.

| Method and route | Purpose |
| --- | --- |
| `GET /api/youtube/automation` | Read the signed-in user's two channel connections and watcher status |
| `POST /api/youtube/oauth/start` | Begin Zernio's hosted connection flow for the requested `main` or `clips` role |
| `GET /api/youtube/oauth/callback` | Validate the one-time state and record the Zernio-connected YouTube account |
| `PATCH /api/youtube/automation` | Save settings or enable/pause watching |
| `POST /api/youtube/check-now` | Immediately sync and poll the main channel's native and Zernio-authored posts |
| `DELETE /api/youtube/connection/:role` | Pause automation and disconnect the `main` or `clips` account |
| `GET /api/jobs` | List automatically created clipping jobs for the signed-in user |
| `GET /api/jobs/:id` | Read one job and its published clip URLs |
| `DELETE /api/jobs/:id` | Cancel/delete a job and its local artifacts |
| `POST /api/jobs` | Returns `410 channel_automation_only`; manual jobs are disabled |

## Tests and build checks

```bash
cd backend
npm test

cd ../frontend
npm test
npm run build
```

## Security and operational limitations

- Never commit `.env` files, Firebase service-account JSON, Zernio API keys, proxy credentials, or downloader cookies.
- The Zernio API key is server-wide and must remain backend-only. The browser receives only Zernio's short-lived hosted connection URL; Firebase identity, one-time state, role, profile ID, and connected account ID are validated before a connection is saved.
- Live channel polling and persistent per-video event state provide recovery and deduplication across native YouTube uploads and Zernio-authored posts. Existing uploads are baselined when watching starts so Ravi does not unexpectedly process a backlog.
- Zernio is used for YouTube account authorization, published-post discovery, and finished-clip publishing. It does not download the source-video file. Source retrieval uses `yt-dlp`, optionally through the configured residential proxy. Use Ravi only for channels/content you control and ensure the downloads, uploads, proxy usage, and automation comply with YouTube's terms, copyright law, and provider terms.
- Downloaded source media lives in an ephemeral OS temporary directory while a job runs and is removed after rendering, failure, or cancellation. Rendered clips and job metadata remain until deletion; there is no automatic retention policy.
- `/files/<job>/clips/<clip>.mp4` URLs are intentionally shareable without authentication. Anyone who obtains one can fetch the rendered clip. Production hardening should use private object storage and authorize each download.
- Firebase ID-token checks isolate job and automation metadata by user, but the service does not yet include full rate limiting, quotas, or distributed abuse controls. Zernio, YouTube, and Groq quotas still apply.
- If either Zernio account is disconnected or becomes unhealthy, Ravi pauses that user's automation and asks them to reconnect the affected role.
- Automatic posts can partially succeed. Ravi records the Zernio post ID and reconciles it before retrying so it does not knowingly publish the same clip twice; failures that cannot be safely reconciled require operator/user review.

## Current product limitations

- Only new public main-channel uploads returned by Zernio's live sync or published-post listing are detected. Private, members-only, scheduled-before-publication, live, restricted, unavailable, oversized, or YouTube-blocked sources may be skipped or fail.
- There is no historical backfill when watching is first enabled.
- The reframe uses face-aware placement when available, with center-crop/padded fallbacks; it does not track active speakers throughout the entire clip.
- The virality score is the clip-selection model's relative judgment, not a trained performance guarantee.
- Processing is CPU-, memory-, disk-, network-, and quota-intensive. Jobs are serialized by default, and long videos increase processing time and transcription usage.

## Project structure

```text
backend/
  src/
    server.js                       # authenticated API and automatic job orchestration
    lib/
      zernioApi.js                  # bounded Zernio profiles, accounts, media, and posts client
      youtubeAutomationService.js   # two-channel connection, watcher, deduplication, and publishing lifecycle
      youtubeAutomationStore.js     # durable single-instance file store
      firebaseAdmin.js              # Firebase ID-token verification
      ytdlp.js                      # source validation/download and IPRoyal integration
      ffmpeg.js                     # vertical rendering, reframing, and subtitle burn-in
      groqTranscribe.js             # Whisper transcription with word timestamps
      clipPicker.js                 # clip selection and ranking through Groq
      stripeBilling.js              # dormant optional subscription integration
  jobs/                             # local job output and automation state (gitignored)
frontend/
  src/
    AuthContext.jsx                 # Firebase sign-in state and actions
    api.js                          # authenticated automation/job API requests
    firebase.js                     # Firebase Web configuration
    components/
      AutomationDashboard.jsx       # main/clips connection, watcher controls, and activity
```
