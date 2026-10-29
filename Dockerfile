# ── Bun toolchain stage ───────────────────────────────────────────────────────
# Digest-pinned multi-arch index. The bare version tag must equal package.json
# packageManager (enforced by test/bun-version-pin.test.ts). Only the bun binary
# is copied out of this stage; nothing from it reaches the runtime image.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

# ── Builder stage ─────────────────────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS builder

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy manifests first for layer caching.
COPY package.json bun.lock bunfig.toml ./

# Install ALL deps (including devDependencies) for the build step
RUN bun install --frozen-lockfile

# Copy web workspace source
COPY web/ ./web/

# Build the SPA — emits hashed assets to web/dist/
ARG DASHBOARD_VERSION=dev
ENV VITE_DASHBOARD_VERSION=$DASHBOARD_VERSION
RUN bun run build:web

# ── Production dependency stage ───────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS prod-deps

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy manifests for prod-only install.
COPY package.json bun.lock bunfig.toml ./

# Install the root package's production deps only (frozen lockfile) — NO dev deps,
# NO build tools, NO lifecycle scripts.
RUN bun install --production --frozen-lockfile --ignore-scripts

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

WORKDIR /app

# Copy only the production dependency tree. Package manifests and package-manager
# state never enter the final image.
COPY --from=prod-deps /app/node_modules/ ./node_modules/

# Copy source (backend runtime — Node 24 strip-only, no build step)
COPY src/ ./src/
COPY public/ ./public/

# Copy prebuilt SPA assets from builder stage
COPY --from=builder /app/web/dist/ ./web/dist/

# Mark this as a production runtime so NODE_ENV-gated guards (e.g. devAutoLogin)
# fire correctly. The builder stage intentionally does NOT set this so bun install
# and bun run build:web run with full dev-dep access.
ENV NODE_ENV=production

# Remove package-manager binaries, shims, and caches (inherited from the Node base
# image, or left by Bun) before handing the filesystem to the unprivileged runtime user.
RUN rm -rf \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/bun \
      /usr/local/bin/bunx \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /root/.cache \
      /root/.npm \
      /root/.local/share/pnpm \
      /root/.bun \
      /usr/local/share/.cache

USER node

EXPOSE 3000

CMD ["node", "src/server.ts"]
