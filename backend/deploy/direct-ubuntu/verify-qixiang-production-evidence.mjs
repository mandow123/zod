import { constants } from 'node:fs';
import { createHash, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import pg from 'pg';
import { PostgresQixiangEvidenceStore, QixiangEvidenceService, qixiangEvidenceKinds } from '../../dist/topups/qixiang-evidence.js';
import { canonicalJson, qixiangDatabaseGateSnapshot, qixiangGateConfigurationDigest } from '../../dist/topups/qixiang-production-gate.js';
import { probeEvidenceDigest } from '../../dist/operations/probe-evidence.js';
import { parseRefreshState } from '../../scripts/kai-probe-credential-core.mjs';
import { fullCommerceStaticFailures, parseEnvironment } from './full-commerce-gate-core.mjs';
import { authorizeQixiangEvidenceSigner, QIXIANG_EVIDENCE_TRUST_POLICY } from './qixiang-evidence-trust-policy.mjs';
import { isCurrentComplianceReview, isExactActiveQixiangMerchant, isExactQixiangRetiredKeyRejection }
  from './qixiang-production-evidence-core.mjs';

const ENV_PATH = '/etc/kai-cloudpay/backend.env';
const EVIDENCE_ROOT = '/var/lib/kai-cloudpay-evidence';
const COMPLIANCE_MANIFEST = `${EVIDENCE_ROOT}/full-commerce-compliance.json`;
const EVIDENCE_TRUST_ROOT = '/etc/kai-cloudpay/evidence-trust';
const PROBE_EXPECTED_SUBJECT = '/etc/kai-cloudpay/probe-expected-subject.sha256';
const REPORT_PATH = '/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json';
const CREDENTIALS = {
  merchant: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-merchant-key', 'qixiang-merchant-key'],
  retired: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-retired-key', 'qixiang-retired-key'],
  checkout: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-checkout-key', 'qixiang-checkout-key'],
  signing: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-signing-private', 'qixiang-gate-signing-private'],
  probeRefresh: ['/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state', 'kai-refresh-state'],
  probeAudit: ['/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-audit-pepper', 'kai-probe-audit-pepper'],
};
const HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const values = process.argv.slice(2); const reportIndex = values.indexOf('--report');
if (values.length !== 2 || resolve(values[reportIndex + 1] ?? '') !== REPORT_PATH
  || process.platform !== 'linux' || process.getuid?.() !== 0) {
  process.stderr.write(`Usage: sudo node verify-qixiang-production-evidence.mjs --report ${REPORT_PATH}\n`);
  process.exit(2);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function secureRead(path, maximum = 1024 * 1024, rootOwned = true, privateFile = true) {
  const link = await lstat(path);
  if (link.isSymbolicLink() || !link.isFile() || (rootOwned && link.uid !== 0)
    || (privateFile ? (link.mode & 0o077) !== 0 : (link.mode & 0o022) !== 0)
    || link.size < 1 || link.size > maximum) throw new Error('QIXIANG_EVIDENCE_FILE_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (metadata.dev !== link.dev || metadata.ino !== link.ino || metadata.size !== link.size) {
      throw new Error('QIXIANG_EVIDENCE_FILE_CHANGED');
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function decrypt(path, name) {
  await secureRead(path, 64 * 1024);
  return execFileSync('/usr/bin/systemd-creds', ['decrypt', `--name=${name}`, path, '-'], {
    maxBuffer: 64 * 1024, encoding: 'buffer', env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
function credentialText(bytes, kind) {
  const value = bytes.toString('utf8').replace(/\n$/u, '');
  if (value.length < 8 || value.length > 16_384 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`QIXIANG_${kind}_CREDENTIAL_INVALID`);
  }
  return value;
}
async function providerMerchantQuery(key) {
  const url = new URL('https://api.payqixiang.cn/api.php');
  url.search = new URLSearchParams({ act: 'query', pid: '4611', key }).toString();
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'User-Agent': 'KAI-CloudPay-Gate/1.0' } });
  if (!response.ok || response.status >= 300 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('QIXIANG_LIVE_MERCHANT_QUERY_FAILED');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 32_768) throw new Error('QIXIANG_LIVE_MERCHANT_QUERY_INVALID');
  const result = JSON.parse(raw);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isInteger(result.code)) {
    throw new Error('QIXIANG_LIVE_MERCHANT_QUERY_INVALID');
  }
  return result;
}
async function verifiedArtifact(entry, kind, expected) {
  if (!entry || Object.keys(entry).sort().join(',') !== 'path,sha256,signerPublicKeyPath,signerPublicKeySha256'
    || !HEX.test(entry.sha256 ?? '') || !HEX.test(entry.signerPublicKeySha256 ?? '')
    || typeof entry.path !== 'string' || !entry.path.startsWith(`${EVIDENCE_ROOT}/`)
    || resolve(entry.path) !== entry.path || entry.path.includes('/../')
    || typeof entry.signerPublicKeyPath !== 'string' || !entry.signerPublicKeyPath.startsWith(`${EVIDENCE_TRUST_ROOT}/`)
    || resolve(entry.signerPublicKeyPath) !== entry.signerPublicKeyPath || entry.signerPublicKeyPath.includes('/../')) {
    throw new Error(`QIXIANG_${kind}_ARTIFACT_INVALID`);
  }
  const bytes = await secureRead(entry.path, 16 * 1024 * 1024);
  if (sha256(bytes) !== entry.sha256) throw new Error(`QIXIANG_${kind}_ARTIFACT_DIGEST_MISMATCH`);
  const signer = await secureRead(entry.signerPublicKeyPath, 64 * 1024);
  if (sha256(signer) !== entry.signerPublicKeySha256) throw new Error(`QIXIANG_${kind}_SIGNER_MISMATCH`);
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`QIXIANG_${kind}_SIGNED_EVIDENCE_INVALID`); }
  const rootKeys = ['schemaVersion','kind','issuedAt','expiresAt','issuer','subject','claims','signature'];
  const subjectKeys = ['appPackage','databaseOid','databaseSystemIdentifier','domain','merchantId','operatorCreditCode',
    'operatorLegalName','probeSubjectSha256','releaseManifestSha256'];
  if (!envelope || Object.keys(envelope).sort().join(',') !== rootKeys.sort().join(',') || envelope.schemaVersion !== 2
    || envelope.kind !== kind || !envelope.issuer || Object.keys(envelope.issuer).sort().join(',') !== 'authorityKind,identifier,legalName'
    || envelope.issuer.authorityKind !== expected.authorityKind || typeof envelope.issuer.identifier !== 'string'
    || envelope.issuer.identifier.length < 3 || typeof envelope.issuer.legalName !== 'string' || envelope.issuer.legalName.length < 2
    || !envelope.subject || Object.keys(envelope.subject).sort().join(',') !== subjectKeys.sort().join(',')
    || canonicalJson(envelope.subject) !== canonicalJson(expected.subject)
    || canonicalJson(envelope.claims) !== canonicalJson(expected.claims)
    || !envelope.signature || Object.keys(envelope.signature).sort().join(',') !== 'algorithm,value'
    || envelope.signature.algorithm !== 'Ed25519' || typeof envelope.signature.value !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature.value)) {
    throw new Error(`QIXIANG_${kind}_SIGNED_EVIDENCE_INVALID`);
  }
  if (!authorizeQixiangEvidenceSigner(QIXIANG_EVIDENCE_TRUST_POLICY, {
    publicKeySha256: entry.signerPublicKeySha256, authorityKind: envelope.issuer.authorityKind,
    issuerIdentifier: envelope.issuer.identifier, issuerLegalName: envelope.issuer.legalName, evidenceKind: kind,
  })) throw new Error(`QIXIANG_${kind}_SIGNER_NOT_AUTHORIZED`);
  const issuedAt = Date.parse(envelope.issuedAt); const expiresAt = Date.parse(envelope.expiresAt); const now = Date.now();
  const { signature: _signature, ...unsignedEnvelope } = envelope;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 60_000 || expiresAt <= now
    || expiresAt <= issuedAt || expiresAt - issuedAt > 366 * 24 * 60 * 60_000
    || !verify(null, Buffer.from(canonicalJson(unsignedEnvelope)),
      signer, Buffer.from(envelope.signature.value, 'base64'))) {
    throw new Error(`QIXIANG_${kind}_SIGNED_EVIDENCE_INVALID`);
  }
  return { digest: entry.sha256, signerSha256: entry.signerPublicKeySha256 };
}

const env = parseEnvironment((await secureRead(ENV_PATH, 256 * 1024)).toString('utf8'));
const staticFailures = fullCommerceStaticFailures(env);
if (staticFailures.length) throw new Error(`FULL_COMMERCE_STATIC_INVALID:${staticFailures.join(',')}`);
const encrypted = Object.fromEntries(await Promise.all(Object.entries(CREDENTIALS).map(async ([key, [path, name]]) =>
  [key, await decrypt(path, name)])));
let merchantKey; let retiredKey; let checkoutKey; let signingKey; let probeAudit;
try {
  merchantKey = credentialText(encrypted.merchant, 'MERCHANT'); retiredKey = credentialText(encrypted.retired, 'RETIRED');
  checkoutKey = credentialText(encrypted.checkout, 'CHECKOUT'); signingKey = encrypted.signing.toString('utf8').replace(/\n$/u, '');
  probeAudit = credentialText(encrypted.probeAudit, 'PROBE_AUDIT');
  const probeRefresh = parseRefreshState(JSON.parse(encrypted.probeRefresh.toString('utf8')));
  const checkoutDecoded = Buffer.from(checkoutKey, 'base64');
  if (checkoutDecoded.length !== 32 || checkoutDecoded.toString('base64') !== checkoutKey) {
    throw new Error('QIXIANG_CHECKOUT_CREDENTIAL_INVALID');
  }
  checkoutDecoded.fill(0);
  if (merchantKey === retiredKey) throw new Error('QIXIANG_KEY_ROTATION_NOT_PERFORMED');
  if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/u.test(signingKey)) {
    throw new Error('QIXIANG_GATE_SIGNING_KEY_INVALID');
  }

  const [currentProvider, retiredProvider, manifestBytes, releaseManifestBytes] = await Promise.all([
    providerMerchantQuery(merchantKey), providerMerchantQuery(retiredKey), secureRead(COMPLIANCE_MANIFEST, 256 * 1024),
    secureRead(join(process.cwd(), 'RELEASE-MANIFEST.json'), 4 * 1024 * 1024, false, false),
  ]);
  const currentActive = isExactActiveQixiangMerchant(currentProvider, merchantKey);
  const retiredRejected = isExactQixiangRetiredKeyRejection(retiredProvider);
  if (!currentActive) throw new Error('QIXIANG_CURRENT_KEY_LIVE_PROOF_FAILED');
  if (!retiredRejected) throw new Error('QIXIANG_RETIRED_KEY_STILL_ACTIVE');

  const compliance = JSON.parse(manifestBytes.toString('utf8'));
  const expectedComplianceKeys = ['schemaVersion','domain','appPackage','operator','icpFiling','appFiling','classification',
    'reviewedAt','reviewers','approvals','acceptance'];
  if (!compliance || Object.keys(compliance).sort().join(',') !== expectedComplianceKeys.sort().join(',')
    || compliance.schemaVersion !== 1 || compliance.domain !== 'cloudpay.kai.com'
    || compliance.appPackage !== 'com.kaicloud.marketplace'
    || compliance.operator?.legalName !== '上海申比芯人工智能科技有限公司'
    || compliance.operator?.creditCode !== '91310112MAKJAYAJ7U'
    || compliance.icpFiling !== env.ICP_FILING || compliance.appFiling !== env.APP_FILING
    || compliance.classification !== 'approved_with_legal_evidence'
    || !isCurrentComplianceReview(compliance.reviewedAt,Date.now())
    || !Array.isArray(compliance.reviewers) || compliance.reviewers.length !== 2
    || !compliance.reviewers.every((id) => UUID.test(id)) || compliance.reviewers[0] === compliance.reviewers[1]) {
    throw new Error('QIXIANG_COMPLIANCE_MANIFEST_INVALID');
  }
  const approvalKeys = ['icpReceipt','appFilingReceipt','legalClassificationOpinion','merchantEntity','domainAppScene',
    'serviceCategory','refundApi','approvedMaxAmount'];
  const acceptanceKeys = ['dedicatedProbeSubjectSha256','canaryTopupId','canaryUserId','canarySubjectId',
    'providerTransactionSha256','acceptedAmountCents',
    'canaryAuthorization','appSessionReport','fulfillmentReport','reconciliationReport','lotAccountingReport'];
  if (!compliance.approvals || Object.keys(compliance.approvals).sort().join(',') !== approvalKeys.sort().join(',')
    || !compliance.acceptance || Object.keys(compliance.acceptance).sort().join(',') !== acceptanceKeys.sort().join(',')
    || !HEX.test(compliance.acceptance.dedicatedProbeSubjectSha256 ?? '')
    || !UUID.test(compliance.acceptance.canaryTopupId ?? '')
    || !UUID.test(compliance.acceptance.canaryUserId ?? '')||!UUID.test(compliance.acceptance.canarySubjectId ?? '')
    || !(compliance.acceptance.providerTransactionSha256===null
      ||HEX.test(compliance.acceptance.providerTransactionSha256??''))
    || compliance.acceptance.acceptedAmountCents !== 501) {
    throw new Error('QIXIANG_COMPLIANCE_MANIFEST_INVALID');
  }
  const expectedProbeSubject=(await secureRead(PROBE_EXPECTED_SUBJECT,128)).toString('utf8').trim();
  const refreshProbeSubject=sha256(probeRefresh.subject);
  if(!HEX.test(expectedProbeSubject)||expectedProbeSubject!==refreshProbeSubject
    ||expectedProbeSubject!==compliance.acceptance.dedicatedProbeSubjectSha256){
    throw new Error('QIXIANG_DEDICATED_PROBE_SUBJECT_MISMATCH');
  }

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
  let bootstrapReadiness;let fullReadiness; let evidenceRows; let databaseSnapshot; let reviewers; let evidenceReviewers;
  let probeEvidence; let testTopup;let canaryState;let canaryAuthorization;
  try {
    const database = { query: (text, parameters) => pool.query(text, parameters) };
    const evidenceService=new QixiangEvidenceService(new PostgresQixiangEvidenceStore(database), {
      ...env, qixiangTopupMode: env.QIXIANG_TOPUP_MODE, qixiangApprovedMaxCents: Number(env.QIXIANG_APPROVED_MAX_CENTS),
    });
    [bootstrapReadiness,fullReadiness,evidenceRows, databaseSnapshot, reviewers, evidenceReviewers, probeEvidence, testTopup,
      canaryState,canaryAuthorization] = await Promise.all([
      evidenceService.readiness('bootstrap_canary'),evidenceService.readiness('full'),
      pool.query(`SELECT kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id
        FROM qixiang_provider_approval_evidence WHERE status='approved' AND valid_from<=now()
        AND(valid_until IS NULL OR valid_until>now()) ORDER BY kind`),
      qixiangDatabaseGateSnapshot((text, parameters) => pool.query(text, parameters)),
      pool.query(`SELECT id,role,status FROM users WHERE id=ANY($1::uuid[])`, [compliance.reviewers]),
      pool.query(`SELECT id,role,status FROM users WHERE id IN(
        SELECT verified_by_operator_id FROM qixiang_provider_approval_evidence WHERE status='approved'
        UNION SELECT approved_by_operator_id FROM qixiang_provider_approval_evidence WHERE status='approved')`),
      pool.query(`SELECT DISTINCT ON(action) action,payload_digest,metadata,created_at
        FROM audit_events WHERE action IN('INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED','INQUIRY_ONLY_APP_SESSION_PROBE_PASSED')
        ORDER BY action,created_at DESC`),
      pool.query(`SELECT t.id,t.amount_cents::text,t.credit_micros::text,t.status,t.provider_transaction_id,
        t.succeeded_at,t.entitlement_expires_at,l.id lot_id,l.granted_micros::text,
        r.signature_verified,r.snapshot_matched,r.processing_result
        FROM kai_credit_topups t JOIN kai_credit_lots l ON l.source_topup_id=t.id
        JOIN LATERAL(SELECT signature_verified,snapshot_matched,processing_result FROM qixiang_payment_receipts
          WHERE topup_id=t.id AND processing_result='accepted' ORDER BY received_at DESC LIMIT 1)r ON true
        WHERE t.id=$1::uuid AND t.provider='qixiang'`, [compliance.acceptance.canaryTopupId]),
      pool.query(`SELECT t.id,t.subject_id,t.created_by_user_id,t.amount_cents::text,t.status,
        (SELECT count(*)::text FROM kai_credit_topups WHERE provider='qixiang' AND status='succeeded' AND id<>$1::uuid) other_succeeded,
        (SELECT count(*)::text FROM kai_credit_topups WHERE provider='qixiang'
          AND status IN('created','pending','verifying','expired','manual_review') AND id<>$1::uuid) other_unresolved
        FROM kai_credit_topups t WHERE t.id=$1::uuid AND t.provider='qixiang'
        UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,
          (SELECT count(*)::text FROM kai_credit_topups WHERE provider='qixiang' AND status='succeeded' AND id<>$1::uuid),
          (SELECT count(*)::text FROM kai_credit_topups WHERE provider='qixiang'
            AND status IN('created','pending','verifying','expired','manual_review') AND id<>$1::uuid)
        WHERE NOT EXISTS(SELECT 1 FROM kai_credit_topups WHERE id=$1::uuid AND provider='qixiang')`,
        [compliance.acceptance.canaryTopupId]),
      pool.query(`SELECT u.id user_id,u.status user_status,s.id subject_id,s.status subject_status,s.kind,s.owner_user_id
        FROM users u JOIN trading_subjects s ON s.id=$2::uuid
        WHERE u.id=$1::uuid`,[compliance.acceptance.canaryUserId,compliance.acceptance.canarySubjectId]),
    ]);
  } finally { await pool.end(); }
  const acceptanceTopup=testTopup.rows[0];const phase=acceptanceTopup?'full_commerce':'bootstrap_canary';
  const requiredEvidenceKinds=phase==='full_commerce'?[...qixiangEvidenceKinds]:qixiangEvidenceKinds.filter((kind)=>
    !['real_fulfillment_acceptance','reconciliation_acceptance','lot_accounting_acceptance'].includes(kind));
  const selectedReadiness=phase==='full_commerce'?fullReadiness:bootstrapReadiness;
  if (!selectedReadiness.ready || evidenceRows.rows.length<requiredEvidenceKinds.length
    || evidenceRows.rows.filter((row)=>requiredEvidenceKinds.includes(row.kind)).map((row)=>row.kind).join(',')
      !== [...requiredEvidenceKinds].sort().join(',')) {
    throw new Error(`QIXIANG_DATABASE_EVIDENCE_NOT_READY:${selectedReadiness.blockers.join(',')}`);
  }
  if (reviewers.rows.length !== 2 || reviewers.rows.some((row) => row.role !== 'operator' || row.status !== 'active')) {
    throw new Error('QIXIANG_COMPLIANCE_REVIEWERS_NOT_ACTIVE');
  }
  if (evidenceReviewers.rows.length < 2
    || evidenceReviewers.rows.some((row) => row.role !== 'operator' || row.status !== 'active')) {
    throw new Error('QIXIANG_DATABASE_EVIDENCE_REVIEWERS_NOT_ACTIVE');
  }
  if (evidenceRows.rows.some((row) => row.verified_by_operator_id === row.approved_by_operator_id)) {
    throw new Error('QIXIANG_DATABASE_EVIDENCE_DUAL_CONTROL_INVALID');
  }
  const stableIdentity=databaseSnapshot.identity;const canary=canaryState.rows[0];
  const authorizedCanary=canaryAuthorization.rows[0];
  if(!authorizedCanary||canaryAuthorization.rows.length!==1||authorizedCanary.user_status!=='active'
    ||authorizedCanary.subject_status!=='active'||authorizedCanary.kind!=='personal'
    ||authorizedCanary.owner_user_id!==compliance.acceptance.canaryUserId){
    throw new Error('QIXIANG_BOOTSTRAP_CANARY_PRINCIPAL_INVALID');
  }
  if(!canary||Number(canary.other_succeeded)!==0||Number(canary.other_unresolved)!==0
    ||(canary.id!==null&&(canary.id!==compliance.acceptance.canaryTopupId
    ||canary.subject_id!==compliance.acceptance.canarySubjectId||canary.created_by_user_id!==compliance.acceptance.canaryUserId
    ||canary.amount_cents!=='501'||!['created','pending','verifying','expired','manual_review','succeeded'].includes(canary.status)))){
    throw new Error('QIXIANG_BOOTSTRAP_CANARY_STATE_INVALID');}
  if(phase==='bootstrap_canary'&&canary.status==='succeeded')throw new Error('QIXIANG_FULL_ACCEPTANCE_INCOMPLETE');
  if(phase==='full_commerce'&&(testTopup.rows.length!==1
    ||acceptanceTopup.status!=='succeeded'||acceptanceTopup.amount_cents!=='501'
    ||sha256(acceptanceTopup.provider_transaction_id??'')!==compliance.acceptance.providerTransactionSha256
    ||acceptanceTopup.signature_verified!==true||acceptanceTopup.snapshot_matched!==true
    ||acceptanceTopup.processing_result!=='accepted'||!acceptanceTopup.lot_id
    ||acceptanceTopup.credit_micros!==acceptanceTopup.granted_micros
    ||Date.parse(acceptanceTopup.entitlement_expires_at)-Date.parse(acceptanceTopup.succeeded_at)!==364*24*60*60_000)){
    throw new Error('QIXIANG_REAL_ACCEPTANCE_TOPUP_INVALID');
  }
  if((phase==='bootstrap_canary'&&(compliance.acceptance.providerTransactionSha256!==null
      ||compliance.acceptance.fulfillmentReport!==null||compliance.acceptance.reconciliationReport!==null
      ||compliance.acceptance.lotAccountingReport!==null))
    ||(phase==='full_commerce'&&(!HEX.test(compliance.acceptance.providerTransactionSha256??'')
      ||!compliance.acceptance.fulfillmentReport||!compliance.acceptance.reconciliationReport
      ||!compliance.acceptance.lotAccountingReport))){throw new Error('QIXIANG_ACCEPTANCE_PHASE_EVIDENCE_INVALID');}
  const releaseManifestSha256=sha256(releaseManifestBytes);
  const evidenceSubject={appPackage:'com.kaicloud.marketplace',databaseOid:stableIdentity.databaseOid,
    databaseSystemIdentifier:stableIdentity.systemIdentifier,domain:'cloudpay.kai.com',merchantId:'4611',
    operatorCreditCode:'91310112MAKJAYAJ7U',operatorLegalName:'上海申比芯人工智能科技有限公司',
    probeSubjectSha256:expectedProbeSubject,releaseManifestSha256};
  const canaryClaims={decision:'passed',amountCents:501,canaryTopupId:compliance.acceptance.canaryTopupId};
  const acceptanceClaims={...canaryClaims,providerTransactionSha256:compliance.acceptance.providerTransactionSha256};
  const probeByAction=new Map(probeEvidence.rows.map((row)=>[row.action,row]));
  const paired=probeByAction.get('INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED');
  const storedSession=probeByAction.get('INQUIRY_ONLY_APP_SESSION_PROBE_PASSED');
  const authentic=(row)=>Boolean(row&&row.metadata&&row.payload_digest===probeEvidenceDigest(row.metadata,probeAudit));
  const pairedAge=Date.now()-new Date(paired?.created_at??0).getTime();
  const sessionAge=Date.now()-new Date(storedSession?.created_at??0).getTime();
  if(!authentic(paired)||!authentic(storedSession)
    ||paired.metadata.producer!=='record-inquiry-readiness.mjs@2'
    ||paired.metadata.probeSubjectSha256!==expectedProbeSubject
    ||pairedAge<0||pairedAge>30*60_000
    ||typeof storedSession.metadata.reportSha256Digest!=='string'
    ||!/^sha256:[0-9a-f]{64}$/u.test(storedSession.metadata.reportSha256Digest)
    ||storedSession.metadata.packageName!=='com.kaicloud.marketplace'
    ||sessionAge<0||sessionAge>24*60*60_000){
    throw new Error('QIXIANG_REAL_PROBE_EVIDENCE_INVALID');
  }
  const artifactInputs=[
    [compliance.approvals.icpReceipt,'icp_filing_receipt','government',{decision:'issued',filingNumber:env.ICP_FILING,domain:'cloudpay.kai.com'}],
    [compliance.approvals.appFilingReceipt,'app_filing_receipt','government',{decision:'issued',filingNumber:env.APP_FILING,appPackage:'com.kaicloud.marketplace'}],
    [compliance.approvals.legalClassificationOpinion,'legal_classification_opinion','qualified_legal_counsel',
      {decision:'approved_with_legal_evidence',classification:'internet_resource_transaction_service'}],
    [compliance.approvals.merchantEntity,'qixiang_merchant_entity_match','payment_provider',
      {decision:'approved',merchantId:'4611',legalEntityName:'上海申比芯人工智能科技有限公司',
        unifiedSocialCreditCode:'91310112MAKJAYAJ7U'}],
    [compliance.approvals.domainAppScene,'qixiang_domain_app_scene_approval','payment_provider',
      {decision:'approved',scene:'android_h5_alipay',serviceCategory:'gpu_compute_card_hours'}],
    [compliance.approvals.serviceCategory,'qixiang_service_category_approval','payment_provider',
      {decision:'approved',category:'gpu_compute_card_hours',entitlementDays:364,nonCash:true,nonTransferable:true}],
    [compliance.approvals.refundApi,'qixiang_refund_api_approval','payment_provider',
      {decision:'approved',api:'refund',enabled:true}],
    [compliance.approvals.approvedMaxAmount,'qixiang_approved_max_amount','payment_provider',
      {decision:'approved',currency:'CNY',minCents:100,maxCents:Number(env.QIXIANG_APPROVED_MAX_CENTS)}],
    [compliance.acceptance.canaryAuthorization,'canary_authorization','independent_acceptance_attestor',
      {...canaryClaims,authorized:true,userId:compliance.acceptance.canaryUserId,
        subjectId:compliance.acceptance.canarySubjectId}],
    [compliance.acceptance.appSessionReport,'app_session_acceptance','device_acceptance_attestor',
      {...canaryClaims,auth:true,storedSession:true,forceStopRestart:true,
        sourceReportSha256:storedSession.metadata.reportSha256Digest.slice(7)}],
    ...(phase==='full_commerce'?[[compliance.acceptance.fulfillmentReport,'real_fulfillment_acceptance','independent_acceptance_attestor',
      {...acceptanceClaims,fulfillment:'compute_card_hours',entitlementDays:364}],
    [compliance.acceptance.reconciliationReport,'reconciliation_acceptance','independent_acceptance_attestor',
      {...acceptanceClaims,callback:true,activeQuery:true,lateSuccess:true}],
    [compliance.acceptance.lotAccountingReport,'lot_accounting_acceptance','independent_acceptance_attestor',
      {...acceptanceClaims,ledgerBalanced:true,lotGranted:true}]]:[]),
  ];
  const artifacts=new Map((await Promise.all(artifactInputs.map(async([entry,kind,authorityKind,claims])=>
    [kind,await verifiedArtifact(entry,kind,{authorityKind,subject:evidenceSubject,claims})]))).map(([kind,item])=>[kind,item.digest]));
  const icp=artifacts.get('icp_filing_receipt'),appFiling=artifacts.get('app_filing_receipt'),
    legal=artifacts.get('legal_classification_opinion'),merchantEntity=artifacts.get('qixiang_merchant_entity_match'),
    domainApp=artifacts.get('qixiang_domain_app_scene_approval'),serviceCategory=artifacts.get('qixiang_service_category_approval'),
    refundApi=artifacts.get('qixiang_refund_api_approval'),approvedMaxAmount=artifacts.get('qixiang_approved_max_amount'),
    canaryAuthorizationDigest=artifacts.get('canary_authorization'),
    appSession=artifacts.get('app_session_acceptance'),fulfillment=artifacts.get('real_fulfillment_acceptance'),
    reconciliation=artifacts.get('reconciliation_acceptance'),lotAccounting=artifacts.get('lot_accounting_acceptance');
  const metadata = new Map(evidenceRows.rows.map((row) => [row.kind, row.metadata]));
  const evidenceDigests = new Map(evidenceRows.rows.map((row) => [row.kind, row.evidence_digest]));
  const rotation = metadata.get('merchant_key_rotation'); const revocation = metadata.get('old_key_revocation');
  if (rotation?.newKeyFingerprint !== sha256(merchantKey) || rotation?.oldKeyFingerprint !== sha256(retiredKey)
    || revocation?.oldKeyFingerprint !== sha256(retiredKey)
    || evidenceDigests.get('merchant_entity_match')!==merchantEntity
    || evidenceDigests.get('domain_app_scene_approval')!==domainApp
    || evidenceDigests.get('service_category_approval')!==serviceCategory
    || evidenceDigests.get('refund_api_confirmation')!==refundApi
    || evidenceDigests.get('approved_max_amount')!==approvedMaxAmount
    || metadata.get('real_fulfillment_acceptance')?.acceptanceReportDigest !== fulfillment
    || metadata.get('reconciliation_acceptance')?.reportDigest !== reconciliation
    || metadata.get('lot_accounting_acceptance')?.testReportDigest !== lotAccounting
    || evidenceDigests.get('real_fulfillment_acceptance')!==fulfillment
    || evidenceDigests.get('reconciliation_acceptance')!==reconciliation
    || evidenceDigests.get('lot_accounting_acceptance')!==lotAccounting) {
    throw new Error('QIXIANG_DATABASE_EVIDENCE_ARTIFACT_BINDING_INVALID');
  }

  const issuedAt = new Date(); const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  const payload = {
    schemaVersion: 2, kind: 'qixiang_full_commerce_runtime_gate', phase,
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    configurationSha256: qixiangGateConfigurationDigest(env), releaseManifestSha256,
    database: databaseSnapshot.state,
    credentials: { merchantSha256: sha256(merchantKey), checkoutSha256: sha256(Buffer.from(checkoutKey,'base64')) },
    provider: { pid: '4611', currentKeyActive: true, accountActive: true, retiredKeyRejected: true,
      proofSha256: sha256(canonicalJson({ currentCode: currentProvider.code, pid: String(currentProvider.pid),
        active: currentProvider.active, retiredCode: retiredProvider.code, retiredMessage: retiredProvider.msg,
        checkedAt: issuedAt.toISOString() })) },
    approvals: { complianceManifestSha256: sha256(manifestBytes), domainAppScene: Boolean(domainApp),
      serviceCategory: Boolean(legal&&icp&&appFiling&&serviceCategory&&merchantEntity&&approvedMaxAmount
        &&canaryAuthorizationDigest),
      refundApi: Boolean(refundApi) },
    acceptance: { dedicatedProbeSubjectSha256: compliance.acceptance.dedicatedProbeSubjectSha256,
      appSessionReportSha256: appSession, fulfillmentReportSha256: fulfillment,
      reconciliationReportSha256: reconciliation, lotAccountingReportSha256: lotAccounting },
    canary:{topupId:compliance.acceptance.canaryTopupId,userId:compliance.acceptance.canaryUserId,
      subjectId:compliance.acceptance.canarySubjectId,amountCents:501},
  };
  if(phase==='bootstrap_canary'){
    payload.acceptance.fulfillmentReportSha256='0'.repeat(64);
    payload.acceptance.reconciliationReportSha256='0'.repeat(64);
    payload.acceptance.lotAccountingReportSha256='0'.repeat(64);
  }
  const signature = sign(null, Buffer.from(canonicalJson(payload)), signingKey).toString('base64');
  const report = { ...payload, signature: { algorithm: 'Ed25519', value: signature } };
  await mkdir(dirname(REPORT_PATH), { recursive: true, mode: 0o755 });
  const temporary = `${REPORT_PATH}.${process.pid}.tmp`; await rm(temporary, { force: true });
  const handle = await open(temporary, 'wx', 0o644);
  try { await handle.writeFile(`${JSON.stringify(report)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, REPORT_PATH);
  const directory = await open(dirname(REPORT_PATH), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  process.stdout.write(`PASS qixiang_production_gate\nReport: ${REPORT_PATH}\nExpires: ${expiresAt.toISOString()}\n`);
} finally {
  for (const bytes of Object.values(encrypted)) bytes.fill(0);
  merchantKey = ''; retiredKey = ''; checkoutKey = ''; signingKey = ''; probeAudit = '';
}
