/**
 * The Claude Code adapter's process lifetime and turn model (review of 23 Nov, DIAG areas lifetime,
 * turns, visible and moves; CONTRACT D-turn, D-hold, D-tasks, D-lost):
 * - every piece of root work has a turn, also work Claude Code takes up by itself with no message
 *   replayed and no state event, and such a turn never hangs;
 * - one rule says whether a process holds work (`holdsWork`), and nothing Sable does by itself lets
 *   go of one that does: the Remote Control keeper, the idle close, a restart for a changed option;
 * - background commands and monitors are the bridge's (`ToolItem.task`), counted from the agent's
 *   own task events and from the call's own result, and lost (never "ended") with their process;
 * - a process that ends by itself, or that Sable closes mid-work, says what it cut, once;
 * - a session the bridge let go never starts a process again, and its close waits for the process.
 * The adapter is driven with fake SDK messages (no real agent turns): on the harness of
 * tests/background-turns.test.ts, and, where the adapter's own reading loop matters, on a fake SDK
 * `query` whose stream a test writes to and ends.
 */
import { EventEmitter } from 'node:events';
import { authGate } from '../server/core/auth-gate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NoticeItem, type SessionMeta, type ToolItem, type TurnItem, type UserItem } from '@shared/protocol';
import { SessionRuntime, type BackgroundLimit } from '../server/core/runtime';
import { remoteToRelease, resetRemoteKeeper, type RemoteHolder } from '../server/core/remote-keep';
import { ClaudeProvider } from '../server/providers/claude';
import { backgroundTaskOf, taskKindOf, wakeOf } from '../server/providers/claude-tools';
import { agentIndex, liveKey, overview } from '../src/features/rail/agents-model';
import { hasWork } from '@shared/work-label';
import type { ProviderSession } from '../server/providers/types';

/** A fake SDK `query`: a stream a test writes to (`out`) and ends (`end`), ended too by `close()` (or later, `closeLag`). */
const sdk = vi.hoisted(() => {
  type Proc = {
    pushed: unknown[];
    closed: boolean;
    /** How long after `close()` the stream ends (Infinity: never). */
    closeLag: number;
    out(m: unknown): void;
    end(err?: Error): void;
    q: Record<string | symbol, unknown>;
  };
  const procs: Proc[] = [];
  const child = { use: false };
  function fakeQuery(p: { prompt: AsyncIterable<unknown>; options?: { spawnClaudeCodeProcess: (request: unknown) => unknown } }) {
    if (child.use) p.options!.spawnClaudeCodeProcess({});
    const buf: unknown[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    const proc: Proc = {
      pushed: [],
      closed: false,
      closeLag: 0,
      out(m) {
        buf.push(m);
        wake?.();
      },
      end(err) {
        done = true;
        failure = err;
        wake?.();
      },
      q: {
        interrupt: async () => {},
        close() {
          proc.closed = true;
          if (proc.closeLag === 0) proc.end();
          else if (Number.isFinite(proc.closeLag)) setTimeout(() => proc.end(), proc.closeLag);
        },
        initializationResult: () => new Promise(() => {}),
        mcpServerStatus: async () => [],
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (buf.length) yield buf.shift();
            if (done) {
              if (failure) throw failure;
              return;
            }
            await new Promise<void>((r) => (wake = r));
            wake = undefined;
          }
        },
      },
    };
    void (async () => {
      for await (const m of p.prompt) proc.pushed.push(m);
    })();
    procs.push(proc);
    return proc.q;
  }
  return { procs, fakeQuery, child, history: vi.fn() };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), getSessionMessages: sdk.history, query: (p: { prompt: AsyncIterable<unknown> }) => sdk.fakeQuery(p) }));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
  sdk.child.use = false;
  vi.restoreAllMocks();
  resetRemoteKeeper();
  sdk.procs.length = 0;
});

type Obj = Record<string, unknown>;
type Session = Obj &
  ProviderSession & {
    holdsWork(): boolean;
    liveWork(): ReturnType<NonNullable<ProviderSession['liveWork']>>;
    exited(): Promise<void>;
  };

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * The adapter on a chat of its own. `live`: its own `ensure` and reading loop on the fake `query`
 * above; otherwise (as tests/background-turns.test.ts) a stand-in process that only records what is
 * pushed and how often it is closed, and a test hands each frame to the adapter itself.
 */
async function claude(opts: { live?: boolean; options?: SessionMeta['options'] } = {}) {
  const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
  const anyP = p as unknown as Obj;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
  anyP.readLimits = async () => [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...(opts.options ? { options: opts.options } : {}) };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const session = (await p.open(rt, {})) as unknown as Session;
  const pushed: { uuid: string; priority?: string }[] = [];
  let closes = 0;
  const stand = { interrupt: async () => undefined, close: () => void closes++, stopTask: async (_id: string) => {} };
  if (!opts.live) {
    session.ensure = function (this: Obj) {
      this.q ??= stand;
      this.input ??= { push: (m: { uuid: string; priority?: string }) => pushed.push(m), end: () => {} };
      return this.q;
    };
  }
  cleanups.push(() => session.close());
  const proc = () => sdk.procs.at(-1)!;
  /** One frame from the process: handed to the adapter, or written to the live process's stream. */
  const message = async (m: Obj) => {
    const frame = { session_id: 'cc1', ...m };
    if (opts.live) {
      proc().out(frame);
      await tick(5);
    } else (session.onMessage as (m: unknown) => void).call(session, frame);
  };
  const send = async (text: string) => {
    const item = rt.add<UserItem>({ type: 'user', text, state: rt.turnActive ? 'queued' : 'sent', ...(rt.turnActive ? { steered: true } : {}) });
    await session.send(item);
    if (opts.live) await tick(5);
    const uuid = opts.live ? (proc().pushed.at(-1) as { uuid: string }).uuid : pushed.at(-1)!.uuid;
    return { item, uuid };
  };
  const replay = (uuid: string, content: string, extra: Obj = {}) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
  const text = (t: string, extra: Obj = {}) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] }, ...extra });
  const state = (s: 'idle' | 'running' | 'requires_action') => message({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `st-${Math.random()}` });
  const system = (m: Obj) => message({ type: 'system', uuid: `sys-${Math.random()}`, ...m });
  /** A root call (its step runs until its result). */
  const call = (id: string, name: string, input: Obj, parent: string | null = null) =>
    message({ type: 'assistant', uuid: `a-${id}`, parent_tool_use_id: parent, message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const done = (id: string, structured?: unknown, parent: string | null = null, content = 'ok') =>
    message({ type: 'user', uuid: `u-${id}`, parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(structured !== undefined ? { tool_use_result: structured } : {}) });
  /** The agent runs a command in the background: its call, its result naming the task, its task's start. */
  const background = async (n: number, description = `Run app tests ${n}`) => {
    await call(`toolu_b${n}`, 'Bash', { command: `pnpm test ${n}`, description, run_in_background: true });
    await done(`toolu_b${n}`, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${n}` }, null, `Command running in background with ID: b${n}`);
    await system({ subtype: 'task_started', task_id: `b${n}`, tool_use_id: `toolu_b${n}`, task_type: 'local_bash', is_backgrounded: true, description });
  };
  const holder = () => session.remoteHolder as RemoteHolder;
  const q = () => session.q as object | undefined;
  const notices = () => rt.items.filter((i): i is NoticeItem => i.type === 'notice');
  const turns = () => rt.items.filter((i): i is TurnItem => i.type === 'turn' && !i.parentId);
  return { p, rt, session, pushed, stand, closes: () => closes, proc, message, send, replay, text, state, system, call, done, background, holder, q, notices, turns };
}

const result = (uuids?: string[], extra: Obj = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage: {}, total_cost_usd: 0, ...(uuids ? { user_message_uuids: uuids, user_message_uuid: uuids.at(-1) } : {}), ...extra });
const step = (rt: SessionRuntime, id: string) => rt.get<ToolItem>(id)!;

/** A chat whose first message Claude Code has read: its turn runs until a test sends that turn's result. */
async function atRest(opts: Parameters<typeof claude>[0] = {}) {
  const h = await claude(opts);
  const a = await h.send('run the tests and wait for them');
  await h.replay(a.uuid, 'run the tests and wait for them');
  return { ...h, first: a };
}

// ─────────────────────────────── D-turn: a turn for all root work ───────────────────────────────

describe('a turn for all root work', () => {
  it.each(['answered', 'timed out'])('keeps the wake refusal when the unread steer is %s', async (end) => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.replay('wake', '<task-notification><task-id>w</task-id><status>completed</status></task-notification>', { isSynthetic: true });
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    const refusal = () => h.message({ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Fable limit" }] } });
    if (end === 'timed out') await refusal();
    const b = await h.send('answer this');
    if (end === 'answered') await refusal();
    await h.message(result(undefined, { is_error: true, errors: ['HTTP 429'] }));
    if (end === 'answered') await h.message(result([b.uuid]));
    else {
      vi.advanceTimersByTime(61_000);
      expect(h.rt.queue.map(q => q.id)).toEqual([b.item.id]);
    }
    expect(h.rt.stopRequested).toBe(false);
    expect(h.notices().filter(n => n.limit)).toEqual([]);
    expect(hits).toMatchObject([{ window: 'Weekly · Fable' }]);
    expect(h.rt.turnActive).toBe(false);
  });

  it.each(['wake after timeout', 'personal before timeout', 'personal after timeout'])('publishes the stopped result refusal for its original owner (%s)', async (which) => {
    vi.useFakeTimers();
    const h = await atRest();
    const wake = which === 'wake after timeout';
    const stoppedCard = vi.fn();
    h.rt.onStoppedLimit = stoppedCard;
    if (wake) {
      await h.message(result([h.first.uuid]));
      await h.state('running');
    }
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    h.rt.stopRequested = true;
    await h.session.interrupt();
    if (!which.includes('before')) vi.advanceTimersByTime(2501);
    await h.message(result(wake ? undefined : [h.first.uuid], { is_error: true, errors: ["You've hit your Fable limit"] }));
    expect(stoppedCard).toHaveBeenCalledTimes(which === 'personal after timeout' ? 1 : 0);
    if (wake) expect(hits).toMatchObject([{ window: 'Weekly · Fable' }]);
    else expect(h.notices().filter(n => n.limit).map(n => n.limit)).toMatchObject([{ userItemId: h.first.item.id, window: 'Weekly · Fable' }]);
    expect(h.rt.stopRequested).toBe(true);
    expect(h.rt.turnActive).toBe(false);
  });

  it('uses the settled wake window for a bare 429 after Stop', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.state('running');
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    const reset = Date.parse('2026-11-25T14:00:00Z');
    await h.message({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: reset / 1000 } });
    await h.session.interrupt();
    vi.advanceTimersByTime(2501);
    await h.message(result(undefined, { is_error: true, errors: ['HTTP 429'] }));
    expect(hits).toMatchObject([{ window: 'Weekly · Fable', resetsAt: reset }]);
  });

  it('publishes notification grace to a waitable move at the last task end', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.background(1);
    await h.message(result([h.first.uuid]));
    const rest = vi.fn(() => h.session.liveWork!());
    h.rt.onRest = rest;
    await h.system({ subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    expect(rest.mock.results[0]?.value).toMatchObject({ commands: 0, notificationUntil: Date.now() + 3000 });
    vi.advanceTimersByTime(3001);
    expect(h.session.liveWork!()).not.toHaveProperty('notificationUntil');
  });

  it('work Claude Code takes up after a result, with no message replayed and no state event, is a turn of its own; its result ends it', async () => {
    const h = await atRest();
    await h.text('I started the tests.');
    await h.message(result([h.first.uuid]));
    expect(h.rt.turnActive).toBe(false);
    // The S1 run: the agent goes on by itself, nothing replayed, the CLI says nothing of its state.
    await h.call('toolu_w1', 'Bash', { command: 'gh run watch', description: 'Watch CI' });
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.meta.status).toBe('running');
    // Its steps belong to it (begun at or after the turn's start), so they are settled with it.
    expect(step(h.rt, 'toolu_w1').ts).toBeGreaterThanOrEqual(h.rt.turnStartedAt);
    // The keeper never lets go of it (B7), whatever the hour.
    expect(h.holder().busy()).toBe(true);
    expect(remoteToRelease([h.holder()], Date.now() + 46 * 60_000)).toEqual([]);
    await h.done('toolu_w1', { stdout: 'CI is green' });
    await h.text('CI is green.');
    await h.message(result());
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).toBe('idle');
    expect(h.turns()).toHaveLength(2);
    expect(h.holder().busy()).toBe(false);
  });

  it('streamed output begins the turn before the first block shows; a wake replayed as a hidden message begins it with its output (turns-M1)', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    // A scheduled tick: Claude Code's own message, read as hidden (it opens no turn by itself).
    await h.replay('tick-1', '<tick>12:00</tick>', { isSynthetic: true });
    expect(h.rt.turnActive).toBe(false);
    await h.message({ type: 'stream_event', parent_tool_use_id: null, uuid: 's1', event: { type: 'message_start', message: { id: 'm-w' } } });
    // A message start alone shows nothing and begins nothing.
    expect(h.rt.turnActive).toBe(false);
    await h.message({ type: 'stream_event', parent_tool_use_id: null, uuid: 's2', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    expect(h.rt.turnActive).toBe(true);
    const written = h.rt.items.findLast((i) => i.type === 'text')!;
    expect(written.ts).toBeGreaterThanOrEqual(h.rt.turnStartedAt);
    await h.message(result());
    expect(h.rt.turnActive).toBe(false);
  });

  it('a new process whose first word is that it runs opens a turn; its idle ends it with nothing shown', async () => {
    const h = await claude();
    (h.session.ensure as () => void).call(h.session);
    await h.state('running');
    expect(h.rt.turnActive).toBe(true);
    await h.state('idle');
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.items).toHaveLength(0);
  });

  it('a refusal at a limit outside the person\'s turn stays the background\'s to decide: it begins no turn', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_r, hit) => void hits.push(hit);
    await h.message({ type: 'assistant', uuid: 'r1', parent_tool_use_id: null, error: 'rate_limit', message: { id: 'm-r1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 6pm" }] } });
    expect(h.rt.turnActive).toBe(false);
    expect(hits).toHaveLength(1);
    // No card of a turn's own: the bridge writes the chat's one card (`limitInBackground`).
    expect(h.notices().filter((n) => n.limit)).toHaveLength(0);
  });

  it.each(['Sable', 'Claude app'])("keeps the person's refused turn on its limit card (%s)", async (from) => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    const uuid = from === 'Sable' ? (await h.send('keep going')).uuid : 'phone';
    await h.replay(uuid, 'keep going');
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    await h.message({ type: 'assistant', uuid: 'limited', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Fable limit" }] } });
    await h.message(result([uuid], { is_error: true, errors: ['Usage limit reached'] }));
    expect(h.notices().filter((n) => n.limit)).toHaveLength(1);
    expect(h.rt.meta.status).toBe('error');
    expect(hits).toEqual([]);
  });

  it("Claude Code's stand-in and the errors it writes itself begin no turn", async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.message({ type: 'assistant', uuid: 'si', parent_tool_use_id: null, message: { id: 'm-si', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } });
    expect(h.rt.turnActive).toBe(false);
    await h.message({ type: 'assistant', uuid: 'ov', parent_tool_use_id: null, error: 'overloaded', message: { id: 'm-ov', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Repeated 529 Overloaded errors' }] } });
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).toBe('idle');
  });

  it('keeps the personal 429 after a refused wake and a concurrent steer', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.replay('wake', '<task-notification><task-id>w</task-id><status>completed</status></task-notification>', { isSynthetic: true });
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    await h.message({ type: 'assistant', uuid: 'refusal', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Fable limit" }] } });
    const b = await h.send('answer this');
    const ends: { error?: string; backgroundOnly?: boolean }[] = [];
    h.rt.onTurnEnd = (_rt, error, opts) => { ends.push({ error, backgroundOnly: !!opts?.backgroundLimit }); };
    await h.message(result(undefined, { is_error: true, errors: ['HTTP 429'] }));
    expect(h.rt.turnActive).toBe(true);
    await h.message(result([b.uuid], { is_error: true, errors: ["You've hit your 5-hour limit"] }));
    expect(h.notices().filter((n) => n.limit)).toHaveLength(1);
    expect(h.rt.meta.lastError).toContain('5-hour');
    expect(ends).toEqual([{ error: "You've hit your 5-hour limit", backgroundOnly: false }]);
    expect(h.notices().find((n) => n.limit)?.limit?.userItemId).toBe(b.item.id);
    expect(hits).toEqual([expect.objectContaining({ window: 'Weekly · Fable' })]);
    expect(h.rt.turnActive).toBe(false);
  });

  it('holds queued work through the refused wake handoff', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.state('running');
    const queued = h.rt.enqueue('next account');
    h.rt.onTurnEnd = (rt, error, opts) => {
      expect(opts?.backgroundLimit).toBe(true);
      if (!error && !opts?.hold && !rt.stopRequested) rt.takeQueued();
    };
    const decisions: string[][] = [];
    h.rt.onBackgroundLimit = (rt) => decisions.push(rt.queue.map((q) => q.id));
    await h.message(result(undefined, { is_error: true, errors: ['HTTP 429'] }));
    expect(decisions).toEqual([[queued.id]]);
    expect(h.rt.turnActive).toBe(false);
  });

  it.each(['stop', 'exit'] as const)('hands off the wake refusal after %s', async (end) => {
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    await h.state('running');
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (rt, hit) => {
      expect(rt.turnActive).toBe(false);
      hits.push(hit);
    };
    const words = "You've hit your Fable limit · resets Nov 25, 3pm (Europe/Berlin). Switch to another model to continue.";
    if (end === 'stop') {
      h.rt.stopRequested = true;
      await h.session.interrupt();
      await h.message(result(undefined, { is_error: true, errors: [words], api_error_status: 429 }));
      expect(h.notices().some((n) => n.variant === 'interrupted')).toBe(true);
      expect(h.rt.stopRequested).toBe(true);
    } else {
      await h.message({ type: 'assistant', uuid: 'refusal', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: words }] } });
      h.proc().end();
      await until(() => !h.rt.turnActive, 'wake cut');
      expect(h.notices().some((n) => n.early === 'died')).toBe(true);
    }
    expect(hits).toEqual([expect.objectContaining({ window: 'Weekly · Fable' })]);
    expect(hits[0].stepId).toBeUndefined();
  });

  it('a result-only HTTP 429 uses the window and reset from the rejected rate-limit event', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.state('running');
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (_rt, hit) => void hits.push(hit);
    const reset = Date.parse('2026-11-25T14:00:00Z');
    await h.message({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: reset / 1000 } });
    await h.message(result(undefined, { is_error: true, errors: ['API Error: 429 Too Many Requests'] }));
    expect(hits).toEqual([expect.objectContaining({ window: 'Weekly · Fable', resetsAt: reset })]);
    expect(h.rt.meta.status).toBe('idle');
    expect(h.notices().filter((n) => n.limit)).toHaveLength(0);
  });

  it.each(['notification', 'result-only 429', 'result-only words', 'idle'] as const)('hands the refused Fable wake to the runtime at rest (%s)', async (end) => {
    vi.useFakeTimers({ now: new Date('2026-11-23T20:48:40Z') });
    const h = await atRest();
    h.rt.update({ model: 'opus' });
    await h.message(result([h.first.uuid]));
    await h.state('idle');
    await h.state('running');
    const words = "You've hit your Fable limit · resets Nov 25, 3pm (Europe/Berlin). Switch to another model to continue.";
    const hits: BackgroundLimit[] = [];
    h.rt.onBackgroundLimit = (rt, hit) => {
      expect(rt.turnActive).toBe(false);
      hits.push(hit);
    };
    const info = { status: 'rejected', rateLimitType: 'seven_day_overage_included', overageStatus: 'rejected' };
    if (end === 'notification' || end === 'idle') {
      await h.replay('wake', '<task-notification><task-id>w</task-id><status>completed</status><summary>Workflow finished</summary></task-notification>', { isSynthetic: true });
      await h.message({ type: 'assistant', uuid: 'refusal', error: 'rate_limit', apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: words }] } });
      await h.message({ type: 'rate_limit_event', rate_limit_info: info });
      expect(h.notices().filter((n) => n.limit)).toHaveLength(0);
      expect(hits).toEqual([]);
    }
    if (end === 'idle') {
      await h.state('idle');
      const settled = h.turns().length;
      await h.message(result(undefined, { is_error: true, errors: [words] }));
      expect(h.turns()).toHaveLength(settled);
    }
    else await h.message(result(undefined, { is_error: true, errors: [end === 'result-only 429' ? 'HTTP 429' : words], ...(end === 'result-only 429' ? { api_error_status: 429 } : {}) }));
    expect(hits).toHaveLength(1);
    expect(hits[0].stepId).toBeUndefined();
    if (end !== 'result-only 429') expect(hits[0]).toMatchObject({ window: 'Weekly · Fable', resetsAt: Date.parse('2026-11-25T14:00:00Z') });
    expect(h.rt.meta.status).toBe('idle');
    expect(h.turns().at(-1)?.error).toBeUndefined();
    expect(h.notices().filter((n) => n.limit)).toHaveLength(0);
  });

  it("output after a stop's safety net settled the turn begins none (it is that turn's); the late result leaves nothing open", async () => {
    const h = await claude();
    const a = await h.send('refactor the parser');
    await h.replay(a.uuid, 'refactor the parser');
    await h.call('toolu_s1', 'Read', { file_path: 'parser.ts' });
    await h.session.interrupt();
    // No result within the grace: the safety net settles the turn (it owes its result).
    await until(() => !h.rt.turnActive, 'the safety net', 4000);
    await h.text('Stopping here.');
    expect(h.rt.turnActive).toBe(false);
    await h.message(result([a.uuid], { subtype: 'error_during_execution', is_error: true }));
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).not.toBe('running');
    // Once that result is in, work the agent takes up again is a turn of its own.
    await h.text('Picking up the next file.');
    expect(h.rt.turnActive).toBe(true);
    await h.message(result());
    expect(h.rt.turnActive).toBe(false);
  }, 10_000);

  it('a CLI that never says it is idle: a turn the agent began ends once it has gone quiet, never while a step of it runs or the CLI says it works', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-05T09:00:00Z') });
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.call('toolu_q1', 'Bash', { command: 'sleep 300', description: 'Wait for CI' });
    expect(h.rt.turnActive).toBe(true);
    // A long step: no frame for five minutes, the turn stays.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.rt.turnActive).toBe(true);
    await h.done('toolu_q1', { stdout: 'done' });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.rt.turnActive).toBe(true);
    // Quiet for the bound, nothing running, nothing waiting: over (looked at again within the bound), with no record and no error.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.rt.turnActive).toBe(false);
    expect(h.turns()).toHaveLength(1);
    expect(h.rt.meta.status).toBe('idle');

    // The CLI says it works (a sub-agent's loop): believed while it is heard from, never for ever.
    await h.state('idle');
    await h.state('running');
    expect(h.rt.turnActive).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.rt.turnActive).toBe(true);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.rt.turnActive).toBe(false);
  });
});

// ──────────────────────────────── D-hold: what the process holds ────────────────────────────────

describe('what the process holds', () => {
  it("tasks as a list and as edges: a foreground wait survives the list, an ambient task holds nothing, a task ends by its state or its call's result (A4)", async () => {
    vi.useFakeTimers({ now: new Date('2026-01-26T09:00:00Z') });
    const h = await atRest();
    await h.call('toolu_fg', 'Agent', { description: 'Read the docs', prompt: 'read' });
    await h.system({ subtype: 'task_started', task_id: 'fg1', tool_use_id: 'toolu_fg', task_type: 'local_agent', is_backgrounded: false });
    // The person stops; Claude Code takes the stop but its call still blocks: the safety net settles the turn.
    void h.session.interrupt();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.rt.turnActive).toBe(false);
    // A list of background tasks (an ambient watcher only) never drops the foreground wait.
    await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1', task_type: 'local_bash', description: 'watch', ambient: true }] });
    expect(h.session.holdsWork()).toBe(true);
    // Its call's result is its end, with no notification; it is the stopped turn's and begins none.
    await h.done('toolu_fg');
    expect(h.rt.turnActive).toBe(false);
    // An ambient watcher alone is nobody's work.
    expect(h.session.holdsWork()).toBe(false);
    expect(h.session.liveWork()).toMatchObject({ agents: 0, commands: 0 });
    // A background task on the list, then ended by its own state (killed) before any notification.
    await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'b7', task_type: 'local_bash', description: 'serve' }, { task_id: 'w1', task_type: 'local_bash', description: 'watch', ambient: true }] });
    expect(h.session.liveWork()).toMatchObject({ commands: 1 });
    expect(h.session.holdsWork()).toBe(true);
    await h.system({ subtype: 'task_updated', task_id: 'b7', patch: { status: 'killed' } });
    expect(h.session.liveWork().commands).toBe(0);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.session.holdsWork()).toBe(false);
  });

  it('the Remote Control keeper never lets go of a process with a command running, and a release that finds work declines', async () => {
    vi.useFakeTimers();
    const h = await atRest({ options: { remoteControl: true } });
    await h.background(1);
    await h.message(result([h.first.uuid]));
    expect(h.rt.meta.commands).toBe(1);
    expect(h.holder().busy()).toBe(true);
    expect(remoteToRelease([h.holder()], Date.now() + 3 * 3600_000)).toEqual([]);
    await h.system({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_b1', status: 'completed', summary: 'done' });
    expect(h.session.holdsWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.holder().busy()).toBe(false);
    expect(remoteToRelease([h.holder()], Date.now() + 46 * 60_000)).toEqual([h.holder()]);
    // The agent began work while the release waited for its slot: declined, the process kept.
    await h.text('The tests passed.');
    expect(h.holder().release()).toBe(false);
    expect(h.q()).toBeDefined();
    expect(h.closes()).toBe(0);
  });

  it('the idle close waits while a command runs, and counts no sleep as idleness (lifetime-M1)', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-12T09:00:00Z') });
    const h = await atRest();
    await h.background(1);
    await h.message(result([h.first.uuid]));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.q()).toBeDefined();
    await h.system({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_b1', status: 'completed', summary: 'done' });
    // The laptop sleeps three hours: the idle timer fires that late, and the sleep was no idleness.
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    await vi.advanceTimersByTimeAsync(8 * 60_000 + 1000);
    expect(h.q()).toBeDefined();
    // Eight minutes after the wake with nothing to do: let go.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.q()).toBeUndefined();
    expect(h.closes()).toBe(1);
  });

  it('a wake-up the agent scheduled holds the process when due within the hour, never longer', async () => {
    const h = await atRest();
    const soon = Date.now() + 20 * 60_000;
    await h.call('toolu_sw', 'ScheduleWakeup', { delaySeconds: 1200, reason: 'CI takes a while', prompt: '/loop check CI' });
    await h.done('toolu_sw', { scheduledFor: soon, clampedDelaySeconds: 1200, wasClamped: false });
    await h.message(result([h.first.uuid]));
    expect(h.session.holdsWork()).toBe(true);
    expect(h.session.liveWork().wakeAt).toBe(soon);
    // Ended by the agent: nothing scheduled. (Each message is replayed and named by its result, as this
    // CLI does: a result naming nothing never answers a message it has not read, review of 23 Nov D-own.)
    const stop = await h.send('stop the loop');
    await h.replay(stop.uuid, 'stop the loop');
    await h.call('toolu_sw2', 'ScheduleWakeup', { stop: true });
    await h.done('toolu_sw2', { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true });
    await h.message(result([stop.uuid]));
    expect(h.session.holdsWork()).toBe(false);
    // Three hours away: no hold (a guess never keeps a process for ever).
    const tonight = await h.send('check again tonight');
    await h.replay(tonight.uuid, 'check again tonight');
    await h.call('toolu_cc', 'CronCreate', { cron: '0 21 * * *', prompt: 'check', recurring: false });
    await h.done('toolu_cc', { id: 'c1', humanSchedule: 'at 9pm', recurring: false, nextFireAt: Date.now() + 3 * 3600_000 });
    await h.message(result([tonight.uuid]));
    expect(h.session.holdsWork()).toBe(false);
  });

  it('a changed option waits for a background command and says so, then restarts (visible-M1)', async () => {
    const h = await atRest();
    await h.background(1);
    // Mid-turn: after this turn, as before.
    await h.session.setOptions!({ browser: true });
    expect(h.notices().map((n) => n.text)).toContain('Browser control starts after this turn');
    await h.message(result([h.first.uuid]));
    await tick();
    // The turn is over but the tests still run: no restart, and the chat says when.
    expect(h.closes()).toBe(0);
    expect(h.notices().map((n) => n.text)).toContain('Browser control starts when the background command finishes');
    await h.system({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_b1', status: 'completed', summary: 'done' });
    await tick();
    expect(h.closes()).toBe(0);
    await h.state('running');
    await h.replay('note', '<task-notification><task-id>b1</task-id><summary>Tests done</summary></task-notification>');
    await h.text('All tests passed.');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.closes()).toBe(0);
    await h.message(result());
    await h.state('idle');
    await vi.advanceTimersByTimeAsync(10);
    expect(h.closes()).toBe(1);
    // Said once.
    expect(h.notices().filter((n) => n.text.endsWith('when the background command finishes'))).toHaveLength(1);
  });

  it('a last task disappearing from the list leaves time to deliver its notification before replacing the process', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    h.p.seen.names = false;
    await h.background(1);
    await h.session.interrupt();
    await vi.advanceTimersByTimeAsync(2600);
    await h.send('review the result');
    expect(h.pushed).toHaveLength(1);
    await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.closes()).toBe(0);
    expect(h.pushed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.closes()).toBe(1);
    expect(h.pushed).toHaveLength(2);
    expect(step(h.rt, 'toolu_b1').task?.state).toBe('stopped');
  });

  it('holds the process for housekeeping throughout notification grace', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.background(1);
    await h.message(result([h.first.uuid]));
    await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    expect(h.holder().busy()).toBe(true);
    expect(h.session.holdsWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.holder().busy()).toBe(false);
  });

  it('rechecks an option at scheduled wake expiry without another frame', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.call('sw', 'ScheduleWakeup', {});
    await h.done('sw', { scheduledFor: Date.now() + 60_000 });
    await h.message(result([h.first.uuid]));
    await h.session.setOptions!({ browser: true });
    await vi.advanceTimersByTimeAsync(179_000);
    expect(h.closes()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.closes()).toBe(1);
  });

  it('a replacement process already has the pending option', async () => {
    const h = await atRest({ live: true });
    await h.session.setOptions!({ browser: true });
    h.proc().end();
    await until(() => !h.q(), 'first SDK stream to end');
    const replacement = await h.send('use the browser');
    await h.message(result([replacement.uuid]));
    await tick();
    expect(h.proc().closed).toBe(false);
  });

  it('waits silently between result and CLI idle for an option restart', async () => {
    const h = await atRest();
    await h.state('running');
    await h.session.setOptions!({ browser: true });
    await h.message(result([h.first.uuid]));
    await tick();
    expect(h.notices().map((n) => n.text)).toEqual(['Browser control starts after this turn']);
    await h.state('idle');
    await tick();
    expect(h.closes()).toBe(1);
  });

  it("stopping background work at a limit is not held by the CLI's own running: the command is asked to stop, then lost with the process", async () => {
    const h = await atRest();
    await h.background(1);
    await h.message(result([h.first.uuid]));
    await h.state('running');
    await h.message(result());
    const asked: string[] = [];
    h.stand.stopTask = async (id: string) => void asked.push(id);
    expect(await (h.session.stopBackgroundWork as () => Promise<boolean>)()).toBe(true);
    expect(asked).toEqual(['b1']);
    expect(h.closes()).toBe(1);
    expect(step(h.rt, 'toolu_b1').task).toMatchObject({ state: 'lost', why: 'limit' });
    expect(h.notices().at(-1)).toMatchObject({ text: '1 background command was lost at the plan limit', detail: 'Run app tests 1' });
  });

  it('a person moving at a limit leaves the loss for their next input', async () => {
    const h = await atRest();
    await h.background(1);
    await h.message(result([h.first.uuid]));
    const wake = vi.fn();
    h.rt.onWorkLost = wake;
    expect(await (h.session.stopBackgroundWork as (automatic: boolean) => Promise<boolean>)(false)).toBe(true);
    expect(h.rt.pendingLost().count).toBe(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it("the CLI's own running while its background agents work is theirs, not a turn: a move at a limit and a send after a sign-in are not held by it", async () => {
    const h = await atRest();
    await h.call('toolu_ag', 'Agent', { description: 'Review the diff', prompt: 'review', run_in_background: true });
    await h.system({ subtype: 'task_started', task_id: 'ag1', tool_use_id: 'toolu_ag', task_type: 'local_agent', is_backgrounded: true, description: 'Review the diff' });
    await h.done('toolu_ag', undefined, null, 'Agent running in background');
    await h.message(result([h.first.uuid]));
    expect(h.rt.turnActive).toBe(false);
    // Its idle comes only once the agent is done: meanwhile it says it runs.
    await h.state('requires_action');
    await h.state('running');
    expect(h.session.holdsWork()).toBe(true);
    expect(h.session.liveWork()).toMatchObject({ turn: false, agents: 1 });
    // The agent is done and the CLI still says it runs (its idle is on its way): that is a turn as far as anyone knows.
    await h.system({ subtype: 'task_notification', task_id: 'ag1', tool_use_id: 'toolu_ag', status: 'completed', summary: 'done' });
    expect(h.session.liveWork()).toMatchObject({ turn: true, agents: 0 });
    await h.state('idle');
    expect(h.session.liveWork()).toMatchObject({ turn: false, agents: 0 });
  });
});

// ─────────────────────────────── D-tasks: background commands ───────────────────────────────

describe('background commands', () => {
  it.each(['idle close', 'Remote Control keeper'])('keeps a SendMessage resume working through the %s until its own run ends', async (keeper) => {
    vi.useFakeTimers();
    const h = await atRest({ options: { remoteControl: keeper === 'Remote Control keeper' } });
    const task = { task_id: 'reviewer', task_type: 'local_agent', description: 'Review the change' };
    await h.call('original', 'Agent', { prompt: 'Review', description: task.description, run_in_background: true });
    await h.system({ ...task, subtype: 'task_started', tool_use_id: 'original', run_id: '01', is_backgrounded: true });
    await h.done('original', { status: 'async_launched', agentId: task.task_id });
    const terminal = (run_id: string) => h.system({ subtype: 'task_notification', task_id: task.task_id, run_id, status: 'completed', output_file: 'review.txt', summary: 'Reviewed' });
    await terminal('01');
    await h.message(result([h.first.uuid]));
    await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    const again = await h.send('Check again');
    await h.replay(again.uuid, 'Check again');
    await h.call('message', 'SendMessage', { to: task.task_id, message: 'Review the follow-up', summary: 'Check follow-up' });
    const active = { ...task, run_id: '02' };
    await h.system({ subtype: 'background_tasks_changed', tasks: [active] });
    await h.system({ ...active, subtype: 'task_started', ...(keeper === 'idle close' ? { tool_use_id: 'message' } : {}), is_backgrounded: true });
    const delivery = { success: true, message: 'Resuming agent reviewer', resumedAgentId: 'reviewer', revivedAgentId: 'reviewer' };
    await h.done('message', delivery, null, delivery.message);
    await h.system({ subtype: 'task_progress', task_id: task.task_id, run_id: '02', tool_use_id: 'message', description: task.description, summary: 'Checking changes', usage: { total_tokens: 100, tool_uses: 2, duration_ms: 50 } });
    await h.system({ subtype: 'task_updated', task_id: task.task_id, run_id: '02', patch: { status: 'running' } });
    await h.message(result([again.uuid]));
    await terminal('01');
    const working = () => {
      const items = Object.fromEntries(h.rt.items.map(i => [i.id, i]));
      const roots = h.rt.items.filter(i => !i.parentId).map(i => i.id);
      const ids = agentIndex()({ items, roots, children: {} });
      return overview(ids, liveKey(items, ids), items, [], roots).working;
    };
    expect(h.session.liveWork()).toMatchObject({ turn: false, agents: 1 });
    expect(h.rt.meta.background).toBe(1);
    expect(hasWork(h.rt.snapshot().session)).toBe(true);
    await vi.advanceTimersByTimeAsync(46 * 60_000);
    expect(h.session.holdsWork()).toBe(true);
    if (keeper === 'Remote Control keeper') {
      expect(remoteToRelease([h.holder()], Date.now())).toEqual([]);
      expect(h.holder().release()).toBe(false);
    }
    expect(h.closes()).toBe(0);
    expect(working()).toEqual(['original']);
    await h.system({ subtype: 'task_updated', task_id: task.task_id, run_id: '02', patch: { status: 'completed' } });
    expect(working()).toEqual([]);
    await terminal('02');
    await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.session.holdsWork()).toBe(false);
    expect(h.rt.meta.background).toBe(0);
    if (keeper === 'Remote Control keeper') {
      expect(remoteToRelease([h.holder()], Date.now() + 46 * 60_000)).toEqual([h.holder()]);
      h.holder().release();
    } else await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
    expect(h.closes()).toBe(1);
  });

  it.each([true, false])('shows a resumed task on a new account when its original call was carried (%s)', async carried => {
    const h = await atRest();
    if (carried) h.rt.add<ToolItem>({ type: 'tool', id: 'old-call', name: 'Agent', kind: 'agent', status: 'done', title: 'Inspect build', detail: {},
      result: { agent: { taskId: 'inspect', background: 'done' } } });
    await h.call('msg', 'SendMessage', { to: 'inspect', message: 'Finish the checks', summary: 'Finish checks' });
    const task = { task_id: 'inspect', task_type: 'local_agent', description: 'Inspect build', run_id: '02' };
    await h.system({ subtype: 'background_tasks_changed', tasks: [task] });
    await h.system({ ...task, subtype: 'task_started', is_backgrounded: true, tool_use_id: 'msg' });
    await h.done('msg', { success: true, resumedAgentId: 'inspect', revivedAgentId: 'inspect' });
    await h.message(result([h.first.uuid]));
    const rows = h.rt.items.filter((i): i is ToolItem => i.type === 'tool' && i.kind === 'agent');
    expect(rows.map(i => i.name)).toEqual([carried ? 'Agent' : 'local_agent']);
    expect(rows[0].result?.agent).toMatchObject({ taskId: 'inspect', background: 'running' });
    expect(h.rt.meta.background).toBe(1);
    await h.system({ ...task, subtype: 'task_notification', status: 'completed' });
    expect(step(h.rt, rows[0].id).result?.agent?.background).toBe('done');
    expect(h.rt.meta.background).toBe(0);
  });

  it('shows the compaction boundary once across the three local-output frames', async () => {
    const h = await atRest();
    await h.system({ subtype: 'compact_boundary', compact_metadata: { pre_tokens: 466000, post_tokens: 24000 } });
    const stdout = '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>';
    await h.text(stdout, { message: { model: '<synthetic>', content: [{ type: 'text', text: stdout }] } });
    await h.replay('output', stdout, { isSynthetic: true });
    await h.system({ subtype: 'local_command_output', content: stdout });
    expect(h.rt.items.filter(i => 'text' in i && i.text?.includes('Compacted'))).toEqual([]);
    expect(h.notices().map(n => n.variant)).toEqual(['compact']);
    for (const output of ['Context usage: 24k', 'Total cost: $0.25']) await h.system({ subtype: 'local_command_output', content: output });
    expect(h.notices().map(n => n.detail)).toEqual(['466k → 24.0k tokens', 'Context usage: 24k', 'Total cost: $0.25']);
    await h.text('Compacted');
    expect(h.rt.items.at(-1)).toMatchObject({ type: 'text', text: 'Compacted' });
  });

  it('reads SDK history with a compact boundary, both stdout spellings and a later ordinary reply', async () => {
    const h = await claude();
    h.rt.update({ providerSessionId: 'imported' });
    const output = '<local-command-stdout>Compacted</local-command-stdout>';
    sdk.history.mockResolvedValueOnce([
      { type: 'system', message: { subtype: 'compact_boundary', compact_metadata: { pre_tokens: 466000, post_tokens: 24000 } } },
      { type: 'user', isCompactSummary: true, message: { content: 'Private compact summary' } },
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Compacted' }] } },
      { type: 'user', uuid: 'out', message: { content: output } },
      { type: 'system', message: { subtype: 'local_command_output', content: 'Compacted' } },
      { type: 'user', uuid: 'cost', message: { content: [{ type: 'text', text: '<local-command-stdout>Total cost: $0.25</local-command-stdout>' }] } },
      { type: 'system', message: { subtype: 'local_command_output', content: 'Context usage: 24k' } },
      { type: 'assistant', message: { model: 'opus', content: [{ type: 'text', text: 'Compacted' }] } },
    ]);
    await (h.session.loadTranscript as () => Promise<void>)();
    expect(sdk.history).toHaveBeenCalledWith('imported', { dir: h.rt.meta.cwd, includeSystemMessages: true });
    expect(h.rt.items.map(i => 'text' in i && i.text)).toEqual(['Conversation compacted', '<local-command-stdout>Total cost: $0.25</local-command-stdout>', 'Command output', 'Compacted']);
    expect(h.notices().at(-1)?.detail).toBe('Context usage: 24k');
  });
  it('publishes SDK-list-only work to the chat, counts a linked step once and clears on exit', async () => {
    const h = await atRest();
    await h.message(result([h.first.uuid]));
    await h.system({ subtype: 'background_tasks_changed', tasks: [
      { task_id: 'c', task_type: 'local_bash' }, { task_id: 'a', task_type: 'local_agent' },
      { task_id: 'ambient', task_type: 'monitor', ambient: true },
    ] });
    expect(h.rt.meta).toMatchObject({ commands: 1, background: 1, status: 'idle' });
    expect(h.session.holdsWork()).toBe(true);
    await h.call('bash-step', 'Bash', { command: 'build', run_in_background: true });
    await h.done('bash-step', { backgroundTaskId: 'c' });
    expect(h.rt.meta.commands).toBe(1);
    await h.system({ subtype: 'task_notification', task_id: 'c', status: 'completed' });
    expect(h.rt.meta).toMatchObject({ commands: 0, background: 1 });
    await h.session.close();
    expect(h.rt.meta).toMatchObject({ commands: 0, background: 0 });
  });

  it('a command run in the background is counted from its own result and its task, and ends with its notification', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.call('toolu_b1', 'Bash', { command: 'pnpm test', description: 'Run app tests', run_in_background: true });
    await h.done('toolu_b1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' });
    // The call's own result ties the task to its step, before any task event.
    expect(step(h.rt, 'toolu_b1').task).toMatchObject({ id: 'b1', kind: 'command', state: 'running' });
    expect(h.rt.meta.commands).toBe(1);
    await h.system({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_b1', task_type: 'local_bash', is_backgrounded: true, description: 'Run app tests' });
    await h.message(result([h.first.uuid]));
    expect(h.rt.turnActive).toBe(false);
    expect(h.session.liveWork()).toMatchObject({ turn: false, agents: 0, commands: 1 });
    expect(h.session.liveWork().oldestCommandAt).toBeTypeOf('number');
    expect(h.session.holdsWork()).toBe(true);
    await h.system({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_b1', status: 'failed', summary: 'Background command "Run app tests" failed with exit code 1' });
    expect(step(h.rt, 'toolu_b1').task).toMatchObject({ state: 'failed' });
    expect(h.rt.meta.commands).toBe(0);
    expect(h.session.holdsWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.session.holdsWork()).toBe(false);
  });

  it.each(['notification', 'list'])('a result-only command holds its process until its %s', async (end) => {
    const h = await atRest();
    await h.call('cmd', 'Bash', { command: 'test' });
    await h.done('cmd', { backgroundTaskId: 'command' });
    await h.message(result([h.first.uuid]));
    expect(h.rt.meta.commands).toBe(1);
    expect(h.session.liveWork().commands).toBe(1);
    expect(h.holder().busy()).toBe(true);
    if (end === 'list') await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    else await h.system({ subtype: 'task_notification', task_id: 'command', status: 'completed' });
    expect(h.session.liveWork().commands).toBe(0);
  });

  it('settles the superseded agent while a monitor keeps the task list live', async () => {
    const h = await atRest();
    await h.call('watcher', 'Monitor', { description: 'watch' });
    await h.done('watcher', { taskId: 'monitor' });
    for (const run of ['a', 'b']) {
      await h.call('tool-' + run, 'Agent', { description: run, run_in_background: true });
      await h.system({ subtype: 'task_started', task_id: 'agent', run_id: run, tool_use_id: 'tool-' + run, task_type: 'local_agent', is_backgrounded: true });
      await h.done('tool-' + run, { status: 'async_launched', agentId: 'agent' }, null, 'Agent running in background');
    }
    await h.system({ subtype: 'task_notification', task_id: 'agent', run_id: 'a', status: 'completed' });
    expect(step(h.rt, 'tool-b').result?.agent?.background).toBe('running');
    await h.system({ subtype: 'task_notification', task_id: 'agent', run_id: 'b', status: 'completed' });
    await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'monitor', task_type: 'monitor' }] });
    expect(step(h.rt, 'tool-a').result?.agent?.background).toBe('stopped');
    expect(step(h.rt, 'tool-b').result?.agent?.background).toBe('done');
    expect(h.rt.meta.background).toBe(0);
    expect(h.session.liveWork().commands).toBe(1);
  });

  it('late frames for a previous run leave the resumed task working', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    const start = async (run: string) => {
      const id = 'tool-' + run;
      await h.call(id, 'Agent', { description: run, run_in_background: true });
      await h.system({ subtype: 'task_started', task_id: 'agent', run_id: run, tool_use_id: id, task_type: 'local_agent', is_backgrounded: true });
      await h.done(id, { status: 'async_launched', agentId: 'agent' }, null, 'Agent running in background');
    };
    const end = (run: string) => h.system({ subtype: 'task_notification', task_id: 'agent', run_id: run, status: 'completed' });
    await start('a');
    await end('a');
    await start('b');
    await h.message(result([h.first.uuid]));
    await h.system({ subtype: 'task_progress', task_id: 'agent', run_id: 'a', summary: 'stale' });
    await end('a');
    await h.system({ subtype: 'task_updated', task_id: 'agent', run_id: 'a', patch: { status: 'completed' } });
    await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'agent', run_id: 'a', ambient: true }] });
    expect(h.session.liveWork().agents).toBe(1);
    expect(step(h.rt, 'tool-b').result?.agent?.background).toBe('running');
    expect(step(h.rt, 'tool-b').output).not.toBe('stale');
    await end('b');
    expect(h.session.holdsWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.session.holdsWork()).toBe(false);
  });

  it('a command moved to the background at its timeout is counted; a start after its end never marks it running again', async () => {
    vi.useFakeTimers();
    const h = await atRest();
    await h.call('toolu_t1', 'Bash', { command: 'pnpm e2e', description: 'Run e2e' });
    await h.system({ subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_t1', task_type: 'local_bash', is_backgrounded: false });
    // A foreground command is its call's: the turn's work, no background task.
    expect(step(h.rt, 'toolu_t1').task).toBeUndefined();
    expect(h.session.liveWork().commands).toBe(0);
    await h.system({ subtype: 'task_updated', task_id: 't1', patch: { is_backgrounded: true } });
    await h.done('toolu_t1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 't1', timedOutAfterMs: 120_000 });
    expect(step(h.rt, 'toolu_t1').task).toMatchObject({ id: 't1', state: 'running' });
    expect(h.session.liveWork().commands).toBe(1);
    await h.system({ subtype: 'task_updated', task_id: 't1', patch: { status: 'completed', end_time: Date.now() } });
    expect(step(h.rt, 'toolu_t1').task).toMatchObject({ state: 'done' });
    await h.system({ subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_t1', task_type: 'local_bash', is_backgrounded: true });
    expect(step(h.rt, 'toolu_t1').task?.state).toBe('done');
    expect(h.session.holdsWork()).toBe(true); // the person's turn still runs
    await h.message(result([h.first.uuid]));
    expect(h.session.holdsWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(h.session.holdsWork()).toBe(false);
  });

  it('a command gone from the live list with no word of its end is taken as stopped after a short grace; its word, when it comes, wins', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-19T09:00:00Z') });
    const h = await atRest();
    await h.background(1);
    await h.background(2);
    await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'a' }, { task_id: 'b2', task_type: 'local_bash', description: 'b' }] });
    await h.system({ subtype: 'background_tasks_changed', tasks: [] });
    // b2's notification comes within the grace; b1's never does.
    await h.system({ subtype: 'task_notification', task_id: 'b2', tool_use_id: 'toolu_b2', status: 'completed', summary: 'done' });
    expect(step(h.rt, 'toolu_b1').task?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(step(h.rt, 'toolu_b1').task?.state).toBe('stopped');
    expect(step(h.rt, 'toolu_b2').task?.state).toBe('done');
    expect(h.rt.meta.commands).toBe(0);
  });

  it("a monitor is tied to its step by its own result; a sub-agent's command counts too", async () => {
    const h = await atRest();
    await h.call('toolu_m1', 'Monitor', { description: 'Watch the build log', timeout_ms: 300_000, command: 'tail -f build.log' });
    await h.done('toolu_m1', { taskId: 'm1', timeoutMs: 300_000 });
    expect(step(h.rt, 'toolu_m1').task).toMatchObject({ id: 'm1', kind: 'monitor', state: 'running' });
    await h.call('toolu_a1', 'Agent', { description: 'Run checks', prompt: 'run', run_in_background: true });
    await h.call('toolu_c1', 'Bash', { command: 'pnpm lint', run_in_background: true }, 'toolu_a1');
    await h.done('toolu_c1', { stdout: '', backgroundTaskId: 'c1' }, 'toolu_a1');
    expect(step(h.rt, 'toolu_c1').task).toMatchObject({ id: 'c1', state: 'running' });
    expect(h.rt.meta.commands).toBe(2);
  });

  it('the wake-up and task readers take only what a result says', () => {
    expect(taskKindOf('local_bash')).toBe('command');
    expect(taskKindOf('local_agent')).toBe('agent');
    expect(taskKindOf('local_workflow')).toBe('agent');
    expect(taskKindOf('monitor_mcp')).toBe('monitor');
    expect(taskKindOf(undefined, 'Bash')).toBe('command');
    expect(taskKindOf('mcp_task')).toBe('other');
    expect(backgroundTaskOf('Bash', { stdout: 'x' })).toBeUndefined();
    expect(backgroundTaskOf('Bash', { backgroundTaskId: 'b9' })).toEqual({ id: 'b9', kind: 'command' });
    expect(backgroundTaskOf('Read', { backgroundTaskId: 'b9' })).toBeUndefined();
    expect(wakeOf('ScheduleWakeup', { delaySeconds: 600 }, undefined)).toBeUndefined();
    expect(wakeOf('ScheduleWakeup', {}, { scheduledFor: 123_456_789_000 })).toEqual({ loop: 123_456_789_000 });
    expect(wakeOf('CronDelete', { id: 'c1' }, { id: 'c1', endedLoopWakeup: true })).toEqual({ cron: { id: 'c1', at: null }, loop: null });
  });
});

// ─────────────────────────── D-lost: a process that goes away ───────────────────────────

describe('a process that goes away', () => {
  it.each(['death', 'capability'] as const)('reports an actual %s before discarding the process task identities', async cause => {
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    const heard = vi.fn();
    h.rt.onWorkLost = heard;
    if (cause === 'death') {
      await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'revived', task_type: 'local_agent', description: 'Review reports' }] });
      h.proc().end();
    } else {
      await h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'review', task_type: 'local_bash', description: 'Review reports' }] });
      expect(h.session.holdsWork()).toBe(true);
      // Exercise the recovery fallback if a capability restart is ever admitted despite a live task.
      vi.spyOn(h.session, 'holdsWork').mockReturnValueOnce(false);
      await h.session.setOptions!({ browser: true });
    }
    await until(() => !h.q(), 'the old process to end');
    expect(heard).toHaveBeenCalledWith(h.rt, cause, 1);
    expect(h.rt.pendingLost().names.join()).toContain('Review reports');
  });
  it('ends by itself at rest with a command running: the command is lost, one notice names it, the agent is told with its next message (A3)', async () => {
    const h = await atRest({ live: true });
    await h.background(1, 'Run app tests');
    await h.text("I'm waiting for the test notification.");
    await h.message(result([h.first.uuid]));
    expect(h.rt.turnActive).toBe(false);
    h.proc().end();
    await until(() => !h.q(), 'the process end');
    expect(step(h.rt, 'toolu_b1').task).toMatchObject({ state: 'lost', why: 'process' });
    expect(step(h.rt, 'toolu_b1').task?.endedAt).toBeUndefined();
    expect(h.rt.meta.commands).toBe(0);
    const told = h.notices().filter((n) => n.text.includes('lost'));
    expect(told).toEqual([expect.objectContaining({ variant: 'info', text: "1 background command was lost with the agent's process", detail: 'Run app tests' })]);
    // No turn was cut: nothing reads "Ended early".
    expect(h.notices().some((n) => n.early)).toBe(false);
    expect(h.rt.takeLost()).toEqual(['"Run app tests" (command, task b1)']);
  });

  it('ends by itself at rest with nothing running: nothing is said', async () => {
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    const before = h.rt.items.length;
    h.proc().end(new Error('Claude Code exited with code 1'));
    await until(() => !h.q(), 'the process end');
    expect(h.rt.items).toHaveLength(before);
    expect(h.rt.meta.status).toBe('idle');
  });

  it('ends by itself mid-turn: the turn ended early (died), its running step settled at that moment, no error', async () => {
    const h = await atRest({ live: true });
    await h.call('toolu_r1', 'Bash', { command: 'pnpm build', description: 'Build' });
    h.proc().end(new Error('Claude Code exited with code 1'));
    await until(() => !h.rt.turnActive, 'the cut');
    const early = h.notices().find((n) => n.early);
    expect(early).toMatchObject({ variant: 'info', text: 'Ended early', early: 'died' });
    expect(early!.detail).toContain('Claude Code exited with code 1');
    expect(h.rt.meta.status).toBe('idle');
    expect(h.rt.meta.lastError).toBeUndefined();
    expect(step(h.rt, 'toolu_r1')).toMatchObject({ status: 'cancelled' });
    expect(step(h.rt, 'toolu_r1').endedAt! - Date.now()).toBeLessThan(1000);
  });

  it("closed by the bridge with a turn its process runs: the turn ended early (closed); a turn it does not run is not its to end (D2)", async () => {
    const h = await atRest();
    await h.call('toolu_x1', 'Read', { file_path: 'a.ts' });
    await h.session.close();
    expect(h.rt.turnActive).toBe(false);
    expect(h.notices().find((n) => n.early)).toMatchObject({ text: 'Ended early', early: 'closed' });
    expect(step(h.rt, 'toolu_x1').status).toBe('cancelled');

    // A handle that runs nothing of the chat's (it never started a process) leaves its turn alone.
    const g = await claude();
    g.rt.beginTurn('Thinking');
    await g.session.close();
    expect(g.rt.turnActive).toBe(true);
    expect(g.notices()).toHaveLength(0);
  });

  it("a closed session is retired: a message sent to it throws, and no process starts on the account it was for (D6)", async () => {
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    await h.session.close();
    const started = sdk.procs.length;
    const late = h.rt.add<UserItem>({ type: 'user', text: 'one more thing', state: 'sent' });
    await expect(h.session.send(late)).rejects.toThrow(/closed/);
    await h.session.setOptions!({ remoteControl: true });
    expect(sdk.procs).toHaveLength(started);
  });

  it("close() resolves once the process's stream has ended, and is bounded when it never does (moves-M3)", async () => {
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    h.proc().closeLag = 150;
    const t0 = Date.now();
    await h.session.close();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
    expect(h.proc().closed).toBe(true);
    // A move asks whether it really ended: it did.
    await expect(h.session.exited()).resolves.toBeUndefined();

    const g = await atRest({ live: true });
    await g.message(result([g.first.uuid]));
    g.proc().closeLag = Infinity;
    vi.useFakeTimers();
    let over = false;
    void g.session.close().then(() => (over = true));
    // It did not: the bound is no exit, and a move then leaves the transcript behind (moves-M3).
    let ended: boolean | undefined;
    void g.session.exited().then(
      () => (ended = true),
      () => (ended = false),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(over).toBe(false);
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(over).toBe(true);
    expect(ended).toBe(false);
    g.proc().end();
  });

  it('a failed spawn leaves no writer after the replacement exits', async () => {
    const failed = new EventEmitter();
    const replacement = Object.assign(new EventEmitter(), { pid: 123 });
    const children = [failed, replacement];
    vi.spyOn(authGate, 'spawner').mockReturnValue(() => children.shift()! as ReturnType<ReturnType<typeof authGate.spawner>>);
    sdk.child.use = true;
    const h = await atRest({ live: true });
    failed.on('error', () => {});
    failed.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn claude' }));
    h.proc().end(new Error('failed to launch'));
    await until(() => !h.q(), 'failed query cleanup');
    const b = await h.send('retry');
    await h.message(result([b.uuid]));
    replacement.emit('exit', 0, null);
    vi.useFakeTimers();
    const closed = h.session.close();
    const confirmed = expect(h.session.exited()).resolves.toBeUndefined();
    const checked = Promise.all([closed, confirmed]);
    await Promise.all([checked, vi.advanceTimersByTimeAsync(3100)]);
  });

  it.each(['close', 'iterator first'])('exited waits for the spawned child after SDK cleanup (%s)', async (order) => {
    const child = new EventEmitter();
    vi.spyOn(authGate, 'spawner').mockReturnValue(() => child as ReturnType<ReturnType<typeof authGate.spawner>>);
    sdk.child.use = true;
    const h = await atRest({ live: true });
    await h.message(result([h.first.uuid]));
    if (order === 'iterator first') {
      h.proc().end();
      await until(() => !h.q(), 'SDK cleanup');
    }
    vi.useFakeTimers();
    const close = h.session.close();
    const exit = h.session.exited();
    child.emit('error', Object.assign(new Error('kill failed'), { syscall: 'kill', code: 'EPERM' }));
    const bound = expect(exit).rejects.toThrow(/not ended/);
    await vi.advanceTimersByTimeAsync(3100);
    await Promise.all([close, bound]);
    child.emit('exit', 0, null);
    await expect(h.session.exited()).resolves.toBeUndefined();
  });

  it('a result for a step already settled keeps the end it got then', async () => {
    const h = await atRest();
    await h.call('toolu_o1', 'Bash', { command: 'sleep 9999', description: 'Wait' });
    h.rt.settle('cancelled');
    const end = step(h.rt, 'toolu_o1').endedAt;
    expect(end).toBeTypeOf('number');
    await tick(20);
    await h.done('toolu_o1', { stdout: 'late' });
    expect(step(h.rt, 'toolu_o1')).toMatchObject({ status: 'cancelled', endedAt: end });
  });
});
