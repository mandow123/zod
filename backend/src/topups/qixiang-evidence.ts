import type { QueryResultRow } from 'pg';
import type { RuntimeConfig } from '../config.js';
import type { Database } from '../database.js';

export const qixiangEvidenceKinds = [
  'merchant_key_rotation', 'old_key_revocation', 'merchant_entity_match', 'domain_app_scene_approval',
  'service_category_approval', 'refund_api_confirmation', 'real_fulfillment_acceptance',
  'reconciliation_acceptance', 'approved_max_amount', 'lot_accounting_acceptance',
] as const;
export type QixiangEvidenceKind = typeof qixiangEvidenceKinds[number];

type EvidenceRow = QueryResultRow & {
  kind: QixiangEvidenceKind;
  evidence_ref: string;
  metadata: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
};

const expectedReference: Record<QixiangEvidenceKind, keyof RuntimeConfig> = {
  merchant_key_rotation: 'QIXIANG_KEY_ROTATION_EVIDENCE_REF',
  old_key_revocation: 'QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF',
  merchant_entity_match: 'QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF',
  domain_app_scene_approval: 'QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF',
  service_category_approval: 'QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF',
  refund_api_confirmation: 'QIXIANG_REFUND_API_EVIDENCE_REF',
  real_fulfillment_acceptance: 'QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF',
  reconciliation_acceptance: 'QIXIANG_RECONCILIATION_EVIDENCE_REF',
  approved_max_amount: 'QIXIANG_APPROVED_MAX_EVIDENCE_REF',
  lot_accounting_acceptance: 'QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF',
};
const blocker: Record<QixiangEvidenceKind, string> = {
  merchant_key_rotation: 'QIXIANG_KEY_ROTATED', old_key_revocation: 'QIXIANG_OLD_KEY_REVOKED',
  merchant_entity_match: 'QIXIANG_MERCHANT_ENTITY_MATCH', domain_app_scene_approval: 'QIXIANG_DOMAIN_APP_SCENE_APPROVED',
  service_category_approval: 'QIXIANG_SERVICE_CATEGORY_APPROVED', refund_api_confirmation: 'QIXIANG_REFUND_API_CONFIRMED',
  real_fulfillment_acceptance: 'QIXIANG_REAL_FULFILLMENT', reconciliation_acceptance: 'QIXIANG_RECONCILIATION',
  approved_max_amount: 'QIXIANG_APPROVED_MAX_UNVERIFIED', lot_accounting_acceptance: 'QIXIANG_LOT_ACCOUNTING',
};

export class PostgresQixiangEvidenceStore {
  constructor(private readonly database: Database) {}

  async approved(now: Date) {
    const result = await this.database.query<EvidenceRow>(`SELECT kind,evidence_ref,metadata,valid_from,valid_until
      FROM qixiang_provider_approval_evidence WHERE status='approved' AND valid_from<=$1
      AND(valid_until IS NULL OR valid_until>$1) ORDER BY kind`, [now]);
    return result.rows;
  }
}

export class QixiangEvidenceService {
  constructor(private readonly store: PostgresQixiangEvidenceStore, private readonly config: RuntimeConfig,
  private readonly now: () => Date = () => new Date()) {}

  async readiness(mode:'full'|'bootstrap_canary'='full') {
    if (this.config.qixiangTopupMode !== 'on') return { ready: false, maxAmountCents: null, blockers: [] as string[] };
    if (mode==='bootstrap_canary'&&this.config.qixiangTechnicalCanaryMode) {
      return { ready: true, maxAmountCents: 501, blockers: [] as string[] };
    }
    const rows = await this.store.approved(this.now());
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    const blockers: string[] = [];
    const requiredKinds=mode==='bootstrap_canary'?qixiangEvidenceKinds.filter((kind)=>
      !['real_fulfillment_acceptance','reconciliation_acceptance','lot_accounting_acceptance'].includes(kind)):qixiangEvidenceKinds;
    for (const kind of requiredKinds) {
      const row = byKind.get(kind);
      const configuredReference = this.config[expectedReference[kind]];
      if (!row || typeof configuredReference !== 'string' || row.evidence_ref !== configuredReference) blockers.push(blocker[kind]);
    }
    const entity = byKind.get('merchant_entity_match')?.metadata;
    if (!entity || entity.merchantId !== '4611' || entity.legalEntityName !== this.config.LEGAL_ENTITY_NAME
      || entity.providerRegisteredName !== this.config.LEGAL_ENTITY_NAME
      || entity.unifiedSocialCreditCode !== this.config.UNIFIED_SOCIAL_CREDIT_CODE) {
      blockers.push('QIXIANG_MERCHANT_ENTITY_MATCH');
    }
    const domainApproval = byKind.get('domain_app_scene_approval')?.metadata;
    if (!domainApproval || domainApproval.domain !== 'api.kaicloudpay.com'
      || domainApproval.appPackage !== 'com.kaicloud.marketplace'
      || domainApproval.scene !== 'android_h5_alipay' || domainApproval.merchantId !== '4611') {
      blockers.push('QIXIANG_DOMAIN_APP_SCENE_APPROVED');
    }
    const maximum = byKind.get('approved_max_amount')?.metadata;
    const maxAmountCents = maximum?.merchantId === '4611' && maximum.currency === 'CNY' && maximum.minCents === 100
      && maximum.maxCents === this.config.qixiangApprovedMaxCents ? this.config.qixiangApprovedMaxCents : null;
    if (maxAmountCents === null) blockers.push('QIXIANG_APPROVED_MAX_UNVERIFIED');
    return { ready: blockers.length === 0, maxAmountCents, blockers: [...new Set(blockers)] };
  }
}
