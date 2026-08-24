import { createHash, verify } from 'node:crypto';
import { AppError } from '../errors.js';

const HEX = /^[0-9a-f]{64}$/u;
const SUBJECT_HEX = /^[0-9a-f]{64}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_LIFETIME_MS = 15 * 60_000;

export const QIXIANG_GATE_ENV_KEYS = [
  'NODE_ENV', 'MOBILE_API_PROFILE', 'HOST', 'PORT', 'TRUST_PROXY_HOPS', 'DATABASE_URL', 'DATABASE_SSL',
  'PUBLIC_ORIGIN', 'QIXIANG_TOPUP_MODE', 'QIXIANG_RECOVERY_MODE', 'QIXIANG_PID',
  'QIXIANG_APPROVED_MAX_CENTS', 'QIXIANG_CHECKOUT_KEY_ID', 'QIXIANG_CHECKOUT_CIPHER_VERSION',
  'QIXIANG_NOTIFY_URL', 'QIXIANG_RETURN_URL', 'QIXIANG_KEY_ROTATION_EVIDENCE_REF',
  'QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF', 'QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF',
  'QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF', 'QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF',
  'QIXIANG_REFUND_API_EVIDENCE_REF', 'QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF',
  'QIXIANG_RECONCILIATION_EVIDENCE_REF', 'QIXIANG_APPROVED_MAX_EVIDENCE_REF',
  'QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF', 'LEGAL_ENTITY_NAME', 'UNIFIED_SOCIAL_CREDIT_CODE',
  'ICP_FILING', 'ICP_FILING_STATUS', 'ICP_FILING_EVIDENCE_REF', 'ICP_FILING_DOMAIN',
  'APP_FILING', 'APP_FILING_STATUS', 'APP_FILING_EVIDENCE_REF', 'APP_FILING_PACKAGE',
  'FILING_OPERATOR_CREDIT_CODE', 'INTERNET_SERVICE_CLASSIFICATION_STATUS',
  'INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF',
] as const;

type Environment = Readonly<Record<string, string | number | boolean | null | undefined>>;
type Action = 'create' | 'refund';
type CanaryContext = Readonly<{ userId: string; subjectId: string; amountCents: number }>;
export type QixiangDatabaseGateState = Readonly<{ identitySha256: string; migrationSha256: string }>;
export type QixiangDatabaseGateSnapshot = Readonly<{ state: QixiangDatabaseGateState;
  identity: Readonly<{ databaseOid: string; systemIdentifier: string }> }>;
type DatabaseQuery = <Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string, values?: unknown[]) => Promise<{ rows: Row[] }>;

export type QixiangProductionGateReceipt = Readonly<{
  schemaVersion: 2;
  kind: 'qixiang_full_commerce_runtime_gate';
  phase: 'bootstrap_canary' | 'full_commerce';
  issuedAt: string;
  expiresAt: string;
  configurationSha256: string;
  releaseManifestSha256: string;
  database: Readonly<{ identitySha256: string; migrationSha256: string }>;
  credentials: Readonly<{ merchantSha256: string; checkoutSha256: string }>;
  provider: Readonly<{
    pid: '4611'; currentKeyActive: true; accountActive: true; retiredKeyRejected: true; proofSha256: string;
  }>;
  approvals: Readonly<{
    complianceManifestSha256: string; domainAppScene: true; serviceCategory: true; refundApi: true;
  }>;
  acceptance: Readonly<{
    dedicatedProbeSubjectSha256: string; appSessionReportSha256: string; fulfillmentReportSha256: string;
    reconciliationReportSha256: string; lotAccountingReportSha256: string;
  }>;
  canary: Readonly<{ topupId: string; userId: string; subjectId: string; amountCents: 501 }>;
  signature: Readonly<{ algorithm: 'Ed25519'; value: string }>;
}>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function qixiangGateConfigurationDigest(environment: Environment) {
  const values = Object.fromEntries(QIXIANG_GATE_ENV_KEYS.map((key) => [key,
    environment[key] === undefined ? null : String(environment[key])]));
  return createHash('sha256').update(canonicalJson(values)).digest('hex');
}

export function qixiangCredentialFingerprint(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export async function qixiangDatabaseGateSnapshot(query: DatabaseQuery): Promise<QixiangDatabaseGateSnapshot> {
  const snapshot = await query(`SELECT current_database() AS database_name,current_user AS database_user,
      COALESCE(inet_server_addr()::text,'local') AS server_address,inet_server_port() AS server_port,
      d.oid::text AS database_oid,c.system_identifier::text AS system_identifier,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)
        FROM schema_migrations),'[]'::jsonb) AS migrations
      FROM pg_database d CROSS JOIN LATERAL pg_control_system() c WHERE d.datname=current_database()`);
  const row = snapshot.rows[0];
  if (!row || snapshot.rows.length !== 1 || typeof row.system_identifier !== 'string'
    || !/^\d{10,24}$/u.test(row.system_identifier) || typeof row.database_oid !== 'string'
    || !/^\d{1,10}$/u.test(row.database_oid) || !Array.isArray(row.migrations)) {
    throw new Error('QIXIANG_DATABASE_STABLE_IDENTITY_INVALID');
  }
  const { migrations, ...identity } = row;
  return { state: {
    identitySha256: createHash('sha256').update(canonicalJson(identity)).digest('hex'),
    migrationSha256: createHash('sha256').update(canonicalJson(migrations)).digest('hex'),
  }, identity: { databaseOid: row.database_oid, systemIdentifier: row.system_identifier } };
}

export async function qixiangDatabaseGateState(query: DatabaseQuery): Promise<QixiangDatabaseGateState> {
  return (await qixiangDatabaseGateSnapshot(query)).state;
}

function unsigned(receipt: QixiangProductionGateReceipt) {
  const { signature: _signature, ...payload } = receipt;
  return Buffer.from(canonicalJson(payload));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseReceipt(raw: string): QixiangProductionGateReceipt {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('QIXIANG_PRODUCTION_GATE_RECEIPT_TOO_LARGE');
  const root = object(JSON.parse(raw));
  if (!root || !exactKeys(root, ['schemaVersion', 'kind', 'phase', 'issuedAt', 'expiresAt', 'configurationSha256',
    'releaseManifestSha256', 'database', 'credentials', 'provider', 'approvals', 'acceptance', 'canary', 'signature'])) {
    throw new Error('QIXIANG_PRODUCTION_GATE_RECEIPT_INVALID');
  }
  const database = object(root.database); const credentials = object(root.credentials); const provider = object(root.provider);
  const approvals = object(root.approvals); const acceptance = object(root.acceptance); const canary=object(root.canary);
  const signature = object(root.signature);
  if (root.schemaVersion !== 2 || root.kind !== 'qixiang_full_commerce_runtime_gate'
    || !['bootstrap_canary','full_commerce'].includes(String(root.phase))
    || typeof root.issuedAt !== 'string' || typeof root.expiresAt !== 'string'
    || !HEX.test(String(root.configurationSha256)) || !HEX.test(String(root.releaseManifestSha256))
    || !database || !exactKeys(database, ['identitySha256', 'migrationSha256'])
    || !HEX.test(String(database.identitySha256)) || !HEX.test(String(database.migrationSha256))
    || !credentials || !exactKeys(credentials, ['merchantSha256', 'checkoutSha256'])
    || !HEX.test(String(credentials.merchantSha256)) || !HEX.test(String(credentials.checkoutSha256))
    || !provider || !exactKeys(provider, ['pid', 'currentKeyActive', 'accountActive', 'retiredKeyRejected', 'proofSha256'])
    || provider.pid !== '4611' || provider.currentKeyActive !== true || provider.accountActive !== true
    || provider.retiredKeyRejected !== true || !HEX.test(String(provider.proofSha256))
    || !approvals || !exactKeys(approvals, ['complianceManifestSha256', 'domainAppScene', 'serviceCategory', 'refundApi'])
    || !HEX.test(String(approvals.complianceManifestSha256)) || approvals.domainAppScene !== true
    || approvals.serviceCategory !== true || approvals.refundApi !== true
    || !acceptance || !exactKeys(acceptance, ['dedicatedProbeSubjectSha256', 'appSessionReportSha256',
      'fulfillmentReportSha256', 'reconciliationReportSha256', 'lotAccountingReportSha256'])
    || !SUBJECT_HEX.test(String(acceptance.dedicatedProbeSubjectSha256))
    || !HEX.test(String(acceptance.appSessionReportSha256)) || !HEX.test(String(acceptance.fulfillmentReportSha256))
    || !HEX.test(String(acceptance.reconciliationReportSha256)) || !HEX.test(String(acceptance.lotAccountingReportSha256))
    || !canary || !exactKeys(canary,['topupId','userId','subjectId','amountCents'])
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(canary.topupId))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(canary.userId))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(canary.subjectId))
    || canary.amountCents!==501
    || !signature || !exactKeys(signature, ['algorithm', 'value']) || signature.algorithm !== 'Ed25519'
    || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.value)) {
    throw new Error('QIXIANG_PRODUCTION_GATE_RECEIPT_INVALID');
  }
  return root as unknown as QixiangProductionGateReceipt;
}

export class QixiangProductionGate {
  private readonly receiptLoader: () => string;
  private readonly verificationPublicKeyPem: string;
  private readonly configurationSha256: string;
  private readonly merchantSha256: string;
  private readonly checkoutSha256: string;
  private readonly releaseManifestSha256: string | undefined;
  private readonly databaseStateLoader: (() => Promise<QixiangDatabaseGateState>) | undefined;
  private runtimeBinding:Readonly<{phase:QixiangProductionGateReceipt['phase'];canary:QixiangProductionGateReceipt['canary']}>|null=null;

  constructor(input: Readonly<{
    receipt: string;
    verificationPublicKeyPem: string;
    environment: Environment;
    merchantKey: string;
    checkoutKey: Buffer;
    releaseManifestSha256?: string;
    receiptLoader?: () => string;
    databaseStateLoader?: () => Promise<QixiangDatabaseGateState>;
    now?: () => Date;
  }>) {
    this.now = input.now ?? (() => new Date());
    this.receiptLoader=input.receiptLoader??(()=>input.receipt);
    this.verificationPublicKeyPem=input.verificationPublicKeyPem;
    this.configurationSha256=qixiangGateConfigurationDigest(input.environment);
    this.merchantSha256=qixiangCredentialFingerprint(input.merchantKey);
    this.checkoutSha256=qixiangCredentialFingerprint(input.checkoutKey);
    this.releaseManifestSha256=input.releaseManifestSha256;
    this.databaseStateLoader=input.databaseStateLoader;
  }

  private readonly now: () => Date;

  readiness(action: Action, canaryContext?:CanaryContext) {
    let receipt:QixiangProductionGateReceipt|null=null;
    try{receipt=parseReceipt(this.receiptLoader());}catch{/* evaluated below */}
    return this.evaluateReceipt(receipt,action,canaryContext);
  }

  private evaluateReceipt(receipt:QixiangProductionGateReceipt|null,action:Action,canaryContext?:CanaryContext){
    const blockers:string[]=[];if(!receipt)blockers.push('GATE_RECEIPT_INVALID');
    if(receipt){let signatureValid=false;try{signatureValid=verify(null,unsigned(receipt),this.verificationPublicKeyPem,
      Buffer.from(receipt.signature.value,'base64'));}catch{/* fail closed */}
      if(!signatureValid)blockers.push('GATE_SIGNATURE_INVALID');
      if(receipt.configurationSha256!==this.configurationSha256)blockers.push('GATE_CONFIGURATION_DRIFT');
      if(!this.releaseManifestSha256||receipt.releaseManifestSha256!==this.releaseManifestSha256)blockers.push('GATE_RELEASE_DRIFT');
      if(receipt.credentials.merchantSha256!==this.merchantSha256||receipt.credentials.checkoutSha256!==this.checkoutSha256)
        blockers.push('GATE_CREDENTIAL_DRIFT');
      const issued=Date.parse(receipt.issuedAt);const expires=Date.parse(receipt.expiresAt);const now=this.now().getTime();
      if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued||expires-issued>MAX_LIFETIME_MS
        ||issued>now+60_000||expires<=now)blockers.push('GATE_EXPIRED');
      if(action==='refund'&&receipt.approvals.refundApi!==true)blockers.push('REFUND_API_NOT_APPROVED');}
    if(receipt&&this.runtimeBinding&&(receipt.phase!==this.runtimeBinding.phase
      ||receipt.canary.topupId!==this.runtimeBinding.canary.topupId
      ||receipt.canary.userId!==this.runtimeBinding.canary.userId
      ||receipt.canary.subjectId!==this.runtimeBinding.canary.subjectId
      ||receipt.canary.amountCents!==this.runtimeBinding.canary.amountCents)){
      blockers.push('GATE_PHASE_RESTART_REQUIRED');}
    if(receipt?.phase==='bootstrap_canary'){
      const exactCanary=action==='create'&&canaryContext?.userId===receipt.canary.userId
        &&canaryContext.subjectId===receipt.canary.subjectId&&canaryContext.amountCents===receipt.canary.amountCents;
      if(!exactCanary)blockers.push('GATE_BOOTSTRAP_CANARY_ONLY');
    }
    return { ready: blockers.length === 0, expiresAt: receipt?.expiresAt ?? null,
      blockers: [...new Set(blockers)] } as const;
  }

  async readinessWithDatabase(action: Action, canaryContext?:CanaryContext) {
    let receipt:QixiangProductionGateReceipt|null=null;
    try{receipt=parseReceipt(this.receiptLoader());}catch{/* fail closed in readiness */}
    const readiness=this.evaluateReceipt(receipt,action,canaryContext);
    const phase=receipt?.phase??null;const canaryTopupId=phase==='bootstrap_canary'?receipt!.canary.topupId:null;
    if (!readiness.ready) return {...readiness,phase,canaryTopupId};
    let databaseMatches = false;
    try {
      const current = await this.databaseStateLoader?.();
      databaseMatches = Boolean(receipt&&current && current.identitySha256 === receipt.database.identitySha256
        && current.migrationSha256 === receipt.database.migrationSha256);
    } catch { /* fail closed */ }
    return databaseMatches ? {...readiness,phase,canaryTopupId}
      : { ...readiness, ready: false, blockers: ['GATE_DATABASE_DRIFT'],phase,canaryTopupId } as const;
  }

  async require(action: Action, canaryContext?:CanaryContext) {
    const readiness = await this.readinessWithDatabase(action,canaryContext);
    if (!readiness.ready) throw new AppError(action === 'refund' ? 'QIXIANG_REFUND_PRODUCTION_GATE_CLOSED'
      : 'QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED', 503, '真实支付生产验收凭证、数据库或发布核验失败。',
    {blockers:readiness.blockers,phase:readiness.phase,canaryTopupId:readiness.canaryTopupId});
    return readiness;
  }

  async requireStartup() {
    if(this.runtimeBinding){const binding=this.runtimeBinding;
      if(binding.phase==='bootstrap_canary')return this.require('create',{userId:binding.canary.userId,
        subjectId:binding.canary.subjectId,amountCents:binding.canary.amountCents});
      await this.require('refund');return this.require('create');}
    let receipt:QixiangProductionGateReceipt;
    try{receipt=parseReceipt(this.receiptLoader());}catch{throw new AppError('QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED',503,
      '真实支付启动验收凭证无效。');}
    if(receipt.phase==='bootstrap_canary')await this.require('create',{userId:receipt.canary.userId,
      subjectId:receipt.canary.subjectId,amountCents:receipt.canary.amountCents});
    else{await this.require('refund');await this.require('create');}
    let current:QixiangProductionGateReceipt;
    try{current=parseReceipt(this.receiptLoader());}catch{throw new AppError('QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED',503,
      '真实支付启动验收凭证已变更。',{blockers:['GATE_PHASE_RESTART_REQUIRED']});}
    if(current.phase!==receipt.phase||current.canary.topupId!==receipt.canary.topupId
      ||current.canary.userId!==receipt.canary.userId||current.canary.subjectId!==receipt.canary.subjectId
      ||current.canary.amountCents!==receipt.canary.amountCents)throw new AppError('QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED',503,
      '真实支付启动阶段已变更，需要受审重启。',{blockers:['GATE_PHASE_RESTART_REQUIRED']});
    this.runtimeBinding={phase:receipt.phase,canary:receipt.canary};
    if(receipt.phase==='bootstrap_canary')return this.require('create',{userId:receipt.canary.userId,
      subjectId:receipt.canary.subjectId,amountCents:receipt.canary.amountCents});
    await this.require('refund');return this.require('create');
  }
}
