import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  KAI_AUTH_APP_REDIRECT,
  KAI_OIDC_CLIENT_ID,
  KAI_OIDC_ISSUER,
  parseKaiAuthCallback,
  validKaiAuthPending,
  validateKaiIdTokenClaims,
} from '../src/kai-auth-protocol.ts';

const state = 's'.repeat(48);
const callback = (parameters) => {
  const url = new URL(KAI_AUTH_APP_REDIRECT);
  url.searchParams.set('state', state);
  url.searchParams.set('iss', KAI_OIDC_ISSUER);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
};

test('KAI auth accepts only the registered HTTPS App Link, state and issuer', () => {
  const code = 'a'.repeat(64);
  assert.deepEqual(parseKaiAuthCallback(callback({ code })), { kind: 'code', code, state });
  assert.equal(parseKaiAuthCallback(`kaicloudpay://auth/kai/callback?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`https://cloud.kai.com/zod/oauth2redirect/other?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`https://evil.example/zod/oauth2redirect/kai?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`${KAI_AUTH_APP_REDIRECT}?code=${code}`).kind, 'error');
  assert.equal(parseKaiAuthCallback(callback({ code, iss: 'https://evil.example' })).kind, 'error');
  assert.equal(parseKaiAuthCallback(callback({ code: 'short' })).kind, 'error');
  assert.deepEqual(parseKaiAuthCallback(callback({ error: 'access_denied' })), {
    kind: 'error', error: 'access_denied', state,
  });
});

test('ID token identity claims are pinned to issuer, public client, nonce and subject', () => {
  const now = Date.parse('2026-08-18T04:00:00.000Z');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = {
    iss: KAI_OIDC_ISSUER, sub: 'user-123', aud: KAI_OIDC_CLIENT_ID, nonce: 'n'.repeat(48),
    iat: Math.floor(now / 1_000) - 10, exp: Math.floor(now / 1_000) + 300,
  };
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
  assert.equal(validateKaiIdTokenClaims(token, {
    nonce: payload.nonce, subject: payload.sub, nowMilliseconds: now,
  }).sub, payload.sub);
  assert.throws(() => validateKaiIdTokenClaims(token, { nonce: 'wrong', nowMilliseconds: now }));
  assert.throws(() => validateKaiIdTokenClaims(token, { subject: 'other', nowMilliseconds: now }));
  assert.throws(() => validateKaiIdTokenClaims(token, { nowMilliseconds: now + 400_000 }));
});

test('pending App PKCE is accepted only inside its bounded callback window', () => {
  const now = Date.parse('2026-08-15T04:00:00.000Z');
  assert.equal(validKaiAuthPending('2026-08-15T03:55:00.000Z', now), true);
  assert.equal(validKaiAuthPending('2026-08-15T03:49:59.000Z', now), false);
  assert.equal(validKaiAuthPending('2026-08-15T04:00:01.000Z', now), false);
});

test('production KAI login is direct public-client Authorization Code plus PKCE', async () => {
  const [auth, oidc, apiClient, session, metro, localAuth, appJson, manifest, assetLinks, fallback] = await Promise.all([
    readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-oidc-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../metro.config.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-auth.local-e2e.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/cloud.kai.com/.well-known/assetlinks.json', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/cloud.kai.com/zod/oauth2redirect/kai/index.html', import.meta.url), 'utf8'),
  ]);
  const formalSource = `${auth}\n${oidc}`;
  assert.match(formalSource, /ResponseType\.Code/u);
  assert.match(formalSource, /CodeChallengeMethod\.S256/u);
  assert.match(formalSource, /usePKCE:\s*true/u);
  assert.match(formalSource, /extraParams:\s*\{ nonce \}/u);
  assert.match(formalSource, /exchangeCodeAsync/u);
  assert.match(formalSource, /refreshAsync/u);
  assert.match(formalSource, /revokeAsync/u);
  assert.match(oidc, /response\.refreshToken === current\.refreshToken/u);
  assert.match(oidc, /scope: requireScope\(response\.scope\)/u);
  assert.match(apiClient, /refreshInFlight \?\?=/u);
  assert.match(apiClient, /sessionLogoutInProgress = true/u);
  assert.match(apiClient, /await refreshInFlight/u);
  assert.match(apiClient, /if \(!session \|\| sessionLogoutInProgress\) return null/u);
  assert.match(apiClient, /updateKaiOidcSessionTokens/u);
  assert.match(apiClient, /'X-KAI-ID-Token': idToken/u);
  assert.match(apiClient, /return session\?\.idToken/u);
  assert.match(auth, /tokens\.accessToken, tokens\.idToken/u);
  assert.doesNotMatch(formalSource, /\/mobile\/v1\/auth\/kai\/(?:start|exchange)/u);
  assert.doesNotMatch(formalSource, /kaicloudpay:\/\/auth\/kai\/callback/u);
  assert.doesNotMatch(formalSource, /clientSecret|client_secret|Authorization:\s*[`'"]Basic/iu);
  assert.doesNotMatch(`${formalSource}\n${apiClient}\n${session}`, /console\.(?:log|warn|error)/u);
  assert.match(session, /expo-secure-store/u);
  assert.match(session, /authProvider:\s*'kai_oidc'/u);
  assert.match(metro, /kai-auth\.local-e2e\.ts/u);
  assert.doesNotMatch(localAuth, /expo-auth-session|auth\.kai\.com|exchangeCodeAsync|refreshAsync/u);
  assert.match(appJson, /"host":\s*"cloud\.kai\.com"/u);
  assert.match(appJson, /"path":\s*"\/zod\/oauth2redirect\/kai"/u);
  assert.match(manifest, /android:autoVerify="true"/u);
  assert.match(manifest, /android:host="cloud\.kai\.com"/u);
  assert.match(manifest, /android:path="\/zod\/oauth2redirect\/kai"/u);
  const association = JSON.parse(assetLinks)[0];
  assert.equal(association.target.package_name, 'com.kaicloud.marketplace');
  assert.deepEqual(association.relation, ['delegate_permission/common.handle_all_urls']);
  assert.deepEqual(association.target.sha256_cert_fingerprints, [
    '20:44:1F:6B:59:3C:4F:19:C0:5A:C6:69:75:E2:84:69:DA:A8:4B:36:F1:8A:41:20:E0:DC:DA:66:1C:F1:99:6A',
  ]);
  assert.match(fallback, /name="referrer" content="no-referrer"/u);
  assert.match(fallback, /default-src 'none'/u);
  assert.doesNotMatch(fallback, /<script|<form|location|searchParams|code=|state=/iu);
});

test('all account entry copy says login happens in the system browser', async () => {
  const [authSheet, profile, accountSecurity] = await Promise.all([
    readFile(new URL('../src/AuthSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProfileScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/AccountSecuritySheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(authSheet, /系统浏览器中完成/u);
  assert.match(authSheet, /使用 KAI 账号登录/u);
  assert.match(authSheet, /KAI_CLOUD_UNIFIED_IDENTITY_V1/u);
  assert.doesNotMatch(profile, /在 App 内登录/u);
  assert.match(profile, /登录 Zod/u);
  assert.match(profile, /本机已退出/u);
  assert.match(profile, /本机安全、通知与账户状态/u);
  assert.match(accountSecurity, /REMOTE_ACCOUNT_SESSIONS_AVAILABLE \? listAccountSessions\(\) : Promise\.resolve\(\[\]\)/u);
  assert.match(accountSecurity, /!REMOTE_ACCOUNT_SESSIONS_AVAILABLE/u);
  assert.match(accountSecurity, /PUSH_INSTALLATION_AVAILABLE\s*\? loadPushStatus\(\)/u);
  assert.match(accountSecurity, /PUSH_INSTALLATION_AVAILABLE \? <View/u);
  assert.match(accountSecurity, /当前没有可核验的远程设备列表/u);
  assert.match(accountSecurity, /不会调用旧登录系统/u);
  assert.doesNotMatch(profile, /logoutCloudPay\(\)\.then\(onSessionChanged\)\.catch\(\(\) => onSessionChanged\(\)\)/u);
});

test('legal versions are bound to pending state and recorded before the OIDC session is saved', async () => {
  const auth = await readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8');
  assert.match(auth, /termsVersion: consents\.termsVersion\.trim\(\)/u);
  assert.match(auth, /privacyVersion: consents\.privacyVersion\.trim\(\)/u);
  assert.match(auth, /\/mobile\/v1\/auth\/kai\/consents/u);
  assert.match(auth, /attemptId: pending\.attemptId/u);
  assert.ok(auth.indexOf('/mobile/v1/auth/kai/consents') < auth.indexOf('saveKaiOidcSession({'));
  assert.match(auth, /tokens\.accessToken, tokens\.idToken/u);
  assert.match(auth, /consent\.accepted\.termsVersion !== pending\.termsVersion/u);
  assert.match(auth, /if \(tokens\) await revokeKaiOidcTokens\(tokens\)/u);
});

test('production auth is OIDC-only while old session endpoints are physically local-E2E', async () => {
  const [session, apiClient, api, logout, accountSecurity, localAccountSecurity, localSession, localClient, localLogout, metro] = await Promise.all([
    readFile(new URL('../src/session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session-logout.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/account-security.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/account-security-common.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session.local-e2e.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api-client.local-e2e.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session-logout.local-e2e.ts', import.meta.url), 'utf8'),
    readFile(new URL('../metro.config.js', import.meta.url), 'utf8'),
  ]);
  const production = `${session}\n${apiClient}\n${api}\n${logout}\n${accountSecurity}`;
  assert.doesNotMatch(production, /\/mobile\/v1\/auth\/(?:refresh|logout|sessions)/u);
  assert.doesNotMatch(session, /authProvider:\s*'cloudpay'/u);
  assert.match(session, /session\.authProvider === 'kai_oidc'/u);
  assert.match(session, /if \(!validSession\(value\)\) \{\s*await clearSession\(\)/u);
  assert.match(localSession, /authProvider:\s*'cloudpay'/u);
  assert.match(localClient, /\/mobile\/v1\/auth\/refresh/u);
  assert.match(localLogout, /\/mobile\/v1\/auth\/logout/u);
  assert.match(localAccountSecurity, /\/mobile\/v1\/auth\/sessions/u);
  assert.match(accountSecurity, /REMOTE_ACCOUNT_SESSIONS_AVAILABLE = false/u);
  assert.match(metro, /session\.local-e2e\.ts/u);
  assert.match(metro, /api-client\.local-e2e\.ts/u);
  assert.match(metro, /session-logout\.local-e2e\.ts/u);
});

test('failed remote revocation is encrypted and retained until authoritative revocation succeeds', async () => {
  const [queue, logout, apiClient, oidc, profile, app] = await Promise.all([
    readFile(new URL('../src/kai-revocation-queue.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session-logout.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-oidc-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProfileScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(queue, /expo-secure-store/u);
  assert.match(queue, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(queue, /current\.length >= MAX_PENDING_REVOCATIONS/u);
  assert.doesNotMatch(queue, /\.slice\(-MAX_PENDING_REVOCATIONS\)/u);
  assert.doesNotMatch(queue, /TTL|expiresAt|Date\.parse\(task\.expires/u);
  assert.match(queue, /KaiRevocationQueueIntegrityError/u);
  assert.match(queue, /!Array\.isArray\(parsed\) \|\| !parsed\.every\(validTask\)/u);
  assert.doesNotMatch(queue, /catch \{ return \[\]; \}/u);
  assert.match(queue, /addNetworkStateListener/u);
  assert.match(queue, /retryPendingKaiOidcRevocations/u);
  assert.doesNotMatch(queue, /saveKaiOidcSession|saveSession|console\./u);
  assert.ok(logout.indexOf('queueKaiOidcRevocation(session)') < logout.indexOf('clearSession()'));
  assert.match(logout, /if \(mayClearLocalSession\) await clearSession\(\)/u);
  assert.match(logout, /本机仍保留当前登录/u);
  assert.match(logout, /联网后自动撤销，不会恢复登录/u);
  assert.match(profile, /reason\.localSessionCleared \? '退出未完成'/u);
  assert.match(oidc, /KaiOidcRefreshValidationError/u);
  assert.match(oidc, /revocationCandidate/u);
  assert.match(apiClient, /queueKaiOidcRevocation\(error\.revocationCandidate\)/u);
  assert.match(apiClient, /isDefinitiveKaiOidcTokenInvalid\(error\)/u);
  assert.doesNotMatch(apiClient, /error\.name === 'TokenError'/u);
  assert.match(apiClient, /async function retireRejectedPairedSession\(\)/u);
  assert.match(apiClient, /await revokeKaiOidcTokens\(current\)/u);
  assert.match(apiClient, /await queueKaiOidcRevocation\(current\)/u);
  assert.match(apiClient, /AUTH_REVOCATION_PERSIST_FAILED/u);
  assert.match(apiClient, /本机仍保留当前登录/u);
  assert.ok(apiClient.indexOf('await queueKaiOidcRevocation(current)')
    < apiClient.indexOf('async function handlePairedRequestFailure'));
  assert.doesNotMatch(apiClient, /retryError\.status === 401\) await clearSession\(\)/u);
  assert.match(apiClient, /return handlePairedRequestFailure\(retryError\)/u);
  assert.match(apiClient, /return handlePairedRequestFailure\(latestError\)/u);
  assert.match(app, /startKaiOidcRevocationRetry/u);
  assert.match(app, /登录安全提醒/u);
});
