/**
 * The multi-account journey: existing folders, naming after sign-in, sign-in timeouts, carrying a
 * conversation to another account, and what happens at a plan limit. Everything runs in temporary
 * folders with the Demo agent or a fake CLI; nothing touches a real profile or sign-in.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent, type NoticeItem, type RateLimit, type TimelineItem, type UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { ClaudeProvider } from '../server/providers/claude';
import { carryClaudeConversation, carryCodexConversation, handoverText } from '../server/accounts/handover';
import { atCap, findAccountFolders, folderLabel, labelFromAuth, pickNextAccount } from '../server/accounts/folders';
import type { ProviderContext, ProviderSession } from '../server/providers/types';
import type { SessionRuntime } from '../server/core/runtime';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name = 'sable-acc-') => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

function put(file: string, text = 'x') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function until(pred: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function start(opts: { make?: (ctx: ProviderContext) => DemoProvider; userHome?: string; loginTimeoutMs?: number; speed?: number } = {}) {
  const home = temp('sable-home-');
  const app = new App({
    home,
    providers: [opts.make ?? ((ctx) => new DemoProvider(ctx, { speed: opts.speed ?? 0 }))],
    quiet: true,
    userHome: opts.userHome ?? temp('sable-user-'),
    loginTimeoutMs: opts.loginTimeoutMs,
  });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(structuredClone(e)));
  return { app, home, events };
}

/** An extra demo account signed in as someone whose plan limits are in `profile`. */
async function demoAccount(app: App, label: string, profile: 'calm' | 'cap' | 'near' | 'light') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  // The bridge knows its limits, as it does once the account has been used or shown.
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');

// ───────────────────────────── carrying a conversation ─────────────────────────────

describe('carrying a conversation between config folders', () => {
  it('copies one Claude conversation with its side files and checkpoints, and nothing else', async () => {
    const a = temp();
    const b = temp();
    const key = 'D--work-app';
    put(path.join(a, 'projects', key, 'abc-123.jsonl'), '{"type":"user"}\n');
    put(path.join(a, 'projects', key, 'abc-123', 'subagents', 'agent-1.jsonl'), '{}');
    put(path.join(a, 'projects', key, 'other.jsonl'), 'not this one');
    put(path.join(a, 'file-history', 'abc-123', 'f1@v1'), 'old');
    put(path.join(a, '.credentials.json'), 'secret');
    put(path.join(b, 'projects', 'elsewhere', 'keep.jsonl'), 'mine');

    expect(await carryClaudeConversation(a, b, 'abc-123')).toBe(true);
    expect(readFileSync(path.join(b, 'projects', key, 'abc-123.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(existsSync(path.join(b, 'projects', key, 'abc-123', 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(existsSync(path.join(b, 'file-history', 'abc-123', 'f1@v1'))).toBe(true);
    expect(existsSync(path.join(b, 'projects', key, 'other.jsonl'))).toBe(false);
    expect(existsSync(path.join(b, '.credentials.json'))).toBe(false);
    expect(readFileSync(path.join(b, 'projects', 'elsewhere', 'keep.jsonl'), 'utf8')).toBe('mine');
    // The source is untouched.
    expect(readFileSync(path.join(a, 'projects', key, 'abc-123.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
  });

  it('says no when the conversation is missing or the id is not a plain id', async () => {
    const a = temp();
    const b = temp();
    put(path.join(a, 'projects', 'k', 'abc.jsonl'));
    expect(await carryClaudeConversation(a, b, 'nope')).toBe(false);
    expect(await carryClaudeConversation(a, b, '../abc')).toBe(false);
    expect(await carryClaudeConversation(path.join(a, 'missing'), b, 'abc')).toBe(false);
    // The same folder: nothing to copy, and it can resume.
    expect(await carryClaudeConversation(a, a, 'abc')).toBe(true);
  });

  it('copies a Codex rollout to the same place under the other CODEX_HOME', async () => {
    const a = temp();
    const b = temp();
    const rel = path.join('2026', '11', '16', 'rollout-2026-11-16T09-00-00-thread-77.jsonl');
    put(path.join(a, 'sessions', rel), '{"type":"session_meta"}\n');
    put(path.join(a, 'auth.json'), 'secret');
    expect(await carryCodexConversation(a, b, 'thread-77')).toBe(true);
    expect(readFileSync(path.join(b, 'sessions', rel), 'utf8')).toBe('{"type":"session_meta"}\n');
    expect(existsSync(path.join(b, 'auth.json'))).toBe(false);
    expect(await carryCodexConversation(a, b, 'thread-78')).toBe(false);
  });

  it('lets a Claude account resume a conversation from another account’s folder', async () => {
    const a = temp();
    const b = temp();
    put(path.join(a, 'projects', 'k', 's-1.jsonl'), 'line\n');
    const p = new ClaudeProvider({ emit: () => {}, log: () => {}, account: { id: 'x', dir: b } });
    expect(p.configHome()).toBe(b);
    expect(await p.adoptConversation(a, 's-1')).toBe(true);
    expect(existsSync(path.join(b, 'projects', 'k', 's-1.jsonl'))).toBe(true);
    await p.dispose();
  });

  it('writes a short handover of the conversation, newest kept, without the message to resend', () => {
    const items: TimelineItem[] = [
      { id: 'u1', ts: 1, type: 'user', text: 'Rename the session module', state: 'sent' },
      { id: 't1', ts: 2, type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit session.ts', status: 'done', detail: {} },
      { id: 'a1', ts: 3, type: 'text', text: 'Renamed it to runtime.ts.', streaming: false },
      { id: 'u2', ts: 4, type: 'user', text: 'Now add tests', state: 'sent' },
    ];
    const text = handoverText(items, { skip: 'u2' });
    expect(text).toContain('User: Rename the session module');
    expect(text).toContain('Agent steps: Edit session.ts');
    expect(text).toContain('Agent: Renamed it to runtime.ts.');
    expect(text).not.toContain('Now add tests');
    const long = Array.from({ length: 80 }, (_, i): TimelineItem => ({ id: `u${i}`, ts: i, type: 'user', text: `message ${i} ${'x'.repeat(200)}`, state: 'sent' }));
    const cut = handoverText(long, { maxChars: 2000 });
    expect(cut.length).toBeLessThanOrEqual(2100);
    expect(cut).toContain('message 79');
    expect(cut).not.toContain('message 0 ');
    expect(cut).toContain('earlier messages left out');
    expect(handoverText([])).toBe('');
  });
});

// ───────────────────────────── existing folders ─────────────────────────────

describe('using an existing folder', () => {
  it('finds config folders by the names inside them, never the agent’s own or registered ones', () => {
    const home = temp();
    mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(path.join(home, '.claude-work', 'projects'), { recursive: true });
    put(path.join(home, '.claude-accounts', 'studio', 'settings.json'), '{}');
    mkdirSync(path.join(home, '.claude-accounts', 'empty'), { recursive: true });
    mkdirSync(path.join(home, '.claude-notes'), { recursive: true });
    put(path.join(home, '.codex-second', 'config.toml'));
    const found = findAccountFolders('claude', home);
    expect(found.map((f) => f.name).sort()).toEqual(['claude-work', 'studio']);
    expect(findAccountFolders('claude', home, [path.join(home, '.claude-work')]).map((f) => f.name)).toEqual(['studio']);
    expect(findAccountFolders('codex', home).map((f) => f.name)).toEqual(['codex-second']);
    expect(findAccountFolders('demo', home)).toEqual([]);
    expect(folderLabel('claude', path.join(home, '.claude-work'))).toBe('Work');
    expect(folderLabel('claude', path.join(home, '.claude-accounts', 'studio'))).toBe('Studio');
  });

  it('registers a folder as an account in place and only forgets it on removal', async () => {
    const userHome = temp();
    const { app, home } = start({ userHome });
    const dir = path.join(userHome, 'profiles', 'side');
    put(path.join(dir, 'demo-auth.json'), JSON.stringify({ email: 'side@example.dev', plan: 'Pro', limits: 'light' }));
    const added = await app.call('account.addExisting', { provider: 'demo', dir });
    expect(added.account).toMatchObject({ label: 'Side', external: true, dir: path.resolve(dir), auth: { loggedIn: true, email: 'side@example.dev' } });
    // Nothing was copied into Sable's own folder.
    expect(existsSync(path.join(home, 'accounts', 'demo', added.account.id))).toBe(false);
    await expect(app.call('account.addExisting', { provider: 'demo', dir })).rejects.toThrow(/already the account Side/);
    await expect(app.call('account.addExisting', { provider: 'demo', dir: path.join(userHome, 'nope') })).rejects.toThrow(/not found/);

    await app.call('account.remove', { provider: 'demo', accountId: added.account.id });
    expect(existsSync(path.join(dir, 'demo-auth.json'))).toBe(true);
    const [demo] = (await app.call('app.hello', {})).providers;
    expect(demo.accounts!.map((a) => a.id)).toEqual([DEFAULT_ACCOUNT]);
  });

  it('lists candidate folders that are not accounts yet', async () => {
    const userHome = temp();
    mkdirSync(path.join(userHome, '.claude-work', 'projects'), { recursive: true });
    const { app } = start({ userHome });
    expect(await app.call('account.folders', { provider: 'claude' })).toEqual([{ dir: path.join(userHome, '.claude-work'), name: 'claude-work' }]);
  });
});

// ───────────────────────────── naming and sign-in ─────────────────────────────

describe('adding an account', () => {
  it('names a new account after its sign-in, and keeps a name the user gave', async () => {
    const { app, events } = start();
    const auto = await app.call('account.add', { provider: 'demo' });
    expect(auto.account.label).toBe('Account 2');
    await app.call('auth.login', { provider: 'demo', accountId: auto.account.id });
    await until(() => events.some((e) => e.type === 'auth.progress' && e.state === 'done' && e.accountId === auto.account.id), 'sign-in');
    const after = (await app.call('app.hello', {})).providers[0].accounts!.find((a) => a.id === auto.account.id)!;
    expect(after.label).toBe('Margaret');
    // Renaming in place sticks; a second sign-in does not rename it again.
    await app.call('account.rename', { provider: 'demo', accountId: auto.account.id, label: 'Work' });
    await app.call('auth.login', { provider: 'demo', accountId: auto.account.id });
    await until(() => events.filter((e) => e.type === 'auth.progress' && e.state === 'done').length === 2, 'second sign-in');
    expect((await app.call('app.hello', {})).providers[0].accounts!.find((a) => a.id === auto.account.id)!.label).toBe('Work');

    const named = await app.call('account.add', { provider: 'demo', label: 'Studio' });
    await app.call('auth.login', { provider: 'demo', accountId: named.account.id });
    await until(() => events.some((e) => e.type === 'auth.progress' && e.state === 'done' && e.accountId === named.account.id), 'named sign-in');
    expect((await app.call('app.hello', {})).providers[0].accounts!.find((a) => a.id === named.account.id)!.label).toBe('Studio');
  });

  it('gives up a sign-in nobody finishes, as timed out', async () => {
    const { app, events } = start({ speed: 1, loginTimeoutMs: 60 });
    const { account } = await app.call('account.add', { provider: 'demo' });
    await app.call('auth.login', { provider: 'demo', accountId: account.id });
    await until(() => events.some((e) => e.type === 'auth.progress' && e.state === 'timeout'), 'timeout');
    await new Promise((r) => setTimeout(r, 50));
    const states = events.flatMap((e) => (e.type === 'auth.progress' ? [e.state] : []));
    expect(states).toEqual(['started', 'url', 'timeout']);
    expect((await app.call('app.hello', {})).providers[0].accounts!.find((a) => a.id === account.id)!.auth.loggedIn).toBe(false);
  });

  it('labels from email, whole email when taken, organisation without one', () => {
    expect(labelFromAuth({ loggedIn: true, email: 'ada@example.dev' }, [])).toBe('Ada');
    expect(labelFromAuth({ loggedIn: true, email: 'ada@example.dev' }, ['ada'])).toBe('ada@example.dev');
    expect(labelFromAuth({ loggedIn: true, email: 'ada.l@example.dev' }, [])).toBe('ada.l');
    expect(labelFromAuth({ loggedIn: true, org: 'Acme' }, [])).toBe('Acme');
    expect(labelFromAuth({ loggedIn: true, org: "ada@example.dev's Organization" }, [])).toBeUndefined();
  });
});

// ───────────────────────────── a fake Claude CLI ─────────────────────────────

/** A stand-in `claude` on PATH: signs in by leaving a file in CLAUDE_CONFIG_DIR, or fails with a reason. */
function fakeClaudeCli(): string {
  const bin = temp('sable-bin-');
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(bin, 'claude.cmd'),
      [
        '@echo off',
        'if "%1"=="--version" (echo 9.9.9& exit /b 0)',
        'if "%1"=="auth" if "%2"=="status" goto status',
        'if "%1"=="auth" if "%2"=="login" goto login',
        'if "%1"=="auth" if "%2"=="logout" (del "%CLAUDE_CONFIG_DIR%\\signed-in" 2>nul& exit /b 0)',
        'exit /b 2',
        ':status',
        'if not exist "%CLAUDE_CONFIG_DIR%\\signed-in" (echo {"loggedIn":false}& exit /b 0)',
        'if "%3"=="--json" (echo {"loggedIn":true,"authMethod":"claude.ai","email":"grace@example.dev","subscriptionType":"max"}) else (echo Login method: Claude Max account)',
        'exit /b 0',
        ':login',
        'echo Opening https://claude.ai/oauth/authorize?code=fake',
        'if "%FAKE_LOGIN%"=="fail" (echo Error: The sign-in was denied in the browser& exit /b 1)',
        'echo.>"%CLAUDE_CONFIG_DIR%\\signed-in"',
        'exit /b 0',
        '',
      ].join('\r\n'),
    );
  } else {
    const file = path.join(bin, 'claude');
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi',
        'if [ "$1 $2" = "auth status" ]; then',
        '  if [ ! -f "$CLAUDE_CONFIG_DIR/signed-in" ]; then echo \'{"loggedIn":false}\'; exit 0; fi',
        '  if [ "$3" = "--json" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","email":"grace@example.dev","subscriptionType":"max"}\'; else echo "Login method: Claude Max account"; fi',
        '  exit 0',
        'fi',
        'if [ "$1 $2" = "auth login" ]; then',
        '  echo "Opening https://claude.ai/oauth/authorize?code=fake"',
        '  if [ "$FAKE_LOGIN" = "fail" ]; then echo "Error: The sign-in was denied in the browser"; exit 1; fi',
        '  touch "$CLAUDE_CONFIG_DIR/signed-in"; exit 0',
        'fi',
        'if [ "$1 $2" = "auth logout" ]; then rm -f "$CLAUDE_CONFIG_DIR/signed-in"; exit 0; fi',
        'exit 2',
        '',
      ].join('\n'),
    );
    chmodSync(file, 0o755);
  }
  return bin;
}

describe('Claude sign-in through its CLI (fake CLI)', () => {
  it('opens the sign-in, reports the link, ends signed in with the plan and the account named', { timeout: 30_000 }, async () => {
    const bin = fakeClaudeCli();
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    process.env.SABLE_LOGIN = 'cli';
    // The fake CLI is found on PATH: a path to a real Claude Code in the environment (the desktop
    // shell sets SABLE_CLAUDE_BIN for its children, also for a test run started from inside Sable)
    // would be asked instead.
    const realBin = process.env.SABLE_CLAUDE_BIN;
    delete process.env.SABLE_CLAUDE_BIN;
    try {
      const home = temp('sable-home-');
      const app = new App({ home, providers: [(ctx) => new ClaudeProvider(ctx)], quiet: true, userHome: temp() });
      apps.push(app);
      const events: BridgeEvent[] = [];
      app.subscribe((e) => events.push(structuredClone(e)));
      const { account } = await app.call('account.add', { provider: 'claude' });
      expect(account.auth.loggedIn).toBe(false);
      await app.call('auth.login', { provider: 'claude', accountId: account.id });
      await until(() => events.some((e) => e.type === 'auth.progress' && (e.state === 'done' || e.state === 'error')), 'sign-in', 25_000);
      const flow = events.flatMap((e) => (e.type === 'auth.progress' ? [[e.state, e.url ?? '']] : []));
      expect(flow).toEqual([
        ['started', ''],
        ['url', 'https://claude.ai/oauth/authorize?code=fake'],
        ['done', ''],
      ]);
    await until(() => events.some(e => e.type === 'provider.updated' && e.provider.accounts?.some(a => a.id === account.id && a.auth.loggedIn)), 'account status');
    const after = (await app.call('app.hello', {})).providers[0].accounts!.find((a) => a.id === account.id)!;
      expect(after.auth).toMatchObject({ loggedIn: true, email: 'grace@example.dev', plan: 'Max' });
      expect(after.label).toBe('Grace');
      expect(existsSync(path.join(account.dir!, 'signed-in'))).toBe(true);

      // A failed sign-in says why.
      const second = await app.call('account.add', { provider: 'claude' });
      process.env.FAKE_LOGIN = 'fail';
      await app.call('auth.login', { provider: 'claude', accountId: second.account.id });
      await until(() => events.some((e) => e.type === 'auth.progress' && e.state === 'error'), 'failed sign-in', 25_000);
      const failed = events.find((e) => e.type === 'auth.progress' && e.state === 'error');
      expect(failed?.type === 'auth.progress' && failed.message).toMatch(/denied in the browser/);
    } finally {
      process.env.PATH = before;
      delete process.env.FAKE_LOGIN;
      delete process.env.SABLE_LOGIN;
      if (realBin !== undefined) process.env.SABLE_CLAUDE_BIN = realBin;
    }
  });
});

// ───────────────────────────── at a plan limit ─────────────────────────────

describe('at a plan limit', () => {
  it('picks the account with the most room, never one at its cap or signed out', () => {
    const now = 1_000_000;
    const lim = (percent: number, resetsAt = now + 3_600_000): RateLimit[] => [{ id: 'five_hour', label: '5-hour limit', percent, resetsAt }];
    const accounts = [
      { id: 'a', signedIn: true, limits: lim(100) },
      { id: 'b', signedIn: true, limits: lim(70) },
      { id: 'c', signedIn: true, limits: lim(20) },
      { id: 'd', signedIn: false, limits: lim(0) },
    ];
    expect(pickNextAccount('a', accounts, now)).toBe('c');
    expect(pickNextAccount('a', [accounts[0], { id: 'x', signedIn: true, limits: lim(100) }], now)).toBeUndefined();
    // A window whose reset has passed is not full any more.
    expect(atCap(lim(100, now - 1), now)).toBe(false);
    expect(pickNextAccount('a', [accounts[0], { id: 'y', signedIn: true, limits: lim(100, now - 1) }], now)).toBe('y');
    // Unknown limits count as half used; the default wins a tie; an API key always has room.
    expect(pickNextAccount('a', [{ id: 'u', signedIn: true }, { id: 'v', signedIn: true, isDefault: true }], now)).toBe('v');
    // An API key (billed per token) is never moved to by itself.
    expect(pickNextAccount('a', [{ id: 'k', signedIn: true, planLimits: false }, accounts[2]], now)).toBe('c');
  });

  it('says when the window resets and offers the account with room, then continues there with the same message', async () => {
    const { app, home } = start();
    const capped = await demoAccount(app, 'Studio', 'cap');
    const roomy = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: capped.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => notices(rt.items).some((n) => n.limit?.provider), 'limit notice');
    const hit = notices(rt.items).find((n) => n.limit)!;
    expect(hit.limit).toMatchObject({ provider: 'demo', accountId: capped.id, window: '5-hour limit', next: roomy.id });
    expect(hit.limit!.resetsAt).toBeGreaterThan(Date.now());
    expect(rt.items.filter((i) => i.type === 'text')).toHaveLength(0);

    const users = rt.items.filter((i) => i.type === 'user').length;
    const res = await app.call('session.switchAccount', { sessionId: rt.id, accountId: roomy.id, retry: true });
    expect(res).toMatchObject({ ok: true, carried: 'conversation' });
    expect(rt.meta.accountId).toBe(roomy.id);
    expect(rt.get<NoticeItem>(hit.id)!.limit!.continuedWith).toBe(roomy.id);
    // The refused message goes out again under the new account: no second copy in the timeline.
    await until(() => rt.items.some((i) => i.type === 'text') && rt.meta.status === 'idle', 'answer');
    expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(users);
    expect(rt.items.findIndex((i) => i.type === 'text')).toBeGreaterThan(rt.items.indexOf(hit));
  });

  it('offers nothing when every other account is at its cap', async () => {
    // A spare account known to be at its cap is skipped: the built-in one (room) is offered.
    const { app, home } = start();
    const a = await demoAccount(app, 'Studio', 'cap');
    const spare = await demoAccount(app, 'Spare', 'cap');
    await app.call('provider.limits', { provider: 'demo', accountId: spare.id });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: a.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => notices(rt.items).some((n) => n.limit?.provider), 'limit notice');
    expect(notices(rt.items).find((n) => n.limit)!.limit!.next).toBe(DEFAULT_ACCOUNT);

    // With the built-in account at its cap too, nothing is offered.
    const { app: app2, home: home2 } = start({ make: (ctx) => new CappedDemo(ctx) });
    const b = await demoAccount(app2, 'Studio', 'cap');
    const spare2 = await demoAccount(app2, 'Spare', 'cap');
    const s2 = await app2.call('session.create', { provider: 'demo', cwd: path.join(home2, 'p'), accountId: b.id });
    const rt2 = app2.runtime(s2.session.id);
    await app2.call('provider.limits', { provider: 'demo' });
    await app2.call('provider.limits', { provider: 'demo', accountId: spare2.id });
    await app2.call('session.send', { sessionId: rt2.id, text: 'hi' });
    await until(() => notices(rt2.items).some((n) => n.limit?.provider), 'limit notice');
    expect(notices(rt2.items).find((n) => n.limit)!.limit!.next).toBeUndefined();
  });

  it('continues on its own with "Continue with the next account at a limit" on', async () => {
    const { app, home } = start();
    await app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const capped = await demoAccount(app, 'Studio', 'cap');
    const roomy = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: capped.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.meta.accountId === roomy.id && rt.items.some((i) => i.type === 'text') && rt.meta.status === 'idle', 'automatic continue');
    expect(notices(rt.items).find((n) => n.limit)!.limit!.continuedWith).toBe(roomy.id);
  });

  it('starts a new conversation with a handover when the other account cannot take the conversation', async () => {
    const sent: string[] = [];
    const { app, home } = start({ make: (ctx) => new NoCarryDemo(ctx, sent) });
    const other = await demoAccount(app, 'Work', 'light');
    // Bypass: the Demo reads only the person's words ("and now the tests", the handover taken off), and
    // the scenario its rotation picks for them edits files, which in Ask first waits for a permission.
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
    const res = await app.call('session.switchAccount', { sessionId: rt.id, accountId: other.id });
    expect(res.carried).toBe('summary');
    expect(rt.meta.providerSessionId).toBeUndefined();
    expect(notices(rt.items).pop()).toMatchObject({ variant: 'info', text: 'New conversation with Work' });
    await app.call('session.send', { sessionId: rt.id, text: 'and now the tests' });
    await until(() => sent.length === 2, 'second send');
    expect(sent[1]).toContain('User: hi');
    // The person's words, then the note about the move (move-context.ts).
    expect(sent[1]).toMatch(/\n\nand now the tests\n\n<system-reminder>\nThis conversation moved to another account/);
    // The timeline shows what the user typed, not the handover.
    expect((rt.items.filter((i) => i.type === 'user').pop() as UserItem).text).toBe('and now the tests');
    // Only once.
    await until(() => rt.meta.status === 'idle', 'idle');
    await app.call('session.send', { sessionId: rt.id, text: 'third' });
    await until(() => sent.length === 3, 'third send');
    expect(sent[2]).toBe('third');
  });

  it('carries on where a turn cut off by a limit stopped, instead of starting it over', async () => {
    const sent: string[] = [];
    const { app, home } = start({ make: (ctx) => new RecordingDemo(ctx, sent) });
    const studio = await demoAccount(app, 'Studio', 'light');
    const roomy = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
    sent.length = 0;
    // A turn that did some work before the limit cut it off.
    rt.add<UserItem>({ type: 'user', text: 'build the importer', state: 'sent' });
    rt.add({ type: 'text', text: 'Reading the parser first.', streaming: false });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit' } });
    const users = rt.items.filter((i) => i.type === 'user').length;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: roomy.id, retry: true });
    await until(() => sent.length === 1, 'the carry-on message');
    expect(sent[0]).toMatch(/Carry on with the task from where it stopped/);
    expect(sent[0]).not.toContain('build the importer');
    // Nothing new in the conversation: it simply goes on.
    expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(users);
  });

  it('"Continue with" at a limit writes where to go back before the refused message goes out there (day 6, D5)', async () => {
    const seen: { text: string; movedFrom?: string; account?: string }[] = [];
    const { app, home } = start({ make: (ctx) => new WatchingDemo(ctx, seen) });
    const capped = await demoAccount(app, 'Studio', 'cap');
    const roomy = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: capped.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => notices(rt.items).some((n) => n.limit?.provider), 'limit notice');
    seen.length = 0;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: roomy.id, retry: true });
    await until(() => seen.length === 1, 'the refused message again');
    // A limit met again in this very turn reads where the chat came from.
    expect(seen[0]).toMatchObject({ text: expect.stringMatching(/^hi\b/), movedFrom: capped.id, account: roomy.id });
  });

  it('refuses to move a working session, and to an account that is gone', async () => {
    const { app, home } = start();
    const other = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const rt = app.runtime(snap.session.id);
    rt.turnActive = true;
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: other.id })).rejects.toThrow(/still working/);
    rt.turnActive = false;
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: 'gone' })).rejects.toThrow(/removed/);
    const ok = await app.call('session.switchAccount', { sessionId: rt.id, accountId: other.id });
    expect(ok.ok).toBe(true);
    expect(notices(rt.items).pop()).toMatchObject({ text: 'Continued with Work' });
    // Sessions of a removed account stay readable.
    await app.call('account.remove', { provider: 'demo', accountId: other.id });
    expect((await app.call('session.snapshot', { sessionId: rt.id })).items.length).toBeGreaterThan(0);
  });
});

/** The demo whose built-in account is at its cap too. */
class CappedDemo extends DemoProvider {
  constructor(ctx: ProviderContext) {
    super(ctx, { speed: 0 });
  }
  override limitProfile() {
    return super.limitProfile() === 'calm' && !this.configHome() ? ('cap' as const) : super.limitProfile();
  }
}

/** The demo agent recording what each send carried. */
class RecordingDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private sent: string[],
  ) {
    super(ctx, { speed: 0 });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    s.send = (item) => {
      this.sent.push(item.text);
      return send(item);
    };
    return s;
  }
}

/** The demo agent recording, with each send, where the chat would go back to and the account it is on. */
class WatchingDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private seen: { text: string; movedFrom?: string; account?: string }[],
  ) {
    super(ctx, { speed: 0 });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    s.send = (item) => {
      this.seen.push({ text: item.text, movedFrom: rt.meta.movedFrom, account: rt.meta.accountId });
      return send(item);
    };
    return s;
  }
}

/** The demo agent where no account can take another's conversation; records what each send carried. */
class NoCarryDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private sent: string[],
  ) {
    super(ctx, { speed: 0 });
  }
  override async adoptConversation() {
    return false;
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    s.send = (item) => {
      this.sent.push(item.text);
      return send(item);
    };
    return s;
  }
}

// ───────────────────────────── Claude limits without the usage endpoint ─────────────────────────────

describe('Claude plan limits from the turn itself', () => {
  const make = () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider({ emit: (e) => events.push(e), log: () => {} });
    return { p, events };
  };

  it('reads every window from a rate_limit_event (no usage request)', () => {
    const { p, events } = make();
    const reset5 = Math.floor(Date.now() / 1000) + 3600;
    const resetW = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const hit = p.onRateLimit({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.81,
      resetsAt: reset5,
      unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: reset5, status: 'allowed_warning' }, seven_day: { utilization: 0.4, resetsAt: resetW, status: 'allowed' } },
    });
    expect(hit).toBeUndefined();
    const last = events.pop();
    expect(last?.type === 'limits.updated' && last.limits).toEqual([
      { id: 'five_hour', label: '5-hour limit', percent: 81, resetsAt: reset5 * 1000, windowMins: 300 },
      { id: 'seven_day', label: 'Weekly · all models', percent: 40, resetsAt: resetW * 1000, windowMins: 10_080 },
    ]);
    expect(last?.type === 'limits.updated' && last.meta).toEqual({ planLimits: true, partial: true });
    // The same numbers again are not news.
    p.onRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: reset5 });
    expect(events).toHaveLength(0);
  });

  it('marks the refusing window full and says when it resets, even with nothing known before', () => {
    const { p, events } = make();
    const reset = Math.floor(Date.now() / 1000) + 5400;
    const hit = p.onRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    expect(hit).toEqual({ resetsAt: reset * 1000, window: '5-hour limit' });
    const last = events.pop();
    expect(last?.type === 'limits.updated' && last.limits[0]).toMatchObject({ id: 'five_hour', percent: 100, resetsAt: reset * 1000 });
  });

  it('asks the usage endpoint again only after a pause once it refused', async () => {
    const { p } = make();
    let asked = 0;
    const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => (asked++, { rate_limits: null, rate_limits_available: true, subscription_type: 'max' }) };
    p.onRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    const first = await p.readLimits(q as never, 0);
    expect(asked).toBe(1);
    // The last known windows stay.
    expect(first.map((l) => l.percent)).toEqual([30]);
    await p.readLimits(q as never, 1);
    expect(asked).toBe(1);
    // The user asking (no gap) still asks.
    await p.readLimits(q as never, 0);
    expect(asked).toBe(2);
  });
});
