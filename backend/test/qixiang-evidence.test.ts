import { randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { migrationManifest } from '../src/schema.js';
import { PostgresQixiangEvidenceStore, QixiangEvidenceService } from '../src/topups/qixiang-evidence.js';

function result<T>(value: Results<T>) { return { ...value, rowCount: value.rows.length || value.affectedRows || 0,
  command: '', oid: 0, rowAsArray: false }; }
function adapter(pglite: PGlite): Database { return { health: async () => true,
  schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
  query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => result(await pglite.query<Row>(text, values)),
  transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
    query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
  } as unknown as PoolClient)), close: () => pglite.close() } as unknown as Database; }

const evidenceReferences = {
  QIXIANG_KEY_ROTATION_EVIDENCE_REF: 'audit://qixiang/key-rotation',
  QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF: 'audit://qixiang/old-revocation',
  QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF: 'audit://qixiang/entity',
  QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF: 'audit://qixiang/domain',
  QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF: 'audit://qixiang/service',
  QIXIANG_REFUND_API_EVIDENCE_REF: 'audit://qixiang/refund',
  QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF: 'audit://qixiang/fulfillment',
  QIXIANG_RECONCILIATION_EVIDENCE_REF: 'audit://qixiang/reconcile',
  QIXIANG_APPROVED_MAX_EVIDENCE_REF: 'audit://qixiang/max',
  QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF: 'audit://qixiang/lot',
} as const;
function config(overrides: Record<string, string | undefined> = {}) { return loadConfig({ NODE_ENV: 'test',
  MOBILE_API_PROFILE: 'full_commerce', PUBLIC_ORIGIN: 'https://cloudpay.kai.com', QIXIANG_TOPUP_MODE: 'on', QIXIANG_PID: '4611',
  QIXIANG_APPROVED_MAX_CENTS: '4999999', QIXIANG_CHECKOUT_KEY_ID: 'qixiang-checkout-2026a',
  QIXIANG_CHECKOUT_CIPHER_VERSION: '1', QIXIANG_NOTIFY_URL: 'https://cloudpay.kai.com/mobile/v1/credits/topups/qixiang/notify',
  QIXIANG_RETURN_URL: 'https://cloudpay.kai.com/payments/qixiang/return', LEGAL_ENTITY_NAME: '上海申比芯人工智能科技有限公司',
  UNIFIED_SOCIAL_CREDIT_CODE: '91310112MAKJAYAJ7U', ...evidenceReferences, ...overrides }); }

async function fixture() {
  const pglite = new PGlite();
  for (const migration of await migrationManifest()) await pglite.exec(migration.sql);
  const database = adapter(pglite); const first = randomUUID(); const second = randomUUID();
  await database.query(`INSERT INTO users(id,email_ciphertext,display_name,role)VALUES
    ($1,'a','Evidence A','operator'),($2,'b','Evidence B','admin')`, [first, second]);
  const time = '2026-08-21T06:00:00.000Z'; const digest = 'a'.repeat(64);
  const values: Array<[string, string, Record<string, unknown>]> = [
    ['merchant_key_rotation',evidenceReferences.QIXIANG_KEY_ROTATION_EVIDENCE_REF,{merchantId:'4611',rotatedAt:time,
      credentialVersion:'v2',newKeyFingerprint:'1'.repeat(64),oldKeyFingerprint:'2'.repeat(64)}],
    ['old_key_revocation',evidenceReferences.QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF,{merchantId:'4611',revokedAt:time,
      providerCaseRef:'CASE-1',oldKeyFingerprint:digest}],
    ['merchant_entity_match',evidenceReferences.QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF,{merchantId:'4611',
      legalEntityName:'上海申比芯人工智能科技有限公司',unifiedSocialCreditCode:'91310112MAKJAYAJ7U',
      providerRegisteredName:'上海申比芯人工智能科技有限公司',verifiedAt:time}],
    ['domain_app_scene_approval',evidenceReferences.QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF,{merchantId:'4611',
      domain:'cloudpay.kai.com',appPackage:'com.kaicloud.marketplace',scene:'android_h5_alipay',providerCaseRef:'CASE-2',approvedAt:time}],
    ['service_category_approval',evidenceReferences.QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF,{merchantId:'4611',
      category:'compute_card_hours',entitlementDays:364,nonTransferable:true,nonCash:true,approvedAt:time}],
    ['refund_api_confirmation',evidenceReferences.QIXIANG_REFUND_API_EVIDENCE_REF,{merchantId:'4611',enabledAt:time,
      supportsOutTradeNo:true,successCodes:[0,1],confirmationRequired:true,providerCaseRef:'CASE-3'}],
    ['real_fulfillment_acceptance',evidenceReferences.QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF,{merchantId:'4611',
      fulfillmentType:'compute_card_hours',testedAt:time,acceptanceReportDigest:digest}],
    ['reconciliation_acceptance',evidenceReferences.QIXIANG_RECONCILIATION_EVIDENCE_REF,{merchantId:'4611',callback:true,
      activeQuery:true,lateSuccess:true,testedAt:time,reportDigest:digest}],
    ['approved_max_amount',evidenceReferences.QIXIANG_APPROVED_MAX_EVIDENCE_REF,{merchantId:'4611',currency:'CNY',
      minCents:100,maxCents:4_999_999,providerLimitRef:'CASE-4',approvedAt:time}],
    ['lot_accounting_acceptance',evidenceReferences.QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF,{schemaVersion:1,
      stores:['credit-orders','credits','device-commerce','fulfillment','topups-reversal','vast-market'],testedAt:time,testReportDigest:digest}],
  ];
  for (const [kind, reference, metadata] of values) await database.query(`INSERT INTO qixiang_provider_approval_evidence(
    id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
    VALUES($1,$2,$3,$4,$5,$6,$7,'2026-08-20T00:00:00Z')`, [randomUUID(),kind,reference,digest,JSON.stringify(metadata),first,second]);
  return { database, pglite };
}

describe('Qixiang runtime evidence readiness', () => {
  it('requires the exact active DB references, merchant entity and approved maximum', async () => {
    const { database } = await fixture(); const runtime = config();
    const state = await new QixiangEvidenceService(new PostgresQixiangEvidenceStore(database), runtime,
      () => new Date('2026-08-21T08:00:00Z')).readiness();
    expect(state).toEqual({ ready: true, maxAmountCents: 4_999_999, blockers: [] }); await database.close();
  }, 30_000);

  it('fails closed on a mismatched legal entity or configured evidence reference', async () => {
    const { database } = await fixture(); const store = new PostgresQixiangEvidenceStore(database);
    expect((await new QixiangEvidenceService(store, config({LEGAL_ENTITY_NAME:'另一主体'}),
      () => new Date('2026-08-21T08:00:00Z')).readiness()).blockers).toContain('QIXIANG_MERCHANT_ENTITY_MATCH');
    expect((await new QixiangEvidenceService(store, config({QIXIANG_RECONCILIATION_EVIDENCE_REF:'audit://wrong'}),
      () => new Date('2026-08-21T08:00:00Z')).readiness()).blockers).toContain('QIXIANG_RECONCILIATION');
    await database.close();
  }, 30_000);

  it('does not touch the evidence store while effective mode is off', async () => {
    const service = new QixiangEvidenceService({approved: async () => { throw new Error('must not read'); }} as never,
      config({MOBILE_API_PROFILE:'inquiry_only'}));
    await expect(service.readiness()).resolves.toEqual({ ready: false, maxAmountCents: null, blockers: [] });
  });
});
