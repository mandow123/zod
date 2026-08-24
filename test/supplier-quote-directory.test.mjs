import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  decodeSupplierQuoteDirectory, supplierQuoteForBilling, supplierQuoteReference,
} from '../src/supplier-quote-directory.ts';
import { verifySupplierLogoEvidence } from '../scripts/verify-supplier-logo-evidence.mjs';

async function snapshot() {
  return JSON.parse(await readFile(new URL('../src/data/supplier-quote-directory.snapshot.json', import.meta.url), 'utf8'));
}

test('100 家供应商快照完整、唯一且全部保持询价状态', async () => {
  const decoded = decodeSupplierQuoteDirectory(await snapshot(), 'bundled_reference_snapshot');
  assert.equal(decoded.items.length, 100);
  assert.equal(new Set(decoded.items.map((item) => item.supplierId)).size, 100);
  assert.equal(decoded.items[0].legalName, '阿里巴巴云计算有限公司');
  assert.equal(decoded.items[99].legalName, 'Exoscale');
  assert.ok(decoded.items.every((item) => !item.purchase.purchasable && !item.purchase.orderCreation
    && item.purchase.inquiryAvailable && item.availability.quantity === null && !item.availability.inventoryCommitment));
  assert.match(supplierQuoteReference(decoded.items[0]), /^\d+\.\d{2} KAI 卡时$/u);
  assert.match(supplierQuoteReference(decoded.items[0], 'monthly'), /^\d+\.\d{2} KAI 卡时$/u);
  assert.ok(decoded.items.every((item) => supplierQuoteForBilling(item, 'hourly')?.referencePrice.hourlyAmount));
  assert.ok(decoded.items.every((item) => supplierQuoteForBilling(item, 'monthly')?.referencePrice.monthlyAmount));
});

test('100 家供应商目录拒绝数量、购买能力和法币字段污染', async () => {
  const missing = await snapshot(); missing.items.pop();
  assert.throws(() => decodeSupplierQuoteDirectory(missing, 'live_api'), /SUPPLIER_QUOTE_DIRECTORY_INCOMPLETE/u);
  const purchasable = await snapshot(); purchasable.items[0].purchase.purchasable = true;
  assert.throws(() => decodeSupplierQuoteDirectory(purchasable, 'live_api'), /SUPPLIER_QUOTE_DIRECTORY_INVALID/u);
  const rawPrice = await snapshot(); rawPrice.items[0].quotes[0].referencePrice.sourceCurrency = 'CNY';
  // Extra source-price material is not accepted by the server contract tests and is never rendered by this adapter.
  assert.doesNotMatch(JSON.stringify(decodeSupplierQuoteDirectory(rawPrice, 'live_api')), /sourceCurrency|CNY/u);
});

test('市场默认供应商入口加载 100 家目录且使用分批渲染', async () => {
  const market = await readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8');
  assert.match(market, /useState<ComputeSource>\('供应商询价'\)/u);
  assert.match(market, /loadSupplierQuoteDirectory\(\)/u);
  assert.match(market, /supplierDirectoryFiltered\.slice\(0, visibleCount\)/u);
  assert.match(market, /已收录 100 家 · 全部需询价确认/u);
  assert.match(market, /发布定向需求/u);
  assert.match(market, /整机长期租赁/u);
  assert.match(market, /发布租赁需求/u);
  assert.match(market, /supplierReservationFiltered\.slice\(0, visibleCount\)/u);
  assert.match(market, /按时.*\$\{supplierReservationFiltered\.length\} 家/u);
  assert.doesNotMatch(market, /人民币|¥|￥|参考价/u);
});

test('本地供应商图标只映射官网域名已核验候选', async () => {
  const decoded = decodeSupplierQuoteDirectory(await snapshot(), 'bundled_reference_snapshot');
  const logoAssets = await readFile(new URL('../src/supplier-logo-assets.ts', import.meta.url), 'utf8');
  const bundledIds = [...logoAssets.matchAll(/'(?<id>supplier-quote-\d{8}-\d{3})': require/gu)]
    .map((match) => match.groups.id);
  assert.equal(bundledIds.length, 31);
  assert.equal(new Set(bundledIds).size, bundledIds.length);
  const approvals = JSON.parse(await readFile(new URL('../assets/suppliers/verified/visual-approvals.json', import.meta.url), 'utf8'));
  assert.deepEqual([...bundledIds].sort(), approvals.approvals.map((item) => item.supplierId).sort());
  const itemById = new Map(decoded.items.map((item) => [item.supplierId, item]));
  assert.ok(bundledIds.every((id) => itemById.get(id)?.logo.status === 'official_domain_candidate'));
  assert.ok(bundledIds.every((id) => logoAssets.includes(`assets/suppliers/verified/${id}.png`)));
  assert.doesNotMatch(logoAssets, /supplier-quote-20260817-001/u);
  const market = await readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(market, /item\.logo\.httpsUrl|source=\{\{ uri: item\.logo/u);
});

async function withLogoFixture(action) {
  const directory = await mkdtemp(resolve(tmpdir(), 'supplier-logo-evidence-test-'));
  try {
    await mkdir(resolve(directory, 'assets/suppliers'), { recursive: true });
    await mkdir(resolve(directory, 'src'), { recursive: true });
    await cp(new URL('../assets/suppliers/verified', import.meta.url), resolve(directory, 'assets/suppliers/verified'), { recursive: true });
    await cp(new URL('../src/supplier-logo-assets.ts', import.meta.url), resolve(directory, 'src/supplier-logo-assets.ts'));
    await action(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('供应商图标证据锁定官网请求、哈希、尺寸、相对路径和人工复核集合', async () => {
  assert.deepEqual(await verifySupplierLogoEvidence(new URL('..', import.meta.url).pathname), { ok: true, approved: 31 });
});

test('供应商图标证据对篡改、缺字段和绝对路径失败关闭', async () => {
  await withLogoFixture(async (directory) => {
    const path = resolve(directory, 'assets/suppliers/verified/supplier-quote-20260817-002.png');
    const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
    await assert.rejects(verifySupplierLogoEvidence(directory), /SUPPLIER_LOGO_ASSET_MISMATCH/u);
  });
  await withLogoFixture(async (directory) => {
    const path = resolve(directory, 'assets/suppliers/verified/manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const result = manifest.results.find((item) => item.supplierId === 'supplier-quote-20260817-002');
    delete result.officialPage.sha256; await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(verifySupplierLogoEvidence(directory), /SUPPLIER_LOGO_EVIDENCE_INVALID/u);
  });
  await withLogoFixture(async (directory) => {
    const path = resolve(directory, 'assets/suppliers/verified/manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.results.find((item) => item.supplierId === 'supplier-quote-20260817-002').relativePath = '/tmp/logo.png';
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(verifySupplierLogoEvidence(directory), /SUPPLIER_LOGO_EVIDENCE_INVALID/u);
  });
});
