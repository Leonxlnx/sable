/**
 * A chat goes idle when the agent is done, also when background agents wake it. The owner's 0.2.9
 * chat: a turn started two background helpers, answered, the person asked mid-turn "what are you
 * still thinking about", the agent answered "nothing", and the live line said "Thinking" forever.
 *
 * Claude Code injects a `<task-notification>` user message (replayed with `isSynthetic`) when a
 * background agent ends; it starts a model turn of its own (a meta turn) whose result names no
 * client message, or is folded into a running turn, or runs no model turn at all. None of that may
 * leave the turn open. A fake SDK message stream and a fake Codex app-server: no real agent turns.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type SessionMeta, type UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderSession } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const users = (rt: SessionRuntime) => rt.items.filter((i): i is UserItem => i.type === 'user');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────── Claude ───────────────────────────────────

async function claude() {
  const events: BridgeEvent[] = [];
  const p = new ClaudeProvider({ emit: (e) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
  const anyP = p as unknown as Record<string, unknown>;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
  anyP.readLimits = async () => [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const session = (await p.open(rt, {})) as unknown as Record<string, unknown> & ProviderSession;
  const pushed: { uuid: string; priority?: string }[] = [];
  const q = { interrupt: async () => undefined, close: () => {} };
  session.ensure = function (this: Record<string, unknown>) {
    this.q ??= q;
    this.input ??= { push: (m: { uuid: string; priority?: string }) => pushed.push(m), end: () => {} };
    return this.q;
  };
  cleanups.push(() => session.close());
  const message = (m: Record<string, unknown>) => (session.onMessage as (m: unknown) => void).call(session, { session_id: 'cc1', ...m });
  const add = (text: string) => rt.add<UserItem>({ type: 'user', text, state: rt.turnActive ? 'queued' : 'sent', ...(rt.turnActive ? { steered: true } : {}) });
  /** The person sends a message (steered when a turn runs, as the composer does). */
  const send = async (text: string) => {
    const item = add(text);
    await session.send(item);
    return { item, uuid: pushed.at(-1)!.uuid };
  };
  const replay = (uuid: string, content: string, extra: Record<string, unknown> = {}) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
  const text = (t: string) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
  const state = (s: 'idle' | 'running' | 'requires_action') => message({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `st-${Math.random()}` });
  /** The agent starts a background helper: its Agent call, the placeholder result, the task. */
  const startHelper = (n: number) => {
    const toolId = `toolu_bg${n}`;
    message({ type: 'assistant', uuid: `a-bg${n}`, parent_tool_use_id: null, message: { id: `msg-bg${n}`, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Agent', input: { description: `Read page ${n}`, prompt: 'read it', run_in_background: true } }] } });
    message({ type: 'system', subtype: 'task_started', task_id: `task${n}`, tool_use_id: toolId, description: `Read page ${n}` });
    message({ type: 'user', uuid: `u-bg${n}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Async agent launched successfully.' }] }, tool_use_result: { status: 'async_launched', agentId: `task${n}` } });
  };
  /** A background helper ends: the task event, then Claude Code's own message about it (meta, replayed as synthetic). */
  const helperDone = (n: number) => {
    message({ type: 'system', subtype: 'task_notification', task_id: `task${n}`, tool_use_id: `toolu_bg${n}`, status: 'completed', summary: `Agent "Read page ${n}" completed` });
    replay(
      `note-${n}`,
      `<task-notification>\n<task-id>task${n}</task-id>\n<tool-use-id>toolu_bg${n}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Read page ${n}" completed</summary>\n<result>Page ${n} says hello.</result>\n</task-notification>`,
      { isSynthetic: true },
    );
  };
  const live = () => ({ turnActive: rt.turnActive, status: rt.meta.status, activity: rt.meta.activity });
  return { rt, session, pushed, message, send, replay, text, state, startHelper, helperDone, live };
}

const result = (uuids?: string[]) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage: {}, total_cost_usd: 0, ...(uuids ? { user_message_uuids: uuids, user_message_uuid: uuids.at(-1) } : {}) });
const IDLE = { turnActive: false, status: 'idle', activity: undefined };

describe('Claude Code: background agents and the turns they start', () => {
  it('the owner\'s chat: helpers end, a steer is answered in their turn, and the chat goes idle', async () => {
    const h = await claude();
    const a = await h.send('Who is Halvard? Read their site and the press page.');
    h.replay(a.uuid, 'Who is Halvard? Read their site and the press page.');
    h.startHelper(1);
    h.startHelper(2);
    h.text('Halvard is a small studio from Porto …');
    h.message(result([a.uuid]));
    expect(h.live()).toEqual(IDLE);

    // The first helper ends: Claude Code wakes the model with its notification (a meta turn).
    h.helperDone(1);
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.meta.activity).toBe('Thinking');
    // The person asks mid-turn; the steer is folded into the meta turn, and the second helper's note too.
    const s = await h.send('what are you still thinkin about????');
    expect(h.pushed.at(-1)?.priority).toBe('next');
    h.replay(s.uuid, 'what are you still thinkin about????');
    h.helperDone(2);
    h.text("Nothing. I'm finished, and the answer about Halvard above is complete.");
    // The meta turn's result names the one client message it folded in, and only that.
    h.message(result([s.uuid]));
    expect(h.live()).toEqual(IDLE);
    expect(users(h.rt).find((u) => u.text.startsWith('what are you'))).toMatchObject({ state: 'sent', steered: true });

    // Claude Code's own word that it is done changes nothing.
    h.state('idle');
    expect(h.live()).toEqual(IDLE);
  });

  it('two notifications that run as one meta turn with a result that names no message: idle after it', async () => {
    const h = await claude();
    const a = await h.send('read both pages');
    h.replay(a.uuid, 'read both pages');
    h.startHelper(1);
    h.startHelper(2);
    h.message(result([a.uuid]));
    expect(h.live()).toEqual(IDLE);
    h.helperDone(1);
    h.helperDone(2);
    expect(h.rt.turnActive).toBe(true);
    h.text('Both pages are read.');
    h.message(result());
    expect(h.live()).toEqual(IDLE);
  });

  it('each notification with a model turn of its own: one turn each, idle after the last', async () => {
    const h = await claude();
    const a = await h.send('read both pages');
    h.replay(a.uuid, 'read both pages');
    h.startHelper(1);
    h.startHelper(2);
    h.message(result([a.uuid]));
    h.helperDone(1);
    h.text('Page one is read.');
    h.message(result());
    expect(h.live()).toEqual(IDLE);
    h.helperDone(2);
    expect(h.rt.turnActive).toBe(true);
    h.text('Page two is read too.');
    h.message(result());
    expect(h.live()).toEqual(IDLE);
  });

  it('a notification during the turn that already answered it, with no turn of its own: idle at the result', async () => {
    const h = await claude();
    const a = await h.send('read the page and wait for it');
    h.replay(a.uuid, 'read the page and wait for it');
    h.startHelper(1);
    // The helper ends while the turn still runs: its note is folded into this turn.
    h.helperDone(1);
    h.text('The page says hello.');
    h.message(result([a.uuid]));
    expect(h.live()).toEqual(IDLE);
  });

  it('a notification that starts no model turn: Claude Code says it is idle and the chat goes idle', async () => {
    const h = await claude();
    const a = await h.send('read the page');
    h.replay(a.uuid, 'read the page');
    h.startHelper(1);
    h.message(result([a.uuid]));
    h.helperDone(1);
    expect(h.rt.turnActive).toBe(true);
    // No assistant message, no result: only the session's own state.
    h.state('idle');
    expect(h.live()).toEqual(IDLE);
  });

  it('a steer into a turn whose result never lists it still ends idle when Claude Code is idle', async () => {
    const h = await claude();
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.startHelper(1);
    h.message(result([a.uuid]));
    h.helperDone(1);
    const s = await h.send('and now?');
    h.replay(s.uuid, 'and now?');
    h.text('Done.');
    // An odd result: no uuids at all (as an older CLI writes).
    h.message(result());
    h.state('idle');
    expect(h.live()).toEqual(IDLE);
  });

  it('a message of ours Claude Code has not read yet keeps the turn when an idle crosses it', async () => {
    const h = await claude();
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.message(result([a.uuid]));
    h.helperDone(1);
    const s = await h.send('next one');
    // Claude Code went idle before it read the steer: the steer's own turn is still to come.
    h.state('idle');
    expect(h.rt.turnActive).toBe(true);
    h.state('running');
    h.replay(s.uuid, 'next one');
    h.message(result([s.uuid]));
    expect(h.live()).toEqual(IDLE);
  });

  it("a wake's result that names nothing never takes a steer Claude Code has not read, before any result named a message", async () => {
    const h = await claude();
    // A process whose results have named no message yet.
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.message(result());
    expect(h.live()).toEqual(IDLE);
    // Claude Code wakes on its own (a scheduled wake-up); the person steers into it.
    h.state('idle');
    h.state('running');
    expect(h.rt.turnActive).toBe(true);
    const s = await h.send('and the docs?');
    h.text('Checked again: still green.');
    // The wake's own result, before Claude Code read the steer.
    h.message(result());
    expect(h.rt.turnActive).toBe(true);
    expect(users(h.rt).find((u) => u.text === 'and the docs?')?.state).toBe('queued');
    // An idle crossing it changes nothing either: the steer's own turn is still to come.
    h.state('idle');
    expect(h.rt.turnActive).toBe(true);
    h.state('running');
    h.replay(s.uuid, 'and the docs?');
    h.text('The docs are fine.');
    h.message(result([s.uuid]));
    expect(h.live()).toEqual(IDLE);
    expect(users(h.rt).find((u) => u.text === 'and the docs?')?.state).toBe('sent');
  });

  it('a result that names its message only by user_message_uuid counts as naming it', async () => {
    const h = await claude();
    const one = (uuid: string) => ({ ...result(), user_message_uuid: uuid });
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.message(one(a.uuid));
    expect(h.live()).toEqual(IDLE);
    // A background helper's note wakes the model; a steer goes in before Claude Code reads it.
    h.helperDone(1);
    expect(h.rt.turnActive).toBe(true);
    const s = await h.send('still there?');
    h.message(result());
    expect(h.rt.turnActive).toBe(true);
    expect(users(h.rt).find((u) => u.text === 'still there?')?.state).toBe('queued');
    h.replay(s.uuid, 'still there?');
    h.message(one(s.uuid));
    expect(h.live()).toEqual(IDLE);
  });

  it('Claude Code starting work on its own opens a turn, and its result closes it', async () => {
    const h = await claude();
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.message(result([a.uuid]));
    h.state('idle');
    // A wake with no replayed message (a scheduled wake-up): the session's state says it runs.
    h.state('running');
    expect(h.rt.turnActive).toBe(true);
    h.text('Checked again: still green.');
    h.message(result());
    expect(h.live()).toEqual(IDLE);
    // A permission answered after the turn is no new work.
    h.state('requires_action');
    h.state('running');
    expect(h.live()).toEqual(IDLE);
  });

  it('a message from the Claude app still keeps the turn open until its own result', async () => {
    const h = await claude();
    const a = await h.send('first');
    h.replay(a.uuid, 'first');
    h.replay('from-phone', 'also check the docs');
    h.message(result([a.uuid]));
    expect(h.rt.turnActive).toBe(true);
    h.message(result(['from-phone']));
    expect(h.live()).toEqual(IDLE);
  });

  it('agent processes report their state, so the idle above ever arrives', () => {
    const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
    const o = p.agentOptions({ cwd: process.cwd(), model: 'm', mode: 'default' }, {});
    // The SDK swallows the CLI's session_state_changed unless the host asks for it.
    expect(o.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });
});

// ───────────────────────────────────── Codex ────────────────────────────────────

async function codex() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-bgturns-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let turnN = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: `turn${++turnN}` } };
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
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true } });
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
  const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
  const complete = (turn: string, status = 'completed') => notify('turn/completed', { threadId: 'th1', turn: { id: turn, status, items: [] } });
  const status = (type: 'idle' | 'active') => notify('thread/status/changed', { threadId: 'th1', status: type === 'active' ? { type, activeFlags: [] } : { type } });
  return { app, id, rt, calls, notify, complete, status, send: (text: string, steer?: boolean) => app.call('session.send', { sessionId: id, text, steer }) };
}

describe('Codex: turns it starts on its own, and a turn whose end never came', () => {
  it('a turn Codex starts by itself runs and ends; a steer into it is answered; idle after', async () => {
    const h = await codex();
    await h.send('start the server in the background');
    await tick();
    h.complete('turn1');
    await tick();
    expect(h.rt.turnActive).toBe(false);
    // Codex wakes on its own (a background terminal ended).
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'auto1', status: 'inProgress', items: [] } });
    expect(h.rt.turnActive).toBe(true);
    await h.send('what are you still doing?', true);
    await tick();
    expect(h.calls.filter((c) => c.method === 'turn/steer').at(-1)?.params.expectedTurnId).toBe('auto1');
    h.complete('auto1');
    await tick();
    expect({ turnActive: h.rt.turnActive, status: h.rt.meta.status, activity: h.rt.meta.activity }).toEqual(IDLE);
  });

  it('the thread goes idle and the turn end never comes: nothing is recorded by a guess, and its end, when it comes, is honoured', async () => {
    const h = await codex();
    await h.send('first');
    await tick();
    expect(h.rt.turnActive).toBe(true);
    h.status('idle');
    // A short grace for turn/completed, which normally lands with it and carries the real outcome.
    await tick(1700);
    // The thread's store cannot say how it ended (review wave 4, #13): it stays open, asked again later.
    expect(h.rt.turnActive).toBe(true);
    h.complete('turn1');
    await tick();
    expect({ turnActive: h.rt.turnActive, status: h.rt.meta.status, activity: h.rt.meta.activity }).toEqual(IDLE);
  });

  it('turn/completed right after the idle status wins: its outcome is kept and nothing ends twice', async () => {
    const h = await codex();
    await h.send('first');
    await tick();
    h.status('idle');
    h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn1', status: 'failed', error: { message: 'boom' }, items: [] } });
    await tick(1700);
    expect(h.rt.meta.status).toBe('error');
    expect(h.rt.items.filter((i) => i.type === 'turn')).toHaveLength(1);
  });

  it('an idle status for a turn that is still starting changes nothing', async () => {
    const h = await codex();
    await h.send('first');
    await tick();
    h.status('active');
    h.status('idle');
    h.status('active');
    await tick(1700);
    expect(h.rt.turnActive).toBe(true);
    h.complete('turn1');
    await tick();
    expect(h.rt.turnActive).toBe(false);
  });
});

/** A fake app-server whose answers a test chooses: `turn/start` may wait, `thread/turns/list` tells a turn's stored outcome. */
async function codexWith(answer: { turnStart?: (n: number) => Promise<unknown> | unknown; turnsList?: () => unknown } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-bgturns-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let starts = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'turn/start') {
        const n = ++starts;
        return answer.turnStart ? answer.turnStart(n) : { turn: { id: `turn${n}` } };
      }
      if (method === 'thread/turns/list') return answer.turnsList?.() ?? {};
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
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true } });
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
  const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
  const status = (type: 'idle' | 'active') => notify('thread/status/changed', { threadId: 'th1', status: type === 'active' ? { type, activeFlags: [] } : { type } });
  const turnStarts = () => calls.filter((c) => c.method === 'turn/start').length;
  return { app, id, rt, calls, notify, status, turnStarts, send: (text: string, steer?: boolean) => app.call('session.send', { sessionId: id, text, steer }) };
}

const lastTurn = (rt: SessionRuntime) => rt.items.findLast((i) => i.type === 'turn') as { stopReason?: string; error?: string } | undefined;

describe("Codex: a turn ended from the thread's idle keeps what is known, and late news of it changes nothing", () => {
  it('after an error that ended the turn: it ends failed and the queue waits', async () => {
    const h = await codexWith();
    await h.send('first');
    await tick();
    // A message sent meanwhile waits in the bridge's queue for the turn's end.
    expect((await h.send('second')).queued).toBe(true);
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'stream disconnected' } });
    h.status('idle');
    await tick(1700);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).toBe('error');
    expect(lastTurn(h.rt)?.error).toBe('stream disconnected');
    expect(h.turnStarts()).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
  });

  it('after a stop was asked: it ends interrupted, not completed', async () => {
    const h = await codexWith();
    await h.send('first');
    await tick();
    await h.app.call('session.interrupt', { sessionId: h.id });
    h.status('idle');
    await tick(1700);
    expect(h.rt.turnActive).toBe(false);
    expect(lastTurn(h.rt)?.stopReason).toBe('interrupted');
  });

  it('with no word of how it ended: the thread is asked; when it cannot say, nothing queued goes out', async () => {
    const h = await codexWith();
    await h.send('first');
    await tick();
    await h.send('second');
    h.status('idle');
    await tick(1700);
    expect(h.calls.some((c) => c.method === 'thread/turns/list')).toBe(true);
    // Not ended by a guess (review wave 4, #13): the turn stays open, the queue held behind it.
    expect(h.rt.turnActive).toBe(true);
    expect(h.turnStarts()).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
  });

  it("the thread's stored outcome decides: failed holds the queue, completed lets it go", async () => {
    const failed = await codexWith({ turnsList: () => ({ data: [{ id: 'turn1', status: 'failed', error: { message: 'model overloaded' }, items: [] }] }) });
    await failed.send('first');
    await tick();
    await failed.send('second');
    failed.status('idle');
    await tick(1700);
    expect(failed.rt.meta.status).toBe('error');
    expect(failed.turnStarts()).toBe(1);

    const done = await codexWith({ turnsList: () => ({ data: [{ id: 'turn1', status: 'completed', items: [] }] }) });
    await done.send('first');
    await tick();
    await done.send('second');
    done.status('idle');
    await tick(1700);
    await tick(50);
    expect(done.turnStarts()).toBe(2);
  });

  it('a late turn/completed of the turn that ended never ends the next one while it is still starting', async () => {
    let release!: (v: unknown) => void;
    const h = await codexWith({
      turnStart: (n) => (n === 1 ? { turn: { id: 'turn1' } } : new Promise((r) => (release = r))),
      turnsList: () => ({ data: [{ id: 'turn1', status: 'completed', items: [] }] }),
    });
    await h.send('first');
    await tick();
    await h.send('second');
    h.status('idle');
    await tick(1700);
    await tick(50);
    // The queued message went out; its turn/start has not answered yet (no id).
    expect(h.turnStarts()).toBe(2);
    expect(h.rt.turnActive).toBe(true);
    h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn1', status: 'completed', items: [] } });
    await tick();
    expect(h.rt.turnActive).toBe(true);
    release({ turn: { id: 'turn2' } });
    await tick();
    h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn2', status: 'completed', items: [] } });
    await tick();
    expect(h.rt.turnActive).toBe(false);
  });
});

describe('Codex: a fast turn that ends while turn/start is still out', () => {
  it('its idle is looked at once the start returns, and the chat goes idle', async () => {
    let release!: (v: unknown) => void;
    const h = await codexWith({ turnStart: () => new Promise((r) => (release = r)), turnsList: () => ({ data: [{ id: 'turn1', status: 'completed', items: [] }] }) });
    void h.send('first');
    await tick();
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'turn1', status: 'inProgress', items: [] } });
    h.status('active');
    h.status('idle');
    // Its turn/completed never comes; the start answers after all of it.
    release({ turn: { id: 'turn1' } });
    await tick(1700);
    await tick(50);
    expect({ turnActive: h.rt.turnActive, status: h.rt.meta.status, activity: h.rt.meta.activity }).toEqual(IDLE);
  });

  it('an idle from before the turn showed itself changes nothing', async () => {
    let release!: (v: unknown) => void;
    const h = await codexWith({ turnStart: () => new Promise((r) => (release = r)) });
    void h.send('first');
    await tick();
    // The thread's idle from before this turn began, delivered while the start is out.
    h.status('idle');
    release({ turn: { id: 'turn1' } });
    await tick(1700);
    expect(h.rt.turnActive).toBe(true);
    h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn1', status: 'completed', items: [] } });
    await tick();
    expect(h.rt.turnActive).toBe(false);
  });
});
