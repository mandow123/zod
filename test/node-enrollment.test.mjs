import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildNodeClaimEnvelope, NodeClaimEnvelopeError, NODE_ENROLL_COMMAND, serializeNodeClaimEnvelope,
} from '../src/node-claim-envelope.ts';
import { allowsInsecureLocalE2EHost } from '../src/local-network-policy.local-e2e.ts';
import { validateNodeClaim } from '../h100-sidecar/src/node-client.mjs';

const NOW = Date.parse('2026-08-15T02:30:00.000Z');
const CLAIM = Object.freeze({
  protocolVersion: 1,
  deploymentId: '11111111-1111-4111-8111-111111111111',
  deploymentGeneration: 1,
  claimId: '22222222-2222-4222-8222-222222222222',
  claimGeneration: 1,
  claimToken: 'A'.repeat(43),
  challenge: 'B'.repeat(32),
  expectedPolicyDigest: `sha256:${'a'.repeat(64)}`,
  expiresAt: '2026-08-15T02:40:00.000Z',
  consumePath: '/node/v1/claims/22222222-2222-4222-8222-222222222222/consume',
  replayed: false,
});

test('builds the exact sidecar envelope without adding shell instructions', () => {
  const envelope = buildNodeClaimEnvelope(CLAIM, 'https://cloudpay.kai.com///', NOW);
  assert.deepEqual(envelope, {
    protocolVersion: 1,
    backendBaseUrl: 'https://cloudpay.kai.com',
    deploymentId: CLAIM.deploymentId,
    claimId: CLAIM.claimId,
    claimToken: CLAIM.claimToken,
    challenge: CLAIM.challenge,
    expectedPolicyDigest: CLAIM.expectedPolicyDigest,
    expiresAt: CLAIM.expiresAt,
    consumePath: CLAIM.consumePath,
  });
  assert.equal(JSON.parse(serializeNodeClaimEnvelope(envelope)).claimToken, CLAIM.claimToken);
  assert.deepEqual(validateNodeClaim(JSON.parse(serializeNodeClaimEnvelope(envelope))),
    { ...envelope, backendBaseUrl: 'https://cloudpay.kai.com/' });
  assert.equal(NODE_ENROLL_COMMAND, 'sudo kai-h100-sidecar-enroll');
});

test('rejects unsafe service addresses, expired claims, and mismatched consume paths', () => {
  for (const base of [
    'http://cloudpay.kai.com',
    'https://user:pass@cloudpay.kai.com',
    'https://cloudpay.kai.com?redirect=evil',
    'https://cloudpay.kai.com/#evil',
    'https://cloudpay.kai.com/api',
  ]) assert.throws(() => buildNodeClaimEnvelope(CLAIM, base, NOW), /HTTPS/u);

  assert.throws(() => buildNodeClaimEnvelope({ ...CLAIM, expiresAt: '2026-08-15T02:29:59.000Z' },
    'https://cloudpay.kai.com', NOW), (error) => error instanceof NodeClaimEnvelopeError && error.code === 'CLAIM_EXPIRED');
  assert.throws(() => buildNodeClaimEnvelope({ ...CLAIM, consumePath: '/node/v1/claims/wrong/consume' }, 'https://cloudpay.kai.com', NOW), /安全校验/u);
  assert.throws(() => buildNodeClaimEnvelope({ ...CLAIM, replayed: 'false' }, 'https://cloudpay.kai.com', NOW), /安全校验/u);
});

test('only the explicit local Android acceptance mode may use the emulator loopback bridge', () => {
  assert.throws(() => buildNodeClaimEnvelope(CLAIM, 'http://10.0.2.2:4100', NOW), /HTTPS/u);
  assert.equal(
    buildNodeClaimEnvelope(CLAIM, 'http://10.0.2.2:4100', NOW, true, allowsInsecureLocalE2EHost).backendBaseUrl,
    'http://10.0.2.2:4100',
  );
  for (const base of ['http://cloudpay.kai.com', 'http://192.168.1.20:4100', 'http://10.0.2.2:4100/api']) {
    assert.throws(() => buildNodeClaimEnvelope(CLAIM, base, NOW, true, allowsInsecureLocalE2EHost), /HTTPS/u);
  }
});

test('provider node enrollment uses one exact backend route and never persists the claim secret', async () => {
  const [client, sheet, screen] = await Promise.all([
    readFile(new URL('../src/provider-node-enrollment.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/NodeEnrollmentSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProviderResourcesScreen.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /\/mobile\/v1\/provider\/assets\/\$\{encodeURIComponent\(assetId\)\}\/node-claims/u);
  assert.match(client, /\/node-enrollments\/\$\{encodeURIComponent\(deploymentId\)\}/u);
  assert.match(client, /error instanceof NodeClaimEnvelopeError && error\.code === 'CLAIM_EXPIRED'/u);
  assert.match(client, /clearProviderNodeClaimRequest\(assetId\)[\s\S]+issueProviderNodeClaimAttempt\(assetId, false\)/u);
  assert.match(client, /buildNodeClaimEnvelope\(response\.claim, API_BASE_URL, Date\.now\(\), LOCAL_E2E_DEMO_ENABLED\)/u);
  assert.doesNotMatch(client, /SecureStore\.setItemAsync\([^,]+,\s*(?:response|claim|envelope|serialized)/u);
  assert.match(sheet, /AppState\.addEventListener\('change'/u);
  assert.match(sheet, /state !== 'active'\) void clearSensitiveState/u);
  assert.match(sheet, /ScreenCapture\.preventScreenCaptureAsync\(pendingScreenKey\)/u);
  assert.ok(sheet.indexOf('await ScreenCapture.preventScreenCaptureAsync') < sheet.indexOf('setIssued(result)'));
  assert.match(sheet, /Clipboard\.getStringAsync\(\) === secret/u);
  assert.match(sheet, /setTimeout\(\(\) => void clearClipboard\(\), 60_000\)/u);
  assert.match(screen, /<NodeEnrollmentSheet/u);
  assert.match(screen, /asset\.nodeAction\?\.key === 'issue_node_claim'/u);
});
