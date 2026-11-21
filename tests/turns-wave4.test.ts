/**
 * Turn accounting after a stop, a forced settlement and a late or missing end (review wave 4):
 * - #11: a turn Claude Code starts by itself after a stop (a scheduled wake, no message replayed) keeps
 *   the stop's hold on the queue: nothing queued goes out when it ends.
 * - #12: a Codex Stop acts only on the turn it was for: never on a newer one begun while it waited,
 *   and never on that turn's own safety net.
 * - #13: Codex records no end it was not told: a compaction acknowledged without an id, and an idle
 *   thread whose store cannot say how the turn ended, leave the turn open and unsure, the queue held.
 * - #14: the turn of a stopped Codex command whose id was never known is never taken for the next start's.
 * - #15: a Claude Code result of a turn the safety net settled is that turn's, come late: it never ends
 *   the next one.
 * - #16: what each message came to is kept until the bridge has looked at the turn's end, and a message
 *   handed to an agent that answers each one on its own names a chat only on its word that it went ok.
 * Fakes only: the Claude Code adapter with a fake SDK stream, the Codex adapter on a fake app-server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, SessionMeta, TurnItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
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

// ── Claude Code: the real adapter, its process replaced by a fake SDK stream ──

type Session = Record<string, unknown> & ProviderSession;

async function claudeApp() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-turns-w4-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const asked: string[] = [];
  const pushed: { uuid: string; priority?: string; message: { content: unknown } }[] = [];
  const sessions: Session[] = [];
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
            this.q ??= { interrupt: async () => {}, close: () => {} };
            this.input ??= { push: (m: (typeof pushed)[number]) => pushed.push(m), end: () => {} };
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
  const message = (m: Record<string, unknown>) => (sessions[0].onMessage as (m: unknown) => void).call(sessions[0], { session_id: 'cc1', ...m });
  const send = async (text: string, steer = false) => {
    const n = pushed.length;
    await app.call('session.send', { sessionId: id, text, ...(steer ? { steer: true } : {}) });
    await until(() => pushed.length > n, `"${text}" sent`);
    return pushed.at(-1)!.uuid;
  };
  const replay = (uuid: string, content: string) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content } });
  const text = (t: string) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
  const result = (uuids: string[], failed = false) =>
    message({
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed,
      ...(failed ? { errors: ['Tool execution failed'] } : {}),
      duration_ms: 10,
      usage: {},
      total_cost_usd: 0,
      user_message_uuids: uuids,
      user_message_uuid: uuids.at(-1),
    });
  /** Claude Code's own word on its state (session_state_changed). */
  const state = (s: 'idle' | 'running') => message({ type: 'system', subtype: 'session_state_changed', state: s });
  const stop = () => app.call('session.interrupt', { sessionId: id });
  const turns = () => rt.items.filter((i): i is TurnItem => i.type === 'turn');
  return { app, id, rt, asked, pushed, send, replay, text, result, state, stop, turns };
}

describe('#11: a wake Claude Code starts by itself after a stop', () => {
  it('keeps the stop\'s hold: the queued message waits for the person when the wake ends', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    expect((await h.app.call('session.send', { sessionId: h.id, text: 'and add tests' })).queued).toBe(true);
    await h.stop();
    h.result([a], true);
    h.state('idle');
    expect(h.rt.turnActive).toBe(false);
    const sent = h.pushed.length;
    // A scheduled wake-up: Claude Code goes to work with no message to replay.
    h.state('running');
    expect(h.rt.turnActive).toBe(true);
    // Its result names no message of anyone's, and it goes idle.
    h.result([]);
    h.state('idle');
    expect(h.rt.turnActive).toBe(false);
    await tick(60);
    expect(h.pushed).toHaveLength(sent);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and add tests']);
  });

  it('the person writing into the wake lifts the hold, as for any turn the agent began', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    await h.app.call('session.send', { sessionId: h.id, text: 'and add tests' });
    await h.stop();
    h.result([a], true);
    h.state('idle');
    h.state('running');
    const d = await h.send('also update the changelog', true);
    h.replay(d, 'also update the changelog');
    h.result([d]);
    expect(h.rt.turnActive).toBe(false);
    await until(() => h.pushed.some((p) => JSON.stringify(p.message.content).includes('and add tests')), 'the queued message sent');
  });
});

describe('#15: a result of a turn the safety net settled', () => {
  /** A CLI that names what each result answers, as its first turn's result showed (wave 5 #13: one that has not shown it gets a new process for the next turn). */
  const naming = async (h: Awaited<ReturnType<typeof claudeApp>>) => {
    const z = await h.send('hello');
    h.replay(z, 'hello');
    h.result([z]);
    expect(h.rt.turnActive).toBe(false);
  };

  it('named for its own message, it never ends the next turn, stopped too', async () => {
    const h = await claudeApp();
    await naming(h);
    const a = await h.send('first');
    h.replay(a, 'first');
    await h.stop();
    // Its result does not come: the stop's safety net settles it.
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    const b = await h.send('second');
    h.replay(b, 'second');
    await h.stop();
    // The first turn's result, late.
    h.result([a], true);
    expect(h.rt.turnActive).toBe(true);
    // The second's own result ends it.
    h.result([b], true);
    expect(h.rt.turnActive).toBe(false);
  }, 10_000);

  it('it adds no line of its own to the next turn, nor fails a message of it', async () => {
    const h = await claudeApp();
    await naming(h);
    const a = await h.send('first');
    h.replay(a, 'first');
    await h.stop();
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    const before = h.turns().length;
    const b = await h.send('Fix the login button that does nothing');
    h.replay(b, 'Fix the login button that does nothing');
    h.result([a], true);
    expect(h.rt.turnActive).toBe(true);
    expect(h.turns()).toHaveLength(before);
    h.text('The login button now submits the form.');
    h.result([b]);
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns().slice(before).map((t) => t.error)).toEqual([undefined]);
  }, 10_000);

  it('in a CLI that names no messages, the next turn goes to a new process: its first result is its own', async () => {
    const h = await claudeApp();
    const a = await h.send('first');
    h.replay(a, 'first');
    await h.stop();
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    const b = await h.send('second');
    h.replay(b, 'second');
    await h.stop();
    // A result that names nothing could be either turn's; the old process (and what it owed) was let
    // go, so it is the second's (wave 5 #13; turns-wave5 shows the old process's late result dropped).
    h.result([], true);
    expect(h.rt.turnActive).toBe(false);
  }, 10_000);
});

describe('#16: what each message came to, kept until the turn is looked at', () => {
  it('a failed first message is never the title, however many steers the turn took after it', async () => {
    const h = await claudeApp();
    const a = await h.send('Rename the billing tab to payments');
    h.replay(a, 'Rename the billing tab to payments');
    const steers: string[] = [];
    for (let i = 1; i <= 201; i++) steers.push(await h.send(`Fix the login button, part ${i}`, true));
    h.text('Renamed the billing tab in the sidebar.');
    h.result([a], true);
    steers.forEach((s, i) => h.replay(s, `Fix the login button, part ${i + 1}`));
    h.text('The login button now submits the form.');
    // One result answers all of them, ok.
    h.result(steers);
    await until(() => !h.rt.turnActive, 'turn end');
    await until(() => h.asked.length === 1, 'title asked');
    expect(h.asked[0]).not.toContain('billing');
    expect(h.asked[0]).toContain('Fix the login button, part 1');
    expect(h.asked[0]).toContain('The login button now submits the form.');
  }, 20_000);

  it('a message handed to an agent that reports per message counts as ok only on its word', () => {
    const meta = { id: 's1', provider: 'claude', cwd: '.', title: 'New session', titleSource: 'auto', status: 'idle', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } } as unknown as SessionMeta;
    const rt = new SessionRuntime(meta, () => {}, () => {});
    // An agent that says nothing per message (Codex): its messages go by their turn's end.
    expect(rt.answeredOk('codex-message')).toBe(true);
    rt.expectOutcome('u1');
    rt.expectOutcome('u2');
    expect(rt.answeredOk('u1')).toBe(false);
    rt.answered(['u1'], 'failed', 'r1');
    rt.answered(Array.from({ length: 300 }, (_, i) => `s${i}`), 'ok', 'r2');
    // None evicted: the first failure is still known.
    expect(rt.answeredOk('u1')).toBe(false);
    expect(rt.answeredBy('u1')).toBe('r1');
    expect(rt.answeredOk('s0')).toBe(true);
    // Looked at: everything goes but what is kept (a steer still waiting for its turn).
    rt.forgetOutcomes(['u2']);
    expect(rt.answeredBy('u1')).toBeUndefined();
    expect(rt.answeredOk('u2')).toBe(false);
  });
});

// ── Codex: the real adapter on a fake app-server ──

type Answers = Partial<Record<string, (params: Record<string, unknown>, n: number) => unknown>>;

async function codexFake(answers: Answers = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-w4-'));
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
  const status = (type: 'idle' | 'active') => notify('thread/status/changed', { status: type === 'active' ? { type, activeFlags: [] } : { type } });
  const started = (turn: string) => notify('turn/started', { turn: { id: turn, status: 'inProgress', items: [] } });
  const complete = (turn: string, s = 'completed') => notify('turn/completed', { turn: { id: turn, status: s, items: [] } });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  const session = () => [...provider.sessions.values()][0] as unknown as Record<string, unknown> & { onRequest(method: string, p: unknown, id: number): Promise<unknown> };
  const lastTurn = () => rt.items.findLast((i): i is TurnItem => i.type === 'turn');
  return {
    app,
    id,
    rt,
    calls,
    notify,
    status,
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

const unsure = (rt: SessionRuntime) => rt.items.some((i) => i.type === 'notice' && /not said how this turn ended/.test((i as NoticeItem).text));

describe('#12: a Codex Stop acts only on its own turn', () => {
  for (const order of ['before', 'after'] as const) {
    it(`a Stop that waited for a start whose turn ended meanwhile leaves the next turn alone (its start answers ${order} the first's)`, async () => {
      const first = gate();
      const second = gate();
      const h = await codexFake({
        'turn/start': async (_p, n) => {
          if (n === 1) return (await first.wait(), { turn: { id: 'turn1' } });
          if (n === 2) return (await second.wait(), { turn: { id: 'turn2' } });
          return { turn: { id: `turn${n}` } };
        },
      });
      void h.send('first');
      await until(() => h.count('turn/start') === 1, 'the first turn/start');
      const stopping = h.stop();
      await tick();
      // The first turn ends on its own while its start is still out; the person sends the next message.
      h.complete('turn1', 'interrupted');
      expect(h.rt.turnActive).toBe(false);
      void h.send('second');
      await until(() => h.count('turn/start') === 2, 'the second turn/start');
      if (order === 'before') {
        second.open(undefined);
        await tick();
        h.started('turn2');
      }
      first.open(undefined);
      await stopping;
      await tick();
      // The stop was for the first turn: the second runs on.
      expect(h.rt.turnActive).toBe(true);
      expect(h.interrupted('turn2')).toBe(false);
      if (order === 'after') {
        second.open(undefined);
        await tick();
        h.started('turn2');
      }
      h.complete('turn2');
      expect(h.rt.turnActive).toBe(false);
      expect(h.lastTurn()?.stopReason).toBe('completed');
    });
  }

  it("a Stop whose interrupt answers late never clears the next turn's safety net", async () => {
    const late = gate();
    // The thread's store has the second turn stopped (the safety net asks it: review wave 6, #12).
    const h = await codexFake({ 'turn/interrupt': async (_p, n) => (n === 1 ? (await late.wait(), {}) : {}), 'thread/turns/list': () => ({ data: [{ id: 'turn2', status: 'interrupted', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().interruptMs = 60;
    const stopping = h.stop();
    await until(() => h.count('turn/interrupt') === 1, 'the first turn/interrupt');
    h.complete('turn1', 'interrupted');
    await h.send('second');
    await tick();
    h.started('turn2');
    // The second is stopped too; its end never comes.
    await h.stop();
    expect(h.rt.turnActive).toBe(true);
    // The first stop's interrupt answers now.
    late.open(undefined);
    await stopping;
    // The second stop's own safety net still ends it.
    await until(() => !h.rt.turnActive, "the second stop's safety net", 1000);
    expect(h.lastTurn()?.stopReason).toBe('interrupted');
  });
});

describe('#13: Codex records no end it was not told', () => {
  it('a compaction acknowledged without an id stays open and unsure, the queue held, until its own end comes', async () => {
    const h = await codexFake();
    h.session().commandMs = 40;
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'thread/compact/start');
    expect((await h.send('next')).queued).toBe(true);
    await tick(120);
    expect(h.rt.turnActive).toBe(true);
    expect(unsure(h.rt)).toBe(true);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['next']);
    expect(h.count('turn/start')).toBe(0);
    // Its turn shows itself late, and ends: honoured, and the queue goes on.
    h.started('cmp1');
    h.complete('cmp1');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
    await until(() => h.count('turn/start') === 1, 'the queued message sent');
  });

  it('a compaction left unsure can be stopped', async () => {
    const h = await codexFake();
    h.session().commandMs = 40;
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'thread/compact/start');
    await tick(120);
    expect(h.rt.turnActive).toBe(true);
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    // Its turn, showing itself after the stop, is stopped too.
    h.started('cmp1');
    await tick();
    expect(h.interrupted('cmp1')).toBe(true);
    expect(h.rt.turnActive).toBe(false);
  });

  for (const [what, answer] of [
    ['fails', () => Promise.reject(new Error('thread/turns/list failed'))],
    ['names another turn only', () => ({ data: [{ id: 'turn0', status: 'completed', items: [] }] })],
    ['names no turn', () => ({})],
  ] as const) {
    it(`an idle thread whose lookup ${what}: the turn stays open and unsure, its prompt kept, the queue held, until its end comes`, async () => {
      const h = await codexFake({ 'thread/turns/list': answer });
      await h.send('first');
      await tick();
      h.started('turn1');
      h.session().idleRecheckMs = [20, 20];
      const answered = h.session().onRequest('item/commandExecution/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'cmd1', command: 'ls', cwd: '.' }, 7);
      await until(() => h.rt.prompts().permissions.length === 1, 'the approval asked');
      await h.send('second');
      h.status('idle');
      await until(() => h.count('thread/turns/list') === 3, 'the probe and its rechecks', 3000);
      await tick(60);
      expect(h.rt.turnActive).toBe(true);
      expect(unsure(h.rt)).toBe(true);
      expect(h.rt.prompts().permissions).toHaveLength(1);
      expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
      expect(h.count('turn/start')).toBe(1);
      // Its real end comes: honoured, and the queue goes on.
      h.complete('turn1');
      await answered;
      expect(h.rt.turnActive).toBe(false);
      expect(h.lastTurn()?.stopReason).toBe('completed');
      await until(() => h.count('turn/start') === 2, 'the queued message sent');
    });
  }

  it('a recheck that finds the exact turn stored ends it as stored', async () => {
    const h = await codexFake({
      'thread/turns/list': (_p, n) => (n === 1 ? Promise.reject(new Error('busy')) : { data: [{ id: 'turn2', status: 'inProgress', items: [] }, { id: 'turn1', status: 'completed', items: [] }] }),
    });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().idleRecheckMs = [20, 20];
    await h.send('second');
    h.status('idle');
    await until(() => !h.rt.turnActive || h.count('turn/start') === 2, 'the turn closed', 3000);
    expect(h.lastTurn()?.stopReason).toBe('completed');
    await until(() => h.count('turn/start') === 2, 'the queued message sent');
  });
});

describe('#14: the turn of a stopped command whose id was never known', () => {
  it('showing itself while the next command starts, it is stopped, never taken for the next one', async () => {
    const first = gate();
    const second = gate();
    const h = await codexFake({ 'thread/compact/start': async (_p, n) => (await (n === 1 ? first : second).wait(), {}) });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'the first compaction');
    const stopping = h.stop();
    await tick();
    first.open(undefined);
    await stopping;
    expect(h.rt.turnActive).toBe(false);
    void h.send('/compact');
    // The second's start waits (the store cannot say which turn the first made: review wave 6, #12).
    await until(() => h.count('thread/turns/list') >= 1, 'the store asked');
    expect(h.count('thread/compact/start')).toBe(1);
    // The stopped compaction's turn shows itself while the second waits: it is stopped.
    h.started('cmpA');
    await tick();
    expect(h.interrupted('cmpA')).toBe(true);
    expect(h.count('thread/compact/start')).toBe(1);
    h.complete('cmpA', 'interrupted');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    second.open(undefined);
    await tick();
    expect(h.rt.turnActive).toBe(true);
    // The second's own turn is its own.
    h.started('cmpB');
    await tick();
    expect(h.interrupted('cmpB')).toBe(false);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  it("its end, never seen start, after the next command's answer named no turn, does not settle the next command", async () => {
    const first = gate();
    const h = await codexFake({ 'thread/compact/start': async (_p, n) => (n === 1 ? (await first.wait(), {}) : {}) });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'the first compaction');
    const stopping = h.stop();
    await tick();
    first.open(undefined);
    await stopping;
    void h.send('/compact');
    // The second waits while the first's turn is not told apart (review wave 6, #12).
    await until(() => h.count('thread/turns/list') >= 1, 'the store asked');
    await tick();
    expect(h.count('thread/compact/start')).toBe(1);
    // The stopped compaction's end comes (its start was never seen): it began before the second's.
    h.complete('cmpA', 'interrupted');
    await until(() => h.count('thread/compact/start') === 2, 'the second compaction');
    expect(h.rt.turnActive).toBe(true);
    h.started('cmpB');
    expect(h.interrupted('cmpB')).toBe(false);
    h.complete('cmpB');
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });

  for (const seen of [true, false]) {
    it(`its end while the next turn's start is out${seen ? '' : ' (its start never seen)'} does not settle the next turn`, async () => {
      const first = gate();
      const second = gate();
      const h = await codexFake({
        'thread/compact/start': async () => (await first.wait(), {}),
        'turn/start': async () => (await second.wait(), { turn: { id: 'turn1' } }),
      });
      void h.send('/compact');
      await until(() => h.count('thread/compact/start') === 1, 'the compaction');
      const stopping = h.stop();
      await tick();
      first.open(undefined);
      await stopping;
      void h.send('next');
      await until(() => h.count('turn/start') === 1, 'turn/start');
      if (seen) h.started('cmpA');
      h.complete('cmpA', 'interrupted');
      expect(h.rt.turnActive).toBe(true);
      second.open(undefined);
      await tick();
      expect(h.rt.turnActive).toBe(true);
      h.started('turn1');
      h.complete('turn1');
      expect(h.rt.turnActive).toBe(false);
      expect(h.lastTurn()?.stopReason).toBe('completed');
    });
  }

  it("the next start's own fast turn, ended before its answer named it, still ends it", async () => {
    const first = gate();
    const second = gate();
    const h = await codexFake({
      'thread/compact/start': async () => (await first.wait(), {}),
      'turn/start': async () => (await second.wait(), { turn: { id: 'turn1' } }),
    });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'the compaction');
    const stopping = h.stop();
    await tick();
    first.open(undefined);
    await stopping;
    void h.send('next');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    // The stopped compaction made no turn; the message's turn runs and ends before its start answers.
    h.started('turn1');
    h.complete('turn1');
    second.open(undefined);
    await tick();
    expect(h.interrupted('turn1')).toBe(false);
    expect(h.rt.turnActive).toBe(false);
    expect(h.lastTurn()?.stopReason).toBe('completed');
  });
});
