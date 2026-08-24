import assert from 'node:assert/strict';
import test from 'node:test';
import {
  subscribeToAppState,
  subscribeToAppUrls,
  subscribeToNotifications,
} from '../src/core/use-app-lifecycle.ts';

test('a late initial URL and runtime URL never invoke the app after unmount', async () => {
  let resolveInitialUrl;
  const initialUrl = new Promise((resolve) => { resolveInitialUrl = resolve; });
  let runtimeListener = null;
  let callbackCount = 0;
  let removeCount = 0;
  const unsubscribe = subscribeToAppUrls({
    getInitialURL: () => initialUrl,
    addEventListener: (_event, listener) => {
      runtimeListener = listener;
      return { remove: () => { removeCount += 1; } };
    },
  }, () => { callbackCount += 1; });
  unsubscribe();
  resolveInitialUrl('zod://auth/callback');
  await initialUrl;
  await Promise.resolve();
  runtimeListener({ url: 'zod://late-runtime-event' });
  assert.equal(removeCount, 1);
  assert.equal(callbackCount, 0);
});

test('AppState activates only on active and removes its listener', () => {
  let listener;
  let activeCount = 0;
  let removeCount = 0;
  const unsubscribe = subscribeToAppState({
    addEventListener: (_event, next) => {
      listener = next;
      return { remove: () => { removeCount += 1; } };
    },
  }, () => { activeCount += 1; });
  listener('background');
  listener('active');
  unsubscribe();
  assert.equal(activeCount, 1);
  assert.equal(removeCount, 1);
});

test('late notification response is guarded and listener is removed', async () => {
  let resolveLastResponse;
  const lastResponse = new Promise((resolve) => { resolveLastResponse = resolve; });
  let callbackCount = 0;
  let clearCount = 0;
  let removeCount = 0;
  const unsubscribe = subscribeToNotifications({
    getLastNotificationResponseAsync: () => lastResponse,
    clearLastNotificationResponseAsync: async () => { clearCount += 1; },
    addNotificationResponseReceivedListener: () => ({ remove: () => { removeCount += 1; } }),
  }, () => { callbackCount += 1; });
  unsubscribe();
  resolveLastResponse({ notification: {} });
  await lastResponse;
  await Promise.resolve();
  assert.equal(callbackCount, 0);
  assert.equal(clearCount, 0);
  assert.equal(removeCount, 1);
});
