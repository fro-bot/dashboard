FROM node:24-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS builder

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install ALL deps (including devDependencies) for the build step
RUN pnpm install --frozen-lockfile

# Copy web workspace source
COPY web/ ./web/

# Build the SPA — emits hashed assets to web/dist/
RUN pnpm build:web

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

# Copy manifests for prod-only install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install production deps only (frozen lockfile) — NO dev deps, NO build tools
RUN pnpm install --frozen-lockfile --prod

# Copy source (backend runtime — Node 24 strip-only, no build step)
COPY src/ ./src/
COPY public/ ./public/

# Copy prebuilt SPA assets from builder stage
COPY --from=builder /app/web/dist/ ./web/dist/

# Non-root user for read_only-friendly operation
RUN addgroup --system --gid 1001 dashboard && \
    adduser --system --uid 1001 --ingroup dashboard dashboard
USER dashboard

# Mark this as a production runtime so NODE_ENV-gated guards (e.g. devAutoLogin)
# fire correctly. The builder stage intentionally does NOT set this so pnpm install
# and pnpm build:web run with full dev-dep access.
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.ts"]
