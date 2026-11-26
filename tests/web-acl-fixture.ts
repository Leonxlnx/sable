import { vi } from 'vitest';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

/** Managed Windows test runners can forbid WRITE_DAC even in TEMP. In that case exercise TLS
 * and protocol tests with throwaway fixture keys. The default run uses the production DACL. */
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    const [file, , options] = args;
    const dir = options && typeof options === 'object' && 'env' in options && options.env?.SABLE_WEB_KEY_DIR;
    if (process.env.SABLE_TEST_WEB_ACL_FIXTURE === '1' && process.platform === 'win32' && dir &&
        path.basename(file).toLowerCase() === 'powershell.exe' && path.dirname(path.dirname(dir)) === process.env.TEMP &&
        /^web-(test|cert)-[\w-]+$/.test(path.basename(path.dirname(dir)))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return Buffer.alloc(0);
    }
    return actual.execFileSync(...args);
  } };
});

