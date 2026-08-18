import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMMON_TIME_ZONES, formatZonedDateTime, initialInquirySchedule, inquiryCardTypeLabel, validateInquiryInput,
} from '../src/inquiry-form.ts';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

const valid = {
  startsAt: '2026-08-20T09:00:00+08:00',
  endsAt: '2026-08-20T18:00:00+08:00',
  confirmBy: '2026-08-19T18:00:00+08:00',
  timeZone: 'Asia/Shanghai', gpuCount: 8,
  description: '用于模型训练，需要容器环境和稳定公网，平台可联系确认软件版本。',
  storageGiB: 1024, dataRegion: '中国大陆', maxCreditAmount: '1200.00',
};
const fixedNow = Date.parse('2026-08-18T12:00:00+08:00');

test('询期表单校验精确时段、IANA时区、正整数、说明与两位小数卡时', () => {
  assert.equal(validateInquiryInput(valid, fixedNow), null);
  assert.match(validateInquiryInput({ ...valid, timeZone: 'Shanghai' }, fixedNow), /IANA/u);
  assert.match(validateInquiryInput({ ...valid, startsAt: '2026-08-20 09:00' }, fixedNow), /包含时区/u);
  assert.match(validateInquiryInput({ ...valid, startsAt: '2026-08-18T11:00:00+08:00' }, fixedNow), /开始时间/u);
  assert.match(validateInquiryInput({ ...valid, endsAt: valid.startsAt }, fixedNow), /归还时间/u);
  assert.match(validateInquiryInput({ ...valid, confirmBy: valid.startsAt }, fixedNow), /最晚确认/u);
  assert.match(validateInquiryInput({ ...valid, confirmBy: '2026-08-17T18:00:00+08:00' }, fixedNow), /当前时间/u);
  assert.match(validateInquiryInput({ ...valid, gpuCount: 0 }, fixedNow), /1 至 100000/u);
  assert.match(validateInquiryInput({ ...valid, gpuCount: 100_001 }, fixedNow), /1 至 100000/u);
  assert.match(validateInquiryInput({ ...valid, storageGiB: 1.5 }, fixedNow), /1 至 10000000/u);
  assert.match(validateInquiryInput({ ...valid, storageGiB: 10_000_001 }, fixedNow), /1 至 10000000/u);
  assert.match(validateInquiryInput({ ...valid, description: '不足二十字' }, fixedNow), /20 至 500/u);
  assert.match(validateInquiryInput({ ...valid, description: '算'.repeat(501) }, fixedNow), /20 至 500/u);
  assert.match(validateInquiryInput({ ...valid, dataRegion: '中' }, fixedNow), /2 至 80/u);
  for (const amount of ['0.00', '1', '1.0', '1.001', '-1.00']) {
    assert.match(validateInquiryInput({ ...valid, maxCreditAmount: amount }, fixedNow), /两位小数/u);
  }
});

test('系统日期时间选择的默认时段、时区切换与 DST 偏移保持真实时刻', () => {
  const schedule = initialInquirySchedule(Date.parse('2026-08-18T04:12:00.000Z'));
  assert.equal(schedule.startsAt, '2026-08-19T04:00:00.000Z');
  assert.equal(Date.parse(schedule.endsAt) - Date.parse(schedule.startsAt), 8 * 60 * 60 * 1000);
  assert.ok(Date.parse(schedule.confirmBy) > Date.parse('2026-08-18T04:12:00.000Z'));
  assert.ok(COMMON_TIME_ZONES.some(([zone]) => zone === 'Asia/Shanghai'));
  assert.ok(COMMON_TIME_ZONES.some(([zone]) => zone === 'America/New_York'));
  assert.deepEqual(formatZonedDateTime('2026-01-15T12:00:00.000Z', 'America/New_York'), { date: '2026-01-15', time: '07:00' });
  assert.deepEqual(formatZonedDateTime('2026-07-15T12:00:00.000Z', 'America/New_York'), { date: '2026-07-15', time: '08:00' });
  assert.deepEqual(formatZonedDateTime('2026-08-19T05:00:00.000Z', 'Asia/Tokyo'), { date: '2026-08-19', time: '14:00' });
  assert.equal(new Date('2026-07-15T12:00:00.000Z').toISOString(), '2026-07-15T12:00:00.000Z');
});

test('卡型仅在原文明示 SXM 或 PCIe 时展示', () => {
  assert.equal(inquiryCardTypeLabel('H100 SXM'), 'H100 SXM');
  assert.equal(inquiryCardTypeLabel('H100 PCIe'), 'H100 PCIe');
  assert.equal(inquiryCardTypeLabel('H100'), '卡型待确认');
  assert.equal(inquiryCardTypeLabel('B300'), '卡型待确认');
});

test('公开目录走真实分页搜索且预约卡片不含销售误导或法币', async () => {
  const [market, api] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'), source('../src/resource-inquiries.ts'),
  ]);
  assert.match(market, /MarketSection = '算力租用' \| '设备采购' \| '预约算力'/u);
  assert.match(market, /loadInquiryCatalog\(\{ model: inquiryModel, region, query, limit: LISTING_PAGE_SIZE \}\)/u);
  assert.match(market, /cursor: inquiryCursor/u);
  assert.match(api, /\/mobile\/v1\/inquiry-catalog\?\$\{params\.toString\(\)\}/u);
  assert.match(api, /params\.set\('cursor', input\.cursor\)/u);
  assert.match(api, /limit: String\(input\.limit \?\? 20\)/u);
  const card = market.slice(market.indexOf('function InquiryCandidateRow'), market.indexOf('function MarketRow'));
  for (const required of ['待认领供应方', '按小时询期', '包月询期', '需询期', '资料日期', '资料待供应方确认', '询期后以卡时报价']) assert.match(card, new RegExp(required, 'u'));
  assert.doesNotMatch(card, /最近核验|核验日期/u);
  assert.match(api, /sourceObservedAt: string/u);
  assert.match(api, /lastVerifiedAt: string \| null/u);
  assert.match(card, /inquiryCardTypeLabel\(candidate\.cardType\)/u);
  assert.doesNotMatch(card, /现货|可购买|立即购买|已入驻|人民币|¥|￥|参考价/u);
});

test('提交只创建询期并以稳定幂等键重试，不生成订单或卡时冻结', async () => {
  const [composer, api] = await Promise.all([
    source('../src/InquiryComposerSheet.tsx'), source('../src/resource-inquiries.ts'),
  ]);
  assert.match(composer, /request\.current\?\.signature !== signature/u);
  assert.match(composer, /createResourceInquiry\(input, request\.current\.key\)/u);
  assert.match(composer, /询期已提交/u);
  assert.match(composer, /平台正在联系供应方/u);
  assert.match(composer, /不会生成订单，也不会冻结或扣除卡时/u);
  assert.match(composer, /documents\.inquiry\.version/u);
  assert.match(composer, /DateTimePickerAndroid\.open/u);
  assert.match(composer, /timeZoneName: timeZone/u);
  assert.match(composer, /COMMON_TIME_ZONES/u);
  assert.doesNotMatch(composer, /onChangeText=\{\(value\) => update\('(startsAt|endsAt|confirmBy|timeZone)'/u);
  assert.match(api, /'\/mobile\/v1\/resource-inquiries'/u);
  assert.doesNotMatch(`${composer}\n${api}`, /createCloudPayOrder|createDeviceOrder|reserveCredits|freezeCredits/u);
});

test('我的询期呈现服务端状态，操作严格由 allowedActions 控制', async () => {
  const [sheet, api] = await Promise.all([
    source('../src/MyInquiriesSheet.tsx'), source('../src/resource-inquiries.ts'),
  ]);
  for (const status of ['submitted', 'awaiting_supplier', 'clarification_required', 'supplier_declined', 'inquiry_expired', 'user_cancelled']) {
    assert.match(api, new RegExp(status, 'u'));
  }
  for (const status of ['capacity_confirmed', 'audit_pending']) assert.match(api, new RegExp(status, 'u'));
  assert.doesNotMatch(`${sheet}\n${api}`, /quoted|confirm_quote|freeze_credit/u);
  assert.match(sheet, /inquiry\.allowedActions\.includes\('provide_clarification'\)/u);
  assert.match(sheet, /inquiry\.allowedActions\.includes\('cancel'\)/u);
  assert.match(api, /\/clarifications/u);
  assert.match(api, /\/cancel/u);
  assert.match(api, /body: \{ message, expectedVersion \}/u);
  assert.match(api, /body: \{ expectedVersion \}/u);
  assert.match(sheet, /cursor \? <Pressable/u);
  assert.match(sheet, /dateTime\(item\.startsAt, item\.timeZone\)/u);
  assert.match(sheet, /dateTime\(item\.endsAt, item\.timeZone\)/u);
  assert.match(sheet, /dateTime\(inquiry\.confirmBy, inquiry\.timeZone\)/u);
  assert.doesNotMatch(sheet, /parsed\.getHours\(\)|parsed\.getMinutes\(\)/u);
});

test('普通市场与询期新增代码不引入人民币参考价', async () => {
  const sources = await Promise.all([
    source('../src/resource-inquiries.ts'), source('../src/InquiryComposerSheet.tsx'),
    source('../src/MyInquiriesSheet.tsx'), source('../src/inquiry-form.ts'),
  ]);
  for (const text of sources) assert.doesNotMatch(text, /人民币|¥|￥|参考价/u);
});
