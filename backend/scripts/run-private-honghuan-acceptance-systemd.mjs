import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInquiryReadinessProbe } from './record-inquiry-readiness.mjs';
import { validateLoopbackProbeDatabaseUrl } from './kai-probe-credential-core.mjs';

const credentialDirectory = resolve(process.env.CREDENTIALS_DIRECTORY ?? '');
const runtimeDirectory = resolve(process.env.RUNTIME_DIRECTORY ?? '');
if (!credentialDirectory.startsWith('/run/credentials/') || runtimeDirectory !== '/run/kai-cloudpay-probe') {
  throw new Error('HONGHUAN_PRIVATE_ACCEPTANCE_SYSTEMD_DIRECTORIES_REQUIRED');
}
const pairPath = resolve(runtimeDirectory, 'ephemeral-token-pair.json');
const [pairBytes, databaseUrlBytes, auditPepperBytes] = await Promise.all([
  readFile(pairPath, 'utf8'),
  readFile(resolve(credentialDirectory, 'kai-probe-database-url'), 'utf8'),
  readFile(resolve(credentialDirectory, 'kai-probe-audit-pepper'), 'utf8'),
]);
const pair = JSON.parse(pairBytes);
const databaseUrl = databaseUrlBytes.trim();
const auditPepper = auditPepperBytes.trim();
if (!pair || Object.keys(pair).sort().join(',') !== 'accessToken,idToken,schemaVersion,subjectSha256'
  || pair.schemaVersion !== 1 || typeof pair.accessToken !== 'string' || pair.accessToken.length < 20
  || typeof pair.idToken !== 'string' || pair.idToken.length < 40
  || typeof pair.subjectSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(pair.subjectSha256)
  || auditPepper.length < 32) {
  throw new Error('HONGHUAN_PRIVATE_ACCEPTANCE_EPHEMERAL_INPUT_INVALID');
}
validateLoopbackProbeDatabaseUrl(databaseUrl);
try {
  const result = await runInquiryReadinessProbe({
    accessToken: pair.accessToken, idToken: pair.idToken, probeSubjectSha256: pair.subjectSha256,
    probeOrigin: 'http://172.31.31.78:4154',
    probeScope: 'private_sidecar', environment: {
      NODE_ENV: 'production', MOBILE_API_PROFILE: 'inquiry_only', PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
      DATABASE_URL: databaseUrl, DATABASE_SSL: 'false', AUDIT_PEPPER: auditPepper,
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, scope: 'private_sidecar', schemaVersion: result.schemaVersion,
    catalog: { total: 11, hourly: 10, contract: 1, details: 11, jsonOnly: true },
    formalInquiry: true, commerceUnchanged: result.commerceUnchanged })}\n`);
} finally {
  await rm(pairPath, { force: true });
}
