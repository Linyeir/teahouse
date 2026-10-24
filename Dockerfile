# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /app ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY --from=build /app/packages/client/dist packages/client/dist
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production \
  TEAHOUSE_DATA_DIR=/data \
  TEAHOUSE_CLIENT_DIR=/app/packages/client/dist \
  TEAHOUSE_PORT=8787
VOLUME /data
EXPOSE 8787
# Healthy once the server answers. /api/version needs no sign-in; the image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.TEAHOUSE_PORT}/api/version`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
