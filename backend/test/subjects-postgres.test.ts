import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { AppError } from '../src/errors.js';
import { PostgresListingAuditStore } from '../src/listings/store.js';
import { SubjectService } from '../src/subjects/service.js';
import { PostgresSubjectStore } from '../src/subjects/store.js';
import { permissionsFor } from '../src/subjects/types.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => {
      const client = { query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)) } as unknown as PoolClient;
      return work(client);
    }),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrate(pglite: PGlite) {
  for (const name of ['0001_cloudpay_ledger.sql', '0003_market_reservations.sql', '0012_mobile_publish.sql', '0015_credit_listing_audits.sql', '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql', '0039_compute_node_readiness.sql', '0054_offer_card_hour_price.sql']) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
}

const config = loadConfig({
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
});

describe('same-account trading subjects', () => {
  it('reserves financial refund approval for accountable provider roles', () => {
    expect(permissionsFor('owner')).toContain('provider.refund.approve');
    expect(permissionsFor('admin')).toContain('provider.refund.approve');
    expect(permissionsFor('provider_manager')).toContain('provider.refund.approve');
    expect(permissionsFor('provider_operator')).not.toContain('provider.refund.approve');
    expect(permissionsFor('viewer')).not.toContain('provider.refund.approve');
  });

  it('creates one personal subject, switches to an organization without re-login, and isolates workspace data', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'owner-phone', '凯', 'member')`, [userId]);
    const audits: string[] = [];
    const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const store = new PostgresSubjectStore(database);
    const service = new SubjectService(store, accounts, config);
    const principal: AccountPrincipal = { userId, sessionId: 'same-session', role: 'member' };

    const first = await service.list(principal);
    const second = await service.list(principal);
    expect(first.subjects).toHaveLength(1);
    expect(second.subjects).toHaveLength(1);
    expect(first.currentSubjectId).toBe(second.currentSubjectId);
    expect(first.subjects[0]).toMatchObject({ kind: 'personal', role: 'owner', selected: true });

    const created = await service.createOrganization(principal, 'KAI 算力实验室', 'organization-create-00001', { requestId: 'r1', ip: '127.0.0.1' });
    const replay = await service.createOrganization(principal, 'KAI 算力实验室', 'organization-create-00001', { requestId: 'r2', ip: '127.0.0.1' });
    expect(created.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, subject: { id: created.subject.id } });
    await expect(service.createOrganization(principal, '不同组织', 'organization-create-00001', { requestId: 'r3', ip: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

    const selected = await service.select(principal, created.subject.id, { requestId: 'r4', ip: '127.0.0.1' });
    expect(selected).toMatchObject({ id: created.subject.id, kind: 'organization', selected: true });
    const organizationWorkspace = await service.providerBootstrap(principal);
    expect(organizationWorkspace).toMatchObject({
      sameAccount: true, requiresRelogin: false, supplier: null,
      nextAction: { key: 'start_provider_onboarding', route: 'provider_onboarding' },
    });

    const personalId = first.currentSubjectId!;
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '个人算力主体', '91310101MA1ABCDEFA', '凯', 'approved')`, [randomUUID(), userId, personalId],
    );
    expect((await service.providerBootstrap(principal)).supplier).toBeNull();
    await service.select(principal, personalId, { requestId: 'r5', ip: '127.0.0.1' });
    expect((await service.providerBootstrap(principal)).supplier?.legalName).toBe('个人算力主体');
    expect(audits).toEqual(expect.arrayContaining(['TRADING_SUBJECT_CREATED', 'TRADING_SUBJECT_SELECTED']));
    await database.close();
  });

  it('lets a viewer open the workspace but rejects provider mutations and restores the relevant draft', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const ownerId = randomUUID(); const viewerId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'owner', '负责人', 'supplier'), ($2, 'viewer', '观察员', 'member')`, [ownerId, viewerId],
    );
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'organization', '组织 A', $2)`, [subjectId, ownerId]);
    await database.query(
      `INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
      [subjectId, ownerId, viewerId],
    );
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [viewerId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '组织 A', '91310101MA1ABCDEFB', '负责人', 'approved')`, [supplierId, ownerId, subjectId],
    );
    const resourceId = randomUUID();
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 8, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    const offerId = randomUUID();
    await database.query(
      `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title, service_mode,
        native_unit, minimum_quantity, suggested_price_cny_micros, status)
       VALUES ($1, $2, $3, 'viewer-resume-offer01', 'digest', 'H100 草稿', 'dedicated', 'GPU时', 1, 31200000, 'draft')`,
      [offerId, supplierId, resourceId],
    );
    const accounts = { recordAudit: async () => undefined } as unknown as AccountStore;
    const service = new SubjectService(new PostgresSubjectStore(database), accounts, config);
    const viewer: AccountPrincipal = { userId: viewerId, sessionId: 'viewer-session', role: 'member' };
    const workspace = await service.providerBootstrap(viewer);
    expect(workspace).toMatchObject({
      canManage: false,
      resourceActions: [],
      resume: { id: offerId, status: 'draft' },
      nextAction: { key: 'view_workspace' },
    });
    await expect(service.current(viewerId, 'provider.offer.manage')).rejects.toBeInstanceOf(AppError);
    await database.close();
  });

  it('separates resources awaiting materials from resources actually under review', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID();
    const collectingId = randomUUID(); const reviewingId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'resource-progress', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [userId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '资源方', '91310101MA1ABCDEFC', '负责人', 'approved')`, [supplierId, userId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $3, 'gpu', 'L40S-COLLECTING', '上海', '{}', 8, 'GPU时', 'pending_verification'),
              ($2, $3, 'gpu', 'L40S-REVIEWING', '上海', '{}', 8, 'GPU时', 'pending_verification')`,
      [collectingId, reviewingId, supplierId],
    );
    await database.query(
      `INSERT INTO resource_verification_runs(id, resource_id, requested_by, status)
       VALUES ($1, $3, $5, 'pending'), ($2, $4, $5, 'running')`,
      [randomUUID(), randomUUID(), collectingId, reviewingId, userId],
    );
    const service = new SubjectService(
      new PostgresSubjectStore(database), { recordAudit: async () => undefined } as unknown as AccountStore, config,
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      resources: { awaitingMaterials: 1, underReview: 1, verified: 0 },
      nextAction: { key: 'prepare_resource_evidence', label: '继续准备审核材料', route: 'provider_resources', entityId: collectingId },
    });
    await database.query(`UPDATE resource_verification_runs SET status = 'running' WHERE resource_id = $1`, [collectingId]);
    const reviewingWorkspace = await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' });
    expect(reviewingWorkspace).toMatchObject({
      resources: { awaitingMaterials: 0, underReview: 2 },
      nextAction: { key: 'track_resource_audit', label: '查看资源验真进度', route: 'provider_resources' },
    });
    expect([collectingId, reviewingId]).toContain(reviewingWorkspace.nextAction.entityId);
    await database.close();
  });

  it('offers a plan only after a verified resource has a ready delivery node', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID(); const resourceId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'resource-readiness', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [userId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '资源方', '91310101MA1READYNOD', '负责人', 'approved')`, [supplierId, userId, subjectId],
    );
    const verificationDigest = `sha256:${'a'.repeat(64)}`;
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total,
         capacity_unit, status, verification_digest, verified_at)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 8, 'GPU时', 'verified', $3, now())`,
      [resourceId, supplierId, verificationDigest],
    );
    const service = new SubjectService(
      new PostgresSubjectStore(database), { recordAudit: async () => undefined } as unknown as AccountStore, config,
    );
    const principal: AccountPrincipal = { userId, sessionId: 'supplier-session', role: 'supplier' };

    const unbound = await service.providerBootstrap(principal);
    expect(unbound).toMatchObject({
      nextAction: { key: 'connect_resource_node', label: '接入执行节点', route: 'provider_resources', entityId: resourceId },
      resourceActions: [{ resourceId, key: 'connect_resource_node', route: 'provider_resources', entityId: resourceId }],
    });
    expect(unbound.resourceActions.some((action) => action.key === 'create_offer')).toBe(false);

    const nodeId = randomUUID();
    const inventoryDigest = `sha256:${'b'.repeat(64)}`;
    const policyDigest = `sha256:${'c'.repeat(64)}`;
    await database.query(
      `INSERT INTO compute_nodes(id, supplier_id, node_public_key, node_key_fingerprint, inventory_digest, status)
       VALUES ($1, $2, $3, $4, $5, 'checking')`,
      [nodeId, supplierId, `ed25519:${'A'.repeat(44)}`, `sha256:${'d'.repeat(64)}`, inventoryDigest],
    );
    await database.query(
      `INSERT INTO compute_resource_bindings(id, resource_id, node_id, status, resource_verification_digest,
         policy_digest, attested_policy_digest, inventory_digest, gpu_set_digest)
       VALUES ($1, $2, $3, 'checking', $4, $5, $5, $6, $7)`,
      [randomUUID(), resourceId, nodeId, verificationDigest, policyDigest, inventoryDigest, `sha256:${'e'.repeat(64)}`],
    );
    expect(await service.providerBootstrap(principal)).toMatchObject({
      nextAction: { key: 'track_node_readiness', label: '查看节点接入进度', route: 'provider_resources', entityId: resourceId },
    });

    await database.query(
      `UPDATE compute_nodes SET status = 'ready', last_heartbeat_at = now(), heartbeat_boot_id = $2,
         heartbeat_sequence = 1, heartbeat_payload_digest = $3, heartbeat_signature = $4 WHERE id = $1`,
      [nodeId, randomUUID(), `sha256:${'f'.repeat(64)}`, `ed25519:${'B'.repeat(88)}`],
    );
    await database.query(`UPDATE compute_resource_bindings SET status = 'ready', confirmed_at = now() WHERE resource_id = $1`, [resourceId]);
    const ready = await service.providerBootstrap(principal);
    expect(ready).toMatchObject({
      nextAction: { key: 'create_offer', label: '创建上架方案', route: 'provider_offer_create', entityId: resourceId },
      resourceActions: [{ resourceId, key: 'create_offer', entityId: resourceId }],
    });

    await database.query(`UPDATE compute_nodes SET status = 'offline' WHERE id = $1`, [nodeId]);
    await database.query(`UPDATE compute_resource_bindings SET status = 'offline' WHERE resource_id = $1`, [resourceId]);
    const offline = await service.providerBootstrap(principal);
    expect(offline).toMatchObject({
      nextAction: { key: 'restore_resource_node', label: '恢复节点连接', route: 'provider_resources', entityId: resourceId },
      resourceActions: [{ resourceId, key: 'restore_resource_node', route: 'provider_resources', entityId: resourceId }],
    });
    expect(offline.resourceActions.some((action) => action.key === 'create_offer')).toBe(false);
    await database.close();
  });

  it('synchronizes expired audits before showing the provider workspace', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID(); const resourceId = randomUUID(); const offerId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'supplier', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [userId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '资源方', '91310101MA1ABCDEF9', '负责人', 'approved')`, [supplierId, userId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 8, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title, service_mode,
        native_unit, minimum_quantity, suggested_price_cny_micros, status, approved_reference_cny_micros,
        approved_unit_credit_micros, conversion_cny_micros_per_credit, audit_valid_until, approved_at)
       VALUES ($1, $2, $3, 'workspace-expiry-00001', 'digest', 'H100 独享', 'dedicated', 'GPU时', 1, 31200000,
        'approved', 31200000, 31140000, 1002000, now() - interval '1 minute', now() - interval '1 day')`,
      [offerId, supplierId, resourceId],
    );
    const accounts = { recordAudit: async () => undefined } as unknown as AccountStore;
    const service = new SubjectService(
      new PostgresSubjectStore(database), accounts, config, new PostgresListingAuditStore(database),
    );
    const workspace = await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' });
    expect(workspace).toMatchObject({
      offers: { approved: 0, expired: 1 },
      listings: { selling: 0, scheduled: 0, scheduledPaused: 0, paused: 0, soldOut: 0 },
      resume: { id: offerId, status: 'expired' },
      nextAction: { key: 'reaudit_expired_offer', label: '重新提交双审', entityId: offerId },
      resourceActions: [{ resourceId, key: 'reaudit_expired_offer', label: '重新提交双审', entityId: offerId }],
    });
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text FROM notifications WHERE user_id = $1 AND title = '审核已到期，请重新提交'`, [userId],
    )).rows[0]?.count).toBe('1');
    await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' });
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text FROM notifications WHERE user_id = $1 AND title = '审核已到期，请重新提交'`, [userId],
    )).rows[0]?.count).toBe('1');
    await database.close();
  });

  it('opens the latest manageable listing directly from the provider workspace', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const offerId = randomUUID(); const resourceAuditId = randomUUID();
    const priceAuditId = randomUUID(); const listingId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'supplier-listing', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [userId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '资源方', '91310101MA1ABCDEF8', '负责人', 'approved')`, [supplierId, userId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 8, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title, service_mode,
        native_unit, minimum_quantity, suggested_price_cny_micros, status, submission_version, approved_reference_cny_micros,
        approved_unit_credit_micros, conversion_cny_micros_per_credit, audit_valid_until, submitted_at, approved_at)
       VALUES ($1, $2, $3, 'workspace-listing-0001', 'digest', 'H100 独享', 'dedicated', 'GPU时', 1, 31200000,
        'approved', 1, 31200000, 31140000, 1002000, now() + interval '30 days', now(), now())`,
      [offerId, supplierId, resourceId],
    );
    await database.query(
      `INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status, reviewer_id, decision_reason,
        evidence_summary, evidence_digest, valid_until, decided_at, approved_reference_cny_micros,
        conversion_cny_micros_per_credit, approved_unit_credit_micros)
       VALUES
        ($1, $3, 1, 'resource', 'approved', $4, '材料完整', '资源验真通过', 'resource-digest', now() + interval '30 days', now(), NULL, NULL, NULL),
        ($2, $3, 1, 'price', 'approved', $4, '价格合理', '价格审核通过', 'price-digest', now() + interval '30 days', now(), 31200000, 1002000, 31140000)`,
      [resourceAuditId, priceAuditId, offerId, userId],
    );
    const service = new SubjectService(
      new PostgresSubjectStore(database), { recordAudit: async () => undefined } as unknown as AccountStore, config,
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      resourceActions: [{
        resourceId, key: 'publish_approved_offer', label: '发布可售容量',
        route: 'provider_listing_editor', entityId: offerId, target: 'offer_listing',
      }],
    });
    await database.query(
      `INSERT INTO credit_market_listings(id, offer_id, resource_id, supplier_id, client_request_id, payload_digest,
        resource_audit_id, price_audit_id, capacity_total, capacity_unit, minimum_quantity, unit_credit_micros,
        reference_cny_micros, conversion_cny_micros_per_credit, status, starts_at, expires_at, audit_snapshot, published_by)
       VALUES ($1, $2, $3, $4, 'workspace-listing-publish-01', 'listing-digest', $5, $6, 8, 'GPU时', 1,
        31140000, 31200000, 1002000, 'active', now(), now() + interval '7 days', '{}', $7)`,
      [listingId, offerId, resourceId, supplierId, resourceAuditId, priceAuditId, userId],
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      listings: { selling: 1, scheduled: 0, scheduledPaused: 0, paused: 0, soldOut: 0 },
      nextAction: { key: 'manage_supply', label: '管理在售资源', route: 'provider_listing_manager', entityId: listingId },
      resourceActions: [{
        resourceId, key: 'manage_listing', label: '管理销售中挂牌',
        route: 'provider_listing_manager', entityId: listingId, target: 'listing',
      }],
    });
    const unusedOfferId = randomUUID();
    await database.query(
      `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title, service_mode,
        native_unit, minimum_quantity, suggested_price_cny_micros, status, submission_version,
        approved_reference_cny_micros, approved_unit_credit_micros, conversion_cny_micros_per_credit,
        audit_valid_until, submitted_at, approved_at)
       VALUES ($1, $2, $3, 'workspace-unused-offer1', 'unused-digest', 'H100 夜间', 'dedicated', 'GPU时', 1,
        28000000, 'approved', 1, 28000000, 27944112, 1002000, now() + interval '30 days', now(), now())`,
      [unusedOfferId, supplierId, resourceId],
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      nextAction: { key: 'publish_capacity', label: '发布可售容量', route: 'provider_listing_editor', entityId: unusedOfferId },
      resourceActions: [{
        resourceId, key: 'publish_approved_offer', label: '发布可售容量',
        route: 'provider_listing_editor', entityId: unusedOfferId, target: 'offer_listing',
      }],
    });
    await database.query(`UPDATE offer_templates SET status = 'suspended' WHERE id = $1`, [unusedOfferId]);
    await database.query(
      `UPDATE credit_market_listings SET starts_at = now() + interval '1 day', expires_at = now() + interval '8 days' WHERE id = $1`,
      [listingId],
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      listings: { selling: 0, scheduled: 1, scheduledPaused: 0, paused: 0, soldOut: 0 },
      nextAction: { key: 'manage_scheduled_supply', label: '查看待生效挂牌', entityId: listingId },
    });
    await database.query(`UPDATE credit_market_listings SET status = 'paused' WHERE id = $1`, [listingId]);
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      listings: { selling: 0, scheduled: 0, scheduledPaused: 1, paused: 0, soldOut: 0 },
      nextAction: { key: 'manage_scheduled_supply', label: '查看待生效挂牌', entityId: listingId },
    });
    await database.close();
  });

  it('sends a rejected offer back to its original editor', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const offerId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'supplier', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)`, [userId, subjectId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '资源方', '91310101MA1ABCDEFA', '负责人', 'approved')`, [supplierId, userId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 8, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title, service_mode,
        native_unit, minimum_quantity, suggested_price_cny_micros, status, submission_version)
       VALUES ($1, $2, $3, 'workspace-rejected-001', 'digest', 'H100 独享', 'dedicated', 'GPU时', 1, 31200000, 'rejected', 1)`,
      [offerId, supplierId, resourceId],
    );
    const service = new SubjectService(
      new PostgresSubjectStore(database), { recordAudit: async () => undefined } as unknown as AccountStore, config,
    );
    expect(await service.providerBootstrap({ userId, sessionId: 'supplier-session', role: 'supplier' })).toMatchObject({
      offers: { rejected: 1 }, resume: { id: offerId, status: 'rejected' },
      nextAction: { key: 'revise_rejected_offer', route: 'provider_offer_editor', entityId: offerId },
      resourceActions: [{
        resourceId, key: 'resolve_offer_review', label: '修改后重新送审',
        route: 'provider_offer_editor', entityId: offerId, target: 'offer_revision',
      }],
    });
    await database.close();
  });
});
