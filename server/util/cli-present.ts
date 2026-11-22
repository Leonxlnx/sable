import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
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

/** Every file that would be the agent's CLI: its override, then its name in each absolute PATH entry. */
function candidates(cli: { name: string; env: string }, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  const value = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const own = env[cli.env];
  return [...(own ? [own] : []), ...trustedPathDirs(value, platform).flatMap((dir) => exts.map((ext) => p.join(dir, cli.name + ext)))];
}

export function cliPresent(id: string, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): boolean {
  const cli = CLI[id];
  if (!cli) return true;
  const exists = o.exists ?? existsSync;
  return candidates(cli, o.env ?? process.env, o.platform ?? process.platform).some((f) => exists(f));
}

/**
 * The same look without holding the thread, for `app.hello`: a PATH entry on a drive that does not
 * answer (a network drive that is gone) can take seconds per file, and the bridge has one thread
 * for every window and phone. Undefined when it is not known within `ms`.
 */
export function cliPresentSoon(
  id: string,
  ms: number,
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (file: string) => Promise<boolean> } = {},
): Promise<boolean | undefined> {
  const cli = CLI[id];
  if (!cli) return Promise.resolve(true);
  const exists = o.exists ?? ((f: string) => access(f).then(() => true, () => false));
  const files = candidates(cli, o.env ?? process.env, o.platform ?? process.platform);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    let left = files.length;
    if (!left) return void (clearTimeout(t), resolve(false));
    for (const f of files) {
      void exists(f).then((yes) => {
        left--;
        if (!yes && left) return;
        clearTimeout(t);
        resolve(yes);
      });
    }
  });
}
