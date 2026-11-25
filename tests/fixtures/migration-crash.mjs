// Exit inside the real writer, leaving the OS to close descriptors. No finally runs.
import fs from 'node:fs';
import disk from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
require.extensions['.ts'] = (mod, source) => mod._compile(ts.transpile(fs.readFileSync(source, 'utf8'),
  { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }), source);
const [dir, phase] = process.argv.slice(2);
const file = id => path.join(dir, 'sessions', id + '.json');
if (phase === 'renamed') {
  const rename = disk.rename;
  disk.rename = async (from, to) => {
    await rename(from, to);
    if (to === file('a')) process.exit(91);
  };
} else if (phase === 'copy') {
  const open = disk.open;
  disk.open = async (...args) => {
    const fh = await open(...args);
    if (args[1] === 'wx') {
      fh.writeFile = async bytes => {
        await fh.write(bytes.subarray(0, 100));
        process.exit(91);
      };
    }
    return fh;
  };
}
if (phase === 'displaced') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from === file('a.tail') && String(to).includes('.recover.')) {
      rename(from, file('parked'));
      const peer = spawnSync(process.execPath, [process.argv[1], dir, 'save-unlocked'], { timeout: 15_000, windowsHide: true, stdio: 'inherit' });
      if (peer.status !== 0) throw peer.error ?? Error('Peer save failed');
      rename(from, to);
      process.exit(91);
    }
    return rename(from, to);
  };
} else if (phase.startsWith('staged-')) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.tmp') && to === file(phase === 'staged-base' ? 'a' : 'a.tail')) process.exit(91);
    return rename(from, to);
  };
}
const { Store } = require('../../server/core/store.ts');
if (phase === 'save-unlocked') {
  // A peer running a build without node:sqlite still writes its sessions.
  const get = process.getBuiltinModule;
  process.getBuiltinModule = name => name === 'node:sqlite' ? undefined : get(name);
}
const store = new Store(dir);
if (phase === 'displaced') {
  await store.sessionFiles.verifyMigrations(['a'], new AbortController().signal);
  throw Error('Cleanup did not reach the displacement');
}
const data = await store.loadSessionAsync('a');
if (phase === 'save-unlocked' || phase === 'save' || phase.startsWith('staged-')) {
  data.items.push({ type: 'text', id: 'peer-save', ts: 7, text: 'From the other process' });
  store.saveSession('a', () => ({ ...data, dirty: new Set(['peer-save']) }));
  if (phase === 'staged-base') await store.persistInput('a');
  else await store.seal();
  if (phase === 'save') fs.writeFileSync(path.join(dir, 'published'), '');
  process.exit(0);
}
await store.sessionFiles.migrate('a', () => true);
throw Error('Migration did not reach the requested crash point: ' + fs.readdirSync(path.dirname(file('a'))));
