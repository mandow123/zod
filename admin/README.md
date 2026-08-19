# KAI Admin Web

Independent React + TypeScript administrator console. It does not import the Expo application or mobile authentication code.

## Security model

- Authentication starts with a full-page navigation to `/admin/v1/auth/login`.
- The browser owns the `HttpOnly` administrator session cookie; JavaScript never reads or persists it.
- Every API request uses `credentials: include` against the fixed `VITE_ADMIN_API_ORIGIN`.
- The CSRF token is accepted only from `/admin/v1/auth/me`, kept in module memory, and attached only to mutating requests.
- No session, token, identity, or authorization material is written to `localStorage` or `sessionStorage`.

## Commands

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Production container

The supplied container is a multi-stage Node 24 build and a non-root Nginx
static server on port `8080`. It includes SPA history fallback, `no-store` HTML
caching, immutable Vite assets, `/healthz`, and CSP/HSTS/anti-framing headers.

The API origin is a security boundary. Build with a canonical HTTPS API origin
and provide the **identical** value at runtime. Both values are required; a
missing, malformed, or mismatched runtime value makes the container exit before
serving traffic. This prevents the compiled client and the CSP `connect-src`
policy from drifting apart.

```sh
docker build \
  --build-arg VITE_ADMIN_API_ORIGIN=https://admin-api.example.invalid \
  -t kai-admin-web:local \
  admin

docker run --rm -p 8080:8080 \
  -e ADMIN_API_ORIGIN=https://admin-api.example.invalid \
  kai-admin-web:local
```

Do not supply credentials, a path, query, fragment, whitespace, a Group, or a
secret in either value. Use a TLS-terminating ingress in production and expose
only the `8080` container port internally.
