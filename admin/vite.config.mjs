import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createAdminDemoApi } from './demo-api.mjs';

export default defineConfig(({ command, mode }) => {
  const demo = mode === 'demo';
  if (demo && command !== 'serve') throw new Error('ADMIN_DEMO_MODE_IS_DEV_ONLY');

  return {
    plugins: [react(), ...(demo ? [createAdminDemoApi()] : [])],
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
