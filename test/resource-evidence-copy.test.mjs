import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceCollectingCopy, resourceEvidenceCopy } from '../src/resource-evidence-copy.ts';
import { readFile } from 'node:fs/promises';

test('submitted evidence reads as review progress and no longer prompts for file formats', () => {
  assert.deepEqual(resourceEvidenceCopy('under_review', null, false, 3), {
    headerTitle: '审核进度', reviewTitle: '平台审核中', reviewText: '审核结果会通过消息通知。', showFormatNote: false,
  });
});

test('collecting evidence keeps the upload guidance', () => {
  assert.deepEqual(resourceEvidenceCopy('collecting', null, true, 3), {
    headerTitle: '准备审核材料', reviewTitle: '材料已齐，可以提交', reviewText: '文件通过安全检查后，才能提交平台审核。', showFormatNote: true,
  });
});

test('passed evidence sends the provider to node enrollment before an offer', () => {
  assert.deepEqual(resourceEvidenceCopy('passed', null, false, 3), {
    headerTitle: '资料核验结果', reviewTitle: '资料已核验',
    reviewText: '资料已通过。下一步请在“我的资产”接入执行节点，节点可交付后再填写上架方案。',
    showFormatNote: false,
  });
});

test('passed evidence closes onto My Assets with an explicit node next step', async () => {
  const source = await readFile(new URL('../src/ResourceEvidenceSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /review === 'passed' \? '查看节点接入' : '完成'/u);
});

test('a resumed correction keeps the concrete review instruction on the resource card', () => {
  assert.deepEqual(resourceCollectingCopy(' 配置截图缺少设备序列号，请更换配置材料后重新提交。 '), {
    summary: '配置截图缺少设备序列号，请更换配置材料后重新提交。', action: '继续补充材料',
  });
  assert.deepEqual(resourceCollectingCopy(null), {
    summary: '准备三类材料后提交平台审核。', action: '准备审核材料',
  });
});
