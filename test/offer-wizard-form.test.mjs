import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commonDeliveryTerms,
  draftPriceEvidence,
  formatCnyForEditing,
  normalizeCnyInput,
  shouldClearFormErrorOnEdit,
  validateOfferWizardStep,
} from '../src/offer-wizard-form.ts';

const complete = {
  title: 'L40S 48G 整卡独享', minimumQuantity: '1',
  availability: '99.9%', delivery: '平台工作区交付', acceptance: '按验真配置验收',
  refund: '按中断分钟退还卡时', cleanup: '结束后清理数据', suggestedPriceCny: '36.00',
  priceComponents: '包含设备、电力、网络和运维', evidenceSource: '近期成交合同',
  evidenceSummary: '同地区同型号同期成交记录',
};

test('人民币核价输入只保留一个小数点和两位小数', () => {
  assert.equal(normalizeCnyInput('36.00'), '36.00');
  assert.equal(normalizeCnyInput('36..0099元'), '36.00');
  assert.equal(normalizeCnyInput('.5'), '0.5');
  assert.equal(normalizeCnyInput('12345678901'), '123456789');
});

test('服务端人民币精度转换成易读的两位编辑格式', () => {
  assert.equal(formatCnyForEditing('31.200000'), '31.20');
  assert.equal(formatCnyForEditing('31'), '31.00');
  assert.equal(formatCnyForEditing('31.2'), '31.20');
  assert.equal(formatCnyForEditing('31.234000'), '31.23');
  assert.equal(formatCnyForEditing(''), '');
});

test('每一步都在进入下一步前检查必填内容', () => {
  assert.equal(validateOfferWizardStep('service', { ...complete, title: '' }), '请填写服务名称与最小起售量。');
  assert.equal(validateOfferWizardStep('terms', { ...complete, refund: '' }), '请完整定义保障、交付、验收、退款和数据清理边界。');
  assert.equal(validateOfferWizardStep('price', { ...complete, suggestedPriceCny: '36.001' }), '请填写人民币依据、价格构成和一条可核验凭证。');
  assert.equal(validateOfferWizardStep('price', complete), null);
});

test('补填内容会移除本地校验提示，但不会掩盖保存失败或版本冲突', () => {
  assert.equal(shouldClearFormErrorOnEdit('idle'), true);
  assert.equal(shouldClearFormErrorOnEdit('saving'), true);
  assert.equal(shouldClearFormErrorOnEdit('saved'), true);
  assert.equal(shouldClearFormErrorOnEdit('error'), false);
  assert.equal(shouldClearFormErrorOnEdit('conflict'), false);
});

test('核价凭证未写完也会进入草稿，恢复后可继续填写', () => {
  assert.deepEqual(draftPriceEvidence('contract', '近期 H100 合同', ''), [{
    type: 'contract', source: '近期 H100 合同', summary: '',
  }]);
  assert.deepEqual(draftPriceEvidence('invoice', '', '', { type: 'contract', source: '', summary: '', digest: `sha256:${'a'.repeat(64)}` }), [{
    type: 'invoice', source: '', summary: '', digest: `sha256:${'a'.repeat(64)}`,
  }]);
});

test('常用条款模板带入当前已验真资源且覆盖五类交付边界', () => {
  const terms = commonDeliveryTerms('L40S 48G');
  assert.match(terms.acceptance, /L40S 48G/u);
  assert.match(terms.availability, /开通未完成不计费/u);
  assert.match(terms.delivery, /5 分钟/u);
  assert.match(terms.refund, /开通失败全额退回/u);
  assert.match(terms.cleanup, /48 小时/u);
  assert.deepEqual(Object.keys(terms).sort(), ['acceptance', 'availability', 'cleanup', 'delivery', 'refund']);
  assert.ok(Object.values(terms).every((value) => value.length >= 10));
});
