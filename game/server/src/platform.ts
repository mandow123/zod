import { advanceBotTurn, advanceTimedOutPlayer, bid, createGame, forfeit, pass, play } from '../../core/engine.ts';
import { gameView } from '../../core/view.ts';
import { GameRuleError } from '../../core/types.ts';
import { JsonGameStore } from './store.ts';
import type { RoomRecord } from './store.ts';
import { randomInt, randomUUID } from 'node:crypto';
import { ChangeBroker } from './change-broker.ts';

export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DouJoyPlatform {
  readonly store: JsonGameStore;
  readonly turnTimeoutMs: number;
  readonly changes: ChangeBroker;
  readonly botThinkMinMs: number;
  readonly botThinkMaxMs: number;
  private readonly botTurnSchedules = new Map<string, { sequence: number; durationMs: number; deadlineMs: number }>();

  constructor(store: JsonGameStore, turnTimeoutMs = 45_000, botThinkMinMs = 1_200, botThinkMaxMs = 2_200, changes = new ChangeBroker()) {
    this.store = store;
    this.turnTimeoutMs = turnTimeoutMs;
    this.changes = changes;
    this.botThinkMinMs = botThinkMinMs;
    this.botThinkMaxMs = Math.max(botThinkMinMs, botThinkMaxMs);
  }

  private roomResource(roomId: string) { return `room:${roomId}`; }
  private gameResource(gameId: string) { return `game:${gameId}`; }

  private botTurnTiming(game: NonNullable<ReturnType<JsonGameStore['game']>>) {
    if (game.phase === 'finished' || !game.players[game.currentSeat]!.isBot) {
      this.botTurnSchedules.delete(game.id);
      return null;
    }
    const existing = this.botTurnSchedules.get(game.id);
    if (existing?.sequence === game.sequence) return existing;
    const durationMs = this.botThinkMinMs === this.botThinkMaxMs
      ? this.botThinkMinMs
      : randomInt(this.botThinkMinMs, this.botThinkMaxMs + 1);
    const timing = { sequence: game.sequence, durationMs, deadlineMs: Date.parse(game.updatedAt) + durationMs };
    this.botTurnSchedules.set(game.id, timing);
    return timing;
  }

  private timedGameView(game: NonNullable<ReturnType<JsonGameStore['game']>>, userId: string) {
    const timing = this.botTurnTiming(game);
    const player = game.players[game.currentSeat];
    return {
      ...gameView(game, userId),
      turn: game.phase === 'finished' ? null : {
        kind: player?.isBot ? 'bot' as const : 'human' as const,
        durationMs: timing?.durationMs ?? this.turnTimeoutMs,
        deadline: new Date(timing?.deadlineMs ?? (Date.parse(game.updatedAt) + this.turnTimeoutMs)).toISOString(),
      },
    };
  }

  private advanceReadyBot(game: NonNullable<ReturnType<JsonGameStore['game']>>, at: number) {
    const timing = this.botTurnTiming(game);
    if (!timing || at < timing.deadlineMs) return false;
    this.botTurnSchedules.delete(game.id);
    return advanceBotTurn(game);
  }

  private touchRoom(room: RoomRecord) {
    room.version += 1;
    room.updatedAt = new Date().toISOString();
  }

  private finishRoomForGame(gameId: string) {
    const room = this.store.roomForGame(gameId);
    if (!room || room.status === 'finished') return null;
    room.status = 'finished';
    this.touchRoom(room);
    return room.id;
  }

  async guest(name?: string) {
    const safeName = name?.trim().slice(0, 12) || `牌友${Math.floor(1000 + Math.random() * 9000)}`;
    const session = this.store.createUser(safeName);
    await this.store.save();
    return { token: session.token, profile: this.profile(session.user.id) };
  }

  authenticate(authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const user = this.store.userForToken(token);
    if (!user) throw new PlatformError(401, 'UNAUTHORIZED', '登录状态已失效，请重新进入。');
    return user;
  }

  profile(userId: string) {
    const user = this.store.user(userId);
    if (!user) throw new PlatformError(404, 'USER_NOT_FOUND', '玩家不存在。');
    const games = this.store.gamesForUser(userId).filter((game) => game.phase === 'finished');
    const wins = games.filter((game) => {
      const seat = game.players.findIndex((player) => player.id === userId);
      const role = game.players[seat]?.role;
      return game.settlement && ((role === 'landlord') === (game.settlement.winner === 'landlord'));
    }).length;
    return {
      id: user.id, name: user.name, balance: this.store.balance(userId),
      games: games.length, wins, winRate: games.length ? Math.round(wins / games.length * 100) : 0,
      tokenPolicy: { purchasable: false, withdrawable: false, transferable: false, redeemable: false },
    };
  }

  async quickGame(userId: string) {
    const active = this.store.gamesForUser(userId).find((game) => game.phase !== 'finished');
    if (active) return this.view(active.id, userId);
    const waitingRoom = this.store.roomsForUser(userId).find((room) => room.status === 'waiting');
    if (waitingRoom) throw new PlatformError(409, 'ROOM_WAITING', '你正在好友房中，请先返回房间或退出。');
    const balance = this.store.balance(userId);
    if (balance < 128) throw new PlatformError(409, 'RELIEF_REQUIRED', '竞技分不足，请先领取今日补助。');
    const user = this.store.user(userId)!;
    const game = createGame({ humanId: userId, humanName: user.name, baseStake: Math.min(100, Math.floor(balance / 128)) });
    this.store.putGame(game);
    await this.store.save();
    return this.timedGameView(game, userId);
  }

  private roomView(room: RoomRecord, userId: string) {
    if (!room.memberIds.includes(userId)) throw new PlatformError(403, 'ROOM_FORBIDDEN', '你不在这个房间里。');
    return {
      id: room.id, code: room.code, version: room.version, status: room.status, hostId: room.hostId,
      isHost: room.hostId === userId, gameId: room.gameId,
      members: room.memberIds.map((id) => {
        const user = this.store.user(id);
        return { id, name: user?.name ?? '玩家', isYou: id === userId };
      }),
      updatedAt: room.updatedAt,
    };
  }

  async createRoom(userId: string) {
    const existing = this.store.roomsForUser(userId).find((room) => room.status !== 'finished');
    if (existing) return this.roomView(existing, userId);
    if (this.store.gamesForUser(userId).some((game) => game.phase !== 'finished')) {
      throw new PlatformError(409, 'GAME_IN_PROGRESS', '你有未结束的牌局，请先返回牌局。');
    }
    let code = '';
    do { code = String(randomInt(100_000, 1_000_000)); } while (this.store.roomByCode(code));
    const timestamp = new Date().toISOString();
    const room: RoomRecord = {
      id: randomUUID(), code, version: 1, hostId: userId, memberIds: [userId], status: 'waiting',
      gameId: null, createdAt: timestamp, updatedAt: timestamp,
    };
    this.store.putRoom(room);
    await this.store.save();
    return this.roomView(room, userId);
  }

  async joinRoom(userId: string, codeInput: string) {
    if (this.store.gamesForUser(userId).some((game) => game.phase !== 'finished')) {
      throw new PlatformError(409, 'GAME_IN_PROGRESS', '你有未结束的牌局，请先返回牌局。');
    }
    const code = codeInput.trim();
    if (!/^\d{6}$/.test(code)) throw new PlatformError(400, 'ROOM_CODE_INVALID', '请输入 6 位房间号。');
    const room = this.store.roomByCode(code);
    if (!room) throw new PlatformError(404, 'ROOM_NOT_FOUND', '房间不存在或已经开局。');
    if (!room.memberIds.includes(userId)) {
      if (room.memberIds.length >= 3) throw new PlatformError(409, 'ROOM_FULL', '房间已经满员。');
      room.memberIds.push(userId);
      this.touchRoom(room);
    }
    await this.store.save();
    this.changes.notify(this.roomResource(room.id));
    return this.roomView(room, userId);
  }

  room(roomId: string, userId: string) {
    const room = this.store.room(roomId);
    if (!room) throw new PlatformError(404, 'ROOM_NOT_FOUND', '房间不存在。');
    return this.roomView(room, userId);
  }

  async waitRoom(roomId: string, userId: string, version: number, timeoutMs: number, signal?: AbortSignal) {
    let room = this.room(roomId, userId);
    if (room.version !== version) return { room, version: room.version, changed: true, timedOut: false };

    const resource = this.roomResource(roomId);
    const generation = this.changes.generation(resource);
    room = this.room(roomId, userId);
    if (room.version !== version) return { room, version: room.version, changed: true, timedOut: false };

    const outcome = await this.changes.wait(resource, generation, timeoutMs, signal);
    if (outcome === 'aborted') return null;
    room = this.room(roomId, userId);
    return { room, version: room.version, changed: room.version !== version, timedOut: outcome === 'timeout' };
  }

  async startRoom(roomId: string, userId: string) {
    const room = this.store.room(roomId);
    if (!room) throw new PlatformError(404, 'ROOM_NOT_FOUND', '房间不存在。');
    if (room.hostId !== userId) throw new PlatformError(403, 'HOST_REQUIRED', '只有房主可以开始。');
    if (room.status !== 'waiting') throw new PlatformError(409, 'ROOM_ALREADY_STARTED', '房间已经开局。');
    const humans = room.memberIds.map((id) => this.store.user(id)!).filter(Boolean);
    const poorPlayer = humans.find((user) => this.store.balance(user.id) < 128);
    if (poorPlayer) throw new PlatformError(409, 'PLAYER_RELIEF_REQUIRED', `${poorPlayer.name} 竞技分不足，需要先领取补助。`);
    const botNames = ['阿满', '小禾'];
    const players = humans.map((user) => ({ id: user.id, name: user.name, isBot: false }));
    while (players.length < 3) players.push({ id: `bot:${randomUUID()}`, name: botNames[players.length - humans.length]!, isBot: true });
    const balance = Math.min(...humans.map((user) => this.store.balance(user.id)));
    const game = createGame({
      humanId: humans[0]!.id, humanName: humans[0]!.name,
      baseStake: Math.min(100, Math.floor(balance / 128)), players,
    });
    this.store.putGame(game);
    room.gameId = game.id;
    room.status = 'playing';
    this.touchRoom(room);
    await this.store.save();
    this.changes.notify(this.roomResource(room.id));
    return { room: this.roomView(room, userId), game: this.timedGameView(game, userId) };
  }

  async leaveRoom(roomId: string, userId: string) {
    const room = this.store.room(roomId);
    if (!room) return { left: true };
    if (room.status !== 'waiting') throw new PlatformError(409, 'ROOM_ALREADY_STARTED', '牌局开始后不能退出房间。');
    room.memberIds = room.memberIds.filter((id) => id !== userId);
    if (room.hostId === userId && room.memberIds[0]) room.hostId = room.memberIds[0];
    if (room.memberIds.length === 0) room.status = 'finished';
    this.touchRoom(room);
    await this.store.save();
    this.changes.notify(this.roomResource(room.id));
    return { left: true };
  }

  async resume(userId: string) {
    const active = this.store.gamesForUser(userId).find((game) => game.phase !== 'finished');
    if (active) return { game: await this.refreshedView(active.id, userId), room: null };
    const room = this.store.roomsForUser(userId).find((candidate) => candidate.status === 'waiting');
    return { game: null, room: room ? this.roomView(room, userId) : null };
  }

  view(gameId: string, userId: string) {
    const game = this.store.game(gameId);
    if (!game) throw new PlatformError(404, 'GAME_NOT_FOUND', '牌局不存在。');
    if (!game.players.some((player) => player.id === userId)) throw new PlatformError(403, 'GAME_FORBIDDEN', '你不在这局牌中。');
    return this.timedGameView(game, userId);
  }

  async refreshedView(gameId: string, userId: string, at = Date.now()) {
    const game = this.store.game(gameId);
    if (!game) throw new PlatformError(404, 'GAME_NOT_FOUND', '牌局不存在。');
    if (!game.players.some((player) => player.id === userId)) throw new PlatformError(403, 'GAME_FORBIDDEN', '你不在这局牌中。');
    if (this.advanceReadyBot(game, at) || advanceTimedOutPlayer(game, at, this.turnTimeoutMs)) {
      this.postSettlement(game);
      const finishedRoomId = game.phase === 'finished' ? this.finishRoomForGame(game.id) : null;
      await this.store.save();
      this.changes.notify(this.gameResource(game.id));
      if (finishedRoomId) this.changes.notify(this.roomResource(finishedRoomId));
    }
    return this.timedGameView(game, userId);
  }

  async waitGame(gameId: string, userId: string, version: number, timeoutMs: number, signal?: AbortSignal) {
    let game = await this.refreshedView(gameId, userId);
    if (game.sequence !== version) return { game, version: game.sequence, changed: true, timedOut: false };

    const resource = this.gameResource(gameId);
    const generation = this.changes.generation(resource);
    game = this.view(gameId, userId);
    if (game.sequence !== version) return { game, version: game.sequence, changed: true, timedOut: false };

    const botDeadline = game.turn?.kind === 'bot' ? Date.parse(game.turn.deadline) : null;
    const effectiveTimeout = botDeadline === null ? timeoutMs : Math.min(timeoutMs, Math.max(1, botDeadline - Date.now()));
    const outcome = await this.changes.wait(resource, generation, effectiveTimeout, signal);
    if (outcome === 'aborted') return null;
    game = await this.refreshedView(gameId, userId);
    return { game, version: game.sequence, changed: game.sequence !== version, timedOut: outcome === 'timeout' };
  }

  private postSettlement(game: NonNullable<ReturnType<JsonGameStore['game']>>) {
    if (game.phase !== 'finished' || !game.settlement) return;
    this.store.post({
      key: `settlement:${game.id}`, referenceType: 'game', referenceId: game.id,
      entries: Object.entries(game.settlement.deltas).map(([accountId, amount]) => ({ accountId, amount, memo: `对局 ${game.id.slice(0, 8)} 结算` })),
    });
  }

  async action(input: Readonly<{
    gameId: string;
    userId: string;
    requestId: string;
    expectedSequence: number;
    kind: 'bid' | 'play' | 'pass';
    score?: number;
    cardIds?: readonly string[];
  }>) {
    if (!input.requestId || input.requestId.length > 100) throw new PlatformError(400, 'REQUEST_ID_REQUIRED', '缺少有效的请求编号。');
    const key = `${input.userId}:${input.gameId}:${input.requestId}`;
    const replay = this.store.actionResult(key);
    if (replay) return replay;
    const game = this.store.game(input.gameId);
    if (!game) throw new PlatformError(404, 'GAME_NOT_FOUND', '牌局不存在。');
    if (!Number.isInteger(input.expectedSequence) || input.expectedSequence !== game.sequence) {
      throw new PlatformError(409, 'STALE_GAME', '牌局状态已经更新，请刷新后重试。');
    }
    try {
      if (input.kind === 'bid') bid(game, input.userId, input.score as 0 | 1 | 2 | 3);
      else if (input.kind === 'play') play(game, input.userId, input.cardIds ?? []);
      else pass(game, input.userId);
    } catch (error) {
      if (error instanceof GameRuleError) throw new PlatformError(409, error.code, error.message);
      throw error;
    }
    this.postSettlement(game);
    const finishedRoomId = game.phase === 'finished' ? this.finishRoomForGame(game.id) : null;
    const result = { game: this.timedGameView(game, input.userId), profile: this.profile(input.userId) };
    this.store.setActionResult(key, result);
    await this.store.save();
    this.changes.notify(this.gameResource(game.id));
    if (finishedRoomId) this.changes.notify(this.roomResource(finishedRoomId));
    return result;
  }

  async abandonGame(gameId: string, userId: string) {
    const game = this.store.game(gameId);
    if (!game) throw new PlatformError(404, 'GAME_NOT_FOUND', '牌局不存在。');
    if (!game.players.some((player) => player.id === userId)) throw new PlatformError(403, 'GAME_FORBIDDEN', '你不在这局牌中。');
    if (game.phase !== 'finished') forfeit(game, userId);
    this.botTurnSchedules.delete(game.id);
    this.postSettlement(game);
    const finishedRoomId = this.finishRoomForGame(game.id);
    await this.store.save();
    this.changes.notify(this.gameResource(game.id));
    if (finishedRoomId) this.changes.notify(this.roomResource(finishedRoomId));
    return { left: true, game: this.timedGameView(game, userId), profile: this.profile(userId) };
  }

  async relief(userId: string) {
    const claimed = this.store.claimRelief(userId);
    await this.store.save();
    return { claimed, profile: this.profile(userId) };
  }

  history(userId: string) {
    return {
      games: this.store.gamesForUser(userId).filter((game) => game.phase === 'finished').slice(0, 20).map((game) => ({
        id: game.id, updatedAt: game.updatedAt, role: game.players.find((player) => player.id === userId)?.role,
        winner: game.settlement?.winner, multiplier: game.settlement?.multiplier,
        delta: game.settlement?.deltas[userId] ?? 0,
      })),
      ledger: this.store.entries(userId),
    };
  }

  async report(userId: string, input: Readonly<{ gameId: string; reason: string; detail?: string }>) {
    const game = this.store.game(input.gameId);
    if (!game || !game.players.some((player) => player.id === userId)) {
      throw new PlatformError(404, 'REPORT_GAME_NOT_FOUND', '只能举报自己参与过的牌局。');
    }
    const allowed = ['collusion', 'cheating', 'harassment', 'other'] as const;
    if (!allowed.includes(input.reason as typeof allowed[number])) throw new PlatformError(400, 'REPORT_REASON_INVALID', '请选择有效的举报原因。');
    const detail = input.detail?.trim().slice(0, 300) ?? '';
    const result = this.store.createReport({
      reporterId: userId, gameId: input.gameId,
      reason: input.reason as typeof allowed[number], detail,
    });
    await this.store.save();
    return { id: result.report.id, created: result.created, status: result.report.status };
  }
}
