import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const auditPathPattern = /^docs\/product-audits\/[^/]+\.json$/u;
const auditIdPattern = /^PM-\d{8}-\d{3,}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function git(root, args, encoding = 'utf8') {
  const output = execFileSync('git', args, {
    cwd: root,
    encoding,
    // Binary brand assets can make an otherwise small reviewed diff exceed
    // Node's 1 MiB child-process default. Keep the audit fail-closed while
    // allowing the complete diff to be hashed instead of truncating it.
    maxBuffer: 64 * 1024 * 1024,
  });
  return typeof output === 'string' ? output.trim() : output;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stagedProductDigest(root = defaultRoot) {
  return sha256(git(root, ['diff', '--cached', '--binary', '--', '.', ':(exclude)docs/product-audits/**'], null));
}

export function commitProductDigest(commit = 'HEAD', root = defaultRoot) {
  return sha256(git(root, ['diff-tree', '--root', '--no-commit-id', '--binary', '-r', `${commit}^{commit}`,
    '--', '.', ':(exclude)docs/product-audits/**'], null));
}

function stagedAuditPaths(root) {
  return git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').filter((name) => auditPathPattern.test(name));
}

function commitAuditPaths(commit, root) {
  return git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=ACMR', '-r', `${commit}^{commit}`])
    .split('\n').filter((name) => auditPathPattern.test(name));
}

function parseAudit(content, path) {
  try { return JSON.parse(content); } catch { throw new Error(`产品经理审计记录不是有效 JSON：${path}`); }
}

export function stagedAuditRecords(root = defaultRoot) {
  return stagedAuditPaths(root).map((path) => parseAudit(git(root, ['show', `:${path}`]), path));
}

export function commitAuditRecords(commit = 'HEAD', root = defaultRoot) {
  return commitAuditPaths(commit, root).map((path) => parseAudit(git(root, ['show', `${commit}^{commit}:${path}`]), path));
}

export function validAuditRecord(record, expected, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const auditedAt = typeof record.auditedAt === 'string' ? Date.parse(record.auditedAt) : Number.NaN;
  return record.schemaVersion === 1
    && record.decision === 'APPROVED'
    && record.auditor === 'App product manager'
    && typeof record.auditId === 'string' && auditIdPattern.test(record.auditId)
    && typeof record.summary === 'string' && record.summary.trim().length >= 12
    && typeof record.baseCommit === 'string' && commitPattern.test(record.baseCommit)
    && typeof record.stagedDiffSha256 === 'string' && digestPattern.test(record.stagedDiffSha256)
    && record.baseCommit === expected.baseCommit
    && record.stagedDiffSha256 === expected.stagedDiffSha256
    && Number.isFinite(auditedAt) && auditedAt <= now;
}

export function matchingAudit(records, expected, now = Date.now()) {
  return records.find((record) => validAuditRecord(record, expected, now));
}

export function verifyStagedProductManagerAudit(root = defaultRoot, now = Date.now()) {
  const stagedNames = git(root, ['diff', '--cached', '--name-only']);
  if (!stagedNames) throw new Error('没有暂存代码，不能创建提交。');
  const expected = { baseCommit: git(root, ['rev-parse', 'HEAD']), stagedDiffSha256: stagedProductDigest(root) };
  const approved = matchingAudit(stagedAuditRecords(root), expected, now);
  if (!approved) throw new Error(`产品经理尚未批准本次暂存代码。\n基线: ${expected.baseCommit}\n差异摘要: ${expected.stagedDiffSha256}`);
  return approved;
}

export function verifyCommittedProductManagerAudit(commit = 'HEAD', root = defaultRoot, now = Date.now()) {
  const resolvedCommit = git(root, ['rev-parse', `${commit}^{commit}`]);
  const lineage = git(root, ['rev-list', '--parents', '-n', '1', resolvedCommit]).split(' ');
  const parents = lineage.slice(1);
  if (parents.length > 1) throw new Error(`产品经理审计不接受 merge commit，请先 rebase 或 squash。\n提交: ${resolvedCommit}`);
  const baseCommit = parents[0] ?? '0000000000000000000000000000000000000000';
  const expected = { baseCommit, stagedDiffSha256: commitProductDigest(resolvedCommit, root) };
  const approved = matchingAudit(commitAuditRecords(resolvedCommit, root), expected, now);
  if (!approved) throw new Error(`提交缺少匹配的产品经理批准记录。\n提交: ${resolvedCommit}\n基线: ${baseCommit}\n差异摘要: ${expected.stagedDiffSha256}`);
  return approved;
}

export function verifyProductManagerAuditRange(base, head, root = defaultRoot, now = Date.now()) {
  const resolvedBase = git(root, ['rev-parse', `${base}^{commit}`]);
  const resolvedHead = git(root, ['rev-parse', `${head}^{commit}`]);
  try {
    git(root, ['merge-base', '--is-ancestor', resolvedBase, resolvedHead]);
  } catch {
    throw new Error(`审计范围不是线性祖先关系，请先 rebase 或 squash。\n基线: ${resolvedBase}\n提交: ${resolvedHead}`);
  }
  const listed = git(root, ['rev-list', '--reverse', '--topo-order', `${resolvedBase}..${resolvedHead}`]);
  const commits = listed ? listed.split('\n').filter(Boolean) : [];
  if (commits.length === 0) throw new Error('审计范围内没有提交。');
  return commits.map((commit) => verifyCommittedProductManagerAudit(commit, root, now));
}

function main() {
  const commitFlag = process.argv.indexOf('--commit');
  const rangeFlag = process.argv.indexOf('--range');
  if (commitFlag >= 0 && rangeFlag >= 0) throw new Error('--commit 与 --range 不能同时使用。');
  let approved;
  if (rangeFlag >= 0) {
    const [base, head] = process.argv.slice(rangeFlag + 1, rangeFlag + 3);
    if (!base || !head) throw new Error('用法：audit:product -- --range <base> <head>');
    approved = verifyProductManagerAuditRange(base, head);
  } else {
    approved = commitFlag >= 0
      ? verifyCommittedProductManagerAudit(process.argv[commitFlag + 1] || 'HEAD')
      : verifyStagedProductManagerAudit();
  }
  const auditIds = (Array.isArray(approved) ? approved : [approved]).map((record) => record.auditId);
  process.stdout.write(`产品经理代码审计通过：${auditIds.join(', ')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
