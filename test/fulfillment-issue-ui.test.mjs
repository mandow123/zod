import assert from 'node:assert/strict';
import test from 'node:test';
import { fulfillmentIssuePresentation, issueKindLabel } from '../src/fulfillment-issue-ui.ts';

const issue = (status, outcome = null) => ({
  id: 'issue-1', kind: 'metering', status, description: '实际使用时间与平台记录不符', descriptionDigest: 'digest',
  openedAt: '2026-08-14T10:00:00.000Z', outcome, reason: status === 'resolved' ? '已核对节点计量记录' : null,
  reasonDigest: status === 'resolved' ? 'reason-digest' : null, decidedAt: status === 'resolved' ? '2026-08-14T11:00:00.000Z' : null,
  settlement: null,
});

test('open issue copy keeps buyer and provider credits frozen', () => {
  assert.match(fulfillmentIssuePresentation(issue('open'), 'buyer').description, /保持冻结/u);
  assert.match(fulfillmentIssuePresentation(issue('open'), 'provider').description, /保持冻结/u);
});

test('three outcomes have distinct and non-misleading result copy', () => {
  assert.equal(fulfillmentIssuePresentation(issue('resolved', 'full_refund'), 'buyer').label, '全额退回');
  assert.equal(fulfillmentIssuePresentation(issue('resolved', 'partial_refund'), 'buyer').label, '部分补偿');
  assert.equal(fulfillmentIssuePresentation(issue('resolved', 'reject_refund'), 'buyer').label, '按实耗结算');
});

test('issue kind labels distinguish access from metering', () => {
  assert.equal(issueKindLabel('access'), '连接无法使用');
  assert.equal(issueKindLabel('metering'), '计量结果有异议');
});
