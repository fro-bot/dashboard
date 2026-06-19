FROM node:24-slim@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

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
