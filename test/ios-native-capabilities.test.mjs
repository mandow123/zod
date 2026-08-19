import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validExpoProjectId } from '../src/project-id.ts';
import { parseOwnedReferralToken } from '../src/external-link-policy.ts';

test('push project IDs reject missing and placeholder values', () => {
  assert.equal(validExpoProjectId(undefined), false);
  assert.equal(validExpoProjectId('your-project-id'), false);
  assert.equal(validExpoProjectId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(validExpoProjectId('123e4567-e89b-42d3-a456-426614174000'), true);
});

test('notification permission is requested only after build configuration validation', async () => {
  const source = await readFile(new URL('../src/account-security-common.ts', import.meta.url), 'utf8');
  const project = source.indexOf('validExpoProjectId');
  const request = source.indexOf('Notifications.requestPermissionsAsync');
  assert.ok(project >= 0 && request > project);
  assert.match(source, /pushNotificationsEnabled/u);
});

test('tokens and PKCE verifier keep the strongest required device-only accessibility', async () => {
  const [session, auth] = await Promise.all([
    readFile(new URL('../src/session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(session, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(auth, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.doesNotMatch(`${session}\n${auth}`, /console\.(?:log|warn|error)/u);
});

test('referral deep links accept only the app scheme or owned HTTPS origin', () => {
  const token = 'referral-token';
  assert.equal(parseOwnedReferralToken(`kaicloudpay://referral?token=${token}`), token);
  assert.equal(parseOwnedReferralToken(`https://cloudpay.kai.com/referral?token=${token}`), token);
  assert.equal(parseOwnedReferralToken(`https://evil.example/referral?token=${token}`), null);
  assert.equal(parseOwnedReferralToken(`javascript://referral?token=${token}`), null);
});

test('resolved iOS config declares associated domains, privacy reasons, encryption, splash and notifications', async () => {
  const source = await readFile(new URL('../app.config.js', import.meta.url), 'utf8');
  assert.match(source, /applinks:cloudpay\.kai\.com/u);
  assert.match(source, /usesNonExemptEncryption: false/u);
  assert.match(source, /NSPrivacyAccessedAPITypes/u);
  assert.match(source, /enableBackgroundRemoteNotifications: false/u);
  assert.match(source, /expo-splash-screen/u);
});

test('notification responses navigate only through the in-app notification identifier', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('const captureNotification');
  const end = app.indexOf('}, []);', start);
  assert.ok(start >= 0 && end > start);
  const handler = app.slice(start, end);
  assert.match(handler, /notificationId/u);
  assert.match(handler, /setActiveTab\('messages'\)/u);
  assert.doesNotMatch(handler, /Linking\.openURL|content\.data\.url/u);
});
