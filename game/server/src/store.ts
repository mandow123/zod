import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { GameState } from '../../core/types.ts';

export type UserRecord = {
  id: string;
  name: string;
  createdAt: string;
  lastReliefDate: string | null;
};

export type LedgerEntry = {
  id: string;
  transactionId: string;
  accountId: string;
  amount: number;
  memo: string;
  createdAt: string;
};

export type RoomRecord = {
  id: string;
  code: string;
  version: number;
  hostId: string;
  memberIds: string[];
  status: 'waiting' | 'playing' | 'finished';
  gameId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportRecord = {
  id: string;
  reporterId: string;
  gameId: string;
  reason: 'collusion' | 'cheating' | 'harassment' | 'other';
  detail: string;
  status: 'open';
  createdAt: string;
};

type LedgerTransaction = {
  id: string;
  key: string;
  referenceType: 'welcome' | 'relief' | 'game';
  referenceId: string;
  createdAt: string;
};

type PersistedState = {
  users: Record<string, UserRecord>;
  sessions: Record<string, string>;
  balances: Record<string, number>;
  games: Record<string, GameState>;
  rooms: Record<string, RoomRecord>;
  reports: ReportRecord[];
  ledgerTransactions: LedgerTransaction[];
  ledgerEntries: LedgerEntry[];
  actionResults: Record<string, unknown>;
};

type PersistedEnvelope = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  savedAt: string;
  checksum: { algorithm: 'sha256'; value: string };
  state: PersistedState;
};

export type JsonGameStoreOptions = Readonly<{ backupCount?: number }>;

const CURRENT_SCHEMA_VERSION = 1 as const;
const DEFAULT_BACKUP_COUNT = 3;
const MAX_BACKUP_COUNT = 10;

const initialState = (): PersistedState => ({
  users: {}, sessions: {}, balances: { treasury: 0 }, games: {}, rooms: {}, reports: [],
  ledgerTransactions: [], ledgerEntries: [], actionResults: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const requireRecord = (value: unknown, field: string) => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
};

const requireString = (value: unknown, field: string) => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

const requireStringArray = (value: unknown, field: string) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be a string array`);
  }
};

const validateRecordValues = (
  value: unknown,
  field: string,
  validate: (entry: unknown, entryField: string, key: string) => void,
) => {
  const record = requireRecord(value, field);
  for (const [key, entry] of Object.entries(record)) validate(entry, `${field}.${key}`, key);
};

const validateState = (value: unknown): asserts value is PersistedState => {
  const state = requireRecord(value, 'state');

  validateRecordValues(state.users, 'state.users', (entry, field, id) => {
    const user = requireRecord(entry, field);
    if (requireString(user.id, `${field}.id`) !== id) throw new Error(`${field}.id must match its key`);
    requireString(user.name, `${field}.name`);
    requireString(user.createdAt, `${field}.createdAt`);
    if (user.lastReliefDate !== null && typeof user.lastReliefDate !== 'string') {
      throw new Error(`${field}.lastReliefDate must be a string or null`);
    }
  });

  validateRecordValues(state.sessions, 'state.sessions', (entry, field) => {
    const userId = requireString(entry, field);
    if (!isRecord(state.users) || !(userId in state.users)) throw new Error(`${field} references an unknown user`);
  });

  validateRecordValues(state.balances, 'state.balances', (entry, field) => {
    if (!Number.isSafeInteger(entry)) throw new Error(`${field} must be a safe integer`);
  });
  if (!isRecord(state.balances) || !Number.isSafeInteger(state.balances.treasury)) {
    throw new Error('state.balances.treasury must be a safe integer');
  }

  validateRecordValues(state.games, 'state.games', (entry, field, id) => {
    const game = requireRecord(entry, field);
    if (requireString(game.id, `${field}.id`) !== id) throw new Error(`${field}.id must match its key`);
    if (!['bidding', 'playing', 'finished'].includes(String(game.phase))) throw new Error(`${field}.phase is invalid`);
    if (!Array.isArray(game.players) || !isRecord(game.hands) || !Array.isArray(game.bottomCards)) {
      throw new Error(`${field} has an invalid game shape`);
    }
    if (!Number.isSafeInteger(game.sequence) || !Array.isArray(game.events)) {
      throw new Error(`${field} has invalid event data`);
    }
    const fairness = requireRecord(game.fairness, `${field}.fairness`);
    if (fairness.algorithm !== 'sha256') throw new Error(`${field}.fairness.algorithm is invalid`);
    requireString(fairness.commitment, `${field}.fairness.commitment`);
    requireString(fairness.nonce, `${field}.fairness.nonce`);
    requireStringArray(fairness.deckOrder, `${field}.fairness.deckOrder`);
    requireString(game.createdAt, `${field}.createdAt`);
    requireString(game.updatedAt, `${field}.updatedAt`);
  });

  validateRecordValues(state.rooms, 'state.rooms', (entry, field, id) => {
    const room = requireRecord(entry, field);
    if (requireString(room.id, `${field}.id`) !== id) throw new Error(`${field}.id must match its key`);
    requireString(room.code, `${field}.code`);
    if (!Number.isSafeInteger(room.version) || Number(room.version) < 1) throw new Error(`${field}.version is invalid`);
    requireString(room.hostId, `${field}.hostId`);
    requireStringArray(room.memberIds, `${field}.memberIds`);
    if (!['waiting', 'playing', 'finished'].includes(String(room.status))) throw new Error(`${field}.status is invalid`);
    if (room.gameId !== null && typeof room.gameId !== 'string') throw new Error(`${field}.gameId is invalid`);
    requireString(room.createdAt, `${field}.createdAt`);
    requireString(room.updatedAt, `${field}.updatedAt`);
  });

  if (!Array.isArray(state.reports)) throw new Error('state.reports must be an array');
  for (const [index, entry] of state.reports.entries()) {
    const field = `state.reports.${index}`;
    const report = requireRecord(entry, field);
    for (const key of ['id', 'reporterId', 'gameId', 'detail', 'createdAt']) requireString(report[key], `${field}.${key}`);
    if (!['collusion', 'cheating', 'harassment', 'other'].includes(String(report.reason))) throw new Error(`${field}.reason is invalid`);
    if (report.status !== 'open') throw new Error(`${field}.status is invalid`);
  }

  if (!Array.isArray(state.ledgerTransactions)) throw new Error('state.ledgerTransactions must be an array');
  for (const [index, entry] of state.ledgerTransactions.entries()) {
    const field = `state.ledgerTransactions.${index}`;
    const transaction = requireRecord(entry, field);
    for (const key of ['id', 'key', 'referenceId', 'createdAt']) requireString(transaction[key], `${field}.${key}`);
    if (!['welcome', 'relief', 'game'].includes(String(transaction.referenceType))) {
      throw new Error(`${field}.referenceType is invalid`);
    }
  }

  if (!Array.isArray(state.ledgerEntries)) throw new Error('state.ledgerEntries must be an array');
  for (const [index, entry] of state.ledgerEntries.entries()) {
    const field = `state.ledgerEntries.${index}`;
    const ledgerEntry = requireRecord(entry, field);
    for (const key of ['id', 'transactionId', 'accountId', 'memo', 'createdAt']) requireString(ledgerEntry[key], `${field}.${key}`);
    if (!Number.isSafeInteger(ledgerEntry.amount)) throw new Error(`${field}.amount must be a safe integer`);
  }

  requireRecord(state.actionResults, 'state.actionResults');
};

const checksumFor = (stateJson: string) => createHash('sha256').update(stateJson).digest('hex');

const encodeSnapshot = (state: PersistedState) => {
  const stateJson = JSON.stringify(state);
  if (stateJson === undefined) throw new Error('STORE_STATE_NOT_SERIALIZABLE');
  const normalizedState = JSON.parse(stateJson) as unknown;
  validateState(normalizedState);
  const envelope: PersistedEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    checksum: { algorithm: 'sha256', value: checksumFor(stateJson) },
    state: normalizedState,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
};

export class StoreSnapshotError extends Error {
  readonly code = 'STORE_SNAPSHOT_INVALID';
  readonly snapshotPath: string;

  constructor(snapshotPath: string, reason: string, options?: ErrorOptions) {
    super(`Invalid KAI Play store snapshot at ${snapshotPath}: ${reason}`, options);
    this.name = 'StoreSnapshotError';
    this.snapshotPath = snapshotPath;
  }
}

export class StoreRecoveryError extends AggregateError {
  readonly code = 'STORE_NO_VALID_SNAPSHOT';
  readonly primaryPath: string;

  constructor(primaryPath: string, errors: readonly StoreSnapshotError[]) {
    super(errors, `STORE_NO_VALID_SNAPSHOT: no valid primary or backup snapshot exists for ${primaryPath}`);
    this.name = 'StoreRecoveryError';
    this.primaryPath = primaryPath;
  }
}

const decodeSnapshot = (contents: string, snapshotPath: string): PersistedState => {
  try {
    const parsed = JSON.parse(contents) as unknown;
    const envelope = requireRecord(parsed, 'snapshot');
    if (envelope.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported schemaVersion ${String(envelope.schemaVersion)}`);
    }
    requireString(envelope.savedAt, 'snapshot.savedAt');
    const checksum = requireRecord(envelope.checksum, 'snapshot.checksum');
    if (checksum.algorithm !== 'sha256') throw new Error('snapshot.checksum.algorithm must be sha256');
    const expectedChecksum = requireString(checksum.value, 'snapshot.checksum.value');
    validateState(envelope.state);
    const actualChecksum = checksumFor(JSON.stringify(envelope.state));
    if (actualChecksum !== expectedChecksum) throw new Error('snapshot checksum mismatch');
    return envelope.state;
  } catch (error) {
    if (error instanceof StoreSnapshotError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new StoreSnapshotError(snapshotPath, reason, { cause: error });
  }
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

const syncDirectory = async (directory: string) => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
};

const atomicWrite = async (path: string, contents: string) => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export class JsonGameStore {
  private state: PersistedState = initialState();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly backupCount: number;
  private recoveredFrom: string | null = null;

  constructor(path: string, options: JsonGameStoreOptions = {}) {
    const backupCount = options.backupCount ?? DEFAULT_BACKUP_COUNT;
    if (!Number.isSafeInteger(backupCount) || backupCount < 1 || backupCount > MAX_BACKUP_COUNT) {
      throw new Error(`STORE_BACKUP_COUNT_INVALID: expected an integer from 1 to ${MAX_BACKUP_COUNT}`);
    }
    this.path = path;
    this.backupCount = backupCount;
  }

  private backupPath(generation: number) { return `${this.path}.bak.${generation}`; }

  recoverySource() { return this.recoveredFrom; }

  async load() {
    const candidates = [this.path, ...Array.from({ length: this.backupCount }, (_, index) => this.backupPath(index + 1))];
    const invalidSnapshots: StoreSnapshotError[] = [];
    let foundSnapshot = false;

    for (const [index, candidate] of candidates.entries()) {
      let contents: string;
      try {
        contents = await readFile(candidate, 'utf8');
        foundSnapshot = true;
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      try {
        this.state = decodeSnapshot(contents, candidate);
        this.recoveredFrom = index === 0 ? null : candidate;
        if (index > 0) await atomicWrite(this.path, contents);
        return;
      } catch (error) {
        if (!(error instanceof StoreSnapshotError)) throw error;
        invalidSnapshots.push(error);
      }
    }

    if (!foundSnapshot) {
      this.state = initialState();
      this.recoveredFrom = null;
      return;
    }

    throw new StoreRecoveryError(this.path, invalidSnapshots);
  }

  private async rotateBackups(currentPrimary: string) {
    try {
      decodeSnapshot(currentPrimary, this.path);
    } catch (error) {
      if (error instanceof StoreSnapshotError) return;
      throw error;
    }

    for (let generation = this.backupCount; generation >= 2; generation -= 1) {
      const source = this.backupPath(generation - 1);
      try {
        const contents = await readFile(source, 'utf8');
        decodeSnapshot(contents, source);
        await atomicWrite(this.backupPath(generation), contents);
      } catch (error) {
        if (isMissing(error) || error instanceof StoreSnapshotError) continue;
        throw error;
      }
    }
    await atomicWrite(this.backupPath(1), currentPrimary);
  }

  private async persist(snapshot: string) {
    let currentPrimary: string | null = null;
    try {
      currentPrimary = await readFile(this.path, 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (currentPrimary !== null) await this.rotateBackups(currentPrimary);
    await atomicWrite(this.path, snapshot);
  }

  save() {
    // Capture at invocation time: later mutations belong to a later queued save.
    const snapshot = encodeSnapshot(this.state);
    const operation = this.writeQueue.catch(() => undefined).then(() => this.persist(snapshot));
    this.writeQueue = operation;
    return operation;
  }

  createUser(name: string) {
    const id = randomUUID();
    const token = randomUUID() + randomUUID();
    const user: UserRecord = { id, name, createdAt: new Date().toISOString(), lastReliefDate: null };
    this.state.users[id] = user;
    this.state.sessions[token] = id;
    this.state.balances[id] = 0;
    this.post({
      key: `welcome:${id}`, referenceType: 'welcome', referenceId: id,
      entries: [
        { accountId: 'treasury', amount: -10_000, memo: '新玩家欢迎赠豆' },
        { accountId: id, amount: 10_000, memo: '新玩家欢迎赠豆' },
      ],
    });
    return { user, token };
  }

  userForToken(token: string) {
    const id = this.state.sessions[token];
    return id ? this.state.users[id] ?? null : null;
  }

  user(id: string) { return this.state.users[id] ?? null; }
  balance(id: string) { return this.state.balances[id] ?? 0; }
  game(id: string) { return this.state.games[id] ?? null; }
  putGame(game: GameState) { this.state.games[game.id] = game; }
  gamesForUser(userId: string) {
    return Object.values(this.state.games)
      .filter((game) => game.players.some((player) => player.id === userId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  room(id: string) { return this.state.rooms[id] ?? null; }
  roomForGame(gameId: string) { return Object.values(this.state.rooms).find((room) => room.gameId === gameId) ?? null; }
  roomByCode(code: string) { return Object.values(this.state.rooms).find((room) => room.code === code && room.status === 'waiting') ?? null; }
  putRoom(room: RoomRecord) { this.state.rooms[room.id] = room; }
  roomsForUser(userId: string) { return Object.values(this.state.rooms).filter((room) => room.memberIds.includes(userId)); }

  createReport(input: Omit<ReportRecord, 'id' | 'status' | 'createdAt'>) {
    const existing = this.state.reports.find((report) => report.reporterId === input.reporterId && report.gameId === input.gameId && report.reason === input.reason);
    if (existing) return { report: existing, created: false };
    const report: ReportRecord = { ...input, id: randomUUID(), status: 'open', createdAt: new Date().toISOString() };
    this.state.reports.push(report);
    return { report, created: true };
  }

  actionResult(key: string) { return this.state.actionResults[key]; }
  setActionResult(key: string, result: unknown) { this.state.actionResults[key] = result; }

  post(input: Readonly<{
    key: string;
    referenceType: LedgerTransaction['referenceType'];
    referenceId: string;
    entries: readonly Readonly<{ accountId: string; amount: number; memo: string }>[];
  }>) {
    if (this.state.ledgerTransactions.some((transaction) => transaction.key === input.key)) return false;
    if (input.entries.reduce((sum, entry) => sum + entry.amount, 0) !== 0) throw new Error('LEDGER_NOT_BALANCED');
    if (input.entries.some((entry) => !Number.isSafeInteger(entry.amount))) throw new Error('LEDGER_AMOUNT_INVALID');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.state.ledgerTransactions.push({ id, key: input.key, referenceType: input.referenceType, referenceId: input.referenceId, createdAt });
    for (const inputEntry of input.entries) {
      this.state.balances[inputEntry.accountId] = (this.state.balances[inputEntry.accountId] ?? 0) + inputEntry.amount;
      this.state.ledgerEntries.push({ id: randomUUID(), transactionId: id, createdAt, ...inputEntry });
    }
    return true;
  }

  entries(accountId: string, limit = 30) {
    return this.state.ledgerEntries.filter((entry) => entry.accountId === accountId).slice(-limit).reverse();
  }

  claimRelief(userId: string) {
    const user = this.state.users[userId];
    if (!user) throw new Error('USER_NOT_FOUND');
    const date = new Date().toISOString().slice(0, 10);
    if (user.lastReliefDate === date) return false;
    if (this.balance(userId) >= 2_000) return false;
    const amount = 2_000 - this.balance(userId);
    this.post({
      key: `relief:${userId}:${date}`, referenceType: 'relief', referenceId: userId,
      entries: [
        { accountId: 'treasury', amount: -amount, memo: '每日补助' },
        { accountId: userId, amount, memo: '每日补助' },
      ],
    });
    user.lastReliefDate = date;
    return true;
  }
}
