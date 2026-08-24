import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'assets/suppliers/verified/manifest.json'), 'utf8'));
const rows = manifest.results.filter((item) => item.status === 'fetched_pending_visual_review');
const width = 1500; const cellWidth = 300; const cellHeight = 180;
const height = Math.ceil(rows.length / 5) * cellHeight;
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const cells = [];
for (const [index, item] of rows.entries()) {
  const x = (index % 5) * cellWidth; const y = Math.floor(index / 5) * cellHeight;
  const png = await readFile(resolve(root, item.relativePath));
  cells.push(`<g transform="translate(${x} ${y})"><rect x="8" y="8" width="284" height="164" rx="16" fill="#fff" stroke="#d6e4f7"/>`
    + `<image x="24" y="24" width="72" height="72" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${png.toString('base64')}"/>`
    + `<text x="112" y="48" font-family="Arial, PingFang SC" font-size="18" font-weight="700" fill="#10213a">${escape(item.legalName)}</text>`
    + `<text x="112" y="78" font-family="Arial" font-size="14" fill="#63738d">${escape(item.supplierId.slice(-3))} · ${item.asset.width}×${item.asset.height}</text>`
    + `<text x="24" y="132" font-family="Arial" font-size="12" fill="#63738d">${escape(new URL(item.asset.finalUrl).hostname)}</text></g>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#eef3f8"/>${cells.join('')}</svg>`;
await writeFile(resolve(root, 'artifacts/release/supplier-logo-contact-sheet.svg'), svg, 'utf8');
