/**
 * "Use a reset in Claude Code": Sable opens the account's own agent in a console window straight
 * into its reset dialog and reads the limits again when the window closes. No test opens a window:
 * the App gets an opener that records what it would start. A fake `claude` is on PATH, so nothing
 * here could reach a real Claude Code.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent, type NoticeItem, type RateLimit, type ResetRun, type TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { clearedWindows, fullWindows, ResetConsoles, type ResetConsoleHost, type ResetReading } from '../server/core/reset-console';
import { ClaudeProvider, resetLine } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext } from '../server/providers/types';
import { registerUsage } from '../server/services/usage';
import { consoleCommandLine, findProgram, type ConsoleSpec } from '../server/util/console';

const H = 3_600_000;
const apps: App[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name = 'sable-reset-') => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

async function until(pred: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An opener that opens nothing: it records each window and closes it when the test says. */
function fakeConsoles() {
  const opened: { spec: ConsoleSpec; close: () => void; closedByUs: boolean }[] = [];
  const open = (spec: ConsoleSpec) => {
    let done!: () => void;
    const closed = new Promise<void>((r) => (done = r));
    const w = { spec, close: done, closedByUs: false };
    opened.push(w);
    return {
      closed,
      close: () => {
        w.closedByUs = true;
        done();
      },
    };
  };
  return { opened, open };
}

// ───────────────────────────── the command line ─────────────────────────────

describe('the console command line', () => {
  // Checked by hand on Windows with `start /b` and stand-ins (no window, no Claude Code session): an
  // .exe in a folder with spaces, a batch file found on PATH by name (its %~dp0 intact) and one by a
  // path with spaces each got `/limit-reset` as one argument, the account's CLAUDE_CONFIG_DIR and the folder.
  it('starts the program with start /wait in a cmd /c of its own, every argument as given, in one verbatim line', () => {
    // A native program by its full path is started by `start` itself, its path in quotes the outer cmd keeps.
    expect(consoleCommandLine({ title: 'Claude Code reset', bin: 'C:\\Program Files\\Sable\\resources\\claude\\claude.exe', args: ['/limit-reset'] })).toBe(
      '"start "Claude Code reset" /wait "C:\\Program Files\\Sable\\resources\\claude\\claude.exe" "/limit-reset""',
    );
    // A batch shim by its full path keeps the inner cmd /c.
    expect(consoleCommandLine({ title: 't', bin: 'C:\\npm\\claude.cmd', args: ['/limit-reset'] })).toBe('"start "t" /wait cmd /d /s /c "C:\\npm\\claude.cmd "/limit-reset"""');
    expect(consoleCommandLine({ title: 'Claude Code reset (Work)', bin: 'claude', args: ['/limit-reset'] })).toBe('"start "Claude Code reset (Work)" /wait cmd /d /s /c "claude "/limit-reset"""');
    // OpenCode's sign-in through the same helper.
    expect(consoleCommandLine({ title: 'OpenCode login', bin: 'opencode', args: ['auth', 'login'] })).toBe('"start "OpenCode login" /wait cmd /d /s /c "opencode auth login""');
  });

  it('refuses what cmd would read as more than text', () => {
    for (const bad of ['a"b', '%PATH%', 'a\r\nb', 'a & calc', 'a | b', 'a > f', 'a ^ b'])
      expect(() => consoleCommandLine({ title: 'x', bin: 'claude', args: [bad] })).toThrow();
    expect(() => consoleCommandLine({ title: 'say "hi"', bin: 'claude', args: [] })).toThrow();
    // Still refused in a native path: what cmd would expand or end the quotes with.
    for (const bad of ['C:\\%TEMP%\\claude.exe', 'C:\\a"b\\claude.exe', 'C:\\a^b\\claude.exe']) expect(() => consoleCommandLine({ title: 'x', bin: bad, args: [] })).toThrow();
    // A batch shim under a folder with `&` cannot be started safely through cmd /c: refused.
    expect(() => consoleCommandLine({ title: 'x', bin: 'C:\\R&D\\claude.cmd', args: [] })).toThrow();
  });

  // Checked by hand on Windows with `start /b` (no window): node.exe linked into `…\R&D\` ran with its
  // argument from this line, the `&` taken as text (review wave 8, #32).
  it('starts a native program under a folder with & in its name (review wave 8, #32)', () => {
    expect(consoleCommandLine({ title: 'Claude Code reset', bin: 'D:\\R&D\\Sable\\resources\\claude\\claude.exe', args: ['/limit-reset'] })).toBe(
      '"start "Claude Code reset" /wait "D:\\R&D\\Sable\\resources\\claude\\claude.exe" "/limit-reset""',
    );
  });

  it('looks for the program before a window opens (start answers a missing one with a message box)', () => {
    const dir = temp('sable-find-');
    writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\n');
    expect(findProgram(path.join(dir, 'tool.cmd'))).toBe(true);
    expect(findProgram(path.join(dir, 'missing.exe'))).toBe(false);
    expect(findProgram('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' })).toBe(true);
    expect(findProgram('missing', { PATH: dir, PATHEXT: '.EXE;.CMD' })).toBe(false);
    // A relative PATH entry (the window's own folder) is never searched.
    expect(findProgram('tool', { PATH: '.', PATHEXT: '.CMD' })).toBe(false);
  });
});

describe("an account's terminal command (review wave 8, #19)", () => {
  it('quotes the CLI and the config folder for the shell', () => {
    expect(resetLine('claude', undefined, 'linux')).toBe('claude "/limit-reset"');
    expect(resetLine('/opt/Sable App/claude', "/home/me/it's/work", 'darwin')).toBe(`CLAUDE_CONFIG_DIR='/home/me/it'\\''s/work' '/opt/Sable App/claude' "/limit-reset"`);
    expect(resetLine('C:\\Program Files\\Sable\\claude.exe', 'C:\\Users\\me\\.sable\\accounts\\claude\\w1', 'win32')).toBe(
      'set "CLAUDE_CONFIG_DIR=C:\\Users\\me\\.sable\\accounts\\claude\\w1" && "C:\\Program Files\\Sable\\claude.exe" "/limit-reset"',
    );
  });
});

describe('which windows a reset cleared', () => {
  const now = Date.now();
  const w = (id: string, percent: number, resetIn = H): RateLimit => ({ id, label: id, percent, resetsAt: now + resetIn });
  it('counts only windows that were full and now have room', () => {
    const before = [w('five_hour', 100), w('seven_day', 100), w('seven_day_fable', 40)];
    expect(clearedWindows(before, [w('five_hour', 0), w('seven_day', 100), w('seven_day_fable', 40)], now).map((l) => l.id)).toEqual(['five_hour']);
    expect(clearedWindows(before, [w('five_hour', 100), w('seven_day', 100)], now)).toEqual([]);
    // A window the new read leaves out says nothing.
    expect(clearedWindows(before, [w('seven_day_fable', 0)], now)).toEqual([]);
    // A window whose reset already passed was not holding anything.
    expect(fullWindows([w('five_hour', 100, -1000)], now)).toEqual([]);
  });
});

// ───────────────────────────── Claude Code's command ─────────────────────────────

function fakeClaudeOnPath(): string {
  const bin = temp('sable-fake-claude-');
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'claude.cmd'), ['@echo off', 'if "%1"=="--version" (echo 9.9.9& exit /b 0)', 'if "%1"=="auth" (echo {"loggedIn":false}& exit /b 0)', 'exit /b 2', ''].join('\r\n'));
  } else {
    const file = path.join(bin, 'claude');
    writeFileSync(file, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi', 'if [ "$1" = "auth" ]; then echo \'{"loggedIn":false}\'; exit 0; fi', 'exit 2', ''].join('\n'));
    chmodSync(file, 0o755);
  }
  return bin;
}

describe("Claude Code's reset dialog", () => {
  it('opens the account’s Claude Code with /limit-reset, its config folder, in a folder of Sable’s own', { timeout: 30_000 }, async () => {
    const before = process.env.PATH;
    const realBin = process.env.SABLE_CLAUDE_BIN;
    // A run started from inside Sable inherits the desktop's SABLE_CLAUDE_BIN: the fake on PATH must win.
    delete process.env.SABLE_CLAUDE_BIN;
    process.env.PATH = `${fakeClaudeOnPath()}${path.delimiter}${before}`;
    try {
      const home = temp();
      const consoles = fakeConsoles();
      const app = new App({ home, providers: [(ctx) => new ClaudeProvider(ctx)], quiet: true, userHome: temp(), openConsole: consoles.open });
      apps.push(app);
      const { account } = await app.call('account.add', { provider: 'claude', label: 'Work' });
      const hello = await app.call('app.hello', {});
      expect(hello.providers.find((p) => p.id === 'claude')?.limitReset).toEqual({ via: 'console', command: 'claude "/limit-reset"' });
      // Each account's own terminal command names its own config folder (review wave 8, #19).
      const accs = hello.providers.find((p) => p.id === 'claude')?.accounts ?? [];
      expect(accs.find((a) => a.id === DEFAULT_ACCOUNT)?.resetCommand).toBe('claude "/limit-reset"');
      const work = accs.find((a) => a.id === account.id)?.resetCommand;
      expect(work).toContain(account.dir!);
      expect(work).toBe(process.platform === 'win32' ? `set "CLAUDE_CONFIG_DIR=${account.dir}" && claude "/limit-reset"` : `CLAUDE_CONFIG_DIR=${account.dir} claude "/limit-reset"`);

      // The account is at its weekly limit (as a turn's rate-limit event would say).
      const p = (app as unknown as { provider: (id: string, acc: string) => ClaudeProvider }).provider('claude', account.id);
      p.ctx.emit({ type: 'limits.updated', provider: 'claude', limits: [{ id: 'seven_day', label: 'Weekly', percent: 100, resetsAt: Date.now() + 48 * H, windowMins: 10_080 }] });

      expect(await app.call('limit.resetInAgent', { provider: 'claude', accountId: account.id })).toEqual({ ok: true });
      expect(consoles.opened).toHaveLength(1);
      const { spec } = consoles.opened[0];
      expect(spec.bin).toBe('claude');
      expect(spec.args).toEqual(['/limit-reset']);
      expect(spec.title).toBe('Claude Code reset (Work)');
      expect(spec.env?.CLAUDE_CONFIG_DIR).toBe(account.dir);
      expect(spec.cwd).toBe(path.join(home, 'limit-reset'));
      expect(existsSync(spec.cwd!)).toBe(true);
      expect(consoleCommandLine(spec)).toBe('"start "Claude Code reset (Work)" /wait cmd /d /s /c "claude "/limit-reset"""');

      // The packaged app's own binary, when the desktop shell names it.
      process.env.SABLE_CLAUDE_BIN = 'C:\\Sable\\claude.exe';
      expect(p.limitResetCommand().bin).toBe('C:\\Sable\\claude.exe');
      // The built-in account uses the person's own setup (no config folder of Sable's).
      const own = (app as unknown as { provider: (id: string, acc: string) => ClaudeProvider }).provider('claude', DEFAULT_ACCOUNT);
      expect(own.limitResetCommand().env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
    } finally {
      process.env.PATH = before;
      if (realBin !== undefined) process.env.SABLE_CLAUDE_BIN = realBin;
      else delete process.env.SABLE_CLAUDE_BIN;
    }
  });
});

// ───────────────────────────── the whole flow, with the Demo ─────────────────────────────

/** The Demo with a reset dialog of its own (as Claude Code has) and fixed limits for the built-in account. */
class DialogDemo extends DemoProvider {
  static fixed = new Map<string, RateLimit[]>();
  static reads = 0;
  constructor(private c: ProviderContext) {
    super(c, { speed: 0 });
  }
  async limits(): Promise<RateLimit[]> {
    DialogDemo.reads++;
    const own = DialogDemo.fixed.get(this.c.account?.id ?? DEFAULT_ACCOUNT);
    if (!own) return super.limits();
    this.c.emit({ type: 'limits.updated', provider: 'demo', limits: own, meta: { planLimits: true } });
    return own;
  }
  limitResetCommand() {
    return { bin: 'demo-cli', args: ['/limit-reset'], env: { DEMO_ACCOUNT: this.c.account?.id ?? DEFAULT_ACCOUNT }, line: 'demo "/limit-reset"' };
  }
}

const fiveIn = (percent: number): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: Date.now() + 2 * H, windowMins: 300 });
const weekIn = (percent: number, hours: number): RateLimit => ({ id: 'seven_day', label: 'Weekly · all models', percent, resetsAt: Date.now() + hours * H, windowMins: 10_080 });
const texts = (items: TimelineItem[]) => items.filter((i) => i.type === 'text');

async function demoAt() {
  DialogDemo.fixed.clear();
  DialogDemo.fixed.set(DEFAULT_ACCOUNT, [fiveIn(100), weekIn(100, 30)]);
  const home = temp();
  const consoles = fakeConsoles();
  const app = new App({ home, providers: [(ctx) => new DialogDemo(ctx)], quiet: true, userHome: temp(), openConsole: consoles.open, resetSettleMs: 30 });
  registerUsage(app, { sources: () => [] });
  apps.push(app);
  const runs: (ResetRun | null)[] = [];
  app.subscribe((e: BridgeEvent) => {
    if (e.type === 'limit.resetRun') runs.push(e.run && { ...e.run });
  });
  await app.call('provider.limits', { provider: 'demo' });
  // A Demo account at its cap whose windows would reset only in an hour.
  const { account } = await app.call('account.add', { provider: 'demo', label: 'Studio' });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: 'studio@example.dev', plan: 'Max', limits: 'cap' }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('demo.limitResetIn', { accountId: account.id, ms: H });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return { app, home, consoles, runs, account };
}

/** What a reset confirmed in the dialog does on the plan's side: the account's windows start over now. */
const resetOnTheServer = (dir: string) => writeFileSync(path.join(dir, 'demo-resets.json'), JSON.stringify({ used: 0, at: Date.now() }));

describe('a reset in the agent’s own dialog, in the App', () => {
  it('re-reads the limits when the window closes and carries on the chat that waited for the reset', { timeout: 20_000 }, async () => {
    const { app, home, consoles, runs, account } = await demoAt();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.items.some((i) => i.type === 'notice' && !!i.limit?.provider), 'limit notice');
    const hit = rt.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.limit)!;
    expect(await app.call('spare.atReset', { sessionId: rt.id })).toMatchObject({ ok: true, spare: { reason: 'reset', accountId: account.id } });
    expect(rt.meta.spare!.at!).toBeGreaterThan(Date.now() + H / 2);

    expect(await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id })).toEqual({ ok: true });
    expect(consoles.opened).toHaveLength(1);
    expect(consoles.opened[0].spec).toMatchObject({ bin: 'demo-cli', args: ['/limit-reset'], env: { DEMO_ACCOUNT: account.id } });
    expect(runs.at(-1)?.state).toBe('open');
    // One at a time per account.
    expect(await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id })).toMatchObject({ ok: false });
    expect(consoles.opened).toHaveLength(1);
    // Nothing went out while the window was open.
    await new Promise((r) => setTimeout(r, 100));
    expect(texts(rt.items)).toHaveLength(0);

    // The person confirms in the window and it closes.
    resetOnTheServer(account.dir!);
    consoles.opened[0].close();
    await until(() => runs.at(-1)?.state === 'cleared', 'cleared');
    expect(runs.map((r) => r?.state)).toEqual(['open', 'reading', 'cleared']);
    expect(runs.at(-1)?.cleared?.length).toBeGreaterThan(0);
    // The chat that waited goes on as at a reset by time: the refused message, on the same account.
    await until(() => texts(rt.items).length === 1 && rt.meta.status === 'idle', 'continued after the reset');
    expect(rt.meta.spare).toBeNull();
    expect(rt.meta.accountId).toBe(account.id);
    expect(rt.get<NoticeItem>(hit.id)!.limit).toMatchObject({ continuedWith: account.id, atReset: true });
    expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(1);
    // Sable never typed into the window or closed it.
    expect(consoles.opened[0].closedByUs).toBe(false);
  });

  it('says so when nothing cleared, and wakes nothing', { timeout: 20_000 }, async () => {
    const { app, home, consoles, runs, account } = await demoAt();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.items.some((i) => i.type === 'notice' && !!i.limit?.provider), 'limit notice');
    await app.call('spare.atReset', { sessionId: rt.id });
    const waitAt = rt.meta.spare!.at;

    await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id });
    const reads = DialogDemo.reads;
    consoles.opened[0].close();
    await until(() => runs.at(-1)?.state === 'unchanged', 'unchanged');
    expect(runs.at(-1)?.message).toBeUndefined();
    // Read twice: the plan's answer may lag a moment behind the dialog.
    expect(DialogDemo.reads - reads).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(texts(rt.items)).toHaveLength(0);
    expect(rt.meta.spare).toMatchObject({ reason: 'reset', at: waitAt });
    // A new attempt may start.
    expect(await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id })).toEqual({ ok: true });
  });

  it('Cancel closes the window, reads the limits all the same, and leaves no line behind', { timeout: 20_000 }, async () => {
    const { app, consoles, runs, account } = await demoAt();
    await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id });
    expect(await app.call('limit.resetCancel', { provider: 'demo', accountId: account.id })).toEqual({ ok: true });
    expect(consoles.opened[0].closedByUs).toBe(true);
    await until(() => runs.at(-1) === null, 'run cleared');
    expect(runs.map((r) => r?.state ?? null)).toEqual(['open', 'reading', null]);
    expect(await app.call('limit.resetCancel', { provider: 'demo', accountId: account.id })).toEqual({ ok: false });
  });

  it('is refused while nothing is at a limit, and for an agent without a dialog', { timeout: 20_000 }, async () => {
    const { app, consoles } = await demoAt();
    const { account } = await app.call('account.add', { provider: 'demo', label: 'Fresh' });
    writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: 'fresh@example.dev', plan: 'Max', limits: 'light' }));
    await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
    await app.call('provider.limits', { provider: 'demo', accountId: account.id });
    expect(await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id })).toEqual({ ok: false, error: 'Nothing is at a limit right now' });
    expect(consoles.opened).toHaveLength(0);

    const plain = new App({ home: temp(), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: temp(), openConsole: consoles.open });
    apps.push(plain);
    expect(await plain.call('limit.resetInAgent', { provider: 'demo' })).toMatchObject({ ok: false });
    expect((await plain.call('app.hello', {})).providers.find((p) => p.id === 'demo')?.limitReset).toBeUndefined();
    expect(consoles.opened).toHaveLength(0);
  });
});

// ───────────────────────────── review wave 8 ─────────────────────────────

/** The controller alone, with a host whose every answer the test sets. */
function controller(over: Partial<ResetConsoleHost> = {}) {
  const consoles = fakeConsoles();
  const runs: (ResetRun | null)[] = [];
  const cleared: string[][] = [];
  const now = Date.now();
  const full: RateLimit[] = [{ id: 'five_hour', label: '5-hour limit', percent: 100, resetsAt: now + 2 * H }];
  const reads: (() => Promise<ResetReading>)[] = [];
  let readCount = 0;
  const host: ResetConsoleHost = {
    open: consoles.open,
    command: () => ({ bin: 'demo-cli', args: ['/limit-reset'], env: {} }),
    cwd: () => tmpdir(),
    title: () => 'Reset',
    known: () => ({ limits: full, signIn: 0 }),
    read: () => {
      readCount++;
      const next = reads.shift();
      return next ? next() : Promise.resolve({ limits: full, fresh: true, signIn: 0 });
    },
    cleared: (_p, _a, w) => cleared.push(w.map((l) => l.id)),
    emit: (_p, _a, run) => runs.push(run && { ...run }),
    log: () => {},
    settleMs: 5,
    ...over,
  };
  const c = new ResetConsoles(host);
  return { c, consoles, runs, cleared, reads, full, readCount: () => readCount };
}

const room = (): RateLimit[] => [{ id: 'five_hour', label: '5-hour limit', percent: 3, resetsAt: Date.now() + 5 * H }];

describe('a reset: only a fresh reading after the dialog counts (review wave 8, #17)', () => {
  it('a throttled read that hands back the old rows is read again, and the fresh one clears', async () => {
    const h = controller();
    h.reads.push(() => Promise.resolve({ limits: h.full, fresh: false, signIn: 0 }), () => Promise.resolve({ limits: room(), fresh: true, signIn: 0 }));
    expect(await h.c.start('claude', 'w')).toEqual({ ok: true });
    h.consoles.opened[0].close();
    await until(() => h.runs.at(-1)?.state === 'cleared', 'cleared');
    expect(h.cleared).toEqual([['five_hour']]);
  });

  it('no fresh reading at all: "could not be read", nothing wakes', async () => {
    const h = controller();
    for (let i = 0; i < 3; i++) h.reads.push(() => Promise.resolve({ limits: room(), fresh: false, signIn: 0 }));
    await h.c.start('claude', 'w');
    h.consoles.opened[0].close();
    await until(() => h.runs.at(-1)?.state === 'unchanged', 'unchanged');
    expect(h.runs.at(-1)?.message).toBe('The limits could not be read');
    expect(h.cleared).toEqual([]);
    expect(h.readCount()).toBe(3);
  });

  it('a reading under another sign-in clears nothing', async () => {
    const h = controller();
    h.reads.push(() => Promise.resolve({ limits: room(), fresh: true, signIn: 1 }));
    await h.c.start('claude', 'w');
    h.consoles.opened[0].close();
    await until(() => h.runs.at(-1)?.state === 'unchanged', 'unchanged');
    expect(h.cleared).toEqual([]);
  });

  it("Claude Code's probe goes past its once-a-minute throttle for a fresh reading", async () => {
    const p = new ClaudeProvider({ emit: () => {}, log: () => {} } as unknown as ProviderContext);
    const anyP = p as unknown as { limitsProbeAt: number; limitsCache: RateLimit[]; baseOptions: () => never };
    anyP.limitsProbeAt = Date.now();
    anyP.limitsCache = [{ id: 'five_hour', label: '5-hour limit', percent: 100 }];
    // Throttled: the last known rows, no process.
    let probed = false;
    anyP.baseOptions = () => {
      probed = true;
      throw new Error('no process in tests');
    };
    expect(await p.limits(true)).toEqual(anyP.limitsCache);
    expect(probed).toBe(false);
    // Fresh: it tries (here it fails at once, before any process starts).
    await p.limits('fresh').catch(() => undefined);
    expect(probed).toBe(true);
  });
});

describe('a reset: Cancel, closing Sable and a window that does not close (review wave 8, #20)', () => {
  it('a known reset wrapper gets its minimum lifetime and its folder stays reserved through exit', async () => {
    vi.useFakeTimers();
    let exit!: () => void;
    let asked = 0;
    const opened = () => ({ pid: 1234, closed: new Promise<void>(resolve => { exit = resolve; }), close: () => { asked++; } });
    const first = controller({ open: opened, closeGraceMs: 20 });
    const next = controller({ open: opened });
    try {
      expect(await first.c.start('claude', 'w')).toEqual({ ok: true });
      first.c.cancel('claude', 'w');
      const waiting = next.c.start('claude', 'w');
      let ready = false;
      void waiting.then(() => { ready = true; });
      await vi.advanceTimersByTimeAsync(2999);
      expect(asked).toBe(0);
      await vi.advanceTimersByTimeAsync(250);
      expect(asked).toBe(1);
      expect(ready).toBe(false);
      exit();
      await vi.advanceTimersByTimeAsync(250);
      expect(await waiting).toEqual({ ok: true });
      exit();
    } finally {
      first.c.dispose();
      next.c.dispose();
      vi.useRealTimers();
    }
  });

  it('Cancel while the limits are read first opens no window', async () => {
    let release!: (r: ResetReading) => void;
    const h = controller({ known: () => ({ limits: [], signIn: 0 }), read: () => new Promise((r) => (release = r)) });
    const started = h.c.start('claude', 'w');
    expect(h.c.cancel('claude', 'w')).toBe(true);
    release({ limits: h.full, fresh: true, signIn: 0 });
    expect(await started).toEqual({ ok: false });
    expect(h.consoles.opened).toHaveLength(0);
    // Free for a new attempt.
    expect(h.c.current('claude', 'w')).toBeUndefined();
  });

  it('Sable closing while the limits are read opens no window either', async () => {
    let release!: (r: ResetReading) => void;
    const h = controller({ known: () => ({ limits: [], signIn: 0 }), read: () => new Promise((r) => (release = r)) });
    const started = h.c.start('claude', 'w');
    h.c.dispose();
    release({ limits: h.full, fresh: true, signIn: 0 });
    expect(await started).toEqual({ ok: false });
    expect(h.consoles.opened).toHaveLength(0);
  });

  it('a window open too long that does not close when asked is given up, and the account is free again', async () => {
    const stuck = { closeAsked: 0 };
    const h = controller({
      maxOpenMs: 10,
      closeGraceMs: 20,
      open: () => ({ closed: new Promise<void>(() => {}), close: () => void stuck.closeAsked++ }),
    });
    await h.c.start('claude', 'w');
    await until(() => h.runs.at(-1)?.state === 'failed', 'failed');
    expect(stuck.closeAsked).toBe(1);
    expect(h.runs.at(-1)?.message).toBe('Claude Code did not close');
    expect(h.c.current('claude', 'w')).toBeUndefined();
    expect(await h.c.start('claude', 'w')).toEqual({ ok: true });
  });

  it('a program that ended with an error says so, after the limits are read', async () => {
    const h = controller({ open: () => ({ closed: Promise.resolve(1), close: () => {} }) });
    await h.c.start('claude', 'w');
    await until(() => h.runs.at(-1)?.state === 'failed', 'failed');
    expect(h.runs.at(-1)?.message).toBe('Claude Code ended with an error');
    expect(h.readCount()).toBeGreaterThan(0);
    // The person closing the window (Ctrl+C, its X) is not an error.
    const g = controller({ open: () => ({ closed: Promise.resolve(0xc000013a), close: () => {} }) });
    await g.c.start('claude', 'w');
    await until(() => g.runs.at(-1)?.state === 'unchanged', 'unchanged');
  });
});

describe('a reset that clears one window wakes only what that window held (review wave 8, #18)', () => {
  for (const known of [true, false])
    it(`a weekly window still full${known ? '' : ' with no reset known'} keeps the chat waiting`, { timeout: 20_000 }, async () => {
      const { app, home, consoles, runs, account } = await demoAt();
      const week: RateLimit = known ? weekIn(100, 30) : { id: 'seven_day', label: 'Weekly · all models', percent: 100, windowMins: 10_080 };
      DialogDemo.fixed.set(account.id, [fiveIn(100), week]);
      await app.call('provider.limits', { provider: 'demo', accountId: account.id });
      const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
      const rt = app.runtime(snap.session.id);
      await app.call('session.send', { sessionId: rt.id, text: 'hi' });
      await until(() => rt.items.some((i) => i.type === 'notice' && !!i.limit?.provider), 'limit notice');
      await app.call('spare.atReset', { sessionId: rt.id });
      expect(rt.meta.spare).toMatchObject({ reason: 'reset' });

      await app.call('limit.resetInAgent', { provider: 'demo', accountId: account.id });
      // The dialog cleared the 5-hour window only.
      DialogDemo.fixed.set(account.id, [fiveIn(0), week]);
      consoles.opened[0].close();
      await until(() => runs.at(-1)?.state === 'cleared', 'cleared');
      expect(runs.at(-1)?.cleared).toEqual(['5-hour limit']);
      await new Promise((r) => setTimeout(r, 300));
      expect(texts(rt.items)).toHaveLength(0);
      expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(1);
      expect(rt.meta.spare).toMatchObject({ reason: 'reset' });
      if (known) expect(rt.meta.spare!.at).toBe(week.resetsAt);
    });
});
