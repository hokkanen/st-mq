# The Supervisor builds both supported architectures from this multi-arch image.
FROM node:22.23.2-alpine AS build
WORKDIR /st-mq
COPY package.json package-lock.json ./
RUN npm ci
COPY chart/ ./chart/
COPY src/ ./src/
COPY vite.config.js icon.png ./
RUN npm run build

FROM node:22.23.2-alpine AS sqlite-tools
RUN apk add --no-cache build-base curl unzip
COPY scripts/build-sqlite-rsync.js /build-sqlite-rsync.js
RUN node /build-sqlite-rsync.js --output /usr/local/bin/sqlite3_rsync

FROM node:22.23.2-alpine
ARG BUILD_VERSION=0.9.5-dev.1
ARG BUILD_ARCH
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="app" io.hass.arch="aarch64|amd64"
ENV NODE_ENV=production STMQ_ADDON=1 STMQ_HOST=0.0.0.0 STMQ_DATA_DIR=/data/st-mq STMQ_DATABASE_DIR=/config/st-mq
WORKDIR /st-mq
RUN apk add --no-cache openssh-client iproute2 iputils
COPY --from=sqlite-tools /usr/local/bin/sqlite3_rsync /usr/local/bin/sqlite3_rsync
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /st-mq/dist ./dist
COPY src/ ./src/
# Runtime and supported administration utilities only. Validation fixtures are
# mounted separately by scripts/test-addon-container.sh.
COPY scripts/history.js scripts/pair-vip.js scripts/pair-vip-addon \
     scripts/replica-receiver.js scripts/replica-ssh.js scripts/replica-verify.js \
     scripts/test-live.js ./scripts/
COPY docs/floor-preheat.md ./docs/floor-preheat.md
COPY test/live/ ./test/live/
COPY config.json ./
RUN install -m 0755 /st-mq/scripts/pair-vip-addon /usr/local/bin/st-mq-vip
# Default direct web, peer and OCPP ports; Supervisor assigns ingress at runtime.
EXPOSE 1234 1244 9001
CMD ["node", "src/main.js"]
