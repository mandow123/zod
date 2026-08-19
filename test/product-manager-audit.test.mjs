import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  stagedAuditRecords,
  stagedProductDigest,
  validAuditRecord,
  verifyCommittedProductManagerAudit,
  verifyStagedProductManagerAudit,
  verifyProductManagerAuditRange,
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
  mkdirSync(join(root, 'docs/product-audits'), { recursive: true });
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

function auditedCommit(root, auditId, fileName) {
  writeFileSync(join(root, fileName), `${auditId}\n`);
  git(root, 'add', fileName);
  const audit = record(root, { auditId, auditedAt: '2026-08-19T08:00:00.000Z', summary: `产品经理已批准提交 ${auditId} 的完整差异。` });
  const auditPath = join(root, `docs/product-audits/${auditId}.json`);
  mkdirSync(join(root, 'docs/product-audits'), { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  git(root, 'add', `docs/product-audits/${auditId}.json`);
  git(root, 'commit', '-m', auditId);
  return git(root, 'rev-parse', 'HEAD');
}

test('range verification validates every audited commit in order', () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'HEAD');
  auditedCommit(root, 'PM-20260819-101', 'first.txt');
  const head = auditedCommit(root, 'PM-20260819-102', 'second.txt');
  const approvals = verifyProductManagerAuditRange(base, head, root);
  assert.deepEqual(approvals.map((approval) => approval.auditId), ['PM-20260819-101', 'PM-20260819-102']);
});

test('range verification rejects an unaudited commit', () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'missing.txt'), 'missing audit\n');
  git(root, 'add', 'missing.txt');
  git(root, 'commit', '-m', 'missing audit');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.throws(() => verifyProductManagerAuditRange(base, head, root), /缺少匹配的产品经理批准记录/u);
});

test('range verification rejects merge commits', () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'left');
  auditedCommit(root, 'PM-20260819-103', 'left.txt');
  git(root, 'checkout', '-b', 'right', base);
  auditedCommit(root, 'PM-20260819-104', 'right.txt');
  git(root, 'merge', '--no-ff', 'left', '-m', 'merge');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.throws(() => verifyProductManagerAuditRange(base, head, root), /merge commit.*rebase.*squash/iu);
});
