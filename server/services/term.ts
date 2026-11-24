import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { BridgeEvent } from '../../shared/protocol';
import type { App } from '../app';
import { killTree } from '../util/proc';

export const MAX_RUNS = 6;
const FLUSH_MS = 30;
const MAX_OUTPUT = 2 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

type Stream = 'out' | 'err';

interface Run {
  id: string;
  child: ChildProcess;
  emit: (e: BridgeEvent) => void;
  bytes: number;
  capped: boolean;
  /** Raw bytes not yet sent (decoded per flush, see decodeChunk). */
  pending: Record<Stream, Buffer>;
  timers: Record<Stream, NodeJS.Timeout | null>;
  finished: boolean;
  killed: boolean;
  startedAt: number;
}

/** Every live run across all apps in this process (for exit cleanup). */
const live = new Map<string, Run>();

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous: kill trees with spawnSync.
  process.on('exit', () => {
    for (const run of live.values()) killSync(run.child);
  });
}

function killSync(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/**
 * Windows: `taskkill /T` walks the tree from a snapshot, so a shell killed while it is still
 * starting its child can leave that child orphaned. Orphans keep their ParentProcessId, so
 * after a killed run exits we sweep for processes whose parent was that pid (batched).
 */
const sweepQueue = new Map<number, number>(); // pid -> run start (ms)
let sweepTimer: NodeJS.Timeout | null = null;

function sweepScript(entries: [number, number][]): string {
  const filter = entries.map(([pid]) => `ParentProcessId=${pid}`).join(' OR ');
  const since = Math.min(...entries.map(([, t]) => t)) - 1000;
  return (
    `$t=[DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime;` +
    `Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $_.CreationDate -ge $t } | ` +
    `ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId *> $null }`
  );
}

const SWEEP_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

function scheduleSweep(pid: number, startedAt: number) {
  sweepQueue.set(pid, startedAt);
  sweepTimer ??= setTimeout(flushSweep, 150);
}

const pendingSweeps = new Set<Promise<void>>();

function flushSweep() {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  const entries = [...sweepQueue];
  sweepQueue.clear();
  if (!entries.length) return;
  const done = new Promise<void>(resolve => {
    const p = spawn('powershell.exe', [...SWEEP_ARGS, sweepScript(entries)], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    p.once('error', () => resolve());
    p.once('close', () => resolve());
  }).catch(() => {});
  pendingSweeps.add(done);
  void done.then(() => pendingSweeps.delete(done));
}

function killRun(run: Run) {
  run.killed = true;
  if (process.platform === 'win32') killTree(run.child);
  else {
    try {
      // Detached on POSIX, so the negative pid addresses the whole process group.
      process.kill(-run.child.pid!, 'SIGTERM');
    } catch {
      killTree(run.child);
    }
    const t = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        try {
          process.kill(-run.child.pid!, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }, 2000);
    t.unref();
  }
}

/**
 * Windows: PowerShell runs a fixed wrapper and reads the user's command from the environment,
 * so nothing is quoted on the command line and errors point at the user's text only (a prelude
 * in the same script would show up in PowerShell's echoed error lines). UTF-8 in and out; the
 * exit code is the native command's, else 1 when PowerShell reported an error.
 */
const PS_WRAPPER =
  '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp.com 65001 > $null;' +
  '$__sable=$env:SABLE_COMMAND; Remove-Item Env:SABLE_COMMAND; $global:LASTEXITCODE=0; $Error.Clear();' +
  '. ([ScriptBlock]::Create($__sable));' +
  'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($Error.Count) { exit 1 }';

/**
 * Windows PowerShell by its full path: the command runs in the project folder, and a bare
 * `powershell.exe` would be looked up there first, before PATH.
 */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const sys = /^[a-zA-Z]:[\\/]/.test(root) ? root : 'C:\\Windows';
  return path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function shellFor(command: string): { cmd: string; args: string[]; env?: Record<string, string> } {
  if (process.platform === 'win32') {
    // npm, pnpm and yarn resolve to .ps1 shims in PowerShell, which Windows' default policy
    // (Restricted) refuses to load: this process may run them (a machine's group policy still wins).
    return {
      cmd: windowsPowerShell(),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_WRAPPER],
      env: { SABLE_COMMAND: command },
    };
  }
  const sh = process.env.SHELL;
  if (sh && sh.startsWith('/')) return { cmd: sh, args: ['-lc', command] };
  return { cmd: '/bin/sh', args: ['-c', command] };
}

// ── output decoding ──
// Most tools write UTF-8, but Windows console tools (ping, ipconfig, net…) write in the OEM
// code page when their output is a pipe, whatever the console code page says. Each flushed
// chunk is decoded as UTF-8 when it is valid UTF-8, otherwise in the OEM code page.

const OEM_HIGH: Record<number, string> = {
  437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
  850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
};
/** OEM code pages that the WHATWG decoders in Node know by another name. */
const OEM_LABEL: Record<number, string> = { 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };

const utf8 = new TextDecoder('utf-8', { fatal: true });
let legacy: ((b: Buffer) => string) | null = null;

function legacyDecoder(): (b: Buffer) => string {
  if (legacy) return legacy;
  let cp = 850;
  try {
    const r = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    cp = Number(/OEMCP\s+REG_SZ\s+(\d+)/.exec(r.stdout ?? '')?.[1]) || cp;
  } catch {
    /* keep the default */
  }
  const high = OEM_HIGH[cp];
  if (high) {
    legacy = (b) => {
      let s = '';
      for (const byte of b) s += byte < 0x80 ? String.fromCharCode(byte) : high[byte - 0x80];
      return s;
    };
  } else {
    const label = OEM_LABEL[cp] ?? (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : 'windows-1252');
    const dec = new TextDecoder(label);
    legacy = (b) => dec.decode(b);
  }
  return legacy;
}

function decodeChunk(b: Buffer): string {
  try {
    return utf8.decode(b);
  } catch {
    return process.platform === 'win32' ? legacyDecoder()(b) : b.toString('utf8');
  }
}

/** Where a UTF-8 sequence cut off by the end of the buffer starts (or the length if none is). */
function completeUpTo(b: Buffer): number {
  for (let i = b.length - 1; i >= Math.max(0, b.length - 3); i--) {
    const c = b[i];
    if (c < 0x80) return b.length;
    if (c >= 0xc0) {
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
      return b.length - i < need ? i : b.length;
    }
  }
  return b.length;
}

function shellEnv(extra?: Record<string, string>) {
  return { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '0', ...extra };
}

function flush(run: Run, stream: Stream, force = true) {
  const t = run.timers[stream];
  if (t) clearTimeout(t);
  run.timers[stream] = null;
  const buf = run.pending[stream];
  if (!buf.length) return;
  // Hold back a character split across reads, briefly: the next read usually completes it.
  const cut = force ? buf.length : completeUpTo(buf);
  run.pending[stream] = buf.subarray(cut);
  if (cut < buf.length) run.timers[stream] = setTimeout(() => flush(run, stream), FLUSH_MS);
  if (cut === 0) return;
  run.emit({ type: 'term.data', termId: run.id, data: decodeChunk(buf.subarray(0, cut)), stream });
}

function push(run: Run, stream: Stream, chunk: Buffer) {
  if (run.capped) return;
  if (run.bytes + chunk.length > MAX_OUTPUT) {
    const room = MAX_OUTPUT - run.bytes;
    if (room > 0) run.pending[stream] = Buffer.concat([run.pending[stream], chunk.subarray(0, room)]);
    run.bytes = MAX_OUTPUT;
    run.capped = true;
    flush(run, 'out');
    flush(run, 'err');
    run.emit({
      type: 'term.data',
      termId: run.id,
      data: '\r\n[Sable: output exceeded 2 MB; the rest is not shown. The command is still running.]\r\n',
      stream: 'err',
    });
    return;
  }
  run.bytes += chunk.length;
  run.pending[stream] = run.pending[stream].length ? Buffer.concat([run.pending[stream], chunk]) : chunk;
  if (!run.timers[stream]) run.timers[stream] = setTimeout(() => flush(run, stream, false), FLUSH_MS);
}

export function registerTerm(app: App) {
  installExitHook();
  const mine = new Set<string>();

  app.register('term.run', ({ cwd, command }) => {
    if (!command || !command.trim()) throw new Error('No command given');
    if (live.size >= MAX_RUNS) {
      throw new Error(`Too many commands running (limit ${MAX_RUNS}). Stop one before starting another.`);
    }
    const dir = path.resolve(cwd || '.');
    try {
      if (!statSync(dir).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Cannot run in ${dir}: folder not found`);
    }
    const { cmd, args, env } = shellFor(command);
    const child = spawn(cmd, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: shellEnv(env),
    });
    const run: Run = {
      id: randomUUID(),
      child,
      emit: app.emit,
      bytes: 0,
      capped: false,
      pending: { out: EMPTY, err: EMPTY },
      timers: { out: null, err: null },
      finished: false,
      killed: false,
      startedAt: Date.now(),
    };
    live.set(run.id, run);
    mine.add(run.id);

    const finish = (code: number | null) => {
      if (run.finished) return;
      run.finished = true;
      flush(run, 'out');
      flush(run, 'err');
      live.delete(run.id);
      mine.delete(run.id);
      if (run.killed && process.platform === 'win32' && child.pid !== undefined) scheduleSweep(child.pid, run.startedAt);
      app.emit({ type: 'term.exit', termId: run.id, code });
    };

    child.stdout!.on('data', (d: Buffer) => push(run, 'out', d));
    child.stderr!.on('data', (d: Buffer) => push(run, 'err', d));
    child.on('error', (err) => {
      if (!run.capped) run.pending.err = Buffer.concat([run.pending.err, Buffer.from(`Could not start ${cmd}: ${err.message}\r\n`)]);
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // Grandchildren can keep the pipes open after the shell exits; do not wait on them forever.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 1500).unref();
    });
    return { termId: run.id };
  });

  app.register('term.kill', ({ termId }) => {
    const run = live.get(termId);
    if (!run) return { ok: false };
    killRun(run);
    return { ok: true };
  });

  // Stop this app's runs (and sweep their orphans) before the app goes away.
  app.onDispose(async () => {
    const runs = [...mine].map((id) => live.get(id)).filter((r): r is Run => !!r);
    for (const run of runs) {
      run.killed = true;
      if (process.platform === 'win32' && run.child.pid !== undefined) {
        killTree(run.child);
        live.delete(run.id); // The asynchronous taskkill owns this tree, including across shell exit.
        sweepQueue.set(run.child.pid, run.startedAt);
      } else killSync(run.child);
    }
    flushSweep();
    await Promise.all([...pendingSweeps]);
  });
}
