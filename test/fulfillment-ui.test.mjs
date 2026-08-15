import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptancePresentation, accessExpiryCopy, canEnterFulfillment, fulfillmentPresentation,
} from '../src/fulfillment-ui.ts';

const fulfillment = (status, connection = null) => ({
  id: 'fulfillment-1', status, connection, accessExpiresAt: null, lastError: null,
  acceptanceDueAt: null, acceptanceMode: null,
  leaseExpiresAt: '2026-08-14T18:00:00.000Z', startedAt: null, readyAt: null, runningAt: null, stoppedAt: null,
});

test('paid and provisioning orders never expose an entry action', () => {
  assert.equal(canEnterFulfillment(null, true, ['create_access_session']), false);
  assert.equal(canEnterFulfillment(fulfillment('pending'), true, ['create_access_session']), false);
  assert.equal(canEnterFulfillment(fulfillment('provisioning'), true, ['create_access_session']), false);
  assert.equal(canEnterFulfillment(fulfillment('ready'), true, ['create_access_session']), false);
});

test('only server-ready or running fulfillment with connection and action can be entered', () => {
  const connection = { protocol: 'https', host: 'provider.internal', port: 443, displayName: 'H100 工作区' };
  assert.equal(canEnterFulfillment(fulfillment('ready', connection), true, []), false);
  assert.equal(canEnterFulfillment(fulfillment('ready', connection), false, ['create_access_session']), false);
  assert.equal(canEnterFulfillment(fulfillment('ready', connection), true, ['create_access_session']), true);
  assert.equal(canEnterFulfillment(fulfillment('running', connection), true, ['create_access_session']), true);
  assert.equal(canEnterFulfillment(fulfillment('stopping', connection), true, ['create_access_session']), false);
  assert.equal(canEnterFulfillment(fulfillment('failed', connection), true, ['create_access_session']), false);
});

test('failed copy only promises a refund after the order is actually refunded', () => {
  assert.match(fulfillmentPresentation(fulfillment('failed'), 'refund_pending').title, /正在处理退款/u);
  assert.match(fulfillmentPresentation(fulfillment('failed'), 'refunded').title, /已退回/u);
});

test('reserved order describes frozen credits instead of claiming delivery or final payment', () => {
  const copy = fulfillmentPresentation(null, 'reserved');
  assert.match(copy.title, /卡时已冻结/u);
  assert.doesNotMatch(copy.title + copy.description, /已开通|算力可用/u);
});

test('every pre-settlement fulfillment state describes credits as frozen, never paid', () => {
  for (const state of [null, fulfillment('pending'), fulfillment('provisioning')]) {
    const copy = fulfillmentPresentation(state, state ? 'provisioning' : 'confirmed');
    assert.match(copy.title + copy.description, /冻结/u);
    assert.doesNotMatch(copy.title + copy.description, /已支付|已扣款/u);
  }
});

test('a stopped disputed fulfillment stays frozen and never prompts acceptance', () => {
  const copy = fulfillmentPresentation(fulfillment('stopped'), 'disputed');
  assert.equal(copy.label, '核对中');
  assert.match(copy.description, /卡时保持冻结/u);
});

test('connection expiry copy counts down from authoritative expiry', () => {
  const now = Date.parse('2026-08-14T10:00:00.000Z');
  assert.equal(accessExpiryCopy('2026-08-14T10:05:00.000Z', now), '访问凭据剩余 5:00');
  assert.equal(accessExpiryCopy('2026-08-14T09:59:59.000Z', now), '访问凭据已失效');
});

test('stopped fulfillment shows the authoritative 24-hour acceptance deadline', () => {
  const dueAt = '2026-08-15T10:00:00.000Z';
  const pending = acceptancePresentation({ ...fulfillment('stopped'), acceptanceDueAt: dueAt,
    acceptanceMode: 'pending' }, Date.parse('2026-08-14T12:00:00.000Z'));
  assert.equal(pending?.deadline, dueAt);
  assert.match(pending?.description ?? '', /确认用量/u);
  assert.match(pending?.description ?? '', /提交异议/u);
  assert.match(pending?.description ?? '', /24 小时验收期/u);
  assert.match(pending?.description ?? '', /系统会按平台计量/u);
});

test('an elapsed pending deadline says the system is processing without claiming completion', () => {
  const pending = acceptancePresentation({ ...fulfillment('stopped'),
    acceptanceDueAt: '2026-08-15T10:00:00.000Z', acceptanceMode: 'pending' },
  Date.parse('2026-08-15T10:00:01.000Z'));
  assert.equal(pending?.title, '验收时间已到');
  assert.match(pending?.description ?? '', /正在/u);
  assert.doesNotMatch(pending?.description ?? '', /已完成结算/u);
});

test('automatic acceptance is described as a system action, never a user confirmation', () => {
  const stopped = { ...fulfillment('stopped'), acceptanceDueAt: '2026-08-15T10:00:00.000Z',
    acceptanceMode: 'system' };
  const acceptance = acceptancePresentation(stopped);
  const summary = fulfillmentPresentation(stopped, 'accepted');
  assert.equal(acceptance?.title, '系统按计量完成');
  assert.equal(summary.title, '系统按计量完成');
  assert.doesNotMatch(`${acceptance?.title}${acceptance?.description}${summary.title}${summary.description}`, /你已确认|用户确认/u);
});
