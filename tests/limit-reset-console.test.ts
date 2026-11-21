/**
 * "Use a reset in Claude Code": Sable opens the account's own agent in a console window straight
 * into its reset dialog and reads the limits again when the window closes. No test opens a window:
 * the App gets an opener that records what it would start. A fake `claude` is on PATH, so nothing
 * here could reach a real Claude Code.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent, type NoticeItem, type RateLimit, type ResetRun, type TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { clearedWindows, fullWindows } from '../server/core/reset-console';
import { ClaudeProvider } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext } from '../server/providers/types';
import { registerUsage } from '../server/services/usage';
import { consoleCommandLine, type ConsoleSpec } from '../server/util/console';

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
  it('starts the program with start /wait, the title and every argument as given, in one verbatim line', () => {
    expect(consoleCommandLine({ title: 'Claude Code reset', bin: 'C:\\Program Files\\Sable\\resources\\claude\\claude.exe', args: ['/limit-reset'] })).toBe(
      '"start "Claude Code reset" /wait "C:\\Program Files\\Sable\\resources\\claude\\claude.exe" "/limit-reset""',
    );
    expect(consoleCommandLine({ title: 'Claude Code reset (Work)', bin: 'claude', args: ['/limit-reset'] })).toBe('"start "Claude Code reset (Work)" /wait claude "/limit-reset""');
    // OpenCode's sign-in, as before its move to the shared helper (now inside the outer quotes `/s` takes off).
    expect(consoleCommandLine({ title: 'OpenCode login', bin: 'opencode', args: ['auth', 'login'] })).toBe('"start "OpenCode login" /wait opencode auth login"');
  });

  it('refuses what cmd would read as more than text', () => {
    for (const bad of ['a"b', '%PATH%', 'a\r\nb'])
      expect(() => consoleCommandLine({ title: 'x', bin: 'claude', args: [bad] })).toThrow();
    expect(() => consoleCommandLine({ title: 'say "hi"', bin: 'claude', args: [] })).toThrow();
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
      expect(consoleCommandLine(spec)).toBe('"start "Claude Code reset (Work)" /wait claude "/limit-reset""');

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
