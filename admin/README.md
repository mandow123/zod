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
npm run demo
npm run typecheck
npm test
npm run build
npm run release
```

## Local product demo

Run `npm run demo`, then open `http://127.0.0.1:4170`. This development-only
mode provides an in-process synthetic administrator session plus sample
dashboard, compute-order, device-order, payout, and top-up records. The console
labels the data as local demo data and never writes to a database.

`npm run dev` still expects a real administrator API. Demo mode cannot be used
for a production build, is not included in the production bundle, and must not
be treated as proof that production OIDC, database, DNS, or TLS is configured.

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

## Reproducible production release

Create the standalone release from a clean checkout with the public API origin
that will be compiled into the browser application:

```sh
VITE_ADMIN_API_ORIGIN=https://admin-api.example.invalid npm run release
```

The command is deliberately fail-closed. It validates that the value is one
canonical HTTPS origin, performs `npm ci` from `package-lock.json`, then runs
typecheck, every administrator test, and the production build before writing:

```text
../artifacts/admin/kai-admin-web.tar.gz
../artifacts/admin/kai-admin-web.tar.gz.sha256
```

The archive is deterministic for identical source, lockfile, Node/npm toolchain,
and API origin. Its ustar entries are sorted and have fixed ownership, mode, and
timestamps; gzip also uses a zero timestamp. The archive contains the production
source, compiled `dist/`, Dockerfile, Nginx template, dependency lockfile, release
metadata, offline verifier, and a sorted SHA-256 for every payload file.

The packaging allowlist excludes all `.env` files (including `.env.example`),
`node_modules`, tests, source maps, demo API/sample records, fixtures, and mocks.
Only the public API origin is recorded; credentials and Secrets must be supplied
through the deployment platform and never placed in this archive.

### Verify after extraction

Verify the downloaded archive checksum first, then extract it and verify every
payload digest plus the build/runtime origin contract:

```sh
cd ../artifacts/admin
shasum -a 256 -c kai-admin-web.tar.gz.sha256
mkdir verify && tar -xzf kai-admin-web.tar.gz -C verify
cd verify/kai-admin-web
ADMIN_API_ORIGIN=https://admin-api.example.invalid \
  node scripts/verify-release.mjs .
```

Verification fails if any file is added, removed, or changed; if a forbidden
path or common private-key/token signature is present; if the package and lock
dependencies drift; if the Docker/Nginx contract is missing; or if
`ADMIN_API_ORIGIN` differs from the `VITE_ADMIN_API_ORIGIN` marker and compiled
assets. The runtime origin is mandatory when invoking the verifier so an
operator cannot accidentally validate integrity while skipping that contract.
