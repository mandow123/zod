import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  KAI_AUTH_APP_REDIRECT,
  createKaiAuthStartUrl,
  parseKaiAuthCallback,
  validKaiAuthPending,
} from '../src/kai-auth-protocol.ts';

test('KAI auth accepts only the registered exact App callback shape', () => {
  assert.deepEqual(
    parseKaiAuthCallback(`${KAI_AUTH_APP_REDIRECT}?code=${'a'.repeat(64)}`),
    { kind: 'code', code: 'a'.repeat(64) },
  );
  assert.equal(parseKaiAuthCallback(`otherapp://auth/kai/callback?code=${'a'.repeat(64)}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`kaicloudpay://evil/kai/callback?code=${'a'.repeat(64)}`).kind, 'ignored');
  assert.equal(parseKaiAuthCallback(`${KAI_AUTH_APP_REDIRECT}?code=short`).kind, 'error');
  assert.equal(parseKaiAuthCallback(`${KAI_AUTH_APP_REDIRECT}?error=authentication_cancelled`).kind, 'error');
});

test('KAI auth start contains only the App redirect and S256 challenge, never a client secret', () => {
  const challenge = 'b'.repeat(43);
  const start = new URL(createKaiAuthStartUrl('https://cloudpay.kai.com', challenge, {
    termsVersion: '2026-08-11', privacyVersion: '2026-08-11',
  }));
  assert.equal(start.origin + start.pathname, 'https://cloudpay.kai.com/mobile/v1/auth/kai/start');
  assert.equal(start.searchParams.get('appRedirect'), KAI_AUTH_APP_REDIRECT);
  assert.equal(start.searchParams.get('appChallenge'), challenge);
  assert.equal(start.searchParams.get('appChallengeMethod'), 'S256');
  assert.equal(start.searchParams.get('termsVersion'), '2026-08-11');
  assert.equal(start.searchParams.get('privacyVersion'), '2026-08-11');
  assert.equal(start.searchParams.has('client_id'), false);
  assert.equal(start.searchParams.has('client_secret'), false);
});

test('pending App PKCE is accepted only inside its bounded callback window', () => {
  const now = Date.parse('2026-08-15T04:00:00.000Z');
  assert.equal(validKaiAuthPending('2026-08-15T03:55:00.000Z', now), true);
  assert.equal(validKaiAuthPending('2026-08-15T03:49:59.000Z', now), false);
  assert.equal(validKaiAuthPending('2026-08-15T04:00:01.000Z', now), false);
});

test('all account entry copy agrees that KAI login leaves the App', async () => {
  const [authSheet, profile] = await Promise.all([
    readFile(new URL('../src/AuthSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProfileScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(authSheet, /系统浏览器中完成/u);
  assert.match(authSheet, /使用 KAI 账号登录/u);
  assert.match(authSheet, /KAI_CLOUD_UNIFIED_IDENTITY_V1/u);
  assert.doesNotMatch(profile, /在 App 内登录/u);
  assert.match(profile, /登录 Zod/u);
});
