import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const KAI_ISSUER = 'https://auth.kai.com/api/auth';
export const KAI_CLIENT_ID = 'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K';
export const KAI_TOKEN_ENDPOINT = `${KAI_ISSUER}/oauth2/token`;
export const KAI_REVOCATION_ENDPOINT = `${KAI_ISSUER}/oauth2/revoke`;
const KAI_JWKS = `${KAI_ISSUER}/jwks`;
const SCOPES = ['openid', 'profile', 'email'];
const remoteKey = createRemoteJWKSet(new URL(KAI_JWKS), { timeoutDuration: 5_000, cooldownDuration: 30_000 });

export function parseRefreshState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'refreshToken,schemaVersion,subject'
    || value.schemaVersion !== 1 || typeof value.refreshToken !== 'string' || value.refreshToken.length < 20
    || typeof value.subject !== 'string' || value.subject.length < 1 || value.subject.length > 512) {
    throw new Error('KAI_PROBE_REFRESH_STATE_INVALID');
  }
  return { schemaVersion: 1, refreshToken: value.refreshToken, subject: value.subject };
}

const REVOCATION_KEYS = 'ambiguousSince,attemptId,mode,originMode,preparedAt,reason,refreshToken,schemaVersion,subject';
const REVOCATION_MODES = new Set(['attempt_pending', 'revoke_only', 'manual_admin_required']);
export function parseKaiProbeCredentialState(value) {
  try { return parseRefreshState(value); } catch {}
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== REVOCATION_KEYS || value.schemaVersion !== 2
    || !REVOCATION_MODES.has(value.mode) || typeof value.refreshToken !== 'string' || value.refreshToken.length < 20
    || typeof value.subject !== 'string' || value.subject.length < 1 || value.subject.length > 512
    || typeof value.attemptId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.attemptId)
    || !['active', 'revoke_only'].includes(value.originMode) || !Number.isFinite(Date.parse(value.preparedAt))
    || !(value.ambiguousSince === null || (typeof value.ambiguousSince === 'string' && Number.isFinite(Date.parse(value.ambiguousSince))))
    || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 128
    || (value.mode === 'attempt_pending' && (value.ambiguousSince !== null || value.reason !== 'revocation_verification_pending'))
    || (value.mode === 'revoke_only' && (value.ambiguousSince !== null || value.reason !== 'candidate_refresh_isolated'))
    || (value.mode === 'manual_admin_required' && (typeof value.ambiguousSince !== 'string'
      || !['revocation_attempt_interrupted', 'revocation_confirmation_unconfirmed'].includes(value.reason)))) {
    throw new Error('KAI_PROBE_CREDENTIAL_STATE_INVALID');
  }
  return { schemaVersion: 2, mode: value.mode, refreshToken: value.refreshToken, subject: value.subject,
    attemptId: value.attemptId, originMode: value.originMode, preparedAt: value.preparedAt,
    ambiguousSince: value.ambiguousSince, reason: value.reason };
}

export function createRevocationAttempt(value, attemptId, preparedAt) {
  const current = parseKaiProbeCredentialState(value);
  if (current.schemaVersion === 2 && current.mode !== 'revoke_only') throw new Error('KAI_PROBE_REVOCATION_REQUIRES_ADMIN');
  const originMode = current.schemaVersion === 1 ? 'active' : 'revoke_only';
  return parseKaiProbeCredentialState({ schemaVersion: 2, mode: 'attempt_pending',
    refreshToken: current.refreshToken, subject: current.subject, attemptId, originMode, preparedAt,
    ambiguousSince: null, reason: 'revocation_verification_pending' });
}

export function createRevokeOnlyCandidate(attemptValue, refreshToken, preparedAt) {
  const attempt = parseKaiProbeCredentialState(attemptValue);
  if (attempt.mode !== 'attempt_pending' || typeof refreshToken !== 'string' || refreshToken.length < 20
    || refreshToken === attempt.refreshToken) throw new Error('KAI_PROBE_REVOCATION_CANDIDATE_INVALID');
  return parseKaiProbeCredentialState({ ...attempt, mode: 'revoke_only', refreshToken, preparedAt,
    ambiguousSince: null, reason: 'candidate_refresh_isolated' });
}

export function createManualAdminState(attemptValue, reason, preparedAt) {
  const attempt = parseKaiProbeCredentialState(attemptValue);
  if (attempt.mode !== 'attempt_pending' || !['revocation_attempt_interrupted', 'revocation_confirmation_unconfirmed'].includes(reason)) {
    throw new Error('KAI_PROBE_MANUAL_STATE_INVALID');
  }
  return parseKaiProbeCredentialState({ ...attempt, mode: 'manual_admin_required', preparedAt,
    ambiguousSince: attempt.ambiguousSince ?? attempt.preparedAt, reason });
}

export function validateLoopbackProbeDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('KAI_PROBE_DATABASE_URL_INVALID'); }
  const sslMode = url.searchParams.get('sslmode');
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.pathname || url.pathname === '/' || (sslMode !== null && sslMode !== 'disable')) {
    throw new Error('KAI_PROBE_DATABASE_MUST_BE_LOOPBACK');
  }
  return url.toString();
}

function atHash(accessToken) {
  return createHash('sha512').update(accessToken, 'utf8').digest().subarray(0, 32).toString('base64url');
}

export async function verifyKaiProbeTokenPair(idToken, accessToken, subject, expected = {}) {
  const result = await jwtVerify(idToken, remoteKey, { issuer: KAI_ISSUER, audience: KAI_CLIENT_ID,
    algorithms: ['EdDSA'], requiredClaims: ['sub', 'iat', 'exp', 'at_hash'], clockTolerance: 5 });
  if (result.payload.sub !== subject || result.payload.at_hash !== atHash(accessToken)
    || (expected.nonce !== undefined && result.payload.nonce !== expected.nonce)) {
    throw new Error('KAI_PROBE_TOKEN_PAIR_INVALID');
  }
  const audiences = Array.isArray(result.payload.aud) ? result.payload.aud : [result.payload.aud];
  if ((audiences.length > 1 && result.payload.azp !== KAI_CLIENT_ID)
    || (result.payload.azp !== undefined && result.payload.azp !== KAI_CLIENT_ID)) throw new Error('KAI_PROBE_TOKEN_AZP_INVALID');
}

async function postForm(url, body, fetcher) {
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 65_536) throw new Error('KAI_PROBE_UPSTREAM_RESPONSE_TOO_LARGE');
  return { response, text };
}

export async function refreshKaiProbeTokens(currentValue, options = {}) {
  const current = parseRefreshState(currentValue);
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: KAI_CLIENT_ID,
    refresh_token: current.refreshToken, scope: SCOPES.join(' ') });
  const { response, text } = await postForm(KAI_TOKEN_ENDPOINT, body, options.fetcher ?? fetch);
  const isJson = (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
  if (!response.ok || !isJson) {
    let errorCode;
    if (isJson) { try { errorCode = JSON.parse(text)?.error; } catch {} }
    throw new Error(response.status === 400 && isJson && errorCode === 'invalid_grant'
      ? 'KAI_PROBE_REFRESH_INVALID_GRANT' : 'KAI_PROBE_REFRESH_UNCONFIRMED');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('KAI_PROBE_REFRESH_RESPONSE_INVALID'); }
  const scopes = new Set(String(value.scope ?? '').split(/\s+/u).filter(Boolean));
  if (typeof value.access_token !== 'string' || value.access_token.length < 20
    || typeof value.id_token !== 'string' || value.id_token.length < 40
    || typeof value.refresh_token !== 'string' || value.refresh_token.length < 20
    || value.refresh_token === current.refreshToken || String(value.token_type).toLowerCase() !== 'bearer'
    || !Number.isInteger(value.expires_in) || value.expires_in < 30 || value.expires_in > 600
    || SCOPES.some((scope) => !scopes.has(scope))) throw new Error('KAI_PROBE_REFRESH_RESPONSE_INVALID');
  await (options.verifyPair ?? verifyKaiProbeTokenPair)(value.id_token, value.access_token, current.subject);
  return { accessToken: value.access_token, idToken: value.id_token,
    nextState: { schemaVersion: 1, refreshToken: value.refresh_token, subject: current.subject } };
}

export async function revokeKaiProbeFamily(currentValue, options = {}) {
  const current = parseRefreshState(currentValue);
  const body = new URLSearchParams({ token: current.refreshToken, token_type_hint: 'refresh_token', client_id: KAI_CLIENT_ID });
  let result;
  try { result = await postForm(KAI_REVOCATION_ENDPOINT, body, options.fetcher ?? fetch); }
  catch { throw new Error('KAI_PROBE_REVOCATION_UNCONFIRMED'); }
  if (!result.response.ok) throw new Error('KAI_PROBE_REVOCATION_UNCONFIRMED');
  const refreshBody = new URLSearchParams({ grant_type: 'refresh_token', client_id: KAI_CLIENT_ID,
    refresh_token: current.refreshToken, scope: SCOPES.join(' ') });
  let confirmation;
  try { confirmation = await postForm(KAI_TOKEN_ENDPOINT, refreshBody, options.fetcher ?? fetch); }
  catch { throw new Error('KAI_PROBE_REVOCATION_UNCONFIRMED'); }
  const isJson = (confirmation.response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
  let value;
  if (isJson) { try { value = JSON.parse(confirmation.text); } catch {} }
  if (confirmation.response.status === 400 && isJson && value?.error === 'invalid_grant') return { revoked: true };
  if (confirmation.response.ok && isJson && typeof value?.refresh_token === 'string'
    && value.refresh_token.length >= 20 && value.refresh_token !== current.refreshToken) {
    return { revoked: false, candidateRefreshToken: value.refresh_token };
  }
  throw new Error('KAI_PROBE_REVOCATION_UNCONFIRMED');
}

export async function prepareProbeRefreshState(credentialPath, runtimeDirectory) {
  const pairPath = resolve(runtimeDirectory, 'ephemeral-token-pair.json');
  const recoveredPath = resolve(runtimeDirectory, 'recovered-refresh-state.json');
  await rm(pairPath, { force: true });
  let value;
  try {
    value = JSON.parse(await readFile(recoveredPath, 'utf8'));
    await rm(recoveredPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    value = JSON.parse(await readFile(credentialPath, 'utf8'));
  }
  return parseRefreshState(value);
}

export async function withExclusiveRotationLock(path, action) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new Error('KAI_PROBE_ROTATION_ALREADY_RUNNING'); }
  try { return await action(); }
  finally { await handle.close(); await rm(path, { force: true }); }
}

export async function atomicWriteHandoff(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
