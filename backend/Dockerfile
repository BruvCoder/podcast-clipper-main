FROM node:22-slim

# ffmpeg/ffprobe for remote-seek clip rendering and subtitle burn-in.
# Transcription now runs on Gemini (see src/lib/geminiTranscribe.js), so no
# Python/faster-whisper toolchain is needed here anymore.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
