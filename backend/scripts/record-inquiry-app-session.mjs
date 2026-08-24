import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { createDatabase } from '../dist/database.js';
import { databaseFingerprint } from '../dist/backups/postgres.js';
import { probeEvidenceDigest } from '../dist/operations/probe-evidence.js';

const SCHEMA = '0065_credit_order_transition_closure.sql';
const PACKAGE = 'com.kaicloud.marketplace';
const inputIndex = process.argv.indexOf('--report');
const reportPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (!reportPath || !isAbsolute(reportPath)) throw new Error('Use --report with an absolute protected report path.');

const info = await stat(reportPath);
if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size < 100 || info.size > 64 * 1024) {
  throw new Error('APP_SESSION_REPORT_FILE_INVALID');
}
const bytes = await readFile(reportPath);
const reportSha256Digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const report = JSON.parse(bytes.toString('utf8'));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
if (!exact(report, ['schemaVersion','generatedAt','packageName','appVersion','apkSha256Digest','publicOrigin','timeline','checks'])
  || !exact(report.timeline, ['authCompletedAt','consentCompletedAt','storedSessionAt','forceStoppedAt','recoveredAt'])
  || !exact(report.checks, ['auth','me','legalConsent','storedSession','forceStopRestart','recoveredSession'])) {
  throw new Error('APP_SESSION_REPORT_SHAPE_INVALID');
}
if (report.schemaVersion !== 1 || report.packageName !== PACKAGE || typeof report.appVersion !== 'string'
  || !/^[A-Za-z0-9._+-]{1,40}$/u.test(report.appVersion)
  || !/^sha256:[a-f0-9]{64}$/u.test(report.apkSha256Digest)
  || Object.values(report.checks).some((value) => value !== true)) throw new Error('APP_SESSION_REPORT_RESULT_INVALID');
const times = ['authCompletedAt','consentCompletedAt','storedSessionAt','forceStoppedAt','recoveredAt']
  .map((key) => Date.parse(report.timeline[key]));
const generatedAt = Date.parse(report.generatedAt);
if (times.some((value) => !Number.isFinite(value)) || !Number.isFinite(generatedAt)
  || times.some((value, index) => index > 0 && value < times[index - 1]) || generatedAt < times.at(-1)
  || Date.now() - generatedAt < 0 || Date.now() - generatedAt > 30 * 60_000) {
  throw new Error('APP_SESSION_REPORT_TIME_INVALID');
}

const config = loadConfig(process.env);
if (config.NODE_ENV !== 'production' || config.mobileApiProfile !== 'inquiry_only'
  || report.publicOrigin !== config.PUBLIC_ORIGIN || new URL(report.publicOrigin).protocol !== 'https:') {
  throw new Error('APP_SESSION_REPORT_PROFILE_ORIGIN_INVALID');
}
if (!config.DATABASE_URL || !config.AUDIT_PEPPER) throw new Error('APP_SESSION_REPORT_DATABASE_CONFIG_REQUIRED');
const database = createDatabase(config);
if (!database) throw new Error('APP_SESSION_REPORT_DATABASE_REQUIRED');
try {
  const schema = await database.schemaReadiness();
  if (!schema.ready || schema.expected !== SCHEMA || schema.applied !== SCHEMA) throw new Error('DATABASE_SCHEMA_0065_REQUIRED');
  const probeId = randomUUID();
  const metadata = {
    profile: 'inquiry_only', producer: 'record-inquiry-app-session.mjs@1', schemaVersion: SCHEMA,
    databaseFingerprint: databaseFingerprint(config.DATABASE_URL), publicOrigin: config.PUBLIC_ORIGIN,
    packageName: PACKAGE, appVersion: report.appVersion, apkSha256Digest: report.apkSha256Digest,
    reportSha256Digest, testedAt: report.generatedAt, auth: true, me: true, legalConsent: true,
    storedSession: true, forceStopRestart: true, recoveredSession: true,
  };
  await database.transaction(async (client) => client.query(
    `INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata)
     VALUES($1,NULL,'system','INQUIRY_ONLY_APP_SESSION_PROBE_PASSED','PRODUCTION_READINESS_PROBE',$2,$3,$4::jsonb)`,
    [randomUUID(),probeId,probeEvidenceDigest(metadata,config.AUDIT_PEPPER),JSON.stringify(metadata)],
  ));
  process.stdout.write(`${JSON.stringify({ok:true,probeId,profile:'inquiry_only',packageName:PACKAGE,
    appVersion:report.appVersion,reportSha256Digest,recordedAt:new Date().toISOString()})}\n`);
} finally { await database.close(); }
