import { randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target?.startsWith('/')) throw new Error('ABSOLUTE_ENV_PATH_REQUIRED');
const names = ['STAGING_BUYER_TOKEN','STAGING_CREATOR_TOKEN','STAGING_OPERATOR_ACCESS_TOKEN','STAGING_SUPPLIER_TOKEN','STAGING_OPERATOR_CONTROL_TOKEN'];
const content = names.map((name) => `${name}=${randomBytes(32).toString('base64url')}`).join('\n') + '\n';
await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
await chmod(target, 0o600);
process.stdout.write(`Created protected staging environment at ${target}. Values were not printed.\n`);
