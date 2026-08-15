import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { MalwareScanner } from '../src/evidence/scanner.js';
import { EvidenceScanWorker } from '../src/evidence/worker.js';
import { PostgresMarketStore } from '../src/market/store.js';
import { ResourceEvidenceScanStore } from '../src/resource-evidence/scan-store.js';
import { ResourceEvidenceService } from '../src/resource-evidence/service.js';
import { ResourceEvidenceStore } from '../src/resource-evidence/store.js';
import type { PrivateObjectStore, StoredObjectMetadata } from '../src/storage/object-store.js';
import type { SubjectAccess, SubjectContext, SubjectPermission } from '../src/subjects/types.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    query: async (text: string, values?: unknown[]) => result(await pglite.query(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

class FakeObjects implements PrivateObjectStore {
  grants: string[] = [];
  deleted: string[] = [];
  bytes = new Map<string, Uint8Array>();
  metadata = new Map<string, StoredObjectMetadata>();

  async createUploadGrant(input: { objectKey: string; expiresAt: Date }) {
    this.grants.push(input.objectKey);
    return { url: `https://storage.test/${input.objectKey}`, method: 'PUT' as const, expiresAt: input.expiresAt, headers: {} };
  }
  async head(objectKey: string) {
    const found = this.metadata.get(objectKey);
    if (!found) throw new Error('missing object');
    return found;
  }
  async createDownloadUrl(objectKey: string) { return `https://storage.test/download/${objectKey}`; }
  async readBytes(objectKey: string) {
    const found = this.bytes.get(objectKey);
    if (!found) throw new Error('missing object');
    return found;
  }
  async delete(objectKey: string) { this.deleted.push(objectKey); }

  register(objectKey: string, bytes: Uint8Array, mimeType: string) {
    const hex = createHash('sha256').update(bytes).digest('hex');
    this.bytes.set(objectKey, bytes);
    this.metadata.set(objectKey, {
      sizeBytes: bytes.byteLength, mimeType, metadataSha256: hex,
      sha256Base64: Buffer.from(hex, 'hex').toString('base64'),
    });
    return `sha256:${hex}`;
  }
}

class FakeSubjects implements SubjectAccess {
  constructor(private readonly subjects: Map<string, string>) {}
  async current(userId: string, permission: SubjectPermission): Promise<SubjectContext> {
    const subjectId = this.subjects.get(userId);
    if (!subjectId) throw new Error('subject missing');
    return {
      subjectId, userId, kind: 'personal', displayName: '资源方', subjectStatus: 'active', role: 'owner',
      permissions: ['subject.manage', 'provider.read', 'provider.profile.manage', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage'],
    };
  }
}

async function migrate(pglite: PGlite) {
  for (const name of [
    '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
    '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
    '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
    '0010_payment_recovery.sql', '0011_backup_audit.sql', '0012_mobile_publish.sql',
    '0013_push_delivery.sql', '0014_account_deletion_automation.sql', '0015_credit_listing_audits.sql',
    '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql', '0018_resource_identity.sql',
    '0019_resource_resubmissions.sql', '0020_resource_verification_evidence.sql',
    '0039_compute_node_readiness.sql', '0041_compute_assets.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
}

describe('resource verification materials', () => {
  it('keeps materials private, scans every file, blocks incomplete review, and snapshots a complete submission', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = adapter(pglite);
    const supplierUserId = randomUUID(); const outsiderId = randomUUID(); const operatorId = randomUUID();
    const subjectId = randomUUID(); const outsiderSubjectId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const runId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'material-supplier', '资源方', 'supplier'), ($2, 'material-outsider', '其他资源方', 'supplier'),
       ($3, 'material-operator', '运营', 'operator')`, [supplierUserId, outsiderId, operatorId],
    );
    await database.query(
      `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
       ($1, 'personal', '资源方', $2), ($3, 'personal', '其他资源方', $4)`,
      [subjectId, supplierUserId, outsiderSubjectId, outsiderId],
    );
    await database.query(
      `INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [subjectId, supplierUserId, outsiderSubjectId, outsiderId],
    );
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '凯云资源有限公司', '91310101MA1MATERIAL', '凯', 'approved')`,
      [supplierId, supplierUserId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_assets(id,supplier_id,management_mode,lifecycle_status,asset_identity_kind,asset_fingerprint)
       VALUES ($1,$2,'self_managed','registered','legacy_resource_id',$3)`,
      [resourceId, supplierId, `legacy-resource:${resourceId}`],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, asset_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, $1, 'gpu', 'H100-80G', '上海', '{}', 16, 'GPU时', 'pending_verification')`,
      [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO resource_verification_runs(id, resource_id, requested_by, status) VALUES ($1, $2, $3, 'pending')`,
      [runId, resourceId, supplierUserId],
    );

    const objects = new FakeObjects();
    const audits: string[] = [];
    const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const subjects = new FakeSubjects(new Map([[supplierUserId, subjectId], [outsiderId, outsiderSubjectId]]));
    const config = loadConfig({
      NODE_ENV: 'test', ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32),
      OTP_PEPPER: 'c'.repeat(32), AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const service = new ResourceEvidenceService(
      new ResourceEvidenceStore(database), accounts, subjects, objects, config, () => new Date('2026-08-12T05:00:00.000Z'),
    );
    const supplier: AccountPrincipal = { userId: supplierUserId, sessionId: randomUUID(), role: 'supplier' };
    const outsider: AccountPrincipal = { userId: outsiderId, sessionId: randomUUID(), role: 'supplier' };
    const operator: AccountPrincipal = { userId: operatorId, sessionId: randomUUID(), role: 'operator' };
    const context = { requestId: 'resource-material-test', ip: '203.0.113.50' };

    await expect(service.checklist(outsider, resourceId)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(service.createUpload(outsider, {
      resourceId, category: 'ownership', fileName: 'outsider.pdf', mimeType: 'application/pdf', sizeBytes: 12,
      sha256Digest: `sha256:${'e'.repeat(64)}`, clientRequestId: 'resource-outsider-00001',
    }, context)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(service.submit(supplier, resourceId, 'resource-submit-000001', context))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INCOMPLETE' });
    expect(await new PostgresMarketStore(database).completeResourceVerification({
      resourceId, reviewerId: operatorId, passed: true, evidenceDigest: `sha256:${'a'.repeat(64)}`, checks: {},
    })).toBeNull();

    for (const [index, category] of ['ownership', 'configuration', 'availability'].entries()) {
      const bytes = Buffer.from(`%PDF-1.7\nresource material ${category}`);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const upload = await service.createUpload(supplier, {
        resourceId, category: category as 'ownership' | 'configuration' | 'availability',
        fileName: `${category}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.byteLength,
        sha256Digest: digest, clientRequestId: `resource-upload-${String(index + 1).padStart(8, '0')}`,
      }, context);
      const replay = await service.createUpload(supplier, {
        resourceId, category: category as 'ownership' | 'configuration' | 'availability',
        fileName: `${category}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.byteLength,
        sha256Digest: digest, clientRequestId: `resource-upload-${String(index + 1).padStart(8, '0')}`,
      }, context);
      expect(replay).toMatchObject({ replayed: true, evidence: { id: upload.evidence.id } });
      await expect(service.renewUpload(supplier, resourceId, upload.evidence.id, `sha256:${'0'.repeat(64)}`))
        .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_FILE_CHANGED' });
      await expect(service.renewUpload(supplier, resourceId, upload.evidence.id, digest))
        .resolves.toMatchObject({ method: 'PUT' });
      const objectKey = objects.grants.at(-1)!;
      objects.register(objectKey, bytes, 'application/pdf');
      if (index === 0) {
        const correct = objects.metadata.get(objectKey)!;
        objects.metadata.set(objectKey, { ...correct, sizeBytes: correct.sizeBytes + 1 });
        await expect(service.completeUpload(supplier, resourceId, upload.evidence.id, context))
          .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_OBJECT_MISMATCH' });
        objects.metadata.set(objectKey, correct);
      }
      await service.completeUpload(supplier, resourceId, upload.evidence.id, context);
    }

    const scanner: MalwareScanner = { scan: async () => ({ clean: true, signature: null }) };
    const worker = new EvidenceScanWorker(
      new ResourceEvidenceScanStore(database), objects, scanner, { info: () => undefined, error: () => undefined },
      60_000, () => new Date('2099-01-01T00:00:00.000Z'),
    );
    await worker.tick();
    expect((await database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND title = '资源材料检查完成' LIMIT 1`,
      [supplierUserId],
    )).rows[0]?.data).toMatchObject({ route: 'provider_resource', subjectId, resourceId });
    const checklist = await service.checklist(supplier, resourceId);
    expect(checklist).toMatchObject({
      review: { status: 'collecting' }, readyToSubmit: true,
      categories: { ownership: { state: 'ready' }, configuration: { state: 'ready' }, availability: { state: 'ready' } },
    });
    const submitted = await service.submit(supplier, resourceId, 'resource-submit-000002', context);
    expect(submitted).toMatchObject({ replayed: false, runId });
    expect((await database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND title = '资源材料已送审' LIMIT 1`,
      [supplierUserId],
    )).rows[0]?.data).toMatchObject({ route: 'provider_resource', subjectId, resourceId });
    expect(await service.submit(supplier, resourceId, 'resource-submit-000002', context))
      .toMatchObject({ replayed: true, runId });
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM resource_verification_material_submissions WHERE verification_run_id = $1`, [runId],
    )).rows[0]?.count).toBe('1');
    expect(await service.checklist(supplier, resourceId)).toMatchObject({
      review: { status: 'under_review', correctionNote: null }, readyToSubmit: false,
    });
    await expect(service.operatorBundle(supplier, resourceId)).rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });
    const reviewBundle = await service.operatorBundle(operator, resourceId);
    expect(reviewBundle).toMatchObject({ verificationRunId: runId, status: 'running' });
    expect(reviewBundle.materials).toHaveLength(3);
    expect(reviewBundle.materials[0]).not.toHaveProperty('objectKey');
    expect(reviewBundle.materials[0]).not.toHaveProperty('sha256Digest');
    const download = await service.operatorDownload(operator, resourceId, reviewBundle.materials[0]!.id, context);
    expect(download.url).toContain('/download/quarantine/resources/');
    await expect(service.createUpload(supplier, {
      resourceId, category: 'ownership', fileName: 'late.pdf', mimeType: 'application/pdf', sizeBytes: 12,
      sha256Digest: `sha256:${'f'.repeat(64)}`, clientRequestId: 'resource-upload-late001',
    }, context)).rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_STATE_INVALID' });
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM resource_verification_material_items WHERE submission_id = (
         SELECT id FROM resource_verification_material_submissions WHERE verification_run_id = $1
       )`, [runId],
    )).rows[0]?.count).toBe('3');
    await expect(database.query(
      `UPDATE resource_verification_material_submissions SET payload_digest = 'changed' WHERE verification_run_id = $1`, [runId],
    )).rejects.toThrow();
    const verified = await new PostgresMarketStore(database).completeResourceVerification({
      resourceId, reviewerId: operatorId, passed: true,
      evidenceDigest: `sha256:${'a'.repeat(64)}`, checks: { ownership: true, configuration: true, availability: true },
    });
    expect(verified?.status).toBe('verified');
    expect((await database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND title = '资源验真已通过' LIMIT 1`,
      [supplierUserId],
    )).rows[0]?.data).toMatchObject({ route: 'provider_resource', subjectId, resourceId });
    expect(audits.filter((action) => action === 'RESOURCE_EVIDENCE_SUBMITTED')).toHaveLength(1);
    expect(audits.filter((action) => action === 'RESOURCE_EVIDENCE_VIEWED')).toHaveLength(1);
    await database.close();
  });

  it('requires only the material rejected by review to be replaced before resubmission', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = adapter(pglite);
    const supplierUserId = randomUUID(); const operatorId = randomUUID(); const subjectId = randomUUID();
    const supplierId = randomUUID(); const resourceId = randomUUID(); const firstRunId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'replacement-supplier', '资源方', 'supplier'), ($2, 'replacement-operator', '运营', 'operator')`,
      [supplierUserId, operatorId],
    );
    await database.query(
      `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`,
      [subjectId, supplierUserId],
    );
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, supplierUserId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $3, '凯云资源有限公司', '91310101MA1REPLACE', '凯', 'approved')`,
      [supplierId, supplierUserId, subjectId],
    );
    await database.query(
      `INSERT INTO compute_assets(id,supplier_id,management_mode,lifecycle_status,asset_identity_kind,asset_fingerprint)
       VALUES ($1,$2,'self_managed','registered','legacy_resource_id',$3)`,
      [resourceId, supplierId, `legacy-resource:${resourceId}`],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, asset_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, $1, 'gpu', 'H100-80G', '上海', '{}', 16, 'GPU时', 'pending_verification')`,
      [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO resource_verification_runs(id, resource_id, requested_by, status, materials_submitted_at)
       VALUES ($1, $2, $3, 'running', now())`, [firstRunId, resourceId, supplierUserId],
    );
    const evidenceIds: Record<string, string> = {};
    for (const [index, category] of ['ownership', 'configuration', 'availability'].entries()) {
      const id = randomUUID(); evidenceIds[category] = id;
      await database.query(
        `INSERT INTO resource_verification_evidence(id, resource_id, supplier_id, submitted_by, category, object_key,
          file_name, mime_type, size_bytes, sha256_digest, status, client_request_id, payload_digest, retention_until, uploaded_at, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', 12, $8, 'verified', $9, $10, now() + interval '1 year', now(), now())`,
        [id, resourceId, supplierId, supplierUserId, category, `quarantine/replacement/${id}.pdf`, `${category}.pdf`,
          `sha256:${String(index + 1).repeat(64)}`, `replacement-upload-${String(index).padStart(8, '0')}`, `payload-${category}`],
      );
    }
    const market = new PostgresMarketStore(database);
    await market.completeResourceVerification({
      resourceId, reviewerId: operatorId, passed: false, evidenceDigest: `sha256:${'f'.repeat(64)}`,
      checks: { ownership: true, configuration: false, availability: true },
      failureReason: '配置截图缺少设备序列号，请更换配置材料后重新提交。',
    });
    expect((await database.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [supplierUserId],
    )).rows[0]).toEqual({
      title: '资源审核需要补充',
      body: '审核意见：配置截图缺少设备序列号，请更换配置材料后重新提交。',
    });
    await market.resubmitResourceVerification({
      id: randomUUID(), resourceId, subjectId, requestedByUserId: supplierUserId,
      clientRequestId: 'replacement-resubmit-0001',
    });
    expect((await market.listSupplierResources(subjectId)).find((item) => item.id === resourceId)?.verification).toMatchObject({
      status: 'pending', failureReason: '配置截图缺少设备序列号，请更换配置材料后重新提交。',
    });
    const store = new ResourceEvidenceStore(database);
    expect(await store.checklist(subjectId, resourceId)).toMatchObject({
      review: { status: 'collecting', correctionNote: '配置截图缺少设备序列号，请更换配置材料后重新提交。' },
      readyToSubmit: false,
      categories: {
        ownership: { state: 'ready', reviewDecision: 'accepted' },
        configuration: { state: 'needs_replacement', reviewDecision: 'replace' },
        availability: { state: 'ready', reviewDecision: 'accepted' },
      },
    });
    const pendingRun = (await database.query<{ id: string; requested_at: Date }>(
      `SELECT id, requested_at FROM resource_verification_runs WHERE resource_id = $1 AND status = 'pending'`, [resourceId],
    )).rows[0]!;
    await expect(store.submit({
      id: randomUUID(), subjectId, userId: supplierUserId, resourceId,
      clientRequestId: 'replacement-submit-blocked1', payloadDigest: 'replacement-submit-blocked', now: new Date(),
    })).resolves.toEqual({ status: 'materials_incomplete' });
    const replacementId = randomUUID();
    await database.query(
      `INSERT INTO resource_verification_evidence(id, resource_id, supplier_id, submitted_by, category, object_key,
        file_name, mime_type, size_bytes, sha256_digest, status, client_request_id, payload_digest, retention_until, created_at, uploaded_at, verified_at)
       VALUES ($1, $2, $3, $4, 'configuration', $5, 'configuration-fixed.pdf', 'application/pdf', 12, $6,
        'verified', 'replacement-upload-fixed01', 'replacement-payload-fixed', now() + interval '1 year', $7::timestamptz + interval '1 second', now(), now())`,
      [replacementId, resourceId, supplierId, supplierUserId, `quarantine/replacement/${replacementId}.pdf`,
        `sha256:${'a'.repeat(64)}`, pendingRun.requested_at],
    );
    expect(await store.checklist(subjectId, resourceId)).toMatchObject({
      readyToSubmit: true,
      categories: {
        ownership: { state: 'ready', reviewDecision: 'accepted', evidence: { id: evidenceIds.ownership } },
        configuration: { state: 'ready', reviewDecision: 'replace', evidence: { id: replacementId } },
        availability: { state: 'ready', reviewDecision: 'accepted', evidence: { id: evidenceIds.availability } },
      },
    });
    expect(await store.submit({
      id: randomUUID(), subjectId, userId: supplierUserId, resourceId,
      clientRequestId: 'replacement-submit-ready001', payloadDigest: 'replacement-submit-ready', now: new Date(),
    })).toMatchObject({ status: 'created', runId: pendingRun.id });
    expect(await store.checklist(subjectId, resourceId)).toMatchObject({
      review: { status: 'under_review' },
      categories: {
        ownership: { state: 'ready', reviewDecision: 'accepted' },
        configuration: { state: 'ready', reviewDecision: 'replace', evidence: { id: replacementId } },
        availability: { state: 'ready', reviewDecision: 'accepted' },
      },
    });
    const submittedItems = await database.query<{ category: string; evidence_id: string }>(
      `SELECT i.category, i.evidence_id FROM resource_verification_material_items i
       JOIN resource_verification_material_submissions s ON s.id = i.submission_id
       WHERE s.verification_run_id = $1 ORDER BY i.category`, [pendingRun.id],
    );
    expect(submittedItems.rows).toEqual([
      { category: 'availability', evidence_id: evidenceIds.availability },
      { category: 'configuration', evidence_id: replacementId },
      { category: 'ownership', evidence_id: evidenceIds.ownership },
    ]);
    await database.close();
  });
});
