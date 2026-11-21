import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { killTree } from './proc';

/**
 * A terminal program run in a console window of its own (Windows), for the CLIs' own dialogs that
 * Sable does not drive: OpenCode's sign-in, Claude Code's limit reset. Sable types nothing into the
 * window; it only learns when the window closes.
 */
export interface ConsoleSpec {
  /** The window's title. */
  title: string;
  /** The program: a name found on PATH or a full path. */
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * An open console window: `closed` resolves when it closes, with the program's exit code when known
 * (`start /wait` hands it on), and rejects when it could not be started; `close` closes it.
 */
export interface ConsoleWindow {
  closed: Promise<number | null | void>;
  close(): void;
}

/** Exit codes of a console program that ended normally or whose window the person closed (Ctrl+C, the window's X). */
export function closedNormally(code: number | null | void): boolean {
  return code === undefined || code === null || code === 0 || code === 0xc000013a || code === -1073741510;
}

export type OpenConsole = (spec: ConsoleSpec) => ConsoleWindow;

/** Plain words go as they are; anything else (a path with spaces, a leading slash) in quotes. */
const PLAIN = /^[\w@+=:,.\\-][\w@+=:,./\\-]*$/;

/**
 * The command line `cmd.exe /d /s /c` runs: `start "<title>" /wait cmd /d /s /c "<bin> <args>"`,
 * the whole of it in one pair of outer quotes that `/s` takes off. The window runs a `cmd /c` of its
 * own around the program, so a batch file (npm's `claude.cmd`) runs like an .exe, a path with spaces
 * holds, and the window closes when the program ends (`start` keeps a batch file's window open with
 * `/k`). A bare name stays unquoted: a batch file found on PATH by a quoted name gets a wrong `%~dp0`,
 * which npm's shims need. It must reach cmd verbatim (`windowsVerbatimArguments`): Node's own quoting
 * would turn the title into `"\"OpenCode login\""`, which `start` takes apart. Refuses what cmd would
 * read as more than text (a quote, `%`, `&`, a pipe or redirection, `^`, a line break), so nothing
 * passed in can change the command.
 *
 * A native program by its full path (the packaged CLI, `…\claude.exe`) is started by `start` itself,
 * without the inner `cmd /c`: its path stays inside one pair of quotes that the outer cmd keeps, so a
 * valid folder name with `&` in it (`R&D`) is only text there (review wave 8, #32). Batch shims keep
 * the inner `cmd /c`, where such a path is still refused.
 */
export function consoleCommandLine(spec: Pick<ConsoleSpec, 'title' | 'bin' | 'args'>): string {
  const native = isNativePath(spec.bin);
  for (const part of [spec.title, ...(native ? [] : [spec.bin]), ...spec.args]) if (/["%&|<>^\r\n\0]/.test(part)) throw new Error('That command cannot be run in a console window');
  if (native && /["%|<>^\r\n\0]/.test(spec.bin)) throw new Error('That command cannot be run in a console window');
  const word = (s: string) => (PLAIN.test(s) ? s : `"${s}"`);
  const args = spec.args.map((a) => ` ${word(a)}`).join('');
  if (native) return `"start "${spec.title}" /wait "${spec.bin}"${args}"`;
  return `"start "${spec.title}" /wait cmd /d /s /c "${word(spec.bin)}${args}""`;
}

/** A full Windows path to an .exe or .com (not a batch file, not a bare name). */
const isNativePath = (bin: string) => /^(?:[a-z]:\\|\\\\)/i.test(bin) && /\.(?:exe|com)$/i.test(bin);

/**
 * Whether the program can be found before a window is opened: `start` answers a missing one with a
 * message box of the shell and an exit code of 0, so it is looked for first (a full path as it is, a
 * bare name on PATH with PATHEXT, never in the window's own folder).
 */
export function findProgram(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (path.isAbsolute(bin)) return existsSync(bin);
  if (/[\\/]/.test(bin)) return false;
  const exts = /\.[a-z0-9]+$/i.test(bin) ? [''] : (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  return dirs.some((d) => exts.some((x) => existsSync(path.join(d, bin + x))));
}

/** Opens the program in a console window of its own (Windows only). */
export const openConsole: OpenConsole = (spec) => {
  if (!findProgram(spec.bin, spec.env ?? process.env)) throw new Error(`${spec.bin} was not found`);
  const child = spawn('cmd.exe', ['/d', '/s', '/c', consoleCommandLine(spec)], {
    windowsHide: false,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  return { closed, close: () => killTree(child) };
};
