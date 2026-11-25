// Exit inside the real writer, leaving the OS to close descriptors. No finally runs.
import fs from 'node:fs';
import disk from 'node:fs/promises';
import { createRequire } from 'node:module';
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
const { Store } = require('../../server/core/store.ts');
if (phase === 'save-unlocked') {
  // A peer running a build without node:sqlite still writes its sessions.
  const get = process.getBuiltinModule;
  process.getBuiltinModule = name => name === 'node:sqlite' ? undefined : get(name);
} else if (phase === 'save') {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const exec = DatabaseSync.prototype.exec;
  let attempts = 0;
  DatabaseSync.prototype.exec = function(sql) {
    try { return exec.call(this, sql); }
    catch (err) {
      if (err.errcode === 5 && ++attempts === 2) fs.writeFileSync(path.join(dir, 'waiting-to-publish'), '');
      throw err;
    }
  };
}
const store = new Store(dir);
const data = await store.loadSessionAsync('a');
if (phase === 'save-unlocked' || phase === 'save') {
  data.items.push({ type: 'text', id: 'peer-save', ts: 7, text: 'From the other process' });
  store.saveSession('a', () => ({ ...data, dirty: new Set(['peer-save']) }));
  await store.seal();
  process.exit(0);
}
await store.sessionFiles.migrate('a', () => true);
throw Error('Migration did not reach the requested crash point: ' + fs.readdirSync(path.dirname(file('a'))));
