import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import mobile from './vite.config';
import { faviconSvg, HEAD_LINKS, iconPng, manifest } from './web-icons';

export default mergeConfig(mobile, defineConfig({
  plugins: [{
    name: 'sable-web-entry',
    transformIndexHtml: { order: 'pre', handler(html) {
      return html.replace(/<style>[\s\S]*?<\/style>/, '').replace('/src/main.tsx', '/src/web/main.ts').replace('</head>', `  ${HEAD_LINKS}\n  </head>`);
    } },
  }, {
    // The icon, the Home Screen icons and the manifest, drawn from Sable's mark in code (web-icons.ts).
    name: 'sable-web-icons',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/favicon.svg', source: faviconSvg() });
      this.emitFile({ type: 'asset', fileName: 'assets/manifest.webmanifest', source: manifest() });
      for (const size of [180, 192, 512]) this.emitFile({ type: 'asset', fileName: `assets/icon-${size}.png`, source: iconPng(size) });
    },
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
