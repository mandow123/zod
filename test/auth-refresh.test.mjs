import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishStoredAuthenticationCommit,
  promoteStoredAuthentication,
  publishStoredAuthentication,
  refreshAfterPendingAuthentication,
} from '../src/auth-refresh.ts';
import { readFile } from 'node:fs/promises';

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

test('consent session is published immediately and its forced refresh supersedes an old guest refresh', async () => {
  const events = [];
  let finishGuestRefresh;
  const pending = new Promise((resolve) => { finishGuestRefresh = resolve; });
  const session = { user: { id: 'kai-user' } };
  const operation = publishStoredAuthentication(
    pending.then(() => { events.push('旧访客快照'); }),
    session,
    () => { events.push('发布已存会话'); },
    async () => { events.push('刷新登录数据'); },
  );
  await Promise.resolve();
  assert.deepEqual(events, ['发布已存会话', '刷新登录数据']);
  finishGuestRefresh();
  assert.deepEqual(await operation, { session, refreshed: true });
  await pending;
  assert.deepEqual(events, ['发布已存会话', '刷新登录数据', '旧访客快照']);
});

test('failed guest refresh and failed post-consent refresh cannot return the stored session to visitor', async () => {
  const published = [];
  const session = { user: { id: 'kai-user' } };
  const result = await publishStoredAuthentication(
    Promise.reject(new Error('old guest refresh failed')),
    session,
    (stored) => { published.push(stored); },
    async () => { throw new Error('platform reads temporarily failed'); },
  );
  assert.deepEqual(result, { session, refreshed: false });
  assert.deepEqual(published, [session]);
});

test('a securely reloaded StoredSession restores authenticated offline state after process death', () => {
  const guestSnapshot = {
    authenticated: false,
    user: null,
    sessionState: 'anonymous',
    resources: [{ id: 'public-resource' }],
  };
  const storedUser = { id: 'kai-user', displayName: 'KAI User' };
  assert.deepEqual(promoteStoredAuthentication(guestSnapshot, storedUser), {
    authenticated: true,
    user: storedUser,
    sessionState: 'offline',
    resources: guestSnapshot.resources,
  });
});

test('StoredSession remains committed when verified-identity cleanup fails and cleanup retries later', async () => {
  const session = { user: { id: 'kai-user' }, stored: true };
  let attempts = 0;
  assert.equal(await finishStoredAuthenticationCommit(session, async () => {
    attempts += 1;
    throw new Error('secure cleanup temporarily unavailable');
  }), session);
  assert.equal(attempts, 1);
  assert.equal(await finishStoredAuthenticationCommit(session, async () => { attempts += 1; }), session);
  assert.equal(attempts, 2);
});

test('App startup recovery uses the same forced refresh generation as a just-accepted session', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const restore = app.slice(
    app.indexOf('const restoreStoredKaiSession'),
    app.indexOf("useEffect(() => {\n    let active = true;", app.indexOf('const restoreStoredKaiSession')),
  );
  assert.match(restore, /loadSession\(\)/u);
  assert.match(restore, /reconcileCommittedKaiOidcSession\(stored\)/u);
  assert.match(restore, /publishKaiSession\(session\)/u);
  const publish = app.slice(app.indexOf('const publishKaiSession'), app.indexOf('const restoreKaiAuthStatus'));
  assert.match(publish, /promoteStoredAuthentication/u);
  assert.match(publish, /\(\) => refresh\(true\)/u);
});
