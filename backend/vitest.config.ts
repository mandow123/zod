import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Several PostgreSQL integration suites boot isolated PGlite databases in
    // parallel. Keep the assertion timeout above cold-start variance so a busy
    // release workstation does not turn healthy database behavior into a
    // false-negative five-second timeout.
    testTimeout: 15_000,
  },
});
