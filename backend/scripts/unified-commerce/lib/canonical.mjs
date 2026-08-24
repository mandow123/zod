import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
export const auditToken = (key, domain, value) => `${domain}_${hmac(key, `${domain}\0${value}`)}`;
export const randomSchema = () => `ucommerce_stage_${randomBytes(6).toString('hex')}`;

export async function readCredential(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('UNIFIED_CREDENTIAL_FILE_MODE_REQUIRED');
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length < 32 || value.length > 4096) throw new Error('UNIFIED_CREDENTIAL_INVALID');
  return value;
}

export async function writeJson0600(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { bytes: Buffer.byteLength(body), sha256: sha256(body) };
}

export function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith('--')) throw new Error('UNIFIED_ARGUMENT_INVALID');
    if (name === '--cleanup' || name === '--plan-only') { parsed.set(name.slice(2), true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`UNIFIED_ARGUMENT_MISSING:${name}`);
    if (parsed.has(name.slice(2))) throw new Error(`UNIFIED_ARGUMENT_DUPLICATE:${name}`);
    parsed.set(name.slice(2), value); index += 1;
  }
  return parsed;
}

export function required(args, name) {
  const value = args.get(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`UNIFIED_ARGUMENT_REQUIRED:${name}`);
  return value;
}
