import { isAbsolute } from 'node:path';
import { readBackupHeader, sha256File } from './format.js';

const inputIndex = process.argv.indexOf('--input');
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (!inputPath || !isAbsolute(inputPath)) throw new Error('Use --input with an absolute encrypted backup path.');
const parsed = await readBackupHeader(inputPath);
process.stdout.write(`${JSON.stringify({
  ok: true, header: parsed.header, encryptedSizeBytes: parsed.sizeBytes, sha256Digest: await sha256File(inputPath),
})}\n`);
