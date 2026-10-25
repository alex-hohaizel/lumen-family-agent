FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RUNTIME_DIR=/app/runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/schema.sql ./src/schema.sql
COPY --from=build /app/assets ./assets
COPY package.json ./
# Bot runs unprivileged; runtime is mounted with the invoking host user's ownership.
USER node
CMD ["node","dist/src/main.js"]
