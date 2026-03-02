FROM node:20-slim

WORKDIR /app

# Install system dependencies (matching gnslgbot2 environment)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    python3 \
    libsodium-dev \
    libopus-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./ 
RUN npm install --production

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
