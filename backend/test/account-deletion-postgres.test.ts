import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresAccountDeletionStore } from '../src/account/deletion-worker.js';
import { deletionBlockersQuery } from '../src/account/deletion-policy.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite) {
  return {
    health: async () => true,
    query: async (text: string, values?: unknown[]) => result(await pglite.query(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

describe('automatic account deletion', () => {
  it('anonymizes due unblocked accounts, revokes access, and retains blocked accounts', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
      '0010_payment_recovery.sql', '0011_backup_audit.sql', '0012_mobile_publish.sql',
      '0013_push_delivery.sql', '0014_account_deletion_automation.sql',
      '0015_credit_listing_audits.sql', '0016_trading_subjects.sql',
      '0022_kai_credit_double_entry_ledger.sql', '0024_kai_credit_order_reservations.sql',
      '0025_kai_credit_order_confirmation.sql',
      '0026_kai_credit_order_delivery_capture.sql',
      '0027_kai_credit_order_delivery_issues.sql',
      '0028_kai_credit_order_delivery_versions.sql',
      '0029_kai_credit_order_mutual_refunds.sql',
      '0030_kai_credit_supplier_settlements.sql',
      '0031_kai_credit_order_dispute_adjudication.sql',
      '0032_kai_credit_post_acceptance_refunds.sql',
      '0033_kai_credit_post_acceptance_adjudication.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const config = loadConfig({ NODE_ENV: 'test', AUDIT_PEPPER: 'a'.repeat(32) });
    const store = new PostgresAccountDeletionStore(database, config);
    const now = new Date('2026-08-20T00:00:00.000Z');
    const due = new Date(now.getTime() - 60_000);
    const userId = randomUUID();
    const heldUserId = randomUUID();
    const phoneHash = 'phone-lookup-one';
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, display_name, status)
       VALUES ($1, 'encrypted-phone-one', $2, '待注销用户', 'deletion_pending'),
              ($3, 'encrypted-phone-two', 'phone-lookup-two', '存在业务用户', 'deletion_pending')`,
      [userId, phoneHash, heldUserId],
    );
    const sessionId = randomUUID();
    await database.query(
      `INSERT INTO mobile_sessions(id, user_id, token_family, device_id, app_version, platform, expires_at)
       VALUES ($1, $2, $3, 'device-one', '1.0.0', 'android', $4)`,
      [sessionId, userId, randomUUID(), new Date(now.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO session_refresh_tokens(id, session_id, token_hash, status, expires_at)
       VALUES ($1, $2, 'refresh-hash-one', 'current', $3)`,
      [randomUUID(), sessionId, new Date(now.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO device_installations(id, user_id, device_id, platform, app_version, push_enabled,
         push_token_ciphertext, push_token_lookup_hash)
       VALUES ($1, $2, 'device-one', 'android', '1.0.0', true, 'encrypted-push', 'push-hash')`,
      [randomUUID(), userId],
    );
    await database.query(
      `INSERT INTO notifications(id, user_id, category, title, body) VALUES ($1, $2, 'account', '账户消息', '待清理')`,
      [randomUUID(), userId],
    );
    await database.query(
      `INSERT INTO otp_challenges(id, destination_hash, purpose, code_hash, expires_at)
       VALUES ($1, $2, 'delete_account', 'otp-hash', $3)`,
      [randomUUID(), phoneHash, new Date(now.getTime() + 60_000)],
    );
    const completedRequestId = randomUUID();
    const heldRequestId = randomUUID();
    await database.query(
      `INSERT INTO account_deletion_requests(id, user_id, status, cooling_off_until)
       VALUES ($1, $2, 'cooling_off', $5), ($3, $4, 'cooling_off', $5)`,
      [completedRequestId, userId, heldRequestId, heldUserId, due],
    );
    await database.query(
      `INSERT INTO compute_demands(id, buyer_id, kind, title, product_hint, region, quantity, capacity_unit,
         desired_start_at, deadline_at, description)
       VALUES ($1, $2, 'gpu', '仍在进行的需求', 'H100', '上海', 1, 'GPU时', $3, $4, '需要继续履约')`,
      [randomUUID(), heldUserId, new Date(now.getTime() + 86_400_000), new Date(now.getTime() + 172_800_000)],
    );

    expect(await store.processDue(now, 10)).toEqual({ completed: 1, held: 1 });
    const users = await database.query<{
      id: string; phone_ciphertext: string; phone_lookup_hash: string | null; display_name: string; status: string;
    }>(`SELECT id, phone_ciphertext, phone_lookup_hash, display_name, status FROM users ORDER BY id`, []);
    const anonymized = users.rows.find((user) => user.id === userId)!;
    expect(anonymized).toMatchObject({ phone_lookup_hash: null, display_name: '已注销用户', status: 'anonymized' });
    expect(anonymized.phone_ciphertext).not.toContain('encrypted-phone-one');
    expect((await database.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM mobile_sessions WHERE id = $1`, [sessionId])).rows[0]?.revoked_at).not.toBeNull();
    expect((await database.query<{ status: string }>(`SELECT status FROM session_refresh_tokens WHERE session_id = $1`, [sessionId])).rows[0]?.status).toBe('revoked');
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM notifications WHERE user_id = $1`, [userId])).rows[0]?.count).toBe('0');
    expect((await database.query<{ user_id: string | null; push_enabled: boolean; push_token_ciphertext: string | null }>(
      `SELECT user_id, push_enabled, push_token_ciphertext FROM device_installations WHERE device_id LIKE 'anonymized:%'`,
    )).rows[0]).toEqual({ user_id: null, push_enabled: false, push_token_ciphertext: null });
    expect((await database.query<{ status: string }>(`SELECT status FROM account_deletion_requests WHERE id = $1`, [completedRequestId])).rows[0]?.status).toBe('completed');
    const held = (await database.query<{ status: string; legal_hold_reason: string | null }>(
      `SELECT status, legal_hold_reason FROM account_deletion_requests WHERE id = $1`, [heldRequestId],
    )).rows[0];
    expect(held?.status).toBe('blocked_by_legal_hold');
    expect(held?.legal_hold_reason).toContain('尚未完成');
    await database.close();
  });

  it('keeps both order parties on legal hold while accepted KAI credits still await settlement', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
      '0010_payment_recovery.sql', '0011_backup_audit.sql', '0012_mobile_publish.sql',
      '0013_push_delivery.sql', '0014_account_deletion_automation.sql',
      '0015_credit_listing_audits.sql', '0016_trading_subjects.sql',
      '0022_kai_credit_double_entry_ledger.sql', '0024_kai_credit_order_reservations.sql',
      '0025_kai_credit_order_confirmation.sql', '0026_kai_credit_order_delivery_capture.sql',
      '0027_kai_credit_order_delivery_issues.sql',
      '0028_kai_credit_order_delivery_versions.sql',
      '0029_kai_credit_order_mutual_refunds.sql',
      '0030_kai_credit_supplier_settlements.sql',
      '0031_kai_credit_order_dispute_adjudication.sql',
      '0032_kai_credit_post_acceptance_refunds.sql',
      '0033_kai_credit_post_acceptance_adjudication.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const buyerUserId = randomUUID(); const supplierUserId = randomUUID(); const reviewerOne = randomUUID(); const reviewerTwo = randomUUID();
    const buyerSubjectId = randomUUID(); const supplierSubjectId = randomUUID(); const resourceId = randomUUID();
    const offerId = randomUUID(); const listingId = randomUUID(); const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
    const orderId = randomUUID(); const reserveTransactionId = randomUUID(); const captureTransactionId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
      ($1, 'buyer', '买方', 'member'), ($2, 'supplier', '提供方', 'supplier'),
      ($3, 'reviewer-one', '资源审核员', 'operator'), ($4, 'reviewer-two', '价格审核员', 'operator')`,
    [buyerUserId, supplierUserId, reviewerOne, reviewerTwo]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
      ($1, 'personal', '买方', $2), ($3, 'personal', '提供方', $4)`,
    [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
    await database.query(`INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
      VALUES ($1, $2, $1, '凯云算力有限公司', '91310101MA1DELETE01', '凯', 'approved')`, [supplierSubjectId, supplierUserId]);
    await database.query(`INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications,
      capacity_total, capacity_unit, status, verification_digest, verified_at)
      VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 2, 'GPU时', 'verified', $3, now())`,
    [resourceId, supplierSubjectId, `sha256:${'a'.repeat(64)}`]);
    const validUntil = new Date('2026-10-01T00:00:00.000Z');
    await database.query(`INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest,
      submission_version, title, service_mode, native_unit, minimum_quantity, suggested_price_cny_micros,
      status, approved_reference_cny_micros, approved_unit_credit_micros, conversion_cny_micros_per_credit,
      audit_valid_until, submitted_at, approved_at) VALUES
      ($1, $2, $3, 'delete-offer-request01', 'delete-offer-digest', 1, 'H100', 'dedicated', 'GPU时', 1, 1002000,
       'approved', 1002000, 1000000, 1002000, $4, now(), now())`, [offerId, supplierSubjectId, resourceId, validUntil]);
    for (const audit of [{ id: resourceAuditId, kind: 'resource', reviewer: reviewerOne }, { id: priceAuditId, kind: 'price', reviewer: reviewerTwo }]) {
      await database.query(`INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status,
        reviewer_id, decision_reason, evidence_summary, evidence_digest, decision_digest,
        approved_reference_cny_micros, conversion_cny_micros_per_credit, approved_unit_credit_micros, valid_until, decided_at)
        VALUES ($1, $2, 1, $3, 'approved', $4, '通过', '通过', $5, $6,
        CASE WHEN $3 = 'price' THEN 1002000 ELSE NULL END, CASE WHEN $3 = 'price' THEN 1002000 ELSE NULL END,
        CASE WHEN $3 = 'price' THEN 1000000 ELSE NULL END, $7, now())`,
      [audit.id, offerId, audit.kind, audit.reviewer, `sha256:${audit.kind === 'price' ? 'b'.repeat(64) : 'c'.repeat(64)}`, `${audit.kind}-decision`, validUntil]);
    }
    await database.query(`INSERT INTO credit_market_listings(id, offer_id, resource_id, supplier_id,
      client_request_id, payload_digest, resource_audit_id, price_audit_id, capacity_total, capacity_reserved,
      capacity_sold, capacity_unit, minimum_quantity, unit_credit_micros, reference_cny_micros,
      conversion_cny_micros_per_credit, starts_at, expires_at, audit_snapshot, published_by)
      VALUES ($1, $2, $3, $4, 'delete-listing-req01', 'delete-listing-digest', $5, $6, 2, 0, 2, 'GPU时', 1,
      1000000, 1002000, 1002000, now(), $7, '{}', $8)`,
    [listingId, offerId, resourceId, supplierSubjectId, resourceAuditId, priceAuditId, validUntil, supplierUserId]);
    const buyerReservedAccountId = randomUUID(); const supplierReceivableAccountId = randomUUID();
    await database.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative) VALUES
      ($1, 'subject', $2, $3, 'reserved', false), ($4, 'subject', $5, $6, 'supplier_receivable', false)`,
    [buyerReservedAccountId, buyerSubjectId, `subject:${buyerSubjectId}:reserved`,
      supplierReceivableAccountId, supplierSubjectId, `subject:${supplierSubjectId}:supplier_receivable`]);
    await database.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
      payload_digest, reference_type, reference_id, description, status) VALUES
      ($1, 'subject:test', 'TEST_RESERVE', 'delete-reserve-key', 'delete-reserve-digest', 'order_reservation', $3, '预留', 'pending'),
      ($2, 'subject:test', 'CREDIT_ORDER_CAPTURE', 'delete-capture-key', 'delete-capture-digest', 'order_capture', $3, '验收', 'pending')`,
    [reserveTransactionId, captureTransactionId, orderId]);
    await database.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
      ($1, $2, '00000000-0000-4000-8000-000000000101', -2000000, '测试预留发行'),
      ($3, $2, $4, 2000000, '测试订单预留'),
      ($5, $6, $4, -2000000, '测试验收扣款'),
      ($7, $6, $8, 2000000, '测试待结算')`,
    [randomUUID(), reserveTransactionId, randomUUID(), buyerReservedAccountId,
      randomUUID(), captureTransactionId, randomUUID(), supplierReceivableAccountId]);
    await database.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = now()
      WHERE id = ANY($1::uuid[])`, [[reserveTransactionId, captureTransactionId]]);
    await database.query(`INSERT INTO kai_credit_orders(id, order_number, buyer_subject_id, supplier_subject_id,
      created_by_user_id, listing_id, client_request_id, payload_digest, status, quantity, capacity_unit,
      unit_credit_micros, total_credit_micros, listing_snapshot, reservation_expires_at, confirmed_at,
      confirmed_by_user_id, delivery_started_at, delivery_ready_at, accepted_at, accepted_by_user_id, closed_at)
      VALUES ($1, 'KC20260812DELETE0001', $2, $3, $4, $5, 'delete-order-request01', 'delete-order-digest',
      'accepted', 2, 'GPU时', 1000000, 2000000, '{}', now(), now(), $6, now(), now(), now(), $4, now())`,
    [orderId, buyerSubjectId, supplierSubjectId, buyerUserId, listingId, supplierUserId]);
    await database.query(`INSERT INTO kai_credit_order_reservations(id, order_id, listing_id, buyer_subject_id,
      quantity, credit_micros, reservation_transaction_id, resolution_transaction_id, status, expires_at,
      resolved_at, resolution_reason, secured_at, secured_by_user_id)
      VALUES ($1, $2, $3, $4, 2, 2000000, $5, $6, 'captured', now(), now(), 'buyer_accepted_delivery', now(), $7)`,
    [randomUUID(), orderId, listingId, buyerSubjectId, reserveTransactionId, captureTransactionId, supplierUserId]);
    expect((await database.query<{ blocked: boolean }>(deletionBlockersQuery, [buyerUserId])).rows[0]?.blocked).toBe(true);
    expect((await database.query<{ blocked: boolean }>(deletionBlockersQuery, [supplierUserId])).rows[0]?.blocked).toBe(true);
    await database.close();
  });
});
