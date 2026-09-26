FROM oven/bun:1.3.11 AS build
WORKDIR /app
COPY evaluator/package.json evaluator/bun.lock ./
RUN bun install --frozen-lockfile
COPY evaluator/server.ts ./
COPY evaluator/client ./client
RUN bun run build

FROM oven/bun:1.3.11
WORKDIR /app
ENV PROMPTFOO_DISABLE_TELEMETRY=1 \
    PROMPTFOO_DISABLE_UPDATE=1 \
    HOME=/tmp
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
USER bun
ENTRYPOINT ["bun", "dist/server.mjs"]
