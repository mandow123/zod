import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonGameStore, StoreRecoveryError } from '../server/src/store.ts';

const withTemporaryDirectory = async (prefix: string, run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('snapshots carry a validated schema version and checksum', async () => {
  await withTemporaryDirectory('doujoy-store-schema-', async (directory) => {
    const path = join(directory, 'state.json');
    const store = new JsonGameStore(path);
    await store.load();
    const { user, token } = store.createUser('持久化玩家');
    await store.save();

    const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
      schemaVersion: number;
      checksum: { algorithm: string; value: string };
    };
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.checksum.algorithm, 'sha256');
    assert.match(snapshot.checksum.value, /^[a-f0-9]{64}$/);

    const reloaded = new JsonGameStore(path);
    await reloaded.load();
    assert.equal(reloaded.user(user.id)?.name, '持久化玩家');
    assert.equal(reloaded.userForToken(token)?.id, user.id);
    assert.equal(reloaded.balance(user.id), 10_000);
  });
});

test('malformed, unversioned, and checksum-damaged snapshots are rejected', async (context) => {
  await withTemporaryDirectory('doujoy-store-reject-', async (directory) => {
    const path = join(directory, 'state.json');
    const cases: ReadonlyArray<Readonly<{ name: string; contents: string }>> = [
      { name: 'malformed JSON', contents: '{"schemaVersion":1' },
      { name: 'missing schema version', contents: JSON.stringify({ state: {} }) },
    ];

    for (const fixture of cases) {
      await context.test(fixture.name, async () => {
        await writeFile(path, fixture.contents, 'utf8');
        const store = new JsonGameStore(path);
        await assert.rejects(
          () => store.load(),
          (error) => error instanceof StoreRecoveryError && error.code === 'STORE_NO_VALID_SNAPSHOT',
        );
      });
    }

    const validStore = new JsonGameStore(path);
    await rm(path, { force: true });
    validStore.createUser('校验和玩家');
    await validStore.save();
    const damaged = JSON.parse(await readFile(path, 'utf8')) as {
      state: { balances: Record<string, number> };
    };
    damaged.state.balances.treasury += 1;
    await writeFile(path, JSON.stringify(damaged), 'utf8');

    await context.test('checksum mismatch', async () => {
      await assert.rejects(
        () => new JsonGameStore(path).load(),
        (error) => error instanceof StoreRecoveryError
          && [...error.errors].some((cause) => String(cause).includes('checksum mismatch')),
      );
    });
  });
});

test('load rolls back through valid generations and repairs the primary snapshot', async () => {
  await withTemporaryDirectory('doujoy-store-recovery-', async (directory) => {
    const path = join(directory, 'state.json');
    const store = new JsonGameStore(path, { backupCount: 3 });
    await store.load();
    const first = store.createUser('第一代').user;
    await store.save();
    const second = store.createUser('第二代').user;
    await store.save();
    store.createUser('第三代');
    await store.save();

    await writeFile(path, '{bad primary', 'utf8');
    await writeFile(`${path}.bak.1`, '{bad newest backup', 'utf8');

    const recovered = new JsonGameStore(path, { backupCount: 3 });
    await recovered.load();
    assert.equal(recovered.recoverySource(), `${path}.bak.2`);
    assert.equal(recovered.user(first.id)?.name, '第一代');
    assert.equal(recovered.user(second.id), null);

    const repaired = new JsonGameStore(path, { backupCount: 3 });
    await repaired.load();
    assert.equal(repaired.recoverySource(), null);
    assert.equal(repaired.user(first.id)?.name, '第一代');
  });
});

test('a failed queued write does not poison later saves', async () => {
  await withTemporaryDirectory('doujoy-store-queue-', async (directory) => {
    const blockedDirectory = join(directory, 'data');
    const path = join(blockedDirectory, 'state.json');
    await writeFile(blockedDirectory, 'temporarily not a directory', 'utf8');

    const store = new JsonGameStore(path);
    const user = store.createUser('队列恢复').user;
    await assert.rejects(() => store.save());

    await rm(blockedDirectory, { force: true });
    await mkdir(blockedDirectory);
    await store.save();

    const reloaded = new JsonGameStore(path);
    await reloaded.load();
    assert.equal(reloaded.user(user.id)?.name, '队列恢复');
    assert.equal((await readdir(blockedDirectory)).some((file) => file.endsWith('.tmp')), false);
  });
});

test('backup count is bounded to prevent unbounded snapshot fan-out', () => {
  assert.throws(() => new JsonGameStore('state.json', { backupCount: 0 }), /STORE_BACKUP_COUNT_INVALID/);
  assert.throws(() => new JsonGameStore('state.json', { backupCount: 11 }), /STORE_BACKUP_COUNT_INVALID/);
});
