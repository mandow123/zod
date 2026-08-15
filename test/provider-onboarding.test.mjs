import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerResourceFormReady, resourceStatusOpensEvidence, supplierOnboardingFormReady,
} from '../src/provider-onboarding.ts';

test('入驻资料完整前不能提交', () => {
  assert.equal(supplierOnboardingFormReady({ legalName: '', creditCode: '', contactName: '' }), false);
  assert.equal(supplierOnboardingFormReady({ legalName: '凯云算力', creditCode: '91310000KAI000001', contactName: '凯' }), false);
  assert.equal(supplierOnboardingFormReady({ legalName: '凯云算力', creditCode: '91310000KAI0000001', contactName: '' }), false);
});

test('完整主体名称、18 位信用代码和联系人允许提交', () => {
  assert.equal(supplierOnboardingFormReady({
    legalName: ' 凯云算力有限公司 ', creditCode: '91310000kai0000001', contactName: ' 凯 ',
  }), true);
});

test('首次资源资料完整前不能保存', () => {
  const valid = { assetReference: 'SN-H100-001', productCode: 'H100', region: '上海', capacityTotal: '8', capacityUnit: 'GPU时' };
  assert.equal(providerResourceFormReady({ ...valid, assetReference: '' }), false);
  assert.equal(providerResourceFormReady({ ...valid, capacityTotal: '0' }), false);
  assert.equal(providerResourceFormReady({ ...valid, capacityTotal: 'not-a-number' }), false);
  assert.equal(providerResourceFormReady(valid), true);
});

test('新增、待补件和被退回资源直接进入材料页', () => {
  for (const status of ['draft', 'pending_verification', 'rejected']) {
    assert.equal(resourceStatusOpensEvidence(status), true);
  }
  for (const status of ['verified', 'suspended', 'retired']) {
    assert.equal(resourceStatusOpensEvidence(status), false);
  }
});
