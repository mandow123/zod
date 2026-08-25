import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const app = read('deploy/kubernetes/app.yaml');
const adminApp = read('deploy/kubernetes/admin-app.yaml');
const adminCanary = read('deploy/kubernetes/admin-api-canary.yaml');
const migration = read('deploy/kubernetes/migrate-job.yaml');
const backupCronjob = read('deploy/kubernetes/backup-cronjob.yaml');
const kubernetesGuide = read('deploy/kubernetes/README.md');
const adminRunbook = read('../docs/admin-production-runbook.md');
const adminRoutingContract = JSON.parse(read('deploy/kubernetes/admin-routing-contract.json'));
const adminRoutingVerifier = read('deploy/kubernetes/verify-admin-routing.mjs');
const adminMonitoring = read('deploy/kubernetes/admin-monitoring.yaml');
const backendPackage = JSON.parse(read('package.json'));
const environmentExample = read('.env.example');
const json = (name) => JSON.parse(read(name));
const direct = 'deploy/direct-ubuntu';
const topology = json(`${direct}/topology.json`);
const nginx = read(`${direct}/cloudpay-mobile-nginx-routes.conf`);
const socket = read(`${direct}/cloudpay-mobile-edge.socket`);
const relay = read(`${direct}/cloudpay-mobile-edge.service`);
const firewall = read(`${direct}/cloudpay-mobile-edge.nft`);
const firewallService = read(`${direct}/cloudpay-mobile-edge-firewall.service`);
const backend = read(`${direct}/cloudpay-mobile-backend.service`);
const migrate = read(`${direct}/cloudpay-mobile-migrate.service`);
const backupService = read(`${direct}/cloudpay-mobile-backup.service`);
const backupTimer = read(`${direct}/cloudpay-mobile-backup.timer`);
const sidecarPreflight = read(`${direct}/preflight-sidecar.mjs`);
const originPreflight = read(`${direct}/preflight-origin.mjs`);
const sidecarVerifier = read(`${direct}/verify-sidecar.mjs`);
const nginxVerifier = read(`${direct}/verify-nginx-config.mjs`);
const routingVerifier = read(`${direct}/verify-routing.mjs`);
const rollbackVerifier = read(`${direct}/verify-rollback.mjs`);
const watchdog = read(`${direct}/cutover-watchdog.mjs`);
const acceptancePolicy = read(`${direct}/acceptance-watchdog-policy.mjs`);
const watchdogUnit = read(`${direct}/cloudpay-mobile-cutover-watchdog.service`);
const pairedProbeUnit = read(`${direct}/cloudpay-mobile-paired-probe.service`);
const pairedProbeTimer = read(`${direct}/cloudpay-mobile-paired-probe.timer`);
const pairedProbeRevoke = read(`${direct}/cloudpay-mobile-paired-probe-revoke.service`);
const pairedProbeSystemdVerifier = read(`${direct}/verify-paired-probe-systemd.mjs`);
const probeStaticProvision = read(`${direct}/provision-probe-static-credentials.mjs`);
const probeStaticVerify = read(`${direct}/verify-probe-static-credentials.mjs`);
const probeRefreshEnrollHost = read(`${direct}/enroll-probe-refresh-credential.mjs`);
const probeRefreshAuthorize = read('scripts/authorize-and-enroll-kai-probe.mjs');
const fullCommerceDropIn = read(`${direct}/cloudpay-mobile-backend-commerce-credentials.conf`);
const fullCommerceCore = read(`${direct}/full-commerce-gate-core.mjs`);
const qixiangEvidenceVerifier = read(`${direct}/verify-qixiang-production-evidence.mjs`);
const qixiangEvidenceCore = read(`${direct}/qixiang-production-evidence-core.mjs`);
const qixiangTrustPolicy = read(`${direct}/qixiang-evidence-trust-policy.mjs`);
const fullCommercePreflight = read(`${direct}/preflight-full-commerce.mjs`);
const qixiangCredentialEnroll = read(`${direct}/enroll-qixiang-commerce-credentials.mjs`);
const fullCommerceRuntimeAssert = read(`${direct}/assert-full-commerce-runtime.mjs`);
const fullCommerceGateRefreshService = read(`${direct}/cloudpay-mobile-qixiang-gate-refresh.service`);
const fullCommerceGateRefreshTimer = read(`${direct}/cloudpay-mobile-qixiang-gate-refresh.timer`);
const pairedProbeRunner = read('scripts/run-inquiry-readiness-systemd.mjs');
const pairedProbeRotator = read('scripts/rotate-kai-probe-credential.mjs');
const pairedProbePersist = read('scripts/persist-kai-probe-refresh.mjs');
const pairedProbeRevokePrepare = read('scripts/prepare-kai-probe-revocation.mjs');
const pairedProbeRevoker = read('scripts/revoke-kai-probe-family.mjs');
const pairedProbeFinalizer = read('scripts/finalize-kai-probe-revocation.mjs');
const probe = read(`${direct}/probe-inquiry.mjs`);
const packageJson = json('package.json');
const bundle = read('scripts/build-deployment-bundle.mjs');
const dockerfile = read('Dockerfile');
const systemdBackend = read('deploy/aws-ubuntu/cloudpay-mobile-backend.service');

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
const missingFrom = (source, names) => names.filter((name) => !new RegExp(`^${name}=`, 'mu').test(source));

const minimalProduction = {
  NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '4100', PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
};
const readiness = loadConfig(minimalProduction).readiness;
const variableName = (blocker) => blocker.match(/^[A-Z][A-Z0-9_]*/u)?.[0];
const syntheticCapabilityBlockers = new Set([
  'KAI_CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED',
  'COMPUTE_PROVIDER_NOT_CONFIGURED',
  'ICP_FILING_NOT_APPROVED',
  'APP_FILING_NOT_APPROVED',
  'INTERNET_SERVICE_CLASSIFICATION_REQUIRED',
]);
const requiredServiceVariables = [...new Set([
  ...readiness.releaseBlockers.map(variableName).filter(Boolean),
  ...readiness.capabilities.computeProvider.missing.map(variableName).filter(Boolean),
])].filter((name) => !syntheticCapabilityBlockers.has(name));
const providerVariables = [...new Set([
  ...readiness.capabilities.alipay.missing,
  ...readiness.capabilities.wechat.missing,
].map(variableName).filter(Boolean))];
const documentedVariables = [...new Set([...requiredServiceVariables, ...providerVariables])];
const exampleMissing = missingFrom(environmentExample, documentedVariables);
check('environment_example_complete', exampleMissing.length === 0,
  exampleMissing.length ? exampleMissing.join(', ') : `${documentedVariables.length} variables`);
const configMapVariables = [...app.matchAll(/^  ([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]);
const uncoveredVariables = documentedVariables.filter((name) =>
  !configMapVariables.includes(name)
    && !kubernetesGuide.includes(`\`${name}\``)
    && !new RegExp(`^${name}=`, 'mu').test(environmentExample));
check('kubernetes_configuration_contract_documented', uncoveredVariables.length === 0,
  uncoveredVariables.length ? uncoveredVariables.join(', ')
    : `${configMapVariables.length} public settings plus externally supplied Secret variables`);
const imagePattern = /image:\s+(\S+@sha256:[a-f0-9]{64})/gu;
const images = [app, migration, backupCronjob]
  .flatMap((source) => [...source.matchAll(imagePattern)].map((match) => match[1]));
check('immutable_image_contract', images.length === 3 && new Set(images).size === 1,
  images.length === 3 ? `${new Set(images).size} unique digest(s)` : `${images.length}/3 images`);

check('authoritative_two_host_topology', topology.publicOrigin === 'https://cloudpay.kai.com'
  && topology.legacyOrigin?.publicIpv4 === '18.163.148.84' && topology.legacyOrigin?.privateIpv4 === '172.31.33.227'
  && topology.legacyOrigin?.port === 8081 && topology.mobileSidecar?.privateIpv4 === '172.31.31.78'
  && topology.mobileSidecar?.edgePort === 4154 && topology.mobileSidecar?.loopbackHost === '127.0.0.1'
  && topology.mobileSidecar?.loopbackPort === 4100 && topology.cloudKaiComChangesAllowed === false,
  '18 origin -> 43 private:4154 -> loopback:4100; cloud.kai.com immutable');

const expectedRoutes = ['/mobile/v1', '/mobile/v1/*', '/payments/qixiang/return', '/privacy', '/terms',
  '/inquiry-terms', '/account/delete'];
check('exact_route_allowlist', JSON.stringify(topology.forwardOnly) === JSON.stringify(expectedRoutes)
  && JSON.stringify(topology.preserveExactly) === JSON.stringify(['/', '/api/*']),
  `${topology.forwardOnly?.length ?? 0} routes; legacy root and /api preserved`);

const locationHeaders = [...nginx.matchAll(/^location\s+([^\n{]+)\{/gmu)].map((match) => match[1].trim());
const expectedLocations = ['= /mobile/v1', '= /mobile/v1/credits/topups/qixiang/notify',
  '= /mobile/v1/auth/kai/callback', '^~ /mobile/v1/', '= /payments/qixiang/return',
  '= /privacy', '= /terms', '= /inquiry-terms', '= /account/delete'];
const proxyCount = (nginx.match(/proxy_pass http:\/\/172\.31\.31\.78:4154;/gu) ?? []).length;
check('nginx_exact_private_forwarding', JSON.stringify(locationHeaders) === JSON.stringify(expectedLocations)
  && proxyCount === 9 && !/\brewrite\b/u.test(nginx) && !/^location[^\n]+\/api/gmu.test(nginx)
  && !nginx.includes('/internal/metrics') && !/\bserver_name\s+[^;]*cloud\.kai\.com/u.test(nginx),
  `${locationHeaders.length} exact/prefix locations, ${proxyCount} private proxy targets`);
check('nginx_canonical_headers_and_xff_cleaning',
  (nginx.match(/proxy_set_header Host cloudpay\.kai\.com;/gu) ?? []).length === 9
    && (nginx.match(/proxy_set_header X-Forwarded-Host cloudpay\.kai\.com;/gu) ?? []).length === 9
    && (nginx.match(/proxy_set_header X-Forwarded-Proto https;/gu) ?? []).length === 9
    && (nginx.match(/set_real_ip_from 172\.31\.0\.0\/16;/gu) ?? []).length === 9
    && (nginx.match(/real_ip_header X-Forwarded-For;/gu) ?? []).length === 9
    && (nginx.match(/real_ip_recursive on;/gu) ?? []).length === 9
    && (nginx.match(/proxy_set_header X-Forwarded-For \$remote_addr;/gu) ?? []).length === 9
    && !nginx.includes('$http_x_forwarded_for')
    && (nginx.match(/add_header Cache-Control "no-store" always;/gu) ?? []).length === 9
    && (nginx.match(/access_log off;/gu) ?? []).length === 2
    && !/\$(?:request_uri|args)\b/u.test(nginx),
  'fixed host/proto, untrusted XFF discarded, API caching disabled');

const adminPublicConfiguration = {
  ADMIN_AUTH_ENABLED: '"false"',
  ADMIN_WEB_ORIGIN: 'https://admin.kai.com',
  ADMIN_API_ORIGIN: 'https://admin-api.kai.com',
  ADMIN_OIDC_REDIRECT_URI: 'https://admin-api.kai.com/admin/v1/auth/callback',
  ADMIN_OIDC_SCOPE: 'openid email',
  ADMIN_OIDC_GROUP_CLAIM: 'email',
  ADMIN_LOGIN_TRANSACTION_TTL_SECONDS: '"300"',
  ADMIN_SESSION_IDLE_TTL_SECONDS: '"1800"',
  ADMIN_SESSION_ABSOLUTE_TTL_SECONDS: '"28800"',
  ADMIN_SESSION_ROTATION_SECONDS: '"900"',
  ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS: '"30"',
  ADMIN_REAUTH_FRESHNESS_SECONDS: '"300"',
};
const missingAdminPublicConfiguration = Object.entries(adminPublicConfiguration)
  .filter(([name, value]) => !app.includes(`  ${name}: ${value}`))
  .map(([name]) => name);
check('admin_auth_staged_disabled_with_canonical_public_configuration',
  missingAdminPublicConfiguration.length === 0,
  missingAdminPublicConfiguration.length ? missingAdminPublicConfiguration.join(', ')
    : 'explicitly disabled with isolated HTTPS origins, callback, scope and bounded TTLs');

const adminSecretVariables = [
  'ADMIN_OIDC_CLIENT_ID', 'ADMIN_OIDC_CLIENT_SECRET', 'ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON',
  'ADMIN_OIDC_FLOW_PEPPER', 'ADMIN_OIDC_SUBJECT_PEPPER', 'ADMIN_OIDC_GROUP_PEPPER',
  'ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY', 'ADMIN_SESSION_TOKEN_PEPPER', 'ADMIN_CSRF_TOKEN_PEPPER',
  'ADMIN_PII_ENCRYPTION_KEY', 'ADMIN_AUDIT_PEPPER',
];
const leakedAdminSecretConfiguration = adminSecretVariables.filter((name) =>
  new RegExp(`^  ${name}:`, 'mu').test(app));
const undocumentedAdminSecrets = adminSecretVariables.filter((name) => !kubernetesGuide.includes(`\`${name}\``));
check('admin_auth_secrets_are_external_and_documented',
  leakedAdminSecretConfiguration.length === 0 && undocumentedAdminSecrets.length === 0
    && /secretRef:\s*\n\s+name: cloudpay-admin-auth-secrets\s*\n\s+optional: true/u.test(app),
  leakedAdminSecretConfiguration.length
    ? `ConfigMap leak: ${leakedAdminSecretConfiguration.join(', ')}`
    : undocumentedAdminSecrets.length ? `undocumented: ${undocumentedAdminSecrets.join(', ')}`
      : 'optional stage-A External Secret reference; no administrator credentials in ConfigMap');

for (const [name, source] of [
  ['api', app], ['migration', migration], ['backup', backupCronjob],
]) {
  const hasConfig = /configMapRef:\s*\n\s+name: cloudpay-backend-config/u.test(source);
  const hasSecrets = /secretRef:\s*\n\s+name: cloudpay-backend-secrets/u.test(source);
  check(`${name}_receives_shared_configuration`, hasConfig && hasSecrets,
    `configMap=${String(hasConfig)}, secret=${String(hasSecrets)}`);
}

check('private_socket_and_exact_source_firewall', socket.includes('ListenStream=172.31.31.78:4154')
  && !socket.includes('0.0.0.0') && relay.includes('127.0.0.1:4100')
  && firewall.includes('ip saddr 172.31.33.227/32 counter accept')
  && firewall.includes('tcp dport 4154 counter drop') && !firewall.includes('172.31.0.0/16')
  && firewallService.includes('/etc/kai-cloudpay/cloudpay-mobile-edge.nft'),
  '4154 binds 43 private IP and only accepts the 18 private source');

for (const [name, unit] of [['backend', backend], ['migration', migrate], ['backup', backupService]]) {
  check(`${name}_hardened_service`, unit.includes('User=kai-cloudpay')
    && unit.includes('EnvironmentFile=/etc/kai-cloudpay/backend.env') && unit.includes('ProtectSystem=strict')
    && unit.includes('NoNewPrivileges=yes') && unit.includes('CapabilityBoundingSet=')
    && !/Environment=.*(?:SECRET|KEY|PASSWORD)=\S+/u.test(unit), 'dedicated unprivileged service with external 0600 environment');
}
check('migration_before_loopback_backend', backend.includes('Requires=cloudpay-mobile-migrate.service')
  && backend.includes('ExecStartPre=/usr/bin/node scripts/verify-production-env.mjs')
  && backend.includes('ExecStart=/usr/bin/node dist/server.js') && migrate.includes('ExecStart=/usr/bin/node dist/migrate.js'),
  '0065 migration gate before 127.0.0.1:4100 service');
check('local_encrypted_backup_schedule', backupService.includes('ExecStart=/usr/bin/node dist/backups/backup.js')
  && backupService.includes('ReadWritePaths=/var/lib/kai-cloudpay-backup')
  && backupTimer.includes('OnCalendar=*-*-* *:17:00') && backupTimer.includes('Persistent=yes'),
  'hourly local AES backup; no offsite claim');

check('sidecar_preflight_fails_closed', sidecarPreflight.includes("check('mobile_sidecar_private_identity'")
  && sidecarPreflight.includes("check('postgres_loopback_only'")
  && sidecarPreflight.includes("check('loopback_services_not_public'")
  && sidecarPreflight.includes("check('exact_source_firewall_installed'")
  && sidecarPreflight.includes("readyForMigrationAndSidecarStart: failures.length === 0")
  && sidecarPreflight.includes("flag: 'wx'"), 'identity, env, listeners, units, firewall and immutable report');
check('probe_static_credentials_two_phase_recoverable', probeStaticProvision.includes("'/usr/bin/flock'")
  && probeStaticProvision.includes("phase: 'prepared'")
  && probeStaticProvision.includes("phase: 'database_password_committed'")
  && probeStaticProvision.includes('await recoverPending()')
  && probeStaticProvision.includes('BEGIN;') && probeStaticProvision.includes('COMMIT;')
  && probeStaticVerify.includes('probe-static-credentials-verified.json')
  && sidecarPreflight.includes("check('recent_probe_static_credential_verification'")
  && sidecarPreflight.includes('staticVerifyAge>=-5*60_000')
  && sidecarPreflight.includes('credentialSha256?.database===databaseCredentialDigest'),
  'serialized two-phase rotation, crash recovery and digest-bound <=24h verification evidence');
check('probe_refresh_enrollment_is_memory_only_create_once', probeRefreshEnrollHost.includes("process.stdin")
  && probeRefreshEnrollHost.includes("'--with-key=host'")
  && probeRefreshEnrollHost.includes('KAI_PROBE_REFRESH_CREDENTIAL_ALREADY_EXISTS')
  && probeRefreshEnrollHost.includes('await rename(temporary, TARGET)')
  && !probeRefreshEnrollHost.includes('process.env.')
  && probeRefreshAuthorize.includes("prompt: 'login'")
  && probeRefreshAuthorize.includes('verifyKaiProbeTokenPair')
  && probeRefreshAuthorize.includes('refreshKaiProbeTokens(initial.state)')
  && probeRefreshAuthorize.includes("child.stdin.end(stdin)")
  && !probeRefreshAuthorize.includes('refreshToken]')
  && packageJson.scripts['production:probe-refresh:authorize-enroll']?.includes('authorize-and-enroll-kai-probe.mjs'),
  'dedicated-account PKCE login validates and rotates before stdin-only host encryption');
check('full_commerce_requires_signed_short_lived_runtime_gate',
  fullCommerceDropIn.includes('LoadCredentialEncrypted=qixiang-merchant-key:')
    && fullCommerceDropIn.includes('LoadCredentialEncrypted=qixiang-checkout-key:')
    && fullCommerceDropIn.includes('LoadCredentialEncrypted=qixiang-gate-verification-public:')
    && fullCommerceDropIn.includes('ReadOnlyPaths=/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json')
    && fullCommerceDropIn.includes('ExecStartPre=+/usr/bin/node')
    && !fullCommerceDropIn.includes('Environment=')
    && fullCommerceCore.includes("env.ICP_FILING_DOMAIN !== 'cloudpay.kai.com'")
    && fullCommerceCore.includes("env.APP_FILING_PACKAGE !== 'com.kaicloud.marketplace'")
    && fullCommerceCore.includes("'PLAINTEXT_QIXIANG_SECRET_IN_ENV'")
    && qixiangEvidenceVerifier.includes('QIXIANG_CURRENT_KEY_LIVE_PROOF_FAILED')
    && qixiangEvidenceVerifier.includes('QIXIANG_RETIRED_KEY_STILL_ACTIVE')
    && qixiangEvidenceCore.includes("value.code === -3 && value.msg === '商户密钥错误'")
    && qixiangTrustPolicy.includes('entry.evidenceKinds.includes(input.evidenceKind)')
    && qixiangEvidenceVerifier.includes('QIXIANG_DEDICATED_PROBE_SUBJECT_MISMATCH')
    && qixiangEvidenceVerifier.includes('QIXIANG_REAL_ACCEPTANCE_TOPUP_INVALID')
    && qixiangEvidenceVerifier.includes('signerPublicKeySha256')
    && qixiangEvidenceVerifier.includes("sign(null, Buffer.from(canonicalJson(payload)), signingKey)")
    && qixiangEvidenceVerifier.includes('RELEASE-MANIFEST.json')
    && qixiangCredentialEnroll.includes("process.stdin")
    && qixiangCredentialEnroll.includes("'--with-key=host'")
    && qixiangCredentialEnroll.includes("generateKeyPairSync('ed25519')")
    && qixiangCredentialEnroll.includes('await writeJournal(journal);await finalize(journal)')
    && qixiangCredentialEnroll.includes('QIXIANG_COMMERCE_CREDENTIAL_ALREADY_EXISTS')
    && !qixiangCredentialEnroll.includes('process.env.')
    && fullCommercePreflight.includes("gate.readiness('create')")
    && fullCommercePreflight.includes("gate.readiness('refund')")
    && fullCommerceRuntimeAssert.includes('await gate.requireStartup()')
    && fullCommerceRuntimeAssert.includes('databaseStateLoader: () => qixiangDatabaseGateState')
    && fullCommerceGateRefreshService.includes('verify-qixiang-production-evidence.mjs --report /var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json')
    && fullCommerceGateRefreshService.includes('StateDirectory=kai-cloudpay-public-gates')
    && fullCommerceGateRefreshTimer.includes('OnUnitActiveSec=5min')
    && packageJson.scripts['production:full-commerce:preflight']?.includes('preflight-full-commerce.mjs'),
  'live key rotation, exact release/config/database evidence and one signed <=10m gate bind startup, create and refund');
check('origin_preflight_uses_private_source_and_fresh_dual_baseline', originPreflight.includes("ORIGIN_PRIVATE_IP = '172.31.33.227'")
  && originPreflight.includes("SIDECAR = 'http://172.31.31.78:4154'")
  && originPreflight.includes("same_time_public_direct_root_baseline")
  && originPreflight.includes("same_time_public_direct_api_baseline")
  && originPreflight.includes('baselineAge >= -5 * 60_000')
  && originPreflight.includes('allowExpectedPublicProofBlockers: true')
  && originPreflight.includes("ACTIVE_CONFIG = '/home/ubuntu/kai-transaction-v1/nginx-kai.conf'")
  && originPreflight.includes("EDGE_CONTAINER = 'kai-transaction-edge'")
  && originPreflight.includes("CONTAINER_CONFIG = '/etc/nginx/nginx.conf'")
  && originPreflight.includes("check('legacy_config_bind_mount_read_only'")
  && originPreflight.includes("check('nginx_realip_module_available'")
  && originPreflight.includes('readyForNginxRouteActivation: failures.length === 0'),
  '18 private identity, current baseline and pre-cutover sidecar proof');
check('nginx_candidate_preserves_legacy_and_cloud_kai', nginxVerifier.includes('existing / or /api location bytes changed')
  && nginxVerifier.includes('cloud.kai.com server bytes changed') && nginxVerifier.includes('readyForNginxReload')
  && nginxVerifier.includes("flag: 'wx'"), 'before/candidate protected block comparison');

const adminWebImages = [...adminApp.matchAll(imagePattern)].map((match) => match[1]);
check('admin_web_uses_independent_immutable_image',
  adminWebImages.length === 1 && adminWebImages[0]?.startsWith('registry.example.invalid/kai/cloudpay-admin-web@sha256:'),
  adminWebImages.length === 1 ? adminWebImages[0] : `${adminWebImages.length}/1 images`);

const adminCanaryImages = [...adminCanary.matchAll(imagePattern)].map((match) => match[1]);
check('admin_api_canary_uses_main_backend_image',
  adminCanaryImages.length === 1 && images.length === 3 && adminCanaryImages[0] === images[0],
  adminCanaryImages.length === 1
    ? `${adminCanaryImages[0] === images[0] ? 'same' : 'different'} immutable digest`
    : `${adminCanaryImages.length}/1 images`);

check('admin_api_canary_is_single_replica_isolated_and_fail_closed',
  /kind: Deployment/u.test(adminCanary)
    && /name: cloudpay-admin-api-canary/u.test(adminCanary)
    && /replicas: 1/u.test(adminCanary)
    && /type: Recreate/u.test(adminCanary)
    && (adminCanary.match(/app\.kubernetes\.io\/name: cloudpay-admin-api-canary/gu)?.length ?? 0) >= 4
    && !/^\s+app\.kubernetes\.io\/name: cloudpay-backend\s*$/mu.test(adminCanary)
    && /name: ADMIN_AUTH_ENABLED\s*\n\s+value: "true"/u.test(adminCanary)
    && /configMapRef:\s*\n\s+name: cloudpay-backend-config/u.test(adminCanary)
    && /secretRef:\s*\n\s+name: cloudpay-backend-secrets/u.test(adminCanary)
    && /secretRef:\s*\n\s+name: cloudpay-admin-auth-secrets/u.test(adminCanary)
    && !/name: cloudpay-admin-auth-secrets\s*\n\s+optional: true/u.test(adminCanary)
    && /serviceAccountName: cloudpay-backend/u.test(adminCanary)
    && /automountServiceAccountToken: false/u.test(adminCanary)
    && /runAsNonRoot: true/u.test(adminCanary)
    && /runAsUser: 1000/u.test(adminCanary)
    && /runAsGroup: 1000/u.test(adminCanary)
    && /readOnlyRootFilesystem: true/u.test(adminCanary)
    && /allowPrivilegeEscalation: false/u.test(adminCanary)
    && /drop: \["ALL"\]/u.test(adminCanary)
    && /requests:\s*\n\s+cpu: 250m\s*\n\s+memory: 384Mi/u.test(adminCanary)
    && (adminCanary.match(/path: \/mobile\/v1\/health/gu)?.length ?? 0) === 2
    && (adminCanary.match(/path: \/mobile\/v1\/readiness/gu)?.length ?? 0) === 1
    && /kind: Service/u.test(adminCanary)
    && /kind: NetworkPolicy/u.test(adminCanary)
    && !/kind: Secret/u.test(adminCanary),
  'one isolated replica, mandatory admin Secret, explicit true override, probes, resources and restricted runtime');

check('admin_web_hardened_high_availability_contract',
  /name: cloudpay-admin-web/u.test(adminApp)
    && /replicas: 2/u.test(adminApp)
    && /maxUnavailable: 0/u.test(adminApp)
    && /maxSurge: 1/u.test(adminApp)
    && /kind: PodDisruptionBudget/u.test(adminApp)
    && /minAvailable: 1/u.test(adminApp)
    && /runAsNonRoot: true/u.test(adminApp)
    && /runAsUser: 101/u.test(adminApp)
    && /runAsGroup: 101/u.test(adminApp)
    && /fsGroup: 101/u.test(adminApp)
    && /readOnlyRootFilesystem: true/u.test(adminApp)
    && /allowPrivilegeEscalation: false/u.test(adminApp)
    && /drop: \["ALL"\]/u.test(adminApp)
    && /automountServiceAccountToken: false/u.test(adminApp)
    && /requests:\s*\n\s+cpu: 50m\s*\n\s+memory: 64Mi/u.test(adminApp)
    && (adminApp.match(/path: \/healthz/gu)?.length ?? 0) === 3
    && /mountPath: \/etc\/nginx\/conf\.d/u.test(adminApp),
  'two replicas, zero-unavailable rollout, PDB, non-root read-only runtime, resources and three health probes');

check('admin_web_runtime_origin_matches_backend_contract',
  /ADMIN_API_ORIGIN: https:\/\/admin-api\.kai\.com/u.test(adminApp)
    && /name: cloudpay-admin-web-config/u.test(adminApp)
    && /containerPort: 8080/u.test(adminApp)
    && /targetPort: http/u.test(adminApp),
  'admin Web runtime connects only to the canonical administrator API origin');

const adminIngressHosts = [...adminApp.matchAll(/^\s+- host: (\S+)/gmu)].map((match) => match[1]);
const adminTlsHosts = [...adminApp.matchAll(/^\s+- hosts: \[([^\]]+)\]/gmu)].map((match) => match[1]);
const adminIngressPaths = [...adminApp.matchAll(/^\s+- path: (\S+)/gmu)].map((match) => match[1]);
check('admin_ingress_hosts_paths_and_tls_are_isolated',
  JSON.stringify(adminIngressHosts) === JSON.stringify(['admin.kai.com', 'admin-api.kai.com'])
    && JSON.stringify(adminTlsHosts) === JSON.stringify(['admin.kai.com', 'admin-api.kai.com'])
    && JSON.stringify(adminIngressPaths) === JSON.stringify(['/', '/admin/v1'])
    && (adminApp.match(/kind: Ingress/gu)?.length ?? 0) === 2
    && adminApp.includes('secretName: cloudpay-admin-kai-com-tls')
    && adminApp.includes('secretName: cloudpay-admin-api-kai-com-tls')
    && !adminApp.includes('host: cloudpay.kai.com')
    && !adminApp.includes('path: /mobile/v1'),
  `${adminIngressHosts.join(', ')}; ${adminIngressPaths.join(', ')}`);

const expectedAdminRoutingContract = {
  schemaVersion: 1,
  web: {
    host: 'admin.kai.com', path: '/', pathType: 'Prefix',
    service: 'cloudpay-admin-web', tlsSecret: 'cloudpay-admin-kai-com-tls',
  },
  api: {
    host: 'admin-api.kai.com', path: '/admin/v1', pathType: 'Prefix',
    service: 'cloudpay-backend', tlsSecret: 'cloudpay-admin-api-kai-com-tls',
  },
  canary: {
    manifest: 'admin-api-canary.yaml', deployment: 'cloudpay-admin-api-canary',
    service: 'cloudpay-admin-api-canary', replicas: 1, adminAuthEnabled: true,
    imageMustMatchDeployment: 'cloudpay-backend', mainService: 'cloudpay-backend',
    ingress: 'cloudpay-admin-api',
  },
  transitions: {
    stageC: [
      'apply_canary_manifest', 'wait_canary_ready', 'verify_canary_admin_environment',
      'switch_admin_api_ingress_main_to_canary', 'verify_enabled_admin_routes',
    ],
    stageD: [
      'set_main_admin_auth_enabled_true', 'restart_main_backend', 'wait_main_backend_rollout',
      'verify_every_main_pod_admin_environment', 'switch_admin_api_ingress_canary_to_main',
      'verify_enabled_admin_routes', 'delete_canary_manifest',
    ],
    emergencyDisable: [
      'set_main_admin_auth_enabled_false', 'restart_main_backend', 'wait_main_backend_rollout',
      'verify_every_main_pod_admin_auth_disabled', 'remove_admin_ingresses', 'delete_canary_manifest',
    ],
  },
  rollback: {
    removeOnly: ['ingress/cloudpay-admin-web', 'ingress/cloudpay-admin-api'],
    preserve: [
      'ingress/cloudpay-mobile-api', 'deployment/cloudpay-backend',
      'database migrations', 'admin audit data',
    ],
  },
};
check('admin_rollback_is_bounded_to_admin_hosts',
  JSON.stringify(adminRoutingContract) === JSON.stringify(expectedAdminRoutingContract)
    && kubernetesGuide.includes('只删除 `ingress/cloudpay-admin-web` 和 `ingress/cloudpay-admin-api`')
    && kubernetesGuide.includes('不得删除或修改 `ingress/cloudpay-mobile-api`'),
  'remove only two administrator Ingress resources; preserve mobile, backend, migrations and audit data');

const inOrder = (source, markers) => {
  let previous = -1;
  return markers.every((marker) => {
    const index = source.indexOf(marker, previous + 1);
    if (index < 0) return false;
    previous = index;
    return true;
  });
};
const stageCOrder = [
  'kubectl apply -f backend/deploy/kubernetes/admin-api-canary.yaml',
  'kubectl rollout status deployment/cloudpay-admin-api-canary',
  'printenv ADMIN_AUTH_ENABLED',
  'node scripts/verify-production-env.mjs --admin-only',
  '"value":"cloudpay-admin-api-canary"',
  '--auth-state enabled',
];
const stageDOrder = [
  '\"ADMIN_AUTH_ENABLED\":\"true\"',
  'kubectl rollout restart deployment/cloudpay-backend',
  'kubectl rollout status deployment/cloudpay-backend',
  'app.kubernetes.io/name=cloudpay-backend',
  'test -n "$main_pods"',
  'printenv ADMIN_AUTH_ENABLED',
  '"value":"cloudpay-backend"',
  '--auth-state enabled',
  'kubectl delete -f backend/deploy/kubernetes/admin-api-canary.yaml',
];
const emergencyOrder = [
  '\"ADMIN_AUTH_ENABLED\":\"false\"',
  'kubectl rollout restart deployment/cloudpay-backend',
  'kubectl rollout status deployment/cloudpay-backend',
  'printenv ADMIN_AUTH_ENABLED',
  'kubectl delete ingress/cloudpay-admin-web ingress/cloudpay-admin-api',
  'kubectl delete -f backend/deploy/kubernetes/admin-api-canary.yaml',
];
check('admin_rollout_transitions_are_isolated_ordered_and_executable',
  inOrder(kubernetesGuide, stageCOrder)
    && inOrder(kubernetesGuide, stageDOrder)
    && inOrder(kubernetesGuide, emergencyOrder)
    && kubernetesGuide.includes('ConfigMap 的 `envFrom` 值只在进程启动时读取')
    && adminRunbook.includes('cloudpay-admin-api-canary')
    && adminRunbook.includes('kubectl rollout restart deployment/cloudpay-backend -n cloudpay')
    && adminRunbook.includes('ConfigMap `envFrom` 不会自动重启 Pod'),
  'Stage C isolated ingress switch; Stage D forced main rollout and per-Pod gate; deterministic emergency disable');

check('admin_route_canary_is_fail_closed_and_immutable',
  backendPackage.scripts?.['production:admin-routing:verify'] === 'node deploy/kubernetes/verify-admin-routing.mjs'
    && ['/healthz', '/admin/v1/auth/me', '/mobile/v1/health', '/api/health']
      .every((path) => adminRoutingVerifier.includes(`'${path}'`))
    && adminRoutingVerifier.includes("expectedAuthCode = options.authState === 'disabled' ? 'NOT_FOUND' : 'ADMIN_AUTH_REQUIRED'")
    && adminRoutingVerifier.includes("decision: ok ? 'keep_admin_routes' : 'remove_admin_routes'")
    && adminRoutingVerifier.includes("'ingress/cloudpay-admin-web'")
    && adminRoutingVerifier.includes("'ingress/cloudpay-admin-api'")
    && adminRoutingVerifier.includes("'ingress/cloudpay-mobile-api'")
    && adminRoutingVerifier.includes("'deployment/cloudpay-backend'")
    && adminRoutingVerifier.includes("'database migrations'")
    && adminRoutingVerifier.includes("'admin audit data'")
    && adminRoutingVerifier.includes("flag: 'wx'")
    && adminRoutingVerifier.includes('isAbsolute(parsed.report)')
    && adminRoutingVerifier.includes('isAbsolute(path)'),
  'HTTPS Web/API and host-scope probes; absolute immutable report; admin-only rollback');

const requiredAdminMetrics = [
  'cloudpay_admin_login_events_24h',
  'cloudpay_admin_security_denials_24h',
  'cloudpay_admin_operation_failures_24h',
  'cloudpay_admin_audit_append_failures_total',
  'cloudpay_admin_http_5xx_total',
  'cloudpay_admin_active_sessions',
  'cloudpay_admin_revoked_sessions_24h',
];
const missingAdminMetrics = requiredAdminMetrics.filter((metric) =>
  !adminMonitoring.includes(metric) || !kubernetesGuide.includes(`\`${metric}`));
const requiredAdminAlerts = [
  'KAIAdminAuditAppendFailures', 'KAIAdminHttp5xxResponses', 'KAIAdminOperationFailures',
  'KAIAdminLoginDeniedOrFailedSpike',
  'KAIAdminSecurityDenialSpike', 'KAIAdminActiveSessionsHigh', 'KAIAdminRevokedSessionsHigh',
];
const missingAdminAlerts = requiredAdminAlerts.filter((alert) => !adminMonitoring.includes(`alert: ${alert}`));
check('admin_monitoring_uses_real_low_cardinality_metrics',
  /apiVersion: monitoring\.coreos\.com\/v1/u.test(adminMonitoring)
    && /kind: PrometheusRule/u.test(adminMonitoring)
    && /namespace: cloudpay/u.test(adminMonitoring)
    && kubernetesGuide.includes('应用 `admin-monitoring.yaml`')
    && missingAdminMetrics.length === 0
    && missingAdminAlerts.length === 0
    && /increase\(cloudpay_admin_audit_append_failures_total\[5m\]\)/u.test(adminMonitoring)
    && /increase\(cloudpay_admin_http_5xx_total\[5m\]\)/u.test(adminMonitoring)
    && /result=~"denied\|failed"/u.test(adminMonitoring)
    && /max\(cloudpay_admin_active_sessions\) > 100/u.test(adminMonitoring)
    && /max\(cloudpay_admin_security_denials_24h\) > 50/u.test(adminMonitoring)
    && !/(?:email|group|request_?id|session_?id|request_?url)\s*[=~]/iu.test(adminMonitoring)
    && !/http_requests/iu.test(adminMonitoring),
  missingAdminMetrics.length ? `missing metrics: ${missingAdminMetrics.join(', ')}`
    : missingAdminAlerts.length ? `missing alerts: ${missingAdminAlerts.join(', ')}`
      : 'audit, HTTP 5xx, login, denial and session alerts with no identity labels');

check('admin_metrics_remain_internal_only',
  kubernetesGuide.includes('不增加公网 Ingress')
    && !app.includes('path: /internal/metrics')
    && !adminApp.includes('path: /internal/metrics'),
  '/internal/metrics is reachable only from the monitoring network policy boundary');

check('container_uses_fail_closed_entrypoint',
  /CMD \["node", "scripts\/start-production-container\.mjs"\]/u.test(dockerfile),
  'scripts/start-production-container.mjs');

check('container_includes_disabled_admin_configuration_preflight',
  dockerfile.includes('scripts/verify-container-env.mjs')
    && dockerfile.includes('scripts/verify-production-env.mjs')
    && dockerfile.includes('scripts/start-production-container.mjs')
    && /production:admin-env:verify/u.test(read('package.json')),
  'runtime image includes the value-redacting --admin-only verifier');
check('systemd_uses_fail_closed_entrypoint',
  /ExecStartPre=\/usr\/bin\/node scripts\/verify-production-env\.mjs/u.test(systemdBackend)
    && /EnvironmentFile=\/etc\/kai-cloudpay\/backend\.env/u.test(systemdBackend),
  'verify-production-env.mjs before dist/server.js');

const expectedProbePaths = ['/mobile/v1/health', '/mobile/v1/readiness', '/mobile/v1/supplier-inquiry-catalog?limit=50',
  '/mobile/v1/me', '/mobile/v1/resource-inquiries', '/privacy', '/terms', '/inquiry-terms', '/account/delete',
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/offer-drafts', '/mobile/v1/orders'];
check('two_phase_inquiry_probe', expectedProbePaths.every((path) => probe.includes(`'${path}'`))
  && probe.includes('allowExpectedPublicProofBlockers === true')
  && probe.includes("expectedPreCutoverBlockers = new Set(['UNIFIED_IDENTITY', 'APP_STORED_SESSION', 'INQUIRY_OPERATIONAL_EVIDENCE'")
  && sidecarVerifier.includes("probeInquiryOrigin(LOOPBACK, { allowExpectedPublicProofBlockers: true })"),
  'private phase permits only public-proof blockers; public phase requires full readiness');
check('public_cutover_preserves_live_legacy_baseline', routingVerifier.includes("PUBLIC_ORIGIN = 'https://cloudpay.kai.com'")
  && routingVerifier.includes("DIRECT_ORIGIN = 'http://18.163.148.84:8081'")
  && routingVerifier.includes("CLOUD_KAI_ORIGIN = 'https://cloud.kai.com'")
  && routingVerifier.includes('public/direct root differ') && routingVerifier.includes('public/direct /api/health differ')
  && routingVerifier.includes('baselineAge < -5 * 60_000')
  && routingVerifier.includes("decision: failures.length === 0 ? 'technical_acceptance_passed' : 'technical_acceptance_failed'")
  && routingVerifier.includes("acceptanceMode: 'always_rollback'")
  && routingVerifier.includes('API caching is not disabled') && routingVerifier.includes("flag: 'wx'"),
  'fresh same-time public/direct baseline plus strict public inquiry validation');
check('rollback_is_origin_config_only', rollbackVerifier.includes("restoredHost: '18.163.148.84'")
  && rollbackVerifier.includes("restoredArtifact: 'saved_nginx_config'")
  && rollbackVerifier.includes("unchanged: ['DNS', 'cloud.kai.com']")
  && rollbackVerifier.includes('legacy mobile auth-only routes were not restored')
  && rollbackVerifier.includes('noCredentialCleanupClaimWithoutEvidence: true')
  && !rollbackVerifier.includes('rollback migration'), 'restore 18 nginx and reload; preserve 43 data and DNS');
check('ten_minute_docker_cutover_watchdog', watchdog.includes("ACTIVE_CONFIG = '/home/ubuntu/kai-transaction-v1/nginx-kai.conf'")
  && watchdog.includes("CONTAINER = 'kai-transaction-edge'") && watchdog.includes("CONTAINER_CONFIG = '/etc/nginx/nginx.conf'")
  && watchdog.includes('deadline.getTime() - startedAt.getTime() !== 10 * 60_000')
  && watchdog.includes("await writeFile(deadlinePath") && watchdog.includes("['exec', CONTAINER, 'nginx', '-t']")
  && watchdog.includes("['exec', CONTAINER, 'nginx', '-s', 'reload']")
  && watchdog.includes('ROLLBACK_BIND_MOUNT_NOT_VISIBLE') && watchdog.includes('probeCredentialRevocationRequiredOn43: true')
  && watchdog.includes('acceptanceWatchdogDecision') && !watchdog.includes('CloudPay cutover accepted before')
  && acceptancePolicy.includes("ACCEPTANCE_MODE = 'always_rollback'")
  && acceptancePolicy.includes("reportResult === 'passed' || reportResult === 'failed'")
  && !watchdog.includes("systemctl', ['reload', 'nginx'") && watchdogUnit.includes('Restart=on-failure')
  && watchdogUnit.includes('WorkingDirectory=/opt/kai-cloudpay-origin')
  && watchdogUnit.includes('ExecStart=/usr/bin/node /opt/kai-cloudpay-origin/cutover-watchdog.mjs')
  && watchdogUnit.includes('/run/docker.sock'),
  'success, failure and timeout all restore Docker config; credential and App cleanup remain explicit');
check('paired_probe_uses_encrypted_systemd_credentials', pairedProbeUnit.includes('User=kai-cloudpay-probe')
  && pairedProbeUnit.includes('LoadCredentialEncrypted=kai-refresh-state:')
  && pairedProbeUnit.includes('LoadCredentialEncrypted=kai-probe-database-url:')
  && !pairedProbeUnit.includes('INQUIRY_READINESS_ACCESS_TOKEN=')
  && !pairedProbeUnit.includes('EnvironmentFile=/etc/kai-cloudpay/backend.env')
  && pairedProbeUnit.indexOf('scripts/rotate-kai-probe-credential.mjs') < pairedProbeUnit.lastIndexOf('scripts/persist-kai-probe-refresh.mjs')
  && pairedProbeUnit.lastIndexOf('scripts/persist-kai-probe-refresh.mjs') < pairedProbeUnit.indexOf('scripts/run-inquiry-readiness-systemd.mjs')
  && pairedProbeRotator.includes('refreshKaiProbeTokens(state)')
  && pairedProbePersist.includes("spawn('/usr/bin/systemd-creds',['encrypt','--with-key=host','--name=kai-refresh-state','-',temporary]")
  && pairedProbeRunner.includes('accessToken:pair.accessToken') && !pairedProbeRunner.includes('INQUIRY_READINESS_ACCESS_TOKEN')
  && pairedProbeTimer.includes('OnCalendar=*-*-* *:00,15,30,45:00')
  && pairedProbeRevoke.includes('scripts/revoke-kai-probe-family.mjs')
  && pairedProbeRevoke.indexOf('scripts/prepare-kai-probe-revocation.mjs') < pairedProbeRevoke.indexOf('ExecStart=/usr/bin/node scripts/revoke-kai-probe-family.mjs')
  && pairedProbeRevoke.includes('scripts/finalize-kai-probe-revocation.mjs')
  && pairedProbeRevoke.includes('ExecStopPost=+/usr/bin/node scripts/persist-kai-probe-refresh.mjs --commit')
  && pairedProbeRevoke.includes('Conflicts=cloudpay-mobile-paired-probe.timer cloudpay-mobile-paired-probe.service')
  && pairedProbeRevoke.includes('Before=cloudpay-mobile-paired-probe.timer cloudpay-mobile-paired-probe.service')
  && pairedProbeRevoke.includes('RestartPreventExitStatus=78')
  && pairedProbeRevoker.includes("withExclusiveRotationLock(resolve(runtimeDirectory,'rotation.lock')")
  && pairedProbeRevoker.includes('if(!result.revoked)')
  && pairedProbeRevokePrepare.includes("createManualAdminState(current,'revocation_attempt_interrupted'")
  && pairedProbeRevokePrepare.indexOf('await persistMachineState(attempt)') < pairedProbeRevokePrepare.indexOf('await atomicWriteHandoff(attemptPath,attempt)')
  && pairedProbeRevoker.includes("createManualAdminState(attempt,'revocation_confirmation_unconfirmed'")
  && pairedProbeRevokePrepare.indexOf("readFile(confirmedPath,'utf8')") < pairedProbeRevokePrepare.indexOf('let current;')
  && pairedProbeRevoker.indexOf("readFile(manualPath,'utf8')") < pairedProbeRevoker.indexOf('await revokeKaiProbeFamily(')
  && pairedProbeSystemdVerifier.includes("properties.ExecMainStatus==='78'")
  && pairedProbeSystemdVerifier.includes("properties.NRestarts==='0'")
  && pairedProbeSystemdVerifier.includes('networkRuns===0')
  && pairedProbeRevoker.includes('createRevokeOnlyCandidate(attempt,result.candidateRefreshToken')
  && pairedProbeRevoker.includes("atomicWriteHandoff(resolve(runtimeDirectory,'rotated-refresh-handoff.json')")
  && pairedProbeRevoker.indexOf('await revokeKaiProbeFamily(') < pairedProbeRevoker.indexOf('await writeFile(confirmedPath')
  && pairedProbeFinalizer.includes("'/run/kai-cloudpay-probe/ephemeral-token-pair.json'")
  && pairedProbeFinalizer.indexOf('readFile(marker') < pairedProbeFinalizer.indexOf("rm('/etc/credstore.encrypted"),
  'dedicated user rotates a machine-encrypted refresh family every 15 minutes; remote revoke precedes deletion');

const scripts = packageJson.scripts;
check('production_commands_use_direct_profile', [scripts['production:routing:capture'], scripts['production:routing:verify'],
  scripts['production:sidecar:preflight'], scripts['production:origin:preflight'], scripts['production:sidecar:verify'],
  scripts['production:nginx:verify'], scripts['production:rollback:verify']]
  .every((command) => command?.includes('deploy/direct-ubuntu/')),
  'primary production host/routing commands point to deploy/direct-ubuntu');
check('legacy_aws_commands_are_explicitly_namespaced',
  Object.entries(scripts)
    .filter(([, command]) => typeof command === 'string' && command.includes('deploy/aws-ubuntu/'))
    .every(([name]) => name.startsWith('production:aws-')),
  'retained AWS administration checks cannot replace the direct production profile');
check('release_bundle_contains_direct_contract', bundle.includes("'deploy/direct-ubuntu/verify-routing.mjs'")
  && bundle.includes("'deploy/direct-ubuntu/preflight-sidecar.mjs'")
  && bundle.includes("'deploy/direct-ubuntu/preflight-origin.mjs'")
  && bundle.includes("'deploy/direct-ubuntu/cloudpay-mobile-nginx-routes.conf'")
  && bundle.includes("'deploy/direct-ubuntu/enroll-qixiang-technical-canary-credentials.mjs'")
  && bundle.includes("'deploy/direct-ubuntu/issue-qixiang-technical-canary-gate.mjs'")
  && bundle.includes("'deploy/direct-ubuntu/cloudpay-mobile-qixiang-technical-canary-gate-refresh.service'")
  && bundle.includes("'deploy/direct-ubuntu/cloudpay-mobile-qixiang-technical-canary-gate-refresh.timer'")
  && !bundle.includes("'deploy/aws-ubuntu/verify-routing.mjs'")
  && bundle.includes("['--no-xattrs', '-czf'")
  && bundle.includes("['LIBARCHIVE', 'xattr']") && bundle.includes("['com', 'apple', 'provenance']"),
  'direct topology and metadata-clean archive are release gates');
check('container_keeps_fail_closed_entrypoint', /CMD \["node", "scripts\/start-production-container\.mjs"\]/u.test(dockerfile)
  && dockerfile.includes('scripts/record-inquiry-readiness.mjs')
  && dockerfile.includes('scripts/record-inquiry-app-session.mjs'), 'controlled environment and readiness evidence');

const failed = checks.filter((item) => !item.pass);
for (const item of checks) process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}\n`);
if (failed.length > 0) {
  process.stderr.write(`Deployment contract failed (${failed.length}/${checks.length}).\n`);
  process.exit(1);
}
process.stdout.write(`Deployment contract passed (${checks.length} checks).\n`);
