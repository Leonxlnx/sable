/**
 * Whose message it is, and what a turn cost, in the Claude Code adapter (review of 23 Nov, DIAG areas
 * messages, turns B4/B5, lifetime A5, moves D4; CONTRACT D-own and D-cost):
 * - a message Sable sent is Sable's for good: a replay of it is never a message from the Claude app,
 *   whatever a result or a turn's end did before it came (S3: the person's card with a picture, a lone
 *   "$204.3" line, then the same words again "From the Claude app" with no picture);
 * - a result that names no message never answers one Claude Code has not read, and one that belongs to
 *   earlier work stands above the person's message without ending their turn; a message that never
 *   comes back keeps its turn only for a while;
 * - a real message from the Claude app stays the app's (also with the same words), with its pictures,
 *   bounded; a steer folded in with the note Sable adds stays Sable's;
 * - the CLI's running total is kept per conversation: a resumed process's first result books only
 *   what it added, never the whole chat's cost;
 * - a limit card the bridge already decided is never reused by a later refusal (D4).
 * The adapter is driven with fake SDK messages (no real agent turns): a stand-in process that records
 * what is pushed, or (where its own start and reading loop matter) a fake SDK `query`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, STEER_FIRST_BLOCK, type NoticeItem, type SessionMeta, type TextItem, type TimelineItem, type ToolItem, type TurnItem, type UserItem } from '@shared/protocol';
import { HANDOVER_HEAD_ACCOUNT, HANDOVER_JOIN, HANDOVER_TAIL, lostTasksNote, stripWrappers } from '@shared/synthetic';
import { App } from '../server/app';
import { claudeFolderKey } from '../server/core/lanes';
import { SessionRuntime } from '../server/core/runtime';
import { READ } from '../server/core/session-file';
import { isLight, resultForWindow } from '../server/core/trim';
import { ClaudeProvider } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import { appPictures, ownReplays, plainWords } from '../server/providers/claude-tools';
import type { ProviderSession } from '../server/providers/types';

/** A fake SDK `query`: a stream a test writes to (`out`) and ends (`end`), ended too by `close()`. */
const sdk = vi.hoisted(() => {
  type Proc = { options?: { resume?: string; model?: string }; pushed: unknown[]; out(m: unknown): void; end(err?: Error): void; q: Record<string | symbol, unknown> };
  const procs: Proc[] = [];
  function fakeQuery(p: { prompt: AsyncIterable<unknown>; options?: Proc['options'] }) {
    const buf: unknown[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    const proc: Proc = {
      options: p.options,
      pushed: [],
      out(m) {
        buf.push(m);
        wake?.();
      },
      end(error) {
        failure = error;
        done = true;
        wake?.();
      },
      q: {
        interrupt: async () => {},
        close: () => proc.end(),
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
  return { procs, fakeQuery, history: vi.fn(), fork: vi.fn() };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), getSessionMessages: sdk.history, forkSession: sdk.fork, query: (p: { prompt: AsyncIterable<unknown> }) => sdk.fakeQuery(p) }));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
  sdk.procs.length = 0;
});

type Obj = Record<string, unknown>;
type Session = Obj & ProviderSession;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const users = (rt: SessionRuntime) => rt.items.filter((i): i is UserItem => i.type === 'user' && !i.parentId);
const turns = (rt: SessionRuntime) => rt.items.filter((i): i is TurnItem => i.type === 'turn' && !i.parentId);
const at = (rt: SessionRuntime, id: string) => rt.items.findIndex((i) => i.id === id);
const result = (uuids?: string[], extra: Obj = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage: {}, total_cost_usd: 0, ...(uuids ? { user_message_uuids: uuids, user_message_uuid: uuids.at(-1) } : {}), ...extra });

/** A small picture, as the composer attaches one and as Claude Code replays it. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const picture = { id: 'att-1', kind: 'image' as const, name: 'screenshot.png', dataUrl: `data:image/png;base64,${PNG}`, mime: 'image/png' };
const imageBlock = (data = PNG, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data } });

/**
 * The adapter on a chat of its own. `live`: its own `ensure` and reading loop on the fake `query`
 * above; otherwise a stand-in process that only records what is pushed, and a test hands each frame
 * to the adapter itself.
 */
async function claude(opts: { live?: boolean; meta?: Partial<SessionMeta>; runtime?: SessionRuntime } = {}) {
  const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
  const anyP = p as unknown as Obj;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
  anyP.readLimits = async () => [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...opts.meta };
  const rt = opts.runtime ?? new SessionRuntime(meta, () => {}, () => {});
  const session = (await p.open(rt, {})) as unknown as Session;
  const pushed: { uuid: string; priority?: string; message: { content: unknown } }[] = [];
  const stand = { interrupt: async () => undefined, close: () => {} };
  if (!opts.live) {
    session.ensure = function (this: Obj) {
      this.q ??= stand;
      this.input ??= { push: (m: (typeof pushed)[number]) => pushed.push(m), end: () => {} };
      return this.q;
    };
  }
  cleanups.push(() => session.close());
  const proc = () => sdk.procs.at(-1)!;
  const message = async (m: Obj) => {
    const frame = { session_id: 'cc1', ...m };
    if (opts.live) {
      proc().out(frame);
      await tick(5);
    } else (session.onMessage as (m: unknown) => void).call(session, frame);
  };
  /** The person sends a message (steered when a turn runs, as the composer does). */
  const send = async (text: string, attachments?: UserItem['attachments']) => {
    const item = rt.add<UserItem>({ type: 'user', text, ...(attachments ? { attachments } : {}), state: rt.turnActive ? 'queued' : 'sent', ...(rt.turnActive ? { steered: true } : {}) });
    await session.send(item);
    if (opts.live) await tick(5);
    const last = (opts.live ? proc().pushed.at(-1) : pushed.at(-1)) as (typeof pushed)[number];
    return { item, uuid: last.uuid, content: last.message.content };
  };
  const replay = (uuid: string, content: unknown, extra: Obj = {}) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
  const text = (t: string, extra: Obj = {}) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] }, ...extra });
  const state = (s: 'idle' | 'running' | 'requires_action') => message({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `st-${Math.random()}` });
  return { p, rt, session, pushed, proc, message, send, replay, text, state, q: () => session.q as object | undefined };
}

it('uses the original input to map a late Write result on a restored row', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-late-input-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const meta: SessionMeta = { id: 's', provider: 'demo', cwd: home, title: 'Late result', titleSource: 'user',
    model: 'm', mode: 'default', status: 'idle', createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const input = { file_path: 'record.txt', content: 'the original Write input' };
  const write: ToolItem = { id: 'write', type: 'tool', ts: 1, status: 'done', kind: 'write', name: 'Write', title: 'Write', detail: {}, input };
  const items: TimelineItem[] = [write, ...Array.from({ length: 4 }, (_, ts) => ({ type: 'turn' as const, id: 't' + ts, ts, durationMs: 1 }))];
  mkdirSync(path.join(home, 'sessions'));
  writeFileSync(path.join(home, 'sessions', 's.json'), '{"gen":1,"items":[\n' + items.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ sessions: [meta], projects: [], accounts: [] }));
  const threshold = READ.inWorkerAbove;
  READ.inWorkerAbove = 1;
  cleanups.push(() => { READ.inWorkerAbove = threshold; });
  const app = new App({ home, quiet: true, providers: [ctx => new DemoProvider(ctx)] });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.snapshot', { sessionId: meta.id });
  const rt = app.runtime(meta.id);
  const row = rt.get<ToolItem>(write.id)!;
  expect(isLight(row)).toBe(true);
  const reads = vi.spyOn(app.store, 'wholeItem');
  expect(JSON.stringify(resultForWindow(snap))).not.toContain(input.content);
  expect(reads).not.toHaveBeenCalled();
  expect(row.input).toEqual(input);
  expect(isLight(row)).toBe(true);
  const h = await claude({ runtime: rt });
  await h.message({ type: 'user', parent_tool_use_id: 'agent', message: { content: [{ type: 'tool_result', tool_use_id: write.id, content: 'ok' }] } });
  expect(row.result?.diff?.[0]).toMatchObject({ path: input.file_path, additions: 1, hunks: [{ lines: ['+' + input.content] }] });
  expect(row.input).toEqual(input);
  expect(isLight(row)).toBe(false);
  expect(row).not.toHaveProperty('inputText');
});

// ───────────────────────────── D-own: a message Sable sent is Sable's ─────────────────────────────

describe("whose message it is (S3)", () => {
  it("a picture sent into a resumed process, and a result naming nothing before its replay: one card, Sable's, no line with the chat's cost, the turn open until its own result", async () => {
    const h = await claude({ live: true, meta: { providerSessionId: 'cc1', usage: { inputTokens: 0, outputTokens: 0, turns: 0, cliCost: { session: 'cc1', total: 200 } } } });
    // Earlier that day: a turn in the first process, which its result names.
    const a = await h.send('run the tests');
    await h.replay(a.uuid, 'run the tests');
    await h.text('All green.');
    await h.message(result([a.uuid], { total_cost_usd: 204.3, usage: { input_tokens: 900, output_tokens: 40 } }));
    // Hours later the process is gone.
    h.proc().end();
    await tick(10);
    expect(h.q()).toBeUndefined();
    // The person sends words and a picture: a new process resumes the conversation.
    const b = await h.send('what is wrong in this screenshot', [picture]);
    expect(sdk.procs).toHaveLength(2);
    expect(JSON.stringify(b.content)).toContain('"type":"image"');
    // Its first word: a result that names nothing, with no work in it and the conversation's saved total.
    await h.message(result(undefined, { total_cost_usd: 204.3 }));
    expect(h.rt.turnActive).toBe(true);
    expect(turns(h.rt)).toHaveLength(1);
    // Then it takes the message.
    await h.replay(b.uuid, [imageBlock(), { type: 'text', text: 'what is wrong in this screenshot' }]);
    expect(users(h.rt).map((u) => u.text)).toEqual(['run the tests', 'what is wrong in this screenshot']);
    expect(users(h.rt).some((u) => u.remote)).toBe(false);
    expect(h.rt.get<UserItem>(b.item.id)).toMatchObject({ state: 'sent', providerId: b.uuid, attachments: [{ kind: 'image' }] });
    expect(h.rt.turnActive).toBe(true);
    await h.text('The button overlaps the field.');
    expect(h.rt.turnActive).toBe(true);
    await h.message(result([b.uuid], { total_cost_usd: 208.24, usage: { input_tokens: 1200, output_tokens: 60 } }));
    expect(h.rt.turnActive).toBe(false);
    // One line for its turn, under its card, with what that turn alone cost; the first turn's line too.
    const lines = turns(h.rt);
    expect(lines).toHaveLength(2);
    expect(at(h.rt, lines[1].id)).toBeGreaterThan(at(h.rt, b.item.id));
    expect(lines[0].costUsd).toBeCloseTo(4.3);
    expect(lines[1].costUsd).toBeCloseTo(3.94);
    expect(h.rt.meta.usage.costUsd).toBeCloseTo(8.24);
    expect(h.rt.meta.usage.cliCost).toEqual({ session: 'cc1', total: 208.24 });
  });

  it("a resumed process's first result that books only a cost, with the person's message still on its way: no line, the turn stays open", async () => {
    const h = await claude({ live: true, meta: { providerSessionId: 'cc1', usage: { inputTokens: 0, outputTokens: 0, turns: 0, cliCost: { session: 'cc1', total: 200 } } } });
    const a = await h.send('run the tests');
    await h.replay(a.uuid, 'run the tests');
    await h.text('All green.');
    await h.message(result([a.uuid], { total_cost_usd: 204.3, usage: { input_tokens: 900, output_tokens: 40 } }));
    h.proc().end();
    await tick(10);
    // Sable was restarted; the person writes; a new process resumes the conversation.
    const b = await h.send('continue now');
    expect(sdk.procs).toHaveLength(2);
    // Its first word names nothing and has no tokens, but its total has grown by what ran unseen
    // (sub-agents' last requests): as built this stood as a bare "$0.10" under the message, the turn closed.
    await h.message(result(undefined, { total_cost_usd: 204.4 }));
    expect(h.rt.turnActive).toBe(true);
    expect(turns(h.rt)).toHaveLength(1);
    expect(h.rt.items.at(-1)).toMatchObject({ id: b.item.id, type: 'user' });
    // The chat's own total has it all the same.
    expect(h.rt.meta.usage.costUsd).toBeCloseTo(4.4);
    await h.replay(b.uuid, 'continue now');
    await h.text('On it.');
    await h.message(result([b.uuid], { total_cost_usd: 205, usage: { input_tokens: 1000, output_tokens: 20 } }));
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.items.map((i) => i.type)).toEqual(['user', 'text', 'turn', 'user', 'text', 'turn']);
    expect(turns(h.rt)[1].costUsd).toBeCloseTo(0.6);
  });

  it('a result naming the rewritten UUID binds when the matching replay arrives', async () => {
    const h = await claude({ live: true, meta: { providerSessionId: 'cc1' } });
    const mine = await h.send('keep the exports');
    await h.text('The old exports stay.');
    await h.message(result(['rewritten'], { result: 'The old exports stay.' }));
    expect(h.rt.turnActive).toBe(true);
    await h.replay('rewritten', 'keep the exports');
    expect(users(h.rt)).toHaveLength(1);
    expect(users(h.rt)[0]).toMatchObject({ id: mine.item.id, providerId: 'rewritten' });
    expect(users(h.rt)[0].remote).toBeUndefined();
    expect(h.rt.items.map((i) => i.type)).toEqual(['user', 'text', 'turn']);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.answeredBy(mine.item.id)).toBe(turns(h.rt)[0].id);
  });

  it('a result naming the message before its replay leaves its card above the result and the chat idle', async () => {
    const h = await claude();
    const a = await h.send('look at this', [picture]);
    // A result that names it, before Claude Code replays it (as for a delivery it then made again).
    await h.message(result([a.uuid]));
    expect(h.rt.turnActive).toBe(false);
    const first = turns(h.rt)[0];
    await h.replay(a.uuid, [imageBlock(), { type: 'text', text: 'look at this' }]);
    expect(users(h.rt)).toHaveLength(1);
    expect(users(h.rt)[0]).toMatchObject({ id: a.item.id, state: 'sent', providerId: a.uuid, attachments: [{ kind: 'image' }] });
    expect(users(h.rt)[0].remote).toBeUndefined();
    expect(at(h.rt, a.item.id)).toBeLessThan(at(h.rt, first.id));
    expect(h.rt.turnActive).toBe(false);
    await h.text('A cat.');
    await h.message(result([a.uuid]));
    expect(h.rt.turnActive).toBe(false);
    // A repeat of the replay changes nothing.
    await h.replay(a.uuid, 'look at this');
    expect(users(h.rt)).toHaveLength(1);
    expect(h.rt.turnActive).toBe(false);
  });

  it("before anything told the CLI's ways, a result that came first answers the message; its replay is still the same card", async () => {
    const h = await claude();
    const a = await h.send('check the build');
    // This test models an older binary that has never named a message.
    h.p.seen.names = false;
    await h.message(result());
    expect(h.rt.turnActive).toBe(false);
    await h.replay(a.uuid, 'check the build');
    expect(users(h.rt)).toHaveLength(1);
    expect(users(h.rt)[0].remote).toBeUndefined();
    expect(h.rt.turnActive).toBe(true);
    await h.text('Built.');
    await h.message(result([a.uuid]));
    expect(h.rt.turnActive).toBe(false);
  });

  it('keeps the personal limit card after a legacy guessed result and late replay', async () => {
    const h = await claude({ meta: { providerSessionId: 'cc1' } });
    h.p.seen.names = false;
    const a = await h.send('check the build');
    await h.message(result());
    await h.replay(a.uuid, 'check the build');
    const hits = vi.fn();
    h.rt.onBackgroundLimit = hits;
    await h.message({ type: 'assistant', uuid: 'refused', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Fable limit" }] } });
    expect(h.rt.items.filter((i) => i.type === 'notice' && i.limit)).toHaveLength(1);
    expect(hits).not.toHaveBeenCalled();
    await h.message(result([a.uuid], { is_error: true, errors: ['HTTP 429'] }));
    expect(h.rt.turnActive).toBe(false);
  });

  it('a result naming nothing never answers a message Claude Code has not read once the CLI is known to name, also learnt in another chat; earlier work stands above the message', async () => {
    const h = await claude();
    const a = await h.send('first');
    await h.replay(a.uuid, 'first');
    // Its reply is stamped with the message it answers: this CLI names them.
    await h.text('First done.', { user_message_uuid: a.uuid, user_message_uuids: [a.uuid] });
    await h.message(result([a.uuid], { usage: { input_tokens: 10, output_tokens: 3 } }));
    expect(h.rt.turnActive).toBe(false);
    const b = await h.send('second');
    // Work it took up by itself ends first, with what it used.
    await h.text('Checked the deploy again.');
    await h.message(result(undefined, { usage: { input_tokens: 20, output_tokens: 5 } }));
    expect(h.rt.turnActive).toBe(true);
    const lines = turns(h.rt);
    expect(lines).toHaveLength(2);
    // That work's line stands above the person's message, which begins what comes next.
    expect(at(h.rt, b.item.id)).toBeGreaterThan(at(h.rt, lines[1].id));
    await h.replay(b.uuid, 'second');
    await h.text('Second done.');
    await h.message(result([b.uuid]));
    expect(h.rt.turnActive).toBe(false);
    expect(users(h.rt).some((u) => u.remote)).toBe(false);
    // Another chat of the same provider reads its first result so before any of its own named a message.
    const rt2 = new SessionRuntime({ ...h.rt.meta, id: 's2', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, () => {}, () => {});
    const other = (await h.p.open(rt2, {})) as unknown as Session;
    const sent: { uuid: string }[] = [];
    other.ensure = function (this: Obj) {
      this.q ??= { interrupt: async () => undefined, close: () => {} };
      this.input ??= { push: (m: { uuid: string }) => sent.push(m), end: () => {} };
      return this.q;
    };
    cleanups.push(() => other.close());
    const c = rt2.add<UserItem>({ type: 'user', text: 'third', state: 'sent' });
    await other.send(c);
    (other.onMessage as (m: unknown) => void).call(other, { session_id: 'cc2', ...result() });
    expect(rt2.turnActive).toBe(true);
    expect(rt2.get<UserItem>(c.id)?.state).toBe('sent');
  });

  it("a result whose sends still wait in Claude Code's queue answers none of them, whatever is known of the CLI", async () => {
    const h = await claude();
    await h.send('first');
    await h.message(result(undefined, { queued_turn_count: 1 }));
    expect(h.rt.turnActive).toBe(true);
  });
});

describe('the first send in a reopened query', () => {
  it('keeps a second send made before init on its own card through a batched result and rewritten replay', async () => {
    const h = await claude({ live: true, meta: { providerSessionId: 'cc1' } });
    const a = await h.send('first');
    const b = await h.send('also check the logs');
    expect(sdk.procs).toHaveLength(1);
    await h.text('The logs are clean.');
    await h.message(result([a.uuid, b.uuid], { result: 'The logs are clean.' }));
    await h.replay('changed-at-start', 'also check the logs');
    expect(users(h.rt).map((u) => [u.id, !!u.remote])).toEqual([[a.item.id, false], [b.item.id, false]]);
    expect(h.rt.items.map((i) => i.type)).toEqual(['user', 'user', 'text', 'turn']);
    expect(h.rt.turnActive).toBe(false);
  });

  for (const reason of ['model change', 'account move', 'idle close']) {
    it.each(['before', 'after'])('keeps the long startup send on one card after ' + reason + ', with a changed replay UUID %s its result', async (when) => {
      let h = await claude({ live: true });
      const first = await h.send('earlier work');
      await h.replay(first.uuid, 'earlier work');
      if (reason === 'idle close') vi.useFakeTimers();
      const end = h.message(result([first.uuid]));
      if (reason === 'idle close') await vi.advanceTimersByTimeAsync(10);
      await end;
      if (reason === 'idle close') {
        await vi.advanceTimersByTimeAsync(8 * 60_000 + 100);
        vi.useRealTimers();
      } else {
        await h.session.close();
        h.rt.update(reason === 'model change' ? { model: 'fable' } : { accountId: 'another' });
        h = await claude({ live: true, runtime: h.rt });
      }
      expect(h.q()).toBeUndefined();
      const words = 'Keep the old exports and explain what happens to the pending updates. '.repeat(30).trim();
      const own = await h.send(words);
      expect(h.rt.meta.activity).toBe('Starting');
      expect(h.proc().options?.resume).toBe('cc1');
      if (reason === 'model change') expect(h.proc().options?.model).toBe('fable');
      if (when === 'before') await h.replay('cli-copy', words);
      await h.text('The exports are preserved.');
      await h.message(result([own.uuid]));
      if (when === 'after') await h.replay('cli-copy', words);
      expect(users(h.rt).filter((u) => u.text === words).map((u) => [u.id, !!u.remote])).toEqual([[own.item.id, false]]);
      expect(h.rt.turnActive).toBe(false);
    });
  }
});

describe('a message that never comes back', () => {
  it.each(['withdrawal', 'failed launch', 'delivery'] as const)('puts the lost-task note on one startup send and settles its reservation on %s', async (end) => {
    const h = await claude({ live: true });
    const step = h.rt.add<ToolItem>({ type: 'tool', kind: 'bash', name: 'Bash', title: 'Build', status: 'done', detail: {} });
    h.rt.taskStarted(step.id, { id: 'build', kind: 'command' });
    h.rt.tasksLost('process');
    const send = async (text: string) => {
      const batch = h.rt.reserveLost();
      const item = h.rt.add<UserItem>({ type: 'user', text, state: h.rt.turnActive ? 'queued' : 'sent', steered: h.rt.turnActive });
      await h.session.send({ ...item, text: text + lostTasksNote(batch.names) }, { taken: batch.taken, release: batch.release });
      await tick();
      return h.proc().pushed.at(-1) as { uuid: string; message: { content: unknown } };
    };
    const a = await send('first');
    const b = await send('second');
    expect(JSON.stringify(a.message.content)).toContain('task build');
    expect(JSON.stringify(b.message.content)).not.toContain('task build');
    if (end === 'delivery') await h.replay(a.uuid, a.message.content);
    else if (end === 'withdrawal') {
      await h.session.interrupt();
      await h.message(result(undefined, { is_error: true, errors: ['Interrupted'], queued_turn_count: 2 }));
    } else {
      h.proc().end(new Error('gated CLI failed to launch'));
      await until(() => !h.q(), 'query exit');
    }
    expect(h.rt.reserveLost().names.length).toBe(end === 'delivery' ? 0 : 1);
  });

  it('a named result after Stop removes the executed queue copy', async () => {
    vi.useFakeTimers();
    const h = await claude();
    h.p.seen.names = false;
    const a = await h.send('deploy once');
    h.rt.stopRequested = true;
    await h.session.interrupt();
    vi.advanceTimersByTime(2501);
    expect(h.rt.queue.map(q => q.id)).toEqual([a.item.id]);
    await h.message(result([a.uuid]));
    expect(h.rt.queue).toEqual([]);
    expect(h.rt.get<UserItem>(a.item.id)?.providerId).toBe(a.uuid);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.stopRequested).toBe(true);
  });

  it('binds the first take to the original picture after an edited redispatch', async () => {
    const h = await claude();
    const a = await h.send('begin');
    await h.replay(a.uuid, 'begin');
    const b = await h.send('Look at this', [picture]);
    await h.session.interrupt();
    await h.message(result([a.uuid], { is_error: true }));
    const queued = h.rt.takeQueued(b.item.id)!;
    const changed = { ...picture, dataUrl: 'data:image/png;base64,YmJi' };
    const resend = await h.send(queued.text, [changed]);
    await h.replay(b.uuid, b.content);
    await h.message(result([b.uuid]));
    expect(h.rt.get<UserItem>(b.item.id)).toMatchObject({ providerId: b.uuid, attachments: [picture] });
    expect(h.rt.answeredBy(b.item.id)).toBe(turns(h.rt).at(-1)?.id);
    expect(h.rt.answeredBy(resend.item.id)).toBeUndefined();
  });

  it('keeps the edited picture when redispatch reuses the queue item ID', async () => {
    const h = await claude();
    const a = await h.send('begin');
    await h.replay(a.uuid, 'begin');
    const b = await h.send('Look at this', [picture]);
    await h.session.interrupt();
    await h.message(result([a.uuid], { is_error: true }));
    const queued = h.rt.takeQueued(b.item.id)!;
    const changed = { ...picture, dataUrl: 'data:image/png;base64,YmJi' };
    const edited = h.rt.add<UserItem>({ id: queued.id, type: 'user', text: queued.text, attachments: [changed], state: 'sent' });
    await h.session.send(edited);
    await h.replay(b.uuid, b.content);
    await h.message(result([b.uuid]));
    const original = users(h.rt).find(u => u.providerId === b.uuid);
    expect(original?.attachments).toEqual([picture]);
    expect(h.rt.answeredBy(original!.id)).toBe(turns(h.rt).at(-1)?.id);
    expect(h.rt.answeredBy(edited.id)).toBeUndefined();
  });

  it('splits both Continue UUIDs named by a batch result', async () => {
    const h = await claude();
    const a = await h.send('Continue');
    await h.replay('app-continue', 'Continue');
    await h.message(result([a.uuid, 'app-continue']));
    expect(users(h.rt).map(u => [u.providerId, !!u.remote])).toEqual([[a.uuid, false], ['app-continue', true]]);
    expect(users(h.rt).map(u => h.rt.answeredBy(u.id))).toEqual([turns(h.rt)[0].id, turns(h.rt)[0].id]);
    expect(h.rt.turnActive).toBe(false);
  });

  it('keeps an app Continue with its assistant-then-result refusal', async () => {
    const h = await claude();
    const a = await h.send('Continue');
    await h.text('First answer.', { user_message_uuid: a.uuid });
    await h.message(result([a.uuid]));
    await h.replay('app-continue', 'Continue');
    const hits = vi.fn();
    h.rt.onBackgroundLimit = hits;
    await h.message({ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Fable limit" }] } });
    await h.message(result(['app-continue'], { is_error: true, errors: ['HTTP 429'] }));
    expect(hits).not.toHaveBeenCalled();
    const remote = users(h.rt).find(u => u.remote)!;
    expect(h.rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit).map(n => n.limit)).toMatchObject([{ userItemId: remote.id, window: 'Weekly · Fable' }]);
    expect(h.rt.turnActive).toBe(false);
  });

  it('keeps both independent refusal owners and windows', async () => {
    const h = await claude();
    const a = await h.send('first');
    const b = await h.send('second');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    await h.message(result([a.uuid], { is_error: true, errors: ["You've hit your Fable limit · resets Nov 25, 3pm (Europe/Berlin)"] }));
    await h.message(result([b.uuid], { is_error: true, errors: ["You've hit your 5-hour limit · resets Nov 25, 4pm (Europe/Berlin)"] }));
    const cards = h.rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit);
    expect(cards.map(n => n.limit)).toMatchObject([
      { userItemId: a.item.id, window: 'Weekly · Fable', resetsAt: 1795615200000 },
      { userItemId: b.item.id, window: '5-hour limit', resetsAt: 1795618800000 },
    ]);
  });

  it('returns both unread instructions in original send order after an earlier footer', async () => {
    vi.useFakeTimers();
    const h = await claude();
    h.p.seen.names = true;
    const a = await h.send('first');
    const b = await h.send('second');
    await h.message(result(undefined, { usage: { output_tokens: 3 } }));
    vi.advanceTimersByTime(61_000);
    expect(h.rt.queue.map(q => q.id)).toEqual([a.item.id, b.item.id]);
  });

  it('arms a fresh unread deadline when the CLI stays idle across two turns', async () => {
    vi.useFakeTimers();
    const h = await claude();
    const a = await h.send('first');
    await h.replay(a.uuid, 'first');
    const b = await h.send('second');
    await h.message(result([a.uuid]));
    await h.state('idle');
    await h.message(result([b.uuid]));
    const c = await h.send('third');
    await h.state('idle');
    vi.advanceTimersByTime(61_000);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map(q => q.id)).toEqual([c.item.id]);
  });

  it('background sub-agent progress cannot extend the unread steer deadline', async () => {
    vi.useFakeTimers();
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?');
    await h.message(result([a.uuid]));
    await h.state('idle');
    await h.message({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg', task_type: 'local_agent' }] });
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(21_000);
      await h.message({ type: 'system', subtype: 'task_progress', task_id: 'bg', description: 'Checking' });
    }
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map(q => q.id)).toEqual([b.item.id]);
    expect(h.session.liveWork?.()?.agents).toBe(1);
  });

  it.each(['same query', 'resumed query', 'resumed query with an earlier rewrite'])('matches the folded payload after its canonical stamp in the %s', async (where) => {
    const h = await claude({ live: true });
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?', [picture]);
    await h.text('Three tests.', { user_message_uuid: b.uuid });
    if (where !== 'same query') {
      if (where === 'resumed query with an earlier rewrite') await h.replay('first-rewrite', b.content);
      await h.message(result([a.uuid, b.uuid]));
      h.proc().end();
      await until(() => !h.q(), 'old query exit');
      await h.send('resume');
    }
    await h.replay('folded-b', b.content);
    expect(users(h.rt).filter(u => u.remote)).toEqual([]);
    expect(users(h.rt).filter(u => u.text === 'what passed?').map(u => [u.id, !!u.remote])).toEqual([[b.item.id, false]]);
    if (where === 'same query') {
      await h.message(result([a.uuid, 'folded-b']));
      expect(h.rt.turnActive).toBe(false);
    }
  });

  it('binds a result-only final after a canonical stamp and a rewritten result', async () => {
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?');
    await h.message(result([a.uuid]));
    await h.text('Checking.', { user_message_uuid: b.uuid });
    await h.message(result(['folded-b'], { result: 'All three passed.' }));
    const footer = turns(h.rt).at(-1)!;
    await h.replay('folded-b', b.content);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.answeredBy(b.item.id)).toBe(footer.id);
    const answer = h.rt.items.slice(at(h.rt, b.item.id) + 1, at(h.rt, footer.id));
    expect(answer.filter((row): row is TextItem => row.type === 'text').map(row => row.text)).toEqual(['Checking.', 'All three passed.']);
  });

  it.each(['before timeout', 'after timeout', 'during a later tool'] as const)('binds a rewritten result and its final answer to the originating steer %s', async (when) => {
    vi.useFakeTimers();
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?');
    await h.message(result([a.uuid]));
    await h.message(result(['rewritten-b'], { result: 'Three tests passed.' }));
    const footer = turns(h.rt).at(-1)!;
    if (when !== 'before timeout') {
      vi.advanceTimersByTime(61_000);
      expect(h.rt.queue.map(q => q.id)).toEqual([b.item.id]);
    }
    if (when === 'during a later tool') {
      await h.replay('wake', '<task-notification><task-id>w</task-id><status>completed</status></task-notification>', { isSynthetic: true });
      await h.message({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'later', name: 'Bash', input: { command: 'test' } }] } });
    }
    await h.replay('rewritten-b', b.content);
    expect(h.rt.turnActive).toBe(when === 'during a later tool');
    if (when === 'during a later tool') expect(h.rt.get<ToolItem>('later')?.status).toBe('running');
    expect(h.rt.queue).toEqual([]);
    expect(h.rt.answeredBy(b.item.id)).toBe(footer.id);
    expect(h.rt.items.slice(at(h.rt, b.item.id) + 1, at(h.rt, footer.id))).toMatchObject([{ type: 'text', text: 'Three tests passed.' }]);
  });

  it.each(['replay', 'stamp', 'result'])('a quiet unread steer returns to the held queue and a late %s reclaims its UUID', async (ack) => {
    vi.useFakeTimers();
    const h = await claude();
    // The runtime hands a held turn to App.afterTurn, which returns the untaken steers.
    h.rt.onTurnEnd = (rt, _error, opts) => { if (opts?.hold) rt.returnUntaken({ reason: 'stopped' }); };
    const first = await h.send('begin');
    await h.replay(first.uuid, 'begin');
    const steer = await h.send('what happened?');
    await h.message(result([first.uuid]));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map((q) => q.id)).toEqual([steer.item.id]);
    if (ack === 'replay') await h.replay(steer.uuid, 'what happened?');
    if (ack !== 'result') await h.text('The tests passed.', ack === 'stamp' ? { user_message_uuid: steer.uuid } : {});
    await h.message(result([steer.uuid], { result: 'The tests passed.' }));
    await h.replay(steer.uuid, 'what happened?');
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue).toEqual([]);
    expect(h.rt.get<UserItem>(steer.item.id)).toMatchObject({ providerId: steer.uuid, state: 'sent', steered: true });
    const reply = h.rt.items.find((i) => i.type === 'text' && !i.parentId && i.text === 'The tests passed.')!;
    expect(at(h.rt, reply.id)).toBeGreaterThan(at(h.rt, steer.item.id));
  });

  it('reclaims a withdrawn steer by its rewritten replay and matching picture', async () => {
    vi.useFakeTimers();
    const h = await claude();
    const first = await h.send('begin');
    await h.replay(first.uuid, 'begin');
    const b = await h.send('look', [picture]);
    await h.message(result([first.uuid]));
    vi.advanceTimersByTime(61_000);
    await h.replay('different-picture', [imageBlock('YmJi'), { type: 'text', text: 'look' }]);
    expect(h.rt.queue.map((q) => q.id)).toEqual([b.item.id]);
    await h.replay('rewritten-b', [imageBlock(), { type: 'text', text: 'look' }]);
    expect(h.rt.queue).toEqual([]);
    expect(h.rt.get<UserItem>(b.item.id)).toMatchObject({ providerId: 'rewritten-b', steered: true });
    await h.message(result(['different-picture', 'rewritten-b']));
    expect(users(h.rt).filter((u) => u.remote).map((u) => u.providerId)).toEqual(['different-picture']);
    expect(h.rt.turnActive).toBe(false);
  });

  it('holds the second unread steer across an autonomous turn and a late take', async () => {
    vi.useFakeTimers();
    const h = await claude();
    h.rt.onTurnEnd = (rt, error, opts) => {
      if (!error && !opts?.hold && !rt.stopRequested) rt.takeQueued();
    };
    const first = await h.send('begin');
    await h.replay(first.uuid, 'begin');
    const b = await h.send('second');
    const c = await h.send('third');
    await h.message(result([first.uuid]));
    vi.advanceTimersByTime(61_000);
    await h.state('running');
    await h.state('idle');
    await h.replay(b.uuid, 'second');
    await h.message(result([b.uuid]));
    expect(h.rt.queue.map((q) => q.id)).toEqual([c.item.id]);
    expect(h.rt.turnActive).toBe(false);
    await h.send('please go on');
    expect(h.rt.stopRequested).toBe(false);
  });

  it('keeps a folded steer with its canonical reply stamp on one card', async () => {
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?');
    await h.replay('folded-b', b.content);
    await h.text('Three tests.', { user_message_uuid: b.uuid });
    await h.message(result([a.uuid, b.uuid]));
    expect(users(h.rt).map((u) => u.id)).toEqual([a.item.id, b.item.id]);
    expect(h.rt.turnActive).toBe(false);
  });

  it('restores a separate Continue exchange when the app UUID gets its own result', async () => {
    const h = await claude();
    const a = await h.send('Continue');
    await h.text('First answer.', { user_message_uuid: a.uuid });
    await h.message(result([a.uuid]));
    await h.replay('app-continue', 'Continue');
    expect(h.rt.get<UserItem>(a.item.id)?.providerId).toBe(a.uuid);
    await h.text('Second answer.');
    await h.message(result(['app-continue']));
    expect(users(h.rt).map((u) => [u.providerId, !!u.remote])).toEqual([[a.uuid, false], ['app-continue', true]]);
    expect(h.rt.items.map((i) => i.type)).toEqual(['user', 'text', 'turn', 'user', 'text', 'turn']);
    expect(h.rt.answeredBy(users(h.rt)[1].id)).toBe(turns(h.rt)[1].id);
    expect(h.rt.turnActive).toBe(false);
  });

  it('gives a separate result-only app 429 to the matching Continue card', async () => {
    const h = await claude();
    const a = await h.send('Continue');
    await h.text('First answer.', { user_message_uuid: a.uuid });
    await h.message(result([a.uuid]));
    await h.replay('app-continue', 'Continue');
    const hits = vi.fn();
    h.rt.onBackgroundLimit = hits;
    await h.message(result(['app-continue'], { is_error: true, errors: ["You've hit your 5-hour limit"] }));
    const remote = users(h.rt).find((u) => u.remote)!;
    expect(h.rt.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.limit)?.limit).toMatchObject({ origin: 'user', userItemId: remote.id });
    expect(hits).not.toHaveBeenCalled();
    expect(h.rt.turnActive).toBe(false);
  });

  it.each([true, false])('settles a legacy first-input receipt on a named-by-order result (answer %s)', async answer => {
    const h = await claude();
    h.p.seen.names = false;
    const taken = vi.fn(), uncertain = vi.fn();
    const item = h.rt.add<UserItem>({ type: 'user', text: 'continue', state: 'sent' });
    await h.session.send(item, { taken, uncertain });
    await h.message(result(undefined, answer ? { result: 'The checks passed.' } : {}));
    expect(taken).toHaveBeenCalledTimes(answer ? 1 : 0);
    expect(uncertain).toHaveBeenCalledTimes(answer ? 0 : 1);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a rewritten replay reopens a guessed legacy send on its own card', async () => {
    const h = await claude();
    h.p.seen.names = false;
    const a = await h.send('read the logs');
    await h.message(result());
    await h.replay('legacy-rewrite', 'read the logs');
    expect(h.rt.turnActive).toBe(true);
    expect(users(h.rt).map((u) => [u.id, !!u.remote])).toEqual([[a.item.id, false]]);
    await h.message(result(['legacy-rewrite']));
    expect(h.rt.turnActive).toBe(false);
  });

  it.each(['replay', 'rewritten replay', 'stamp', 'result'] as const)('keeps a loss through failed launch and acknowledges the retry on %s', async (ack) => {
    const h = await claude({ live: true });
    const step = h.rt.add<ToolItem>({ type: 'tool', kind: 'bash', name: 'Bash', title: 'Build', status: 'done', detail: {} });
    h.rt.taskStarted(step.id, { id: 'build', kind: 'command' });
    h.rt.tasksLost('process');
    const dispatch = async (s: typeof h) => {
      const batch = s.rt.pendingLost();
      const item = s.rt.add<UserItem>({ type: 'user', text: 'retry build', state: 'sent' });
      const payload = { ...item, text: item.text + lostTasksNote(batch.names) };
      await s.session.send(payload, { taken: batch.taken });
      await tick();
      return s.proc().pushed.at(-1) as { uuid: string; message: { content: string } };
    };
    await dispatch(h);
    h.proc().end(new Error('gated CLI failed to launch'));
    await until(() => !h.q(), 'failed launch');
    const restored = new SessionRuntime({ ...h.rt.meta }, () => {}, () => {});
    restored.loadRestored(structuredClone(h.rt.items));
    expect(restored.pendingLost().names.join()).toContain('Build');
    const retry = await claude({ live: true, runtime: restored });
    const send = await dispatch(retry);
    expect(send.message.content).toContain('Build');
    retry.p.seen.names = false;
    await retry.message(result());
    expect(restored.pendingLost().names.join()).toContain('Build');
    if (ack === 'replay') await retry.replay(send.uuid, send.message.content);
    if (ack === 'rewritten replay') await retry.replay('new-sdk-uuid', send.message.content);
    if (ack === 'stamp') await retry.text('Build ran.', { user_message_uuid: send.uuid });
    if (ack === 'result') await retry.message(result([send.uuid]));
    expect(restored.pendingLost().names).toEqual([]);
  });

  it('returns an at-rest send still unread at Stop to the queue', async () => {
    const h = await claude();
    h.p.seen.names = true;
    const a = await h.send('retry later', [picture]);
    h.rt.stopRequested = true;
    await h.session.interrupt();
    await h.message(result(undefined, { is_error: true, errors: ['Interrupted'] }));
    expect(h.rt.queue).toMatchObject([{ id: a.item.id, text: 'retry later', attachments: [picture] }]);
    expect(h.rt.get(a.item.id)).toBeUndefined();
    expect(h.rt.turnActive).toBe(false);
  });

  it.each(['withdrawn', 'legacy', 'provisional'] as const)('settles a silent %s delivery without an idle frame', async (delivery) => {
    vi.useFakeTimers();
    const h = await claude();
    h.p.seen.names = delivery !== 'legacy';
    const a = await h.send('check the logs');
    if (delivery === 'provisional') {
      await h.replay('same-words', 'check the logs');
      await h.text('First answer.', { user_message_uuid: a.uuid });
      await h.message(result([a.uuid]));
    } else {
      await h.message(result());
      if (delivery === 'withdrawn') vi.advanceTimersByTime(61_000);
      await h.replay(delivery === 'legacy' ? a.uuid : 'rewritten', 'check the logs');
    }
    expect(h.rt.turnActive).toBe(true);
    vi.advanceTimersByTime(181_000);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue).toEqual([]);
    expect(h.rt.get<UserItem>(a.item.id)?.state).toBe('sent');
  });

  it('an existing chat on another account sees learned result UUID support', async () => {
    const first = await claude();
    first.p.seen.names = false;
    const second = await claude();
    const a = await first.send('work');
    await first.message(result([a.uuid]));
    await second.send('other account');
    await second.message(result());
    expect(second.rt.turnActive).toBe(true);
    expect(turns(second.rt)).toEqual([]);
  });
  it('keeps its turn only while the process works or speaks; then the turn ends, and a late replay is still Sable\'s', async () => {
    vi.useFakeTimers();
    const h = await claude();
    const a = await h.send('first');
    await h.replay(a.uuid, 'first');
    await h.message(result([a.uuid]));
    const b = await h.send('second');
    // A zeroed result that names nothing (a delivery that failed), then the CLI says it is idle.
    await h.message(result());
    await h.state('idle');
    expect(h.rt.turnActive).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(h.rt.turnActive).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map((q) => q.id)).toEqual([b.item.id]);
    expect(h.rt.get(b.item.id)).toBeUndefined();
    // Claude Code takes it after all.
    await h.replay(b.uuid, 'second');
    expect(users(h.rt).map((u) => [u.text, !!u.remote])).toEqual([
      ['first', false],
      ['second', false],
    ]);
    expect(h.rt.turnActive).toBe(true);
    await h.text('Second done.');
    await h.message(result([b.uuid]));
    expect(h.rt.turnActive).toBe(false);
  });

  it('is waited for while the CLI says it works', async () => {
    vi.useFakeTimers();
    const h = await claude();
    const a = await h.send('first');
    await h.replay(a.uuid, 'first');
    await h.message(result([a.uuid]));
    await h.send('second');
    await h.message(result());
    await h.state('running');
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.rt.turnActive).toBe(true);
  });
});

// ───────────────────────────── the Claude app's messages, and folds ─────────────────────────────

describe("a message from the Claude app stays the app's", () => {
  it('one that holds the words of a steer still on its way is the app\'s, and the steer is taken by its own replay', async () => {
    const h = await claude();
    const a = await h.send('refactor the module');
    await h.replay(a.uuid, 'refactor the module');
    const s = await h.send('please run the full test suite');
    await h.replay('app1', 'also: please run the full test suite now');
    expect(users(h.rt).find((u) => u.providerId === 'app1')).toMatchObject({ text: 'also: please run the full test suite now', remote: true });
    expect(h.rt.get<UserItem>(s.item.id)?.state).toBe('queued');
    await h.replay(s.uuid, 'please run the full test suite');
    expect(h.rt.get<UserItem>(s.item.id)).toMatchObject({ state: 'sent', providerId: s.uuid });
    expect(users(h.rt).filter((u) => u.remote)).toHaveLength(1);
  });

  it('one with the very words of a steer still on its way is taken for it, and is the app\'s again once the steer comes back under its own uuid', async () => {
    const h = await claude();
    const a = await h.send('refactor the module');
    await h.replay(a.uuid, 'refactor the module');
    const s = await h.send('run the tests again');
    await h.replay('app2', 'run the tests again');
    // Read as the steer folded in under another uuid.
    expect(users(h.rt).filter((u) => u.remote)).toHaveLength(0);
    expect(h.rt.get<UserItem>(s.item.id)).toMatchObject({ state: 'sent', providerId: 'app2' });
    // The steer comes back under its own uuid: the other one was the app's.
    await h.replay(s.uuid, 'run the tests again');
    expect(h.rt.get<UserItem>(s.item.id)?.providerId).toBe(s.uuid);
    expect(users(h.rt).filter((u) => u.remote)).toMatchObject([{ text: 'run the tests again', providerId: 'app2' }]);
    expect(users(h.rt)).toHaveLength(3);
  });

  it('one with the words of a message of Sable\'s already taken is the app\'s', async () => {
    const h = await claude();
    const a = await h.send('Continue');
    await h.replay(a.uuid, 'Continue');
    await h.message(result([a.uuid]));
    await h.replay('app3', 'Continue');
    expect(users(h.rt).map((u) => [u.text, !!u.remote])).toEqual([
      ['Continue', false],
      ['Continue', true],
    ]);
  });

  it('keeps distinct pictures with identical captions', async () => {
    const h = await claude();
    const mine = await h.send('Look at this', [picture]);
    const caption = { type: 'text', text: 'Look at this' };
    await h.replay('other-picture', [imageBlock('YmJi'), caption]);
    expect(users(h.rt).find((u) => u.remote)).toMatchObject({ providerId: 'other-picture', attachments: [{ dataUrl: 'data:image/png;base64,YmJi' }] });
    expect(h.rt.get<UserItem>(mine.item.id)?.providerId).toBeUndefined();
  });

  it('a canonical reply stamp restores an identical app message with its picture', async () => {
    const h = await claude();
    const mine = await h.send('Look at this', [picture]);
    await h.replay('same-picture', [imageBlock(), { type: 'text', text: 'Look at this' }]);
    expect(users(h.rt)).toHaveLength(1);
    await h.text('A dog.', { user_message_uuid: mine.uuid });
    expect(users(h.rt).filter((u) => u.remote).map((u) => u.providerId)).toEqual(['same-picture']);
    expect(h.rt.get<UserItem>(mine.item.id)?.providerId).toBe(mine.uuid);
    await h.message(result([mine.uuid]));
    expect(h.rt.turnActive).toBe(true);
    await h.message(result(['same-picture']));
    expect(h.rt.turnActive).toBe(false);
  });

  it('a canonical stamp after the provisional app result keeps both answers with their cards', async () => {
    const h = await claude();
    const mine = await h.send('Look at this', [picture]);
    await h.replay('app-first', [imageBlock(), { type: 'text', text: 'Look at this' }]);
    await h.text('Reply to the app.');
    await h.message(result(['app-first']));
    const appResult = turns(h.rt)[0];
    await h.text('Reply to Sable.', { user_message_uuid: mine.uuid });
    await h.message(result([mine.uuid]));
    const app = users(h.rt).find((u) => u.remote)!;
    expect(h.rt.answeredBy(app.id)).toBe(appResult.id);
    expect(h.rt.answeredBy(mine.item.id)).toBe(turns(h.rt)[1].id);
    expect(h.rt.items.map((i) => i.type)).toEqual(['user', 'text', 'turn', 'user', 'text', 'turn']);
    expect(users(h.rt).map((u) => u.providerId)).toEqual(['app-first', mine.uuid]);
  });

  it('keeps its pictures within bounds, also a message of a picture alone', async () => {
    const h = await claude();
    await h.replay('app4', [imageBlock()]);
    const only = users(h.rt).find((u) => u.providerId === 'app4');
    expect(only).toMatchObject({ text: '', remote: true, attachments: [{ kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG}` }] });
    await h.message(result(['app4']));
    const big = 'A'.repeat(5 * 1024 * 1024);
    await h.replay('app5', [{ type: 'text', text: 'two of them' }, imageBlock(big), imageBlock(PNG, 'image/jpeg'), imageBlock(PNG, 'image/svg+xml'), { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]);
    expect(users(h.rt).find((u) => u.providerId === 'app5')?.attachments).toMatchObject([{ kind: 'image', mime: 'image/jpeg' }]);
  });

  it("one Claude Code marks as its own with no wrapper Sable knows is Claude Code's line, never the app's", async () => {
    const h = await claude();
    await h.replay('meta-1', 'Base directory for this skill: /x\n\nDo the thing.', { isSynthetic: true });
    expect(users(h.rt)).toHaveLength(0);
    expect(h.rt.items.find((i): i is NoticeItem => i.type === 'notice')).toMatchObject({ variant: 'info', text: 'Base directory for this skill: /x', detail: 'Do the thing.' });
  });
});

describe("a steer folded in stays Sable's", () => {
  it('replayed under another uuid with the note Sable adds after a steer, and with a handover before it', async () => {
    const h = await claude();
    const a = await h.send('refactor the module');
    await h.replay(a.uuid, 'refactor the module');
    const s = await h.send('ok');
    expect(JSON.stringify(s.content)).toContain(JSON.stringify(STEER_FIRST_BLOCK));
    await h.replay('fold-1', [{ type: 'text', text: 'ok' }, { type: 'text', text: STEER_FIRST_BLOCK }]);
    expect(h.rt.get<UserItem>(s.item.id)).toMatchObject({ state: 'sent', providerId: 'fold-1' });
    // What went had a handover before the person's words (the card shows their words alone).
    const card = h.rt.add<UserItem>({ type: 'user', text: 'go on', state: 'queued', steered: true });
    const sent = `${HANDOVER_HEAD_ACCOUNT}\nUser: hi\nAgent: hello\n${HANDOVER_TAIL}${HANDOVER_JOIN}go on`;
    await h.session.send({ ...card, text: sent });
    await h.replay('fold-2', [{ type: 'text', text: sent }, { type: 'text', text: STEER_FIRST_BLOCK }]);
    expect(h.rt.get<UserItem>(card.id)).toMatchObject({ state: 'sent', providerId: 'fold-2' });
    expect(users(h.rt).some((u) => u.remote)).toBe(false);
    expect(users(h.rt)).toHaveLength(3);
  });

  it.each(['no replay', 'replay after result', 'folded replay', 'stream before replay', 'complete before replay', 'result text only', 'stamp on complete frame'] as const)('keeps the root reply below the taken steer (%s)', async (delivery) => {
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const s = await h.send('what passed?');
    const answer = 'All three tests passed.';
    const stream = (event: Obj) => h.message({ type: 'stream_event', parent_tool_use_id: null, event });
    const full = (uuid: string, text: string, extra: Obj = {}) => h.message({ type: 'assistant', uuid, message: { id: 'msg', content: [{ type: 'text', text }] }, ...extra });
    if (delivery === 'folded replay') await h.replay('fold', [{ type: 'text', text: 'what passed?' }, { type: 'text', text: STEER_FIRST_BLOCK }]);
    await stream({ type: 'message_start', message: { id: 'msg' } });
    if (delivery !== 'folded replay' && delivery !== 'result text only') {
      await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } });
      if (delivery === 'stream before replay') await h.replay(s.uuid, 'what passed?');
      await stream({ type: 'content_block_stop', index: 0 });
    }
    // A CLI can stream just the start, and send a full block. A duplicate of that full frame adds no text.
    const stamp = delivery === 'stamp on complete frame' ? { user_message_uuids: [a.uuid, s.uuid] } : {};
    if (delivery !== 'result text only') {
      await full('full', answer, stamp);
      await full('full', answer, stamp);
    }
    if (delivery === 'complete before replay') await h.replay(s.uuid, 'what passed?');
    await h.message(result([a.uuid, delivery === 'folded replay' ? 'fold' : s.uuid], delivery === 'complete before replay' ? {} : { result: answer }));
    if (delivery === 'replay after result') await h.replay(s.uuid, 'what passed?');
    const replies = h.rt.items.filter((i) => i.type === 'text' && !i.parentId && i.text === answer);
    expect(replies).toHaveLength(1);
    expect(at(h.rt, replies[0].id)).toBeGreaterThan(at(h.rt, s.item.id));
    expect(h.rt.get<UserItem>(s.item.id)?.state).toBe('sent');
    expect(h.rt.turnActive).toBe(false);
  });

  it('shows a result-only final answer after the interim reply and tool', async () => {
    const h = await claude();
    const a = await h.send('run CI');
    await h.replay(a.uuid, 'run CI');
    const b = await h.send('what passed?');
    await h.replay(b.uuid, 'what passed?');
    await h.text("I'll check.");
    await h.message({ type: 'assistant', uuid: 'call', message: { id: 'tool', content: [{ type: 'tool_use', id: 'tests', name: 'Bash', input: { command: 'test' } }] } });
    await h.message({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tests', content: 'ok' }] } });
    await h.message(result([a.uuid, b.uuid], { result: 'All three tests passed.' }));
    const shown = h.rt.items.slice(at(h.rt, b.item.id) + 1).filter((i): i is TextItem => i.type === 'text' && !i.parentId);
    expect(shown.map((i) => i.text)).toEqual(["I'll check.", 'All three tests passed.']);
  });

  it('never replayed, it is taken at the first reply stamped with it, above that reply', async () => {
    const h = await claude();
    const a = await h.send('refactor the module');
    await h.replay(a.uuid, 'refactor the module');
    const s = await h.send('and the docs');
    await h.text('Docs too.', { user_message_uuid: s.uuid, user_message_uuids: [a.uuid, s.uuid] });
    expect(h.rt.get<UserItem>(s.item.id)).toMatchObject({ state: 'sent', providerId: s.uuid });
    const reply = h.rt.items.findLast((i): i is TextItem => i.type === 'text')!;
    expect(at(h.rt, s.item.id)).toBeLessThan(at(h.rt, reply.id));
    await h.message(result([a.uuid, s.uuid]));
    expect(h.rt.turnActive).toBe(false);
  });
});

// ───────────────────────────── D-cost: what a turn cost ─────────────────────────────

describe("what a turn cost (D-cost)", () => {
  const resumed = (cliCost?: { session: string; total: number }) => ({ providerSessionId: 'cc1', usage: { inputTokens: 0, outputTokens: 0, turns: 0, costUsd: 10, ...(cliCost ? { cliCost } : {}) } });

  it("a resumed process's first result books only what it added to the total this chat saw", async () => {
    const h = await claude({ live: true, meta: resumed({ session: 'cc1', total: 200 }) });
    const a = await h.send('go');
    await h.replay(a.uuid, 'go');
    await h.message(result([a.uuid], { total_cost_usd: 200.5, usage: { input_tokens: 10, output_tokens: 2 } }));
    expect(turns(h.rt)[0].costUsd).toBeCloseTo(0.5);
    expect(h.rt.meta.usage.costUsd).toBeCloseTo(10.5);
  });

  it('with no total known for the conversation (a chat from before), the first result books nothing, the next what it added', async () => {
    const h = await claude({ live: true, meta: resumed() });
    const a = await h.send('go');
    await h.replay(a.uuid, 'go');
    await h.message(result([a.uuid], { total_cost_usd: 204.3 }));
    expect(turns(h.rt)[0].costUsd).toBeUndefined();
    expect(h.rt.meta.usage.costUsd).toBe(10);
    expect(h.rt.meta.usage.cliCost).toEqual({ session: 'cc1', total: 204.3 });
    const b = await h.send('more');
    await h.replay(b.uuid, 'more');
    await h.message(result([b.uuid], { total_cost_usd: 208.24 }));
    expect(turns(h.rt)[1].costUsd).toBeCloseTo(3.94);
  });

  it('a zeroed total says nothing; a resume from an earlier point books nothing for its first; a /clear counts from zero', async () => {
    const h = await claude({ live: true, meta: resumed({ session: 'cc1', total: 50 }) });
    const round = async (words: string, total: number) => {
      const m = await h.send(words);
      await h.replay(m.uuid, words);
      await h.message(result([m.uuid], { total_cost_usd: total }));
      return turns(h.rt).at(-1)!.costUsd;
    };
    // Resumed at an earlier point (a rewind): its saved total is below the one seen last.
    expect(await round('one', 30)).toBeUndefined();
    expect(await round('two', 31)).toBeCloseTo(1);
    expect(await round('three', 0)).toBeUndefined();
    expect(await round('four', 32)).toBeCloseTo(1);
    // Cleared in this process: its total starts again.
    expect(await round('five', 0.4)).toBeCloseTo(0.4);
    expect(h.rt.meta.usage.costUsd).toBeCloseTo(12.4);
  });

  it('conversation_reset starts the new baseline at zero even if its first total exceeds the old one', async () => {
    const h = await claude();
    const a = await h.send('old');
    await h.message(result([a.uuid], { total_cost_usd: 0.1 }));
    await h.message({ type: 'conversation_reset', session_id: 'cc1', new_conversation_id: 'cc2', trigger: 'clear' });
    expect(h.rt.meta.usage.cliCost).toEqual({ session: 'cc2', total: 0 });
    const b = await h.send('new');
    await h.message(result([b.uuid], { session_id: 'cc2', total_cost_usd: 0.3 }));
    expect(turns(h.rt).at(-1)?.costUsd).toBeCloseTo(0.3);
    expect(h.rt.meta.usage.costUsd).toBeCloseTo(0.4);
  });

  it('a new conversation counts from zero', async () => {
    const h = await claude({ live: true });
    const a = await h.send('go');
    await h.replay(a.uuid, 'go');
    await h.message(result([a.uuid], { total_cost_usd: 0.25 }));
    expect(turns(h.rt)[0].costUsd).toBeCloseTo(0.25);
  });
});

// ───────────────────────────── D4: a decided limit card ─────────────────────────────

describe('a limit card the bridge decided (D4)', () => {
  const refused = { type: 'assistant', uuid: 'lim-1', parent_tool_use_id: null, error: 'rate_limit', message: { id: 'm-lim', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } };
  const cards = (rt: SessionRuntime) => rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit);
  const person = (h: Awaited<ReturnType<typeof claude>>) => h.replay('from-app', 'please continue');

  it.each([true, false])('a task wake with a prior limit card hands off once (decided %s)', async (decided) => {
    const h = await claude();
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Usage limit', limit: { window: '5-hour limit', ...(decided ? { provider: 'claude' as const, accountId: 'default' } : {}) } });
    h.rt.limitCard = card.id;
    const hit = vi.fn();
    h.rt.onBackgroundLimit = hit;
    await h.replay('note', '<task-notification><task-id>t1</task-id><status>completed</status></task-notification>', { isSynthetic: true });
    expect(h.rt.turnActive).toBe(true);
    await h.message(refused);
    await h.message(result(undefined, { is_error: true, errors: ['HTTP 429'] }));
    expect(hit).toHaveBeenCalledTimes(1);
    expect(cards(h.rt).map((n) => n.id)).toEqual([card.id]);
    expect(h.rt.turnActive).toBe(false);
  });

  it('is not reused when the person writes from the Claude app and is refused', async () => {
    const h = await claude();
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit', provider: 'claude', accountId: 'default' } });
    h.rt.limitCard = card.id;
    await person(h);
    expect(h.rt.turnActive).toBe(true);
    await h.message(refused);
    expect(cards(h.rt)).toHaveLength(2);
    expect(cards(h.rt)[1].limit?.provider).toBeUndefined();
  });

  it('one not decided yet is that turn\'s too', async () => {
    const h = await claude();
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit', origin: 'background' } });
    h.rt.limitCard = card.id;
    await person(h);
    await h.message(refused);
    expect(cards(h.rt)).toHaveLength(1);
    expect(cards(h.rt)[0]).toMatchObject({ id: card.id, limit: { origin: 'user', userItemId: users(h.rt)[0].id } });
    expect(at(h.rt, card.id)).toBeGreaterThan(at(h.rt, users(h.rt)[0].id));
  });
});

// ───────────────────────────── C5: a steer read after it was sent again ─────────────────────────────

async function claudeApp() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-msg-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const pushed: { uuid: string; message: { content: unknown } }[] = [];
  const sessions: Session[] = [];
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    providers: [
      (ctx) => {
        const p = new ClaudeProvider(ctx);
        const any = p as unknown as Obj;
        any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
        any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
        any.limits = async () => [];
        any.readLimits = async () => [];
        p.quickTitle = async () => 'A title';
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Session;
          s.ensure = function (this: Obj) {
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
  const message = (m: Obj) => (sessions[0].onMessage as (m: unknown) => void).call(sessions[0], { session_id: 'cc1', ...m });
  const send = async (text: string, steer = false) => {
    const n = pushed.length;
    await app.call('session.send', { sessionId: id, text, ...(steer ? { steer: true } : {}) });
    await until(() => pushed.length > n, `"${text}" sent`);
    return pushed.at(-1)!.uuid;
  };
  const replay = (uuid: string, content: string) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content } });
  const result = (uuids: string[], interrupted = false) =>
    message({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted, duration_ms: 10, usage: {}, total_cost_usd: 0, user_message_uuids: uuids, user_message_uuid: uuids.at(-1) });
  return { app, id, rt, pushed, send, replay, result, message, stop: () => app.call('session.interrupt', { sessionId: id }) };
}

it('keeps the personal retry and the Fable window together at the app handoff', async () => {
  const h = await claudeApp();
  const a = await h.send('first');
  h.replay(a, 'first');
  h.result([a]);
  h.message({ type: 'user', uuid: 'wake', isReplay: true, isSynthetic: true, message: { content: '<task-notification><task-id>w</task-id><status>completed</status></task-notification>' } });
  const fable = "You've hit your Fable limit · resets Nov 25, 3pm (Europe/Berlin). Switch to another model to continue.";
  h.message({ type: 'assistant', uuid: 'refusal', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: fable }] } });
  const b = await h.send('answer this', true);
  const queued = h.rt.enqueue('after the decision');
  h.message(result(undefined, { is_error: true, errors: [fable] }));
  h.message(result([b], { is_error: true, errors: ["You've hit your 5-hour limit"] }));
  const person = users(h.rt).find((u) => u.providerId === b)!;
  const cards = h.rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit);
  expect(cards.map((n) => n.limit)).toEqual([expect.objectContaining({ origin: 'user', userItemId: person.id, window: '5-hour limit', wakeWindow: 'Weekly · Fable' })]);
  await tick(25);
  expect(h.rt.queue.map((q) => q.id)).toEqual([queued.id]);
  expect(h.pushed).toHaveLength(2);
});

it('decides both independently refused sends on their original app cards', async () => {
  const h = await claudeApp();
  const a = await h.send('first');
  const b = await h.send('second', true);
  const hits = () => h.rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit);
  h.message(result([a], { is_error: true, errors: ["You've hit your Fable limit"] }));
  h.message(result([b], { is_error: true, errors: ["You've hit your 5-hour limit"] }));
  await until(() => hits().length === 2 && hits().every(n => n.limit?.provider === 'claude'), 'both app limit decisions');
  expect(hits().map(n => [h.rt.get<UserItem>(n.limit!.userItemId!)?.providerId, n.limit?.window])).toEqual([
    [a, 'Weekly · Fable'], [b, '5-hour limit'],
  ]);
});

it('enriches a late stopped personal refusal without dispatching the queue', async () => {
  const h = await claudeApp();
  const a = await h.send('first');
  h.replay(a, 'first');
  const next = h.rt.enqueue('wait here');
  vi.useFakeTimers();
  await h.stop();
  await vi.advanceTimersByTimeAsync(2501);
  expect(h.rt.turnActive).toBe(false);
  h.message(result([a], { is_error: true, errors: ["You've hit your Fable limit"] }));
  vi.useRealTimers();
  const card = h.rt.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.limit)!;
  await until(() => card?.limit?.provider === 'claude', 'manual limit decision');
  expect(h.rt.get<UserItem>(card.limit!.userItemId!)?.providerId).toBe(a);
  expect(h.rt.queue.map(q => q.id)).toEqual([next.id]);
  expect(h.pushed).toHaveLength(1);
});

it('dispatches one lost-task note through the app while the first send awaits its receipt', async () => {
  const h = await claudeApp();
  const step = h.rt.add<ToolItem>({ type: 'tool', kind: 'bash', name: 'Bash', title: 'Build', status: 'done', detail: {} });
  h.rt.taskStarted(step.id, { id: 'build', kind: 'command' });
  h.rt.tasksLost('process');
  const a = await h.send('first');
  const b = await h.send('second', true);
  expect(h.pushed.filter(m => JSON.stringify(m.message.content).includes('task build')).map(m => m.uuid)).toEqual([a]);
  h.result([b]);
  expect(h.rt.pendingLost().names).toHaveLength(1);
  h.replay(a, 'first');
  expect(h.rt.pendingLost().names).toEqual([]);
  h.result([a]);
});

it('acknowledges the app handover only when Claude replays its send', async () => {
  const h = await claudeApp();
  const step = h.rt.add<ToolItem>({ type: 'tool', kind: 'bash', name: 'Bash', title: 'Build', status: 'done', detail: {} });
  h.rt.taskStarted(step.id, { id: 'build', kind: 'command' });
  h.rt.tasksLost('process');
  const uuid = await h.send('check again');
  expect(h.pushed.at(-1)!.message.content).toContain('Build');
  expect(h.rt.pendingLost().names).toHaveLength(1);
  h.replay(uuid, 'check again');
  expect(h.rt.pendingLost().names).toEqual([]);
  h.result([uuid]);
});

describe('a steer withdrawn at a stop and sent again (C5)', () => {
  it('read by Claude Code after all once it went again from the queue: one card', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    const b = await h.send('and keep the old exports', true);
    await h.stop();
    h.result([a], true);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports']);
    // The person sends it again from the queue.
    const n = h.pushed.length;
    await h.app.call('queue.sendNow', { sessionId: h.id, id: h.rt.queue[0].id });
    await until(() => h.pushed.length > n, 'sent again');
    // Claude Code had the first one after all.
    h.replay(b, 'and keep the old exports');
    expect(users(h.rt).map((u) => u.text)).toEqual(['Refactor the session module', 'and keep the old exports']);
    expect(users(h.rt).some((u) => u.remote)).toBe(false);
  });
});

describe('a chat read again (D-own)', () => {
  it("a card from the app that the agent's own id proves is Sable's message is merged into its card; the same words without that proof stay", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-msg-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const make = () => new App({ home, quiet: true, userHome: path.join(home, 'user'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    const first = make();
    const snap = await first.call('session.create', { provider: 'demo', cwd: home, mode: 'default' });
    const rt = first.runtime(snap.session.id);
    const own = rt.add<UserItem>({ type: 'user', text: 'look at this', state: 'sent', providerId: 'p1' });
    const twin = rt.add<UserItem>({ type: 'user', text: 'look at this', state: 'sent', providerId: 'p1', remote: true });
    const fromApp = rt.add<UserItem>({ type: 'user', text: 'look at this', state: 'sent', providerId: 'p2', remote: true });
    await first.dispose();
    const second = make();
    cleanups.push(() => second.dispose());
    await second.call('session.snapshot', { sessionId: snap.session.id });
    const ids = second.runtime(snap.session.id).items.map((i) => i.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(twin.id);
    expect(ids).toContain(fromApp.id);
  });
});

// ───────────────────────────── the pure readers ─────────────────────────────

describe('the readers', () => {
  it('sends file references before the lost-task note', async () => {
    const h = await claude();
    const file = { id: 'f', name: 'log.txt', path: 'C:/fixture/log.txt', kind: 'file' as const };
    const item = h.rt.add<UserItem>({ type: 'user', text: 'inspect', state: 'sent', attachments: [file] });
    const note = lostTasksNote(['build']);
    await h.session.send({ ...item, text: item.text + note });
    const body = h.pushed.at(-1)!.message.content as string;
    expect(body).toBe('inspect\n\n@C:/fixture/log.txt' + note);
    expect(stripWrappers(body)).toBe('inspect\n\n@C:/fixture/log.txt');
  });
  it('a chat read again drops a card from the app only where an own card has its provider id', () => {
    const items = [
      { id: 'u1', ts: 1, type: 'user', text: 'look at this', state: 'sent', providerId: 'p1' },
      { id: 't1', ts: 2, type: 'turn', durationMs: 1 },
      { id: 'u2', ts: 3, type: 'user', text: 'look at this', state: 'sent', providerId: 'p1', remote: true },
      // Same words, no proof: the app's.
      { id: 'u3', ts: 4, type: 'user', text: 'Continue', state: 'sent', providerId: 'p3' },
      { id: 'u4', ts: 5, type: 'user', text: 'Continue', state: 'sent', providerId: 'p4', remote: true },
      // An own card with no provider id proves nothing.
      { id: 'u5', ts: 6, type: 'user', text: 'again', state: 'sent' },
      { id: 'u6', ts: 7, type: 'user', text: 'again', state: 'sent', providerId: 'p6', remote: true },
    ] as TimelineItem[];
    expect(ownReplays(items)).toEqual(['u2']);
  });

  it('words compare without wrappers, the steer note and what Sable adds', () => {
    expect(plainWords(`ok\n${STEER_FIRST_BLOCK}`)).toBe('ok');
    expect(plainWords(`${HANDOVER_HEAD_ACCOUNT}\nUser: a\n${HANDOVER_TAIL}${HANDOVER_JOIN}go  on\n`)).toBe('go on');
  });

  it('pictures of an app message: plain base64 pictures only, within count, size and total', () => {
    const one = 'A'.repeat(100);
    const limits = { count: 2, each: 200, total: 300 };
    expect(appPictures('text', limits)).toBeUndefined();
    expect(appPictures([imageBlock(one), imageBlock(one), imageBlock(one)], limits)).toHaveLength(2);
    expect(appPictures([imageBlock('A'.repeat(190))], limits)).toBeUndefined();
    expect(appPictures([imageBlock('not base64!')], limits)).toBeUndefined();
    expect(appPictures([imageBlock(one), imageBlock('B'.repeat(150))], { count: 4, each: 200, total: 250 })).toHaveLength(1);
  });
});

it('refuses an unresolved interior rewind before touching the conversation or files', async () => {
  const h = await claude({ meta: { providerSessionId: 'native' } });
  h.rt.add<UserItem>({ type: 'user', text: 'first', providerId: 'old-1' });
  const second = h.rt.add<UserItem>({ type: 'user', text: 'second', providerId: 'old-2' });
  const before = structuredClone(h.rt.items);
  const result = await h.session.rewind!(second.id, true);
  expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/summary/) });
  expect(h.q()).toBeFalsy();
  expect(h.rt.items).toEqual(before);
  expect(h.rt.meta.providerSessionId).toBe('native');
});

it('uses the copied Claude history for inherited interior forks and rewinds', async () => {
  const h = await claude({ meta: { providerSessionId: 'native-copy' } });
  const first = h.rt.add<UserItem>({ type: 'user', text: 'first', providerId: 'native-1' });
  const reply = h.rt.add<TextItem>({ type: 'text', text: 'answer', streaming: false });
  h.rt.add<TurnItem>({ type: 'turn', durationMs: 1 });
  const second = h.rt.add<UserItem>({ type: 'user', text: 'second', providerId: 'native-2' });
  const home = mkdtempSync(path.join(tmpdir(), 'sable-copied-chain-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.spyOn(h.p, 'configHome').mockReturnValue(home);
  const dir = path.join(home, 'projects', claudeFolderKey(h.rt.meta.cwd));
  mkdirSync(dir, { recursive: true });
  const entries = ['native-1', 'reply-1', 'native-2'].map((original, i) => ({
    type: i === 1 ? 'assistant' : 'user', uuid: 'copy-' + i, parentUuid: i ? 'copy-' + (i - 1) : null,
    sessionId: 'native-copy', forkedFrom: { sessionId: 'native-source', messageUuid: original },
  }));
  writeFileSync(path.join(dir, 'native-copy.jsonl'), entries.map(i => JSON.stringify(i)).join('\n') + '\n');
  sdk.fork.mockResolvedValueOnce({ sessionId: 'next-copy' });
  const copied = await h.p.open(h.rt, { chainFrom: 'native-source' });
  cleanups.push(() => copied.close());
  expect(await copied.fork!(reply.id)).toBe('next-copy');
  expect(sdk.fork).toHaveBeenCalledWith('native-copy', { dir: h.rt.meta.cwd, upToMessageId: 'copy-1' });
  expect(await copied.rewind!(second.id, false)).toMatchObject({ ok: true });
  expect(h.rt.get(first.id)).toBe(first);
  expect(h.rt.get(second.id)).toBeUndefined();
  expect(h.rt.meta.providerSessionId).toBe('native-copy');
});
