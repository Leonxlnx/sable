/**
 * Turn accounting when a provider cannot tell which turn is which (review wave 6):
 * - #11: Claude Code. A message it took without a replay still owes its result after a stop's safety
 *   net, so the next message goes to a new process; with background tasks running in the old one, the
 *   next message waits (held) until that result is told apart, and can be stopped; a stop Claude Code
 *   never confirmed ends the turn only by closing its process.
 * - #12: Codex. A start never goes while a stopped start's turn is not told apart (a failed or lagging
 *   store) or not over (its interrupt failed or is slow); a start whose answer names its turn tells the
 *   two apart itself; a taken stop is settled by what the thread says of exactly that turn, never a timer.
 * Fakes only: the Claude Code adapter on a fake SDK stream, the Codex adapter on a fake app-server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, TurnItem, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import type { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderSession } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
function gate<T = unknown>() {
  let open!: (v: T) => void;
  const shut = new Promise<T>((r) => (open = r));
  return { wait: () => shut, open };
}
const notices = (rt: SessionRuntime) => rt.items.filter((i): i is NoticeItem => i.type === 'notice');

// ── Claude Code: the real adapter, its process replaced by a fake SDK stream ──

type Session = Record<string, unknown> & ProviderSession;
type Pushed = { uuid: string; priority?: string; message: { content: unknown } };

function fakeProcess(pushed: Pushed[], interrupt: () => Promise<void>) {
  const buf: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    closed: () => closed,
    out(m: unknown) {
      buf.push(m);
      wake?.();
    },
    q: {
      interrupt,
      close: () => void (closed = true),
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (buf.length) yield buf.shift();
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      },
    },
    input: { push: (m: Pushed) => pushed.push(m), end: () => {} },
  };
}

/** Every process is read by the adapter's own loop (`pump`): what a test writes to one process reaches the chat only while that process is the chat's. */
async function claudeApp(opts: { interrupt?: () => Promise<void> } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-turns-w6-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const pushed: Pushed[] = [];
  const procs: ReturnType<typeof fakeProcess>[] = [];
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    providers: [
      (ctx) => {
        const p = new ClaudeProvider(ctx);
        const any = p as unknown as Record<string, unknown>;
        any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
        any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
        any.limits = async () => [];
        any.readLimits = async () => [];
        p.quickTitle = async () => 'A title';
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Session;
          s.ensure = function (this: Record<string, unknown>) {
            if (this.q) return this.q;
            const proc = fakeProcess(pushed, opts.interrupt ?? (async () => {}));
            procs.push(proc);
            this.q = proc.q;
            this.input = proc.input;
            void (this.pump as (q: unknown) => Promise<void>).call(this, proc.q);
            return this.q;
          };
          return s as unknown as ProviderSession;
        };
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'claude', cwd, mode: 'default' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  const message = async (m: Record<string, unknown>, proc = procs.at(-1)) => {
    proc!.out({ session_id: 'cc1', ...m });
    await tick(5);
  };
  const send = async (text: string) => {
    const n = pushed.length;
    await app.call('session.send', { sessionId: id, text });
    await until(() => pushed.length > n, `"${text}" sent`);
    return pushed.at(-1)!.uuid;
  };
  const replay = (uuid: string, content: string, proc = procs.at(-1)) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content } }, proc);
  /** A result of a CLI that names no messages. */
  const result = (failed = false, proc = procs.at(-1)) =>
    message({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, ...(failed ? { errors: ['Tool execution failed'] } : {}), duration_ms: 10, usage: {}, total_cost_usd: 0 }, proc);
  const system = (m: Record<string, unknown>, proc = procs.at(-1)) => message({ type: 'system', ...m }, proc);
  const stop = () => app.call('session.interrupt', { sessionId: id });
  const turns = () => rt.items.filter((i): i is TurnItem => i.type === 'turn' && !i.parentId);
  return { app, id, rt, pushed, procs, send, replay, result, system, stop, turns };
}

/** A turn the safety net settled on a stream that names no messages, with background task `t1` running in its process. */
async function settledWithTask() {
  const h = await claudeApp();
  const a = await h.send('first');
  await h.replay(a, 'first');
  await h.system({ subtype: 'task_started', task_id: 't1' });
  await h.stop();
  await until(() => !h.rt.turnActive, 'the safety net', 4000);
  // The next message: its result could not be told from the first's, and the process cannot be let go.
  await h.app.call('session.send', { sessionId: h.id, text: 'second' });
  await tick();
  expect(h.rt.turnActive).toBe(true);
  expect(h.rt.meta.activity).toBe('Waiting for the stopped turn to end');
  expect(h.pushed).toHaveLength(1);
  return h;
}

describe('#11: a Claude Code result that cannot be told apart', () => {
  it('a message taken without a replay still owes its result: the next message goes to a new process, and its own result ends it', async () => {
    const h = await claudeApp();
    await h.send('first');
    // Never replayed; the stop's safety net settles the turn.
    await h.stop();
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    await h.send('second');
    expect(h.procs).toHaveLength(2);
    expect(h.procs[0].closed()).toBe(true);
    // The first process answers the first message late, naming nothing: it reaches nothing here.
    await h.result(true, h.procs[0]);
    expect(h.rt.turnActive).toBe(true);
    expect(h.turns()).toHaveLength(0);
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('a message withdrawn at the stop and read after all: its own result ends the turn it begins', async () => {
    const h = await claudeApp();
    const a = await h.send('first');
    await h.stop();
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    // Claude Code takes it after all, on the same process.
    await h.replay(a, 'first');
    expect(h.rt.turnActive).toBe(true);
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('with a background task running, the next message waits; the process going idle sends it there', async () => {
    const h = await settledWithTask();
    await h.system({ subtype: 'session_state_changed', state: 'idle' });
    expect(h.pushed).toHaveLength(2);
    expect(h.procs).toHaveLength(1);
    expect(h.rt.meta.activity).toBe('Thinking');
    await h.replay(h.pushed[1].uuid, 'second');
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it("the owed result arriving sends the waiting message; that result never ends the message's turn", async () => {
    const h = await settledWithTask();
    // The first turn's late result.
    await h.result(true);
    expect(h.pushed).toHaveLength(2);
    expect(h.rt.turnActive).toBe(true);
    expect(h.turns()).toHaveLength(0);
    await h.replay(h.pushed[1].uuid, 'second');
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('the last background task ending lets the old process go: the waiting message goes to a new one', async () => {
    const h = await settledWithTask();
    await h.system({ subtype: 'task_notification', task_id: 't1', status: 'completed' });
    expect(h.procs).toHaveLength(2);
    expect(h.procs[0].closed()).toBe(true);
    expect(h.pushed).toHaveLength(2);
    // What the old process still writes reaches nothing.
    await h.result(true, h.procs[0]);
    expect(h.rt.turnActive).toBe(true);
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('a waiting message can be stopped: nothing reaches Claude Code, it stays in the conversation, stopped, and the task keeps running', async () => {
    const h = await settledWithTask();
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    expect(h.pushed).toHaveLength(1);
    expect(h.procs[0].closed()).toBe(false);
    expect(notices(h.rt).filter((n) => n.variant === 'interrupted')).toHaveLength(2);
    expect(h.rt.items.some((i) => i.type === 'user' && i.text === 'second')).toBe(true);
    // Nothing it held is sent later either.
    await h.system({ subtype: 'session_state_changed', state: 'idle' });
    expect(h.pushed).toHaveLength(1);
  }, 10_000);

  it('a stop Claude Code never confirmed keeps the turn until its process is closed; nothing of that process reaches the next turn', async () => {
    const h = await claudeApp({ interrupt: () => Promise.reject(new Error('interrupt failed')) });
    const a = await h.send('first');
    await h.replay(a, 'first');
    await h.stop();
    expect(h.rt.turnActive).toBe(true);
    await until(() => !h.rt.turnActive, 'the process closed', 4000);
    expect(h.procs[0].closed()).toBe(true);
    expect(notices(h.rt).some((n) => n.variant === 'interrupted')).toBe(true);
    await h.send('second');
    expect(h.procs).toHaveLength(2);
    await h.result(true, h.procs[0]);
    expect(h.rt.turnActive).toBe(true);
    await h.result();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('an unconfirmed stop whose result comes within the grace ends by that result, the process kept', async () => {
    const h = await claudeApp({ interrupt: () => Promise.reject(new Error('interrupt failed')) });
    const a = await h.send('first');
    await h.replay(a, 'first');
    await h.stop();
    await h.result(true);
    expect(h.rt.turnActive).toBe(false);
    await tick(2700);
    expect(h.procs[0].closed()).toBe(false);
  }, 10_000);
});

// ── Codex: the real adapter on a fake app-server ──

type Answers = Partial<Record<string, (params: Record<string, unknown>, n: number) => unknown>>;

async function codexFake(answers: Answers = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-w6-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const seen = new Map<string, number>();
  let threads = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const n = (seen.get(method) ?? 0) + 1;
      seen.set(method, n);
      const own = answers[method];
      if (own) return own(params, n);
      if (method === 'thread/start') return { thread: { id: `th${++threads}`, model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return { thread: { id: String(params.threadId), model: 'm' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: `turn${n}` } };
      if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
      return {};
    },
  };
  let provider!: CodexProvider;
  const app = new App({
    home,
    providers: [
      (ctx) => {
        const p = new CodexProvider(ctx);
        const anyP = p as unknown as Record<string, unknown>;
        anyP.client = async () => rpc;
        anyP.version = async () => ({ installed: true, version: '1' });
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true, compact: true } });
        provider ??= p;
        return p;
      },
    ],
    quiet: true,
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'default', model: 'm' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  const notify = (method: string, p: Record<string, unknown>) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, { threadId: 'th1', ...p });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  const session = () => [...provider.sessions.values()][0] as unknown as Record<string, unknown>;
  return {
    app,
    id,
    rt,
    calls,
    count,
    session,
    started: (turn: string) => notify('turn/started', { turn: { id: turn, status: 'inProgress', items: [] } }),
    complete: (turn: string, s = 'completed') => notify('turn/completed', { turn: { id: turn, status: s, items: [] } }),
    idle: () => notify('thread/status/changed', { status: { type: 'idle' } }),
    lastTurn: () => rt.items.findLast((i): i is TurnItem => i.type === 'turn'),
    send: (text: string) => app.call('session.send', { sessionId: id, text }),
    stop: () => app.call('session.interrupt', { sessionId: id }),
    interrupts: (turnId: string) => calls.filter((c) => c.method === 'turn/interrupt' && c.params.turnId === turnId).length,
  };
}

type Codex = Awaited<ReturnType<typeof codexFake>>;

/** A /compact stopped after its start answered with no turn id: its turn, if any, is not told apart. */
async function strayCompaction(h: Codex) {
  void h.send('/compact');
  await until(() => h.count('thread/compact/start') === 1, 'the first compaction');
  await tick();
  await h.stop();
  expect(h.rt.turnActive).toBe(false);
  h.session().strayRecheckMs = [15, 15];
}

describe("#12: Codex never guesses which turn a stopped start's is", () => {
  it("a failed store: the next command waits, and its own turn, shown before its answer, is never stopped as the first's", async () => {
    const second = gate();
    const h = await codexFake({
      'thread/compact/start': async (_p, n) => (n === 2 ? (await second.wait(), {}) : {}),
      'thread/turns/list': () => Promise.reject(new Error('thread/turns/list failed')),
    });
    await strayCompaction(h);
    void h.send('/compact');
    await until(() => h.count('thread/turns/list') >= 2, 'the store asked again');
    // Asked every time with no answer and no turn of the first shown: it made none, and the second goes.
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    h.started('cmpB');
    second.open(undefined);
    await tick();
    expect(h.interrupts('cmpB')).toBe(0);
    expect(h.rt.turnActive).toBe(true);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("a failed store: the first's turn showing itself while the next command waits is stopped, and the next goes only once it ended", async () => {
    const h = await codexFake({ 'thread/turns/list': () => Promise.reject(new Error('thread/turns/list failed')) });
    await strayCompaction(h);
    h.session().strayRecheckMs = [200, 200, 200];
    void h.send('/compact');
    await until(() => h.count('thread/turns/list') >= 1, 'the store asked');
    h.started('cmpA');
    await tick();
    expect(h.interrupts('cmpA')).toBe(1);
    await tick(60);
    expect(h.count('thread/compact/start')).toBe(1);
    h.complete('cmpA', 'interrupted');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    h.started('cmpB');
    await tick();
    expect(h.interrupts('cmpB')).toBe(0);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("an empty store that lags: the first's turn, listed on a later ask, is stopped before the next command goes", async () => {
    const h = await codexFake({ 'thread/turns/list': (_p, n) => (n === 1 ? { data: [] } : { data: [{ id: 'cmpA', status: 'inProgress', items: [] }] }) });
    await strayCompaction(h);
    void h.send('/compact');
    await until(() => h.interrupts('cmpA') === 1, 'the first stopped');
    await tick(60);
    expect(h.count('thread/compact/start')).toBe(1);
    // Its late news is nobody's; its end lets the second go.
    h.started('cmpA');
    h.complete('cmpA', 'interrupted');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    expect(h.rt.turnActive).toBe(true);
    h.started('cmpB');
    await tick();
    expect(h.interrupts('cmpB')).toBe(0);
    h.complete('cmpB');
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("an empty store: a message goes at once, and the first's turn showing itself later is stopped, never taken for the message's", async () => {
    const second = gate();
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [] }), 'turn/start': async () => (await second.wait(), { turn: { id: 'turn1' } }) });
    await strayCompaction(h);
    void h.send('next');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.started('cmpA');
    second.open(undefined);
    await tick();
    expect(h.interrupts('cmpA')).toBe(1);
    h.started('turn1');
    h.complete('cmpA', 'interrupted');
    expect(h.rt.turnActive).toBe(true);
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("a stopped start's turn whose interrupt failed: the next message waits until Codex ends it", async () => {
    const h = await codexFake({
      'turn/interrupt': () => Promise.reject(new Error('turn/interrupt failed')),
      'thread/turns/list': () => ({ data: [{ id: 'cmpA', status: 'inProgress', items: [] }] }),
    });
    await strayCompaction(h);
    h.started('cmpA');
    await tick();
    expect(h.interrupts('cmpA')).toBe(1);
    void h.send('next');
    await until(() => notices(h.rt).some((n) => n.text === 'Codex has not ended the stopped turn'), 'the wait said');
    expect(h.count('turn/start')).toBe(0);
    expect(h.rt.turnActive).toBe(true);
    h.complete('cmpA');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.started('turn1');
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it('a message waiting for a stopped turn can be stopped: it never goes, and that turn is asked to stop again', async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'cmpA', status: 'inProgress', items: [] }] }) });
    await strayCompaction(h);
    h.started('cmpA');
    void h.send('next');
    await until(() => h.rt.meta.activity === 'Waiting for the stopped turn to end', 'the wait shown');
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    expect(h.interrupts('cmpA')).toBe(2);
    await tick(80);
    expect(h.count('turn/start')).toBe(0);
  });

  it('the thread going idle ends the wait for a stopped turn', async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'cmpA', status: 'inProgress', items: [] }] }) });
    await strayCompaction(h);
    h.started('cmpA');
    void h.send('next');
    await until(() => h.count('thread/turns/list') >= 1, 'the store asked');
    h.idle();
    await until(() => h.count('turn/start') === 1, 'turn/start');
  });

  it('a taken stop whose end is slow: the turn stays open, stopping, until the thread says how it ended', async () => {
    const h = await codexFake({ 'thread/turns/list': (_p, n) => ({ data: [{ id: 'turn1', status: n < 2 ? 'inProgress' : 'interrupted', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().interruptMs = 30;
    h.session().idleRecheckMs = [60];
    await h.stop();
    await until(() => h.count('thread/turns/list') === 1, 'the store asked');
    await tick();
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.meta.activity).toBe('Stopping');
    await until(() => !h.rt.turnActive, 'the stored end', 1000);
    expect(h.lastTurn()?.stopReason).toBe('interrupted');
  });

  it('a taken stop the thread keeps as running is never ended by a timer: the person is told, and its own end ends it', async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().interruptMs = 20;
    h.session().idleRecheckMs = [20];
    await h.stop();
    await until(() => notices(h.rt).some((n) => n.text === 'Codex has not stopped this turn yet'), 'the person told');
    expect(h.rt.turnActive).toBe(true);
    h.complete('turn1', 'interrupted');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('interrupted');
  });
});
