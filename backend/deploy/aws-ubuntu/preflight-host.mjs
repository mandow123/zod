import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!['--private-ip', '--baseline', '--report'].includes(name)) throw new Error(`Unknown argument: ${name}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    result[name.slice(2)] = value;
    index += 1;
  }
  for (const name of ['private-ip', 'baseline', 'report']) {
    if (!result[name]) throw new Error(`--${name} is required`);
  }
  return result;
}

export function isVpcPrivateIpv4(value) {
  const parts = String(value).split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 172 && parts[1] === 31;
}

export function parseEnvironmentFile(source) {
  const environment = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`invalid environment assignment on line ${index + 1}`);
    const [, name, rawValue] = match;
    if (Object.hasOwn(environment, name)) throw new Error(`duplicate environment variable ${name}`);
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment[name] = value;
  }
  return environment;
}

export function listeningCloudPayPorts(source) {
  return [...new Set(source.split(/\r?\n/u).flatMap((line) => {
    const match = /(?:\[.*\]|\d+(?:\.\d+){3}|\*):((?:4100|4154))\b/u.exec(line);
    return match ? [Number(match[1])] : [];
  }))].sort((left, right) => left - right);
}

function run(binary, args, options = {}) {
  return spawnSync(binary, args, { encoding: 'utf8', ...options });
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path));
}

function versionAtLeast(actual, minimum) {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...filesUnder(path)] : [path];
  });
}

function sameFile(left, right, substitutions = {}) {
  if (!existsSync(left) || !existsSync(right)) return false;
  let expected = readFileSync(left, 'utf8');
  for (const [from, to] of Object.entries(substitutions)) expected = expected.replaceAll(from, to);
  return readFileSync(right, 'utf8') === expected;
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Usage: node preflight-host.mjs --private-ip 172.31.x.x --baseline /absolute/cloudpay-before.json --report /absolute/preflight.json\n');
    process.exit(2);
  }

  const reportPath = resolve(args.report);
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass, detail });
  check('linux_target', process.platform === 'linux', process.platform);
  check('root_operator', typeof process.getuid === 'function' && process.getuid() === 0,
    typeof process.getuid === 'function' ? `uid=${process.getuid()}` : 'uid unavailable');

  const nodePath = '/usr/bin/node';
  const node = run(nodePath, ['--version']);
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/u, '') : '';
  check('pinned_node_runtime', existsSync(nodePath) && node.status === 0 && versionAtLeast(nodeVersion, '22.18.0'),
    nodeVersion || '/usr/bin/node unavailable');

  const hostTools = {
    npm: firstExisting(['/usr/bin/npm']), systemctl: firstExisting(['/usr/bin/systemctl', '/bin/systemctl']),
    nft: firstExisting(['/usr/sbin/nft', '/usr/bin/nft']), ss: firstExisting(['/usr/bin/ss', '/usr/sbin/ss']),
    ip: firstExisting(['/usr/sbin/ip', '/usr/bin/ip']), getent: firstExisting(['/usr/bin/getent']),
    pg_dump: firstExisting(['/usr/bin/pg_dump']), pg_restore: firstExisting(['/usr/bin/pg_restore']),
  };
  for (const [name, command] of Object.entries(hostTools)) {
    check(`host_tool_${name}`, Boolean(command), command ?? 'missing');
  }

  const user = run('/usr/bin/getent', ['passwd', 'kai-cloudpay']);
  const userParts = user.status === 0 ? user.stdout.trim().split(':') : [];
  const serviceUid = Number(userParts[2]);
  const noLoginShell = /(?:nologin|false)$/u.test(userParts[6] ?? '');
  check('service_identity', userParts[0] === 'kai-cloudpay' && Number.isInteger(serviceUid) && noLoginShell,
    userParts[0] === 'kai-cloudpay' ? `uid=${serviceUid}, no-login=${String(noLoginShell)}` : 'kai-cloudpay missing');

  let assignedAddresses = [];
  const ip = hostTools.ip ? run(hostTools.ip, ['-j', 'address', 'show']) : { status: 127, stdout: '' };
  try {
    assignedAddresses = JSON.parse(ip.stdout || '[]').flatMap((entry) => entry.addr_info ?? []).map((entry) => entry.local);
  } catch { assignedAddresses = []; }
  check('vpc_private_ip', isVpcPrivateIpv4(args['private-ip']) && assignedAddresses.includes(args['private-ip']),
    isVpcPrivateIpv4(args['private-ip']) ? `${args['private-ip']} assigned=${String(assignedAddresses.includes(args['private-ip']))}` : 'must be assigned 172.31.0.0/16 IPv4');

  const listeners = hostTools.ss ? run(hostTools.ss, ['-H', '-ltnp']) : { status: 127, stdout: '' };
  const occupied = listeners.status === 0 ? listeningCloudPayPorts(listeners.stdout) : [4100, 4154];
  check('dedicated_ports_free', listeners.status === 0 && occupied.length === 0,
    occupied.length ? `occupied: ${occupied.join(', ')}` : '4100 and 4154 are free');

  const currentPath = '/opt/kai-cloudpay/current';
  let currentTarget = '';
  try { currentTarget = realpathSync(currentPath); } catch { currentTarget = ''; }
  check('current_release_selected', currentTarget === releaseRoot, currentTarget || 'current symlink missing');

  const unsafeReleaseEntries = existsSync(releaseRoot) ? [releaseRoot, ...filesUnder(releaseRoot)].filter((path) => {
    const stats = statSync(path);
    return stats.uid !== 0 || (stats.mode & 0o022) !== 0;
  }) : [releaseRoot];
  check('release_tree_root_owned_read_only', unsafeReleaseEntries.length === 0,
    unsafeReleaseEntries.length ? `${unsafeReleaseEntries.length} unsafe entries` : 'root-owned, no group/other writes');

  const environmentPath = '/etc/kai-cloudpay/backend.env';
  let environment = {};
  let environmentDetail = 'missing';
  if (existsSync(environmentPath)) {
    const stats = statSync(environmentPath);
    try {
      environment = parseEnvironmentFile(readFileSync(environmentPath, 'utf8'));
      environmentDetail = `mode=${(stats.mode & 0o777).toString(8)}, owner=${stats.uid}:${stats.gid}`;
      check('production_environment_permissions', stats.uid === 0 && stats.gid === 0 && (stats.mode & 0o777) === 0o600, environmentDetail);
    } catch (error) {
      environmentDetail = error instanceof Error ? error.message : String(error);
      check('production_environment_permissions', false, environmentDetail);
    }
  } else check('production_environment_permissions', false, environmentDetail);

  const productionGate = run(nodePath, ['scripts/verify-production-env.mjs'], {
    cwd: releaseRoot,
    env: { PATH: process.env.PATH ?? '', ...environment },
  });
  check('production_capabilities_configured', productionGate.status === 0,
    productionGate.status === 0 ? 'release configuration gate passed' : 'release configuration gate rejected the host');

  const unitDirectory = '/etc/systemd/system';
  const unitNames = [
    'cloudpay-mobile-backend.service', 'cloudpay-mobile-migrate.service', 'cloudpay-mobile-backup.service',
    'cloudpay-mobile-backup.timer', 'cloudpay-mobile-edge.service', 'cloudpay-mobile-edge-firewall.service',
  ];
  const mismatchedUnits = unitNames.filter((name) => !sameFile(join(releaseRoot, 'deploy/aws-ubuntu', name), join(unitDirectory, name)));
  const socketMatches = sameFile(join(releaseRoot, 'deploy/aws-ubuntu/cloudpay-mobile-edge.socket'),
    join(unitDirectory, 'cloudpay-mobile-edge.socket'), { PRIVATE_IPV4: args['private-ip'] });
  const firewallMatches = sameFile(join(releaseRoot, 'deploy/aws-ubuntu/cloudpay-mobile-edge.nft'),
    '/etc/kai-cloudpay/cloudpay-mobile-edge.nft');
  check('installed_service_contract', mismatchedUnits.length === 0 && socketMatches && firewallMatches,
    mismatchedUnits.length || !socketMatches || !firewallMatches
      ? `mismatch: ${[...mismatchedUnits, ...(!socketMatches ? ['cloudpay-mobile-edge.socket'] : []), ...(!firewallMatches ? ['cloudpay-mobile-edge.nft'] : [])].join(', ')}`
      : 'release units, private socket and firewall match');

  const backupDirectory = '/var/lib/kai-cloudpay-backup';
  let backupReady = false;
  let backupDetail = 'missing';
  if (existsSync(backupDirectory)) {
    const stats = statSync(backupDirectory);
    backupReady = stats.isDirectory() && stats.uid === serviceUid && stats.gid === Number(userParts[3]) && (stats.mode & 0o777) === 0o700;
    backupDetail = `mode=${(stats.mode & 0o777).toString(8)}, owner=${stats.uid}:${stats.gid}`;
  }
  check('backup_workspace_locked', backupReady, backupDetail);

  let baseline;
  try { baseline = JSON.parse(readFileSync(resolve(args.baseline), 'utf8')); } catch { baseline = null; }
  const capturedAt = Date.parse(baseline?.capturedAt ?? '');
  const baselineAge = Date.now() - capturedAt;
  const baselineReady = baseline?.schemaVersion === 1 && baseline?.origin === 'https://cloudpay.kai.com'
    && baseline?.protected?.['/'] && baseline?.protected?.['/api/health']
    && Number.isFinite(capturedAt) && baselineAge >= 0 && baselineAge <= 24 * 60 * 60 * 1000;
  check('fresh_old_site_baseline', Boolean(baselineReady), baselineReady ? `${Math.round(baselineAge / 60_000)} minutes old` : 'missing, invalid or older than 24 hours');

  const failures = checks.filter((item) => !item.pass);
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    releaseRoot,
    privateIp: args['private-ip'],
    readyForMigrationAndSidecarStart: failures.length === 0,
    nextStep: failures.length === 0 ? 'run_migration_then_backend_backup_and_private_probes' : 'fix_host_before_starting_any_cloudpay_unit',
    checks,
  };
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  for (const item of checks) process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
