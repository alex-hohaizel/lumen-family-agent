FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY tools/release ./tools/release
COPY src ./src
COPY assets ./assets
COPY LICENSE ./
ARG LUMEN_BUILD_REVISION
RUN LUMEN_BUILD_REVISION="$LUMEN_BUILD_REVISION" npm run build:release && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RUNTIME_DIR=/app/runtime
# The packaged headless binary links to NSS/NSPR and Expat on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libnss3 libexpat1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.release ./
# Bot runs unprivileged; runtime is mounted with the invoking host user's ownership.
USER node
CMD ["node","dist/src/main.js"]
