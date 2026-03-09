FROM node:22-bookworm-slim

WORKDIR /app

# Install system dependencies + Python pip for edge-tts (same as gnslgbot2)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    libsodium-dev \
    libopus-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python edge-tts + SpeechRecognition — exact same libraries gnslgbot2 uses
RUN pip3 install --no-cache-dir edge-tts SpeechRecognition --break-system-packages

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]
