import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { decryptedBackupStream, sha256File, verifyEncryptedBackup } from './format.js';
import {
  databaseFingerprint, postgresProcessEnvironment, postgresServerMajor, postgresToolMajor, safeProcessError,
} from './postgres.js';

const inputIndex = process.argv.indexOf('--input');
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (!inputPath || !isAbsolute(inputPath)) throw new Error('Use --input with an absolute encrypted backup path.');

const config = loadConfig(process.env);
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!config.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY is required.');
const targetFingerprint = databaseFingerprint(config.DATABASE_URL);
if (process.env.RESTORE_CONFIRM_TARGET_FINGERPRINT !== targetFingerprint) {
  throw new Error(`RESTORE_CONFIRM_TARGET_FINGERPRINT must equal ${targetFingerprint}.`);
}
const expectedDigest = process.env.RESTORE_EXPECTED_SHA256;
if (!expectedDigest || !/^sha256:[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error('RESTORE_EXPECTED_SHA256 is required.');

function restoreErrorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 120);
  if (error instanceof Error) return safeProcessError(error.message).slice(0, 120);
  return 'RESTORE_UNKNOWN_ERROR';
}

async function childExit(child: ReturnType<typeof spawn>) {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString('utf8'); });
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(
      `PG_RESTORE_FAILED:${code ?? signal ?? 'unknown'}:${safeProcessError(stderr)}`,
    )));
  });
}

const actualDigest = await sha256File(inputPath);
if (actualDigest !== expectedDigest) throw new Error('RESTORE_ENCRYPTED_CHECKSUM_MISMATCH');
const verified = await verifyEncryptedBackup(inputPath, config.BACKUP_ENCRYPTION_KEY);
if (targetFingerprint === verified.header.databaseFingerprint) throw new Error('RESTORE_TARGET_MUST_BE_ISOLATED');
if (process.env.RESTORE_CONFIRM_SOURCE_FINGERPRINT !== verified.header.databaseFingerprint) {
  throw new Error(`RESTORE_CONFIRM_SOURCE_FINGERPRINT must equal ${verified.header.databaseFingerprint}.`);
}
if (process.env.RESTORE_CONFIRM_KEY_ID !== verified.header.keyId) {
  throw new Error(`RESTORE_CONFIRM_KEY_ID must equal ${verified.header.keyId}.`);
}

const pgEnvironment = postgresProcessEnvironment(config.DATABASE_URL, config.databaseSsl);
let pool = new Pool({ connectionString: config.DATABASE_URL, ssl: config.databaseSsl ? { rejectUnauthorized: true } : false });
const targetVersion = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
const targetPostgresMajor = postgresServerMajor(targetVersion.rows[0]?.server_version_num ?? '');
if (targetPostgresMajor !== verified.header.postgresMajor || postgresToolMajor('pg_restore') !== targetPostgresMajor) {
  await pool.end();
  throw new Error('RESTORE_POSTGRES_MAJOR_MISMATCH');
}
const existing = await pool.query<{ count: string }>(
  `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
);
if (Number(existing.rows[0]?.count ?? 0) !== 0) {
  await pool.end();
  throw new Error('RESTORE_TARGET_NOT_EMPTY');
}
await pool.end();

const restore = spawn('pg_restore', [
  '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', `--dbname=${pgEnvironment.PGDATABASE}`,
], { env: pgEnvironment, stdio: ['pipe', 'ignore', 'pipe'] });
if (!restore.stdin) throw new Error('PG_RESTORE_STDIN_UNAVAILABLE');
const decrypted = await decryptedBackupStream(inputPath, config.BACKUP_ENCRYPTION_KEY);
await Promise.all([pipeline(decrypted.stream, restore.stdin), childExit(restore)]);

const drillId = randomUUID();
const completedAt = new Date();
pool = new Pool({ connectionString: config.DATABASE_URL, ssl: config.databaseSsl ? { rejectUnauthorized: true } : false });
try {
  const schema = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  const schemaVersion = schema.rows[0]?.version ?? null;
  if (!schemaVersion || schemaVersion !== verified.header.schemaVersion) throw new Error('RESTORE_SCHEMA_VERSION_MISMATCH');
  if(config.mobileApiProfile==='inquiry_only'&&schemaVersion!=='0066_compute_data_flywheel_v1.sql')
    throw new Error('RESTORE_SCHEMA_0066_REQUIRED');
  const invariants = await pool.query<{
    listing_capacity_invalid: string; order_amount_invalid: string; duplicate_success_payment: string; refund_amount_invalid: string;
    kai_credit_transaction_unbalanced: string; kai_credit_account_negative: string;
    kai_credit_order_invalid: string; kai_credit_reservation_invalid: string; kai_credit_listing_capacity_invalid: string;
    kai_credit_delivery_invalid: string; kai_credit_acceptance_invalid: string;
    kai_credit_delivery_issue_invalid: string; kai_credit_mutual_refund_invalid: string;
    kai_credit_supplier_settlement_invalid: string;
    kai_credit_dispute_adjudication_invalid: string;
    kai_credit_post_acceptance_refund_invalid: string;
    kai_credit_post_acceptance_adjudication_invalid: string;
  }>(`SELECT
      (SELECT count(*) FROM market_listings WHERE capacity_reserved < 0 OR capacity_sold < 0
        OR capacity_reserved + capacity_sold > capacity_total)::text AS listing_capacity_invalid,
      (SELECT count(*) FROM orders WHERE subtotal_cents + fee_cents <> total_cents OR total_cents <= 0)::text AS order_amount_invalid,
      (SELECT count(*) FROM (SELECT order_id FROM payment_intents WHERE status = 'succeeded' GROUP BY order_id HAVING count(*) > 1) x)::text AS duplicate_success_payment,
      (SELECT count(*) FROM (
        SELECT r.payment_intent_id FROM refunds r JOIN payment_intents p ON p.id = r.payment_intent_id
        WHERE r.status = 'succeeded' GROUP BY r.payment_intent_id, p.amount_cents HAVING sum(r.amount_cents) > p.amount_cents
      ) x)::text AS refund_amount_invalid,
      (SELECT count(*) FROM (
        SELECT t.id FROM kai_credit_transactions t JOIN kai_credit_entries e ON e.transaction_id = t.id
        WHERE t.status = 'posted' GROUP BY t.id HAVING count(*) < 2 OR sum(e.amount_micros) <> 0
      ) x)::text AS kai_credit_transaction_unbalanced,
      (SELECT count(*) FROM (
        SELECT a.id FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id = a.id
        LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id AND t.status = 'posted'
        WHERE a.allow_negative = false GROUP BY a.id HAVING COALESCE(sum(e.amount_micros) FILTER (WHERE t.id IS NOT NULL), 0) < 0
      ) x)::text AS kai_credit_account_negative,
      (SELECT count(*) FROM kai_credit_orders WHERE total_credit_micros <> CEIL(quantity * unit_credit_micros)::bigint
        OR ((status IN ('reserved', 'confirmed', 'provisioning', 'ready', 'in_service', 'acceptance_pending',
          'release_pending', 'refund_pending', 'disputed')) <> (closed_at IS NULL)))::text AS kai_credit_order_invalid,
      (SELECT count(*) FROM kai_credit_order_reservations r JOIN kai_credit_orders o ON o.id = r.order_id
        WHERE r.credit_micros <> o.total_credit_micros OR r.quantity <> o.quantity
          OR ((r.status IN ('active', 'secured')) <> (r.resolved_at IS NULL AND r.resolution_transaction_id IS NULL))
          OR ((r.status = 'secured') AND (r.secured_at IS NULL OR r.secured_by_user_id IS NULL)))::text
        AS kai_credit_reservation_invalid,
      (SELECT count(*) FROM credit_market_listings WHERE capacity_reserved < 0 OR capacity_sold < 0
        OR capacity_reserved + capacity_sold > capacity_total)::text AS kai_credit_listing_capacity_invalid,
      (SELECT count(*) FROM kai_credit_order_deliveries d JOIN kai_credit_orders o ON o.id = d.order_id
        WHERE d.supplier_subject_id <> o.supplier_subject_id
          OR (d.attempt_number = (SELECT max(latest.attempt_number) FROM kai_credit_order_deliveries latest
                WHERE latest.order_id = d.order_id) AND (
            (d.status = 'provisioning') <> (o.status = 'provisioning')
            OR (d.status = 'ready') <> (o.status IN ('acceptance_pending', 'disputed'))
            OR (d.status = 'completed') <> (o.status IN ('accepted', 'closed') OR EXISTS (
              SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
              WHERE p.order_id = o.id AND p.status = 'succeeded'))
            OR (d.status = 'refunded') <> (o.status = 'refunded' AND NOT EXISTS (
              SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
              WHERE p.order_id = o.id AND p.status = 'succeeded'))
          ))
          OR ((d.delivery_payload_ciphertext IS NULL) <> (d.delivery_payload_digest IS NULL)))::text
        AS kai_credit_delivery_invalid,
      (SELECT count(*) FROM kai_credit_orders o
        LEFT JOIN kai_credit_order_acceptances a ON a.order_id = o.id
        LEFT JOIN kai_credit_order_reservations r ON r.order_id = o.id
        LEFT JOIN kai_credit_order_deliveries d ON d.id = a.delivery_attempt_id
        LEFT JOIN kai_credit_transactions t ON t.id = a.capture_transaction_id
        WHERE (o.status IN ('accepted', 'closed') OR EXISTS (
            SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
            WHERE p.order_id = o.id AND p.status = 'succeeded')) <> (a.order_id IS NOT NULL)
          OR ((o.status IN ('accepted', 'closed') OR EXISTS (
            SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
            WHERE p.order_id = o.id AND p.status = 'succeeded')) AND (
            a.buyer_subject_id <> o.buyer_subject_id OR a.accepted_by_user_id <> o.accepted_by_user_id
            OR a.accepted_at <> o.accepted_at OR r.status <> 'captured'
            OR r.resolution_transaction_id <> a.capture_transaction_id OR d.status <> 'completed'
            OR d.order_id <> o.id
            OR t.status <> 'posted' OR t.scope <> 'CREDIT_ORDER_CAPTURE'
          )))::text AS kai_credit_acceptance_invalid,
      (SELECT count(*) FROM kai_credit_order_delivery_issues i
        JOIN kai_credit_orders o ON o.id = i.order_id
        JOIN kai_credit_order_reservations r ON r.order_id = o.id
        JOIN kai_credit_order_deliveries d ON d.id = i.delivery_attempt_id
        WHERE i.buyer_subject_id <> o.buyer_subject_id OR d.order_id <> o.id
          OR i.description_ciphertext IS NULL OR i.description_digest IS NULL
          OR (i.status = 'open' AND (o.status <> 'disputed' OR r.status <> 'secured' OR d.status <> 'ready'))
          OR (i.status = 'rework_started' AND (o.status <> 'provisioning' OR r.status <> 'secured' OR d.status <> 'ready'))
          OR (i.status = 'reworked' AND d.status <> 'superseded')
          OR (i.status = 'escalated' AND (o.status <> 'disputed' OR r.status <> 'secured' OR d.status <> 'ready'))
          OR (i.status = 'dismissed' AND (o.status <> 'acceptance_pending' OR r.status <> 'secured' OR d.status <> 'ready'))
          OR (i.status = 'refunded' AND (o.status <> 'refunded' OR r.status <> 'released' OR d.status <> 'refunded'))
        )::text AS kai_credit_delivery_issue_invalid,
      (SELECT count(*) FROM kai_credit_orders o
        LEFT JOIN kai_credit_order_mutual_refunds mr ON mr.order_id = o.id
        LEFT JOIN kai_credit_order_delivery_issues i ON i.id = mr.delivery_issue_id
        LEFT JOIN kai_credit_order_reservations r ON r.order_id = o.id
        LEFT JOIN kai_credit_transactions t ON t.id = mr.refund_transaction_id
        WHERE mr.order_id IS NOT NULL AND (
            o.status <> 'refunded'
            OR mr.buyer_subject_id <> o.buyer_subject_id OR mr.supplier_subject_id <> o.supplier_subject_id
            OR mr.credit_micros <> o.total_credit_micros OR mr.status <> 'succeeded'
            OR i.order_id <> o.id OR i.status <> 'refunded' OR i.requested_resolution <> 'refund'
            OR r.status <> 'released' OR r.resolution_transaction_id <> mr.refund_transaction_id
            OR t.status <> 'posted' OR t.scope <> 'CREDIT_ORDER_MUTUAL_REFUND'
          ))::text AS kai_credit_mutual_refund_invalid,
      (SELECT count(*) FROM kai_credit_orders o
        LEFT JOIN kai_credit_supplier_settlements s ON s.order_id = o.id
        LEFT JOIN kai_credit_order_acceptances a ON a.id = s.acceptance_id
        LEFT JOIN kai_credit_order_reservations r ON r.order_id = o.id
        LEFT JOIN kai_credit_transactions t ON t.id = s.settlement_transaction_id
        LEFT JOIN kai_credit_entries ae ON ae.transaction_id = t.id AND ae.amount_micros > 0
        LEFT JOIN kai_credit_accounts aa ON aa.id = ae.account_id
        LEFT JOIN kai_credit_entries re ON re.transaction_id = t.id AND re.amount_micros < 0
        LEFT JOIN kai_credit_accounts ra ON ra.id = re.account_id
        WHERE (o.status = 'closed') <> (s.order_id IS NOT NULL)
          OR (o.status = 'closed' AND (
            s.supplier_subject_id IS DISTINCT FROM o.supplier_subject_id
            OR s.credit_micros IS DISTINCT FROM o.total_credit_micros
            OR s.status IS DISTINCT FROM 'succeeded' OR a.order_id IS DISTINCT FROM o.id
            OR s.available_at IS DISTINCT FROM a.accepted_at + interval '7 days'
            OR s.settled_at IS NULL OR s.settled_at < s.available_at OR r.status IS DISTINCT FROM 'captured'
            OR t.status IS DISTINCT FROM 'posted' OR t.scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT'
            OR aa.subject_id IS DISTINCT FROM o.supplier_subject_id OR aa.account_kind IS DISTINCT FROM 'available'
            OR ae.amount_micros IS DISTINCT FROM o.total_credit_micros
            OR ra.subject_id IS DISTINCT FROM o.supplier_subject_id
            OR ra.account_kind IS DISTINCT FROM 'supplier_receivable'
            OR re.amount_micros IS DISTINCT FROM -o.total_credit_micros
          )))::text AS kai_credit_supplier_settlement_invalid,
      (SELECT count(*) FROM kai_credit_orders o
        LEFT JOIN kai_credit_order_dispute_escalations e ON e.order_id = o.id
        LEFT JOIN kai_credit_order_delivery_issues i ON i.id = e.delivery_issue_id
        LEFT JOIN kai_credit_order_deliveries dl ON dl.id = i.delivery_attempt_id
        LEFT JOIN kai_credit_order_reservations r ON r.order_id = o.id
        LEFT JOIN kai_credit_order_dispute_decisions d ON d.escalation_id = e.id
        LEFT JOIN kai_credit_transactions t ON t.id = d.refund_transaction_id
        LEFT JOIN kai_credit_order_dispute_decision_requests q ON q.decision_id = d.id
        WHERE (e.id IS NOT NULL AND (
          e.buyer_subject_id IS DISTINCT FROM o.buyer_subject_id
          OR e.supplier_subject_id IS DISTINCT FROM o.supplier_subject_id OR i.order_id IS DISTINCT FROM o.id
          OR i.requested_resolution IS DISTINCT FROM 'refund'
          OR (e.status = 'pending' AND (o.status <> 'disputed' OR i.status <> 'escalated'
            OR r.status <> 'secured' OR dl.status <> 'ready' OR d.id IS NOT NULL))
          OR (e.status = 'resolved' AND (d.id IS NULL OR e.resolved_at IS NULL))
          OR (d.outcome = 'full_refund' AND (
            o.status <> 'refunded' OR i.status <> 'refunded' OR dl.status <> 'refunded'
            OR r.status <> 'released' OR d.credit_micros <> o.total_credit_micros
            OR r.resolution_transaction_id <> d.refund_transaction_id
            OR t.status <> 'posted' OR t.scope <> 'CREDIT_ORDER_ADJUDICATED_REFUND'))
          OR (d.outcome = 'resume_acceptance' AND (
            o.status <> 'acceptance_pending' OR i.status <> 'dismissed' OR dl.status <> 'ready'
            OR r.status <> 'secured' OR d.credit_micros <> 0 OR d.refund_transaction_id IS NOT NULL))
          OR (d.id IS NOT NULL AND (q.order_id IS DISTINCT FROM o.id OR q.operator_id IS DISTINCT FROM d.operator_id))
        )) OR (o.status = 'refunded'
          AND NOT EXISTS (SELECT 1 FROM kai_credit_order_mutual_refunds mr WHERE mr.order_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM kai_credit_order_dispute_decisions dd
            WHERE dd.order_id = o.id AND dd.outcome = 'full_refund')
          AND NOT EXISTS (SELECT 1 FROM kai_credit_order_post_acceptance_refunds pr
            WHERE pr.order_id = o.id AND pr.status = 'succeeded'))
        )::text AS kai_credit_dispute_adjudication_invalid,
      (SELECT count(*) FROM kai_credit_order_post_acceptance_refunds p
        JOIN kai_credit_orders o ON o.id = p.order_id
        LEFT JOIN kai_credit_order_acceptances a ON a.id = p.acceptance_id
        LEFT JOIN kai_credit_order_reservations r ON r.order_id = o.id
        LEFT JOIN kai_credit_order_deliveries dl ON dl.id = a.delivery_attempt_id
        LEFT JOIN kai_credit_transactions t ON t.id = p.refund_transaction_id
        LEFT JOIN credit_market_listings l ON l.id = o.listing_id
        LEFT JOIN kai_credit_post_acceptance_refund_escalations x ON x.refund_id = p.id
        LEFT JOIN kai_credit_post_acceptance_refund_decisions d ON d.refund_id = p.id
        WHERE p.buyer_subject_id IS DISTINCT FROM o.buyer_subject_id
          OR p.supplier_subject_id IS DISTINCT FROM o.supplier_subject_id
          OR p.credit_micros IS DISTINCT FROM o.total_credit_micros
          OR a.order_id IS DISTINCT FROM o.id OR a.accepted_at IS DISTINCT FROM o.accepted_at
          OR p.requested_at < a.accepted_at OR p.requested_at >= a.accepted_at + interval '7 days'
          OR r.status IS DISTINCT FROM 'captured' OR dl.status IS DISTINCT FROM 'completed'
          OR l.capacity_sold < o.quantity
          OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = o.id)
          OR (p.status = 'pending' AND (
            o.status <> 'accepted' OR p.approved_by_user_id IS NOT NULL
            OR p.refund_transaction_id IS NOT NULL OR p.resolved_at IS NOT NULL
            OR x.id IS NOT NULL OR d.id IS NOT NULL))
          OR (p.status = 'escalated' AND (
            o.status <> 'accepted' OR p.approved_by_user_id IS NOT NULL
            OR p.refund_transaction_id IS NOT NULL OR p.resolved_at IS NOT NULL
            OR x.id IS NULL OR x.status <> 'pending' OR d.id IS NOT NULL))
          OR (p.status = 'succeeded' AND (
            o.status <> 'refunded' OR p.resolved_at IS NULL
            OR p.resolved_at < p.requested_at OR t.status IS DISTINCT FROM 'posted'
            OR t.reference_type IS DISTINCT FROM 'refund' OR t.reference_id IS DISTINCT FROM o.id::text
            OR (SELECT count(*) FROM kai_credit_entries e WHERE e.transaction_id = t.id) <> 2
            OR (SELECT COALESCE(sum(e.amount_micros), 0) FROM kai_credit_entries e
                JOIN kai_credit_accounts account ON account.id = e.account_id
                WHERE e.transaction_id = t.id AND account.subject_id = o.buyer_subject_id
                  AND account.account_kind = 'available') <> o.total_credit_micros
            OR (SELECT COALESCE(sum(e.amount_micros), 0) FROM kai_credit_entries e
                JOIN kai_credit_accounts account ON account.id = e.account_id
                WHERE e.transaction_id = t.id AND account.subject_id = o.supplier_subject_id
                  AND account.account_kind = 'supplier_receivable') <> -o.total_credit_micros
            OR (p.approved_by_user_id IS NOT NULL AND (
              t.scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_REFUND' OR x.id IS NOT NULL OR d.id IS NOT NULL))
            OR (p.approved_by_user_id IS NULL AND (
              t.scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND'
              OR x.status IS DISTINCT FROM 'resolved' OR d.outcome IS DISTINCT FROM 'full_refund'
              OR d.refund_transaction_id IS DISTINCT FROM p.refund_transaction_id))
          ))
          OR (p.status = 'rejected' AND (
            o.status <> 'accepted' OR p.approved_by_user_id IS NOT NULL
            OR p.refund_transaction_id IS NOT NULL OR p.resolved_at IS NULL
            OR p.resolved_at < p.requested_at OR x.status IS DISTINCT FROM 'resolved'
            OR d.outcome IS DISTINCT FROM 'reject_refund' OR d.refund_transaction_id IS NOT NULL
          )))::text AS kai_credit_post_acceptance_refund_invalid,
      (SELECT count(*) FROM kai_credit_post_acceptance_refund_escalations x
        JOIN kai_credit_order_post_acceptance_refunds p ON p.id = x.refund_id
        JOIN kai_credit_orders o ON o.id = x.order_id
        LEFT JOIN kai_credit_post_acceptance_refund_decisions d ON d.escalation_id = x.id
        LEFT JOIN kai_credit_post_acceptance_refund_decision_requests q ON q.decision_id = d.id
        LEFT JOIN kai_credit_transactions t ON t.id = d.refund_transaction_id
        WHERE x.order_id IS DISTINCT FROM p.order_id
          OR x.buyer_subject_id IS DISTINCT FROM o.buyer_subject_id
          OR x.supplier_subject_id IS DISTINCT FROM o.supplier_subject_id
          OR (x.escalated_by_side = 'buyer' AND x.escalated_at < p.requested_at + interval '24 hours')
          OR (x.status = 'pending' AND (
            p.status <> 'escalated' OR o.status <> 'accepted' OR x.resolved_at IS NOT NULL OR d.id IS NOT NULL))
          OR (x.status = 'resolved' AND (
            x.resolved_at IS NULL OR d.id IS NULL OR q.decision_id IS NULL
            OR d.order_id IS DISTINCT FROM o.id OR d.refund_id IS DISTINCT FROM p.id
            OR q.order_id IS DISTINCT FROM o.id OR q.operator_id IS DISTINCT FROM d.operator_id
            OR (d.outcome = 'full_refund' AND (
              p.status <> 'succeeded' OR o.status <> 'refunded'
              OR d.credit_micros <> o.total_credit_micros
              OR d.refund_transaction_id IS DISTINCT FROM p.refund_transaction_id
              OR t.status IS DISTINCT FROM 'posted'
              OR t.scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND'))
            OR (d.outcome = 'reject_refund' AND (
              p.status <> 'rejected' OR o.status <> 'accepted'
              OR d.credit_micros <> 0 OR d.refund_transaction_id IS NOT NULL))
          )))::text AS kai_credit_post_acceptance_adjudication_invalid`);
  const checks = invariants.rows[0];
  if (!checks || Object.values(checks).some((value) => Number(value) !== 0)) throw new Error('RESTORE_LEDGER_INVARIANT_FAILED');
  await pool.query(
    `INSERT INTO restore_drills(id, backup_artifact_name, target_fingerprint, status, schema_version,
       verified_invariants, started_at, completed_at)
     VALUES ($1, $2, $3, 'succeeded', $4, $5::jsonb, $6, $6)`,
    [drillId, basename(inputPath), targetFingerprint, schemaVersion, JSON.stringify(checks), completedAt],
  );
  await pool.query(
    `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id, payload_digest, metadata)
     VALUES ($1, NULL, 'system', 'DATABASE_RESTORE_VERIFIED', 'RESTORE_DRILL', $2, $3, $4::jsonb)`,
    [randomUUID(), drillId, actualDigest.slice(7), JSON.stringify({ artifactName: basename(inputPath), targetFingerprint, schemaVersion })],
  );
  if(config.mobileApiProfile==='inquiry_only'){
    const sourceAuditUrl=process.env.RESTORE_AUDIT_DATABASE_URL;
    if(!sourceAuditUrl)throw new Error('RESTORE_AUDIT_DATABASE_URL_REQUIRED');
    if(databaseFingerprint(sourceAuditUrl)!==verified.header.databaseFingerprint)
      throw new Error('RESTORE_AUDIT_DATABASE_FINGERPRINT_MISMATCH');
    const auditPool=new Pool({connectionString:sourceAuditUrl,ssl:config.databaseSsl?{rejectUnauthorized:true}:false});
    try{
      const auditSchema=await auditPool.query<{version:string}>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      if(auditSchema.rows[0]?.version!=='0066_compute_data_flywheel_v1.sql')
        throw new Error('RESTORE_AUDIT_DATABASE_SCHEMA_MISMATCH');
      await auditPool.query('BEGIN');
      await auditPool.query(`INSERT INTO restore_drills(id,backup_artifact_name,target_fingerprint,status,schema_version,
        verified_invariants,started_at,completed_at) VALUES($1,$2,$3,'succeeded',$4,$5::jsonb,$6,$6)`,
      [drillId,basename(inputPath),targetFingerprint,schemaVersion,JSON.stringify(checks),completedAt]);
      await auditPool.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata)
        VALUES($1,NULL,'system','DATABASE_RESTORE_VERIFIED','RESTORE_DRILL',$2,$3,$4::jsonb)`,
      [randomUUID(),drillId,actualDigest.slice(7),JSON.stringify({artifactName:basename(inputPath),targetFingerprint,
        schemaVersion,sourceDatabaseFingerprint:verified.header.databaseFingerprint,durability:'local_only'})]);
      await auditPool.query('COMMIT');
    }catch(error){await auditPool.query('ROLLBACK').catch(()=>undefined);throw error;}finally{await auditPool.end();}
  }
  process.stdout.write(`${JSON.stringify({ ok: true, drillId, artifactName: basename(inputPath), targetFingerprint, schemaVersion, verifiedInvariants: checks })}\n`);
} catch (error) {
  await pool.query(
    `INSERT INTO restore_drills(id, backup_artifact_name, target_fingerprint, status, started_at, completed_at, failure_code)
     VALUES ($1, $2, $3, 'failed', $4, $4, $5)`,
    [drillId, basename(inputPath), targetFingerprint, completedAt, restoreErrorCode(error)],
  ).catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
