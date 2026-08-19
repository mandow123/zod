import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
});
