/**
 * "I suddenly get logged out": one gate per account for the processes Sable starts (starts of one
 * config folder one at a time, two accounts never waiting for each other, nothing let go before it
 * answered), the catch-up after a wake spread out, and a refusal for the sign-in that is not
 * believed at once (asked again, retried once silently, one notice when the CLI says signed out,
 * and the chat carries on once signed in again). Fake processes, the Demo agent, temporary folders.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeItem, TimelineItem, UserItem } from '@shared/protocol';
import { AUTH_FAILURE_TEXT, isAuthFailure, parseSynthetic, RESUME_AFTER_SIGN_IN, signInBackgroundNote, userText } from '@shared/synthetic';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext, ProviderSession } from '../server/providers/types';
import type { SessionRuntime } from '../server/core/runtime';
import { AuthGate, GATE, gateKey, noteAuthFailure, refusedForSignIn, resetAuthFailures, type GatedProcess } from '../server/core/auth-gate';

const temps: string[] = [];
const apps: App[] = [];
const procs: GatedProcess[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetAuthFailures();
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ───────────────────────────── the gate ─────────────────────────────

/** A fake CLI: answers its first stdin line after `delay` ms with one line, then echoes until stdin closes. */
function fakeCli(dir: string) {
  const file = path.join(dir, 'fake-cli.cjs');
  writeFileSync(
    file,
    `const delay = Number(process.argv[2] || 0);
let first = true;
process.stdin.on('data', () => { if (first) { first = false; setTimeout(() => process.stdout.write('ready ' + Date.now() + '\\n'), delay); } });
process.stdin.on('end', () => process.exit(0));`,
  );
  return file;
}

const small = { ...GATE, holdMs: 3000, auxLeaseMs: 3000, settleMs: 100, minLifeMs: 50, lingerMs: 2000 };

function run(gate: AuthGate, script: string, configDir: string, delay = 200) {
  const p = gate.spawner()({ command: process.execPath, args: [script, String(delay)], env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
  procs.push(p);
  const started = Date.now();
  let answeredAt = 0;
  p.stdout.on('data', () => (answeredAt ||= Date.now()));
  p.stdin.write('{"type":"control_request"}\n');
  return { p, started, answered: () => answeredAt };
}

describe('one gate per account', () => {
  it('two starts for one account are serialized; two accounts are not', async () => {
    const dir = temp('sable-gate-');
    const script = fakeCli(dir);
    const gate = new AuthGate(small);
    const a1 = run(gate, script, path.join(dir, 'ultra1'), 300);
    const a2 = run(gate, script, path.join(dir, 'ultra1'), 300);
    const b1 = run(gate, script, path.join(dir, 'ultra2'), 300);
    await until(() => !!(a1.answered() && a2.answered() && b1.answered()), 'all three answered');
    // The second start of ultra1 waited for the first one's answer (and its settle).
    expect(a2.answered() - a1.answered()).toBeGreaterThanOrEqual(300 + small.settleMs - 30);
    // Another account went beside it.
    expect(Math.abs(b1.answered() - a1.answered())).toBeLessThan(300);
    const keys = gate.trace.filter((t) => t.kind === 'start').map((t) => t.key);
    expect(keys.filter((k) => k === gateKey('claude', path.join(dir, 'ultra1')))).toHaveLength(2);
  });

  it('a long status check never lets two waiting starts in together (review wave 16, #9)', async () => {
    const gate = new AuthGate({ ...small, holdMs: 400, auxLeaseMs: 5000 });
    const key = 'claude:x';
    let inside = 0;
    let most = 0;
    // `auth status` holds the gate for more than three seconds.
    const status = gate.run(key, async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 3300));
      inside--;
    });
    const start = async () => {
      const leave = await gate.enter(key, 'start');
      inside++;
      most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 150));
      inside--;
      leave();
    };
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([status, start(), start()]);
    expect(most).toBe(1);
    const starts = gate.trace.filter((t) => t.kind === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[1].at - starts[0].at).toBeGreaterThanOrEqual(140);
  }, 10_000);

  it('a start goes ahead of auxiliary requests that wait', async () => {
    const gate = new AuthGate(small);
    const leave = await gate.enter('claude:y', 'aux');
    const order: string[] = [];
    const aux = gate.run('claude:y', async () => void order.push('aux'));
    const start = gate.enter('claude:y', 'start').then((l) => (order.push('start'), l()));
    leave();
    await Promise.all([aux, start]);
    expect(order).toEqual(['start', 'aux']);
  });

  it('a holder that died loses the gate when its lease ends, so no start waits for ever', async () => {
    const gate = new AuthGate({ ...small, auxLeaseMs: 300 });
    void gate.enter('claude:z', 'aux'); // never released
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const leave = await gate.enter('claude:z', 'start');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(1500);
    leave();
  });

  it('auxiliary requests of one account never overlap, nor a start of it', async () => {
    const gate = new AuthGate(small);
    let inside = 0;
    let most = 0;
    const work = () =>
      gate.run('claude:a', async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 40));
        inside--;
      });
    const start = gate.enter('claude:a', 'start');
    const order: string[] = [];
    await Promise.all([start.then((leave) => (order.push('start'), setTimeout(leave, 60))), work().then(() => order.push('aux1')), work().then(() => order.push('aux2'))]);
    expect(most).toBe(1);
    expect(order[0]).toBe('start');
  });

  it('a process asked to close before it answered is let go only after its answer', async () => {
    const dir = temp('sable-gate-');
    const script = fakeCli(dir);
    const gate = new AuthGate(small);
    const a = run(gate, script, path.join(dir, 'acc'), 400);
    let exitedAt = 0;
    a.p.on('exit', () => (exitedAt = Date.now()));
    // The SDK closes stdin at once (a probe given up, a prewarm discarded).
    await new Promise((r) => setTimeout(r, 50));
    a.p.stdin.end();
    await until(() => exitedAt > 0, 'exit');
    expect(a.answered()).toBeGreaterThan(0);
    expect(exitedAt).toBeGreaterThanOrEqual(a.answered());
  });

  it('a process closed while it still waits for the gate never starts', async () => {
    const gate = new AuthGate(small);
    const leave = await gate.enter(gateKey('claude', '/x'), 'aux');
    const p = gate.spawner()({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: { CLAUDE_CONFIG_DIR: '/x' } });
    let code: number | null | undefined;
    p.on('exit', (c) => (code = c));
    p.kill('SIGTERM');
    expect(code).toBeNull();
    expect(p.exitCode).toBeNull();
    leave();
  });
});

describe('after a wake', () => {
  it('a timer more than a minute late spreads the catch-up instead of firing everything at once', () => {
    vi.useFakeTimers();
    const gate = new AuthGate({ ...GATE, spreadMs: 4000, jitterMs: 0 });
    const ran: number[] = [];
    const t0 = Date.now();
    // Five accounts' timers, all meant for ten minutes ago (the laptop slept through them).
    for (let i = 0; i < 5; i++) gate.afterWake(() => ran.push(Date.now() - t0), t0 - 600_000, t0);
    // Not one in the same tick: each in its own slot.
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(20_000);
    expect(ran).toEqual([0, 4000, 8000, 12000, 16000]);
  });

  it('a timer on time runs at once', () => {
    const gate = new AuthGate(GATE);
    const ran: string[] = [];
    gate.afterWake(() => ran.push('now'), Date.now() - 5000);
    expect(ran).toEqual(['now']);
    expect(gate.waking()).toBe(false);
  });

  it('accounts get different offsets', () => {
    const gate = new AuthGate({ ...GATE, jitterMs: 0 });
    const a = gate.stagger('claude:ultra1');
    const b = gate.stagger('claude:ultra2');
    expect(a).not.toBe(b);
    expect(gate.stagger('claude:ultra1')).toBe(a);
  });
});

describe("Claude Code's words for a refused sign-in", () => {
  it('are known, and nobody else words are taken for them', () => {
    expect(isAuthFailure(AUTH_FAILURE_TEXT)).toBe(true);
    expect(isAuthFailure('Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.')).toBe(true);
    expect(isAuthFailure('The tests fail to authenticate because the fixture has no token.')).toBe(false);
    expect(refusedForSignIn('authentication_failed')).toBe(true);
    expect(refusedForSignIn('rate_limit', ['You have reached your usage limit.'])).toBe(false);
  });

  it("a message that only begins like one of Sable's texts stays the person's (review wave 16, #14)", () => {
    const mine = '\n\nWhy does this keep failing on CI?';
    const until = 'The check `pnpm test` failed (exit code 1). Fix the cause, not the check. When your turn ends, Sable runs it again (round 2 of 5).\n\n```text\nFAIL a.test.ts\n```';
    // Sable's whole messages are Sable's.
    expect(userText(until)).toBe('');
    expect(userText(RESUME_AFTER_SIGN_IN)).toBe('');
    // The same with the person's own words under them: theirs, whole.
    for (const lead of [until, RESUME_AFTER_SIGN_IN, `${RESUME_AFTER_SIGN_IN}${signInBackgroundNote(['Map auth'])}`, 'The check `pnpm test` failed (exit code 1). Fix the cause, not the check. When your turn ends, Sable runs it again (round 2 of 5).']) {
      const text = `${lead}${mine}`;
      expect(parseSynthetic(text)?.role).not.toBe('hidden');
      expect(userText(text)).toContain('Why does this keep failing on CI?');
    }
    // A handover's head pasted with a question under it (no exchanges): the person's.
    const head = 'This continues a conversation that started under another account. Here is what happened so far, oldest first:\nwhat does this line mean?';
    expect(userText(head)).toContain('what does this line mean?');
    // A real handover before the person's words: only their words show.
    const handover = 'This continues a conversation that started under another account. Here is what happened so far, oldest first:\nUser: hi\nAgent: hello\n\nCarry on from there. The next message is the one to answer now.\n\n---\n\nand now the tests';
    expect(userText(handover)).toBe('and now the tests');
    // The Browser tab's line after the person's words goes; their words stay.
    expect(userText('look at this\n\n[Sable: the user\'s Browser tab shows http://localhost:5173/. browser_read reads it.]')).toBe('look at this');
  });

  it('the carry-on after a sign-in is Sable\'s own, never the person\'s', () => {
    const text = `${RESUME_AFTER_SIGN_IN}${signInBackgroundNote(['Map auth error responses'])}`;
    expect(parseSynthetic(text)).toBeTruthy();
    expect(userText(text)).toBe('');
  });
});

// ───────────────────────────── refused for the sign-in ─────────────────────────────

interface Log {
  sent: string[];
  /** How many of the next sends are refused for the sign-in. */
  refuse: number;
  /** A sub-agent of the turn is refused with it. */
  background?: boolean;
}

/** The Demo agent, whose sends can be refused for the sign-in as Claude Code's are (`noteAuthFailure`, a failed turn). */
class AuthDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private log: Log,
  ) {
    super(ctx, { speed: 0 });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    s.send = async (item, o) => {
      this.log.sent.push(item.text);
      if (this.log.refuse <= 0) return send(item, o);
      this.log.refuse--;
      rt.beginTurn('Thinking');
      // A sub-agent of the turn may be refused too: still one notice.
      if (this.log.background) noteAuthFailure(rt.id, 'Map auth error responses');
      noteAuthFailure(rt.id);
      setTimeout(() => rt.endTurn(AUTH_FAILURE_TEXT), 0);
    };
    return s;
  }
}

async function setup(signInDelay = 10) {
  const log: Log = { sent: [], refuse: 0 };
  const home = temp('sable-auth-');
  const app = new App({ home, providers: [(ctx) => new AuthDemo(ctx, log)], quiet: true, userHome: temp('sable-auth-user-'), refreshDelays: { info: 60_000, caps: 60_000, signIn: signInDelay } });
  apps.push(app);
  const { account } = await app.call('account.add', { provider: 'demo', label: 'Ultra1' });
  const authFile = path.join(account.dir!, 'demo-auth.json');
  const signIn = () => writeFileSync(authFile, JSON.stringify({ email: 'ultra1@example.dev', plan: 'Max', limits: 'calm' }));
  const signOut = () => unlinkSync(authFile);
  signIn();
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
  const rt = app.runtime(snap.session.id);
  return { app, log, rt, account, signIn, signOut };
}

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');
const people = (items: TimelineItem[]) => items.filter((i): i is UserItem => i.type === 'user' && !parseSynthetic(i.text)).map((u) => u.text);

describe('a refusal for the sign-in is not believed at once', () => {
  it('a failure followed by "signed in" is sent once more, silently', async () => {
    const { app, log, rt } = await setup();
    log.refuse = 1;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => log.sent.length === 2 && rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'the retry and its answer');
    expect(log.sent).toEqual(['hi there', 'hi there']);
    expect(notices(rt.items).filter((n) => n.variant === 'error')).toEqual([]);
    expect(people(rt.items)).toEqual(['hi there']);
    // The failed turn left no line of its own: one turn.
    expect(rt.items.filter((i) => i.type === 'turn')).toHaveLength(1);
  });

  it('a message sent and answered while the status is asked is never resumed nor stripped of its turn (review wave 16, #8)', async () => {
    const { app, log, rt } = await setup(400);
    log.refuse = 1;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => log.sent.length === 1 && rt.meta.status !== 'running', 'the refusal');
    // B goes out and finishes while the CLI is still being asked about A's refusal.
    await app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    await until(() => log.sent.length === 2 && rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), "B's answer");
    const turns = rt.items.filter((i) => i.type === 'turn').length;
    await new Promise((r) => setTimeout(r, 700));
    // Nothing more went out: no continuation for B, no A again; B keeps its closing line.
    expect(log.sent).toEqual(['hi there', 'hi again']);
    expect(rt.items.filter((i) => i.type === 'turn')).toHaveLength(turns);
    expect(notices(rt.items).filter((n) => n.variant === 'error')).toEqual([]);
  });

  it('a second refusal of the same message, still "signed in", is not retried again', async () => {
    const { app, log, rt } = await setup();
    log.refuse = 2;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => notices(rt.items).some((n) => n.variant === 'error'), 'the notice');
    expect(log.sent).toHaveLength(2);
    expect(notices(rt.items).filter((n) => n.variant === 'error')).toHaveLength(1);
  });

  it('"signed out" gives one notice however many requests failed, and signing in again carries on', async () => {
    const { app, log, rt, account, signIn, signOut } = await setup();
    signOut();
    log.refuse = 2;
    log.background = true;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => notices(rt.items).some((n) => !!n.auth), 'the sign-in notice');
    // The person tries again by hand: refused again, still one notice.
    await until(() => rt.meta.status !== 'running', 'idle');
    await app.call('session.send', { sessionId: rt.id, text: 'try again' });
    await until(() => log.sent.length === 2 && rt.meta.status !== 'running', 'second refusal');
    await new Promise((r) => setTimeout(r, 60));
    const auth = notices(rt.items).filter((n) => !!n.auth);
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ text: 'Signed out of Ultra1', auth: { state: 'signedOut', provider: 'demo', accountId: account.id, label: 'Ultra1' } });
    expect(notices(rt.items).filter((n) => n.variant === 'error' && !n.auth)).toEqual([]);
    // Signed in again (as Settings › Accounts reads it): the chat carries on by itself.
    signIn();
    await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
    await until(() => log.sent.length === 3 && rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'carried on');
    expect(notices(rt.items).filter((n) => !!n.auth)).toEqual([]);
    // The turn had done work (a sub-agent was refused with it): a carry-on of Sable's own, naming it.
    expect(log.sent[2]).toContain(RESUME_AFTER_SIGN_IN);
    expect(log.sent[2]).toContain('Map auth error responses');
    expect(people(rt.items)).toEqual(['hi there', 'try again']);
  });
});
