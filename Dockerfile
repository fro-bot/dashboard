FROM node:24-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install production deps only (frozen lockfile)
RUN pnpm install --frozen-lockfile --prod

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Non-root user for read_only-friendly operation
RUN addgroup --system --gid 1001 dashboard && \
    adduser --system --uid 1001 --ingroup dashboard dashboard
USER dashboard

EXPOSE 3000

CMD ["node", "src/server.ts"]
