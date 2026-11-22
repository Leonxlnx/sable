// Starts the dev server on a throwaway data folder, so tests and screenshots never touch ~/.sable
// (plain `pnpm dev` runs the bridge on the real profile). Usage: node scripts/dev-test.mjs
// The folder is %TEMP%/sable-dev-home (override with SABLE_TEST_HOME); it is seeded as onboarded.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.SABLE_TEST_HOME || path.join(os.tmpdir(), 'sable-dev-home');
mkdirSync(path.join(home, 'sessions'), { recursive: true });
const state = path.join(home, 'state.json');
if (!existsSync(state)) writeFileSync(state, JSON.stringify({ projects: [], settings: { onboarded: true, prewarm: false }, sessions: [], accounts: [] }));
// Never start an idle agent process ahead of time here: it would run on the real agents' sign-in.
else {
  try {
    const s = JSON.parse(readFileSync(state, 'utf8'));
    if (s.settings?.prewarm !== false) {
      s.settings = { ...s.settings, prewarm: false };
      writeFileSync(state, JSON.stringify(s));
    }
  } catch {}
}

console.log(`[dev-test] data folder: ${home}`);
// Never GitHub from here either: the Changes tab's pull request row would start gh on the owner's sign-in.
const child = spawn('pnpm', ['dev'], { stdio: 'inherit', shell: true, env: { ...process.env, SABLE_HOME: home, SABLE_NO_GITHUB: '1' } });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
