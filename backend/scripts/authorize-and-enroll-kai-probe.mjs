import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KAI_CLIENT_ID, KAI_ISSUER, refreshKaiProbeTokens, revokeKaiProbeFamily,
  verifyKaiProbeTokenPair } from './kai-probe-credential-core.mjs';

const CALLBACK_PORTS = [52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687];
const CALLBACK_PATH = '/oauth2redirect/kai';
const DISCOVERY_URL = `${KAI_ISSUER}/.well-known/openid-configuration`;
const REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const TARGET_HOST = '43.198.97.0';
const TARGET_USER = 'ubuntu';
const DEFAULT_TARGET_SCRIPT = '/opt/kai-cloudpay/candidate/deploy/direct-ubuntu/enroll-probe-refresh-credential.mjs';
const MAX_RESPONSE_BYTES = 65_536;

const opaque = (bytes = 48) => randomBytes(bytes).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('base64url');
const scopeSet = (value) => new Set(String(value ?? '').split(/\s+/u).filter(Boolean));

export function parseEnrollmentArguments(argv) {
  const result = { identityFile: '', host: TARGET_HOST };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]; const value = argv[index + 1];
    if (name === '--identity-file' && value) { result.identityFile = resolve(value); index += 1; }
    else if (name === '--host' && value) { result.host = value; index += 1; }
    else throw new Error(`KAI_PROBE_ENROLLMENT_ARGUMENT_INVALID:${name}`);
  }
  if (!result.identityFile || result.host !== TARGET_HOST) {
    throw new Error('KAI_PROBE_ENROLLMENT_TARGET_INVALID');
  }
  return result;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), ...options });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('KAI_OIDC_RESPONSE_TOO_LARGE');
  let value; try { value = JSON.parse(text); } catch { throw new Error('KAI_OIDC_RESPONSE_NOT_JSON'); }
  if (!response.ok) throw new Error(`KAI_OIDC_HTTP_${response.status}`);
  return value;
}

function secureEndpoint(value, expectedPath) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'auth.kai.com' || url.port || url.pathname !== expectedPath
    || url.username || url.password || url.search || url.hash) throw new Error('KAI_OIDC_DISCOVERY_ENDPOINT_INVALID');
  return url.toString();
}

async function loadDiscovery() {
  const value = await fetchJson(DISCOVERY_URL);
  if (value.issuer !== KAI_ISSUER) throw new Error('KAI_OIDC_DISCOVERY_ISSUER_INVALID');
  return {
    authorization: secureEndpoint(value.authorization_endpoint, '/api/auth/oauth2/authorize'),
    token: secureEndpoint(value.token_endpoint, '/api/auth/oauth2/token'),
    userinfo: secureEndpoint(value.userinfo_endpoint, '/api/auth/oauth2/userinfo'),
  };
}

async function listenForCallback(expectedState) {
  for (const port of CALLBACK_PORTS) {
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    let settle;
    const callback = new Promise((resolveCallback, rejectCallback) => { settle = { resolveCallback, rejectCallback }; });
    const server = createServer((request, response) => {
      const finish = (status, message) => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          'x-content-type-options': 'nosniff' });
        response.end(message);
      };
      try {
        if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}`) return finish(404, '未找到。');
        const url = new URL(request.url ?? '', redirectUri);
        if (url.pathname !== CALLBACK_PATH || url.hash
          || ['state', 'iss'].some((name) => url.searchParams.getAll(name).length !== 1)
          || ['code', 'error'].filter((name) => url.searchParams.has(name)).length !== 1
          || ['code', 'error'].some((name) => url.searchParams.getAll(name).length > 1)) {
          return finish(400, '授权回调无效，请关闭页面后重试。');
        }
        if (url.searchParams.get('state') !== expectedState || url.searchParams.get('iss') !== KAI_ISSUER) {
          return finish(400, '授权来源校验失败，请关闭页面后重试。');
        }
        const error = url.searchParams.get('error'); const code = url.searchParams.get('code');
        if (error) { finish(400, '授权未完成，可以关闭此页面。'); settle.rejectCallback(new Error('KAI_OIDC_AUTHORIZATION_REJECTED')); return; }
        if (!code || code.length < 20 || code.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(code)) {
          return finish(400, '授权码无效，请关闭页面后重试。');
        }
        finish(200, '专用测试账号授权已完成，可以返回 Codex。'); settle.resolveCallback(code);
      } catch { finish(400, '授权回调无效，请关闭页面后重试。'); }
    });
    const listening = await new Promise((resolveListening) => {
      server.once('error', () => resolveListening(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolveListening(true));
    });
    if (!listening) { server.close(); continue; }
    const timeout = setTimeout(() => settle.rejectCallback(new Error('KAI_OIDC_AUTHORIZATION_TIMEOUT')), 10 * 60_000);
    return { redirectUri, callback: callback.finally(() => { clearTimeout(timeout); server.close(); }) };
  }
  throw new Error('KAI_OIDC_NO_REGISTERED_LOOPBACK_PORT_AVAILABLE');
}

async function openBrowser(url) {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
  await new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(command, [url], { stdio: 'ignore' });
    child.once('error', rejectOpen);
    child.once('close', (status) => status === 0 ? resolveOpen() : rejectOpen(new Error('KAI_OIDC_BROWSER_OPEN_FAILED')));
  });
}

async function exchangeCode(endpoints, code, verifier, nonce, redirectUri) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: KAI_CLIENT_ID, code,
    code_verifier: verifier, redirect_uri: redirectUri });
  const value = await fetchJson(endpoints.token, { method: 'POST', headers: { accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const scopes = scopeSet(value.scope);
  if (typeof value.access_token !== 'string' || value.access_token.length < 20
    || typeof value.refresh_token !== 'string' || value.refresh_token.length < 20
    || typeof value.id_token !== 'string' || value.id_token.length < 40
    || String(value.token_type).toLowerCase() !== 'bearer'
    || !Number.isInteger(value.expires_in) || value.expires_in < 30 || value.expires_in > 3_600
    || REQUIRED_SCOPES.some((scope) => !scopes.has(scope))) throw new Error('KAI_OIDC_TOKEN_RESPONSE_INVALID');
  let subject;
  try { subject = JSON.parse(Buffer.from(value.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.sub; }
  catch { throw new Error('KAI_OIDC_SUBJECT_INVALID'); }
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > 512) throw new Error('KAI_OIDC_SUBJECT_INVALID');
  await verifyKaiProbeTokenPair(value.id_token, value.access_token, subject, { nonce });
  return { state: { schemaVersion: 1, refreshToken: value.refresh_token, subject }, accessToken: value.access_token };
}

async function verifyUserinfo(endpoint, accessToken, subject) {
  const value = await fetchJson(endpoint, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
  if (value.sub !== subject) throw new Error('KAI_OIDC_USERINFO_SUBJECT_MISMATCH');
}

function runSsh(args, stdin = '') {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const stdout = []; const stderr = []; let bytes = 0;
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
      bytes += chunk.length; if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
    });
    child.once('error', rejectRun);
    child.once('close', (status) => resolveRun({ status, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'), overflow: bytes > MAX_RESPONSE_BYTES }));
    child.stdin.end(stdin);
  });
}

async function remoteCommand(configuration, mode, stdin = '') {
  const args = ['-i', configuration.identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', `${TARGET_USER}@${configuration.host}`, 'sudo', '/usr/bin/node',
    DEFAULT_TARGET_SCRIPT, mode];
  return runSsh(args, stdin);
}

export async function authorizeAndEnroll(argv = process.argv.slice(2)) {
  const configuration = parseEnrollmentArguments(argv); await access(configuration.identityFile);
  const existing = await remoteCommand(configuration, '--status');
  if (existing.overflow || existing.status !== 0) throw new Error('KAI_PROBE_REMOTE_STATUS_UNCONFIRMED');
  if (JSON.parse(existing.stdout)?.present === true) throw new Error('KAI_PROBE_REFRESH_CREDENTIAL_ALREADY_EXISTS');
  const endpoints = await loadDiscovery(); const state = opaque(); const nonce = opaque(); const verifier = opaque(64);
  const listener = await listenForCallback(state); const challenge = sha256(verifier);
  const authorization = new URL(endpoints.authorization);
  for (const [name, value] of Object.entries({ client_id: KAI_CLIENT_ID, redirect_uri: listener.redirectUri,
    response_type: 'code', scope: REQUIRED_SCOPES.join(' '), state, nonce, code_challenge: challenge,
    code_challenge_method: 'S256', prompt: 'login' })) authorization.searchParams.set(name, value);
  await openBrowser(authorization.toString());
  const code = await listener.callback;
  let activeState;
  try {
    const initial = await exchangeCode(endpoints, code, verifier, nonce, listener.redirectUri);
    activeState = initial.state;
    await verifyUserinfo(endpoints.userinfo, initial.accessToken, initial.state.subject);
    const rotated = await refreshKaiProbeTokens(initial.state);
    activeState = rotated.nextState;
    await verifyUserinfo(endpoints.userinfo, rotated.accessToken, activeState.subject);
    const enrolled = await remoteCommand(configuration, '--enroll', `${JSON.stringify(activeState)}\n`);
    let enrollmentConfirmed = false;
    try { enrollmentConfirmed = enrolled.status === 0 && !enrolled.overflow && JSON.parse(enrolled.stdout)?.valid === true; } catch {}
    if (!enrollmentConfirmed) {
      const status = await remoteCommand(configuration, '--status');
      let credentialPresent = false;
      try { credentialPresent = status.status === 0 && !status.overflow && JSON.parse(status.stdout)?.present === true; } catch {}
      if (credentialPresent) {
        throw new Error('KAI_PROBE_ENROLLMENT_COMMIT_AMBIGUOUS_CREDENTIAL_PRESENT');
      }
      throw new Error('KAI_PROBE_ENROLLMENT_NOT_COMMITTED');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, enrolled: true, encryptedWithHostKey: true })}\n`);
  } catch (error) {
    if (activeState && !String(error?.message ?? '').includes('AMBIGUOUS_CREDENTIAL_PRESENT')) {
      await revokeKaiProbeFamily(activeState).catch(() => undefined);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  authorizeAndEnroll().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error).replace(/[^A-Z0-9_:.-]/giu, '')}\n`);
    process.exit(1);
  });
}
