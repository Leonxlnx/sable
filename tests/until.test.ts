/**
 * Until green (`/until <check>`): the command's parsing, what is kept of a check's output, the
 * loop's state machine against a fake check runner (rounds, every stop, pauses, a check giving way
 * to a turn, usage across a window reset), and the whole loop in the App with the Demo agent and a
 * real check: queued messages first, three rounds to green, and the line a restart leaves.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, SessionMeta, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { countResults, digest, endLine, failureMessage, notFound, parseUntil, runCheck, UntilLoops, type CheckOutcome, type UntilHost } from '../server/core/until';
import { DemoProvider } from '../server/providers/demo';
import { pickScenario } from '../server/providers/demo-scenarios';
import { groupTurns, shapeOf, type TurnGroup } from '@/features/timeline/turns';

async function until(pred: () => boolean, what: string, ms = 8000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// ─────────────────────────────────── the command ───────────────────────────────────

describe('parseUntil', () => {
  it('reads the check with the default rounds and usage', () => {
    expect(parseUntil('pnpm test')).toEqual({ args: { check: 'pnpm test', rounds: 5, usage: 10 } });
    expect(parseUntil('  pnpm exec tsc --noEmit  ')).toEqual({ args: { check: 'pnpm exec tsc --noEmit', rounds: 5, usage: 10 } });
  });

  it('takes --rounds and --usage anywhere, capped', () => {
    expect(parseUntil('pnpm test --rounds 8')).toEqual({ args: { check: 'pnpm test', rounds: 8, usage: 10 } });
    expect(parseUntil('--rounds=3 pnpm test --usage 15%')).toEqual({ args: { check: 'pnpm test', rounds: 3, usage: 15 } });
    expect(parseUntil('pnpm test --rounds 99')).toMatchObject({ args: { rounds: 20 } });
    expect(parseUntil('pnpm test --rounds two')).toHaveProperty('error');
    expect(parseUntil('pnpm test --usage 0')).toHaveProperty('error');
  });

  it('keeps flags that belong to the check, and strips one pair of backticks', () => {
    expect(parseUntil('pnpm test -- --run')).toMatchObject({ args: { check: 'pnpm test -- --run' } });
    expect(parseUntil('`pnpm test`')).toMatchObject({ args: { check: 'pnpm test' } });
  });

  it('knows off, and asks for a check', () => {
    expect(parseUntil('off')).toEqual({ off: true });
    expect(parseUntil('STOP')).toEqual({ off: true });
    expect(parseUntil('')).toHaveProperty('error');
    expect(parseUntil('--rounds 3')).toHaveProperty('error');
  });
});

// ─────────────────────────────────── the output ───────────────────────────────────

const VITEST_FAIL = [
  '',
  '> relay-api@0.9.2 test',
  '> vitest run',
  '',
  '\u001b[1m RUN \u001b[22m v2.1.4 /r',
  '',
  ' \u001b[32m✓\u001b[39m tests/tokens.test.ts (6 tests) 14ms',
  ' ✓ tests/session.test.ts (9 tests) 21ms',
  ' ❯ tests/auth.test.ts (4 tests | 1 failed) 48ms',
  '   × requireAuth > rejects unknown session tokens 9ms',
  "     → expected { error: 'session_missing' } to deeply equal { error: 'invalid_session' }",
  ' ✓ tests/routes.test.ts (6 tests) 112ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/auth.test.ts > requireAuth > rejects unknown session tokens',
  "AssertionError: expected { error: 'session_missing' } to deeply equal { error: 'invalid_session' }",
  ' ❯ tests/auth.test.ts:41:32',
  '',
  ' Test Files  1 failed | 3 passed (4)',
  '      Tests  1 failed | 24 passed (25)',
  '   Duration  1.42s',
].join('\r\n');

describe('digest', () => {
  it('keeps the failures and the summary, without colour or passing lines', () => {
    const d = digest(VITEST_FAIL);
    expect(d.failing).toBe(1);
    expect(d.passing).toBe(24);
    expect(d.text).not.toMatch(/\u001b|✓|vitest run|RUN/);
    expect(d.text.split('\n')[0]).toContain('tests/auth.test.ts (4 tests | 1 failed)');
    expect(d.text).toContain('AssertionError');
    expect(d.text).toContain('Tests  1 failed | 24 passed (25)');
  });

  it('counts what other runners and compilers report', () => {
    expect(countResults('Tests:       2 failed, 10 passed, 12 total')).toEqual({ failing: 2, passing: 10 });
    expect(countResults('  10 passing (2s)\n  2 failing')).toEqual({ failing: 2, passing: 10 });
    expect(countResults('===== 3 failed, 41 passed in 2.31s =====')).toEqual({ failing: 3, passing: 41 });
    expect(countResults('test result: FAILED. 7 passed; 1 failed; 0 ignored')).toEqual({ failing: 1, passing: 7 });
    expect(countResults('src/a.ts(3,5): error TS2322: x\nsrc/b.ts(9,1): error TS2304: y')).toEqual({ failing: 2 });
    expect(countResults('src/a.ts:3:5 - error TS2322: x\n\nFound 4 errors in 2 files.')).toEqual({ failing: 4 });
    expect(countResults('✖ 5 problems (3 errors, 2 warnings)')).toEqual({ failing: 3 });
    expect(countResults('      Tests  25 passed (25)')).toEqual({ failing: 0, passing: 25 });
    expect(countResults('all good')).toEqual({});
  });

  it('keeps the head of a long failure and its end, within 60 lines and 4 KB', () => {
    const lines = ['starting', ' FAIL  first.test.ts', ...Array.from({ length: 400 }, (_, i) => `  at frame ${i} ${'x'.repeat(40)}`), ' Tests  12 failed | 3 passed (15)'];
    const d = digest(lines.join('\n'));
    const out = d.text.split('\n');
    expect(out.length).toBeLessThanOrEqual(61);
    expect(d.text.length).toBeLessThanOrEqual(4100);
    expect(d.text).toContain('FAIL  first.test.ts');
    expect(out[out.length - 1]).toContain('12 failed');
    expect(d.text).toMatch(/… (\d+ lines|cut)/);
    expect(d.failing).toBe(12);
  });

  it('without a failure line keeps the last lines; a redrawn line keeps what it ended as', () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const d = digest(many);
    expect(d.text.split('\n')).toHaveLength(61);
    expect(d.text).toContain('line 99');
    expect(d.text).not.toContain('line 10\n');
    expect(digest('progress 10%\rprogress 100%\nexit').text).toBe('progress 100%\nexit');
    expect(digest('').text).toBe('');
  });
});

describe('what is said', () => {
  it('sends the failure with its round, and a fence the output cannot close', () => {
    const text = failureMessage({ command: 'pnpm test', round: 2, rounds: 5, passed: false, exitCode: 1, failing: 3, durationMs: 900, output: 'a ``` b' });
    expect(text).toMatch(/^The check `pnpm test` failed \(exit code 1, 3 failing\)\. Fix the cause, not the check\. When your turn ends, Sable runs it again \(round 3 of 5\)\./);
    expect(text).toContain('````text\na ``` b\n````');
    expect(failureMessage({ command: 'x', round: 1, rounds: 5, passed: false, timedOut: true, exitCode: null, durationMs: 1 })).toContain('did not finish within 10 minutes');
  });

  it('ends in one calm line', () => {
    expect(endLine('passed', 3)).toBe('Green after 3 rounds');
    expect(endLine('passed', 1)).toBe('Green after 1 round');
    expect(endLine('rounds', 5, { failing: 2 })).toBe('Stopped after 5 rounds: 2 still failing');
    expect(endLine('usage', 3, { used: 10.4, account: 'Ultra1' })).toBe("Stopped after 3 rounds: this loop used 10% of Ultra1's week");
    expect(endLine('stopped', 0)).toBe('Stopped before the first check');
    expect(endLine('restart', 2)).toBe('Stopped after 2 rounds: Sable closed');
  });
});

// ─────────────────────────────────── the loop ───────────────────────────────────

const pass = (out = '      Tests  25 passed (25)'): CheckOutcome => ({ code: 0, output: out, durationMs: 40 });
const fail = (n: number): CheckOutcome => ({ code: 1, output: ` FAIL  a.test.ts\n      Tests  ${n} failed | ${25 - n} passed (25)`, durationMs: 40 });

/** A loop on a real runtime with a fake check runner; the "agent" is the test, which ends turns. */
function harness(outcomes: CheckOutcome[], o: { weekly?: () => { percent: number; resetsAt?: number } | undefined; capped?: () => string | undefined; slow?: boolean } = {}) {
  const meta: SessionMeta = {
    id: 's1',
    provider: 'demo',
    cwd: '/r',
    title: 'New session',
    titleSource: 'auto',
    model: 'demo-large',
    mode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const sent: UserItem[] = [];
  const runs: string[] = [];
  let release: (() => void) | undefined;
  const host: UntilHost = {
    busy: (r) => r.turnActive,
    settle: async () => {},
    weekly: async () => o.weekly?.(),
    capped: async () => o.capped?.(),
    accountLabel: () => 'Ultra1',
    send: async (r, text, mark) => {
      sent.push(r.add<UserItem>({ type: 'user', text, state: 'sent', until: mark }));
      r.beginTurn();
    },
    run: (command, _cwd, signal) => {
      runs.push(command);
      const next = outcomes.shift() ?? fail(1);
      if (!o.slow) return Promise.resolve(next);
      return new Promise((resolve) => {
        release = () => resolve(next);
        signal.addEventListener('abort', () => resolve({ code: null, output: '', durationMs: 1, aborted: true }), { once: true });
      });
    },
    log: () => {},
  };
  const loops = new UntilLoops(host);
  rt.onTurnStart = (r) => loops.turnStarted(r);
  const notices = () => rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.until);
  return {
    rt,
    loops,
    sent,
    runs,
    notices,
    release: () => release?.(),
    /** The agent's turn ends normally with nothing queued (what the app tells the loop). */
    endTurn: () => {
      rt.endTurn();
      loops.turnOver(rt);
      loops.turnEnded(rt);
    },
    arm: (text: string) => {
      const p = parseUntil(text);
      if (!('args' in p)) throw new Error('bad');
      return loops.arm(rt, p.args);
    },
  };
}

describe('the loop', () => {
  it('idle: checks at once, sends each failure, and goes green on round 3', async () => {
    const h = harness([fail(3), fail(1), pass()]);
    h.arm('pnpm test');
    await until(() => h.sent.length === 1, 'first failure');
    expect(h.sent[0].until?.check).toMatchObject({ round: 1, rounds: 5, passed: false, failing: 3, exitCode: 1 });
    expect(h.sent[0].text).toMatch(/^The check `pnpm test` failed/);
    expect(h.rt.meta.until).toMatchObject({ check: 'pnpm test', round: 2, phase: 'working', failing: 3 });
    h.endTurn();
    await until(() => h.sent.length === 2, 'second failure');
    expect(h.sent[1].until?.check).toMatchObject({ round: 2, failing: 1 });
    h.endTurn();
    await until(() => h.notices().length === 1, 'the end');
    const end = h.notices()[0];
    expect(end.text).toBe('Green after 3 rounds');
    expect(end.until).toMatchObject({ end: 'passed', check: { passed: true, round: 3, passing: 25 } });
    expect(h.rt.meta.until).toBeFalsy();
    expect(h.runs).toHaveLength(3);
  });

  it('armed mid-turn: waits for the turn to end', async () => {
    const h = harness([pass()]);
    h.rt.beginTurn();
    expect(h.arm('pnpm test')).toMatchObject({ phase: 'working', round: 1 });
    await tick();
    expect(h.runs).toHaveLength(0);
    h.endTurn();
    await until(() => h.notices().length === 1, 'green');
    expect(h.notices()[0].text).toBe('Green after 1 round');
  });

  it('stops at the round limit with what still fails', async () => {
    const h = harness([fail(3), fail(2)]);
    h.arm('pnpm test --rounds 2');
    await until(() => h.sent.length === 1, 'first failure');
    h.endTurn();
    await until(() => h.notices().length === 1, 'the end');
    expect(h.notices()[0].text).toBe('Stopped after 2 rounds: 2 still failing');
    expect(h.notices()[0].until).toMatchObject({ end: 'rounds', check: { round: 2, failing: 2 } });
    expect(h.sent).toHaveLength(1);
    expect(h.rt.meta.until).toBeFalsy();
  });

  it('stops when the user says so, counting the rounds checked', async () => {
    const h = harness([fail(3)]);
    h.arm('pnpm test');
    await until(() => h.sent.length === 1, 'first failure');
    expect(h.loops.stop(h.rt)).toBe(true);
    expect(h.rt.meta.until).toBeFalsy();
    // Stopped while the agent works: the line goes in after its turn, not into it.
    expect(h.notices()).toHaveLength(0);
    h.endTurn();
    expect(h.notices()[0]).toMatchObject({ text: 'Stopped after 1 round', detail: 'pnpm test', until: { end: 'stopped' } });
    expect(h.rt.items.at(-1)).toBe(h.notices()[0]);
    await tick();
    expect(h.runs).toHaveLength(1);
    expect(h.loops.stop(h.rt)).toBe(false);
  });

  it('stops when the loop has used its share of the week', async () => {
    let percent = 40;
    const h = harness([fail(3), fail(2), fail(1)], { weekly: () => ({ percent, resetsAt: 9e12 }) });
    h.arm('pnpm test');
    await until(() => h.sent.length === 1, 'first failure');
    percent = 46;
    h.endTurn();
    await until(() => h.sent.length === 2, 'second failure');
    expect(h.rt.meta.until?.used).toBe(6);
    percent = 51;
    h.endTurn();
    await until(() => h.notices().length === 1, 'the end');
    expect(h.notices()[0].text).toBe("Stopped after 3 rounds: this loop used 11% of Ultra1's week");
    expect(h.notices()[0].until).toMatchObject({ end: 'usage', check: { round: 3, failing: 1 } });
    expect(h.sent).toHaveLength(2);
  });

  it('counts usage across a weekly reset, and with --usage', async () => {
    let w = { percent: 90, resetsAt: 1e12 };
    const h = harness([fail(3), fail(2), fail(1)], { weekly: () => w });
    h.arm('pnpm test --usage 12');
    await until(() => h.sent.length === 1, 'first failure');
    w = { percent: 97, resetsAt: 1e12 };
    h.rt.beginTurn();
    // The window resets during the turn: the 7 points before it still count.
    w = { percent: 3, resetsAt: 1e12 + 7 * 86_400_000 };
    h.endTurn();
    await until(() => h.sent.length === 2, 'second failure');
    expect(h.rt.meta.until?.used).toBe(10);
    w = { percent: 6, resetsAt: 1e12 + 7 * 86_400_000 };
    h.endTurn();
    await until(() => h.notices().length === 1, 'the end');
    expect(h.notices()[0].until?.end).toBe('usage');
  });

  it('stops at the account cap when no account takes over', async () => {
    const h = harness([fail(3)], { capped: () => 'Ultra1 reached its 95% cap' });
    h.arm('pnpm test');
    await until(() => h.notices().length === 1, 'the end');
    expect(h.notices()[0].text).toBe('Stopped after 1 round: Ultra1 reached its 95% cap');
    expect(h.sent).toHaveLength(0);
  });

  it('a stopped or failed turn pauses the loop until the next turn, or Check now', async () => {
    const h = harness([fail(3), fail(2), pass()]);
    h.arm('pnpm test');
    await until(() => h.sent.length === 1, 'first failure');
    // The user stops the turn: no check.
    h.rt.endTurn();
    h.loops.turnHeld(h.rt);
    await tick();
    expect(h.rt.meta.until?.phase).toBe('paused');
    expect(h.runs).toHaveLength(1);
    // Their next message's turn ends normally: the check runs (round 2).
    h.rt.beginTurn();
    expect(h.rt.meta.until?.phase).toBe('working');
    h.endTurn();
    await until(() => h.sent.length === 2, 'second failure');
    expect(h.sent[1].until?.check?.round).toBe(2);
    h.rt.endTurn('boom');
    h.loops.turnHeld(h.rt);
    expect(h.loops.checkNow(h.rt)).toBe(true);
    await until(() => h.notices().length === 1, 'green');
    expect(h.notices()[0].text).toBe('Green after 3 rounds');
  });

  it('a turn that starts while a check runs goes first; the check runs again after it, same round', async () => {
    const h = harness([fail(3), pass()], { slow: true });
    h.arm('pnpm test');
    await until(() => h.runs.length === 1, 'the check');
    expect(h.rt.meta.until?.phase).toBe('checking');
    // The user sends a message: the check gives way.
    h.rt.beginTurn();
    h.release();
    await tick();
    expect(h.sent).toHaveLength(0);
    expect(h.rt.meta.until).toMatchObject({ phase: 'working', round: 1 });
    h.endTurn();
    await until(() => h.runs.length === 2, 'the check again');
    h.release();
    await until(() => h.notices().length === 1, 'green');
    expect(h.notices()[0].text).toBe('Green after 1 round');
  });

  it('a check that cannot run ends the loop with its output', async () => {
    const h = harness([{ code: 1, output: "'pnpmm' is not recognized as an internal or external command,", durationMs: 5, missing: true }]);
    h.arm('pnpmm test');
    await until(() => h.notices().length === 1, 'the end');
    expect(h.notices()[0]).toMatchObject({ text: 'Stopped: the check could not run', until: { end: 'broken', check: { output: expect.stringContaining('not recognized') } } });
  });

  it('a new /until replaces the loop (with a line once a check ran); closing the session ends it without a word', async () => {
    const h = harness([fail(3), fail(3), fail(2)], { slow: true });
    h.arm('pnpm test');
    await until(() => h.runs.length === 1, 'the check');
    // Replaced before any check finished: nothing to say.
    h.arm('pnpm lint');
    expect(h.rt.meta.until).toMatchObject({ check: 'pnpm lint', round: 1 });
    await until(() => h.runs.length === 2, 'the new check');
    expect(h.notices()).toHaveLength(0);
    h.release();
    await until(() => h.sent.length === 1, 'its failure');
    // Replaced mid-turn after a round: its line follows the turn.
    h.arm('pnpm test --rounds 3');
    expect(h.rt.meta.until).toMatchObject({ check: 'pnpm test', rounds: 3, round: 1, phase: 'working' });
    h.endTurn();
    expect(h.notices().map((n) => n.text)).toEqual(['Stopped after 1 round']);
    await until(() => h.runs.length === 3, 'the replacing check');
    h.loops.closed(h.rt);
    h.release();
    await tick();
    expect(h.rt.meta.until).toBeFalsy();
    expect(h.notices()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('runs one check at a time across sessions', async () => {
    let running = 0;
    let most = 0;
    const host = (rt: SessionRuntime): UntilHost => ({
      busy: () => false,
      settle: async () => {},
      weekly: async () => undefined,
      capped: async () => undefined,
      accountLabel: () => 'x',
      send: async () => {},
      run: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        return pass();
      },
      log: () => void rt,
    });
    const meta = (id: string): SessionMeta => ({ id, provider: 'demo', cwd: '/r', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } });
    const rts = ['a', 'b', 'c'].map((id) => new SessionRuntime(meta(id), () => {}, () => {}));
    const loops = new UntilLoops(host(rts[0]));
    for (const rt of rts) loops.arm(rt, { check: 'x', rounds: 5, usage: 10 });
    await until(() => rts.every((rt) => !rt.meta.until), 'all green');
    expect(most).toBe(1);
  });
});

// ─────────────────────────────────── in the app ───────────────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function app(home = mkdtempSync(path.join(tmpdir(), 'sable-until-'))) {
  const userHome = mkdtempSync(path.join(tmpdir(), 'sable-until-user-'));
  cleanups.push(() => rmSync(userHome, { recursive: true, force: true }));
  const a = new App({ home, userHome, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  let disposed = false;
  const dispose = async () => {
    if (!disposed) await a.dispose();
    disposed = true;
  };
  cleanups.push(dispose);
  return { app: a, home, dispose };
}

describe('until green in the app (Demo agent, real check)', () => {
  it('the Demo scenario fails twice and goes green on round 3; a queued message goes before the check', async () => {
    const { app: a, home } = await app();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const cwd = path.join(home, 'relay-api');
    mkdirSync(cwd, { recursive: true });
    const snap = await a.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions' });
    const id = snap.session.id;
    const rt = a.runtime(id);
    await a.call('session.send', { sessionId: id, text: 'Set up the until green demo' });
    await until(() => !rt.turnActive && rt.meta.status === 'idle', 'the setup turn');
    expect(rt.suggestion).toBe('/until node check.mjs');

    // Armed while a turn runs, with a message queued behind it: the message goes first, then the check.
    await a.call('session.send', { sessionId: id, text: 'hello' });
    expect(rt.turnActive).toBe(true);
    const armed = await a.call('until.set', { sessionId: id, text: 'node check.mjs' });
    expect(armed).toMatchObject({ ok: true, until: { phase: 'working', round: 1, rounds: 5 } });
    await a.call('session.send', { sessionId: id, text: 'hi there' });
    expect(rt.queue).toHaveLength(1);

    await until(() => rt.items.some((i) => i.type === 'notice' && i.until?.end), 'the loop to end', 30_000);
    const users = rt.items.filter((i): i is UserItem => i.type === 'user');
    const texts = users.map((u) => (u.until ? `check ${u.until.check?.round}: ${u.until.check?.failing}` : u.text));
    expect(texts).toEqual(['Set up the until green demo', 'hello', 'hi there', 'check 1: 3', 'check 2: 1']);
    expect(users[3].text).toMatch(/^The check `node check\.mjs` failed \(exit code 1, 3 failing\)/);
    expect(users[3].until?.check?.output).toContain('Tests  3 failed | 22 passed (25)');
    const end = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.until);
    expect(end).toMatchObject({ text: 'Green after 3 rounds', until: { end: 'passed', check: { round: 3, passed: true, passing: 25 } } });
    expect(rt.meta.until).toBeFalsy();
    expect(rt.meta.status).toBe('idle');
  }, 40_000);

  it('/until off stops it; a loop armed when Sable closes says so when the session is opened again', async () => {
    const first = await app();
    const home = first.home;
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const snap = await first.app.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions' });
    const id = snap.session.id;
    expect(await first.app.call('until.set', { sessionId: id, text: '' })).toMatchObject({ ok: false, error: expect.stringContaining('/until pnpm test') });
    expect(await first.app.call('until.set', { sessionId: id, text: 'off' })).toEqual({ ok: false });

    // A check that takes a while, so the loop is still armed when Sable closes.
    await first.app.call('until.set', { sessionId: id, text: 'node -e "setTimeout(() => process.exit(1), 400)"' });
    const rt = first.app.runtime(id);
    expect(rt.meta.until?.phase).toBe('checking');
    await first.dispose();

    const second = await app(home);
    const meta = second.app.runtime(id).meta;
    expect(meta.until).toBeFalsy();
    const again = await second.app.call('session.snapshot', { sessionId: id });
    const line = again.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.until);
    expect(line).toMatchObject({ text: 'Stopped before the first check: Sable closed', detail: expect.stringContaining('node -e'), until: { end: 'restart' } });

    await second.app.call('until.set', { sessionId: id, text: 'node -e "setTimeout(() => process.exit(1), 400)"' });
    expect(await second.app.call('until.set', { sessionId: id, text: 'off' })).toEqual({ ok: true });
    expect(second.app.runtime(id).meta.until).toBeFalsy();
  }, 20_000);

  it('a message sent while the check runs goes first; the check runs again after its turn', async () => {
    const { app: a, home } = await app();
    // The check's process lets go of its folder a moment after it ends (Windows, a busy machine: under a
    // full parallel run two seconds were not enough). Waited for without blocking; a temporary folder
    // that still cannot be removed is left to the system, it is not what this test is about.
    cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 }).catch(() => {}));
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const snap = await a.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions' });
    const rt = a.runtime(snap.session.id);
    await a.call('until.set', { sessionId: rt.id, text: 'node -e "setTimeout(() => process.exit(1), 700)" --rounds 1' });
    expect(rt.meta.until?.phase).toBe('checking');
    await a.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => !!endOf(rt), 'the loop to end', 20_000);
    const kinds = rt.items.filter((i) => i.type !== 'thinking').map((i) => (i.type === 'user' ? `user:${i.until ? 'check' : i.text}` : i.type === 'notice' && i.until ? 'end' : i.type));
    // The message, its turn, then the one check: no failure went out over the message.
    expect(kinds[0]).toBe('user:hi');
    expect(kinds.indexOf('turn')).toBeGreaterThan(0);
    expect(kinds.at(-1)).toBe('end');
    expect(kinds.filter((k) => k.startsWith('user:'))).toEqual(['user:hi']);
    expect(endOf(rt)).toMatchObject({ text: 'Stopped after 1 round: still failing', until: { end: 'rounds', check: { round: 1 } } });
  }, 30_000);

  it('the Demo routes Sable\'s failure message to its fix scenario', () => {
    expect(pickScenario('The check `pnpm test` failed (exit code 1). Fix the cause, not the check.', 'default', 0).id).toBe('untilFix');
    expect(pickScenario('until green, please', 'default', 0).id).toBe('untilSetup');
  });
});

describe('in the conversation', () => {
  it("a loop's end line closes a turn left open (interrupted) and stands on its own", () => {
    expect(shapeOf({ id: 'x', ts: 0, type: 'notice', variant: 'info', text: 'Green after 3 rounds', until: { end: 'passed' } })).toBe('Z');
    const { groups } = groupTurns(['1', '2', '3', '4', '5', '6'], 'UwiZUw', true);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item', 'turn']);
    expect((groups[0] as TurnGroup).state).toBe('interrupted');
    expect((groups[2] as TurnGroup).state).toBe('running');
  });
});

// ─────────────────────────────────── accounts ───────────────────────────────────

/** An extra demo account signed in, with made-up plan limits in `profile` (light: weekly 22%, near: 74%). */
async function demoAccount(a: App, label: string, profile: 'light' | 'near') {
  const { account } = await a.call('account.add', { provider: 'demo', label });
  await setProfile(a, account, label, profile);
  await a.call('auth.refresh', { provider: 'demo', accountId: account.id });
  return account;
}

async function setProfile(a: App, account: { id: string; dir?: string }, label: string, profile: 'light' | 'near') {
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await a.call('provider.limits', { provider: 'demo', accountId: account.id });
}

/** A session on `accountId` with the until-green project set up (the Demo's first turn). */
async function project(a: App, home: string, accountId: string) {
  const cwd = path.join(home, 'relay-api');
  mkdirSync(cwd, { recursive: true });
  const snap = await a.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions', accountId });
  const rt = a.runtime(snap.session.id);
  await a.call('session.send', { sessionId: rt.id, text: 'Set up the until green demo' });
  await until(() => !rt.turnActive && rt.meta.status === 'idle', 'the setup turn');
  return rt;
}

const endOf = (rt: SessionRuntime) => rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.until?.end);

describe('until green across accounts', () => {
  it('survives the move to another account at a cap, and goes green there', async () => {
    const { app: a, home } = await app();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const studio = await demoAccount(a, 'Studio', 'light');
    const work = await demoAccount(a, 'Work', 'light');
    await a.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    const rt = await project(a, home, studio.id);
    // Studio climbs past its cap: the loop's first check waits for the move, and the loop goes on under Work.
    await setProfile(a, studio, 'Studio', 'near');
    await a.call('until.set', { sessionId: rt.id, text: 'node check.mjs' });
    await until(() => !!endOf(rt), 'the loop to end', 30_000);
    expect(rt.meta.accountId).toBe(work.id);
    expect(rt.items.some((i) => i.type === 'notice' && i.text === 'Moved to Work: Studio reached its 70% cap')).toBe(true);
    expect(endOf(rt)?.text).toBe('Green after 3 rounds');
  }, 40_000);

  it("stops when the loop has used its share of the account's week", async () => {
    const { app: a, home } = await app();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const studio = await demoAccount(a, 'Studio', 'light');
    const rt = await project(a, home, studio.id);
    await a.call('until.set', { sessionId: rt.id, text: 'node check.mjs' });
    // The week climbs from 22% to 74% while the check runs.
    await setProfile(a, studio, 'Studio', 'near');
    await until(() => !!endOf(rt), 'the loop to end', 30_000);
    expect(endOf(rt)).toMatchObject({ text: "Stopped after 1 round: this loop used 52% of Studio's week", until: { end: 'usage', check: { round: 1, failing: 3 } } });
    expect(rt.items.filter((i) => i.type === 'user' && i.until)).toHaveLength(0);
  }, 40_000);
});

// ─────────────────────────────────── running a check ───────────────────────────────────

describe('runCheck', () => {
  const signal = () => new AbortController().signal;

  it('runs through the shell in the folder, stdout and stderr together, with the exit code, no colour and CI set', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-until-run-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const o = await runCheck(`node -e "console.log(process.cwd()); console.log(process.env.NO_COLOR, !!process.env.CI); console.error('boom'); process.exit(3)"`, dir, signal());
    expect(o.code).toBe(3);
    expect(o.missing).toBeFalsy();
    const [cwd, env] = o.output.split(/\r?\n/);
    expect(path.resolve(cwd.trim()).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    expect(env.trim()).toBe('1 true');
    expect(o.output).toContain('boom');
  });

  it('kills a check that runs past its timeout, and one that is aborted', async () => {
    const t0 = Date.now();
    const slow = await runCheck('node -e "setTimeout(() => {}, 30000)"', tmpdir(), signal(), 500);
    expect(slow).toMatchObject({ code: null, timedOut: true });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const stopped = await runCheck('node -e "setTimeout(() => {}, 30000)"', tmpdir(), ctrl.signal);
    expect(stopped).toMatchObject({ code: null, aborted: true });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('knows a command the shell could not find, in any language', () => {
    expect(notFound('pnpmm test', 1, "'pnpmm' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n")).toBe(true);
    expect(notFound('pnpmm test', 1, 'Der Befehl "pnpmm" ist entweder falsch geschrieben oder\r\nkonnte nicht gefunden werden.\r\n')).toBe(true);
    expect(notFound('pnpmm test', 127, 'sh: 1: pnpmm: not found')).toBe(true);
    expect(notFound('pnpm test', 1, ' ERR_PNPM_NO_SCRIPT  Missing script: "test"')).toBe(false);
    expect(notFound('pnpm test', 1, VITEST_FAIL)).toBe(false);
    expect(notFound('pnpm test', 0, "'pnpm'")).toBe(false);
  });

  it('says when nothing could run: no such folder, or no such command', async () => {
    expect(await runCheck('node -v', path.join(tmpdir(), 'sable-until-no-such-folder'), signal())).toMatchObject({ missing: true });
    const none = await runCheck('sable-until-no-such-command-xyz', tmpdir(), signal());
    expect(none.code).not.toBe(0);
    expect(none.missing).toBe(true);
  });
});

