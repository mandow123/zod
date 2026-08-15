import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const app = read('deploy/kubernetes/app.yaml');
const migration = read('deploy/kubernetes/migrate-job.yaml');
const backup = read('deploy/kubernetes/backup-cronjob.yaml');
const kubernetesGuide = read('deploy/kubernetes/README.md');
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

check('container_uses_fail_closed_entrypoint',
  /CMD \["node", "scripts\/start-production-container\.mjs"\]/u.test(dockerfile),
  'scripts/start-production-container.mjs');
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
