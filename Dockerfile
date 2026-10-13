# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

# Cache apt lists + debs between builds — reinstalls skip the download step
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    libopus-dev \
    libsodium-dev \
    libfontconfig1 \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 \
    librsvg2-2 \
    libharfbuzz0b

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Use a current npm 11 release instead of the bundled npm 10.9.9 that crashes
# with "Exit handler never called" in the Render Docker build.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global npm@11.21.0 \
    && npm ci --omit=dev --no-fund --no-audit \
    && rm -rf /app/node_modules/ffmpeg-static

FROM base AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pip3 install --no-cache-dir --requirement /app/requirements.txt --break-system-packages \
    && mkdir -p /app/data \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV FFMPEG_PATH=ffmpeg

EXPOSE 10000

CMD ["node", "--max-old-space-size=384", "--expose-gc", "/app/index.js"]
