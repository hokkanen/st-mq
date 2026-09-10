# Explicit Node image also works with older Supervisors that inject BUILD_FROM.
FROM node:22.23.2-alpine AS build
WORKDIR /st-mq
COPY package.json package-lock.json ./
RUN npm ci
COPY chart/ ./chart/
COPY src/ ./src/
COPY vite.config.js ./
RUN npm run build

FROM node:22.23.2-alpine AS sqlite-tools
RUN apk add --no-cache build-base curl unzip
COPY scripts/build-sqlite-rsync.js /build-sqlite-rsync.js
RUN node /build-sqlite-rsync.js --output /usr/local/bin/sqlite3_rsync

FROM node:22.23.2-alpine
ARG BUILD_VERSION=0.9.0
ARG BUILD_ARCH
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.arch="aarch64|amd64"
ENV NODE_ENV=production STMQ_ADDON=1 STMQ_HOST=0.0.0.0 STMQ_DATA_DIR=/data/st-mq STMQ_DATABASE_DIR=/config/st-mq
WORKDIR /st-mq
RUN apk add --no-cache openssh-client iproute2 iputils
COPY --from=sqlite-tools /usr/local/bin/sqlite3_rsync /usr/local/bin/sqlite3_rsync
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /st-mq/dist ./dist
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY test/live/ ./test/live/
COPY scheduler.js config.json ./
RUN install -m 0755 /st-mq/scripts/pair-vip-addon /usr/local/bin/st-mq-vip
EXPOSE 1234 8099 1244
CMD ["node", "src/main.js"]
