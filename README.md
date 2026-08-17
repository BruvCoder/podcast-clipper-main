# Podcast Clipper

Podcast Clipper turns a public YouTube podcast into ranked, subtitled vertical clips. Users sign in with Firebase Authentication, choose clip settings, and receive MP4 clips rendered locally by the backend.

> This repository is currently designed for local development. Read [Security and deployment limitations](#security-and-deployment-limitations) before exposing it to the internet.

## How it works

1. The frontend signs users in with Google or email/password through Firebase Authentication.
2. Authenticated API requests include a Firebase ID token. The backend verifies the token with Firebase Admin and keeps each user's jobs separate.
3. The backend uses two RapidAPI providers to fetch a video-only stream and an audio track, then uses FFmpeg to combine them into an H.264/AAC MP4.
4. FFmpeg extracts audio, and `faster-whisper` transcribes it locally with word-level timestamps.
5. Gemini receives the timestamped transcript and selects, titles, and ranks the best moments.
6. FFmpeg reframes each moment to 9:16 and burns in timed subtitles. The browser polls the job and displays the resulting clips.

The active downloader does not require `yt-dlp`.

## Requirements

- **Node.js 22.12 or newer** and npm. Vite 8 requires a current Node release.
- **FFmpeg and ffprobe** available on `PATH`.
- **Python 3** with pip.
- A **RapidAPI key** subscribed to both providers used by the backend:
  - Cloud API Hub - YouTube Downloader (`cloud-api-hub-youtube-downloader.p.rapidapi.com`)
  - YouTube MP3 (`youtube-mp36.p.rapidapi.com`)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey).
- A **Firebase project** with a Web app, Firebase Authentication, and a Firebase Admin service account.

Confirm the local tools before installing dependencies:

```bash
node --version
ffmpeg -version
ffprobe -version
python3 --version
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

## 2. Configure and install the backend

From the repository root:

```bash
cd backend
npm ci
python3 -m pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env` and set:

```dotenv
RAPIDAPI_KEY=your_rapidapi_key_here
GEMINI_API_KEY=your_gemini_api_key_here
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

The remaining values have local defaults:

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_MODEL` | Model used to select and rank clip moments | `gemini-3.6-flash` |
| `PORT` | Backend HTTP port | `8787` |
| `WHISPER_MODEL` | faster-whisper model size | `base` |
| `PYTHON_BIN` | Python executable launched by Node | `python3` |
| `VIDEO_RAPIDAPI_HOST` | Override the video provider host | Built-in provider host |
| `AUDIO_RAPIDAPI_HOST` | Override the audio provider host | Built-in provider host |
| `RAPIDAPI_TIMEOUT_MS` | Provider API request timeout | `30000` |
| `DOWNLOAD_INACTIVITY_TIMEOUT_MS` | Maximum idle time while receiving media | `45000` |
| `DOWNLOAD_TOTAL_TIMEOUT_MS` | Maximum total time for one media download | `1800000` |
| `FFMPEG_TIMEOUT_MS` | Maximum merge/transcode time | `1800000` |
| `METADATA_TIMEOUT_MS` | YouTube metadata request timeout | `15000` |

If Python is named differently, set `PYTHON_BIN` accordingly—for example, `python` on some Windows installations. The first transcription downloads the selected Whisper model and can take longer than later runs.

## 3. Install the frontend

In the frontend directory, install its locked dependencies:

```bash
npm ci
```

If you have not already done so, copy `frontend/.env.example` to `frontend/.env` and fill in the Firebase Web configuration described above.

## 4. Run locally

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

Sign in with Google or create an email/password account, paste a supported public YouTube URL, select the clip options, and submit the job. Downloading, local transcription, and video rendering can take several minutes for long sources.

## Tests and build checks

Run the downloader transport, validation, ranking, and fallback tests:

```bash
cd backend
npm test
```

Run the frontend YouTube URL validation tests:

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
- The authenticated `/api/jobs` routes verify Firebase ID tokens and restrict job metadata by Firebase user ID. Rendered `/files/<job>/clips/<clip>.mp4` URLs are intentionally shareable without authentication, but backend working files are not served. Anyone who obtains a clip URL can still fetch that rendered clip.
- CORS is currently open and there is no rate limiting, quota enforcement, or production hardening. Do not expose this backend directly to the public internet as-is.
- Job metadata lives in an in-memory `Map`. Restarting the backend removes job history and status, and multiple backend instances do not share state.
- Source media, extracted audio, and rendered clips are written under `backend/jobs/`. Files remain on that machine until removed, have no automatic retention policy, and are unsuitable for ephemeral or multi-instance hosting.
- Firebase Authentication does not make file storage private. A production version should move job state to a database, store media in private object storage, authorize every download, and add cleanup/retention jobs.
- RapidAPI receives the YouTube video ID and its providers supply the media streams. Gemini receives the timestamped transcript for clip selection. Whisper transcription and FFmpeg processing run locally.
- Only process media you are authorized to download and reuse. You are responsible for complying with YouTube's terms, copyright law, and the terms and quotas of all configured API providers.

## Current product limitations

- The vertical reframe uses a center crop or padded layout; it does not track faces or active speakers.
- The virality score is Gemini's relative judgment across the returned clips, not a trained prediction or guarantee of performance.
- Processing is CPU-, memory-, disk-, and network-intensive. Long videos and larger Whisper models substantially increase runtime and resource usage.
- The pipeline targets public YouTube video URL formats supported by its URL parser and external providers; private, restricted, unavailable, or provider-blocked videos will fail.

## Project structure

```text
backend/
  scripts/
    transcribe_whisper.py  # local faster-whisper transcription
  src/
    server.js              # authenticated API and job orchestration
    lib/
      firebaseAdmin.js     # Firebase ID-token verification
      rapidapi.js          # video/audio download and muxing
      ffmpeg.js            # extraction, reframing, and subtitle rendering
      gemini.js            # clip selection and ranking
  jobs/                    # local per-job media and output (gitignored)
frontend/
  src/
    AuthContext.jsx        # Firebase sign-in state and actions
    api.js                 # authenticated API requests
    firebase.js            # Firebase Web configuration
    components/            # app screens and controls
  test/                    # Node test runner tests
```
