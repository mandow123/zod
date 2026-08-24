# syntax=docker/dockerfile:1.7
FROM node:24.18.0-bookworm-slim
ENV NODE_ENV=production ZOD_ENV=staging STAGING_SANDBOX_ENABLED=true PORT=4187
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* && mkdir -p /app/staging-sandbox /data/zod-staging-sandbox \
  && chown -R node:node /app /data/zod-staging-sandbox
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts --include=dev
COPY --chown=node:node staging-sandbox ./staging-sandbox
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD ["node","-e","fetch('http://127.0.0.1:4187/mobile/v1/staging/health',{headers:{'x-zod-client-environment':'staging','x-kai-e2e-session':process.env.STAGING_OPERATOR_ACCESS_TOKEN}}).then(r=>{if(!r.ok||r.headers.get('x-zod-environment')!=='staging')process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["./node_modules/.bin/tsx","staging-sandbox/server.ts"]
