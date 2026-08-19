import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCommercePolicy, guardCommerceRequest } from '../src/commerce-policy.ts';

test('ios/app-store commerce mutations fail before apiRequest can be called', () => {
  const iosPolicy = createCommercePolicy({
    buildPlatform: 'ios',
    distributionChannel: 'app-store',
    nativeTopupsEnabled: true,
    newOrdersEnabled: true,
  });
  let apiRequestCalls = 0;
  const apiRequest = () => { apiRequestCalls += 1; };

  assert.throws(
    () => guardCommerceRequest(iosPolicy, 'newOrders', apiRequest),
    /此版本不提供新增购买/u,
  );
  assert.throws(
    () => guardCommerceRequest(iosPolicy, 'nativeTopups', apiRequest),
    /此版本不提供充值/u,
  );
  assert.equal(apiRequestCalls, 0);
});

test('android/direct-cn commerce policy preserves enabled request behavior', () => {
  const androidPolicy = createCommercePolicy({
    buildPlatform: 'android',
    distributionChannel: 'direct-cn',
    nativeTopupsEnabled: true,
    newOrdersEnabled: true,
  });
  let apiRequestCalls = 0;
  const result = guardCommerceRequest(androidPolicy, 'newOrders', () => {
    apiRequestCalls += 1;
    return 'sent';
  });
  assert.equal(result, 'sent');
  assert.equal(apiRequestCalls, 1);
});

test('every buyer mutation entry point enforces the distribution request guard', async () => {
  const [api, device, vast, publishing] = await Promise.all([
    readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/device-commerce.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/vast-commerce.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/publishing.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /createCloudPayOrder[\s\S]*?guardNewOrderRequest\(async \(\) =>[\s\S]*?apiRequest/u);
  assert.match(api, /createCreditTopup[\s\S]*?guardNativeTopupRequest\(async \(\) =>[\s\S]*?apiRequest/u);
  assert.match(device, /createDeviceOrder[\s\S]*?guardNewOrderRequest\(async \(\) =>[\s\S]*?apiRequest/u);
  assert.match(vast, /createVastQuote[\s\S]*?guardNewOrderRequest\(async \(\) =>[\s\S]*?apiRequest/u);
  assert.match(vast, /createVastOrder[\s\S]*?guardNewOrderRequest\(async \(\) =>[\s\S]*?apiRequest/u);
  assert.match(publishing, /createDemand[\s\S]*?guardNewOrderRequest\(async \(\) =>[\s\S]*?apiRequest/u);
});

test('iOS-facing screens hide topup, demand, Vast purchase, and external purchase CTAs', async () => {
  const [app, credit, home, market] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/CreditScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/HomeScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /topupsEnabled=\{distributionPolicy\.nativeTopups\}/u);
  assert.match(app, /newOrdersEnabled=\{distributionPolicy\.newOrders\}/u);
  assert.match(credit, /topupsEnabled \?/u);
  assert.match(home, /newOrdersEnabled/u);
  assert.match(market, /distributionPolicy\.newOrders[\s\S]*?VastPurchaseSheet/u);
  for (const source of [app, credit, home, market]) {
    assert.doesNotMatch(source, /去网页购买|去网页充值|前往网页购买|前往网页充值/u);
  }
});
