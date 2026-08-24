#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { auditToken, hmac, parseArgs, readCredential, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';
import { quoteIdentifier, schemaInventory, sensitiveColumn, sqliteJson } from './lib/sqlite.mjs';

const args = parseArgs(process.argv.slice(2));
const databasePath = required(args, 'sqlite');
const serverPath = required(args, 'python-server');
const paymentPath = required(args, 'python-payment');
const auditKey = await readCredential(required(args, 'audit-key-file'));
const snapshotEvidence = JSON.parse(await readFile(required(args, 'snapshot-evidence'), 'utf8'));
const authPg = JSON.parse(await readFile(required(args, 'auth-pg-inventory'), 'utf8'));
const commercePg = JSON.parse(await readFile(required(args, 'commerce-pg-inventory'), 'utf8'));
const pgInventory = (value, system) => {
  const signed = { ...value }; delete signed.attestationHmac; delete signed.reportDigest;
  if (value?.schemaVersion !== 1 || value?.system !== system
    || !/^system_[0-9a-f]{64}$/u.test(value.fingerprintToken)
    || !/^[0-9a-f]{64}$/u.test(value.fingerprintDigest)
    || !/^[0-9a-f]{64}$/u.test(value.schemaDigest)
    || value.primaryKeyOrdinalValidated !== true
    || !Number.isSafeInteger(value.primaryKeyColumnCount) || value.primaryKeyColumnCount < 0
    || !/^[0-9a-f]{64}$/u.test(value.primaryKeyOrdinalDigest)
    || !Number.isSafeInteger(value.tableCount) || value.tableCount < 1
    || !Number.isSafeInteger(value.migrationCount) || value.migrationCount < 0
    || !/^[0-9a-f]{64}$/u.test(value.migrationDigest)
    || !value.tableCounts || Object.values(value.tableCounts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || !/^[0-9a-f]{64}$/u.test(value.attestationHmac)
    || value.attestationHmac !== hmac(auditKey, stable(signed))
    || (system === '18_node_auth_pg' && (!Number.isSafeInteger(value.verifiedSubjectCount)
      || value.verifiedSubjectCount < 0 || !Number.isSafeInteger(value.sourceSubjectCandidates)
      || value.sourceSubjectCandidates < 0 || !Number.isSafeInteger(value.matchedSubjects)
      || value.matchedSubjects < 0 || value.matchedSubjects > value.sourceSubjectCandidates
      || !Array.isArray(value.sourceIdentityMatches)
      || value.sourceIdentityMatches.some((match) => !/^users_[0-9a-f]{64}$/u.test(match?.sourceUserToken)
        || !/^kai-subject_[0-9a-f]{64}$/u.test(match?.verifiedSubjectToken))
      || value.sourceIdentityMatches.length !== value.matchedSubjects))) {
    throw new Error('UNIFIED_PG_INVENTORY_INVALID');
  }
  return value;
};
pgInventory(authPg, '18_node_auth_pg'); pgInventory(commercePg, '43_node_commerce_pg');
const database = await readFile(databasePath); const databaseInfo = await stat(databasePath);
if (snapshotEvidence?.schemaVersion !== 1 || snapshotEvidence.kind !== 'sqlite_backup_api_consistency_evidence'
  || snapshotEvidence.backupCopy?.sha256 !== sha256(database)
  || snapshotEvidence.backupCopy?.bytes !== databaseInfo.size
  || !Number.isFinite(Date.parse(snapshotEvidence.capturedAt))
  || snapshotEvidence.backupCopy?.quickCheck?.[0]?.quick_check !== 'ok'
  || snapshotEvidence.backupCopy?.foreignKeyViolationCount !== 0
  || !Number.isSafeInteger(snapshotEvidence.backupCopy?.pageCount) || snapshotEvidence.backupCopy.pageCount < 1
  || !/^[0-9a-f]{64}$/u.test(snapshotEvidence.sourceObservation?.database?.sha256)
  || !Number.isSafeInteger(snapshotEvidence.sourceObservation?.database?.bytes)
  || !/^[0-9a-f]{64}$/u.test(snapshotEvidence.sourceObservation?.wal?.sha256)
  || !Number.isSafeInteger(snapshotEvidence.sourceObservation?.wal?.bytes)
  || !/^[0-9a-f]{64}$/u.test(snapshotEvidence.sourceObservation?.shm?.sha256)
  || !Number.isSafeInteger(snapshotEvidence.sourceObservation?.shm?.bytes)
  || snapshotEvidence.claims?.remoteFilesReadOnly !== true
  || snapshotEvidence.claims?.sourceObservationMayAdvanceAfterBackup !== true
  || snapshotEvidence.claims?.walBytesEmbeddedInBackupCopy !== false
  || snapshotEvidence.claims?.backupCopyIsConsistentSQLiteImage !== true
  || snapshotEvidence.privacy?.sourcePathsIncluded !== false
  || snapshotEvidence.privacy?.piiValuesIncluded !== false
  || snapshotEvidence.privacy?.credentialsIncluded !== false) {
  throw new Error('UNIFIED_SNAPSHOT_EVIDENCE_INVALID');
}
const server = await readFile(serverPath, 'utf8'); const payment = await readFile(paymentPath, 'utf8');
const rawInventory = await schemaInventory(databasePath);
const sqlitePrimaryKeys = [];
for (const table of rawInventory) {
  const primaryKeys = table.columns.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  if (primaryKeys.some((column, index) => Number(column.pk) !== index + 1)) {
    throw new Error('UNIFIED_SQLITE_PRIMARY_KEY_ORDINAL_INVALID');
  }
  sqlitePrimaryKeys.push(...primaryKeys.map((column) => ({ table: table.name, column: column.name,
    primaryKeyOrdinal: Number(column.pk) })));
}
const sqliteTableNames = rawInventory.map((table) => table.name).sort();
const sqliteMigrationProvenance = sqliteTableNames.includes('schema_migrations')
  ? { status: 'source_table_present_manual_review', evidenceDigest: sha256(stable(['schema_migrations',
    rawInventory.find((table) => table.name === 'schema_migrations')?.rowCount])) }
  : { status: 'not_applicable', reason: 'source_schema_has_no_schema_migrations_table',
    evidenceDigest: sha256(stable({ tableNames: sqliteTableNames,
      snapshotEvidenceDigest: sha256(stable(snapshotEvidence)) })) };
const tables = [];
for (const table of rawInventory) {
  const safeColumns = table.columns.filter((column) => !sensitiveColumn(column.name));
  const selection = safeColumns.length > 0 ? safeColumns.map((column) => quoteIdentifier(column.name)).join(',') : '1 AS structural_row';
  const rows = await sqliteJson(databasePath, `SELECT ${selection} FROM ${quoteIdentifier(table.name)} ORDER BY rowid;`);
  const schema = table.columns.map((column) => ({ type: String(column.type ?? '').toUpperCase(),
    notNull: Boolean(column.notnull), primaryKeyOrdinal: Number(column.pk), sensitive: sensitiveColumn(column.name) }));
  tables.push({ table: table.name, rowCount: table.rowCount, schemaDigest: sha256(stable(schema)),
    keySchema: { primaryKeyColumnTokens: table.columns.filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => auditToken(auditKey, 'column', `${table.name}:${column.name}`)),
    uniqueIndexCount: table.indexes.filter((index) => Number(index.unique) === 1).length,
    foreignKeyCount: table.foreignKeys.length },
    safeColumnCount: safeColumns.length, sensitiveColumnCount: table.columns.length - safeColumns.length,
    safeContentHmac: hmac(auditKey, stable(rows)) });
}

const paymentIdentifiers = await sqliteJson(databasePath,
  `SELECT id,provider_txn_id FROM payments ORDER BY id;`);

const literalExactRoutes = [...server.matchAll(/if\s+path\s*==\s*["']([^"']+)["']/gu)].map((match) => match[1]);
const uniqueLiteralExactRoutes = [...new Set(literalExactRoutes)].sort();
const dynamicRoutePatternCount = [...server.matchAll(/re\.fullmatch\([^\n]*,\s*path\)/gu)].length;
const setMembershipRouteCount = [...server.matchAll(/if\s+path\s+in\s*\(([^)]*)\)/gu)]
  .flatMap((match) => [...match[1].matchAll(/["'](\/api\/[^"']+)["']/gu)]).length;
const staticDispatchBranchCount = literalExactRoutes.length + dynamicRoutePatternCount + setMembershipRouteCount;
const paymentFunctions = ['create_checkout', 'query_order', 'refund_order', 'verify_signature'];
const serverFlows = ['request_provider_checkout', 'apply_payment_callback', 'query_and_confirm_qixiang_payment',
  'reconcile_pending_qixiang_payments', 'request_provider_refund'];
const requiredDomainCounts = Object.fromEntries(await Promise.all(['users', 'listings', 'orders', 'payments',
  'allocations', 'settlements'].map(async (table) => [table,
    Number((await sqliteJson(databasePath, `SELECT count(*) count FROM ${quoteIdentifier(table)};`))[0].count)])));
const output = {
  schemaVersion: 1,
  source: { kind: 'sqlite_consistent_backup_copy', bytes: databaseInfo.size, sha256: sha256(database),
    consistencyMethod: 'sqlite_backup_api_read_transaction', capturedAt: snapshotEvidence.capturedAt,
    evidenceDigest: sha256(stable(snapshotEvidence)), quickCheck: 'ok', foreignKeyViolationCount: 0,
    sourceObservation: { observedAt: snapshotEvidence.sourceObservation.observedAt,
      database: snapshotEvidence.sourceObservation.database, wal: snapshotEvidence.sourceObservation.wal,
      shm: snapshotEvidence.sourceObservation.shm, mayAdvanceAfterBackup: true },
    walState: { contentCopied: false, contentRequired: false, sourceDigestRecorded: true } },
  tables,
  requiredDomainCounts,
  paymentIdentityAudit: paymentIdentifiers.map((row) => ({
    outTradeNoToken: auditToken(auditKey, 'out_trade_no', row.id),
    tradeNoToken: row.provider_txn_id ? auditToken(auditKey, 'trade_no', row.provider_txn_id) : null,
  })),
  pythonFlow: {
    serverCodeSha256: sha256(server), paymentAdapterCodeSha256: sha256(payment),
    literalExactRoutes: { handlerBranchCount: literalExactRoutes.length, uniquePathCount: uniqueLiteralExactRoutes.length,
      digest: sha256(stable(uniqueLiteralExactRoutes)), completeness: 'literal_exact_only' },
    dynamicOrManualRoutes: { regexBranchCount: dynamicRoutePatternCount,
      setMembershipPathCount: setMembershipRouteCount, staticDispatchBranchCount,
      completeness: 'static_python_dispatch_inventory_not_runtime_route_proof', manualReviewRequired: true },
    serverFlowPresence: Object.fromEntries(serverFlows.map((name) => [name, new RegExp(`def\\s+${name}\\s*\\(`, 'u').test(server)])),
    paymentFunctionPresence: Object.fromEntries(paymentFunctions.map((name) => [name,
      new RegExp(`def\\s+${name}\\s*\\(`, 'u').test(payment)])),
    activeQueryAfterCallbackPresent: /apply_payment_callback[\s\S]+query_and_confirm_qixiang_payment/u.test(server),
  },
  dataIslands: {
    sqliteCommerce18: { system: '18_sqlite_commerce', fingerprintToken: auditToken(auditKey, 'system',
      `sqlite-commerce|${sha256(database)}`), schemaDigest: sha256(stable(tables.map((table) => [table.table, table.schemaDigest]))),
      tableCount: rawInventory.length, primaryKeyOrdinalValidated: true,
      primaryKeyColumnCount: sqlitePrimaryKeys.length,
      primaryKeyOrdinalDigest: sha256(stable(sqlitePrimaryKeys)), migrationProvenance: sqliteMigrationProvenance,
      tableCounts: Object.fromEntries(tables.map((table) => [table.table, table.rowCount])) },
    nodeAuthPg18: { system: authPg.system, fingerprintToken: authPg.fingerprintToken,
      fingerprintDigest: authPg.fingerprintDigest, schemaDigest: authPg.schemaDigest, tableCounts: authPg.tableCounts,
      tableCount: authPg.tableCount, migrationCount: authPg.migrationCount, migrationDigest: authPg.migrationDigest,
      primaryKeyOrdinalValidated: authPg.primaryKeyOrdinalValidated,
      primaryKeyColumnCount: authPg.primaryKeyColumnCount,
      primaryKeyOrdinalDigest: authPg.primaryKeyOrdinalDigest,
      sourceIdentityMatches: [...authPg.sourceIdentityMatches]
        .sort((left, right) => left.sourceUserToken.localeCompare(right.sourceUserToken)),
      verifiedSubjectCount: authPg.verifiedSubjectCount, sourceSubjectCandidates: authPg.sourceSubjectCandidates,
      matchedSubjects: authPg.matchedSubjects, matchingPolicy: authPg.matchingPolicy },
    nodeCommercePg43: { system: commercePg.system, fingerprintToken: commercePg.fingerprintToken,
      fingerprintDigest: commercePg.fingerprintDigest, schemaDigest: commercePg.schemaDigest,
      tableCounts: commercePg.tableCounts, tableCount: commercePg.tableCount,
      migrationCount: commercePg.migrationCount, migrationDigest: commercePg.migrationDigest,
      primaryKeyOrdinalValidated: commercePg.primaryKeyOrdinalValidated,
      primaryKeyColumnCount: commercePg.primaryKeyColumnCount,
      primaryKeyOrdinalDigest: commercePg.primaryKeyOrdinalDigest },
  },
  fingerprints: { auth18: authPg.fingerprintToken, commerce43: commercePg.fingerprintToken },
  privacy: { piiValuesIncluded: false, rawClaimsIncluded: false, rawCallbacksIncluded: false,
    merchantCredentialsIncluded: false, sourcePathsIncluded: false, providerIdentifiersTokenized: true },
};
output.reportDigest = sha256(stable(output));
const written = await writeJson0600(required(args, 'output'), output);
process.stdout.write(`${JSON.stringify({ ok: true, output: { ...written }, reportDigest: output.reportDigest })}\n`);
