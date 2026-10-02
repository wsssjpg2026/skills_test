# Optional prod-like image (architecture doc §6.2). Local dev does NOT need
# docker — `npm ci && npm run build && npm start` boots the embedded-mode kernel.
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY sdk ./sdk
RUN npm ci
RUN npm run build
# Keep only production deps (optional native deps better-sqlite3/serialport stay).
RUN npm prune --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    ORCH_CONFIG=/app/orch.config.json
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY orch.config.json orch.config.postgres.json ./
COPY plugins ./plugins
EXPOSE 8080
CMD ["node", "packages/kernel/dist/bin.js"]
