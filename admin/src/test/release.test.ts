import { describe, expect, it } from 'vitest';
import {
  assertReleasePath,
  canonicalHttpsOrigin,
  formatManifest,
} from '../../scripts/release-lib.mjs';

describe('administrator Web production release policy', () => {
  it('accepts only canonical HTTPS build/runtime origins', () => {
    expect(canonicalHttpsOrigin('https://admin-api.example.invalid')).toBe(
      'https://admin-api.example.invalid',
    );
    for (const unsafe of [
      '',
      'http://admin-api.example.invalid',
      'https://user:secret@admin-api.example.invalid',
      'https://admin-api.example.invalid/path',
      'https://admin-api.example.invalid?debug=1',
      'https://admin-api.example.invalid ',
    ]) {
      expect(() => canonicalHttpsOrigin(unsafe)).toThrow();
    }
  });

  it('rejects environment files, dependencies, tests, demos, fixtures and source maps', () => {
    expect(assertReleasePath('src/main.tsx')).toBe('src/main.tsx');
    expect(assertReleasePath('dist/assets/index-a1b2c3.js')).toBe('dist/assets/index-a1b2c3.js');

    for (const forbidden of [
      '.env',
      '.env.example',
      'node_modules/react/index.js',
      'src/test/client.test.ts',
      'src/__tests__/client.ts',
      'demo-api.mjs',
      'src/order-fixture.ts',
      'src/user-mock.ts',
      'dist/assets/index.js.map',
      '../outside.txt',
      '/absolute.txt',
    ]) {
      expect(() => assertReleasePath(forbidden)).toThrow();
    }
  });

  it('writes a stable, sorted, duplicate-free SHA-256 manifest', () => {
    const first = '1'.repeat(64);
    const second = '2'.repeat(64);
    expect(formatManifest([
      { path: 'src/main.tsx', digest: second },
      { path: 'Dockerfile', digest: first },
    ])).toBe(`${first}  Dockerfile\n${second}  src/main.tsx\n`);

    expect(() => formatManifest([
      { path: 'Dockerfile', digest: first },
      { path: 'Dockerfile', digest: second },
    ])).toThrow(/duplicate/u);
    expect(() => formatManifest([{ path: 'Dockerfile', digest: 'not-a-digest' }])).toThrow(
      /invalid SHA-256/u,
    );
  });
});
