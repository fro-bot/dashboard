FROM node:24-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install production deps only (frozen lockfile)
RUN pnpm install --frozen-lockfile --prod

# Copy source
COPY src/ ./src/

# Non-root user for read_only-friendly operation
RUN addgroup --system --gid 1001 dashboard && \
    adduser --system --uid 1001 --ingroup dashboard dashboard
USER dashboard

EXPOSE 3000

CMD ["node", "src/server.ts"]
