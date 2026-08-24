import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hashPattern = /^[0-9a-f]{64}$/u;
const idPattern = /^supplier-quote-20260817-\d{3}$/u;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safeHttps(value) {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && !/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('SUPPLIER_LOGO_PNG_INVALID');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function verifySupplierLogoEvidence(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'assets/suppliers/verified/manifest.json'), 'utf8'));
  const approvals = JSON.parse(await readFile(resolve(root, 'assets/suppliers/verified/visual-approvals.json'), 'utf8'));
  const mapping = await readFile(resolve(root, 'src/supplier-logo-assets.ts'), 'utf8');
  if (manifest.schemaVersion !== 2 || approvals.schemaVersion !== 1 || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !Number.isFinite(Date.parse(approvals.reviewedAt)) || !Array.isArray(manifest.results)
    || !Array.isArray(manifest.fetchedIds) || !Array.isArray(approvals.approvals)) throw new Error('SUPPLIER_LOGO_EVIDENCE_INVALID');
  const mappedIds = [...mapping.matchAll(/'(?<id>supplier-quote-\d{8}-\d{3})': require/gu)].map((match) => match.groups.id);
  const approvalById = new Map(approvals.approvals.map((item) => [item.supplierId, item]));
  const resultById = new Map(manifest.results.map((item) => [item.supplierId, item]));
  if (new Set(mappedIds).size !== mappedIds.length || mappedIds.length !== approvalById.size
    || mappedIds.some((id) => !approvalById.has(id)) || [...approvalById].some(([id]) => !mappedIds.includes(id))
    || mappedIds.includes('supplier-quote-20260817-001')) throw new Error('SUPPLIER_LOGO_APPROVAL_SET_MISMATCH');
  for (const id of mappedIds) {
    const result = resultById.get(id); const approval = approvalById.get(id);
    if (!idPattern.test(id) || result?.status !== 'fetched_pending_visual_review' || result.supplierId !== id
      || !manifest.fetchedIds.includes(id) || !Number.isFinite(Date.parse(result.fetchedAt))
      || typeof result.relativePath !== 'string' || isAbsolute(result.relativePath) || result.relativePath.includes('..')
      || result.relativePath !== `assets/suppliers/verified/${id}.png`
      || !safeHttps(result.officialPage?.requestUrl) || !safeHttps(result.officialPage?.finalUrl)
      || !safeHttps(result.asset?.requestUrl) || !safeHttps(result.asset?.finalUrl)
      || !hashPattern.test(result.officialPage?.sha256) || !hashPattern.test(result.asset?.rawSha256)
      || !hashPattern.test(result.asset?.pngSha256) || approval?.pngSha256 !== result.asset.pngSha256
      || !Number.isInteger(result.asset.width) || !Number.isInteger(result.asset.height)
      || result.asset.width < 16 || result.asset.height < 16 || result.asset.width > 4096 || result.asset.height > 4096
      || !String(result.asset.contentType).startsWith('image/')) throw new Error(`SUPPLIER_LOGO_EVIDENCE_INVALID:${id}`);
    const bytes = await readFile(resolve(root, result.relativePath)); const dimensions = pngDimensions(bytes);
    if (sha256(bytes) !== result.asset.pngSha256 || bytes.length !== result.asset.bytes
      || dimensions.width !== result.asset.width || dimensions.height !== result.asset.height) {
      throw new Error(`SUPPLIER_LOGO_ASSET_MISMATCH:${id}`);
    }
  }
  return { ok: true, approved: mappedIds.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await verifySupplierLogoEvidence(resolve(import.meta.dirname, '..'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
