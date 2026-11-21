import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A desktop app started from Finder, the Dock or Spotlight does not get the PATH of the person's
 * terminal: launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin`, so `codex`, `git`, `node`, Homebrew
 * and anything installed by npm, bun or volta would all be "not found". The shell that the person
 * actually uses knows the real PATH (their .zprofile, .zshrc, Homebrew's shellenv, nvm ...), so it
 * is asked once, at start-up, and the answer is merged into this process's PATH. The agents and
 * the terminal tab inherit it from there.
 */

const START = '__SABLE_PATH_START__';
const END = '__SABLE_PATH_END__';
/** PATH entries are separated by a colon: this only ever runs where the system is POSIX. */
const DELIM = ':';

/** Where command line tools usually live on a Mac, tried after what the shell reported. */
export function wellKnownDirs(home: string = os.homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.claude', 'local'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, 'bin'),
  ];
}

/** The PATH value printed between the markers, or undefined (the shell printed other things around it: banners, motd, plugin output). */
export function parseLoginPath(stdout: string): string | undefined {
  const a = stdout.lastIndexOf(START);
  if (a < 0) return undefined;
  const b = stdout.indexOf(END, a);
  if (b < 0) return undefined;
  const value = stdout.slice(a + START.length, b).trim();
  return value && !value.includes('\n') ? value : undefined;
}

/**
 * `first` stays in front; entries of `rest` follow unless already there. Empty entries and
 * duplicates go, the order of what remains is kept.
 */
export function mergePath(first: string, ...rest: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [first, ...rest]) {
    for (const entry of (list ?? '').split(DELIM)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(DELIM);
}

/**
 * Asks the person's login shell for its PATH (interactive, so .zshrc counts as it does in a
 * terminal window). Resolves undefined when it cannot be had within `timeoutMs`: a slow or broken
 * shell profile must never keep the app from starting.
 */
export function askLoginShell(shell: string, timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      // `printenv PATH` rather than `echo $PATH`: fish keeps PATH as a list.
      const script = `printf '%s' '${START}'; printenv PATH; printf '%s' '${END}'`;
      const child = execFile(
        shell,
        ['-ilc', script],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
          // oh-my-zsh and friends would otherwise stop to ask about updates.
          env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false', TERM: process.env.TERM ?? 'xterm-256color' },
        },
        (err, stdout) => resolve(err && !stdout ? undefined : parseLoginPath(String(stdout))),
      );
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Puts the login shell's PATH (and the usual tool folders that exist) into `process.env.PATH`.
 * Returns the PATH that results. Does nothing on Windows, where apps get the user's PATH as it is.
 */
export async function fixPathFromLoginShell(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; ask?: typeof askLoginShell; exists?: (p: string) => boolean; home?: string } = {}): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return undefined;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const shell = env.SHELL && path.posix.isAbsolute(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  const ask = opts.ask ?? askLoginShell;
  const fromShell = exists(shell) ? await ask(shell) : undefined;
  const known = wellKnownDirs(opts.home).filter((d) => exists(d));
  const merged = mergePath(fromShell ?? '', env.PATH, known.join(DELIM));
  if (merged) env.PATH = merged;
  return env.PATH;
}
