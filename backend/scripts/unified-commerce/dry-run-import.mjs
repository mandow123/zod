#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { auditToken, parseArgs, randomSchema, readCredential, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';
import { rejectSensitiveShape, validateEmbeddedDigest, validateMapping } from './lib/validation.mjs';

const args = parseArgs(process.argv.slice(2));
const allowed = new Set(['engine', 'database-url-file', 'isolation-proof-file', 'audit-key-file',
  'source-inventory', 'mapping', 'output', 'schema', 'cleanup', 'plan-only']);
if ([...args.keys()].some((key) => !allowed.has(key)) || process.env.UNIFIED_COMMERCE_PROMOTE
  || process.env.CANONICAL_PROMOTION || args.has('promote') || args.has('promotion')) {
  throw new Error('UNIFIED_CANONICAL_PROMOTION_FORBIDDEN');
}
const engine = args.get('engine') ?? 'pglite';
if (!['pglite', 'pg'].includes(engine)) throw new Error('UNIFIED_DRY_RUN_ENGINE_INVALID');
const auditKey = await readCredential(required(args, 'audit-key-file'));
const inventory = JSON.parse(await readFile(required(args, 'source-inventory'), 'utf8'));
const mapping = JSON.parse(await readFile(required(args, 'mapping'), 'utf8'));
const inventoryDigest = validateEmbeddedDigest(inventory, 'reportDigest', 'UNIFIED_SOURCE_INVENTORY_DIGEST_INVALID');
rejectSensitiveShape(mapping);
const validated = validateMapping(mapping);
if (mapping.sourceInventoryDigest !== inventoryDigest) throw new Error('UNIFIED_INVENTORY_MAPPING_MISMATCH');
const schema = args.get('schema') ?? randomSchema();
if (!/^ucommerce_stage_[0-9a-f]{12}$/u.test(schema)) throw new Error('UNIFIED_STAGING_SCHEMA_INVALID');
const baseReport = { schemaVersion: 1, mode: 'dry_run', engine,
  canonicalPromotion: { enabled: false, attempted: false }, sourceInventoryDigest: inventoryDigest,
  mappingDigest: validated.mappingDigest, expectedCounts: validated.counts,
  invariantChecks: validated.checks, schemaToken: auditToken(auditKey, 'schema', schema) };

if (args.get('plan-only') === true) {
  const report = { ...baseReport, target: { connected: false, isolated: null }, stagedCounts: null,
    cleanup: { requested: false, completed: false }, readyForCanonicalPromotion: false,
    blockers: ['PLAN_ONLY', 'CANONICAL_PROMOTION_DISABLED'] };
  report.reportDigest = sha256(stable(report));
  const written = await writeJson0600(required(args, 'output'), report);
  process.stdout.write(`${JSON.stringify({ ok: true, planOnly: true, output: written, reportDigest: report.reportDigest })}\n`);
  process.exit(0);
}

const productionDigests = [inventory.dataIslands?.nodeAuthPg18?.fingerprintDigest,
  inventory.dataIslands?.nodeCommercePg43?.fingerprintDigest].filter(Boolean);
let database; let target;
if (engine === 'pglite') {
  if (args.has('database-url-file') || args.has('isolation-proof-file')) throw new Error('UNIFIED_PGLITE_EXTERNAL_TARGET_FORBIDDEN');
  const client = new PGlite();
  database = { query: (sql, parameters = []) => client.query(sql, parameters), close: () => client.close() };
  const fingerprintDigest = sha256(`pglite|ephemeral|${schema}`);
  if (productionDigests.includes(fingerprintDigest)) throw new Error('UNIFIED_TARGET_NOT_ISOLATED');
  target = { connected: true, isolated: true, engine: 'pglite',
    isolationMarker: 'PGLITE_IN_PROCESS_EPHEMERAL', fingerprintDigest };
} else {
  const databaseUrl = await readCredential(required(args, 'database-url-file'));
  const proof = JSON.parse(await readCredential(required(args, 'isolation-proof-file')));
  if (proof?.schemaVersion !== 1 || proof.purpose !== 'unified_commerce_dry_run' || proof.isolated !== true
    || proof.allowed !== true || !/^[0-9a-f]{64}$/u.test(proof.targetFingerprintDigest)
    || !Array.isArray(proof.productionFingerprintDigests)
    || stable([...proof.productionFingerprintDigests].sort()) !== stable([...productionDigests].sort())
    || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= Date.now()) {
    throw new Error('UNIFIED_ISOLATION_PROOF_INVALID');
  }
  if (productionDigests.includes(proof.targetFingerprintDigest)) throw new Error('UNIFIED_TARGET_NOT_ISOLATED');
  const databaseUrlValue = databaseUrl.trim();
  const parsed = new URL(databaseUrlValue);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('UNIFIED_POSTGRES_URL_INVALID');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrlValue, application_name: 'unified-commerce-dry-run',
    statement_timeout: 30_000, query_timeout: 30_000 });
  await client.connect();
  const row = (await client.query(`SELECT current_database() database,
    COALESCE(inet_server_addr()::text,'local') host,current_setting('port') port`)).rows[0];
  const fingerprintDigest = sha256(`43_node_commerce_pg|postgres|${row.host}|${row.port}|${row.database}`);
  if (fingerprintDigest !== proof.targetFingerprintDigest || productionDigests.includes(fingerprintDigest)) {
    await client.end(); throw new Error('UNIFIED_TARGET_NOT_ISOLATED');
  }
  database = { query: (sql, parameters = []) => client.query(sql, parameters), close: () => client.end() };
  target = { connected: true, isolated: true, engine: 'pg',
    isolationMarker: 'SIGNED_ISOLATION_PROOF', fingerprintDigest };
}

let committed = false; let cleaned = false;
try {
  await database.query('BEGIN');
  await database.query(`CREATE SCHEMA ${schema}`);
  for (const ddl of [
    `CREATE TABLE ${schema}.users(source_token text PRIMARY KEY,verified_subject_token text,
      canonical_eligible boolean NOT NULL,payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.listings(source_token text PRIMARY KEY,supplier_token text NOT NULL REFERENCES ${schema}.users,
      payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.orders(source_token text PRIMARY KEY,buyer_token text NOT NULL REFERENCES ${schema}.users,
      listing_token text NOT NULL REFERENCES ${schema}.listings,payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.payments(source_token text PRIMARY KEY,order_token text NOT NULL REFERENCES ${schema}.orders,
      trade_no_token text UNIQUE,payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.allocations(source_token text PRIMARY KEY,owner_token text NOT NULL REFERENCES ${schema}.users,
      order_token text NOT NULL REFERENCES ${schema}.orders,listing_token text NOT NULL REFERENCES ${schema}.listings,payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.settlements(source_token text PRIMARY KEY,order_token text NOT NULL REFERENCES ${schema}.orders,
      supplier_token text NOT NULL REFERENCES ${schema}.users,payload jsonb NOT NULL)`,
    `CREATE TABLE ${schema}.conflicts(ordinal bigint PRIMARY KEY,payload jsonb NOT NULL)`,
  ]) await database.query(ddl);
  for (const row of mapping.entities.users) await database.query(
    `INSERT INTO ${schema}.users VALUES($1,$2,$3,$4::jsonb)`,
    [row.sourceToken, row.verifiedKaiSubjectToken, row.canonicalEligible, JSON.stringify(row)]);
  for (const row of mapping.entities.listings) await database.query(
    `INSERT INTO ${schema}.listings VALUES($1,$2,$3::jsonb)`, [row.sourceToken, row.supplierToken, JSON.stringify(row)]);
  for (const row of mapping.entities.orders) await database.query(
    `INSERT INTO ${schema}.orders VALUES($1,$2,$3,$4::jsonb)`,
    [row.sourceToken, row.buyerToken, row.listingToken, JSON.stringify(row)]);
  for (const row of mapping.entities.payments) await database.query(
    `INSERT INTO ${schema}.payments VALUES($1,$2,$3,$4::jsonb)`,
    [row.sourceToken, row.orderToken, row.tradeNoToken, JSON.stringify(row)]);
  for (const row of mapping.entities.allocations) await database.query(
    `INSERT INTO ${schema}.allocations VALUES($1,$2,$3,$4,$5::jsonb)`,
    [row.sourceToken, row.ownerToken, row.orderToken, row.listingToken, JSON.stringify(row)]);
  for (const row of mapping.entities.settlements) await database.query(
    `INSERT INTO ${schema}.settlements VALUES($1,$2,$3,$4::jsonb)`,
    [row.sourceToken, row.orderToken, row.supplierToken, JSON.stringify(row)]);
  for (let index = 0; index < mapping.conflicts.length; index += 1) await database.query(
    `INSERT INTO ${schema}.conflicts VALUES($1,$2::jsonb)`, [index + 1, JSON.stringify(mapping.conflicts[index])]);
  const stagedCounts = {};
  for (const table of Object.keys(validated.counts)) stagedCounts[table] = Number((await database.query(
    `SELECT count(*)::text count FROM ${schema}.${table}`)).rows[0].count);
  if (stable(stagedCounts) !== stable(validated.counts)) throw new Error('UNIFIED_STAGING_COUNTS_INVALID');
  await database.query('COMMIT'); committed = true;
  if (args.get('cleanup') === true) {
    await database.query('BEGIN'); await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.query('COMMIT'); cleaned = true;
  }
  const conflictSummary = Object.fromEntries(Object.entries(mapping.conflicts.reduce((summary, conflict) => {
    summary[conflict.code] = (summary[conflict.code] ?? 0) + 1; return summary;
  }, {})).sort(([left], [right]) => left.localeCompare(right)));
  const conflictBlockers = [
    ['LISTING_STAGING_EVIDENCE_REQUIRED', 'LISTING_EVIDENCE_REQUIRED'],
    ['ORDER_MANUAL_REVIEW_REQUIRED', 'ORDER_MANUAL_REVIEW_REQUIRED'],
    ['PAYMENT_ACTIVE_QUERY_CONFIRMATION_REQUIRED', 'PAYMENT_ACTIVE_QUERY_REQUIRED'],
    ['LEGACY_ALLOCATION_NO_CREDIT_LOT', 'LEGACY_ALLOCATION_NO_LOT'],
    ['SETTLEMENT_HOLDING_REVIEW_REQUIRED', 'SETTLEMENT_HOLDING_REVIEW_REQUIRED'],
  ].filter(([code]) => conflictSummary[code] > 0).map(([, blocker]) => blocker);
  const report = { ...baseReport, target, stagedCounts, conflictCount: mapping.conflicts.length,
    conflictSummary,
    cleanup: { requested: args.get('cleanup') === true, completed: cleaned }, readyForCanonicalPromotion: false,
    blockers: ['CANONICAL_PROMOTION_DISABLED', ...conflictBlockers,
      ...(mapping.entities.users.some((row) => !row.canonicalEligible) ? ['IDENTITY_CONFLICTS_PRESENT'] : [])] };
  report.reportDigest = sha256(stable(report));
  const written = await writeJson0600(required(args, 'output'), report);
  process.stdout.write(`${JSON.stringify({ ok: true, output: written, reportDigest: report.reportDigest,
    engine, isolated: true, stagedCounts, cleaned })}\n`);
} catch (error) {
  if (!committed) await database.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally { await database.close(); }
