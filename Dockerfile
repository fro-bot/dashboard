FROM node:24-slim

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
