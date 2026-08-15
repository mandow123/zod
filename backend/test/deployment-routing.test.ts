import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploymentRoot = resolve(import.meta.dirname, '../deploy/aws-ubuntu');

describe('cloudpay.kai.com production routing contract', () => {
  it('forwards only the mobile API and exact legal pages', async () => {
    const contract = JSON.parse(await readFile(resolve(deploymentRoot, 'cloudpay-mobile-alb-routes.json'), 'utf8')) as {
      target: { port: number; healthCheckPath: string };
      forwardOnly: string[];
      mustRemainOnExistingTarget: string[];
    };

    expect(contract.target).toMatchObject({ port: 4154, healthCheckPath: '/mobile/v1/health' });
    expect(contract.forwardOnly).toEqual([
      '/mobile/v1', '/mobile/v1/*', '/privacy', '/terms', '/account/delete',
    ]);
    expect(contract.forwardOnly).not.toContain('/');
    expect(contract.forwardOnly).not.toContain('/*');
    expect(contract.forwardOnly).not.toContain('/api/*');
    expect(contract.mustRemainOnExistingTarget).toEqual(['/', '/api/*']);
  });

  it('keeps the app private and exposes only a VPC-restricted relay', async () => {
    const [socket, service, firewall] = await Promise.all([
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-edge.socket'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-edge.service'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-edge.nft'), 'utf8'),
    ]);

    expect(socket).toContain('ListenStream=PRIVATE_IPV4:4154');
    expect(socket).not.toContain('ListenStream=0.0.0.0');
    expect(service).toContain('127.0.0.1:4100');
    expect(service).not.toMatch(/ExecStart=.*(?:127\.0\.0\.1:3051|:3000)/u);
    expect(firewall).toContain('tcp dport 4154 ip saddr 172.31.0.0/16 counter accept');
    expect(firewall).toContain('tcp dport 4154 counter drop');
  });

  it('runs migrations before the hardened backend and schedules non-overlapping hourly backups', async () => {
    const [backend, migration, backup, timer, relay] = await Promise.all([
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-backend.service'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-migrate.service'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-backup.service'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-backup.timer'), 'utf8'),
      readFile(resolve(deploymentRoot, 'cloudpay-mobile-edge.service'), 'utf8'),
    ]);
    for (const unit of [backend, migration, backup]) {
      expect(unit).toContain('User=kai-cloudpay');
      expect(unit).toContain('EnvironmentFile=/etc/kai-cloudpay/backend.env');
      expect(unit).toContain('ProtectSystem=strict');
      expect(unit).toContain('NoNewPrivileges=yes');
      expect(unit).toContain('CapabilityBoundingSet=');
      expect(unit).not.toMatch(/Environment=.*(?:SECRET|KEY|PASSWORD)=\S+/u);
    }
    expect(backend).toContain('Requires=cloudpay-mobile-migrate.service');
    expect(backend).toContain('ExecStart=/usr/bin/node dist/server.js');
    expect(backend).toContain('Restart=on-failure');
    expect(migration).toContain('ExecStart=/usr/bin/node dist/migrate.js');
    expect(migration).toContain('TimeoutStartSec=900');
    expect(backup).toContain('ExecStart=/usr/bin/node dist/backups/backup.js');
    expect(backup).toContain('ReadWritePaths=/var/lib/kai-cloudpay-backup');
    expect(backup).toContain('TimeoutStartSec=3300');
    expect(timer).toContain('OnCalendar=*-*-* *:17:00');
    expect(timer).toContain('Persistent=yes');
    expect(relay).toContain('Requires=cloudpay-mobile-backend.service');
    expect(relay).not.toContain('docker.service');
  });

  it('fails closed unless old routes, release readiness, and legal pages all survive', async () => {
    const verifier = await readFile(resolve(deploymentRoot, 'verify-routing.mjs'), 'utf8');
    for (const marker of [
      "protectedPaths = ['/', '/api/health']",
      'mkdir(dirname(outputPath), { recursive: true })',
      "readinessBody?.deployment?.ready !== true",
      "readinessBody?.release?.ready !== true",
      "[privacy, '隐私政策']",
      "[terms, '用户协议']",
      "[deletion, '删除 CloudPay 账户']",
      "'/mobile/v1/provider/bootstrap'",
      "'/mobile/v1/provider/offer-drafts'",
      'record.status !== 401',
      "record.contentType !== 'application/json'",
      "decision: failures.length === 0 ? 'keep_mobile_routes' : 'remove_mobile_routes'",
      "removeOnly: ['/mobile/v1', '/mobile/v1/*', '/privacy', '/terms', '/account/delete']",
      "preserve: ['/', '/api/*', 'database migrations']",
    ]) expect(verifier).toContain(marker);
  });

  it('requires a target-host preflight before any service is started', async () => {
    const [preflight, packageJson] = await Promise.all([
      readFile(resolve(deploymentRoot, 'preflight-host.mjs'), 'utf8'),
      readFile(resolve(deploymentRoot, '../../package.json'), 'utf8'),
    ]);
    for (const marker of [
      "check('linux_target'", "check('root_operator'", "check('pinned_node_runtime'",
      "check('vpc_private_ip'", "check('dedicated_ports_free'", "check('current_release_selected'",
      "check('production_environment_permissions'", "check('production_capabilities_configured'",
      "check('installed_service_contract'", "check('backup_workspace_locked'", "check('fresh_old_site_baseline'",
      "flag: 'wx'", 'readyForMigrationAndSidecarStart: failures.length === 0',
    ]) expect(preflight).toContain(marker);
    expect(JSON.parse(packageJson).scripts['production:host:preflight']).toContain('preflight-host.mjs');
  });
});
