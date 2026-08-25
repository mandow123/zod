FROM node:22.18.0-alpine

WORKDIR /app

COPY package.json ./package.json
COPY core ./core
COPY server ./server

RUN addgroup -S doujoy && adduser -S doujoy -G doujoy \
  && mkdir -p /data && chown -R doujoy:doujoy /app /data

USER doujoy

ENV NODE_ENV=production \
    DOUJOY_PORT=4310 \
    DOUJOY_DATA_PATH=/data/state.json

EXPOSE 4310
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4310/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "server/src/server.ts"]
