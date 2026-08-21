import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async ({ command, mode }) => {
  const demo = mode === 'demo';
  if (demo && command !== 'serve') throw new Error('ADMIN_DEMO_MODE_IS_DEV_ONLY');

  const plugins = [react()];
  if (demo) {
    // Keep the synthetic demo API out of production release bundles. Using a
    // runtime-computed import also lets the production-only source archive
    // build without carrying demo fixtures.
    const demoModulePath = './demo-api.mjs';
    const { createAdminDemoApi } = await import(demoModulePath);
    plugins.push(createAdminDemoApi());
  }

  return {
    plugins,
    build: {
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: true,
    },
    server: {
      port: 4170,
      strictPort: true,
    },
    preview: {
      port: 4170,
      strictPort: true,
    },
  };
});
