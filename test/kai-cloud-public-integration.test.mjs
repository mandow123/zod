import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('mobile KAI Cloud verification remains a backend-mediated, fail-closed flow', async () => {
  const [client, sheet, screen] = await Promise.all([
    read('../src/kai-cloud-verification.ts'),
    read('../src/KaiCloudVerificationSheet.tsx'),
    read('../src/screens/ProviderResourcesScreen.tsx'),
  ]);

  assert.match(client, /\/mobile\/v1\/provider\/assets\/\$\{encodeURIComponent\(assetId\)\}\/kai-cloud-verification/u);
  assert.doesNotMatch(client, /KAI_CLOUD_PUBLIC_CLIENT_SECRET|Cookie|\/api\/public\/v1/u);
  assert.match(client, /await SecureStore\.setItemAsync/u);
  assert.match(client, /缓存结果不会被当作当前已验证/u);
  assert.match(client, /!value\.available \|\| value\.syncState === 'unavailable'/u);
  assert.match(sheet, /loadKaiCloudVerification/u);
  assert.match(sheet, /startKaiCloudVerification/u);
  assert.match(sheet, /revokeKaiCloudVerification/u);
  assert.match(screen, /<KaiCloudVerificationSheet/u);
  assert.match(screen, /onKaiCloudAction/u);
});

test('derived public contract requires OAuth scopes, signed events, idempotency, and device sequence', async () => {
  const [contract, mapping] = await Promise.all([
    read('../docs/contracts/kai-cloud-public-v1.openapi.yaml'),
    read('../docs/KAI_CLOUD_PUBLIC_API_INTEGRATION.md'),
  ]);

  for (const value of ['resource:read', 'verification:write', 'agent:write', 'Idempotency-Key',
    'x-kai-delivery-id', 'x-kai-timestamp', 'x-kai-signature', 'sequence']) {
    assert.match(contract, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  const specification = parse(contract);
  assert.equal(specification.openapi, '3.1.0');
  const normalizedContract = contract.replace(/\r\n?/gu, '\n');
  const bytes = Buffer.from(normalizedContract);
  assert.equal(createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'),
    '70b0bc523d92706a16f5633510c68371e005f51e');
  assert.ok(specification.paths['/api/public/v1/oauth/token']);
  assert.deepEqual(specification.paths['/api/public/v1/oauth/token'].post.security, []);
  assert.equal(specification.components.securitySchemes.oauthClient.flows.clientCredentials.tokenUrl,
    'https://sandbox-auth.cloud.kai.com/api/public/v1/oauth/token');
  assert.ok(specification.components.securitySchemes.oauthClient.flows.clientCredentials.scopes['resource:read']);
  assert.ok(specification.components.securitySchemes.oauthClient.flows.clientCredentials.scopes['verification:write']);
  assert.ok(specification.paths['/api/public/v1/agent-challenges']);
  assert.ok(specification.paths['/api/public/v1/devices/register']);
  assert.ok(specification.paths['/api/public/v1/devices/{deviceId}/heartbeats']);
  assert.equal(specification.webhooks.resourceVerificationUpdated.post.requestBody.content
    ['application/json'].schema.properties.version.const, 1);
  assert.deepEqual(specification.paths['/api/public/v1/resource-verifications'].post.security,
    [{ oauthClient: ['resource:read', 'verification:write'] }]);
  assert.deepEqual(specification.paths['/api/public/v1/agent-challenges'].post.security,
    [{ oauthClient: ['agent:write'] }]);
  assert.deepEqual(specification.paths['/api/public/v1/devices/register'].post.security, []);
  assert.equal(specification.paths['/api/public/v1/devices/register'].post.operationId, 'registerSignedDevice');
  assert.equal(specification.paths['/api/public/v1/devices/{deviceId}/heartbeats'].post.operationId,
    'recordSignedDeviceHeartbeat');
  assert.deepEqual(specification.paths['/api/public/v1/devices/{deviceId}/heartbeats'].post.security, []);
  assert.ok(specification.components.schemas.Heartbeat.required.includes('sequence'));
  assert.deepEqual(specification.webhooks.resourceVerificationUpdated.post.security, []);
  assert.deepEqual(specification.webhooks.resourceVerificationUpdated.post.parameters.map((parameter) => parameter.name),
    ['x-kai-delivery-id', 'x-kai-timestamp', 'x-kai-signature']);
  assert.match(mapping, /App[^\n]*backend[^\n]*KAI Cloud/u);
  assert.match(mapping, /client secret.*只由服务端/iu);
  assert.match(mapping, /c30f38cadc7f9030c8fb59fbf91c6182d9d4cb9c/u);
  assert.match(mapping, /70b0bc523d92706a16f5633510c68371e005f51e/u);
  assert.match(mapping, /fail-closed/u);
  assert.doesNotMatch(mapping, /HttpOnly Cookie.*复用/u);
});
