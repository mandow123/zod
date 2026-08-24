import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { probeInquiryOrigin } from './probe-inquiry.mjs';

const ORIGIN_PRIVATE_IP = '172.31.33.227';
const SIDECAR = 'http://172.31.31.78:4154';
const ACTIVE_CONFIG = '/home/ubuntu/kai-transaction-v1/nginx-kai.conf';
const EDGE_CONTAINER = 'kai-transaction-edge';
const CONTAINER_CONFIG = '/etc/nginx/nginx.conf';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const values = process.argv.slice(2);
const value = (flag) => { const index = values.indexOf(flag); return index >= 0 ? values[index + 1] : undefined; };
const baselinePath = value('--baseline');
const nginxConfigPath = value('--nginx-config');
const reportValue = value('--report');
if (values.length !== 6 || !baselinePath || !nginxConfigPath || !reportValue) {
  process.stderr.write('Usage: node preflight-origin.mjs --baseline /absolute/before.json --nginx-config /absolute/site.conf --report /absolute/report.json\n');
  process.exit(2);
}

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
check('linux_root_operator', process.platform === 'linux' && process.getuid?.() === 0, 'root on Linux required');
let addresses = '';
try { addresses = execFileSync('/usr/sbin/ip', ['-4', '-o', 'addr', 'show'], { encoding: 'utf8' }); } catch {}
check('legacy_origin_private_identity', addresses.includes(` ${ORIGIN_PRIVATE_IP}/`), ORIGIN_PRIVATE_IP);
check('authoritative_host_config_path', resolve(nginxConfigPath) === ACTIVE_CONFIG, ACTIVE_CONFIG);
let baseline;
try { baseline = JSON.parse(await readFile(resolve(baselinePath), 'utf8')); } catch {}
const baselineAge = Date.now() - Date.parse(baseline?.capturedAt);
check('fresh_public_baseline', baseline?.schemaVersion === 1 && Number.isFinite(baselineAge)
  && baselineAge >= -5 * 60_000 && baselineAge <= 24 * 60 * 60_000,
  baseline?.capturedAt ?? 'missing');
const publicRoot = baseline?.protected?.root?.public;
const directRoot = baseline?.protected?.root?.direct;
const publicApi = baseline?.protected?.apiHealth?.public;
const directApi = baseline?.protected?.apiHealth?.direct;
check('same_time_public_direct_root_baseline', publicRoot?.bytes > 0 && publicRoot?.bytes === directRoot?.bytes
  && publicRoot?.sha256 === directRoot?.sha256, publicRoot?.sha256 ?? 'missing');
check('same_time_public_direct_api_baseline', publicApi?.bytes > 0 && publicApi?.bytes === directApi?.bytes
  && publicApi?.sha256 === directApi?.sha256, publicApi?.sha256 ?? 'missing');
check('legacy_api_identity', publicApi?.json?.service === 'kai-transaction' && publicApi?.json?.phase === 1
  && publicApi?.json?.payment_mode === 'provider' && publicApi?.json?.auth_provider === 'kai_identity'
  && publicApi?.json?.auth_ready === true, publicApi?.json?.service ?? 'missing');
let nginxBytes;
try { nginxBytes = await readFile(resolve(nginxConfigPath)); } catch {}
check('legacy_nginx_config_readable', Boolean(nginxBytes), nginxBytes ? sha256(nginxBytes) : 'missing');
let nginxMode = 0;
try { nginxMode = (await stat(resolve(nginxConfigPath))).mode & 0o777; } catch {}
check('legacy_nginx_config_not_world_writable', Boolean(nginxBytes) && (nginxMode & 0o022) === 0, nginxMode.toString(8));
let containerInspect;
let containerConfig;
let nginxBuild='';
try {
  containerInspect = JSON.parse(execFileSync('/usr/bin/docker', ['inspect', EDGE_CONTAINER], { encoding: 'utf8' }))[0];
  containerConfig = execFileSync('/usr/bin/docker', ['exec', EDGE_CONTAINER, 'cat', CONTAINER_CONFIG]);
  nginxBuild = execFileSync('/usr/bin/docker', ['exec', EDGE_CONTAINER, 'sh', '-c', 'nginx -V 2>&1'], { encoding: 'utf8' });
  execFileSync('/usr/bin/docker', ['exec', EDGE_CONTAINER, 'nginx', '-t'], { stdio: 'ignore' });
} catch {}
const configMount = containerInspect?.Mounts?.find((mount) => mount.Source === ACTIVE_CONFIG && mount.Destination === CONTAINER_CONFIG);
check('legacy_edge_container_running', containerInspect?.State?.Running === true, EDGE_CONTAINER);
check('legacy_config_bind_mount_read_only', configMount?.RW === false, `${ACTIVE_CONFIG} -> ${CONTAINER_CONFIG} ro`);
check('nginx_realip_module_available', nginxBuild.includes('--with-http_realip_module'), 'ngx_http_realip_module');
check('host_container_config_identical', Boolean(nginxBytes && containerConfig)
  && sha256(nginxBytes) === sha256(containerConfig), nginxBytes && containerConfig ? sha256(containerConfig) : 'missing');
let sidecar;
try { sidecar = await probeInquiryOrigin(SIDECAR, { allowExpectedPublicProofBlockers: true }); } catch (error) {
  sidecar = { ok: false, failures: [error instanceof Error ? error.message : String(error)] };
}
check('private_sidecar_from_exact_origin', sidecar.ok === true, sidecar.failures?.join('; ') || SIDECAR);
const failures = checks.filter((item) => !item.pass);
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), hostRole: 'legacy_origin',
  privateIpv4: ORIGIN_PRIVATE_IP, sidecar: SIDECAR, publicOrigin: 'https://cloudpay.kai.com',
  nginxConfigPath: resolve(nginxConfigPath), nginxConfigSha256: nginxBytes ? sha256(nginxBytes) : null,
  readyForNginxRouteActivation: failures.length === 0, checks, sidecarProbe: sidecar, failures };
const reportPath = resolve(reportValue);
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${failures.length === 0 ? 'PASS' : 'FAIL'} origin_preflight\nReport: ${reportPath}\n`);
if (failures.length > 0) process.exit(1);
