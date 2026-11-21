/**
 * Turn accounting after a stop, an idle and a late answer (review wave 5):
 * - #12: a Claude Code message with no result of its own when the turn went idle came to nothing
 *   known: it is never taken as ok, and a chat is named only from a message whose success is known.
 * - #13: a Claude Code turn the safety net settled owes a result for each message it had read, and
 *   one late result pays only its own; on a stream that has not shown it names what a result answers,
 *   the next message goes to a new process, so the next turn's results are always its own.
 * - #14: Codex: a start that fails after its turn ended never ends a newer turn; a Stop whose
 *   interrupt failed is settled by what the thread says of exactly that turn, never by a timer.
 * - #15: Codex: a start never goes out while a stopped start's turn is not told apart: the thread's
 *   store says which turn that was, so two starts that name no turn are never told apart by order.
 * Fakes only: the Claude Code adapter with a fake SDK stream, the Codex adapter on a fake app-server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeItem, SessionMeta, TurnItem, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ChatTitles } from '../server/core/titles';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderSession } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

// ── Claude Code: the real adapter, its process replaced by a fake SDK stream ──

type Session = Record<string, unknown> & ProviderSession;
type Pushed = { uuid: string; priority?: string; message: { content: unknown } };

/** One fake agent process: what the test writes to `out` comes out of its stream, as the SDK's would. */
function fakeProcess(pushed: Pushed[]) {
  const buf: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream = {
    closed: () => closed,
    out(m: unknown) {
      buf.push(m);
      wake?.();
    },
    q: {
      interrupt: async () => {},
      // The process is told to close; what it had written already may still be read.
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
  return stream;
}

/**
 * `streams`: each process gets a fake SDK stream read by the adapter's own loop (`pump`), and the
 * test writes to the process it means. Without: the adapter's message handler is called directly.
 */
async function claudeApp(opts: { streams?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-turns-w5-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const asked: string[] = [];
  const pushed: Pushed[] = [];
  const sessions: Session[] = [];
  /** Every agent process started, in order. */
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
        p.quickTitle = async (prompt) => (asked.push(prompt.user), 'A title');
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Session;
          s.ensure = function (this: Record<string, unknown>) {
            if (this.q) return this.q;
            const proc = fakeProcess(pushed);
            procs.push(proc);
            this.q = proc.q;
            this.input = proc.input;
            if (opts.streams) void (this.pump as (q: unknown) => Promise<void>).call(this, proc.q);
            return this.q;
          };
          sessions.push(s);
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
  /** A message from the agent process `proc` (the newest by default). */
  const message = (m: Record<string, unknown>, proc = procs.at(-1)) => {
    const full = { session_id: 'cc1', ...m };
    if (opts.streams) proc!.out(full);
    else (sessions[0].onMessage as (m: unknown) => void).call(sessions[0], full);
  };
  const settle = () => (opts.streams ? tick(5) : Promise.resolve());
  const send = async (text: string, steer = false) => {
    const n = pushed.length;
    await app.call('session.send', { sessionId: id, text, ...(steer ? { steer: true } : {}) });
    await until(() => pushed.length > n, `"${text}" sent`);
    return pushed.at(-1)!.uuid;
  };
  const replay = (uuid: string, content: string) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content } });
  const text = (t: string) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
  /** A result naming `uuids`; `null`: one of a CLI that names no messages. */
  const resultMsg = (uuids: string[] | null, failed = false) => ({
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    ...(failed ? { errors: ['Tool execution failed'] } : {}),
    duration_ms: 10,
    usage: {},
    total_cost_usd: 0,
    ...(uuids ? { user_message_uuids: uuids, user_message_uuid: uuids.at(-1) } : {}),
  });
  const result = (uuids: string[] | null, failed = false, proc = procs.at(-1)) => message(resultMsg(uuids, failed), proc);
  const state = (s: 'idle' | 'running') => message({ type: 'system', subtype: 'session_state_changed', state: s });
  const stop = () => app.call('session.interrupt', { sessionId: id });
  const turns = () => rt.items.filter((i): i is TurnItem => i.type === 'turn' && !i.parentId);
  const user = (t: string) => rt.items.find((i): i is UserItem => i.type === 'user' && i.text === t);
  return { app, id, rt, asked, pushed, procs, send, replay, text, result, state, stop, turns, user, settle };
}

describe('#12: a Claude Code message with no result of its own at idle', () => {
  it('a steer read but not answered when the turn went idle is never ok, and never names the chat', async () => {
    const h = await claudeApp();
    const cmd = await h.send('/cost');
    const steer = await h.send('Fix the login button that does nothing', true);
    h.replay(cmd, '/cost');
    h.replay(steer, 'Fix the login button that does nothing');
    // The command's own result, ok; the steer it read keeps the turn going.
    h.result([cmd]);
    expect(h.rt.turnActive).toBe(true);
    // Idle before the steer's own result: the turn ends, the steer's outcome unknown.
    h.state('idle');
    expect(h.rt.turnActive).toBe(false);
    expect(h.user('Fix the login button that does nothing')?.state).toBe('sent');
    await tick(60);
    expect(h.asked).toEqual([]);
    // Its result comes later, failed: still nothing named from it.
    h.result([steer], true);
    await tick(60);
    expect(h.asked).toEqual([]);
  });

  function titled(outcome?: 'pending' | 'ok' | 'failed') {
    const meta = { id: 's1', provider: 'claude', cwd: '.', title: 'Fix the login button', titleSource: 'auto', status: 'idle', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } } as unknown as SessionMeta;
    const rt = new SessionRuntime(meta, () => {}, () => {});
    const msg = rt.add<UserItem>({ type: 'user', text: 'Fix the login button that does nothing', state: 'sent' } as UserItem);
    rt.add<TurnItem>({ type: 'turn', durationMs: 10 } as TurnItem);
    if (outcome === 'pending') rt.expectOutcome(msg.id);
    else if (outcome) rt.answered([msg.id], outcome);
    const asked: string[] = [];
    const titles = new ChatTitles({ settings: () => ({}), model: () => async (p) => (asked.push(p.user), 'A title'), open: () => true, log: () => {} });
    cleanups.push(() => titles.dispose());
    titles.turnEnded(rt, [msg.id]);
    return asked;
  }

  it('the title model gets a message only on its agent\'s word that it went ok', async () => {
    // Handed to an agent that answers each message, with no word: not named, whatever the caller says.
    const pending = titled('pending');
    const failed = titled('failed');
    // Its word that it went ok; and an agent that says nothing per message (it goes by the turn).
    const ok = titled('ok');
    const turn = titled();
    await tick(20);
    expect(pending).toEqual([]);
    expect(failed).toEqual([]);
    expect(ok).toHaveLength(1);
    expect(turn).toHaveLength(1);
  });
});

describe('#13: results owed by a turn the safety net settled', () => {
  it('one late result pays only for its own message: the other message read still owes one', async () => {
    const h = await claudeApp();
    // This CLI names what each result answers (its first turn said so).
    const z = await h.send('hello');
    h.replay(z, 'hello');
    h.result([z]);
    expect(h.rt.turnActive).toBe(false);
    const a = await h.send('first');
    h.replay(a, 'first');
    const a2 = await h.send('and the readme', true);
    h.replay(a2, 'and the readme');
    await h.stop();
    // Neither result comes: the stop's safety net settles the turn.
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    const b = await h.send('second');
    h.replay(b, 'second');
    await h.stop();
    const before = h.turns().length;
    // The settled turn's results, late and one each: neither is the stopped second turn's.
    h.result([a], true);
    expect(h.rt.turnActive).toBe(true);
    h.result([a2], true);
    expect(h.rt.turnActive).toBe(true);
    expect(h.turns()).toHaveLength(before);
    expect(h.procs).toHaveLength(1);
    // The second's own result ends it.
    h.result([b], true);
    expect(h.rt.turnActive).toBe(false);
  }, 10_000);

  for (const failed of [false, true]) {
    it(`a stream that has not shown it names messages: the next message goes to a new process, and its own result ${failed ? 'fails' : 'settles'} it`, async () => {
      const h = await claudeApp();
      const a = await h.send('first');
      h.replay(a, 'first');
      await h.stop();
      // Its result never comes.
      await until(() => !h.rt.turnActive, 'the safety net', 4000);
      const b = await h.send('Fix the login button that does nothing');
      h.replay(b, 'Fix the login button that does nothing');
      h.text('The login button now submits the form.');
      // A result that names nothing: the second turn's own, never taken for the first's.
      h.result(null, failed);
      expect(h.rt.turnActive).toBe(false);
      const last = h.turns().at(-1)!;
      expect(last.error).toBe(failed ? 'Tool execution failed' : undefined);
      expect(h.procs).toHaveLength(2);
      expect(h.procs[0].closed()).toBe(true);
      if (!failed) {
        await until(() => h.asked.length === 1, 'title asked');
        expect(h.asked[0]).toContain('Fix the login button that does nothing');
      }
    }, 10_000);
  }

  it("a result the old process still owed, written after the next message went to a new one, never reaches it", async () => {
    const h = await claudeApp({ streams: true });
    const a = await h.send('first');
    h.replay(a, 'first');
    await h.settle();
    await h.stop();
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    const b = await h.send('second');
    expect(h.procs).toHaveLength(2);
    h.replay(b, 'second');
    await h.settle();
    // The first process writes its stopped turn's result late (it names no message).
    h.result(null, true, h.procs[0]);
    await h.settle();
    expect(h.rt.turnActive).toBe(true);
    expect(h.turns()).toHaveLength(0);
    h.result(null);
    await h.settle();
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().map((t) => t.error)).toEqual([undefined]);
  }, 10_000);
});

// ── Codex: the real adapter on a fake app-server ──

type Answers = Partial<Record<string, (params: Record<string, unknown>, n: number) => unknown>>;

async function codexFake(answers: Answers = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-w5-'));
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
  const started = (turn: string) => notify('turn/started', { turn: { id: turn, status: 'inProgress', items: [] } });
  const complete = (turn: string, s = 'completed') => notify('turn/completed', { turn: { id: turn, status: s, items: [] } });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  const session = () => [...provider.sessions.values()][0] as unknown as Record<string, unknown> & { send(item: UserItem): Promise<void> };
  const lastTurn = () => rt.items.findLast((i): i is TurnItem => i.type === 'turn');
  return {
    app,
    id,
    rt,
    calls,
    notify,
    started,
    complete,
    count,
    session,
    lastTurn,
    send: (text: string) => app.call('session.send', { sessionId: id, text }),
    stop: () => app.call('session.interrupt', { sessionId: id }),
    interrupted: (turnId: string) => calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === turnId),
  };
}

const notices = (rt: SessionRuntime) => rt.items.filter((i): i is NoticeItem => i.type === 'notice');

describe('#14: a Codex error belongs to its own turn', () => {
  it("a start that fails after its turn ended by Codex's word never ends the next turn", async () => {
    const first = gate();
    const h = await codexFake({
      'turn/start': async (_p, n) => {
        if (n === 1) return (await first.wait(), Promise.reject(new Error('turn/start timed out')));
        return { turn: { id: `turn${n}` } };
      },
    });
    void h.send('first');
    await until(() => h.count('turn/start') === 1, 'the first turn/start');
    // The first turn runs and ends while its start is still out.
    h.started('turn1');
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    void h.send('second');
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    await tick();
    h.started('turn2');
    // The first start's answer comes now: an error.
    first.open(undefined);
    await tick(40);
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.meta.status).toBe('running');
    h.complete('turn2');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
    expect(h.lastTurn()?.error).toBeUndefined();
  });

  it("the bridge never ends a newer turn on an older message's send failing late", async () => {
    const late = gate();
    const h = await codexFake();
    const s = h.session();
    const own = s.send.bind(s);
    let n = 0;
    s.send = async (item: UserItem) => {
      if (++n > 1) return own(item);
      await own(item);
      await late.wait();
      throw new Error('the connection dropped');
    };
    void h.send('first');
    await until(() => h.count('turn/start') === 1, 'the first turn/start');
    await tick();
    h.started('turn1');
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    void h.send('second');
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    await tick();
    h.started('turn2');
    late.open(undefined);
    await tick(40);
    expect(h.rt.turnActive).toBe(true);
    expect(notices(h.rt).some((x) => x.text === 'Could not send the message')).toBe(false);
    h.complete('turn2');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it('a Stop whose interrupt failed while the turn still runs is not taken for a stop: the turn runs on to its own end', async () => {
    const h = await codexFake({
      'turn/interrupt': () => Promise.reject(new Error('turn/interrupt timed out')),
      'thread/turns/list': () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }),
    });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().interruptMs = 40;
    await h.stop();
    await tick(150);
    expect(h.rt.turnActive).toBe(true);
    expect(h.count('thread/turns/list')).toBeGreaterThanOrEqual(1);
    expect(notices(h.rt).some((x) => /did not stop/i.test(x.text))).toBe(true);
    // Codex goes on and ends the turn itself: that is how it ended.
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it('a Stop whose interrupt failed after the turn did stop: the thread says so, and the turn ends so at once', async () => {
    const h = await codexFake({
      'turn/interrupt': () => Promise.reject(new Error('turn/interrupt timed out')),
      'thread/turns/list': () => ({ data: [{ id: 'turn1', status: 'interrupted', items: [] }] }),
    });
    await h.send('first');
    await tick();
    h.started('turn1');
    await h.stop();
    await until(() => !h.rt.turnActive, 'the turn ended as stored', 1000);
    expect(h.lastTurn()?.stopReason).toBe('interrupted');
  });
});

describe('#15: a start waits until a stopped start\'s turn is told apart', () => {
  it("a stopped command that made no turn: the next command's own turn, shown before its answer, is its own", async () => {
    const second = gate();
    const h = await codexFake({
      'thread/compact/start': async (_p, n) => (n === 2 ? (await second.wait(), {}) : {}),
      'thread/turns/list': () => ({ data: [] }),
    });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'the first compaction');
    await tick();
    // Stopped before its turn showed itself (its answer named none): it never shows one.
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    // The second's own turn shows itself before its answer.
    h.started('cmpB');
    second.open(undefined);
    await tick();
    expect(h.interrupted('cmpB')).toBe(false);
    expect(h.rt.turnActive).toBe(true);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("a stopped command's turn showing itself long after, while the next command runs, is stopped and never taken for it", async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'cmpA', status: 'inProgress', items: [] }] }) });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'the first compaction');
    await tick();
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    // More than a minute later.
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 61_000);
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    await tick();
    // The first's turn, late: it was stopped before the second went out, and its news is nobody's.
    h.started('cmpA');
    h.complete('cmpA', 'interrupted');
    expect(h.interrupted('cmpA')).toBe(true);
    expect(h.rt.turnActive).toBe(true);
    h.started('cmpB');
    await tick();
    expect(h.interrupted('cmpB')).toBe(false);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });
});
