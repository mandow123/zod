import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { AdminAuthService } from '../src/admin/auth-service.js';
import { PostgresAdminAuditStore } from '../src/admin/audit-store.js';
import { PostgresAdminIdentityStore } from '../src/admin/identity-store.js';
import { PostgresAdminLoginTransactionStore } from '../src/admin/login-transaction-store.js';
import { AdminProcessMetrics } from '../src/admin/metrics.js';
import { PostgresAdminRbacStore } from '../src/admin/rbac-store.js';
import type { AdminAuthRuntimeSettings } from '../src/admin/runtime.js';
import { PostgresAdminSessionStore } from '../src/admin/session-store.js';
import { databaseFingerprint } from '../src/backups/postgres.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { AppError } from '../src/errors.js';
import { KAI_OIDC_ISSUER } from '../src/identity/kai-oidc-constants.js';
import { OperationsService } from '../src/operations/service.js';
import { PostgresOperationsStore } from '../src/operations/store.js';
import { probeEvidenceDigest } from '../src/operations/probe-evidence.js';

const restoreInvariants = Object.fromEntries([
  'listing_capacity_invalid', 'order_amount_invalid', 'duplicate_success_payment', 'refund_amount_invalid',
  'kai_credit_transaction_unbalanced', 'kai_credit_account_negative', 'kai_credit_order_invalid',
  'kai_credit_reservation_invalid', 'kai_credit_listing_capacity_invalid', 'kai_credit_delivery_invalid',
  'kai_credit_acceptance_invalid', 'kai_credit_delivery_issue_invalid', 'kai_credit_mutual_refund_invalid',
  'kai_credit_supplier_settlement_invalid', 'kai_credit_dispute_adjudication_invalid',
  'kai_credit_post_acceptance_refund_invalid', 'kai_credit_post_acceptance_adjudication_invalid',
].map((key) => [key, '0']));

const adminSettings: AdminAuthRuntimeSettings = Object.freeze({
  webOrigin: 'https://admin.example.test',
  apiOrigin: 'https://admin-api.example.test',
  oidcClientId: 'admin-client',
  oidcClientSecret: 'admin-client-secret-unique',
  oidcRedirectUri: 'https://admin-api.example.test/admin/v1/auth/callback',
  oidcScopes: Object.freeze(['email', 'openid']),
  oidcGroupClaim: 'email',
  oidcGroupRoleMappings: Object.freeze([
    Object.freeze({ group: 'admin@example.test', roleCode: 'support_viewer' as const }),
  ]),
  oidcFlowPepper: 'f'.repeat(40),
  oidcSubjectPepper: 's'.repeat(40),
  oidcGroupPepper: 'g'.repeat(40),
  oidcTransactionEncryptionKey: Buffer.alloc(32, 21).toString('base64'),
  sessionTokenPepper: 't'.repeat(40),
  csrfTokenPepper: 'c'.repeat(40),
  piiEncryptionKey: Buffer.alloc(32, 22).toString('base64'),
  auditPepper: 'a'.repeat(40),
  loginTransactionTtlSeconds: 300,
  sessionIdleTtlSeconds: 1_800,
  sessionAbsoluteTtlSeconds: 28_800,
  sessionRotationSeconds: 900,
  previousTokenGraceSeconds: 10,
  reauthFreshnessSeconds: 300,
});

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

describe('protected operational monitoring', () => {
  it('counts stuck workflows without exposing customer records and exports authenticated metrics', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
      '0010_payment_recovery.sql',
      '0011_backup_audit.sql',
      '0060_admin_identity_rbac_sessions.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const capturedAt = new Date('2026-08-12T01:00:00.000Z');
    const old = new Date(capturedAt.getTime() - 25 * 60 * 60_000);
    const buyerId = randomUUID(); const supplierUserId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const listingId = randomUUID(); const orderId = randomUUID();
    const paymentId = randomUUID(); const refundId = randomUUID(); const disputeId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'buyer-secret', '买家'), ($2, 'supplier-secret', '供应商')`,
      [buyerId, supplierUserId],
    );
    await database.query(
      `INSERT INTO supplier_profiles(id, user_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, '凯云算力有限公司', '91310101MA1ABCDEF0', '负责人', 'approved')`, [supplierId, supplierUserId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 10, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO market_listings(id, resource_id, supplier_id, product_code, region, capacity_total, capacity_reserved,
         capacity_unit, unit_price_cents, minimum_quantity, status, starts_at, expires_at, sla)
       VALUES ($1, $2, $3, 'H100', '上海', 10, 1, 'GPU时', 12800, 1, 'active', $4, $5, '{}')`,
      [listingId, resourceId, supplierId, new Date(old.getTime() - 86_400_000), new Date(capturedAt.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO orders(id, order_number, buyer_id, supplier_id, listing_id, status, quantity, capacity_unit,
         unit_price_cents, subtotal_cents, total_cents, listing_snapshot, reservation_expires_at, updated_at)
       VALUES ($1, 'CP-OPS-01', $2, $3, $4, 'acceptance_pending', 1, 'GPU时', 12800, 12800, 12800, '{}', $5, $6)`,
      [orderId, buyerId, supplierId, listingId, old, old],
    );
    await database.query(
      `INSERT INTO capacity_reservations(id, order_id, listing_id, buyer_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'active', $5)`, [randomUUID(), orderId, listingId, buyerId, old],
    );
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, channel, status, amount_cents,
         expires_at, reconciliation_dead_lettered_at)
       VALUES ($1, $2, 'wechat', 'KP-OPS-01', 'app', 'pending', 12800, $3, $4)`,
      [paymentId, orderId, old, new Date(capturedAt.getTime() - 60_000)],
    );
    await database.query(
      `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status, updated_at)
       VALUES ($1, $2, $3, $4, 1000, '服务异常申请部分退款', 'provider_pending', $5)`,
      [refundId, orderId, buyerId, paymentId, old],
    );
    await database.query(
      `INSERT INTO disputes(id, order_id, opened_by, category, reason, status, evidence_deadline)
       VALUES ($1, $2, $3, 'service_unavailable', '服务持续不可用需要审核处理', 'evidence_pending', $4)`,
      [disputeId, orderId, buyerId, old],
    );
    await database.query(
      `INSERT INTO dispute_evidence(id, dispute_id, submitted_by, object_key, file_name, mime_type, size_bytes,
         sha256_digest, status, uploaded_at, retention_until)
       VALUES ($1, $2, $3, 'quarantine/ops/evidence.pdf', 'evidence.pdf', 'application/pdf', 100,
         $4, 'scan_failed', $5, $6)`,
      [randomUUID(), disputeId, buyerId, `sha256:${'a'.repeat(64)}`, old, new Date(capturedAt.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO invoices(id, order_id, user_id, invoice_type, invoice_title_ciphertext, email_ciphertext,
         amount_cents, status, processing_started_at)
       VALUES ($1, $2, $3, 'personal', 'encrypted-title', 'encrypted-email', 11800, 'processing', $4)`,
      [randomUUID(), orderId, buyerId, old],
    );
    await database.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload, available_at, created_at)
       VALUES ($1, 'test.pending', 'ORDER', $2, '{}', $3, $3),
              ($4, 'test.dead', 'ORDER', $5, '{}', $6, $6)`,
      [randomUUID(), orderId, old, randomUUID(), orderId, old],
    );
    await database.query(`UPDATE outbox_events SET dead_lettered_at = $2 WHERE topic = 'test.dead' AND aggregate_id = $1`, [orderId, old]);
    await database.query(
      `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id, payload_digest, created_at)
       VALUES ($1, $2, 'user', 'OPS_TEST', 'ORDER', $3, 'digest', $4)`,
      [randomUUID(), buyerId, orderId, new Date(capturedAt.getTime() - 60_000)],
    );

    const adminIdentityId = randomUUID();
    const activeAdminSessionId = randomUUID();
    const revokedAdminSessionId = randomUUID();
    await database.query(
      `INSERT INTO admin_identities(id, issuer, subject_hash, display_name, email_ciphertext, status)
       VALUES ($1, 'https://auth.kai.com', $2, 'Metrics Admin', 'admin-secret@example.test', 'active')`,
      [adminIdentityId, 's'.repeat(128)],
    );
    await database.query(
      `INSERT INTO admin_sessions(id, admin_identity_id, token_hash, csrf_token_hash, status,
         authz_version_at_issue, permission_definition_version, permission_snapshot_digest,
         created_at, last_seen_at, idle_expires_at, absolute_expires_at,
         revoked_at, revocation_reason_code, created_ip_hash, last_ip_hash, user_agent_hash)
       VALUES
         ($1, $2, $3, $4, 'active', 1, 'admin-permissions-v1', $5,
          $6, $6, $7, $8, NULL, NULL, $9, $9, $10),
         ($11, $2, $12, $13, 'revoked', 1, 'admin-permissions-v1', $5,
          $6, $6, $7, $8, $14, 'LOGOUT', $9, $9, $10)`,
      [activeAdminSessionId, adminIdentityId, 'a'.repeat(128), 'b'.repeat(128), 'p'.repeat(128),
        new Date(capturedAt.getTime() - 2 * 60 * 60_000), new Date(capturedAt.getTime() + 30 * 60_000),
        new Date(capturedAt.getTime() + 6 * 60 * 60_000), 'i'.repeat(64), 'u'.repeat(64),
        revokedAdminSessionId, 'r'.repeat(128), 'c'.repeat(128), new Date(capturedAt.getTime() - 60 * 60_000)],
    );
    const auditTime = new Date(capturedAt.getTime() - 30 * 60_000);
    const loginAudit = new PostgresAdminAuditStore(database, adminSettings.auditPepper);
    const failedLoginProducer = new AdminAuthService(
      new PostgresAdminIdentityStore(database),
      new PostgresAdminRbacStore(database),
      new PostgresAdminSessionStore(database, { previousTokenGraceMs: 10_000 }),
      new PostgresAdminLoginTransactionStore(database),
      loginAudit,
      {
        exchange: async () => {
          throw new AppError('AUTH_KAI_UPSTREAM_UNAVAILABLE', 502, '统一身份服务暂时不可用。');
        },
        userInfoWithClaims: async () => ({
          profile: { subject: 'unused', displayName: null, email: null, emailVerified: false },
          claims: {},
        }),
      },
      { verifyWithClaims: async () => { throw new Error('verifier must not run'); } },
      adminSettings,
    );
    const failedLoginContext = {
      requestId: 'producer-request-id-must-not-be-exported',
      ip: '192.0.2.10',
      userAgent: 'metrics-test-browser',
      now: auditTime,
    };
    const failedLogin = await failedLoginProducer.startLogin('/', failedLoginContext);
    const failedLoginAuthorization = new URL(failedLogin.authorizationUrl);
    await expect(failedLoginProducer.completeLogin({
      state: failedLoginAuthorization.searchParams.get('state')!,
      code: 'upstream-failure-code',
      issuer: KAI_OIDC_ISSUER,
      providerError: undefined,
      browserBindingToken: failedLogin.browserBindingToken,
    }, failedLoginContext)).rejects.toMatchObject({ code: 'ADMIN_LOGIN_FAILED' });
    expect(await loginAudit.recent(10)).toContainEqual(expect.objectContaining({
      action: 'admin.auth.login.failed',
      outcome: 'failed',
      errorCode: 'AUTH_KAI_UPSTREAM_UNAVAILABLE',
    }));
    for (const [action, outcome] of [
      ['admin.auth.login.succeeded', 'succeeded'],
      ['admin.auth.login.failed', 'denied'],
      ['admin.auth.origin.denied', 'denied'],
      ['admin.order.read', 'failed'],
    ] as const) {
      await database.query(
        `INSERT INTO admin_audit_events(id, occurred_at, admin_identity_id, admin_session_id,
           permission_snapshot_digest, action, request_id, outcome, error_code, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'sensitive-request-id-123', $7,
           CASE WHEN $7 = 'succeeded' THEN NULL ELSE 'ADMIN_TEST_OUTCOME' END, '{}'::jsonb)`,
        [randomUUID(), auditTime, adminIdentityId, activeAdminSessionId, 'd'.repeat(128), action, outcome],
      );
    }
    await database.query(
      `INSERT INTO admin_audit_events(id, occurred_at, permission_snapshot_digest, action, request_id, outcome)
       VALUES ($1, $2, $3, 'admin.auth.login.failed', 'old-request-id', 'denied')`,
      [randomUUID(), new Date(capturedAt.getTime() - 25 * 60 * 60_000), 'o'.repeat(128)],
    );

    const token = 'metrics-token-'.padEnd(48, 'x');
    const auditPepper = 'operations-readiness-audit-pepper-2026';
    const databaseUrl = 'postgresql://prod/prod-inquiry';
    const config = loadConfig({ NODE_ENV: 'test', METRICS_BEARER_TOKEN: token, DATABASE_URL: databaseUrl,
      AUDIT_PEPPER: auditPepper, PUBLIC_ORIGIN:'https://cloudpay.kai.com' });
    const adminMetrics = new AdminProcessMetrics();
    adminMetrics.recordAuditAppendFailure();
    adminMetrics.recordAuditAppendFailure();
    adminMetrics.recordHttp5xx();
    const service = new OperationsService(
      new PostgresOperationsStore(database), config, () => capturedAt, adminMetrics, async()=>true,
    );
    expect(await service.inquiryReleaseReadiness()).toEqual({
      ready: false, backup: { ready: false }, restore: { ready: false }, kaiPaired: { ready: false },appSession:{ready:false},
      durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,disasterRecovery:false,riskAccepted:true},blockers: [
        'LOCAL_BACKUP_ARTIFACT_24H', 'RESTORE_DRILL_SUCCESS_90D','KAI_PAIRED_PROBE_30M','APP_STORED_SESSION_PROBE_24H',
      ],
    });
    // Empty success shells must not satisfy production readiness.
    await database.query(`INSERT INTO backup_runs(id,status,artifact_name,started_at,completed_at)
      VALUES($1,'succeeded','inquiry-backup.enc',$2,$2)`, [randomUUID(), new Date(capturedAt.getTime() - 60_000)]);
    await database.query(`INSERT INTO restore_drills(id,backup_artifact_name,target_fingerprint,status,started_at,completed_at)
      VALUES($1,'inquiry-backup.enc','isolated-restore','succeeded',$2,$2)`,
    [randomUUID(), new Date(capturedAt.getTime() - 120_000)]);
    expect((await service.inquiryReleaseReadiness()).ready).toBe(false);
    const completedAt = new Date(capturedAt.getTime() - 60_000);
    await database.query(`INSERT INTO backup_runs(id,status,artifact_name,object_key,encrypted_size_bytes,
      encrypted_sha256_digest,schema_version,started_at,completed_at)
      VALUES($1,'succeeded','cloudpay-postgres-invalid-target.kcpb','local://cloudpay-postgres-invalid-target.kcpb',2048,$2,
      '0065_credit_order_transition_closure.sql',$3,$3)`, [randomUUID(), `sha256:${'e'.repeat(64)}`, completedAt]);
    await database.query(`INSERT INTO restore_drills(id,backup_artifact_name,target_fingerprint,status,schema_version,
      verified_invariants,started_at,completed_at) VALUES($1,'cloudpay-postgres-invalid-target.kcpb',$2,'succeeded',
      '0065_credit_order_transition_closure.sql',$3::jsonb,$4,$4)`,
    [randomUUID(), databaseFingerprint(databaseUrl), JSON.stringify(restoreInvariants), completedAt]);
    expect((await service.inquiryReleaseReadiness()).restore.ready).toBe(false);
    const missingInvariant = { ...restoreInvariants };
    delete missingInvariant.kai_credit_transaction_unbalanced;
    await database.query(`INSERT INTO restore_drills(id,backup_artifact_name,target_fingerprint,status,schema_version,
      verified_invariants,started_at,completed_at) VALUES($1,'cloudpay-postgres-invalid-target.kcpb','isolated-missing-invariant','succeeded',
      '0065_credit_order_transition_closure.sql',$2::jsonb,$3,$3)`,
    [randomUUID(), JSON.stringify(missingInvariant), completedAt]);
    expect((await service.inquiryReleaseReadiness()).restore.ready).toBe(false);
    const validBackupId=randomUUID(),validArtifact='cloudpay-postgres-20260821T020000Z-valid000.kcpb',validDigest=`sha256:${'b'.repeat(64)}`;
    await database.query(`INSERT INTO backup_runs(id,status,artifact_name,object_key,encrypted_size_bytes,
      encrypted_sha256_digest,schema_version,started_at,completed_at)
      VALUES($1,'succeeded',$2,$3,2048,$4,'0065_credit_order_transition_closure.sql',$5,$5)`,
    [validBackupId,validArtifact,`local://${validArtifact}`,validDigest,completedAt]);
    await database.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata,created_at)
      VALUES($1,NULL,'system','DATABASE_BACKUP_COMPLETED','BACKUP_RUN',$2,$3,$4::jsonb,$5)`,[randomUUID(),validBackupId,
      validDigest.slice(7),JSON.stringify({artifactName:validArtifact,objectKey:`local://${validArtifact}`,sizeBytes:2048,
        schemaVersion:'0065_credit_order_transition_closure.sql',databaseFingerprint:databaseFingerprint(databaseUrl),
        durability:'local_only',offsite:false}),completedAt]);
    await database.query(`INSERT INTO restore_drills(id,backup_artifact_name,target_fingerprint,status,schema_version,
      verified_invariants,started_at,completed_at) VALUES($1,$2,$3,'succeeded',
      '0065_credit_order_transition_closure.sql',$4::jsonb,$5,$5)`,
    [randomUUID(),validArtifact, `${databaseFingerprint(databaseUrl)}-isolated`, JSON.stringify(restoreInvariants), completedAt]);
    const common = { profile: 'inquiry_only', probeVersion: 1,
      schemaVersion: '0065_credit_order_transition_closure.sql', databaseFingerprint: databaseFingerprint(databaseUrl) };
    const kaiMetadata = { ...common,producer:'record-inquiry-readiness.mjs@2',publicOrigin: 'https://cloudpay.kai.com',
      probeSubjectSha256:'f'.repeat(64),
        probeOrigin: 'https://cloudpay.kai.com', commerceStateDigest: `sha256:${'d'.repeat(64)}`, me: true,
        legal: true, consent: true, subjects: true, subjectSelection: true, formalInquiry: true, cancel: true,
        commerceUnchanged: true };
    const appMetadata={...common,producer:'record-inquiry-app-session.mjs@1',publicOrigin:'https://cloudpay.kai.com',
      packageName:'com.kaicloud.marketplace',appVersion:'1.0.0',apkSha256Digest:`sha256:${'e'.repeat(64)}`,
      reportSha256Digest:`sha256:${'f'.repeat(64)}`,auth:true,me:true,legalConsent:true,storedSession:true,
      forceStopRestart:true,recoveredSession:true};
    await database.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata,created_at)
      VALUES($1,NULL,'system','INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED','PRODUCTION_READINESS_PROBE',$2,'forged',$3::jsonb,$4),
      ($5,NULL,'system','INQUIRY_ONLY_APP_SESSION_PROBE_PASSED','PRODUCTION_READINESS_PROBE',$2,'forged',$6::jsonb,$4)`, [
      randomUUID(), randomUUID(), JSON.stringify(kaiMetadata), new Date(completedAt.getTime()-60_000),
      randomUUID(), JSON.stringify(appMetadata),
    ]);
    const forged = await service.inquiryReleaseReadiness();
    expect(forged.kaiPaired.ready).toBe(false);
    expect(forged.appSession.ready).toBe(false);
    await database.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata,created_at)
      VALUES($1,NULL,'system','INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED','PRODUCTION_READINESS_PROBE',$2,$3,$4::jsonb,$5),
      ($6,NULL,'system','INQUIRY_ONLY_APP_SESSION_PROBE_PASSED','PRODUCTION_READINESS_PROBE',$2,$7,$8::jsonb,$5)`, [
      randomUUID(), randomUUID(), probeEvidenceDigest(kaiMetadata,auditPepper), JSON.stringify(kaiMetadata),
      completedAt, randomUUID(), probeEvidenceDigest(appMetadata,auditPepper), JSON.stringify(appMetadata),
    ]);
    expect(await service.inquiryReleaseReadiness()).toEqual({ ready: true, backup: { ready: true },
      restore: { ready: true }, kaiPaired: { ready: true },appSession:{ready:true},
      durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,disasterRecovery:false,riskAccepted:true},blockers: [] });
    const operator: AccountPrincipal = { userId: randomUUID(), sessionId: randomUUID(), role: 'operator' };
    const summary = await service.summary(operator);
    expect(summary).toMatchObject({
      status: 'critical', counts: {
        paymentPending: 1, paymentOverdue: 1, paymentDeadLetters: 1,
        refundProviderPendingStale: 1, outboxPending: 1, outboxDeadLetters: 1,
        evidenceScanFailed: 1, disputesReadyForReview: 1, deliveryStale: 1,
        reservationOverdue: 1, invoiceProcessingStale: 1, auditEvents24h: 6,
        adminLoginSucceeded24h: 1, adminLoginDenied24h: 1, adminLoginFailed24h: 1,
        adminSecurityDenials24h: 1, adminOperationFailures24h: 2,
        adminActiveSessions: 1, adminRevokedSessions24h: 1,
      },
    });
    await expect(service.summary({ ...operator, role: 'member' })).rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });

    const app = await buildApp({ config, database, operationsService: service, logger: false });
    const denied = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('cloudpay_operational_items{kind="payment_dead_letters"} 1');
    expect(response.body).toContain('cloudpay_operational_health 0');
    expect(response.body).toContain('cloudpay_admin_login_events_24h{result="succeeded"} 1');
    expect(response.body).toContain('cloudpay_admin_login_events_24h{result="denied"} 1');
    expect(response.body).toContain('cloudpay_admin_login_events_24h{result="failed"} 1');
    expect(response.body).toContain('cloudpay_admin_security_denials_24h 1');
    expect(response.body).toContain('cloudpay_admin_operation_failures_24h 2');
    expect(response.body).toContain('cloudpay_admin_audit_append_failures_total 2');
    expect(response.body).toContain('cloudpay_admin_http_5xx_total 1');
    expect(response.body).toContain('cloudpay_admin_active_sessions 1');
    expect(response.body).toContain('cloudpay_admin_revoked_sessions_24h 1');
    expect(response.body).not.toContain('buyer-secret');
    expect(response.body).not.toContain('admin-secret@example.test');
    expect(response.body).not.toContain('sensitive-request-id-123');
    expect(response.body).not.toContain('ADMIN_TEST_OUTCOME');
    await app.close();
    await database.close();
  });
});
