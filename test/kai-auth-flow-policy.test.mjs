import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAuthorizationExchangeFailure,
  classifyVerifiedResumeFailure,
  classifyVerifiedStageFailure,
  issuedKaiTokenRevocationCandidate,
  KaiOidcExchangeValidationError,
  platformPendingReason,
  persistRotatedVerifiedIdentity,
  parsePreservingStoredValue,
  retireVerifiedIdentityWithFallback,
  resolvePlatformUnauthorized,
  runVerifiedBootstrap,
  sameAuthLegalDocuments,
  shouldClearPendingAfterKaiAuthStartFailure,
  validateIssuedKaiOidcTokenSet,
} from '../src/kai-auth-flow-policy.ts';

test('start failure clears only its own pre-callback browser-open state', () => {
  const base = { callbackReceived: false, attemptId: 'attempt-a', currentAttemptId: 'attempt-a' };
  assert.equal(shouldClearPendingAfterKaiAuthStartFailure({ ...base, currentPhase: 'browser_open' }), true);
  assert.equal(shouldClearPendingAfterKaiAuthStartFailure({ ...base, callbackReceived: true,
    currentPhase: 'browser_open' }), false);
  assert.equal(shouldClearPendingAfterKaiAuthStartFailure({ ...base, currentPhase: 'authorization_received' }), false);
  assert.equal(shouldClearPendingAfterKaiAuthStartFailure({ ...base, currentPhase: 'exchanging' }), false);
  assert.equal(shouldClearPendingAfterKaiAuthStartFailure({ ...base, currentAttemptId: 'attempt-b',
    currentPhase: 'browser_open' }), false);
});

test('initial exchange revocation candidate uses only actually returned qualified tokens', () => {
  const accessToken = 'a'.repeat(20);
  const refreshToken = 'r'.repeat(20);
  assert.deepEqual(issuedKaiTokenRevocationCandidate({ accessToken, refreshToken }), { accessToken, refreshToken });
  assert.deepEqual(issuedKaiTokenRevocationCandidate({ accessToken, refreshToken: 'short' }), { accessToken });
  assert.deepEqual(issuedKaiTokenRevocationCandidate({ accessToken: 'short', refreshToken }), { refreshToken });
  assert.equal(issuedKaiTokenRevocationCandidate({ accessToken: 'short', refreshToken: null }), null);
});

test('nonce, scope and ID-token validation failures retain the actual issued family for revocation', () => {
  const response = {
    accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), idToken: 'i'.repeat(80),
    tokenType: 'Bearer', scope: 'openid profile email offline_access', expiresIn: 300,
    requiredScopes: ['openid', 'profile', 'email', 'offline_access'],
  };
  for (const invalid of [
    { ...response, validateIdToken: () => { throw new Error('nonce mismatch'); } },
    { ...response, idToken: 'malformed'.repeat(8), validateIdToken: () => { throw new Error('ID token format'); } },
    { ...response, scope: 'openid profile email', validateIdToken: () => ({ sub: 'subject' }) },
  ]) {
    assert.throws(() => validateIssuedKaiOidcTokenSet(invalid), (error) => {
      assert.equal(error instanceof KaiOidcExchangeValidationError, true);
      assert.deepEqual(error.revocationCandidate, {
        accessToken: response.accessToken, refreshToken: response.refreshToken,
      });
      return true;
    });
  }
});

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
  }), 'retain_pending');
});

test('platform failures produce stable user-visible pending reasons', () => {
  assert.equal(platformPendingReason({ apiStatus: 0 }), 'platform_network_unavailable');
  assert.equal(platformPendingReason({ apiStatus: 200, apiCode: 'RESPONSE_INVALID' }), 'platform_response_invalid');
  assert.equal(platformPendingReason({ apiStatus: 401 }), 'platform_not_accepted');
  assert.equal(platformPendingReason({ apiStatus: 403 }), 'platform_not_accepted');
  assert.equal(platformPendingReason({ apiStatus: 500 }), 'platform_server_error');
  assert.equal(platformPendingReason({}), 'platform_configuration_pending');
  assert.equal(platformPendingReason({ identityConfirmationUnavailable: true }), 'identity_confirmation_unavailable');
});

test('paired platform 401 retains a confirmed KAI identity instead of revoking it', async () => {
  let retired = 0;
  const result = await resolvePlatformUnauthorized({
    identity: { family: 'verified' },
    confirmIdentity: async () => undefined,
    definitiveInvalid: () => false,
    retire: async () => { retired += 1; },
  });
  assert.equal(result, 'retain_platform_not_accepted');
  assert.equal(retired, 0);
});

test('userinfo network failure retains identity while explicit invalidity retires once', async () => {
  let retired = 0;
  const network = await resolvePlatformUnauthorized({
    identity: { family: 'verified' },
    confirmIdentity: async () => { throw new Error('network'); },
    definitiveInvalid: () => false,
    retire: async () => { retired += 1; },
  });
  assert.equal(network, 'retain_identity_confirmation_unavailable');
  assert.equal(retired, 0);
  const invalid = await resolvePlatformUnauthorized({
    identity: { family: 'verified' },
    confirmIdentity: async () => { throw new Error('explicit unauthorized'); },
    definitiveInvalid: () => true,
    retire: async () => { retired += 1; },
  });
  assert.equal(invalid, 'reauthenticate');
  assert.equal(retired, 1);
});

test('only exchange network ambiguity inside the recovery window keeps encrypted authorization', () => {
  assert.equal(classifyAuthorizationExchangeFailure({
    retryableNetwork: true, definitiveInvalid: false, recoveryWindowValid: true,
  }), 'retain_encrypted_authorization');
  assert.equal(classifyAuthorizationExchangeFailure({
    retryableNetwork: true, definitiveInvalid: false, recoveryWindowValid: false,
  }), 'surface_error');
  assert.equal(classifyAuthorizationExchangeFailure({
    retryableNetwork: false, definitiveInvalid: true, recoveryWindowValid: true,
  }), 'restart_authorization');
  assert.equal(classifyAuthorizationExchangeFailure({
    retryableNetwork: false, definitiveInvalid: false, recoveryWindowValid: true,
  }), 'surface_error');
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
