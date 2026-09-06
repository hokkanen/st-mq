# Explicit default: builds work without Home Assistant supplying BUILD_FROM.
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM} AS build
WORKDIR /st-mq
COPY package.json package-lock.json ./
RUN npm ci
COPY chart/ ./chart/
COPY vite.config.js ./
RUN npm run build

FROM ${BUILD_FROM}
ARG BUILD_VERSION=0.8.0
ARG BUILD_ARCH
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.arch="aarch64|amd64"
ENV NODE_ENV=production STMQ_ADDON=1 STMQ_HOST=0.0.0.0 STMQ_DATA_DIR=/data/st-mq
WORKDIR /st-mq
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /st-mq/dist ./dist
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY scheduler.js config.json ./
EXPOSE 1234
CMD ["node", "src/main.js"]
