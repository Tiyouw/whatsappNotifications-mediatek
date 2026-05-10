# syntax=docker/dockerfile:1
# WhatsApp reminder bot — Fly.io image
# Base image: Node 20 on Debian Bookworm (slim). Bookworm has an up-to-date
# ffmpeg in its repos and glibc that matches sharp's prebuilt linux-x64 binary.
FROM node:20-bookworm-slim

# System dependencies:
#  - ffmpeg: redundancy for fluent-ffmpeg's spawn paths (ffmpeg-static ships a
#    bundled binary but apt-install keeps PATH-based calls working too).
#  - ca-certificates: TLS for googleapis / Baileys websocket.
#  - tini-less runtime is fine; Fly's init handles PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first (better layer caching).
# npm ci picks up the correct @img/sharp-linux-x64 optional dep automatically
# because we're building inside a linux/amd64 image; npm rebuild sharp makes
# the prebuilt binary presence explicit and catches misconfiguration early.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm rebuild sharp --verbose

# Copy the rest of the source. .dockerignore keeps secrets, session state,
# dashboard/, .git, etc. out of the image.
COPY . .

# Drop to the unprivileged `node` user baked into the official image.
# /app must be owned by node so any runtime writes (logs, temp files) work.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "index.js"]
