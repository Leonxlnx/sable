import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The phone app: a static bundle Capacitor ships inside the APK (no server, no network but the desktop). */
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@shared': r('../shared'),
      '@desk': r('../src'),
      '@m': r('./src'),
      // The desktop's own name for its folder, inside the pure modules the phone reads (usage/plans.ts,
      // usage/format.ts): `@/…` only (a bare '@' alias matches '@' and '@/…', never '@capacitor/…').
      '@': r('../src'),
    },
    // The shared files import nothing from node_modules but these; resolve them here, not at the root.
    dedupe: ['react', 'react-dom'],
  },
  server: { fs: { allow: ['..'] }, watch: { ignored: ['**/android/**', '**/dist/**'] } },
  // Only the app's own entry: the Android build folder holds old bundles the scan would trip over.
  optimizeDeps: { entries: ['index.html'] },
  build: { target: 'es2022', sourcemap: false, outDir: 'dist', assetsInlineLimit: 0 },
});
