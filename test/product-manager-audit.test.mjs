import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  stagedAuditRecords,
  stagedProductDigest,
  validAuditRecord,
  verifyCommittedProductManagerAudit,
  verifyStagedProductManagerAudit,
} from '../scripts/verify-product-manager-audit.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'zod-product-audit-'));
  git(root, 'init');
  git(root, 'config', 'user.name', 'Zod Test');
  git(root, 'config', 'user.email', 'zod-test@example.invalid');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-m', 'base');
  return root;
}

function record(root, overrides = {}) {
  return {
    schemaVersion: 1,
    auditId: 'PM-20260817-001',
    auditor: 'App product manager',
    decision: 'APPROVED',
    auditedAt: '2026-08-17T03:20:00.000Z',
    baseCommit: git(root, 'rev-parse', 'HEAD'),
    stagedDiffSha256: stagedProductDigest(root),
    summary: '产品结构、交易红线与前后端一致性审计通过。',
    ...overrides,
  };
}

test('only a staged approval bound to the exact staged diff can pass', () => {
  const root = repository();
  writeFileSync(join(root, 'change.txt'), 'approved change\n');
  git(root, 'add', 'change.txt');
  const audit = record(root);
  const auditPath = join(root, 'docs/product-audits/PM-20260817-001.json');
  execFileSync('mkdir', ['-p', join(root, 'docs/product-audits')]);
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  assert.deepEqual(stagedAuditRecords(root), []);
  assert.throws(() => verifyStagedProductManagerAudit(root), /尚未批准/u);

  git(root, 'add', 'docs/product-audits/PM-20260817-001.json');
  assert.equal(verifyStagedProductManagerAudit(root).auditId, audit.auditId);
  writeFileSync(auditPath, '{"decision":"CHANGES_REQUESTED"}\n');
  assert.equal(verifyStagedProductManagerAudit(root).auditId, audit.auditId);

  git(root, 'commit', '-m', 'audited change');
  assert.equal(verifyCommittedProductManagerAudit('HEAD', root).auditId, audit.auditId);
});

test('invalid decisions, identities, timestamps, hashes and summaries are rejected', () => {
  const expected = { baseCommit: 'a'.repeat(40), stagedDiffSha256: 'b'.repeat(64) };
  const valid = {
    schemaVersion: 1, auditId: 'PM-20260817-002', auditor: 'App product manager', decision: 'APPROVED',
    auditedAt: '2026-08-17T03:20:00.000Z', summary: '所有产品红线以及前后端契约均已通过审计。', ...expected,
  };
  const now = Date.parse('2026-08-17T04:00:00.000Z');
  assert.equal(validAuditRecord(valid, expected, now), true);
  for (const invalid of [
    { decision: 'CHANGES_REQUESTED' }, { auditor: 'Developer' }, { auditId: '' }, { summary: '' },
    { baseCommit: 'bad' }, { stagedDiffSha256: 'bad' }, { auditedAt: 'invalid' },
    { auditedAt: '2026-08-17T05:00:00.000Z' },
  ]) assert.equal(validAuditRecord({ ...valid, ...invalid }, expected, now), false);
});
