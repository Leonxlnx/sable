import { spawn } from 'node:child_process';
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

/** An open console window: `closed` resolves when it closes (or fails to open); `close` closes it. */
export interface ConsoleWindow {
  closed: Promise<void>;
  close(): void;
}

export type OpenConsole = (spec: ConsoleSpec) => ConsoleWindow;

/** Plain words go as they are; anything else (a path with spaces, a leading slash) in quotes. */
const PLAIN = /^[\w@+=:,.\\-][\w@+=:,./\\-]*$/;

/**
 * The command line `cmd.exe /d /s /c` runs: `start "<title>" /wait <bin> <args>`, the whole of it in
 * one pair of outer quotes that `/s` takes off. It must reach cmd verbatim (`windowsVerbatimArguments`):
 * Node's own quoting would turn the title into `"\"OpenCode login\""`, which `start` takes apart.
 * Refuses what cmd would read as more than text (a quote, `%`, a line break), so nothing passed in
 * can change the command.
 */
export function consoleCommandLine(spec: Pick<ConsoleSpec, 'title' | 'bin' | 'args'>): string {
  for (const part of [spec.title, spec.bin, ...spec.args]) if (/["%\r\n\0]/.test(part)) throw new Error('That command cannot be run in a console window');
  const word = (s: string) => (PLAIN.test(s) ? s : `"${s}"`);
  return `"start "${spec.title}" /wait ${word(spec.bin)}${spec.args.map((a) => ` ${word(a)}`).join('')}"`;
}

/** Opens the program in a console window of its own (Windows only). */
export const openConsole: OpenConsole = (spec) => {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', consoleCommandLine(spec)], {
    windowsHide: false,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  return { closed, close: () => killTree(child) };
};
