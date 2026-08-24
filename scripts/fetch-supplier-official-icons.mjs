import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const directoryPath = resolve(root, 'src/data/supplier-quote-directory.snapshot.json');
const outputDirectory = resolve(root, 'assets/suppliers/verified');
const manifestPath = resolve(outputDirectory, 'manifest.json');
const sipsPath = '/usr/bin/sips';
const manualReviewRejectIds = new Set(['supplier-quote-20260817-001']);
const headers = { 'user-agent': 'KAI-CloudPay-Supplier-Asset-Verifier/2.0' };

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function decodeHtml(value) { return value.replaceAll('&amp;', '&').replaceAll('&#x2F;', '/').replaceAll('&#47;', '/'); }

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  const normalized = address.toLowerCase();
  return isIP(address) === 6 && normalized !== '::' && normalized !== '::1'
    && !normalized.startsWith('fc') && !normalized.startsWith('fd') && !normalized.startsWith('fe8')
    && !normalized.startsWith('fe9') && !normalized.startsWith('fea') && !normalized.startsWith('feb')
    && !normalized.startsWith('::ffff:127.') && !normalized.startsWith('::ffff:10.')
    && !normalized.startsWith('::ffff:192.168.');
}

async function validateRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('HTTPS_PUBLIC_URL_REQUIRED');
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error('PUBLIC_DNS_REQUIRED');
  return url;
}

async function safeFetch(value, accept, maximumRedirects = 5) {
  let current = await validateRemoteUrl(value);
  const redirects = [];
  for (let count = 0; count <= maximumRedirects; count += 1) {
    const response = await fetch(current, { headers: { ...headers, accept }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || count === maximumRedirects) throw new Error('REDIRECT_INVALID');
      const next = await validateRemoteUrl(new URL(location, current).href);
      redirects.push(next.href); current = next; continue;
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return { response, requestUrl: value, finalUrl: current.href, redirects };
  }
  throw new Error('REDIRECT_INVALID');
}

function iconLinks(html, pageUrl) {
  const candidates = [];
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const relValue = tag.match(/\brel\s*=\s*["']([^"']+)["']/iu)?.[1] ?? '';
    if (!/(?:^|\s)(?:shortcut\s+icon|icon|apple-touch-icon)(?:\s|$)/iu.test(relValue)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!href || href.startsWith('data:')) continue;
    try {
      const url = new URL(decodeHtml(href), pageUrl);
      if (url.protocol !== 'https:') continue;
      const sizes = tag.match(/\bsizes\s*=\s*["']([^"']+)["']/iu)?.[1] ?? '';
      const score = Math.max(...[...sizes.matchAll(/(\d+)x(\d+)/gu)].map((match) => Number(match[1]) * Number(match[2])), 0)
        + (/apple-touch-icon/iu.test(relValue) ? 1 : 0);
      candidates.push({ url: url.href, score, provenance: 'referenced_by_official_https_page' });
    } catch {}
  }
  return [...new Map(candidates.sort((a, b) => b.score - a.score).map((item) => [item.url, item])).values()];
}

async function convertToPng(inputPath, outputPath) {
  await execFileAsync(sipsPath, ['-s', 'format', 'png', inputPath, '--out', outputPath], { timeout: 15_000 });
  const info = await stat(outputPath);
  if (!info.isFile() || info.size < 64 || info.size > 4_000_000) throw new Error('PNG_OUTPUT_INVALID');
  const { stdout } = await execFileAsync(sipsPath, ['-g', 'pixelWidth', '-g', 'pixelHeight', outputPath], { timeout: 15_000 });
  const width = Number(/pixelWidth:\s*(\d+)/u.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/u.exec(stdout)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 4096 || height > 4096) {
    throw new Error('PNG_DIMENSIONS_INVALID');
  }
  return { width, height };
}

async function downloadSupplierIcon(item, workDirectory) {
  const page = await safeFetch(item.logo.sourceUrl, 'text/html,application/xhtml+xml');
  const pageType = (page.response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml'].includes(pageType)) throw new Error('OFFICIAL_PAGE_CONTENT_TYPE_INVALID');
  const pageBytes = Buffer.from(await page.response.arrayBuffer());
  if (pageBytes.length < 64 || pageBytes.length > 2_000_000) throw new Error('OFFICIAL_PAGE_SIZE_INVALID');
  const pageHtml = pageBytes.toString('utf8');
  const pageOrigin = new URL(page.finalUrl).origin;
  const declared = new URL(item.logo.httpsUrl);
  const candidates = iconLinks(pageHtml, page.finalUrl);
  if (declared.origin === pageOrigin && !candidates.some((candidate) => candidate.url === declared.href)) {
    candidates.push({ url: declared.href, score: -1, provenance: 'same_origin_declared_favicon' });
  }
  const errors = [];
  for (const candidate of candidates) {
    const rawPath = resolve(workDirectory, `${item.supplierId}.raw`);
    const pngPath = resolve(workDirectory, `${item.supplierId}.png`);
    try {
      const asset = await safeFetch(candidate.url, 'image/avif,image/webp,image/apng,image/svg+xml,image/*');
      const contentType = (asset.response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) throw new Error('ICON_CONTENT_TYPE_INVALID');
      const rawBytes = Buffer.from(await asset.response.arrayBuffer());
      if (rawBytes.length < 32 || rawBytes.length > 2_000_000) throw new Error('ICON_SIZE_INVALID');
      await writeFile(rawPath, rawBytes, { flag: 'wx', mode: 0o600 });
      const dimensions = await convertToPng(rawPath, pngPath);
      const pngBytes = await readFile(pngPath);
      const targetPath = resolve(outputDirectory, `${item.supplierId}.png`);
      const rejected = manualReviewRejectIds.has(item.supplierId);
      if (!rejected) await copyFile(pngPath, targetPath);
      return { status: rejected ? 'manual_review_rejected' : 'fetched_pending_visual_review',
        fetchedAt: new Date().toISOString(), relativePath: rejected ? null : relative(root, targetPath),
        manualReviewReason: rejected ? 'visually_corrupted_or_not_recognizable' : null,
        officialPage: { requestUrl: page.requestUrl, finalUrl: page.finalUrl, redirects: page.redirects,
          contentType: pageType, sha256: sha256(pageBytes) },
        asset: { requestUrl: asset.requestUrl, finalUrl: asset.finalUrl, redirects: asset.redirects,
          contentType, rawSha256: sha256(rawBytes), pngSha256: sha256(pngBytes), bytes: pngBytes.length, ...dimensions },
        provenance: candidate.provenance };
    } catch (error) {
      await rm(rawPath, { force: true }); await rm(pngPath, { force: true });
      errors.push(`${candidate.url}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join(' | ') || 'NO_ICON_CANDIDATE');
}

await mkdir(outputDirectory, { recursive: true });
const workDirectory = await mkdtemp(join(tmpdir(), 'kai-supplier-icons-'));
try {
  const directory = JSON.parse(await readFile(directoryPath, 'utf8'));
  const officialCandidates = directory.items.filter((item) => item.logo?.status === 'official_domain_candidate'
    && item.logo?.sourceUrl?.startsWith('https://') && item.logo?.httpsUrl?.startsWith('https://'));
  const results = [];
  for (let index = 0; index < officialCandidates.length; index += 6) {
    results.push(...await Promise.all(officialCandidates.slice(index, index + 6).map(async (item) => {
      try { return { supplierId: item.supplierId, legalName: item.legalName, ...(await downloadSupplierIcon(item, workDirectory)) }; }
      catch (error) { return { supplierId: item.supplierId, legalName: item.legalName, status: 'unavailable',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }; }
    })));
  }
  const fetchedIds = results.filter((item) => item.status === 'fetched_pending_visual_review').map((item) => item.supplierId);
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(),
    policy: 'Fresh fetch only; HTTPS public-network pages and assets; every bundled mapping additionally requires visual approval.',
    fetchedIds, approvedIds: [], results }, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ officialCandidates: officialCandidates.length, fetched: fetchedIds.length,
    rejected: results.filter((item) => item.status === 'manual_review_rejected').length,
    unavailable: results.filter((item) => item.status === 'unavailable').length })}\n`);
} finally { await rm(workDirectory, { recursive: true, force: true }); }
