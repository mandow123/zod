import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  decodeSupplierInquiryCatalog, decodeSupplierInquiryResource, HONGHUAN_MONTHLY_TIER_ID, supplierCatalogCardCount,
  supplierCatalogInquiryCandidate, supplierCatalogReferenceCredit, supplierInquiryCatalogCounts,
} from '../src/honghuan-inquiry-catalog.ts';
import { FORMAL_MARKET_FRESH_SECTION } from '../src/market-entry.ts';

const canonical = [
  ['gpu-honghuan-a100-sxm4-80gb-1', 'A100', 'SXM4', 80, 1, '28.44', '682.63'],
  ['gpu-honghuan-a100-sxm4-80gb-2', 'A100', 'SXM4', 80, 2, '53.89', '1293.41'],
  ['gpu-honghuan-h100-sxm-80gb-1', 'H100', 'SXM', 80, 1, '89.82', '2155.69'],
  ['gpu-honghuan-h100-sxm-80gb-2', 'H100', 'SXM', 80, 2, '163.17', '3916.17'],
  ['gpu-honghuan-h200-nvl-1', 'H200', 'NVL', 140, 1, '88.32', '2119.76'],
  ['gpu-honghuan-h200-nvl-2', 'H200', 'NVL', 140, 2, '137.72', '3305.39'],
  ['gpu-honghuan-b200-179gb-1', 'B200', null, 179, 1, '143.71', '3449.10'],
  ['gpu-honghuan-b200-179gb-2', 'B200', null, 179, 2, '278.44', '6682.63'],
  ['gpu-honghuan-b200-179gb-4', 'B200', null, 179, 4, '547.90', '13149.70'],
  ['gpu-honghuan-b300-269gb-1', 'B300', null, 269, 1, '305.39', '7329.34'],
];

function item(index, contract = false) {
  const entry = contract ? [HONGHUAN_MONTHLY_TIER_ID, 'B300', null, null, null, null, null] : canonical[index];
  const [resourceId, model, formFactor, advertisedMemoryGb, countPerInstance, hourlyAmount, dailyAmount] = entry;
  return {
    resourceId,
    version: 1, catalogKind: contract ? 'contract_monthly' : 'hourly_gpu',
    title: contract ? 'B300 整机长期租赁 · 32台起' : `${model} 按时算力`, legalReviewRequired: contract,
    supplier: {
      id: 'supplier-shanghai-honghuan', legalName: '上海鸿欢网络科技有限公司', displayName: '上海鸿欢',
      logo: { httpsUrl: 'https://assets.kai.com/suppliers/shanghai-honghuan.jpg', version: 'v1', authorizationStatus: 'unverified', provenance: 'user_provided' },
      disclosureStatus: 'platform_imported_unverified',
    },
    specifications: {
      gpu: { model, formFactor, advertisedMemoryGb, environmentObservedMemoryGb: null, countPerInstance },
      cpu: { description: null }, memory: { description: null }, storage: { description: null },
      software: { cudaVersion: null, pythonVersion: null, pytorchStatus: 'unknown' }, notes: [],
    },
    quantity: contract
      ? { unit: 'server', min: 32, max: 128, allowedValues: [32, 64, 128] }
      : { unit: 'instance', min: 1, max: 100000, allowedValues: null },
    region: { scope: 'national', exact: null, confirmationRequired: true },
    billing: {
      modes: [contract ? 'monthly' : 'hourly'], unit: contract ? 'SERVER_MONTH' : 'GPU_HOUR',
      referencePrice: { currency: 'KAI_CARD_HOUR', precision: 2, status: 'reference_only',
        hourlyAmount, dailyAmount,
        monthlyAmount: contract ? '411676.65' : null, validUntil: '2026-09-19T03:59:59.000Z' },
    },
    availability: { status: 'inquiry_required', quantity: null, inventoryCommitment: false },
    delivery: { mode: 'manual', leadTime: contract
      ? { status: 'supplier_declared', value: 4, unit: 'month' }
      : { status: 'inquiry_confirmation_required', value: null, unit: null } },
    purchase: { purchasable: false, orderCreation: false, inquiryAvailable: true, cta: 'submit_inquiry' },
    source: { observedAt: '2026-08-19', kind: 'USER_PROVIDED_SUPPLIER_QUOTE',
      label: '资料来源：用户提供的供应商报价', verificationStatus: 'unverified' },
    terms: 'inquiry-required',
  };
}

function completeCatalog() {
  return { ok: true, items: [...Array.from({ length: 10 }, (_, index) => item(index)), item(10, true)], nextCursor: null };
}

test('正式供应商目录只接受完整十一项、两位小数参考卡时和合同档位', () => {
  const decoded = decodeSupplierInquiryCatalog(completeCatalog(), true);
  assert.equal(decoded.items.length, 11);
  assert.deepEqual(decoded.items.slice(0, 10).map((entry) => [entry.resourceId, entry.specifications.gpu.model,
    entry.specifications.gpu.formFactor, entry.specifications.gpu.advertisedMemoryGb,
    entry.specifications.gpu.countPerInstance, entry.billing.referencePrice.hourlyAmount,
    entry.billing.referencePrice.dailyAmount]), canonical);
  const monthly = decoded.items.find((entry) => entry.resourceId === HONGHUAN_MONTHLY_TIER_ID);
  assert.ok(monthly);
  assert.equal(supplierCatalogReferenceCredit(monthly), '411676.65 KAI 卡时');
  assert.equal(supplierCatalogCardCount(monthly), '总 GPU 数待确认');
  assert.deepEqual(monthly.quantity.allowedValues, [32, 64, 128]);
});

test('目录适配器保留正式资源版本且不把导入资料标成已认领', () => {
  const monthly = decodeSupplierInquiryCatalog(completeCatalog(), true).items.at(-1);
  assert.ok(monthly);
  const candidate = supplierCatalogInquiryCandidate(monthly);
  assert.equal(candidate.source, 'shanghai_honghuan');
  assert.equal(candidate.candidateId, HONGHUAN_MONTHLY_TIER_ID);
  assert.equal(candidate.catalog?.version, 1);
  assert.equal(candidate.catalog?.quantity.unit, 'server');
  assert.equal(candidate.supplier.claimed, false);
});

test('目录拒绝授权夸大、购买能力、价格精度和不完整响应', () => {
  const disclosure = completeCatalog();
  disclosure.items[0].supplier.disclosureStatus = 'supplier_provided';
  assert.throws(() => decodeSupplierInquiryCatalog(disclosure, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const purchasable = completeCatalog();
  purchasable.items[0].purchase.purchasable = true;
  assert.throws(() => decodeSupplierInquiryCatalog(purchasable, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const precision = completeCatalog();
  precision.items[0].billing.referencePrice.hourlyAmount = '28.4';
  assert.throws(() => decodeSupplierInquiryCatalog(precision, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const wrongId = completeCatalog();
  wrongId.items[0].resourceId = 'gpu-honghuan-a100-sxm4-80gb-unknown';
  assert.throws(() => decodeSupplierInquiryCatalog(wrongId, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const wrongPrice = completeCatalog();
  wrongPrice.items[0].billing.referencePrice.hourlyAmount = '28.45';
  assert.throws(() => decodeSupplierInquiryCatalog(wrongPrice, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const wrongDailyPrice = completeCatalog();
  wrongDailyPrice.items[0].billing.referencePrice.dailyAmount = '682.64';
  assert.throws(() => decodeSupplierInquiryCatalog(wrongDailyPrice, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const wrongSpecification = completeCatalog();
  wrongSpecification.items[0].specifications.gpu.countPerInstance = 2;
  assert.throws(() => decodeSupplierInquiryCatalog(wrongSpecification, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const incomplete = completeCatalog();
  incomplete.items.pop();
  assert.throws(() => decodeSupplierInquiryCatalog(incomplete, true), /SUPPLIER_INQUIRY_CATALOG_INCOMPLETE/u);
});

test('目录所有层级拒绝额外财务、库存和授权证据字段', () => {
  const extraTop = completeCatalog();
  extraTop.items[0].cnyAmount = '19.00';
  assert.throws(() => decodeSupplierInquiryCatalog(extraTop, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const extraStock = completeCatalog();
  extraStock.items[0].availability.stock = 10;
  assert.throws(() => decodeSupplierInquiryCatalog(extraStock, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const extraAuthorization = completeCatalog();
  extraAuthorization.items[0].supplier.logo.authorizationEvidence = 'unverified-upload';
  assert.throws(() => decodeSupplierInquiryCatalog(extraAuthorization, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);

  const extraEnvelope = completeCatalog();
  extraEnvelope.cnyAmount = '19.00';
  assert.throws(() => decodeSupplierInquiryCatalog(extraEnvelope, true), /SUPPLIER_INQUIRY_CATALOG_INVALID/u);
});

test('详情响应必须与请求的正式资源ID完全一致', () => {
  const response = { ok: true, item: item(1) };
  assert.equal(decodeSupplierInquiryResource(response, canonical[1][0]).resourceId, canonical[1][0]);
  assert.throws(() => decodeSupplierInquiryResource(response, canonical[0][0]), /SUPPLIER_INQUIRY_CATALOG_RESOURCE_MISMATCH/u);
});

test('Market两组筛选和formal询期请求保持物理分流', async () => {
  const [market, inquiries, composer] = await Promise.all([
    readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/resource-inquiries.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/InquiryComposerSheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(market, /supplierCatalogKind === 'hourly_gpu' \? inquiryCandidates\.map/u);
  assert.match(market, /!inquiryModel \|\| item\.specifications\.gpu\.model === inquiryModel/u);
  assert.match(market, /'A100', 'H100', 'H200', 'B200', 'B300'/u);
  assert.match(market, /报价资料导入 · 未经 KAI 验真/u);
  assert.doesNotMatch(market.slice(market.indexOf('function SupplierInquiryRow'), market.indexOf('function DeviceProductRow')), /已认证|已核验|现货|立即购买/u);
  assert.match(inquiries, /supplierResourceId: string; supplierResourceVersion: number; quantity: number/u);
  assert.match(inquiries, /body: resourceInquiryRequestBody\(input\)/u);
  assert.match(composer, /candidate\.source === 'shanghai_honghuan'/u);
  assert.match(composer, /reason\.code === 'CATALOG_VERSION_CONFLICT'/u);
  assert.match(composer, /\? \{ \.\.\.common, source: 'shanghai_honghuan', supplierResourceId:[\s\S]*?: \{ \.\.\.common, source: 'general_inquiry', candidateId:/u);
});

test('formal fresh Market 默认直达 100 家供应商且上海鸿欢计数不混入旧候选', async () => {
  assert.equal(FORMAL_MARKET_FRESH_SECTION, '算力租用');
  const catalog = decodeSupplierInquiryCatalog(completeCatalog(), true);
  assert.deepEqual(supplierInquiryCatalogCounts(catalog.items), { total: 11, hourly: 10, monthly: 1 });
  const market = await readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8');
  assert.match(market, /useState<MarketSection>\(FORMAL_MARKET_FRESH_SECTION\)/u);
  assert.match(market, /上海鸿欢 \$\{supplierCatalogCounts\.total\} 项/u);
  assert.doesNotMatch(market, /supplierCatalogFiltered\.length \+ .*inquiryCandidates\.length/u);
  assert.match(market, /setSupplierCatalogError\('供应商目录暂时无法读取，请稍后重试。'\)/u);
  assert.match(market, /仅渲染服务端返回的完整 11 项，不在本地补造资源/u);
  assert.match(market, /supplierRentalMarket \? supplierDirectoryState === 'available' \? `\$\{supplierDirectoryItems\.length\} 家`/u);
  assert.match(market, /已收录 100 家 · 全部需询价确认/u);
});
