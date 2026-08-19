import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type Session = { token: string; profile: { id: string } };
type Room = { id: string; code: string; version: number; status: string; gameId: string | null; members: unknown[] };
type Game = { id: string; sequence: number; phase: string };

const pause = (milliseconds: number) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

test('HTTP long polling wakes on room/game changes, caps timeouts, and cleans disconnected waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-sync-http-'));
  const port = 4800 + Math.floor(Math.random() * 400);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('server/src/server.ts')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      DOUJOY_PORT: String(port),
      DOUJOY_DATA_PATH: join(directory, 'state.json'),
      DOUJOY_WAIT_TIMEOUT_MAX_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const post = async <T extends object>(path: string, token?: string, input: object = {}, requestId?: string) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as T & { ok: boolean };
    assert.equal(response.ok, true, JSON.stringify(payload));
    return payload;
  };

  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('SERVER_START_TIMEOUT')), 10_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('DouJoy server listening')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      child.once('exit', (code) => reject(new Error(`SERVER_EXITED_${code}`)));
    });

    const host = await post<Session>('/v1/sessions/guest', undefined, { name: '房主' });
    const member = await post<Session>('/v1/sessions/guest', undefined, { name: '牌友' });
    const created = await post<{ room: Room }>('/v1/rooms', host.token);
    assert.equal(created.room.version, 1);

    const roomWait = fetch(`${origin}/v1/rooms/${created.room.id}/wait?version=1&timeoutMs=5000`, {
      headers: { authorization: `Bearer ${host.token}` },
    }).then((response) => response.json()) as Promise<{ changed: boolean; timedOut: boolean; version: number; room: Room }>;
    const joined = await post<{ room: Room }>('/v1/rooms/join', member.token, { code: created.room.code });
    const roomChange = await roomWait;
    assert.equal(roomChange.changed, true);
    assert.equal(roomChange.timedOut, false);
    assert.equal(roomChange.version, joined.room.version);
    assert.equal(roomChange.room.members.length, 2);

    const timeoutStartedAt = Date.now();
    const timeoutResponse = await fetch(`${origin}/v1/rooms/${created.room.id}/wait?version=${joined.room.version}&timeoutMs=5000`, {
      headers: { authorization: `Bearer ${host.token}` },
    }).then((response) => response.json()) as { changed: boolean; timedOut: boolean };
    const timeoutElapsed = Date.now() - timeoutStartedAt;
    assert.equal(timeoutResponse.changed, false);
    assert.equal(timeoutResponse.timedOut, true);
    assert.ok(timeoutElapsed >= 350 && timeoutElapsed < 2_000, `capped wait took ${timeoutElapsed}ms`);

    const startWait = fetch(`${origin}/v1/rooms/${created.room.id}/wait?version=${joined.room.version}&timeoutMs=5000`, {
      headers: { authorization: `Bearer ${member.token}` },
    }).then((response) => response.json()) as Promise<{ changed: boolean; room: Room }>;
    const started = await post<{ room: Room; game: Game }>(`/v1/rooms/${created.room.id}/start`, host.token);
    const startChange = await startWait;
    assert.equal(startChange.changed, true);
    assert.equal(startChange.room.status, 'playing');

    const gameWait = fetch(`${origin}/v1/games/${started.game.id}/wait?version=${started.game.sequence}&timeoutMs=5000`, {
      headers: { authorization: `Bearer ${host.token}` },
    }).then((response) => response.json()) as Promise<{ changed: boolean; timedOut: boolean; version: number; game: Game }>;
    const action = await post<{ game: Game }>(
      `/v1/games/${started.game.id}/bid`, host.token,
      { expectedSequence: started.game.sequence, score: 1 }, 'sync-action-1',
    );
    const gameChange = await gameWait;
    assert.equal(gameChange.changed, true);
    assert.equal(gameChange.timedOut, false);
    assert.equal(gameChange.version, action.game.sequence);

    const waitUrl = `${origin}/v1/games/${started.game.id}/wait?version=${action.game.sequence}&timeoutMs=5000`;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstWait = fetch(waitUrl, { headers: { authorization: `Bearer ${host.token}` }, signal: firstController.signal });
    const secondWait = fetch(waitUrl, { headers: { authorization: `Bearer ${host.token}` }, signal: secondController.signal });
    await pause(75);
    const limited = await fetch(waitUrl, { headers: { authorization: `Bearer ${host.token}` } });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'WAIT_LIMITED');

    firstController.abort();
    secondController.abort();
    await Promise.allSettled([firstWait, secondWait]);
    await pause(75);
    const afterDisconnect = await fetch(`${origin}/v1/games/${started.game.id}/wait?version=${action.game.sequence}&timeoutMs=20`, {
      headers: { authorization: `Bearer ${host.token}` },
    });
    assert.equal(afterDisconnect.status, 200);
    assert.equal(((await afterDisconnect.json()) as { timedOut: boolean }).timedOut, true);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
