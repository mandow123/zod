import assert from 'node:assert/strict';

const origin = process.env.ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:4156';
const e2eSession = 'acceptance_contract_session_000000000000000000000000';

async function read(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, init);
  const body = await response.json();
  assert.equal(response.status, 200, `${pathname} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const health = await read('/mobile/v1/health');
assert.equal(health.ok, true);

const readiness = await read('/mobile/v1/readiness');
assert.equal(readiness.ok, true);
assert.equal(readiness.database.connected, true);
assert.equal(readiness.deployment.ready, true);

const resources = await read('/mobile/v1/market/resources?limit=50');
assert.deepEqual(resources.resources, []);
assert.equal(resources.nextCursor, null);

const listings = await read('/mobile/v1/market/listings?limit=50');
assert.deepEqual(listings.listings, []);

const devices = await read('/mobile/v1/device-products');
assert.equal(devices.ok, true);
assert.equal(devices.products.length, 1);
const spark = devices.products[0];
assert.equal(spark.title, 'NVIDIA DGX Spark');
assert.equal(spark.campaignKey, 'nvidia-dgx-spark-200-baige-20off');
assert.equal(spark.inventory.total, 200);
assert.equal(spark.pricing.discountPercent, 20);
assert.equal(spark.purchasable, false);
assert.deepEqual(spark.localAcceptance, {
  mode: 'local_e2e', inventoryCommitment: false, orderCreation: false,
});

const demo = await read('/__e2e/demo-catalog', {
  headers: { 'x-kai-e2e-session': e2eSession },
});
assert.equal(demo.mode, 'local_e2e');
assert.equal(demo.count, 100);
assert.equal(demo.listings.length, 100);
assert.equal(demo.listings[0].campaignKey, 'nvidia-dgx-spark-200-baige-20off');
assert.equal(demo.listings[0].demo.purchasable, false);

const candidates = [];
let cursor = null;
do {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const page = await read(`/mobile/v1/inquiry-catalog?${query}`);
  candidates.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);

assert.equal(candidates.length, 120);
assert.deepEqual(
  Object.fromEntries(['H100', 'H200', 'B300'].map((model) => [model, candidates.filter((item) => item.model === model).length])),
  { H100: 100, H200: 16, B300: 4 },
);
for (const candidate of candidates) {
  assert.equal(candidate.status, 'inquiry_required');
  assert.equal(candidate.lastVerifiedAt, null);
  assert.equal(candidate.verification.status, 'awaiting_supplier_confirmation');
  const serialized = JSON.stringify(candidate).toLowerCase();
  for (const forbidden of ['price', 'currency', 'inventory', 'stock', 'purchasable', 'buy']) {
    assert.equal(serialized.includes(forbidden), false, `candidate ${candidate.candidateId} exposed ${forbidden}`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  origin,
  market: { resources: resources.resources.length, listings: listings.listings.length },
  localDemoListings: demo.count,
  deviceProducts: devices.products.length,
  inquiryCandidates: candidates.length,
  inquiryByModel: { H100: 100, H200: 16, B300: 4 },
})}\n`);
