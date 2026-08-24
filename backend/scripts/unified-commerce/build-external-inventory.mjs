#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { auditToken, hmac, parseArgs, readCredential, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';

const args = parseArgs(process.argv.slice(2));
const allowed = new Set(['system', 'token-key-file', 'input', 'output']);
if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('UNIFIED_ARGUMENT_INVALID');
const system = required(args, 'system');
if (!['18_node_auth_pg', '43_node_commerce_pg'].includes(system)) throw new Error('UNIFIED_EXTERNAL_SYSTEM_INVALID');
const tokenKey = await readCredential(required(args, 'token-key-file'));
const inputPath = required(args, 'input');
const input = JSON.parse(await readFile(inputPath === '-' ? 0 : inputPath, 'utf8'));
if (input?.schemaVersion !== 1 || input.system !== system
  || typeof input.fingerprintMaterial !== 'string' || input.fingerprintMaterial.length < 8
  || input.fingerprintMaterial.length > 2048 || /[\u0000-\u001f\u007f]/u.test(input.fingerprintMaterial)
  || !Array.isArray(input.schemaRows) || !input.tableCounts || typeof input.tableCounts !== 'object'
  || !Number.isSafeInteger(input.migrationCount) || input.migrationCount < 0
  || !/^[0-9a-f]{64}$/u.test(input.migrationDigest)
  || Object.values(input.tableCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
  throw new Error('UNIFIED_EXTERNAL_INPUT_INVALID');
}
const normalizeSchemaRow = (row) => {
  if (!row || typeof row.tableName !== 'string' || typeof row.columnName !== 'string'
    || typeof row.dataType !== 'string' || typeof row.isNullable !== 'boolean'
    || !Number.isSafeInteger(row.primaryKeyOrdinal) || row.primaryKeyOrdinal < 0) {
    throw new Error('UNIFIED_EXTERNAL_SCHEMA_INVALID');
  }
  return { tableName: row.tableName, columnName: row.columnName, dataType: row.dataType.toLowerCase(),
    isNullable: row.isNullable, primaryKeyOrdinal: row.primaryKeyOrdinal };
};
const schemaRows = input.schemaRows.map(normalizeSchemaRow)
  .sort((left, right) => stable(left).localeCompare(stable(right)));
const schemaKeys = new Set(); const primaryKeysByTable = new Map();
for (const row of schemaRows) {
  const key = `${row.tableName}\0${row.columnName}`;
  if (schemaKeys.has(key)) throw new Error('UNIFIED_EXTERNAL_SCHEMA_DUPLICATE');
  schemaKeys.add(key);
  if (row.primaryKeyOrdinal > 0) {
    const ordinals = primaryKeysByTable.get(row.tableName) ?? [];
    ordinals.push(row.primaryKeyOrdinal); primaryKeysByTable.set(row.tableName, ordinals);
  }
}
for (const ordinals of primaryKeysByTable.values()) {
  ordinals.sort((left, right) => left - right);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new Error('UNIFIED_EXTERNAL_PRIMARY_KEY_ORDINAL_INVALID');
}
const primaryKeySnapshot = schemaRows.filter((row) => row.primaryKeyOrdinal > 0)
  .map((row) => ({ tableName: row.tableName, columnName: row.columnName,
    primaryKeyOrdinal: row.primaryKeyOrdinal }));
const output = { schemaVersion: 1, system,
  fingerprintToken: auditToken(tokenKey, 'system', `${system}|${input.fingerprintMaterial}`),
  fingerprintDigest: sha256(`${system}|${input.fingerprintMaterial}`),
  schemaDigest: sha256(stable(schemaRows)), tableCounts: input.tableCounts,
  tableCount: new Set(schemaRows.map((row) => row.tableName)).size,
  primaryKeyOrdinalValidated: true, primaryKeyColumnCount: primaryKeySnapshot.length,
  primaryKeyOrdinalDigest: sha256(stable(primaryKeySnapshot)),
  migrationCount: input.migrationCount, migrationDigest: input.migrationDigest };
if (system === '18_node_auth_pg') {
  if (input.tokenOnlyAttestation) {
    const attestation = input.tokenOnlyAttestation;
    if (!Number.isSafeInteger(attestation.verifiedSubjectCount) || attestation.verifiedSubjectCount < 0
      || !Number.isSafeInteger(attestation.sourceSubjectCandidates) || attestation.sourceSubjectCandidates < 0
      || !Number.isSafeInteger(attestation.matchedSubjects) || attestation.matchedSubjects < 0
      || !Array.isArray(attestation.sourceIdentityMatches)
      || attestation.matchedSubjects !== 0 || attestation.sourceIdentityMatches.length !== 0
      || attestation.sourceIdentityMatches.some((match) => !/^users_[0-9a-f]{64}$/u.test(match?.sourceUserToken)
        || !/^kai-subject_[0-9a-f]{64}$/u.test(match?.verifiedSubjectToken))) {
      throw new Error('UNIFIED_AUTH_TOKEN_ATTESTATION_INVALID');
    }
    Object.assign(output, { verifiedSubjectCount: attestation.verifiedSubjectCount,
      sourceSubjectCandidates: attestation.sourceSubjectCandidates, matchedSubjects: attestation.matchedSubjects,
      sourceIdentityMatches: [...attestation.sourceIdentityMatches]
        .sort((left, right) => left.sourceUserToken.localeCompare(right.sourceUserToken)),
      matchingPolicy: 'production_subject_pepper_hmac_sha512_exact_match_reported_as_audit_hmac_sha256_tokens' });
  } else {
    if (!Array.isArray(input.verifiedSubjects) || !Array.isArray(input.candidateSubjects)) {
      throw new Error('UNIFIED_AUTH_SUBJECT_INPUT_REQUIRED');
    }
    const verifiedSubjectTokens = new Set(input.verifiedSubjects.map((subject) => {
      if (typeof subject !== 'string' || subject.length === 0 || subject.length > 2048
        || /[\u0000-\u001f\u007f]/u.test(subject)) throw new Error('UNIFIED_AUTH_SUBJECT_INVALID');
      return auditToken(tokenKey, 'kai-subject', subject);
    }));
    const sourceIdentityMatches = []; const seenCandidates = new Set();
    for (const candidate of input.candidateSubjects) {
      if (!candidate || !/^users_[0-9a-f]{64}$/u.test(candidate.sourceUserToken)
        || typeof candidate.subject !== 'string' || candidate.subject.length === 0 || candidate.subject.length > 2048
        || /[\u0000-\u001f\u007f]/u.test(candidate.subject)
        || seenCandidates.has(candidate.sourceUserToken)) throw new Error('UNIFIED_SOURCE_IDENTITY_CANDIDATE_INVALID');
      seenCandidates.add(candidate.sourceUserToken);
      const verifiedSubjectToken = auditToken(tokenKey, 'kai-subject', candidate.subject);
      if (verifiedSubjectTokens.has(verifiedSubjectToken)) {
        sourceIdentityMatches.push({ sourceUserToken: candidate.sourceUserToken, verifiedSubjectToken });
      }
    }
    Object.assign(output, { verifiedSubjectCount: verifiedSubjectTokens.size,
      sourceSubjectCandidates: input.candidateSubjects.length, matchedSubjects: sourceIdentityMatches.length,
      sourceIdentityMatches: sourceIdentityMatches.sort((left, right) => left.sourceUserToken.localeCompare(right.sourceUserToken)),
      matchingPolicy: 'controlled_subject_exact_match_reported_as_audit_hmac_sha256_tokens' });
  }
}
output.attestationHmac = hmac(tokenKey, stable(output));
output.reportDigest = sha256(stable(output));
const written = await writeJson0600(required(args, 'output'), output);
process.stdout.write(`${JSON.stringify({ ok: true, system, output: written, reportDigest: output.reportDigest })}\n`);
