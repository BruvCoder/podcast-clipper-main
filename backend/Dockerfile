FROM node:22-slim

ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH=amd64
ARG YTDLP_AMD64_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_ARM64_SHA256=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc

# YuNet face detector, used to place the 9:16 crop on the speaker instead of the
# middle of the frame. Pinned and checksummed like yt-dlp above.
ARG YUNET_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
ARG YUNET_URL=https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

# Pin and verify the official Linux bundle so Railway never picks up a stale
# distro package or an unreviewed "latest" release during a rebuild. Node 22
# is also the JavaScript runtime yt-dlp uses for YouTube challenge solving.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && case "${TARGETARCH}" in \
      amd64) YTDLP_ASSET="yt-dlp_linux"; YTDLP_SHA256="${YTDLP_AMD64_SHA256}" ;; \
      arm64) YTDLP_ASSET="yt-dlp_linux_aarch64"; YTDLP_SHA256="${YTDLP_ARM64_SHA256}" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_ASSET}" \
      --output /usr/local/bin/yt-dlp \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && test "$(yt-dlp --version)" = "${YTDLP_VERSION}" \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && mkdir -p /usr/local/share/vod-clipper \
    && curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
      "${YUNET_URL}" --output /usr/local/share/vod-clipper/yunet.onnx \
    && echo "${YUNET_SHA256}  /usr/local/share/vod-clipper/yunet.onnx" | sha256sum --check --strict \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

# Face detection for crop placement. opencv-python-headless leaves out the GUI
# libraries, which a server has no use for and which pull in a large X11 tree.
# Failure to detect is non-fatal at runtime (the renderer falls back to a centre
# crop), but the import is verified here so a broken image fails at build time
# rather than silently degrading every clip.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages "opencv-python-headless==4.10.0.84" "numpy<2" \
    && python3 -c "import cv2; cv2.FaceDetectorYN.create('/usr/local/share/vod-clipper/yunet.onnx', '', (320, 320))" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
