import { vi } from 'vitest';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function fixtureDir(dir: string) {
  return path.basename(dir) === 'web' && path.dirname(path.dirname(dir)) === process.env.TEMP &&
    /^web-(test|cert)-[\w-]+$/.test(path.basename(path.dirname(dir)));
}
// Called in each fixture owner's afterEach, before it removes its private directory.
export function restoreWebAcl(home: string) {
  const dir = path.join(home, 'web');
  if (process.platform !== 'win32' || !fixtureDir(dir) || !existsSync(dir) || process.env.SABLE_TEST_WEB_ACL_FIXTURE === '1') return;
  const ps = path.join((process.env.SystemRoot ?? process.env.SYSTEMROOT)!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    "$grant='*'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+':(OI)(CI)F'; & icacls.exe $env:SABLE_TEST_RESTORE /inheritance:e /grant:r $grant; exit $LASTEXITCODE"],
    { windowsHide: true, env: { ...process.env, SABLE_TEST_RESTORE: dir } });
}

// web-cert.ts runs its PowerShell through web-run.ts (from a worker thread). With SABLE_TEST_WEB_ACL_FIXTURE=1
// (a sandbox where Windows ACLs cannot be set) the folder's DACL and the key reads are stood in for.
vi.mock('../server/services/web-run', async original => {
  const actual = await original<typeof import('../server/services/web-run')>();
  return { ...actual, runOff: (file: string, args: string[], env: NodeJS.ProcessEnv, opts?: { timeout?: number; maxBuffer?: number }) => {
    if (process.env.SABLE_TEST_WEB_ACL_FIXTURE === '1' && process.platform === 'win32' && path.basename(file).toLowerCase() === 'powershell.exe') {
      if (env.SABLE_WEB_KEY_DIR && fixtureDir(env.SABLE_WEB_KEY_DIR)) {
        mkdirSync(env.SABLE_WEB_KEY_DIR, { recursive: true });
        return Promise.resolve(Buffer.alloc(0));
      }
      if (env.SABLE_WEB_PRIVATE_FILE && fixtureDir(path.dirname(env.SABLE_WEB_PRIVATE_FILE))) return Promise.resolve(readFileSync(env.SABLE_WEB_PRIVATE_FILE));
    }
    return actual.runOff(file, args, env, opts);
  } };
});
