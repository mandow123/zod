import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditToken, sha256, stable } from './lib/canonical.mjs';
import { rejectSensitiveShape, validateMapping } from './lib/validation.mjs';

const here = new URL('.', import.meta.url).pathname;
const fixture = (name) => join(here, 'fixtures', name);
const run = (command, arguments_, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, arguments_, { cwd: options.cwd ?? join(here, '../..'),
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(options.stdin ?? '');
});
const runNode = (script, args, options) => run(process.execPath, [join(here, script), ...args], options);
const write0600 = (path, value) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const resign = (value, field) => {
  const next = structuredClone(value); delete next[field]; next[field] = sha256(stable(next)); return next;
};

async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'unified-commerce-test-'));
  const database = join(directory, 'source.db');
  const created = await run('sqlite3', [database], { stdin: await readFile(fixture('source.sql'), 'utf8') });
  assert.equal(created.code, 0, created.stderr);
  const auditKeyPath = join(directory, 'audit.key'); const auditKey = 'fixture-audit-key-0123456789abcdef0123456789abcdef';
  await write0600(auditKeyPath, auditKey);
  const databaseBytes = await readFile(database); const databaseDigest = sha256(databaseBytes);
  const snapshotEvidence = join(directory, 'snapshot-evidence.json');
  await write0600(snapshotEvidence, { schemaVersion: 1, kind: 'sqlite_backup_api_consistency_evidence',
    capturedAt: '2026-08-21T00:00:00.000Z', backupCopy: { bytes: databaseBytes.length, sha256: databaseDigest,
      quickCheck: [{ quick_check: 'ok' }], foreignKeyViolationCount: 0, pageCount: 1 },
    sourceObservation: { observedAt: '2026-08-21T00:00:01.000Z',
      database: { bytes: databaseBytes.length, sha256: databaseDigest },
      wal: { bytes: 0, sha256: '1'.repeat(64) }, shm: { bytes: 0, sha256: '2'.repeat(64) } },
    claims: { remoteFilesReadOnly: true, sourceObservationMayAdvanceAfterBackup: true,
      walBytesEmbeddedInBackupCopy: false, backupCopyIsConsistentSQLiteImage: true },
    privacy: { sourcePathsIncluded: false, piiValuesIncluded: false, credentialsIncluded: false } });
  const schemaRows = [{ tableName: 'users', columnName: 'id', dataType: 'uuid', isNullable: false,
    primaryKeyOrdinal: 1 }];
  const authInput = join(directory, 'auth-input.json'); const authOutput = join(directory, 'auth.json');
  await write0600(authInput, { schemaVersion: 1, system: '18_node_auth_pg', fingerprintMaterial: 'postgres|auth|5432|authdb',
    schemaRows, tableCounts: { users: 2, external_identities: 2, sessions: 1 }, migrationCount: 1,
    migrationDigest: 'a'.repeat(64),
    verifiedSubjects: ['SUBJECT_SENTINEL_01', 'SUBJECT_SENTINEL_02'],
    candidateSubjects: [1, 2, 3, 4].map((index) => ({ sourceUserToken: auditToken(auditKey, 'users', `u0${index}`),
      subject: `SUBJECT_SENTINEL_0${index}` })) });
  const authRun = await runNode('build-external-inventory.mjs', ['--system', '18_node_auth_pg', '--token-key-file', auditKeyPath,
    '--input', authInput, '--output', authOutput]);
  assert.equal(authRun.code, 0, authRun.stderr);
  const commerceInput = join(directory, 'commerce-input.json'); const commerceOutput = join(directory, 'commerce.json');
  await write0600(commerceInput, { schemaVersion: 1, system: '43_node_commerce_pg',
    fingerprintMaterial: 'postgres|commerce|5432|commercedb', schemaRows, tableCounts: { schema_migrations: 63 },
    migrationCount: 63, migrationDigest: 'b'.repeat(64) });
  const commerceRun = await runNode('build-external-inventory.mjs', ['--system', '43_node_commerce_pg',
    '--token-key-file', auditKeyPath, '--input', commerceInput, '--output', commerceOutput]);
  assert.equal(commerceRun.code, 0, commerceRun.stderr);
  const inventoryPath = join(directory, 'source-inventory.json');
  const inventoryRun = await runNode('inventory-source.mjs', ['--sqlite', database, '--python-server', fixture('server.py'),
    '--python-payment', fixture('qixiangpay.py'), '--audit-key-file', auditKeyPath,
    '--snapshot-evidence', snapshotEvidence, '--auth-pg-inventory', authOutput,
    '--commerce-pg-inventory', commerceOutput, '--output', inventoryPath]);
  assert.equal(inventoryRun.code, 0, inventoryRun.stderr);
  const mappingPath = join(directory, 'domain-mapping.json');
  const mappingRun = await runNode('build-domain-mapping.mjs', ['--sqlite', database, '--audit-key-file', auditKeyPath,
    '--source-inventory', inventoryPath, '--output', mappingPath]);
  assert.equal(mappingRun.code, 0, mappingRun.stderr);
  return { directory, database, auditKeyPath, snapshotEvidence, authOutput, commerceOutput, inventoryPath, mappingPath };
}

test('builds a zero-secret inventory for three distinct data islands', async () => {
  const prepared = await prepare();
  const inventoryText = await readFile(prepared.inventoryPath, 'utf8');
  const inventory = JSON.parse(inventoryText);
  assert.equal(inventory.requiredDomainCounts.users, 15);
  assert.deepEqual(Object.keys(inventory.dataIslands).sort(), ['nodeAuthPg18', 'nodeCommercePg43', 'sqliteCommerce18']);
  assert.equal(inventory.dataIslands.nodeAuthPg18.sourceIdentityMatches.length, 2);
  assert.equal(inventory.dataIslands.nodeAuthPg18.tableCount, 1);
  assert.equal(inventory.dataIslands.nodeAuthPg18.migrationCount, 1);
  assert.equal(inventory.dataIslands.nodeCommercePg43.migrationCount, 63);
  assert.equal(inventory.dataIslands.sqliteCommerce18.tableCount, 7);
  assert.equal(inventory.dataIslands.sqliteCommerce18.primaryKeyColumnCount, 6);
  assert.equal(inventory.dataIslands.sqliteCommerce18.migrationProvenance.status, 'not_applicable');
  assert.equal(inventory.source.consistencyMethod, 'sqlite_backup_api_read_transaction');
  assert.equal(inventory.source.walState.contentRequired, false);
  assert.equal(inventory.pythonFlow.literalExactRoutes.completeness, 'literal_exact_only');
  assert.equal(inventory.pythonFlow.literalExactRoutes.handlerBranchCount, 4);
  assert.equal(inventory.pythonFlow.dynamicOrManualRoutes.staticDispatchBranchCount, 4);
  assert.equal(inventory.pythonFlow.dynamicOrManualRoutes.manualReviewRequired, true);
  for (const sentinel of ['PII_SENTINEL', 'NAME_SENTINEL', 'SUBJECT_SENTINEL', 'TRADE_SENTINEL',
    'OUTTRADE_SENTINEL', 'CHECKOUT_URL_SENTINEL', prepared.database]) assert.equal(inventoryText.includes(sentinel), false);
  assert.equal((await stat(prepared.inventoryPath)).mode & 0o077, 0);
});

test('maps only exact auth-PG subject matches and quarantines every canonical domain', async () => {
  const prepared = await prepare();
  const mappingText = await readFile(prepared.mappingPath, 'utf8'); const mapping = JSON.parse(mappingText);
  assert.equal(mapping.entities.users.filter((row) => row.canonicalEligible).length, 2);
  assert.equal(mapping.entities.users.filter((row) => !row.canonicalEligible).length, 13);
  assert.ok(mapping.entities.listings.every((row) => row.importState === 'legacy_import_staging'
    && row.canonicalEligible === false));
  assert.ok(mapping.entities.orders.every((row) => row.canonicalEligible === false));
  assert.ok(mapping.entities.payments.every((row) => row.confirmationState === 'active_query_unconfirmed'
    && row.grantAllowed === false));
  assert.ok(mapping.entities.allocations.every((row) => row.creditLotCreated === false));
  for (const sentinel of ['SUBJECT_SENTINEL', 'TRADE_SENTINEL', 'OUTTRADE_SENTINEL', 'PII_SENTINEL']) {
    assert.equal(mappingText.includes(sentinel), false);
  }
});

test('permits tokenized payment identifiers but rejects raw identifier fields', () => {
  assert.doesNotThrow(() => rejectSensitiveShape({ outTradeNoToken: 'out_trade_no_abc', tradeNoToken: 'trade_no_abc' }));
  assert.throws(() => rejectSensitiveShape({ outTradeNo: 'raw' }), /UNIFIED_SENSITIVE_FIELD_REJECTED/u);
  assert.throws(() => rejectSensitiveShape({ tradeNo: 'raw' }), /UNIFIED_SENSITIVE_FIELD_REJECTED/u);
});

test('imports exact mapping into an actually isolated PGlite staging schema by default', async () => {
  const prepared = await prepare(); const reportPath = join(prepared.directory, 'dry-run.json');
  const result = await runNode('dry-run-import.mjs', ['--audit-key-file', prepared.auditKeyPath,
    '--source-inventory', prepared.inventoryPath, '--mapping', prepared.mappingPath, '--output', reportPath, '--cleanup']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const mapping = JSON.parse(await readFile(prepared.mappingPath, 'utf8'));
  assert.equal(report.engine, 'pglite'); assert.equal(report.target.isolated, true);
  assert.equal(report.target.isolationMarker, 'PGLITE_IN_PROCESS_EPHEMERAL');
  assert.deepEqual(report.stagedCounts, { users: 15, listings: 25, orders: 2, payments: 2, allocations: 1, settlements: 1 });
  assert.equal(report.canonicalPromotion.enabled, false); assert.equal(report.readyForCanonicalPromotion, false);
  assert.ok(Object.values(report.invariantChecks).every(Boolean));
  assert.equal(report.conflictCount, mapping.conflicts.length);
  assert.ok(['LISTING_EVIDENCE_REQUIRED', 'ORDER_MANUAL_REVIEW_REQUIRED', 'PAYMENT_ACTIVE_QUERY_REQUIRED',
    'LEGACY_ALLOCATION_NO_LOT', 'SETTLEMENT_HOLDING_REVIEW_REQUIRED'].every((blocker) => report.blockers.includes(blocker)));
  assert.equal(report.cleanup.completed, true);
});

test('hard rejects every canonical promotion attempt before target construction', async () => {
  const prepared = await prepare();
  const result = await runNode('dry-run-import.mjs', ['--audit-key-file', prepared.auditKeyPath,
    '--source-inventory', prepared.inventoryPath, '--mapping', prepared.mappingPath,
    '--output', join(prepared.directory, 'forbidden.json'), '--promote', 'yes']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /UNIFIED_CANONICAL_PROMOTION_FORBIDDEN/u);
});

test('rejects missing snapshot evidence and a forged auth identity match', async () => {
  const prepared = await prepare();
  const missing = await runNode('inventory-source.mjs', ['--sqlite', prepared.database,
    '--python-server', fixture('server.py'), '--python-payment', fixture('qixiangpay.py'),
    '--audit-key-file', prepared.auditKeyPath, '--auth-pg-inventory', prepared.authOutput,
    '--commerce-pg-inventory', prepared.commerceOutput, '--output', join(prepared.directory, 'missing.json')]);
  assert.notEqual(missing.code, 0); assert.match(missing.stderr, /UNIFIED_ARGUMENT_REQUIRED:snapshot-evidence/u);

  const forgedAuth = JSON.parse(await readFile(prepared.authOutput, 'utf8'));
  forgedAuth.sourceIdentityMatches.push({ sourceUserToken: auditToken('wrong-key-wrong-key-wrong-key-0001', 'users', 'u15'),
    verifiedSubjectToken: auditToken('wrong-key-wrong-key-wrong-key-0001', 'kai-subject', 'forged') });
  forgedAuth.matchedSubjects += 1;
  const forgedPath = join(prepared.directory, 'forged-auth.json'); await write0600(forgedPath, forgedAuth);
  const forged = await runNode('inventory-source.mjs', ['--sqlite', prepared.database,
    '--python-server', fixture('server.py'), '--python-payment', fixture('qixiangpay.py'),
    '--audit-key-file', prepared.auditKeyPath, '--snapshot-evidence', prepared.snapshotEvidence,
    '--auth-pg-inventory', forgedPath, '--commerce-pg-inventory', prepared.commerceOutput,
    '--output', join(prepared.directory, 'forged.json')]);
  assert.notEqual(forged.code, 0); assert.match(forged.stderr, /UNIFIED_PG_INVENTORY_INVALID/u);

  const differentKey = join(prepared.directory, 'different-audit.key');
  await write0600(differentKey, 'different-audit-key-0123456789abcdef0123456789abcdef');
  const wrongKey = await runNode('inventory-source.mjs', ['--sqlite', prepared.database,
    '--python-server', fixture('server.py'), '--python-payment', fixture('qixiangpay.py'),
    '--audit-key-file', differentKey, '--snapshot-evidence', prepared.snapshotEvidence,
    '--auth-pg-inventory', prepared.authOutput, '--commerce-pg-inventory', prepared.commerceOutput,
    '--output', join(prepared.directory, 'wrong-key.json')]);
  assert.notEqual(wrongKey.code, 0); assert.match(wrongKey.stderr, /UNIFIED_PG_INVENTORY_INVALID/u);
});

test('rejects malformed external primary-key ordinals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unified-pk-test-'));
  const keyPath = join(directory, 'key'); await write0600(keyPath, 'pk-audit-key-0123456789abcdef0123456789abcdef');
  const inputPath = join(directory, 'input.json');
  await write0600(inputPath, { schemaVersion: 1, system: '43_node_commerce_pg',
    fingerprintMaterial: 'postgres|isolated|5432|db', tableCounts: { example: 1 }, migrationCount: 1,
    migrationDigest: 'a'.repeat(64), schemaRows: [
      { tableName: 'example', columnName: 'first', dataType: 'uuid', isNullable: false, primaryKeyOrdinal: 1 },
      { tableName: 'example', columnName: 'second', dataType: 'uuid', isNullable: false, primaryKeyOrdinal: 3 },
    ] });
  const result = await runNode('build-external-inventory.mjs', ['--system', '43_node_commerce_pg',
    '--token-key-file', keyPath, '--input', inputPath, '--output', join(directory, 'output.json')]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /UNIFIED_EXTERNAL_PRIMARY_KEY_ORDINAL_INVALID/u);
});

test('rejects a nonzero token-only identity match before signing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unified-auth-attestation-test-'));
  const keyPath = join(directory, 'key'); await write0600(keyPath, 'auth-audit-key-0123456789abcdef0123456789abcdef');
  const inputPath = join(directory, 'input.json');
  await write0600(inputPath, { schemaVersion: 1, system: '18_node_auth_pg',
    fingerprintMaterial: 'postgres|auth|5432|db', tableCounts: { users: 1, identities: 1 }, migrationCount: 1,
    migrationDigest: 'a'.repeat(64), schemaRows: [
      { tableName: 'users', columnName: 'id', dataType: 'uuid', isNullable: false, primaryKeyOrdinal: 1 },
    ], tokenOnlyAttestation: { verifiedSubjectCount: 1, sourceSubjectCandidates: 1, matchedSubjects: 1,
      sourceIdentityMatches: [{ sourceUserToken: `users_${'a'.repeat(64)}`,
        verifiedSubjectToken: `kai-subject_${'b'.repeat(64)}` }] } });
  const result = await runNode('build-external-inventory.mjs', ['--system', '18_node_auth_pg',
    '--token-key-file', keyPath, '--input', inputPath, '--output', join(directory, 'output.json')]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /UNIFIED_AUTH_TOKEN_ATTESTATION_INVALID/u);
});

test('legacy evidence normalizer requires every privacy attestation explicitly false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unified-privacy-test-'));
  const keyPath = join(directory, 'key'); await write0600(keyPath, 'privacy-audit-key-0123456789abcdef0123456789abcdef');
  const evidencePath = join(directory, 'evidence.json');
  await write0600(evidencePath, { schemaVersion: 1, kind: 'commerce43_postgres_readonly',
    canonicalIdentity: 'postgres|isolated|5432|db', schemaDigest: 'a'.repeat(64), tableCount: 1,
    migrationCount: 1, migrationDigest: 'b'.repeat(64), counts: { users: 0 },
    privacy: { credentialsIncluded: false } });
  const result = await runNode('normalize-readonly-evidence.mjs', ['--system', '43_node_commerce_pg',
    '--audit-key-file', keyPath, '--input', evidencePath, '--output', join(directory, 'output.json')]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /UNIFIED_READONLY_EVIDENCE_INVALID/u);
});

test('rejects production fingerprints before any pg target connection', async () => {
  const prepared = await prepare(); const inventory = JSON.parse(await readFile(prepared.inventoryPath, 'utf8'));
  const databaseUrlPath = join(prepared.directory, 'database-url');
  await write0600(databaseUrlPath, 'postgresql://nobody:never@127.0.0.1:1/isolated_dry_run');
  const proofPath = join(prepared.directory, 'isolation-proof.json');
  await write0600(proofPath, { schemaVersion: 1, purpose: 'unified_commerce_dry_run', isolated: true, allowed: true,
    targetFingerprintDigest: inventory.dataIslands.nodeCommercePg43.fingerprintDigest,
    productionFingerprintDigests: [inventory.dataIslands.nodeAuthPg18.fingerprintDigest,
      inventory.dataIslands.nodeCommercePg43.fingerprintDigest], expiresAt: '2099-01-01T00:00:00.000Z' });
  const result = await runNode('dry-run-import.mjs', ['--engine', 'pg', '--database-url-file', databaseUrlPath,
    '--isolation-proof-file', proofPath, '--audit-key-file', prepared.auditKeyPath,
    '--source-inventory', prepared.inventoryPath, '--mapping', prepared.mappingPath,
    '--output', join(prepared.directory, 'production-target.json')]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /UNIFIED_TARGET_NOT_ISOLATED/u);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/u);
});

test('rejects mapping count, reference, and token tampering', async () => {
  const prepared = await prepare(); const original = JSON.parse(await readFile(prepared.mappingPath, 'utf8'));
  const roleTamper = structuredClone(original); roleTamper.entities.users[0].role = 'forged-admin';
  assert.throws(() => validateMapping(roleTamper), /UNIFIED_MAPPING_DIGEST_INVALID/u);
  const countDraft = structuredClone(original); countDraft.entities.listings.pop();
  const countTamper = resign(countDraft, 'mappingDigest');
  assert.throws(() => validateMapping(countTamper), /UNIFIED_MAPPING_COUNTS_INVALID/u);
  const referenceDraft = structuredClone(original);
  referenceDraft.entities.orders[0].listingToken = `listings_${'f'.repeat(64)}`;
  const referenceTamper = resign(referenceDraft, 'mappingDigest');
  assert.throws(() => validateMapping(referenceTamper), /UNIFIED_MAPPING_INVARIANT_FAILED/u);
  const tokenDraft = structuredClone(original); tokenDraft.entities.users[0].sourceToken = 'raw-user-id';
  const tokenTamper = resign(tokenDraft, 'mappingDigest');
  assert.throws(() => validateMapping(tokenTamper), /UNIFIED_MAPPING_TOKEN_INVALID/u);
});

test('binds sqlite bytes, inventory digest, and mapping digest across every stage', async () => {
  const prepared = await prepare();
  const inventory = JSON.parse(await readFile(prepared.inventoryPath, 'utf8'));
  const mapping = JSON.parse(await readFile(prepared.mappingPath, 'utf8'));

  const staleInventory = structuredClone(inventory); staleInventory.requiredDomainCounts.users = 99;
  const staleInventoryPath = join(prepared.directory, 'stale-inventory.json'); await write0600(staleInventoryPath, staleInventory);
  const staleDry = await runNode('dry-run-import.mjs', ['--audit-key-file', prepared.auditKeyPath,
    '--source-inventory', staleInventoryPath, '--mapping', prepared.mappingPath,
    '--output', join(prepared.directory, 'stale-dry.json')]);
  assert.notEqual(staleDry.code, 0); assert.match(staleDry.stderr, /UNIFIED_SOURCE_INVENTORY_DIGEST_INVALID/u);

  const otherDatabaseInventory = structuredClone(inventory); otherDatabaseInventory.source.sha256 = 'f'.repeat(64);
  const resignedInventory = resign(otherDatabaseInventory, 'reportDigest');
  const otherDatabasePath = join(prepared.directory, 'other-database-inventory.json');
  await write0600(otherDatabasePath, resignedInventory);
  const mappingAttempt = await runNode('build-domain-mapping.mjs', ['--sqlite', prepared.database,
    '--audit-key-file', prepared.auditKeyPath, '--source-inventory', otherDatabasePath,
    '--output', join(prepared.directory, 'other-database-mapping.json')]);
  assert.notEqual(mappingAttempt.code, 0); assert.match(mappingAttempt.stderr, /UNIFIED_SOURCE_DATABASE_MISMATCH/u);

  const rebound = structuredClone(mapping); rebound.sourceInventoryDigest = 'e'.repeat(64);
  const reboundMapping = resign(rebound, 'mappingDigest'); const reboundPath = join(prepared.directory, 'rebound.json');
  await write0600(reboundPath, reboundMapping);
  const reboundDry = await runNode('dry-run-import.mjs', ['--audit-key-file', prepared.auditKeyPath,
    '--source-inventory', prepared.inventoryPath, '--mapping', reboundPath,
    '--output', join(prepared.directory, 'rebound-dry.json')]);
  assert.notEqual(reboundDry.code, 0); assert.match(reboundDry.stderr, /UNIFIED_INVENTORY_MAPPING_MISMATCH/u);
});
