// Runs the desktop app and reloads it when its source changes.
//   electron/, server/, shared/  -> bundle the Electron files again, then restart the app
//   src/                         -> rebuild the UI (vite build), then restart the app
// Each change is debounced; the window closes and reopens with the new build. Stop with Ctrl+C.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBin = require('electron'); // the path to electron.exe
const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');

let app = null;
let queued = null;
let busy = false;

function run(label, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}

// The dev window gets its own Electron profile (Chromium cache, window state, single-instance lock).
// Sharing %APPDATA%\Sable with the installed app makes Chromium fail to move the cache on start-up
// ("Unable to move the cache: Access is denied"), because the installed app holds those files.
const devProfile = path.join(root, 'scratch', 'desktop-dev-profile');

function start() {
  if (app) app.kill();
  app = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { SABLE_USER_DATA: devProfile, ...process.env },
  });
  app.on('exit', (code, signal) => {
    if (signal === null && code !== null && code !== 0) console.log(`[desktop:dev] app exited (code ${code})`);
  });
}

async function rebuild(kind) {
  try {
    if (kind === 'ui') await run('vite build', process.execPath, [viteBin, 'build']);
    await run('electron build', process.execPath, [path.join(root, 'scripts/build-electron.mjs')]);
    start();
    console.log(`[desktop:dev] reloaded (${kind})`);
  } catch (error) {
    console.error(`[desktop:dev] ${error.message}`);
  }
}

// One build at a time; changes that arrive meanwhile merge into one follow-up build.
async function drain() {
  if (busy) return;
  busy = true;
  while (queued) {
    const kind = queued;
    queued = null;
    await rebuild(kind);
  }
  busy = false;
}

let timer = null;
function changed(kind) {
  // A UI change also needs the Electron bundle, so 'ui' wins over 'electron'.
  queued = queued === 'ui' || kind === 'ui' ? 'ui' : 'electron';
  clearTimeout(timer);
  timer = setTimeout(drain, 250);
}

const isSource = (file) => file && !/[\\/](node_modules|dist|dist-electron|dist-resources|release|release-[^\\/]+)[\\/]/.test(file) && !/\.(md|log)$/.test(file);

for (const dir of ['electron', 'server', 'shared']) {
  watch(path.join(root, dir), { recursive: true }, (_event, file) => {
    if (isSource(file)) changed('electron');
  });
}
watch(path.join(root, 'src'), { recursive: true }, (_event, file) => {
  if (isSource(file)) changed('ui');
});

process.on('SIGINT', () => {
  app?.kill();
  process.exit(0);
});
process.on('exit', () => app?.kill());

console.log('[desktop:dev] building, then opening the app. Edits to electron/, server/, shared/ or src/ reload it.');
await rebuild('ui');
