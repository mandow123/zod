import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ClamAvScanner } from '../src/evidence/scanner.js';

async function fakeClamd(response: string) {
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 14 || !data.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let offset = 10;
      while (offset + 4 <= data.length) {
        const length = data.readUInt32BE(offset);
        if (length === 0) {
          socket.end(`${response}\0`);
          return;
        }
        if (offset + 4 + length > data.length) return;
        offset += 4 + length;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, port: address.port };
}

describe('ClamAV evidence scanning protocol', () => {
  it('streams bytes and accepts only an explicit clean response', async () => {
    const clean = await fakeClamd('stream: OK');
    await expect(new ClamAvScanner('127.0.0.1', clean.port).scan(Buffer.from('safe evidence')))
      .resolves.toEqual({ clean: true, signature: null });
    await new Promise<void>((resolve) => clean.server.close(() => resolve()));

    const infected = await fakeClamd('stream: Eicar-Test-Signature FOUND');
    await expect(new ClamAvScanner('127.0.0.1', infected.port).scan(Buffer.from('unsafe evidence')))
      .resolves.toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    await new Promise<void>((resolve) => infected.server.close(() => resolve()));
  });
});
