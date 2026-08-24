#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { auditToken, hmac, parseArgs, readCredential, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';

const args = parseArgs(process.argv.slice(2));
const allowed = new Set(['system', 'audit-key-file', 'input', 'output']);
if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('UNIFIED_ARGUMENT_INVALID');
const system = required(args, 'system');
const expectedKind = system === '18_node_auth_pg' ? 'auth18_postgres_readonly'
  : system === '43_node_commerce_pg' ? 'commerce43_postgres_readonly' : null;
if (!expectedKind) throw new Error('UNIFIED_EXTERNAL_SYSTEM_INVALID');
const key = await readCredential(required(args, 'audit-key-file'));
const evidence = JSON.parse(await readFile(required(args, 'input'), 'utf8'));
if (evidence?.schemaVersion !== 1 || evidence.kind !== expectedKind
  || typeof evidence.canonicalIdentity !== 'string' || !evidence.canonicalIdentity.startsWith('postgres|')
  || evidence.canonicalIdentity.length > 2048 || /[\u0000-\u001f\u007f]/u.test(evidence.canonicalIdentity)
  || !/^[0-9a-f]{64}$/u.test(evidence.schemaDigest)
  || !Number.isSafeInteger(evidence.tableCount) || evidence.tableCount < 1
  || !Number.isSafeInteger(evidence.migrationCount) || evidence.migrationCount < 0
  || !/^[0-9a-f]{64}$/u.test(evidence.migrationDigest)
  || !evidence.counts || Object.values(evidence.counts).some((count) => !Number.isSafeInteger(count) || count < 0)
  || evidence.privacy?.piiValuesIncluded !== false
  || (system === '18_node_auth_pg' && evidence.privacy?.rawSubjectsIncluded !== false)
  || evidence.privacy?.credentialsIncluded !== false) {
  throw new Error('UNIFIED_READONLY_EVIDENCE_INVALID');
}
const output = { schemaVersion: 1, system,
  fingerprintToken: auditToken(key, 'system', `${system}|${evidence.canonicalIdentity}`),
  fingerprintDigest: sha256(`${system}|${evidence.canonicalIdentity}`), schemaDigest: evidence.schemaDigest,
  tableCounts: evidence.counts, tableCount: evidence.tableCount, migrationCount: evidence.migrationCount,
  migrationDigest: evidence.migrationDigest, primaryKeyOrdinalValidated: false,
  primaryKeyColumnCount: 0, primaryKeyOrdinalDigest: sha256(stable([])) };
if (system === '18_node_auth_pg') {
  if (!Array.isArray(evidence.verifiedSubjectTokens)
    || evidence.verifiedSubjectTokens.some((token) => !/^kai-subject_[0-9a-f]{64}$/u.test(token))
    || !Number.isSafeInteger(evidence.sourceSubjectCandidates) || evidence.sourceSubjectCandidates < 0
    || !Number.isSafeInteger(evidence.matchedSubjects) || evidence.matchedSubjects < 0
    || evidence.matchedSubjects !== evidence.verifiedSubjectTokens.length) {
    throw new Error('UNIFIED_AUTH_EVIDENCE_INVALID');
  }
  if (evidence.matchedSubjects !== 0) throw new Error('UNIFIED_AUTH_MATCH_MAPPING_REQUIRED');
  Object.assign(output, { verifiedSubjectCount: evidence.counts.identities,
    sourceIdentityMatches: [], sourceSubjectCandidates: evidence.sourceSubjectCandidates,
    matchedSubjects: evidence.matchedSubjects,
    matchingPolicy: 'production_subject_pepper_hmac_sha512_exact_match_reported_as_audit_hmac_sha256_tokens' });
}
output.attestationHmac = hmac(key, stable(output));
output.reportDigest = sha256(stable(output));
const written = await writeJson0600(required(args, 'output'), output);
process.stdout.write(`${JSON.stringify({ ok: true, system, output: written, reportDigest: output.reportDigest })}\n`);
