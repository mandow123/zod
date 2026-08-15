import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshAfterPendingAuthentication } from '../src/auth-refresh.ts';

test('登录成功后等待旧刷新结束，再读取新会话', async () => {
  const events = [];
  let finishPending;
  const pending = new Promise((resolve) => { finishPending = resolve; });
  const operation = refreshAfterPendingAuthentication(pending.then(() => { events.push('旧刷新结束'); }), async () => {
    events.push('读取新会话');
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  finishPending();
  await operation;
  assert.deepEqual(events, ['旧刷新结束', '读取新会话']);
});
