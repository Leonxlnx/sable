import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { trustedPathDirs } from './which';

const resolved = new Map<string, string | null>();

/** Finds a command on PATH the way cmd.exe would (PATHEXT order). Windows only; cached. */
function whichWin(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = `${cmd}\0${env.PATH ?? env.Path ?? ''}`;
  if (resolved.has(key)) return resolved.get(key)!;
  let found: string | null = null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) found = existsSync(cmd) ? cmd : null;
  else {
    const exts = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    // Absolute entries only: a relative one ("." or "bin") would read against whatever folder the CLI starts in.
    const dirs = trustedPathDirs(env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? '', 'win32');
    outer: for (const dir of dirs)
      for (const ext of exts) {
        const p = path.join(dir, cmd + ext.toLowerCase());
        if (existsSync(p)) {
          found = p;
          break outer;
        }
      }
  }
  resolved.set(key, found);
  return found;
}

/**
 * How to start a CLI without `shell: true` plus an argument array (Node's DEP0190: the args
 * would be joined unescaped). Native executables run directly. On Windows an npm shim
 * (.cmd/.bat) can only run through cmd.exe, so it gets one command string with each argument
 * quoted; a command that is not on PATH also goes through the shell, so a missing CLI still
 * reports "not recognized" the usual way.
 */
export function cliCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { file: cmd, args, shell: false };
  const exe = whichWin(cmd, env);
  if (exe && /\.(exe|com)$/i.test(exe)) return { file: exe, args, shell: false };
  const head = exe ? `"${exe}"` : cmd;
  return { file: [head, ...args.map(quoteArg)].join(' '), args: [], shell: true };
}

/** `spawn` for a CLI by name (see `cliCommand`). */
export function spawnCli(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const c = cliCommand(cmd, args, opts.env);
  return spawn(c.file, c.args, { windowsHide: true, ...opts, shell: c.shell });
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** Runs a CLI to completion. npm shims (.cmd) on Windows run through cmd.exe (see `cliCommand`). */
export function runCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string; maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const max = opts.maxBytes ?? 8_000_000;
    let child: ChildProcess;
    try {
      child = spawnCli(cmd, args, { cwd: opts.cwd, env: opts.env });
    } catch {
      resolve({ code: null, stdout, stderr, missing: true });
      return;
    }
    const finish = (code: number | null, missing = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, missing });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, opts.timeoutMs ?? 15_000);
    child.stdout?.on('data', (d) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < max) stderr += d.toString();
    });
    child.on('error', () => finish(null, true));
    child.on('close', (code) => {
      const missing = code !== 0 && /is not recognized|not found|ENOENT/i.test(stderr) && !stdout;
      finish(code, missing);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Quotes one argument for a cmd.exe command line (plain words stay as they are). */
export function quoteArg(arg: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Kills a process and its children (shell-spawned commands leave grandchildren behind otherwise). */
export function killTree(child: ChildProcess | undefined) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill();
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}
