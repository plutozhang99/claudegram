# syntax=docker/dockerfile:1.6
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY src ./src

RUN addgroup -S harbor && adduser -S -G harbor harbor \
    && mkdir -p /app/data \
    && chown -R harbor:harbor /app
USER harbor

ENV HARBOR_PORT=7823 \
    HARBOR_DB_PATH=/app/data/harbor.db
EXPOSE 7823
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HARBOR_PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
