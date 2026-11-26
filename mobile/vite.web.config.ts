import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import mobile from './vite.config';

export default mergeConfig(mobile, defineConfig({
  plugins: [{
    name: 'sable-web-entry',
    transformIndexHtml: { order: 'pre', handler(html) {
      return html.replace(/<style>[\s\S]*?<\/style>/, '').replace('/src/main.tsx', '/src/web/main.ts');
    } },
  }],
  resolve: { alias: [{ find: /^@capacitor\/.+$/, replacement: fileURLToPath(new URL('./src/web/plugins.ts', import.meta.url)) }] },
  define: {
    'import.meta.env.SABLE_WEB': 'true',
    'import.meta.env.VITE_SABLE_DEBUG': 'false',
    // All existing page caches (including drafts, submissions and tails) have page lifetime.
    localStorage: 'globalThis.sablePageStorage',
  },
  build: { outDir: 'dist-web' },
}));

