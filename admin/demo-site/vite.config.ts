import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from '@openai/sites-vite-plugin';
import vinext from 'vinext';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import hostingConfig from './.openai/hosting.json';

const productionClient = normalizePath(new URL('../src/api/client.ts', import.meta.url).pathname).replace(/^\/[A-Za-z]:/u, (value) => value.slice(1));
const demoClient = normalizePath(new URL('../src/api/demo-client.ts', import.meta.url).pathname).replace(/^\/[A-Za-z]:/u, (value) => value.slice(1));

function demoClientAlias(): Plugin {
  return {
    name: 'kai-admin-online-demo-client',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const resolved = normalizePath(new URL(source, `file:///${normalizePath(importer)}`).pathname)
        .replace(/^\/[A-Za-z]:/u, (value) => value.slice(1));
      return resolved === productionClient ? demoClient : null;
    },
  };
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_ADMIN_DEMO': JSON.stringify('true'),
  },
  plugins: [
    demoClientAlias(),
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
