FROM node:22-slim

# ffmpeg/ffprobe for muxing, reframing, and subtitle burn-in; python3 + pip for
# faster-whisper transcription (invoked as a subprocess from src/lib/whisper.js).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY . .

ENV PYTHON_BIN=python3
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
