# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . ./

# The API origin is deliberately required at build time. It is embedded in the
# static bundle and must equal ADMIN_API_ORIGIN supplied at container startup.
ARG VITE_ADMIN_API_ORIGIN
ENV VITE_ADMIN_API_ORIGIN=${VITE_ADMIN_API_ORIGIN}
RUN node -e "const value = process.env.VITE_ADMIN_API_ORIGIN ?? ''; let url; try { url = new URL(value); } catch { throw new Error('VITE_ADMIN_API_ORIGIN must be a URL'); } const valid = value === url.origin && url.protocol === 'https:' && !url.username && !url.password && !/[\u0000-\u001f\u007f\s]/.test(value); if (!valid) { throw new Error('VITE_ADMIN_API_ORIGIN must be one canonical HTTPS origin without credentials, path, query, fragment, or whitespace'); }" \
  && npm run build \
  && printf '%s' "$VITE_ADMIN_API_ORIGIN" > dist/.admin-api-origin

FROM nginx:1.28-alpine AS runtime

# The command below expands ADMIN_API_ORIGIN only after it matches the
# build-time marker. The unprivileged nginx account only binds port 8080 and
# owns the writable runtime directories.
RUN rm /etc/nginx/conf.d/default.conf \
  && sed -i -e '/^user[[:space:]]/d' -e 's#pid[[:space:]]\+/run/nginx.pid;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && mkdir -p /etc/nginx/templates /var/cache/nginx /var/run \
  && chown -R nginx:nginx /etc/nginx/conf.d /etc/nginx/templates /var/cache/nginx /var/run /usr/share/nginx/html

COPY --chown=nginx:nginx default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=nginx:nginx /app/dist/ /usr/share/nginx/html/

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# Do not use a default origin. The immutable build marker was parsed as a
# canonical HTTPS URL above; exact equality transfers that validation to the
# runtime value. A missing, whitespace-bearing, or mismatched value fails
# before nginx starts serving administrator pages.
CMD ["/bin/sh", "-ec", "value=\"${ADMIN_API_ORIGIN:-}\"; test -n \"$value\"; case \"$value\" in *[[:space:]]*) exit 64 ;; esac; test \"$value\" = \"$(cat /usr/share/nginx/html/.admin-api-origin)\"; envsubst '$ADMIN_API_ORIGIN' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'"]
