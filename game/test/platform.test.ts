import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseBotPlay } from '../core/bot.ts';
import { DouJoyPlatform, PlatformError } from '../server/src/platform.ts';
import { JsonGameStore } from '../server/src/store.ts';

type PlatformGameView = Awaited<ReturnType<DouJoyPlatform['quickGame']>>;

async function advanceBotTurns(platform: DouJoyPlatform, game: PlatformGameView, userId: string) {
  let current = game;
  while (current.phase !== 'finished' && current.players[current.currentSeat]!.isBot) {
    const beforeSequence = current.sequence;
    current = await platform.refreshedView(current.id, userId, Date.parse(current.updatedAt) + 10_000);
    assert.equal(current.sequence, beforeSequence + 1, 'each bot refresh must expose exactly one action');
  }
  return current;
}

test('a guest can finish an authoritative game and receive one ledger settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-'));
  try {
    const store = new JsonGameStore(join(directory, 'state.json'));
    await store.load();
    const platform = new DouJoyPlatform(store);
    const session = await platform.guest('小测');
    assert.equal(session.profile.balance, 10_000);
    let game = await platform.quickGame(session.profile.id);
    let action = 0;
    while (game.phase !== 'finished' && action < 300) {
      action += 1;
      const requestId = `test-${action}`;
      if (game.phase === 'bidding') {
        ({ game } = await platform.action({ gameId: game.id, userId: session.profile.id, requestId, expectedSequence: game.sequence, kind: 'bid', score: 1 }));
      } else {
        const selected = chooseBotPlay(game.hand, game.leadCombination);
        ({ game } = await platform.action({
          gameId: game.id, userId: session.profile.id, requestId,
          expectedSequence: game.sequence,
          kind: selected ? 'play' : 'pass', cardIds: selected?.map((card) => card.id),
        }));
      }
      game = await advanceBotTurns(platform, game, session.profile.id);
    }
    assert.equal(game.phase, 'finished');
    const history = platform.history(session.profile.id);
    assert.equal(history.games.length, 1);
    assert.equal(history.ledger.filter((entry) => entry.memo.includes('结算')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actions are idempotent and stale clients cannot advance a game', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-idempotency-'));
  try {
    const store = new JsonGameStore(join(directory, 'state.json'));
    await store.load();
    const platform = new DouJoyPlatform(store);
    const session = await platform.guest('幂等测试');
    const game = await platform.quickGame(session.profile.id);
    const input = {
      gameId: game.id, userId: session.profile.id, requestId: 'same-action',
      expectedSequence: game.sequence, kind: 'bid' as const, score: 3,
    };
    const first = await platform.action(input);
    const replay = await platform.action(input);
    assert.deepEqual(replay, first);
    await assert.rejects(
      () => platform.action({ ...input, requestId: 'stale-action' }),
      (error) => error instanceof PlatformError && error.code === 'STALE_GAME',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an offline player is safely auto-played after the configured turn timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-timeout-'));
  try {
    const store = new JsonGameStore(join(directory, 'state.json'));
    await store.load();
    const platform = new DouJoyPlatform(store, 10_000);
    const session = await platform.guest('离线测试');
    const game = await platform.quickGame(session.profile.id);
    const resume = await platform.resume(session.profile.id);
    assert.equal(resume.game?.id, game.id);
    assert.equal(resume.room, null);
    const beforeSequence = game.sequence;
    const refreshed = await platform.refreshedView(game.id, session.profile.id, Date.parse(game.updatedAt) + 10_001);
    assert.equal(refreshed.sequence, beforeSequence + 1);
    assert.notEqual(refreshed.phase, 'finished');
    assert.equal(refreshed.players[refreshed.currentSeat]!.isBot, true);
    const returned = await advanceBotTurns(platform, refreshed, session.profile.id);
    assert.equal(returned.currentSeat, returned.viewerSeat);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('relief is free, bounded, and claimable only once per day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-relief-'));
  try {
    const store = new JsonGameStore(join(directory, 'state.json'));
    await store.load();
    const platform = new DouJoyPlatform(store);
    const session = await platform.guest('补助测试');
    assert.equal((await platform.relief(session.profile.id)).claimed, false);
    store.post({
      key: 'test-spend', referenceType: 'game', referenceId: 'test',
      entries: [
        { accountId: session.profile.id, amount: -9_500, memo: '测试消耗' },
        { accountId: 'treasury', amount: 9_500, memo: '测试消耗' },
      ],
    });
    const first = await platform.relief(session.profile.id);
    const second = await platform.relief(session.profile.id);
    assert.equal(first.claimed, true);
    assert.equal(first.profile.balance, 2_000);
    assert.equal(second.claimed, false);
    assert.equal(second.profile.balance, 2_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('friend rooms support three humans, host controls, and private hands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-room-'));
  try {
    const store = new JsonGameStore(join(directory, 'state.json'));
    await store.load();
    const platform = new DouJoyPlatform(store);
    const one = await platform.guest('玩家一');
    const two = await platform.guest('玩家二');
    const three = await platform.guest('玩家三');
    const room = await platform.createRoom(one.profile.id);
    await platform.joinRoom(two.profile.id, room.code);
    const full = await platform.joinRoom(three.profile.id, room.code);
    assert.equal(full.members.length, 3);
    const waitingResume = await platform.resume(two.profile.id);
    assert.equal(waitingResume.room?.id, room.id);
    assert.equal(waitingResume.game, null);
    await assert.rejects(
      () => platform.startRoom(room.id, two.profile.id),
      (error) => error instanceof PlatformError && error.code === 'HOST_REQUIRED',
    );
    const started = await platform.startRoom(room.id, one.profile.id);
    assert.equal(started.game.players.every((player) => !player.isBot), true);
    assert.equal(started.game.hand.length, 17);
    assert.equal('hands' in started.game, false);
    const secondView = platform.view(started.game.id, two.profile.id);
    assert.equal(secondView.hand.length, 17);
    assert.notDeepEqual(secondView.hand, started.game.hand);
    let current = started.game;
    let action = 0;
    while (current.phase !== 'finished' && action < 400) {
      action += 1;
      const actor = current.players[current.currentSeat]!.id;
      const actorView = platform.view(current.id, actor);
      if (current.phase === 'bidding') {
        ({ game: current } = await platform.action({
          gameId: current.id, userId: actor, requestId: `room-${action}`,
          expectedSequence: current.sequence, kind: 'bid', score: 3,
        }));
      } else {
        const selected = chooseBotPlay(actorView.hand, actorView.leadCombination);
        ({ game: current } = await platform.action({
          gameId: current.id, userId: actor, requestId: `room-${action}`,
          expectedSequence: current.sequence, kind: selected ? 'play' : 'pass',
          cardIds: selected?.map((card) => card.id),
        }));
      }
    }
    assert.equal(current.phase, 'finished');
    assert.equal(Object.values(current.settlement!.deltas).reduce((sum, value) => sum + value, 0), 0);
    assert.equal([one, two, three].every((session) => platform.history(session.profile.id).games.length === 1), true);
    const report = await platform.report(two.profile.id, { gameId: current.id, reason: 'collusion' });
    const duplicate = await platform.report(two.profile.id, { gameId: current.id, reason: 'collusion' });
    assert.equal(report.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(report.id, duplicate.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
