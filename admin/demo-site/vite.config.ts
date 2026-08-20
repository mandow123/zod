import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from '@openai/sites-vite-plugin';
import vinext from 'vinext';
import { defineConfig, normalizePath } from 'vite';
import hostingConfig from './.openai/hosting.json';

const demoClient = normalizePath(new URL('../src/api/demo-client.ts', import.meta.url).pathname).replace(/^\/[A-Za-z]:/u, (value) => value.slice(1));

export default defineConfig({
  define: {
    'import.meta.env.VITE_ADMIN_DEMO': JSON.stringify('true'),
  },
  resolve: {
    alias: [{ find: /^\.\.\/api\/client$/u, replacement: demoClient }],
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  plugins: [
    vinext(),
    sites(),
    cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      config: {
        main: './worker/index.ts',
        compatibility_flags: ['nodejs_compat'],
        d1_databases: hostingConfig.d1 ? [] : [],
        r2_buckets: hostingConfig.r2 ? [] : [],
      },
    }),
  ],
});
