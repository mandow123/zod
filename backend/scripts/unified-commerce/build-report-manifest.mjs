#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';

const args = parseArgs(process.argv.slice(2));
const allowed = new Set(['source-inventory', 'domain-mapping', 'dry-run-report', 'output']);
if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('UNIFIED_ARGUMENT_INVALID');
const requested = [
  ['source-inventory.json', required(args, 'source-inventory')],
  ['domain-mapping.json', required(args, 'domain-mapping')],
  ['dry-run-report.json', required(args, 'dry-run-report')],
];
const files = [];
for (const [expectedName, path] of requested) {
  if (basename(path) !== expectedName) throw new Error('UNIFIED_REPORT_NAME_INVALID');
  const info = await stat(path); const bytes = await readFile(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('UNIFIED_REPORT_MODE_INVALID');
  files.push({ name: expectedName, bytes: info.size, sha256: sha256(bytes) });
}
const output = { schemaVersion: 1, kind: 'unified_commerce_u0_zero_secret_reports', files };
output.aggregateDigest = sha256(stable(output));
const written = await writeJson0600(required(args, 'output'), output);
process.stdout.write(`${JSON.stringify({ ok: true, output: written, aggregateDigest: output.aggregateDigest })}\n`);
