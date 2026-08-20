FROM node:22.18.0-alpine

WORKDIR /app/web
COPY web/index.html web/styles.css web/app.js web/casual-games.js web/serve.mjs ./

RUN addgroup -S doujoy && adduser -S doujoy -G doujoy \
  && chown -R doujoy:doujoy /app

USER doujoy

ENV NODE_ENV=production \
    DOUJOY_WEB_HOST=0.0.0.0 \
    DOUJOY_WEB_PORT=8081 \
    DOUJOY_WEB_UPSTREAM=http://doujoy-server:4310

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "serve.mjs"]
