import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('HTTP server exposes health, guest session, profile and quick game contracts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-http-'));
  const port = 4400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('server/src/server.ts')], {
    cwd: resolve('.'),
    env: { ...process.env, DOUJOY_PORT: String(port), DOUJOY_DATA_PATH: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as { ok: boolean; tokenMode: string };
    assert.deepEqual(health, { ok: true, service: 'doujoy', tokenMode: 'play-only' });
    const session = await fetch(`http://127.0.0.1:${port}/v1/sessions/guest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '契约测试' }),
    }).then((response) => response.json()) as { token: string; profile: { balance: number } };
    assert.equal(session.profile.balance, 10_000);
    const quick = await fetch(`http://127.0.0.1:${port}/v1/games/quick`, {
      method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json()) as { ok: boolean; game: { hand: unknown[]; players: unknown[]; phase: string } };
    assert.equal(quick.ok, true);
    assert.equal(quick.game.players.length, 3);
    assert.equal(quick.game.hand.length, 17);
    assert.equal(quick.game.phase, 'bidding');
    const resumed = await fetch(`http://127.0.0.1:${port}/v1/resume`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((response) => response.json()) as { game: { id: string }; room: null };
    assert.equal(resumed.game.id, quick.game.id);
    assert.equal(resumed.room, null);
    const report = await fetch(`http://127.0.0.1:${port}/v1/reports`, {
      method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: quick.game.id, reason: 'other' }),
    }).then((response) => response.json()) as { report: { created: boolean; status: string } };
    assert.equal(report.report.created, true);
    assert.equal(report.report.status, 'open');
    const abandoned = await fetch(`http://127.0.0.1:${port}/v1/games/${quick.game.id}/abandon`, {
      method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json()) as { ok: boolean; left: boolean; game: { phase: string; settlement: { winner: string } }; profile: { games: number } };
    assert.equal(abandoned.ok, true);
    assert.equal(abandoned.left, true);
    assert.equal(abandoned.game.phase, 'finished');
    assert.equal(abandoned.game.settlement.winner, 'farmers');
    assert.equal(abandoned.profile.games, 1);

    const second = await fetch(`http://127.0.0.1:${port}/v1/sessions/guest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '房主' }),
    }).then((response) => response.json()) as { token: string };
    const third = await fetch(`http://127.0.0.1:${port}/v1/sessions/guest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '好友' }),
    }).then((response) => response.json()) as { token: string };
    const room = await fetch(`http://127.0.0.1:${port}/v1/rooms`, {
      method: 'POST', headers: { authorization: `Bearer ${second.token}`, 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json()) as { room: { id: string; code: string } };
    const joined = await fetch(`http://127.0.0.1:${port}/v1/rooms/join`, {
      method: 'POST', headers: { authorization: `Bearer ${third.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: room.room.code }),
    }).then((response) => response.json()) as { room: { id: string; members: unknown[] } };
    assert.equal(joined.room.id, room.room.id);
    assert.equal(joined.room.members.length, 2);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
