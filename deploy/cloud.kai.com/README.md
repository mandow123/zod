# Zod Android App Link

Deploy `.well-known/assetlinks.json` at exactly:

`https://cloud.kai.com/.well-known/assetlinks.json`

Deployment requirements:

- return HTTP `200` directly, without a redirect;
- return `Content-Type: application/json`;
- return `Cache-Control: no-store` while the identity launch is being verified;
- serve the bytes from this repository without an HTML wrapper or authentication;
- keep the Android package name `com.kaicloud.marketplace` unchanged;
- keep the App manifest callback constrained to `/zod/oauth2redirect/kai`.

The current fingerprint is the verified KAI CloudPay Upload certificate used by the direct and Huawei release builds. Google Play App Signing uses a different certificate. Before publishing through Google Play, append its SHA-256 fingerprint to the same `sha256_cert_fingerprints` array; do not replace the direct/Huawei fingerprint.

Verification after deployment:

```sh
curl -i https://cloud.kai.com/.well-known/assetlinks.json
adb shell pm verify-app-links --re-verify com.kaicloud.marketplace
adb shell pm get-app-links com.kaicloud.marketplace
```

Do not enable the production login release gate until Android reports `cloud.kai.com` as verified for the release-signed APK.

## OAuth callback fallback

Deploy `zod/oauth2redirect/kai/index.html` at exactly:

`https://cloud.kai.com/zod/oauth2redirect/kai`

This is only a fail-closed fallback for devices where the verified App Link did not open Zod. The page contains no script, third-party content, form, redirect, or query-string reader. It must never display the authorization `code` or `state`.

Configure this exact route to:

- return `Cache-Control: no-store` and `Referrer-Policy: no-referrer`;
- return a strict `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` response header;
- disable query-string access logging, or redact the complete query before it reaches access, CDN, WAF, analytics, tracing, and error logs;
- avoid redirects and avoid analytics or error-reporting injection;
- never cache the request URL or response at the CDN.

The OAuth authorization code is short-lived and single-use, but it is still a credential. If the hosting layer cannot guarantee query redaction, do not expose the fallback page and keep the production login gate closed.
