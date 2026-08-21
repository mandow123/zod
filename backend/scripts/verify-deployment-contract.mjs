import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const app = read('deploy/kubernetes/app.yaml');
const adminApp = read('deploy/kubernetes/admin-app.yaml');
const adminCanary = read('deploy/kubernetes/admin-api-canary.yaml');
const migration = read('deploy/kubernetes/migrate-job.yaml');
const backup = read('deploy/kubernetes/backup-cronjob.yaml');
const kubernetesGuide = read('deploy/kubernetes/README.md');
const adminRunbook = read('../docs/admin-production-runbook.md');
const adminRoutingContract = JSON.parse(read('deploy/kubernetes/admin-routing-contract.json'));
const adminRoutingVerifier = read('deploy/kubernetes/verify-admin-routing.mjs');
const adminMonitoring = read('deploy/kubernetes/admin-monitoring.yaml');
const backendPackage = JSON.parse(read('package.json'));
const environmentExample = read('.env.example');
const dockerfile = read('Dockerfile');
const systemdBackend = read('deploy/aws-ubuntu/cloudpay-mobile-backend.service');
const routingContract = JSON.parse(read('deploy/aws-ubuntu/cloudpay-mobile-alb-routes.json'));
const routingVerifier = read('deploy/aws-ubuntu/verify-routing.mjs');
const hostPreflight = read('deploy/aws-ubuntu/preflight-host.mjs');
const sidecarVerifier = read('deploy/aws-ubuntu/verify-sidecar.mjs');

const minimalProduction = {
  NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '4100', PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
};
const readiness = loadConfig(minimalProduction).readiness;
const variableName = (blocker) => blocker.match(/^[A-Z][A-Z0-9_]*/u)?.[0];
const syntheticCapabilityBlockers = new Set([
  'KAI_CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED',
  'COMPUTE_PROVIDER_NOT_CONFIGURED',
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

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
const missingFrom = (source, names) => names.filter((name) => !new RegExp(`^${name}=`, 'mu').test(source));

const exampleMissing = missingFrom(environmentExample, documentedVariables);
check('environment_example_complete', exampleMissing.length === 0,
  exampleMissing.length ? exampleMissing.join(', ') : `${documentedVariables.length} variables`);

const configMapVariables = [...app.matchAll(/^  ([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]);
const uncoveredVariables = documentedVariables.filter((name) =>
  !configMapVariables.includes(name) && !kubernetesGuide.includes(`\`${name}\``));
check('kubernetes_configuration_contract_documented', uncoveredVariables.length === 0,
  uncoveredVariables.length
    ? uncoveredVariables.join(', ')
    : `${configMapVariables.length} public settings, ${documentedVariables.length - configMapVariables.filter((name) => documentedVariables.includes(name)).length} secret settings`);

check('compute_provider_configuration_split',
  ['COMPUTE_PROVIDER', 'COMPUTE_PROVIDER_URL', 'COMPUTE_ALLOCATED_ACCELERATOR_COUNT']
    .every((name) => configMapVariables.includes(name))
    && !configMapVariables.includes('COMPUTE_PROVIDER_TOKEN')
    && kubernetesGuide.includes('`COMPUTE_PROVIDER_TOKEN`')
    && /COMPUTE_PROVIDER_URL:\s+https:\/\//u.test(app)
    && /COMPUTE_ALLOCATED_ACCELERATOR_COUNT:\s+"1"/u.test(app),
  'public sidecar settings in ConfigMap; bearer token documented as Secret');

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
  ['api', app], ['migration', migration], ['backup', backup],
]) {
  const hasConfig = /configMapRef:\s*\n\s+name: cloudpay-backend-config/u.test(source);
  const hasSecrets = /secretRef:\s*\n\s+name: cloudpay-backend-secrets/u.test(source);
  check(`${name}_receives_shared_configuration`, hasConfig && hasSecrets,
    `configMap=${String(hasConfig)}, secret=${String(hasSecrets)}`);
}

const imagePattern = /image:\s+(\S+@sha256:[a-f0-9]{64})/gu;
const images = [app, migration, backup].flatMap((source) => [...source.matchAll(imagePattern)].map((match) => match[1]));
check('immutable_image_contract', images.length === 3 && new Set(images).size === 1,
  images.length === 3 ? `${new Set(images).size} unique digest(s)` : `${images.length}/3 images`);

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
  /COPY\s+scripts\/verify-container-env\.mjs\s+scripts\/verify-production-env\.mjs\s+scripts\/start-production-container\.mjs\s+\.\/scripts\//u.test(dockerfile)
    && /production:admin-env:verify/u.test(read('package.json')),
  'runtime image includes the value-redacting --admin-only verifier');
check('systemd_uses_fail_closed_entrypoint',
  /ExecStartPre=\/usr\/bin\/node scripts\/verify-production-env\.mjs/u.test(systemdBackend)
    && /EnvironmentFile=\/etc\/kai-cloudpay\/backend\.env/u.test(systemdBackend),
  'verify-production-env.mjs before dist/server.js');

const expectedForwardPaths = ['/mobile/v1', '/mobile/v1/*', '/privacy', '/terms', '/account/delete'];
const expectedProtectedPaths = ['/', '/api/*'];
check('alb_exact_forward_contract',
  JSON.stringify(routingContract.forwardOnly) === JSON.stringify(expectedForwardPaths)
    && JSON.stringify(routingContract.mustRemainOnExistingTarget) === JSON.stringify(expectedProtectedPaths)
    && routingContract.target?.port === 4154
    && routingContract.target?.healthCheckPath === '/mobile/v1/health',
  `${routingContract.forwardOnly?.length ?? 0} forwarded paths; target ${String(routingContract.target?.port)}`);

const ingressPaths = [...app.matchAll(/^\s+- path: (\S+)/gmu)].map((match) => match[1]);
const expectedIngressPaths = ['/mobile/v1', '/privacy', '/terms', '/account/delete'];
check('kubernetes_ingress_matches_alb_contract',
  JSON.stringify(ingressPaths) === JSON.stringify(expectedIngressPaths),
  ingressPaths.join(', '));

const providerProbes = [
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/offers', '/mobile/v1/provider/listings',
];
const missingRoutingProbes = [
  '/mobile/v1/health', '/mobile/v1/readiness', '/privacy', '/terms', '/account/delete',
  ...providerProbes,
].filter((path) => !routingVerifier.includes(`'${path}'`));
check('routing_verifier_covers_full_provider_cutover', missingRoutingProbes.length === 0
  && routingVerifier.includes("protectedPaths = ['/', '/api/health']")
  && routingVerifier.includes('record.status !== 401')
  && routingVerifier.includes("record.contentType !== 'application/json'"),
missingRoutingProbes.length ? missingRoutingProbes.join(', ') : `${providerProbes.length} provider probes plus health, readiness and legal pages`);
check('routing_failure_has_bounded_rollback',
  routingVerifier.includes("decision: failures.length === 0 ? 'keep_mobile_routes' : 'remove_mobile_routes'")
    && routingVerifier.includes("removeOnly: ['/mobile/v1', '/mobile/v1/*', '/privacy', '/terms', '/account/delete']")
    && routingVerifier.includes("preserve: ['/', '/api/*', 'database migrations']"),
  'mobile routes only; old site, legacy API and migrations preserved');
check('target_host_preflight_fails_closed',
  hostPreflight.includes("check('dedicated_ports_free'")
    && hostPreflight.includes("check('production_capabilities_configured'")
    && hostPreflight.includes("check('installed_service_contract'")
    && hostPreflight.includes("check('fresh_old_site_baseline'")
    && hostPreflight.includes("flag: 'wx'")
    && hostPreflight.includes("readyForMigrationAndSidecarStart: failures.length === 0"),
  'identity, ports, config, units, backup and fresh baseline; immutable report');
check('private_sidecar_verifier_covers_provider_entry',
  ['/mobile/v1/health', '/mobile/v1/readiness', '/privacy', '/terms', '/account/delete', ...providerProbes]
    .every((path) => sidecarVerifier.includes(`'${path}'`))
    && sidecarVerifier.includes("probeOrigin('http://127.0.0.1:4100')")
    && sidecarVerifier.includes('readyForAlbTargetRegistration')
    && sidecarVerifier.includes("flag: 'wx'"),
  'loopback and VPC edge signatures plus immutable report before ALB registration');

const failed = checks.filter((item) => !item.pass);
for (const item of checks) {
  process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}\n`);
}
if (failed.length > 0) {
  process.stderr.write(`Deployment contract failed with ${failed.length} problem(s).\n`);
  process.exit(1);
}
process.stdout.write(`Deployment contract passed (${checks.length} checks).\n`);
