import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

const root = resolve(import.meta.dirname, '../deploy/direct-ubuntu');
const text = (name:string) => readFile(resolve(root, name), 'utf8');

describe('18 origin to 43 private inquiry-only deployment', () => {
  it('locks the observed two-host topology without changing cloud.kai.com', async () => {
    const topology = JSON.parse(await text('topology.json'));
    expect(topology).toMatchObject({ publicOrigin:'https://cloudpay.kai.com',
      legacyOrigin:{publicIpv4:'18.163.148.84',privateIpv4:'172.31.33.227',port:8081},
      mobileSidecar:{publicIpv4:'43.198.97.0',privateIpv4:'172.31.31.78',edgePort:4154,
        loopbackHost:'127.0.0.1',loopbackPort:4100},cloudKaiComChangesAllowed:false });
    expect(topology.forwardOnly).toEqual(['/mobile/v1','/mobile/v1/*','/payments/qixiang/return',
      '/privacy','/terms','/inquiry-terms','/account/delete']);
    expect(topology.preserveExactly).toEqual(['/','/api/*']);
  });

  it('adds only nine Nginx locations with query-silent auth and payment callbacks', async () => {
    const nginx = await text('cloudpay-mobile-nginx-routes.conf');
    expect([...nginx.matchAll(/^location\s+([^\n{]+)\{/gmu)].map((match)=>match[1]!.trim())).toEqual([
      '= /mobile/v1','= /mobile/v1/credits/topups/qixiang/notify','= /mobile/v1/auth/kai/callback',
      '^~ /mobile/v1/','= /payments/qixiang/return',
      '= /privacy','= /terms','= /inquiry-terms','= /account/delete',
    ]);
    expect(nginx.match(/proxy_pass http:\/\/172\.31\.31\.78:4154;/gu)).toHaveLength(9);
    expect(nginx.match(/proxy_set_header Host cloudpay\.kai\.com;/gu)).toHaveLength(9);
    expect(nginx.match(/proxy_set_header X-Forwarded-Proto https;/gu)).toHaveLength(9);
    expect(nginx.match(/set_real_ip_from 172\.31\.0\.0\/16;/gu)).toHaveLength(9);
    expect(nginx.match(/real_ip_recursive on;/gu)).toHaveLength(9);
    expect(nginx.match(/proxy_set_header X-Forwarded-For \$remote_addr;/gu)).toHaveLength(9);
    expect(nginx.match(/access_log off;/gu)).toHaveLength(2);
    expect(nginx).not.toMatch(/\$(?:request_uri|args)\b/u);
    expect(nginx).not.toContain('$http_x_forwarded_for');
    expect(nginx).not.toMatch(/^location[^\n]+(?:\/api|\/internal\/metrics)/gmu);
  });

  it('binds 4154 only on 43 private and permits only the 18 private source', async () => {
    const [socket,relay,firewall]=await Promise.all([text('cloudpay-mobile-edge.socket'),text('cloudpay-mobile-edge.service'),text('cloudpay-mobile-edge.nft')]);
    expect(socket).toContain('ListenStream=172.31.31.78:4154');
    expect(socket).not.toContain('0.0.0.0');
    expect(relay).toContain('127.0.0.1:4100');
    expect(firewall).toContain('ip saddr 172.31.33.227/32 counter accept');
    expect(firewall).toContain('tcp dport 4154 counter drop');
    expect(firewall).not.toContain('172.31.0.0/16');
  });

  it('gives two cleaned client IPs independent buckets and an extra forged XFF value cannot bypass one hop',async()=>{
    const app=Fastify({trustProxy:1,logger:false});
    await app.register(rateLimit,{max:1,timeWindow:'1 minute',keyGenerator:(request)=>request.ip});
    app.get('/probe',async(request)=>({ip:request.ip}));
    const first=await app.inject({method:'GET',url:'/probe',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.10'}});
    const secondClient=await app.inject({method:'GET',url:'/probe',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.11'}});
    const forgedLeft=await app.inject({method:'GET',url:'/probe',remoteAddress:'127.0.0.1',
      headers:{'x-forwarded-for':'203.0.113.250, 198.51.100.10'}});
    expect(first.statusCode).toBe(200);expect(first.json().ip).toBe('198.51.100.10');
    expect(secondClient.statusCode).toBe(200);expect(secondClient.json().ip).toBe('198.51.100.11');
    expect(forgedLeft.statusCode).toBe(429);
    await app.close();
  });

  it('uses exact Stage A blockers then permits Stage B only with three legal blockers', async () => {
    const [probe,origin,publicVerify,productionGate]=await Promise.all([text('probe-inquiry.mjs'),text('preflight-origin.mjs'),
      text('verify-routing.mjs'),readFile(resolve(root,'../../scripts/verify-production-env.mjs'),'utf8')]);
    expect(probe).toContain("expectedPreCutoverBlockers = new Set(['UNIFIED_IDENTITY', 'APP_STORED_SESSION', 'INQUIRY_OPERATIONAL_EVIDENCE'");
    expect(probe).toContain("'KAI_PAIRED_PROBE_30M', 'APP_STORED_SESSION_PROBE_24H'");
    expect(probe).toContain('actualPreCutoverBlockers.size === expectedPreCutoverBlockers.size');
    expect(probe).toContain('readinessBody?.capabilities?.observability === true');
    expect(origin).toContain('allowExpectedPublicProofBlockers: true');
    expect(publicVerify).toContain('probeInquiryOrigin(PUBLIC_ORIGIN)');
    expect(publicVerify).toContain('baselineAge < -5 * 60_000');
    expect(probe).toContain('technicalAcceptanceReady');
    expect(probe).toContain("expectedLegalBlockers = new Set(['ICP_FILING_NOT_APPROVED', 'APP_FILING_NOT_APPROVED'");
    expect(probe).toContain('readinessBody?.capabilities?.kaiPairedProbe?.ready === true');
    expect(probe).toContain('readinessBody?.capabilities?.appSessionProbe?.ready === true');
    expect(probe).toContain('readinessBody?.release?.ready === false');
    expect(publicVerify).toContain("decision: failures.length === 0 ? 'technical_acceptance_passed' : 'technical_acceptance_failed'");
    expect(publicVerify).toContain("acceptanceMode: 'always_rollback'");
    expect(productionGate).toContain('config.readiness.startupBlockers');
    expect(productionGate).toContain("config.mobileApiProfile==='full_commerce'&&config.qixiangTechnicalCanaryMode");
    expect(productionGate).toContain('technicalCanaryToleratedStartupBlockers');
    expect(productionGate).toContain("['QIXIANG_TECHNICAL_CANARY_TOPUPS_UNAVAILABLE']");
    expect(productionGate).toContain("['QIXIANG_TECHNICAL_CANARY_RECOVERY_UNAVAILABLE']");
    expect(productionGate).toContain('minAmountCents===501');
  });

  it('validates the real Docker edge and preserves current public/direct legacy baselines', async () => {
    const [origin,routing,nginxVerifier]=await Promise.all([text('preflight-origin.mjs'),text('verify-routing.mjs'),text('verify-nginx-config.mjs')]);
    expect(origin).toContain("ACTIVE_CONFIG = '/home/ubuntu/kai-transaction-v1/nginx-kai.conf'");
    expect(origin).toContain("EDGE_CONTAINER = 'kai-transaction-edge'");
    expect(origin).toContain("CONTAINER_CONFIG = '/etc/nginx/nginx.conf'");
    expect(origin).toContain("check('legacy_config_bind_mount_read_only'");
    expect(origin).toContain('baselineAge >= -5 * 60_000');
    expect(routing).toContain("DIRECT_ORIGIN = 'http://18.163.148.84:8081'");
    expect(routing).toContain('public/direct root differ');
    expect(routing).toContain('public/direct /api/health differ');
    expect(routing).toContain('record?.json?.payment_ready === true');
    expect(routing).toContain('record?.json?.payment_create_enabled === false');
    expect(routing).toContain('record?.json?.payment_reconciliation_ready === true');
    expect(routing).toContain('record?.json?.payment_worker_ready === true');
    expect(routing).toContain('legacy mobile auth-only market gate differs');
    expect(routing).toContain("protectedRecord(PUBLIC_ORIGIN, '/mobile/v1/market/resources')");
    expect(nginxVerifier).toContain('existing / or /api location bytes changed');
    expect(nginxVerifier).toContain('cloud.kai.com server bytes changed');
  });

  it('auto-restores the Docker config within ten minutes and separates 43 credential revocation', async () => {
    const [watchdog,unit,revoke,rollback]=await Promise.all([text('cutover-watchdog.mjs'),text('cloudpay-mobile-cutover-watchdog.service'),
      text('cloudpay-mobile-paired-probe-revoke.service'),text('verify-rollback.mjs')]);
    expect(watchdog).toContain('10 * 60_000');
    expect(watchdog).toContain("await writeFile(deadlinePath");
    expect(watchdog).toContain("flag: 'wx'");
    expect(watchdog).toContain('deadline.getTime() - startedAt.getTime() !== 10 * 60_000');
    expect(watchdog).toContain("CONTAINER = 'kai-transaction-edge'");
    expect(watchdog).toContain("['exec', CONTAINER, 'nginx', '-t']");
    expect(watchdog).toContain("['exec', CONTAINER, 'nginx', '-s', 'reload']");
    expect(watchdog).toContain('ROLLBACK_BIND_MOUNT_NOT_VISIBLE');
    expect(watchdog).toContain('acceptanceWatchdogDecision');
    expect(watchdog).toContain("report.decision === 'technical_acceptance_passed'");
    expect(watchdog).toContain("report.decision === 'technical_acceptance_failed'");
    expect(watchdog).not.toContain('process.stdout.write(`CloudPay cutover accepted');
    expect(watchdog).toContain("status: 'pending_remote_confirmation'");
    expect(watchdog).toContain("status: 'pending_device_and_auth_cleanup'");
    expect(watchdog).toContain('probeCredentialRevocationRequiredOn43: true');
    expect(watchdog).not.toContain("systemctl', ['reload', 'nginx'");
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WorkingDirectory=/opt/kai-cloudpay-origin');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/kai-cloudpay-origin/cutover-watchdog.mjs');
    expect(unit).toContain('ReadWritePaths=/home/ubuntu/kai-transaction-v1/nginx-kai.conf /var/lib/kai-cloudpay-deploy /run/docker.sock');
    expect(unit).toContain('CapabilityBoundingSet=CAP_DAC_OVERRIDE');
    expect(unit).toContain('AmbientCapabilities=CAP_DAC_OVERRIDE');
    expect(unit).not.toContain('CAP_DAC_READ_SEARCH');
    expect(unit).not.toContain('CAP_SYS_ADMIN');
    expect(rollback).toContain('legacy mobile auth-only routes were not restored');
    expect(rollback).toContain('cloud.kai.com changed');
    expect(rollback).toContain('noCredentialCleanupClaimWithoutEvidence: true');
    expect(revoke).toContain('cloudpay-mobile-paired-probe.timer');
    expect(revoke).toContain('Conflicts=cloudpay-mobile-paired-probe.timer cloudpay-mobile-paired-probe.service');
  });

  it('always rolls back both successful and failed technical acceptance reports', async () => {
    const { ACCEPTANCE_MODE, acceptanceWatchdogDecision } = await import(
      '../deploy/direct-ubuntu/acceptance-watchdog-policy.mjs'
    );
    expect(ACCEPTANCE_MODE).toBe('always_rollback');
    expect(acceptanceWatchdogDecision({ reportResult:'passed',nowMs:1,deadlineMs:10 })).toMatchObject({
      action:'rollback',technicalAcceptanceResult:'passed',reason:expect.stringContaining('always_rollback'),
    });
    expect(acceptanceWatchdogDecision({ reportResult:'failed',nowMs:1,deadlineMs:10 })).toMatchObject({
      action:'rollback',technicalAcceptanceResult:'failed',reason:expect.stringContaining('always_rollback'),
    });
    expect(acceptanceWatchdogDecision({ reportResult:null,nowMs:9,deadlineMs:10 })).toEqual({
      action:'wait',technicalAcceptanceResult:'not_recorded',
    });
    expect(acceptanceWatchdogDecision({ reportResult:null,nowMs:10,deadlineMs:10 })).toMatchObject({
      action:'rollback',technicalAcceptanceResult:'not_recorded',reason:expect.stringContaining('10 minutes'),
    });
  });

  it('refreshes real paired proof every 15 minutes without tokens in env or argv', async () => {
    const [service,timer,wrapper,rotator,systemdVerifier,packageJson,bundle]=await Promise.all([
      text('cloudpay-mobile-paired-probe.service'),text('cloudpay-mobile-paired-probe.timer'),
      readFile(resolve(root,'../../scripts/run-inquiry-readiness-systemd.mjs'),'utf8'),
      readFile(resolve(root,'../../scripts/rotate-kai-probe-credential.mjs'),'utf8'),
      text('verify-paired-probe-systemd.mjs'),
      readFile(resolve(root,'../../package.json'),'utf8'),readFile(resolve(root,'../../scripts/build-deployment-bundle.mjs'),'utf8'),
    ]);
    expect(service).toContain('User=kai-cloudpay-probe');
    expect(service).toContain('LoadCredentialEncrypted=kai-refresh-state:');
    expect(service).toContain('LoadCredentialEncrypted=kai-probe-database-url:');
    expect(service).not.toContain('EnvironmentFile=/etc/kai-cloudpay/backend.env');
    expect(service).not.toContain('INQUIRY_READINESS_ACCESS_TOKEN=');
    expect(timer).toContain('OnCalendar=*-*-* *:00,15,30,45:00');
    expect(wrapper).toContain('CREDENTIALS_DIRECTORY');
    expect(wrapper).not.toContain('process.env.INQUIRY_READINESS_ACCESS_TOKEN');
    expect(wrapper).toContain('accessToken:pair.accessToken');
    expect(rotator).toContain("prepareProbeRefreshState(resolve(credentialDirectory,'kai-refresh-state'),runtimeDirectory)");
    expect(service.indexOf('scripts/rotate-kai-probe-credential.mjs')).toBeLessThan(service.lastIndexOf('scripts/persist-kai-probe-refresh.mjs'));
    expect(service.lastIndexOf('scripts/persist-kai-probe-refresh.mjs')).toBeLessThan(service.indexOf('ExecStart=/usr/bin/node scripts/run-inquiry-readiness-systemd.mjs'));
    expect(systemdVerifier).toContain("properties.ExecMainStatus==='78'");
    expect(systemdVerifier).toContain("properties.NRestarts==='0'");
    expect(systemdVerifier).toContain('networkRuns===0');
    expect(JSON.parse(packageJson).scripts['production:routing:verify']).toContain('deploy/direct-ubuntu/');
    expect(bundle).toContain("'deploy/direct-ubuntu/verify-routing.mjs'");
    expect(bundle).toContain("'deploy/direct-ubuntu/issue-qixiang-technical-canary-gate.mjs'");
    expect(bundle).toContain("'deploy/direct-ubuntu/cloudpay-mobile-qixiang-technical-canary-gate-refresh.timer'");
    expect(bundle).not.toContain("'deploy/aws-ubuntu/verify-routing.mjs'");
  });

  it('recovers static probe credential rotation and binds preflight to recent verified ciphertexts', async () => {
    const [provision,verify,preflight]=await Promise.all([
      text('provision-probe-static-credentials.mjs'),text('verify-probe-static-credentials.mjs'),text('preflight-sidecar.mjs'),
    ]);
    expect(provision).toContain("'/usr/bin/flock'");
    expect(provision).toContain("phase: 'prepared'");
    expect(provision).toContain("phase: 'database_password_committed'");
    expect(provision).toContain('await recoverPending()');
    expect(provision).toContain('BEGIN;');
    expect(provision).toContain('COMMIT;');
    expect(verify).toContain('probe-static-credentials-verified.json');
    expect(preflight).toContain("check('recent_probe_static_credential_verification'");
    expect(preflight).toContain('staticVerifyAge>=-5*60_000');
    expect(preflight).toContain('credentialSha256?.database===databaseCredentialDigest');
  });
});
