import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Build only: every Phosphor icon ships six weights, the app renders duotone, bold, fill and
 * regular. Drops the thin and light entries from each icon's weight map. Any file that does
 * not look exactly as expected is left alone.
 */
function phosphorWeights(): PluginOption {
  const DEFS = /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/;
  // One `[ "weight", element ]` entry with its trailing comma, so no hole is left behind.
  const ENTRY = /\n {2}\[\n {4}"(thin|light)",\n[\s\S]*?\n {2}\],?(?=\n)/g;
  return {
    name: 'sable:phosphor-weights',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!DEFS.test(id.split('?')[0]) || !code.includes('new Map([')) return null;
      const out = code.replace(ENTRY, (m) => (m.indexOf('\n  [\n', 1) >= 0 ? m : ''));
      if (out === code) return null;
      // Both gone, the four used weights intact, nothing else touched.
      const kept = ['bold', 'duotone', 'fill', 'regular'].every((w) => out.includes(`\n    "${w}",`));
      if (!kept || /\n {4}"(thin|light)",/.test(out)) return null;
      return { code: out, map: null };
    },
  };
}

/**
 * The page's first script (src/boot.ts: the bridge socket and the launch light) is an entry of its
 * own and loads before the app's. Bundled into the app's entry (what Vite does with a second script
 * in index.html) it would run only after the app's shared chunks had loaded and run.
 */
function bootEntry(): PluginOption {
  let build = false;
  return {
    name: 'sable:boot-entry',
    config(_config, env) {
      build = env.command === 'build';
      return build ? { build: { rollupOptions: { input: { index: r('./index.html'), boot: r('./src/boot.ts') } } } } : undefined;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!build) return [{ tag: 'script', attrs: { type: 'module', src: '/src/boot.ts' }, injectTo: 'head-prepend' }];
        const chunk = Object.values(ctx.bundle ?? {}).find((c) => c.type === 'chunk' && c.isEntry && c.name === 'boot');
        if (!chunk || chunk.type !== 'chunk') return;
        return [
          { tag: 'script', attrs: { type: 'module', crossorigin: true, src: `/${chunk.fileName}` }, injectTo: 'head-prepend' },
          ...chunk.imports.map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `/${f}` }, injectTo: 'head-prepend' as const })),
        ];
      },
    },
  };
}

export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = [phosphorWeights(), bootEntry(), react()];
  if (command === 'serve') {
    // The bridge (Claude Code / Codex / demo providers) rides on the dev server.
    const { bridgePlugin } = await import('./server/vite-plugin');
    plugins.push(bridgePlugin());
  }
  return {
    plugins,
    resolve: {
      alias: {
        '@': r('./src'),
        '@shared': r('./shared'),
      },
    },
    server: { port: 5173, strictPort: false, host: '127.0.0.1' },
    build: { target: 'es2022', sourcemap: false },
    // The highlighting worker loads grammars on demand, which needs an ES module worker.
    worker: { format: 'es' as const },
  };
});
