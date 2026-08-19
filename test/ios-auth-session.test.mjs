import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { interpretKaiAuthSessionResult } from '../src/kai-auth-browser-result.ts';
import { resolveIosKaiAuthBrowserPolicy } from '../src/kai-auth-browser-policy.ts';
import {
  KAI_AUTH_APP_REDIRECT,
  KAI_AUTH_UNIVERSAL_REDIRECT,
} from '../src/kai-auth-protocol.ts';

test('iOS 17.3 uses the custom scheme and iOS 17.4 uses the universal callback', () => {
  assert.deepEqual(resolveIosKaiAuthBrowserPolicy(true, '17.3.1'), {
    redirectUrl: KAI_AUTH_APP_REDIRECT,
    preferUniversalLinks: false,
  });
  assert.deepEqual(resolveIosKaiAuthBrowserPolicy(true, '17.4'), {
    redirectUrl: KAI_AUTH_UNIVERSAL_REDIRECT,
    preferUniversalLinks: true,
  });
  assert.deepEqual(resolveIosKaiAuthBrowserPolicy(true, '18.0'), {
    redirectUrl: KAI_AUTH_UNIVERSAL_REDIRECT,
    preferUniversalLinks: true,
  });
  assert.deepEqual(resolveIosKaiAuthBrowserPolicy(true, 'unknown'), {
    redirectUrl: KAI_AUTH_APP_REDIRECT,
    preferUniversalLinks: false,
  });
  assert.deepEqual(resolveIosKaiAuthBrowserPolicy(false, '17.4'), {
    redirectUrl: KAI_AUTH_APP_REDIRECT,
    preferUniversalLinks: false,
  });
});

test('iOS auth session maps success, cancellation, dismissal, and timeout without exposing callback data', () => {
  const callback = `https://cloudpay.kai.com/mobile/auth/kai/callback?code=${'a'.repeat(64)}`;
  assert.equal(interpretKaiAuthSessionResult({ type: 'success', url: callback }), callback);
  assert.throws(() => interpretKaiAuthSessionResult({ type: 'cancel' }), /登录已取消/u);
  assert.throws(() => interpretKaiAuthSessionResult({ type: 'dismiss' }), /登录已取消/u);
  assert.throws(() => interpretKaiAuthSessionResult({ type: 'timeout' }), /超时/u);
  assert.throws(() => interpretKaiAuthSessionResult({ type: 'success', url: 'https://evil.example/callback' }), /回调/u);
});

test('iOS adapter uses SDK 57 ASWebAuthenticationSession universal-link option with a bounded timeout', async () => {
  const [adapter, auth, app] = await Promise.all([
    readFile(new URL('../src/kai-auth-browser.ios.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/kai-auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(adapter, /WebBrowser\.openAuthSessionAsync/u);
  assert.match(adapter, /Platform\.Version/u);
  assert.match(adapter, /preferUniversalLinks: policy\.preferUniversalLinks/u);
  assert.match(adapter, /KAI_AUTH_BROWSER_TIMEOUT_MILLISECONDS/u);
  assert.doesNotMatch(adapter, /console\.(?:log|warn|error)/u);
  assert.doesNotMatch(auth, /console\.(?:log|warn|error)/u);
  assert.match(auth, /const browserPolicy = getKaiAuthBrowserPolicy\(\)[\s\S]*?createKaiAuthStartUrl\([\s\S]*?browserPolicy\.redirectUrl/u);
  assert.match(app, /Linking\.getInitialURL\(\)/u);
  assert.match(app, /const handled = new Set<string>\(\)/u);
  assert.match(app, /handled\.has\(url\)/u);
});
