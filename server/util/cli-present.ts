import { existsSync } from 'node:fs';
import path from 'node:path';
import { trustedPathDirs } from './which';

/**
 * Whether an agent's CLI is there, without starting it: its override variable names a file that
 * exists, or a file of its name is in an absolute PATH entry. Only a first guess for `app.hello` at
 * a start with nothing cached (the CLI's own answer replaces it moments later); never a reason to
 * run anything. An agent without a CLI of its own (the Demo) is always there.
 */
const CLI: Record<string, { name: string; env: string }> = {
  claude: { name: 'claude', env: 'SABLE_CLAUDE_BIN' },
  codex: { name: 'codex', env: 'SABLE_CODEX_BIN' },
  opencode: { name: 'opencode', env: 'SABLE_OPENCODE_BIN' },
};

export function cliPresent(id: string, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): boolean {
  const cli = CLI[id];
  if (!cli) return true;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const own = env[cli.env];
  if (own && exists(own)) return true;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  const value = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  for (const dir of trustedPathDirs(value, platform)) for (const ext of exts) if (exists(p.join(dir, cli.name + ext))) return true;
  return false;
}
