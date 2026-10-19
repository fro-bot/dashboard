# ── Bun toolchain stage ───────────────────────────────────────────────────────
# Digest-pinned multi-arch index. The bare version tag must equal package.json
# packageManager (enforced by test/bun-version-pin.test.ts). Only the bun binary
# is copied out of this stage; nothing from it reaches the runtime image.
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun

# ── Builder stage ─────────────────────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS builder

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy manifests first for layer caching. The wiki-writer manifest is copied so the
# workspace resolves against the lockfile; none of its source enters any stage.
COPY package.json bun.lock bunfig.toml ./
COPY wiki-writer/package.json ./wiki-writer/package.json

# Install ALL deps (including devDependencies) for the build step
RUN bun install --frozen-lockfile

# Copy web workspace source
COPY web/ ./web/

# Build the SPA — emits hashed assets to web/dist/
ARG DASHBOARD_VERSION=dev
ENV VITE_DASHBOARD_VERSION=$DASHBOARD_VERSION
RUN bun run build:web

# ── Production dependency stage ───────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS prod-deps

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy manifests for prod-only install. The wiki-writer manifest is needed so the
# frozen lockfile matches the workspace; no wiki-writer source is copied.
COPY package.json bun.lock bunfig.toml ./
COPY wiki-writer/package.json ./wiki-writer/package.json

# Install the root package's production deps only (frozen lockfile) — NO dev deps,
# NO build tools, NO lifecycle scripts. --filter './' keeps the wiki-writer workspace's
# dependencies out of the runtime image.
RUN bun install --filter './' --production --frozen-lockfile --ignore-scripts

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

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
