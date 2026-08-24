import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  KAI_AUTH_LOOPBACK_PORTS,
  KAI_OIDC_CLIENT_ID,
  KAI_OIDC_ISSUER,
  kaiAuthLoopbackRedirect,
  parseKaiAuthCallback,
  validKaiAuthExchangeRecovery,
  validKaiAuthRedirectUri,
  validKaiAuthPending,
  validateKaiIdTokenClaims,
} from '../src/kai-auth-protocol.ts';

const state = 's'.repeat(48);
const callback = (parameters) => {
  const url = new URL(kaiAuthLoopbackRedirect(KAI_AUTH_LOOPBACK_PORTS[0]));
  url.searchParams.set('state', state);
  url.searchParams.set('iss', KAI_OIDC_ISSUER);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
};

test('KAI auth accepts only an exact registered IPv4 loopback callback, state and issuer', () => {
  const code = 'a'.repeat(64);
  assert.deepEqual(parseKaiAuthCallback(callback({ code })), { kind: 'code', code, state });
  for (const port of KAI_AUTH_LOOPBACK_PORTS) assert.equal(validKaiAuthRedirectUri(kaiAuthLoopbackRedirect(port)), true);
  assert.equal(KAI_AUTH_LOOPBACK_PORTS.length, 9);
  assert.equal(validKaiAuthRedirectUri('http://localhost:52711/oauth2redirect/kai'), false);
  assert.equal(validKaiAuthRedirectUri('http://127.0.0.1:52712/oauth2redirect/kai'), false);
  assert.equal(validKaiAuthRedirectUri('http://[::1]:52711/oauth2redirect/kai'), false);
  assert.equal(parseKaiAuthCallback(`kaicloudpay://auth/kai/callback?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`com.kaicloud.marketplace:/oauth2redirect/other?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`com.kaicloud.marketplace://evil.example/oauth2redirect/kai?code=${code}&state=${state}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`${kaiAuthLoopbackRedirect(KAI_AUTH_LOOPBACK_PORTS[0])}?code=${code}`).kind, 'error');
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

test('received authorization is recoverable for only five minutes', () => {
  const now = Date.parse('2026-08-20T04:00:00.000Z');
  assert.equal(validKaiAuthExchangeRecovery('2026-08-20T03:55:00.000Z', now), true);
  assert.equal(validKaiAuthExchangeRecovery('2026-08-20T03:54:59.999Z', now), false);
  assert.equal(validKaiAuthExchangeRecovery('2026-08-20T04:00:00.001Z', now), false);
});

test('native terminal callback is adopted once after a process restart without losing browser-open state', async () => {
  const [auth, app, sheet, loopback, recoveryStore, module] = await Promise.all([
    readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/AuthSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/main/java/expo/modules/kaiauthloopback/LoopbackSessionManager.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/formal/java/expo/modules/kaiauthloopback/LoopbackCallbackRecoveryStore.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/main/java/expo/modules/kaiauthloopback/KaiAuthLoopbackModule.kt', import.meta.url), 'utf8'),
  ]);
  assert.ok(loopback.indexOf('session.recoveryStore.persist') < loopback.indexOf('writeResponse(client, 200'));
  assert.match(recoveryStore, /context\.noBackupFilesDir/u);
  assert.match(recoveryStore, /AES\/GCM\/NoPadding/u);
  assert.match(recoveryStore, /fun peek\(attemptId: String\)/u);
  assert.match(recoveryStore, /fun acknowledge\(attemptId: String, state: String\)/u);
  assert.match(module, /peekPersistedCallbackAsync/u);
  assert.match(module, /acknowledgePersistedCallbackAsync/u);
  assert.match(auth, /loadKaiAuthProgress[\s\S]*recoverPersistedKaiAuthCallback/u);
  const codeAdoption = auth.slice(
    auth.indexOf("phase: 'authorization_received'"),
    auth.indexOf('async function recoverPersistedKaiAuthCallback'),
  );
  assert.doesNotMatch(codeAdoption, /acknowledgePersistedKaiAuthCallbackAsync/u);
  assert.match(auth, /verifiedSaved = true;[\s\S]*await acknowledgeAndClearPending\(exchanging\)/u);
  assert.match(auth, /retain_encrypted_authorization[\s\S]*savePending\([\s\S]*identity_exchange_retry/u);
  assert.match(auth, /shouldClearPendingAfterKaiAuthStartFailure/u);
  assert.match(sheet, /authorizationFailed[\s\S]*onKaiAuthStart/u);
  assert.match(sheet, /重新选择 KAI 账号/u);
  assert.match(app, /catch \(reason\) \{[\s\S]*setKaiAuthError[\s\S]*await restoreKaiAuthStatus\(\)/u);
});

test('production KAI login is direct public-client Authorization Code plus PKCE', async () => {
  const [auth, oidc, protocol, loopback, keepAlive, recoveryStore, formalManifest, stagingManifest, formalPorts, stagingPorts, moduleGradle,
    apiClient, session, metro, localAuth, appJson, manifest, gradle] = await Promise.all([
    readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-oidc-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-auth-protocol.ts', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/main/java/expo/modules/kaiauthloopback/LoopbackSessionManager.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/main/java/expo/modules/kaiauthloopback/LoopbackKeepAliveService.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/formal/java/expo/modules/kaiauthloopback/LoopbackCallbackRecoveryStore.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/formal/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/staging/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/formal/java/expo/modules/kaiauthloopback/LoopbackPortBinder.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/src/staging/java/expo/modules/kaiauthloopback/LoopbackPortBinder.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/kai-auth-loopback/android/build.gradle', import.meta.url), 'utf8'),
    readFile(new URL('../src/api-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../metro.config.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-auth.local-e2e.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8'),
  ]);
  const formalSource = `${auth}\n${oidc}`;
  assert.match(formalSource, /ResponseType\.Code/u);
  assert.match(formalSource, /CodeChallengeMethod\.S256/u);
  assert.match(formalSource, /usePKCE:\s*true/u);
  assert.match(formalSource, /extraParams:\s*\{ nonce \}/u);
  assert.match(auth, /startKaiAuthLoopbackAsync/u);
  assert.match(auth, /SecureStore\.setItemAsync[\s\S]*redirectUri: listener\.redirectUri/u);
  assert.match(oidc, /redirectUri: input\.redirectUri/u);
  assert.match(protocol, /52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687/u);
  assert.match(formalPorts, /52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687/u);
  assert.doesNotMatch(stagingPorts, /52711|53419|54127|54833|55603|56311|57119|57901|58687/u);
  assert.match(stagingPorts, /emptyList<Int>\(\)/u);
  assert.match(moduleGradle, /CLOUDPAY_STAGING_DEMO/u);
  assert.match(moduleGradle, /kaiAuthLoopbackStaging \? 'src\/staging\/java' : 'src\/formal\/java'/u);
  assert.match(moduleGradle, /kaiAuthLoopbackStaging \? 'src\/staging\/AndroidManifest\.xml' : 'src\/formal\/AndroidManifest\.xml'/u);
  assert.match(loopback, /Collections\.shuffle\(shuffled, SecureRandom\(\)\)/u);
  assert.match(loopback, /SystemClock::elapsedRealtime/u);
  assert.match(loopback, /LoopbackLifetime\(SystemClock::elapsedRealtime\)/u);
  assert.match(loopback, /remainingMilliseconds\(\)/u);
  assert.match(recoveryStore, /AndroidKeyStore/u);
  assert.match(recoveryStore, /AES\/GCM\/NoPadding/u);
  assert.match(recoveryStore, /context\.noBackupFilesDir/u);
  assert.match(recoveryStore, /AtomicFile/u);
  assert.doesNotMatch(recoveryStore, /SharedPreferences|Log\./u);
  assert.match(auth, /acknowledgeAndClearPending/u);
  assert.match(keepAlive, /FOREGROUND_SERVICE_TYPE_SHORT_SERVICE/u);
  assert.match(keepAlive, /START_NOT_STICKY/u);
  assert.match(keepAlive, /ready\.get\(5, TimeUnit\.SECONDS\)/u);
  assert.match(keepAlive, /STOP_FOREGROUND_REMOVE/u);
  assert.match(keepAlive, /override fun onTimeout\(startId: Int, fgsType: Int\)/u);
  assert.match(await readFile(new URL('../modules/kai-auth-loopback/android/src/main/java/expo/modules/kaiauthloopback/KaiAuthLoopbackModule.kt', import.meta.url), 'utf8'), /Lifecycle\.State\.RESUMED/u);
  assert.match(loopback, /LoopbackKeepAliveService\.stop\(\)/u);
  assert.match(formalManifest, /android:permission="android\.permission\.FOREGROUND_SERVICE"|android\.permission\.FOREGROUND_SERVICE/u);
  assert.match(formalManifest, /android:exported="false"/u);
  assert.match(formalManifest, /android:foregroundServiceType="shortService"/u);
  assert.doesNotMatch(stagingManifest, /FOREGROUND_SERVICE|LoopbackKeepAliveService/u);
  assert.match(formalSource, /exchangeCodeAsync/u);
  const initialExchange = oidc.slice(
    oidc.indexOf('export async function exchangeKaiAuthorizationCode'),
    oidc.indexOf('export async function refreshKaiOidcTokens'),
  );
  assert.match(initialExchange, /validateIssuedKaiOidcTokenSet\([\s\S]*requiredScopes: KAI_OIDC_SCOPES[\s\S]*validateKaiIdTokenClaims\(idToken, \{ nonce: input\.nonce \}\)/u);
  const exchangeCompletion = auth.slice(auth.indexOf('async function completePendingAuthorization'));
  assert.match(exchangeCompletion, /error instanceof KaiOidcExchangeValidationError[\s\S]*revokeKaiOidcTokens[\s\S]*queueKaiOidcRevocation[\s\S]*clear: \(\) => acknowledgeAndClearPending\(exchanging\)/u);
  assert.match(oidc, /class KaiOidcExchangeNetworkError[\s\S]*throw new KaiOidcExchangeNetworkError\(\)/u);
  assert.match(auth, /error instanceof KaiOidcExchangeNetworkError/u);
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
  assert.match(auth, /identity\.accessToken, identity\.idToken/u);
  assert.doesNotMatch(formalSource, /\/mobile\/v1\/auth\/kai\/(?:start|exchange)/u);
  assert.doesNotMatch(formalSource, /kaicloudpay:\/\/auth\/kai\/callback/u);
  assert.doesNotMatch(formalSource, /clientSecret|client_secret|Authorization:\s*[`'"]Basic/iu);
  assert.doesNotMatch(`${formalSource}\n${apiClient}\n${session}`, /console\.(?:log|warn|error)/u);
  assert.match(session, /expo-secure-store/u);
  assert.match(session, /authProvider:\s*'kai_oidc'/u);
  assert.match(metro, /kai-auth\.local-e2e\.ts/u);
  assert.doesNotMatch(localAuth, /expo-auth-session|auth\.kai\.com|exchangeCodeAsync|refreshAsync/u);
  assert.match(appJson, /"scheme":\s*"kaicloudpay"/u);
  assert.doesNotMatch(appJson, /com\.kaicloud\.marketplace.*oauth2redirect|kaiAuthAppRedirect/u);
  assert.match(manifest, /android:scheme="\$\{cloudPayReferralScheme\}"/u);
  assert.doesNotMatch(manifest, /oauth2redirect|cloudPayAuth|android:autoVerify="true"/u);
  assert.match(gradle, /cloudPayReferralScheme:\s*"kaicloudpay"/u);
  assert.doesNotMatch(gradle, /cloudPayAuth(?:Scheme|Host|Path)/u);
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

test('verified KAI identity remains isolated until current legal consent succeeds', async () => {
  const auth = await readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8');
  const session = await readFile(new URL('../src/session.ts', import.meta.url), 'utf8');
  assert.match(auth, /saveVerifiedKaiIdentity/u);
  assert.match(session, /verified_pending_consent/u);
  assert.match(session, /VERIFIED_IDENTITY_KEY/u);
  const verifiedType = session.slice(session.indexOf('export type VerifiedKaiIdentity'), session.indexOf('function validSession'));
  assert.doesNotMatch(verifiedType, /user:\s*CloudPayUser/u);
  assert.match(auth, /platformBootstrap\(identity\)/u);
  assert.match(auth, /decodeKaiPlatformProfile\(profile\)/u);
  assert.match(auth, /decodeKaiPlatformLegalBootstrap\(legal\)\.documents/u);
  assert.match(auth, /\/mobile\/v1\/auth\/kai\/consents/u);
  assert.match(auth, /attemptId: identity\.attemptId/u);
  assert.ok(auth.indexOf('/mobile/v1/auth/kai/consents') < auth.indexOf('saveKaiOidcSession({'));
  assert.match(auth, /identity\.accessToken, identity\.idToken/u);
  assert.match(auth, /decodeKaiPlatformConsent\(consent, documents\)/u);
  assert.match(auth, /const session = await saveKaiOidcSession/u);
  assert.match(auth, /return reconcileCommittedKaiOidcSession\(session\)/u);
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
