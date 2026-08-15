import { createConnection, type Socket } from 'node:net';
import type { RuntimeConfig } from '../config.js';

export type MalwareScanResult = Readonly<{ clean: boolean; signature: string | null }>;

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<MalwareScanResult>;
}

function write(socket: Socket, bytes: Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { socket.off('drain', onDrain); reject(error); };
    const onDrain = () => { socket.off('error', onError); resolve(); };
    socket.once('error', onError);
    if (socket.write(bytes)) {
      socket.off('error', onError);
      resolve();
    } else socket.once('drain', onDrain);
  });
}

export class ClamAvScanner implements MalwareScanner {
  constructor(private readonly host: string, private readonly port: number) {}

  async scan(bytes: Uint8Array) {
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('EVIDENCE_SCAN_SIZE_LIMIT');
    const socket = createConnection({ host: this.host, port: this.port });
    socket.setTimeout(60_000);
    const response = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8').replace(/\0.*$/su, '').trim());
      };
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunks.reduce((total, item) => total + item.length, 0) > 4096) reject(new Error('CLAMAV_RESPONSE_TOO_LARGE'));
        if (chunk.includes(0)) finish();
      });
      socket.once('timeout', () => reject(new Error('CLAMAV_TIMEOUT')));
      socket.once('error', reject);
      socket.once('end', finish);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      await write(socket, Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.byteLength);
        await write(socket, length);
        await write(socket, chunk);
      }
      await write(socket, Buffer.alloc(4));
      const result = await response;
      if (result.endsWith(': OK')) return { clean: true, signature: null };
      const match = /: (.+) FOUND$/u.exec(result);
      if (match?.[1]) return { clean: false, signature: match[1].slice(0, 200) };
      throw new Error('CLAMAV_RESPONSE_INVALID');
    } finally {
      socket.destroy();
    }
  }
}

export function createMalwareScanner(config: RuntimeConfig) {
  if (!config.readiness.capabilities.malwareScanning.available) return null;
  const port = Number(config.CLAMAV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLAMAV_PORT must be between 1 and 65535.');
  return new ClamAvScanner(config.CLAMAV_HOST!, port);
}
