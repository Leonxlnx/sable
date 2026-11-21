// Bundles the desktop shell: electron/main.ts (with the server, ws and the Agent SDK's JavaScript)
// -> dist-electron/main.cjs, electron/preload.ts -> dist-electron/preload.cjs. Run after `vite build`
// (see `pnpm desktop:build`). The bundle needs nothing from node_modules at runtime.
//
// The SDK starts a native Claude Code binary from its platform package; that binary is staged in
// dist-resources/claude/ (a hard link, so no copy of its ~370 MB) and shipped by electron-builder as
// an extra resource. electron/main.ts points SABLE_CLAUDE_BIN at it.
import { build } from 'esbuild';
import { copyFileSync, existsSync, linkSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-electron');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  logLevel: 'warning',
  absWorkingDir: root,
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['electron/main.ts'],
    outfile: path.join(out, 'main.cjs'),
    // ws tries its optional native add-ons in a try/catch and falls back to JavaScript without them.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    // Server modules (and the SDK) locate files next to themselves through import.meta.url; in the
    // bundle that is the bundle's own location, so the files they read are copied next to it below.
    define: { 'import.meta.url': '__bundleUrl' },
    banner: { js: "const __bundleUrl = require('node:url').pathToFileURL(__filename).href;" },
    legalComments: 'none',
  }),
  build({
    ...common,
    entryPoints: ['electron/preload.ts'],
    outfile: path.join(out, 'preload.cjs'),
    external: ['electron'],
  }),
]);

copyFileSync(path.join(root, 'server/providers/demo-content.md'), path.join(out, 'demo-content.md'));
copyFileSync(path.join(root, 'build/icon.png'), path.join(out, 'icon.png'));
copyFileSync(path.join(root, 'build/icon.ico'), path.join(out, 'icon.ico'));
if (existsSync(path.join(root, 'build/icon-mac.png'))) copyFileSync(path.join(root, 'build/icon-mac.png'), path.join(out, 'icon-mac.png'));

/* ── the Claude Code binary ── */

const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
// The platform package is the SDK's own optional dependency, so resolve it from the SDK's real folder.
const sdkDir = realpathSync(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk'));
let source;
try {
  source = createRequire(path.join(sdkDir, 'package.json')).resolve(`${platformPkg}/${exe}`);
} catch {
  throw new Error(`${platformPkg} is not installed; run pnpm install (it is an optional dependency of the Agent SDK).`);
}
const staged = path.join(root, 'dist-resources/claude', exe);
// A hard link is the same file; a fallback copy is compared by size (each SDK release changes it).
const same = (a, b) => existsSync(b) && (statSync(a).ino === statSync(b).ino || statSync(a).size === statSync(b).size);
if (!same(source, staged)) {
  rmSync(path.dirname(staged), { recursive: true, force: true });
  mkdirSync(path.dirname(staged), { recursive: true });
  try {
    linkSync(source, staged);
  } catch {
    copyFileSync(source, staged); // another volume: a real copy
  }
}

console.log('Built dist-electron/main.cjs and dist-electron/preload.cjs; staged dist-resources/claude/' + exe);
