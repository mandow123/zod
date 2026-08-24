import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeInquiryOrigin } from './probe-inquiry.mjs';

const LOOPBACK = 'http://127.0.0.1:4100';

async function main() {
  const values = process.argv.slice(2);
  const reportIndex = values.indexOf('--report');
  const reportValue = reportIndex >= 0 ? values[reportIndex + 1] : undefined;
  if (values.length !== 2 || reportIndex < 0 || !reportValue) {
    process.stderr.write('Usage: node verify-sidecar.mjs --report /absolute/sidecar-probe.json\n');
    process.exit(2);
  }
  let probe;
  const executionFailures = [];
  try { probe = await probeInquiryOrigin(LOOPBACK, { allowExpectedPublicProofBlockers: true }); } catch (error) {
    executionFailures.push(error instanceof Error ? error.message : String(error));
  }
  const readyForOriginProbe = executionFailures.length === 0 && probe?.ok === true;
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), hostRole: 'mobile_sidecar',
    loopback: LOOPBACK, privateEdge: 'http://172.31.31.78:4154', allowedSource: '172.31.33.227/32',
    readyForOriginProbe, nextStep: readyForOriginProbe ? 'verify_from_legacy_origin' : 'keep_origin_routes_unchanged',
    probe: probe ?? null, executionFailures };
  const reportPath = resolve(reportValue);
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${readyForOriginProbe ? 'PASS' : 'FAIL'} sidecar_loopback\nReport: ${reportPath}\n`);
  if (!readyForOriginProbe) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
