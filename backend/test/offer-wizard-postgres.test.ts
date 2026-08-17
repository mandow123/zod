import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresListingAuditStore } from '../src/listings/store.js';
import { cnyMicrosFromCreditMicros, creditMicrosFromCnyMicros, parseCreditMicros } from '../src/listings/types.js';

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
  for (const name of [
    '0001_cloudpay_ledger.sql', '0003_market_reservations.sql', '0012_mobile_publish.sql',
    '0015_credit_listing_audits.sql', '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql',
    '0021_offer_revision_drafts.sql', '0035_offer_wizard_draft_abandonment.sql', '0054_offer_card_hour_price.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
}

describe('mobile offer wizard drafts', () => {
  it('resumes safely, rejects stale saves, and submits one offer with both audits atomically', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const store = new PostgresListingAuditStore(database);
    const userId = randomUUID(); const subjectId = randomUUID(); const resourceId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 'wizard-user', '资源方', 'supplier')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '资源方', $2)`, [subjectId, userId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $1, '凯云资源方', '91310101MA1ABCDEF0', '凯', 'approved')`, [subjectId, userId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100-SXM-80G', '华东-上海', '{}', 100, 'GPU时', 'verified')`, [resourceId, subjectId],
    );

    const createInput = {
      id: randomUUID(), subjectId, userId, resourceId, clientRequestId: 'wizard-create-0000001', payloadDigest: 'resource-digest',
    };
    const created = await store.createWizardDraft(createInput);
    expect(created?.status).toBe('created');
    if (!created || (created.status !== 'created' && created.status !== 'replayed')) throw new Error('draft was not created');
    expect((await store.createWizardDraft({ ...createInput, id: randomUUID() }))?.status).toBe('replayed');
    const repeatedResource = await store.createWizardDraft({
      ...createInput, id: randomUUID(), clientRequestId: 'wizard-create-0000002', payloadDigest: 'same-resource-new-action',
    });
    expect(repeatedResource?.status).toBe('replayed');
    if (!repeatedResource || (repeatedResource.status !== 'created' && repeatedResource.status !== 'replayed')) throw new Error('active draft was not reused');
    expect(repeatedResource.draft.id).toBe(created.draft.id);
    const payload = {
      title: 'H100 80G 独享算力', serviceMode: 'dedicated' as const, nativeUnit: 'GPU时', minimumQuantity: '1',
      sla: { availability: '99.9%' }, deliveryTerms: { mode: '平台工作区' }, acceptanceTerms: { criteria: '配置与时长' },
      refundTerms: { policy: '故障按分钟退还卡时' }, cleanupTerms: { policy: '任务结束即清理' },
      suggestedUnitCredits: '31.14', priceComponents: { summary: '设备、电力、网络与运维' },
      priceEvidence: [{ type: 'contract', source: '近三个月合同', summary: '同型号同地区已成交合同' }],
    };
    const saved = await store.updateWizardDraft({
      subjectId, draftId: created.draft.id, expectedVersion: 1, currentStep: 'review', payload,
    });
    expect(saved?.version).toBe(2);
    expect(await store.updateWizardDraft({
      subjectId, draftId: created.draft.id, expectedVersion: 1, currentStep: 'price', payload,
    })).toBeNull();
    expect((await store.listWizardDrafts(subjectId))[0]?.payload.title).toBe('H100 80G 独享算力');

    const submit = {
      subjectId, userId, draftId: created.draft.id, expectedVersion: 2, submitRequestId: 'wizard-submit-0000001',
      submitPayloadDigest: 'formal-digest', resourceId, title: payload.title, serviceMode: payload.serviceMode,
      nativeUnit: payload.nativeUnit, minimumQuantity: payload.minimumQuantity, sla: payload.sla,
      deliveryTerms: payload.deliveryTerms, acceptanceTerms: payload.acceptanceTerms, refundTerms: payload.refundTerms,
      cleanupTerms: payload.cleanupTerms,
      suggestedUnitCreditMicros: parseCreditMicros(payload.suggestedUnitCredits)!,
      suggestedPriceCnyMicros: cnyMicrosFromCreditMicros(parseCreditMicros(payload.suggestedUnitCredits)!),
      priceComponents: payload.priceComponents, priceEvidence: payload.priceEvidence,
    };
    const submitted = await store.submitWizardDraft(submit);
    expect(submitted.status).toBe('created');
    if (!('offer' in submitted)) throw new Error('draft was not submitted');
    expect(submitted.offer.status).toBe('under_review');
    expect(submitted.audits.map((item) => item.kind).sort()).toEqual(['price', 'resource']);
    expect(submitted.offer.suggestedUnitCreditMicros).toBe(31_140_000n);
    expect((await store.submitWizardDraft(submit)).status).toBe('replayed');
    const submittedDraft = await store.getWizardDraft(subjectId, created.draft.id);
    expect(submittedDraft?.status).toBe('submitted');
    expect(submittedDraft?.convertedOfferId).toBe(submitted.offer.id);
    expect(await store.abandonWizardDraft({
      subjectId, userId, draftId: created.draft.id, expectedVersion: 3,
    })).toBe('conflict');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM offer_templates')).rows[0]?.count).toBe('1');
    expect(await store.updateWizardDraft({
      subjectId, draftId: created.draft.id, expectedVersion: 3, currentStep: 'review', payload,
    })).toBeNull();

    const disposable = await store.createWizardDraft({
      ...createInput, id: randomUUID(), clientRequestId: 'wizard-create-discard1', payloadDigest: 'disposable-resource-digest',
    });
    if (!disposable || (disposable.status !== 'created' && disposable.status !== 'replayed')) throw new Error('disposable draft was not created');
    expect(await store.abandonWizardDraft({
      subjectId, userId, draftId: disposable.draft.id, expectedVersion: disposable.draft.version + 1,
    })).toBe('conflict');
    expect(await store.abandonWizardDraft({
      subjectId, userId, draftId: disposable.draft.id, expectedVersion: disposable.draft.version,
    })).toBe('abandoned');
    expect(await store.abandonWizardDraft({
      subjectId, userId, draftId: disposable.draft.id, expectedVersion: disposable.draft.version,
    })).toBe('conflict');
    expect(await store.listWizardDrafts(subjectId)).toEqual([]);
    expect(await store.getWizardDraft(subjectId, disposable.draft.id)).toBeNull();
    expect((await database.query<{ status: string; abandoned: boolean }>(
      `SELECT status, abandoned_at IS NOT NULL AND abandoned_by = $2 AS abandoned
       FROM offer_wizard_drafts WHERE id = $1`, [disposable.draft.id, userId],
    )).rows[0]).toEqual({ status: 'abandoned', abandoned: true });
    await database.close();
  });

  it('parses card-hour decimals exactly at the public offer boundary', () => {
    expect(parseCreditMicros('31.14')).toBe(31_140_000n);
    expect(parseCreditMicros('0')).toBeNull();
    expect(parseCreditMicros('1.0000001')).toBeNull();
    expect(creditMicrosFromCnyMicros(cnyMicrosFromCreditMicros(31_140_000n))).toBe(31_140_000n);
  });
});
