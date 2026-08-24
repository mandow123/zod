# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts/verify-container-env.mjs scripts/verify-production-env.mjs scripts/start-production-container.mjs scripts/record-inquiry-readiness.mjs scripts/record-inquiry-app-session.mjs scripts/rotate-kai-probe-credential.mjs scripts/run-inquiry-readiness-systemd.mjs scripts/kai-probe-credential-core.mjs scripts/persist-kai-probe-refresh.mjs scripts/prepare-kai-probe-revocation.mjs scripts/revoke-kai-probe-family.mjs scripts/finalize-kai-probe-revocation.mjs ./scripts/
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /var/lib/cloudpay-backup \
    && chown -R node:node /app /var/lib/cloudpay-backup
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/mobile/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start-production-container.mjs"]
