import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyVerifiedResumeFailure,
  classifyVerifiedStageFailure,
  persistRotatedVerifiedIdentity,
  parsePreservingStoredValue,
  retireVerifiedIdentityWithFallback,
  runVerifiedBootstrap,
  sameAuthLegalDocuments,
} from '../src/kai-auth-flow-policy.ts';

test('verified resume retains only retryable network and gateway failures', () => {
  for (const apiStatus of [0, 502, 503, 504]) {
    assert.equal(classifyVerifiedResumeFailure({ apiStatus, definitiveInvalid: false }), 'retain_pending');
  }
  assert.equal(classifyVerifiedResumeFailure({ apiStatus: 401, definitiveInvalid: false }), 'require_reauthentication');
  assert.equal(classifyVerifiedResumeFailure({ definitiveInvalid: true }), 'require_reauthentication');
  assert.equal(classifyVerifiedResumeFailure({ apiStatus: 500, definitiveInvalid: false }), 'surface_error');
  assert.equal(classifyVerifiedResumeFailure({ apiStatus: 200, apiCode: 'RESPONSE_INVALID', definitiveInvalid: false }), 'retain_pending');
});

test('every non-identity platform failure keeps the verified-pending gate closed', () => {
  for (const input of [
    { apiStatus: 500 },
    { apiStatus: 403 },
    { apiStatus: 200, apiCode: 'RESPONSE_INVALID' },
    {},
  ]) {
    assert.equal(classifyVerifiedStageFailure({
      stage: 'platform', definitiveInvalid: false, ...input,
    }), 'retain_pending');
  }
  assert.equal(classifyVerifiedStageFailure({
    stage: 'platform', apiStatus: 401, definitiveInvalid: false,
  }), 'require_reauthentication');
});

test('a refreshed identity rejected by the paired API retires the new family', async () => {
  const retired = [];
  const result = await runVerifiedBootstrap({
    stored: { family: 'old' },
    refresh: async () => ({ family: 'new' }),
    bootstrap: async () => { throw new Error('paired 401'); },
    classify: () => 'require_reauthentication',
    retire: async (identity) => { retired.push(identity.family); },
  });
  assert.equal(result.kind, 'reauthenticate');
  assert.deepEqual(retired, ['new']);
});

test('rotated credentials are queued when encrypted persistence fails', async () => {
  let queued = 0;
  await assert.rejects(() => persistRotatedVerifiedIdentity({
    save: async () => { throw new Error('secure store unavailable'); },
    queueRevocation: async () => { queued += 1; },
  }), /已安排撤销/u);
  assert.equal(queued, 1);
});

test('a failed revocation queue retains verified identity instead of clearing it', async () => {
  let cleared = 0;
  await assert.rejects(() => retireVerifiedIdentityWithFallback({
    revoke: async () => { throw new Error('offline'); },
    queueRevocation: async () => { throw new Error('secure store unavailable'); },
    clear: async () => { cleared += 1; },
  }), /仍保留待处理状态/u);
  assert.equal(cleared, 0);
});

test('an unpersisted first token family is queued once when direct revocation fails', async () => {
  let queued = 0;
  let cleared = 0;
  await retireVerifiedIdentityWithFallback({
    revoke: async () => { throw new Error('offline'); },
    queueRevocation: async () => { queued += 1; },
    clear: async () => { cleared += 1; },
  });
  assert.equal(queued, 1);
  assert.equal(cleared, 1);
});

test('successful remote revoke clears verified identity exactly once', async () => {
  let cleared = 0;
  await retireVerifiedIdentityWithFallback({
    revoke: async () => undefined,
    queueRevocation: async () => { throw new Error('must not queue'); },
    clear: async () => { cleared += 1; },
  });
  assert.equal(cleared, 1);
});

test('legal consent is invalidated by either version or URL changes', () => {
  const current = {
    terms: { version: 'v1', url: 'https://cloudpay.kai.com/terms' },
    privacy: { version: 'v1', url: 'https://cloudpay.kai.com/privacy' },
  };
  assert.equal(sameAuthLegalDocuments(current, current), true);
  assert.equal(sameAuthLegalDocuments(current, { ...current, terms: { ...current.terms, version: 'v2' } }), false);
  assert.equal(sameAuthLegalDocuments(current, { ...current, privacy: { ...current.privacy, url: 'https://cloudpay.kai.com/privacy-v2' } }), false);
});

test('corrupt verified identity is rejected without a destructive cleanup callback', () => {
  let cleared = 0;
  assert.throws(() => parsePreservingStoredValue('{broken', () => true), /stored_value_integrity/u);
  assert.equal(cleared, 0);
});
