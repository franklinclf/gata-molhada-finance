FROM node:22-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build:web

FROM node:22-slim

ARG GIT_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/franklinclf/gata-molhada-finance"

ENV APP_VERSION=${GIT_SHA} \
    DB_PATH=/data/gmf.sqlite \
    PORT=8080

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY --from=web /build/dist/web ./dist/web

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
