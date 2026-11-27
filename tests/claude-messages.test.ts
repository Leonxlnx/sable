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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, REPLY_FIRST_PROMPT, STEER_FIRST_BLOCK, type NoticeItem, type SessionMeta, type TextItem, type TimelineItem, type ToolItem, type TurnItem, type UserItem } from '@shared/protocol';
import { HANDOVER_HEAD_ACCOUNT, HANDOVER_JOIN, STEER_NOW_BLOCK, delegateReport, nativePersonalPrompt, parseSynthetic, HANDOVER_TAIL, lostTasksNote, stripWrappers } from '@shared/synthetic';
import { App } from '../server/app';
import { claudeFolderKey } from '../server/core/lanes';
import { resultDigest } from '../server/core/delegate-result';
import { Store } from '../server/core/store';
import { SessionRuntime } from '../server/core/runtime';
import { READ, SessionFiles } from '../server/core/session-file';
import { phoneItem, phoneQuestion } from '../server/services/phone';
import { isLight, resultForWindow } from '../server/core/trim';
import { ClaudeProvider, titleOptions } from '../server/providers/claude';
import { CodexProvider, titleThreadParams } from '../server/providers/codex';
import { titlePrompt } from '../server/core/titles';
import { commitPrompt } from '../server/core/commit-draft';
import { DemoProvider } from '../server/providers/demo';
import { appPictures, ownReplays, plainWords } from '../server/providers/claude-tools';
import type { Provider, ProviderSession } from '../server/providers/types';

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

vi.mock('../server/providers/claude-history', () => ({
  claudeHistory: async (method: string, args: unknown[], _env: unknown, signal: AbortSignal) => {
    const read = method === 'forkSession' ? sdk.fork : sdk.history;
    let abort!: () => void;
    try {
      return await Promise.race([read(...args), new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  },
}));

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

async function claudeApp(saved?: { home: string; id: string }) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-msg-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  if (saved) {
    cpSync(path.join(saved.home, 'sessions'), path.join(home, 'sessions'), { recursive: true });
    cpSync(path.join(saved.home, 'state.json'), path.join(home, 'state.json'));
  }
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
  const id = saved?.id ?? (await app.call('session.create', { provider: 'claude', cwd, mode: 'default' })).session.id;
  const rt = saved ? app.sessions.get(id)! : app.runtime(id);
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
  return { app, home, id, rt, pushed, send, replay, result, message, stop: () => app.call('session.interrupt', { sessionId: id }) };
}

describe('reply first', () => {
  it('appends the instruction to the chat process after the Customize brief and respects opt-out and helper scopes', async () => {
    const h = await claude({ live: true });
    await h.send('begin');
    expect(REPLY_FIRST_PROMPT).toContain('use `background: true` for work that takes more than a minute or two');
    expect(h.proc().options).toMatchObject({ systemPrompt: { append: expect.stringContaining(REPLY_FIRST_PROMPT) } });
    const brief = 'Customize this desktop.';
    let enabled: boolean | undefined;
    const ctx = { emit() {}, log() {}, customBrief: () => brief, settings: () => ({ ...DEFAULT_SETTINGS, replyFirst: enabled }) };
    const cc = new ClaudeProvider(ctx);
    const codex = new CodexProvider(ctx);
    (codex as unknown as Obj).client = async () => ({ request: async () => ({ config: { developer_instructions: 'Use German.' } }) });
    const options = async (meta: { id: string; options?: { readOnly?: boolean }; custom?: boolean }) => [
      (cc.agentOptions({ cwd: process.cwd(), model: '', mode: 'default', ...meta }, {}).systemPrompt as { append: string }).append,
      await codex.developerInstructions(process.cwd(), meta),
    ];
    for (const value of await options({ id: 'chat', custom: true })) expect(value).toContain(brief + '\n\n' + REPLY_FIRST_PROMPT);
    for (const meta of [{ id: 'sub-delegated' }, { id: 'check', options: { readOnly: true } }]) {
      for (const value of await options(meta)) expect(value).not.toContain(REPLY_FIRST_PROMPT);
    }
    for (const prompt of [titlePrompt({ message: 'hello', answer: 'hi' }, process.cwd()), commitPrompt({ files: [], subjects: [], patch: '' }, process.cwd())]) {
      expect(titleOptions(prompt, {}, new AbortController()).systemPrompt).toBe(prompt.system);
      expect(titleThreadParams(prompt, 'm').baseInstructions).toBe(prompt.system);
      expect(prompt.system).not.toContain(REPLY_FIRST_PROMPT);
    }
    enabled = false;
    for (const value of await options({ id: 'chat' })) expect(value).not.toContain(REPLY_FIRST_PROMPT);
  });
});

async function waitingSteer(delay?: number) {
  const h = await claudeApp();
  if (delay !== undefined) await h.app.call('app.setSettings', { patch: { steerAfterMs: delay } });
  const first = await h.send('do the work');
  h.replay(first, 'do the work');
  h.message({ type: 'assistant', uuid: 'tool-call', message: { id: 'working', content: [{ type: 'tool_use', id: 'foreground', name: 'Agent', input: { description: 'Read the code' } }] } });
  const tool = h.rt.get<ToolItem>('foreground')!;
  expect(tool).toMatchObject({ type: 'tool', kind: 'agent', status: 'running' });
  h.message({ type: 'system', subtype: 'init', claude_code_version: '2.1.325' });
  const uuid = await h.send('answer me', true);
  const card = users(h.rt).at(-1)!;
  const interrupt = vi.fn(async (_scope?: unknown) => ({ response: { turn: 'stopped', still_queued: [] as string[] } }));
  const request = vi.fn(async (_request: Obj) => ({ response: { cancelled: true } }));
  Object.assign((h.rt.handle as unknown as Session).q as Obj, { request: (r: Obj) => r.subtype === 'interrupt' ? interrupt(r.for_user_message_uuids) : request(r), interrupt });
  const now = (itemId = card.id, allowed?: () => boolean) => h.app.call('session.steerNow', { sessionId: h.id, itemId }, { allowed });
  return { ...h, first, tool, uuid, card, now, interrupt, request };
}

describe('unread steer deadlines', () => {
  it('sends at the first deadline, through the manual interrupt path, including a second waiting steer', async () => {
    const h = await waitingSteer(30_000);
    expect(h.card.steerWait).toEqual({ stepId: h.tool.id, autoAt: h.card.ts + 30_000 });
    expect(phoneItem(h.card)).toMatchObject({ steerWait: h.card.steerWait });
    // Arm timers under the fake clock. The first card was deliberately taken under the real one.
    h.replay(h.uuid, h.card.text);
    expect(h.card.steerWait).toBeNull();
    vi.useFakeTimers();
    const uuid = await h.send('first unread', true);
    const first = users(h.rt).at(-1)!;
    h.rt.dangerHeld = true;
    h.rt.heldMode = 'default';
    await vi.advanceTimersByTimeAsync(29_000);
    const later = await h.send('second unread', true);
    expect(h.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(h.interrupt).toHaveBeenCalledTimes(1)); // Withdrawal is committed to disk before interrupt.
    expect(h.request.mock.calls.map(([r]) => r.message_uuid)).toEqual([uuid, later]);
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    h.result([h.first, h.uuid], true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(h.pushed).toHaveLength(6));
    expect(h.pushed.at(-2)?.message.content).toEqual([{ type: 'text', text: first.text }, { type: 'text', text: STEER_NOW_BLOCK }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.interrupt).toHaveBeenCalledTimes(1);
  });

  it('updates the waiting step without moving the deadline, and clears the fields on replay', async () => {
    const h = await waitingSteer();
    const autoAt = h.card.steerWait!.autoAt;
    h.rt.patch<ToolItem>(h.tool.id, { status: 'done' });
    expect(h.card.steerWait).toEqual({ autoAt, stepId: undefined });
    const next = h.rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', status: 'awaiting', title: 'Build', detail: {} });
    expect(phoneItem(h.card)).toMatchObject({ steerWait: { autoAt, stepId: next.id } });
    h.replay(h.uuid, h.card.text);
    expect(h.card.steerWait).toBeNull();
  });

  it.each(['taken', 'withdrawn', 'zero', 'stop'] as const)('does not interrupt after %s', async reason => {
    const h = await waitingSteer(reason === 'zero' ? 0 : 30_000);
    h.replay(h.uuid, h.card.text);
    vi.useFakeTimers();
    const uuid = await h.send('one more', true);
    const card = users(h.rt).at(-1)!;
    if (reason === 'taken') h.replay(uuid, card.text);
    if (reason === 'withdrawn') {
      await h.rt.handle!.recallSteers!(card.id, () => {});
      expect(h.rt.takeQueued(card.id)?.text).toBe(card.text);
      h.request.mockClear();
    }
    if (reason === 'zero') expect(card.steerWait?.autoAt).toBeUndefined();
    if (reason === 'stop') await h.stop();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.interrupt).toHaveBeenCalledTimes(reason === 'stop' ? 1 : 0);
  });
});

describe('Sable delegates in a Claude turn', () => {
  const early = 'The person sent a message, so this call returns early. The sub-agent keeps working in the background. Its report will be delivered to you when it finishes. Answer the person now, then carry on. Do not start the same task again.';
  const background = 'The sub-agent is working in the background. Its report will be delivered to you when it finishes. Carry on. Do not start the same task again.';
  async function setup() {
    const h = await claudeApp();
    const first = await h.send('delegate the review');
    h.replay(first, 'delegate the review');
    function start(agent: 'codex' | 'claude', id: string, inBackground = false, anonymous = false) {
      let child!: SessionRuntime;
      const interrupt = vi.fn(async () => child.endTurn());
      const close = vi.fn(async () => {});
      const provider = { open: async (r: SessionRuntime) => {
        child = r;
        return { send: async () => r.beginTurn(), interrupt, close };
      } } as unknown as Provider;
      const name = 'mcp__sable__delegate_to_' + agent;
      if (!anonymous) h.message({ type: 'assistant', uuid: 'call-' + id, message: { id: 'msg-' + id, content: [{ type: 'tool_use', id, name, input: { description: id, prompt: id } }] } });
      const parent = h.app.provider('claude') as ClaudeProvider;
      parent.ctx.otherAgents = () => ['claude', 'codex'];
      const options = parent.agentOptions(h.rt.meta, { session: h.rt.handle as Parameters<typeof parent.agentOptions>[1]['session'] });
      type RegisteredTool = { handler(args: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
      const server = options.mcpServers!.sable as unknown as { instance: { _registeredTools: Record<string, RegisteredTool> } };
      vi.spyOn(h.app, 'provider').mockImplementationOnce(() => provider);
      const result = server.instance._registeredTools['delegate_to_' + agent].handler(
        { description: id, prompt: id, background: inBackground }, { _meta: anonymous ? {} : { 'claudecode/toolUseId': id }, signal: new AbortController().signal },
      ).then(r => ({ ok: !r.isError, text: r.content[0].text }));
      const finish = (error?: string) => {
        child.add<TextItem>({ type: 'text', text: 'Report for ' + id, streaming: false });
        child.endTurn(error);
      };
      const receipt = (text: string) => h.message({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
      return { result, finish, child: () => child, interrupt, close, receipt, row: () => h.rt.get<ToolItem>(id)! };
    }
    return { ...h, first, start };
  }

  it.each(['codex', 'claude'] as const)('releases delegate_to_%s immediately, then wakes once at rest', async agent => {
    const h = await setup();
    const c = h.start(agent, 'review');
    const steer = await h.send('what did you find?', true);
    expect(await c.result).toEqual({ ok: true, text: early });
    c.receipt(early);
    h.replay(steer, 'what did you find?');
    h.result([h.first, steer]);
    expect(h.rt.turnActive).toBe(false);
    expect(c.row()).toMatchObject({ status: 'running' });
    expect(h.rt.meta.background).toBe(1);
    c.finish();
    await until(() => h.pushed.length >= 3, 'report wake');
    const report = h.pushed[2];
    expect(report.message.content).toContain('Report for review');
    expect(parseSynthetic(report.message.content as string)?.role).toBe('hidden');
    h.replay(report.uuid, report.message.content as string);
    expect(c.row()).toMatchObject({ status: 'done', delegateReport: 'delivered', result: { text: 'Report for review' } });
    expect(h.rt.meta.background ?? 0).toBe(0);
    expect(h.rt.items.find(i => i.type === 'text' && i.text === 'Report for review')?.parentId).toBe('review');
    h.result([report.uuid]);
    await tick();
    expect(h.rt.turnActive).toBe(false);
    expect(h.pushed).toHaveLength(3);
  });

  it('keeps two reports, including failure, through same-tick releases and late SDK tool results', async () => {
    const h = await setup();
    const a = h.start('claude', 'one', true);
    const b = h.start('codex', 'two', true);
    expect(await a.result).toEqual({ ok: true, text: background });
    expect(await b.result).toEqual({ ok: true, text: background });
    expect(h.rt.meta.background).toBe(2);
    a.finish();
    b.finish('failed');
    await until(() => h.pushed.length === 2, 'reports in the running turn');
    a.receipt(background);
    b.receipt(background);
    const report = h.pushed[1];
    expect(report.message.content).toContain('Report for one');
    expect(report.message.content).toContain('two (failed)');
    expect(report.message.content).not.toContain(STEER_FIRST_BLOCK);
    h.replay(report.uuid, report.message.content as string);
    expect(a.row()).toMatchObject({ status: 'done', delegateReport: 'delivered' });
    expect(b.row()).toMatchObject({ status: 'error', delegateReport: 'delivered' });
    expect(h.rt.meta.background ?? 0).toBe(0);
    h.result([h.first, report.uuid]);
    await tick();
    expect(h.pushed).toHaveLength(2);
  });

  it('preserves a child permission through release and turn end, then Stop reaches the child at rest', async () => {
    const h = await setup();
    const c = h.start('codex', 'child');
    const permission = c.child().requestPermission({ toolName: 'Read', kind: 'read', detail: {}, title: 'Read files', options: [{ id: 'yes', label: 'Allow', tone: 'allow' }] });
    const steer = await h.send('hello', true);
    expect(await c.result).toEqual({ ok: true, text: early });
    h.replay(steer, 'hello');
    h.result([h.first, steer]);
    const ask = h.rt.prompts().permissions[0];
    expect(ask).toMatchObject({ sessionId: h.id, itemId: 'child' });
    h.rt.answerPermission(ask.id, { optionId: 'yes' });
    expect(await permission).toMatchObject({ optionId: 'yes' });
    await h.stop();
    await until(() => c.row().delegateReport === 'stopped', 'stopped child');
    expect(c.interrupt).toHaveBeenCalledTimes(1);
    expect(h.rt.meta.background ?? 0).toBe(0);
    expect(h.pushed).toHaveLength(2);
  });

  it('retries and closes a deleted delegate whose turn never confirms Stop', async () => {
    const h = await setup();
    const c = h.start('codex', 'stuck', true);
    await c.result;
    c.interrupt.mockImplementation(async () => {});
    await h.app.call('session.close', { sessionId: h.id, remove: true });
    await until(() => c.close.mock.calls.length > 0, 'deleted child closed', 4000);
    expect(c.interrupt.mock.calls.length).toBeGreaterThan(1);
    expect(h.rt.pendingDelegateReports.size).toBe(0);
  });

  it('ignores late child frames after the person deletes the chat while its interrupt is in flight', async () => {
    const h = await setup();
    const c = h.start('codex', 'late', true);
    await c.result;
    c.interrupt.mockImplementation(async () => {});
    await h.app.call('session.close', { sessionId: h.id, remove: true });
    expect(c.interrupt).toHaveBeenCalled();
    c.finish();
    await tick();
    expect(h.rt.items.some(i => i.type === 'text' && i.text === 'Report for late')).toBe(false);
    expect(h.rt.pendingDelegateReports.size).toBe(0);
    expect(h.pushed).toHaveLength(1);
  });

  it('delivers a finished delegate to the idle parent beside a serving command', async () => {
    const h = await setup();
    const c = h.start('codex', 'review', true);
    await c.result;
    h.result([h.first]);
    h.rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Preview', detail: { command: 'npm run dev' }, status: 'done',
      task: { id: 'serve', kind: 'command', state: 'running', since: Date.now(), serving: true } });
    expect(h.rt.meta.serving).toBe(1);
    c.finish();
    await until(() => h.pushed.length === 2, 'report beside server');
    expect(h.pushed[1].message.content).toContain('Report for review');
  });

  it.each(['manual', 'revoked', 'unread', 'removed', 'command'] as const)('rechecks a finished report beside a server and a %s blocker', async blocker => {
    const h = await setup();
    const c = h.start('codex', 'held-report', true);
    await c.result;
    h.result([h.first]);
    await tick(20);
    h.rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Serve', detail: {}, status: 'done',
      task: { id: 'server', kind: 'command', state: 'running', since: Date.now(), serving: true } });
    const short = blocker === 'command' && h.rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Build', detail: {}, status: 'done',
      task: { id: 'build', kind: 'command', state: 'running', since: Date.now() } });
    const queued = blocker !== 'command' && h.rt.enqueue('later');
    if (queued && blocker === 'manual') queued.byHand = true;
    if (queued && blocker === 'revoked') queued.phoneSender = { deviceId: 'removed', generation: 1 };
    if (queued && blocker === 'unread') h.rt.unreadQueueHeld = true;
    c.finish();
    await until(() => !h.rt.delegates.size, 'saved report');
    await tick(50);
    if (blocker === 'command' || blocker === 'removed') expect(h.pushed).toHaveLength(1);
    if (queued && blocker === 'removed') h.rt.takeQueued(queued.id);
    if (short) h.rt.patch<ToolItem>(short.id, { task: { ...short.task!, state: 'done' } });
    await until(() => h.pushed.length === 2, 'report after blocker clears');
    expect(h.pushed[1].message.content).toContain('Report for held-report');
  });

  it('rechecks when a send reservation and the last delivery hold release', async () => {
    const h = await setup();
    const c = h.start('codex', 'pending-hold', true);
    await c.result;
    h.result([h.first]);
    const gates = h.app as unknown as {
      holdSends(rt: SessionRuntime, wait: Promise<void>): Promise<void>;
      beginDispatch(rt: SessionRuntime): () => void;
    };
    let finish!: () => void;
    const held = gates.holdSends(h.rt, new Promise<void>(resolve => { finish = resolve; }));
    const release = gates.beginDispatch(h.rt);
    c.finish();
    await until(() => !h.rt.delegates.size, 'child ended');
    release();
    await tick(60);
    expect(h.pushed).toHaveLength(1);
    finish();
    await held;
    await until(() => h.pushed.length === 2, 'last hold released');
    expect(h.pushed[1].message.content).toContain('Report for pending-hold');
  });

  it('holds a failed child report across a move, limit decision and send, then attaches it to the next message once', async () => {
    const h = await setup();
    const locks = h.app as unknown as { moving: Set<string>; limitDecisions: Map<string, Set<string>>; sending: Map<string, number> };
    const c = h.start('codex', 'lost', true);
    await c.result;
    h.result([h.first]);
    locks.moving.add(h.id);
    c.child().cutTurn('died');
    await until(() => c.row().delegateReport === 'pending', 'process loss');
    await tick();
    expect(h.pushed).toHaveLength(1);
    locks.moving.delete(h.id);
    locks.limitDecisions.set(h.id, new Set(['limit']));
    h.rt.onDelegateReport!();
    await tick();
    expect(h.pushed).toHaveLength(1);
    locks.limitDecisions.delete(h.id);
    locks.sending.set(h.id, 1);
    h.rt.onDelegateReport!();
    await tick();
    expect(h.pushed).toHaveLength(1);
    await until(() => !h.rt.delegates.has('lost'), 'held result committed');
    locks.sending.delete(h.id);
    const uuid = await h.send('carry on');
    const words = h.pushed.at(-1)!.message.content as string;
    expect(words).toContain('The sub-agent lost its process');
    expect(stripWrappers(words)).toBe('carry on');
    h.rt.reset([...h.rt.items]);
    h.rt.onDelegateReport!();
    await tick();
    expect(h.pushed).toHaveLength(2);
    h.replay(uuid, words);
    expect(c.row().delegateReport).toBe('delivered');
    expect(h.rt.meta.delegateRecovery).toBeUndefined();
  });

  it('restores a lost delegate with its restart report and keeps a stopped one quiet', async () => {
    const h = await setup();
    const row = (id: string, delegateReport: 'working' | 'stopping'): ToolItem => ({
      type: 'tool', id, ts: 1, name: 'delegate_to_codex', kind: 'agent', status: 'running', title: id, detail: {},
      delegateReport, result: { agent: { background: 'running' } },
    });
    h.result([h.first]);
    h.rt.loadRestored([row('review', 'working'), row('old', 'stopping')]);
    h.rt.onDelegateReport!();
    await until(() => h.pushed.length === 2, 'restart report');
    const words = h.pushed[1].message.content as string;
    expect(words).toContain('Sable restarted before the sub-agent reported.');
    expect(words).not.toContain('old (');
    h.replay(h.pushed[1].uuid, words);
    expect(h.rt.get<ToolItem>('review')?.delegateReport).toBe('delivered');
    expect(h.rt.get<ToolItem>('old')?.delegateReport).toBe('stopped');
  });

  it('keeps two anonymous calls on distinct delegate rows', async () => {
    const h = await setup();
    const a = h.start('codex', 'one', true, true);
    const b = h.start('codex', 'two', true, true);
    await Promise.all([a.result, b.result]);
    expect(h.rt.delegates.size).toBe(2);
    a.finish();
    b.finish();
    await until(() => h.pushed.length > 1, 'two anonymous reports');
    expect(h.pushed[1].message.content).toContain('Report for one');
    expect(h.pushed[1].message.content).toContain('Report for two');
  });

  it('declines a repeated explicit claim and only removes its own registration', async () => {
    const h = await setup();
    const a = h.start('codex', 'same', true);
    await a.result;
    const owner = h.rt.delegates.get('same')!;
    const duplicate = h.start('codex', 'same', true);
    expect(await duplicate.result).toMatchObject({ ok: false });
    expect(h.rt.delegates.get('same')).toBe(owner);
    const successor = { detach() {}, stop() {}, ended: Promise.resolve() };
    h.rt.delegates.set('same', successor);
    a.finish();
    await owner.ended;
    expect(h.rt.delegates.get('same')).toBe(successor);
    expect(h.rt.pendingDelegateReports.has('same')).toBe(false);
    expect(h.rt.items.some(i => i.type === 'text' && i.text === 'Report for same')).toBe(false);
  });

  it.each([true, false])('recovers the foreground answer only without a tool receipt (receipt %s)', async read => {
    const h = await setup();
    const c = h.start('codex', 'foreground');
    await tick();
    c.finish();
    const answer = await c.result;
    if (read) c.receipt(answer.text);
    await h.rt.handle!.close('move');
    expect(h.rt.pendingDelegateReports.has('foreground')).toBe(!read);
    expect(c.row().result?.text).toBe(answer.text);
  });

  it('preserves the foreground answer across a substitute tool result', async () => {
    const h = await setup();
    const c = h.start('codex', 'substitute');
    await tick();
    c.finish();
    const answer = await c.result;
    c.receipt('Tool execution was interrupted');
    expect(c.row().result?.text).toBe(answer.text);
    await h.rt.handle!.close('move');
    expect(h.rt.pendingDelegateReports.has('substitute')).toBe(true);
  });

  it('checks saved native tool bodies and returns just the requested receipts', async () => {
    const h = await setup();
    const p = h.app.provider('claude') as ClaudeProvider;
    const id = 'fea5b259-ff81-4da5-9670-bf4f16ae95ce';
    const anon = 'delegate-' + id;
    const digest = resultDigest('actual answer')!;
    const tools = new Map<string, { delivery?: string; digest?: string }>([['good', { digest }], ['wrong', { digest }], [anon, { delivery: id }]]);
    sdk.history.mockResolvedValueOnce([{ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'good', content: [{ type: 'text', text: 'actual answer' }] },
      { type: 'tool_result', tool_use_id: 'wrong', is_error: true, content: 'Interrupted' },
      { type: 'tool_result', tool_use_id: 'unrelated', content: 'actual answer' },
      { type: 'tool_result', tool_use_id: 'sdk-id', content: 'actual answer\n\n[Sable delegate receipt ' + id + ']' },
    ] } }]);
    const receipts = await p.delegateReceipts('cc1', h.rt.meta.cwd, undefined, { ids: new Set(), tools });
    expect(receipts.ids).toEqual(new Set(['tool:good', 'tool:' + anon]));
    expect(receipts.settled).toBe(false);
  });

  it('sends personal input immediately when a known report checkpoint is still writing', async () => {
    const h = await setup();
    h.result([h.first]);
    const row = h.rt.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', status: 'done',
      detail: {}, title: 'Held', result: { text: 'later report' }, delegateReport: 'pending', delegateWait: 'budget' });
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    h.rt.persistDelegate = write;
    h.rt.pendingDelegateReports.add(row.id);
    h.rt.onDelegateReport!();
    await until(() => write.mock.calls.length > 0, 'checkpoint began');
    try {
      await h.send('do this first');
      expect(h.pushed[1].message.content).toBe('do this first');
    } finally {
      h.rt.persistDelegate = h.rt.persistInput;
      finish();
    }
  });

  it('expires a second receipt lookup on the same chat without launching another SDK reader', async () => {
    const h = await setup();
    const p = h.app.provider('claude') as ClaudeProvider;
    let finish!: (rows: never[]) => void;
    sdk.history.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([]);
    const slow = p.steerReceipts('same-chat', h.rt.meta.cwd, new Set(['first']));
    try {
      await until(() => !!finish, 'first SDK reader');
      await expect(p.delegateReceipts('same-chat', h.rt.meta.cwd, undefined, { tools: new Map(), ids: new Set(['second']) },
        AbortSignal.timeout(50))).rejects.toThrow();
      expect(sdk.history).toHaveBeenCalledTimes(1);
    } finally { finish([]); await slow; }
  });

  it('reads another chat while a steer history read is stalled', async () => {
    const h = await setup();
    const p = h.app.provider('claude') as ClaudeProvider;
    let finish!: (rows: never[]) => void;
    sdk.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce([{ type: 'user', uuid: 'other' }]);
    const slow = p.steerReceipts('cc1', h.rt.meta.cwd, new Set(['first']));
    try {
      await until(() => !!finish, 'first lookup');
      const fast = p.steerReceipts('cc2', h.rt.meta.cwd, new Set(['other']));
      expect(await Promise.race([fast, tick(250).then(() => [])])).toEqual(['other']);
    } finally { finish([]); await slow; }
  });

  it('releases the Claude history lock when a report read times out', async () => {
    const h = await setup();
    const p = h.app.provider('claude') as ClaudeProvider;
    let finish!: (rows: never[]) => void;
    sdk.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const read = p.delegateReceipts('cc1', h.rt.meta.cwd, undefined, { ids: new Set(['id']), tools: new Map() }, AbortSignal.timeout(80));
      await expect(read).rejects.toThrow();
      sdk.history.mockResolvedValueOnce([{ type: 'user', uuid: 'free' }]);
      expect(await p.steerReceipts('cc2', h.rt.meta.cwd, new Set(['free']))).toEqual(['free']);
    } finally { finish?.([]); }
  });

  it('hydrates two recovery chats at a time', async () => {
    const h = await setup();
    const home = mkdtempSync(path.join(tmpdir(), 'delegate-hydration-'));
    const state = { ...h.app.store.state, sessions: Array.from({ length: 5 }, (_, i) => ({ ...h.rt.meta, status: 'idle', id: 'recover' + i, delegateRecovery: true })) };
    writeFileSync(path.join(home, 'state.json'), JSON.stringify(state));
    const gates: (() => void)[] = [];
    let active = 0, peak = 0;
    const files = vi.spyOn(Store.prototype, 'loadSessionAsync').mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>(resolve => gates.push(resolve));
      active--;
      return { items: [], todos: [] };
    });
    vi.useFakeTimers();
    const app = new App({ home, userHome: home, quiet: true, providers: [() => h.app.provider('claude')] });
    const delayed: string[] = [];
    app.subscribe(e => { if (e.type === 'toast' && e.text.includes('Delegate recovery')) delayed.push(e.text); });
    try {
      expect(gates).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(90_010);
      expect(delayed).toHaveLength(2);
      expect(gates).toHaveLength(2);
      vi.useRealTimers();
      for (let n = 0; n < 5; n++) {
        await until(() => !!gates[n], 'next recovery read');
        gates[n]();
      }
      expect(peak).toBe(2);
    } finally {
      vi.useRealTimers();
      for (const resolve of gates) resolve();
      files.mockRestore();
      await app.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts the native Claude result after the quit interrupt grace expires', async () => {
    const h = await claude({ meta: { id: 'sub-quitting' } });
    const { uuid } = await h.send('finish the review');
    await h.replay(uuid, 'finish the review');
    Object.assign(h.rt, { awaitingQuitResult: true });
    vi.useFakeTimers();
    try {
      await h.session.interrupt();
      await vi.advanceTimersByTimeAsync(7900);
      expect(h.rt.turnActive).toBe(true);
      await h.text('Definitive review');
      await h.message(result([uuid]));
      expect(h.rt.turnActive).toBe(false);
      expect(h.rt.items.some(i => i.type === 'notice' && i.variant === 'interrupted')).toBe(false);
      expect(h.rt.items.some(i => i.type === 'text' && i.text === 'Definitive review')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('recovers a definitive child answer received after the quit seal', async () => {
    const h = await setup();
    const c = h.start('codex', 'after-seal', true);
    await c.result;
    await until(() => c.child().turnActive, 'started');
    c.interrupt.mockImplementation(async () => {});
    let close!: () => void;
    c.close.mockImplementation(async () => new Promise(resolve => { close = resolve; }));
    await h.rt.persistDelegate!();
    vi.useFakeTimers();
    let sealed = false;
    const quitting = h.app.dispose(() => { sealed = true; });
    await vi.advanceTimersByTimeAsync(7900);
    vi.useRealTimers();
    try {
      await until(() => sealed, 'sealed snapshot');
      c.finish();
      await tick();
      const restarted = await claudeApp(h);
      await until(() => !!restarted.rt.get('after-seal'), 'recovered row');
      expect(restarted.rt.get<ToolItem>('after-seal')).toMatchObject({ status: 'done', result: { text: 'Report for after-seal' } });
    } finally { close?.(); await quitting; }
  });

  it('saves a final delegate answer received during quit before acknowledging the store', async () => {
    const h = await setup();
    const c = h.start('codex', 'update', true);
    await c.result;
    await until(() => c.child().turnActive, 'started');
    c.interrupt.mockImplementation(async () => { await tick(); c.finish(); });
    await h.app.dispose();
    const disk = new SessionFiles(id => path.join(h.home, 'sessions', id + '.json')).load(h.id);
    expect(disk.items.find(i => i.id === 'update')).toMatchObject({ delegateReport: 'pending', result: { text: 'Report for update' } });
  });

  it.each(['stuck', 'closed'] as const)('seals an unconfirmed child as working when its transport is %s during quit', async transport => {
    const h = await setup();
    const c = h.start('codex', 'unconfirmed-quit', true);
    await c.result;
    await until(() => c.child().turnActive, 'child began');
    c.interrupt.mockImplementation(async () => {});
    let close!: () => void;
    c.close.mockImplementation(async () => { if (transport === 'stuck') await new Promise<void>(resolve => { close = resolve; }); });
    vi.useFakeTimers();
    const quitting = h.app.dispose();
    await expect(h.app.call('session.send', { sessionId: h.id, text: 'too late' })).rejects.toThrow(/closing/);
    await vi.advanceTimersByTimeAsync(8000);
    vi.useRealTimers();
    try {
      await quitting;
      const disk = new SessionFiles(id => path.join(h.home, 'sessions', id + '.json')).load(h.id);
      expect(disk.items.find(i => i.id === 'unconfirmed-quit')).toMatchObject({ delegateReport: 'working' });
      const recovered = new SessionRuntime({ ...h.rt.meta }, () => {}, () => {});
      recovered.loadRestored(disk.items);
      expect(recovered.get<ToolItem>('unconfirmed-quit')?.result?.text).toContain('Sable restarted');
    } finally { close?.(); }
  });

  it('keeps a detached child of the retained conversation across rewind', async () => {
    const h = await setup();
    const retained = h.start('codex', 'retained', true);
    await retained.result;
    h.result([h.first]);
    const later = await h.send('later');
    h.replay(later, 'later');
    const pruned = h.start('codex', 'pruned', true);
    await pruned.result;
    h.result([later]);
    const target = users(h.rt).find(u => u.text === 'later')!;
    expect(await h.app.call('session.rewind', { sessionId: h.id, itemId: target.id, restoreFiles: false })).toMatchObject({ ok: true });
    expect(pruned.interrupt).toHaveBeenCalled();
    expect(retained.interrupt).not.toHaveBeenCalled();
    retained.finish();
    await until(() => !h.rt.delegates.size, 'retained child finished');
    expect(retained.row().result?.text).toBe('Report for retained');
  });

  it.each([true, false])('settles an unacknowledged report reservation at its deadline (issued %s)', async issued => {
    const h = await setup();
    let wire!: NonNullable<Parameters<ProviderSession['send']>[1]>;
    const send = vi.spyOn(h.rt.handle!, 'send').mockImplementationOnce(async (_item, opts) => {
      wire = opts!;
      if (issued) wire.issueReport?.();
    });
    const c = h.start('codex', 'no-ack', true);
    await c.result;
    vi.useFakeTimers();
    try {
      c.finish();
      await vi.waitFor(() => expect(wire).toBeDefined());
      if (issued) sdk.history.mockResolvedValueOnce([]);
      await vi.advanceTimersByTimeAsync(90_010);
      expect(c.row().delegateReport).toBe('pending');
      if (issued) {
        // The receipt lookup did not complete: the report goes again by itself, once, and nothing is written.
        expect(c.row().delegateRedelivered).toBe(1);
        expect(c.row().delegateReceiptState).toBeFalsy();
        expect(c.row().delegateRetryId).toBeFalsy();
        expect(h.rt.reservedDelegateReports.has('no-ack') || h.rt.pendingDelegateReports.has('no-ack')).toBe(true);
        expect(h.rt.items.some(i => i.type === 'notice' && /Delivery unconfirmed|report-retry/.test(i.text + (i.detail ?? '')))).toBe(false);
      } else {
        expect(h.rt.reservedDelegateReports.has('no-ack')).toBe(false);
        expect(c.row().delegateReceiptState).toBeFalsy();
        expect(users(h.rt)[0].delegateContinuations ?? 0).toBe(0);
        expect(() => wire.issueReport?.()).toThrow();
      }
    } finally { vi.useRealTimers(); send.mockRestore(); }
  });

  it('sends personal words while the report history read is stalled', async () => {
    const h = await setup();
    let resume!: () => void;
    const read = vi.spyOn(h.app.provider('claude') as ClaudeProvider, 'delegateReceipts').mockImplementation(() =>
      new Promise(resolve => { resume = () => resolve({ ids: new Set(), settled: false }); }));
    const c = h.start('codex', 'unconfirmed');
    await tick();
    c.finish();
    await c.result;
    h.result([h.first]);
    h.rt.endDelegateGeneration();
    try {
      const sending = h.send('my words');
      await until(() => read.mock.calls.length > 0, 'lookup');
      await until(() => h.pushed.some(m => m.message.content === 'my words'), 'personal input');
      await sending;
    } finally { resume?.(); }
  });

  it('recovers a foreground answer prepared before the SDK tool returned', async () => {
    const h = await setup();
    const c = h.start('codex', 'before-return');
    await tick();
    let close!: () => void;
    c.close.mockImplementationOnce(() => new Promise(resolve => { close = resolve; }));
    c.finish();
    await until(() => !!close, 'terminal save before close');
    try {
      const restarted = await claudeApp(h);
      await until(() => restarted.pushed.length > 0, 'unissued foreground answer recovered');
      expect(restarted.pushed[0].message.content).toContain('Report for before-return');
      expect(restarted.rt.get<ToolItem>('before-return')?.delegateReceiptState).toBeFalsy();
    } finally { close(); await c.result; }
  });

  it('sends a foreground tool result with no echo again once, with no notice', async () => {
    const h = await setup();
    const c = h.start('codex', 'silent-caller');
    await tick();
    vi.useFakeTimers();
    try {
      c.finish();
      await vi.waitFor(() => expect(c.row().delegateAttempt?.tool).toBe('silent-caller'));
      sdk.history.mockResolvedValueOnce([]);
      await vi.advanceTimersByTimeAsync(90_010);
      expect(c.row()).toMatchObject({ delegateReport: 'pending', delegateRedelivered: 1, result: { text: 'Report for silent-caller' } });
      expect(c.row().delegateReceiptState).toBeFalsy();
      expect(c.row().delegateRetryId).toBeFalsy();
      expect(h.rt.items.some(i => i.type === 'notice' && /Delivery unconfirmed|report-retry/.test(i.text + (i.detail ?? '')))).toBe(false);
    } finally { vi.useRealTimers(); await c.result; }
  });

  it('recognizes the foreground receipt when the call arrived before its native tool ID', async () => {
    const h = await setup();
    const c = h.start('codex', 'late-native', false, true);
    await tick();
    c.finish();
    const answer = await c.result;
    c.receipt(answer.text);
    await h.rt.handle!.close('move');
    expect(h.rt.pendingDelegateReports.size).toBe(0);
    expect(h.rt.meta.delegateRecovery).toBeUndefined();
  });

  it('recovers an in-flight foreground call when the entire bridge restarts', async () => {
    const h = await setup();
    const c = h.start('codex', 'in-flight');
    await tick();
    await h.app.store.flush();
    const restarted = await claudeApp(h);
    await until(() => restarted.pushed.length > 0, 'restored foreground call');
    expect(restarted.pushed[0].message.content).toContain('Sable restarted before the sub-agent reported.');
    c.finish();
    await c.result;
  });

  it('recovers a saved terminal child answer and leaves partial text unconfirmed', async () => {
    const h = await setup();
    h.result([h.first]);
    const rows = ['finished', 'partial'].flatMap((id): TimelineItem[] => [
      { type: 'tool', id, name: 'delegate_to_codex', kind: 'agent', status: 'running', title: id, detail: {}, ts: 1,
        delegateReport: 'working', result: { agent: { background: 'running' } } },
      { type: 'text', parentId: id, id: 'sub-123:' + id, ts: 2, text: id + ' answer', streaming: false },
      ...(id === 'finished' ? [{ type: 'turn' as const, parentId: id, id: 'sub-123:end', ts: 3, durationMs: 1 }] : []),
    ]);
    h.rt.loadRestored(rows);
    expect(h.rt.get<ToolItem>('finished')).toMatchObject({ status: 'done', delegateReport: 'pending', result: { text: 'finished answer' } });
    expect(h.rt.get<ToolItem>('partial')?.result?.text).toBe('Sable restarted before the sub-agent reported.');
  });

  it('retains the completed foreground answer when its caller exits in the same tick', async () => {
    const h = await setup();
    const c = h.start('codex', 'boundary');
    await tick();
    c.finish();
    await h.rt.handle!.close('move');
    expect(await c.result).toMatchObject({ ok: true, text: 'Report for boundary' });
    expect(c.row()).toMatchObject({ delegateReport: 'pending', result: { text: 'Report for boundary' } });
  });

  it('preserves the child question before its display row arrives', async () => {
    const h = await setup();
    const c = h.start('codex', 'review', true);
    await c.result;
    const answer = c.child().ask([], 'missing-nested-step');
    const req = h.rt.prompts().questions[0];
    expect(phoneQuestion(req)).toMatchObject({ delegateId: 'review', itemId: expect.stringContaining('missing-nested-step') });
    h.result([h.first]);
    expect(h.rt.answerQuestion(req.id, { choice: ['continue'] })).toBe(true);
    expect(await answer).toEqual({ choice: ['continue'] });
    c.finish();
  });

  it('keeps an owed report behind the person’s Stop across restart', async () => {
    const h = await setup();
    const c = h.start('codex', 'stopped-wake', true);
    await c.result;
    h.result([h.first]);
    const locks = h.app as unknown as { moving: Set<string> };
    locks.moving.add(h.id);
    c.finish();
    await until(() => !h.rt.delegates.size, 'saved report');
    await h.stop();
    await h.app.store.flush();
    const restored = await claudeApp(h);
    await until(() => !!restored.rt.get('stopped-wake'), 'restored report');
    await tick(100);
    expect(restored.pushed).toHaveLength(0);
    await restored.send('now continue');
    expect(restored.pushed[0].message.content).toContain('Report for stopped-wake');
  });

  it('revokes a rewound delegate before its late frames and drops an empty wake', async () => {
    const h = await setup();
    const c = h.start('codex', 'pruned', true);
    await c.result;
    c.interrupt.mockImplementation(async () => {});
    h.result([h.first]);
    const head = users(h.rt)[0];
    expect(await h.app.call('session.rewind', { sessionId: h.id, itemId: head.id, restoreFiles: false })).toMatchObject({ ok: true });
    c.finish();
    await tick(40);
    expect(h.rt.items.some(i => i.parentId === 'pruned')).toBe(false);
    h.rt.pendingDelegateReports.add('missing');
    h.rt.onDelegateReport!();
    await tick(40);
    expect(h.pushed).toHaveLength(1);
  });

  it.each([false, true])('reclaims a locally rejected report offer before the next chat save (issued checkpoint %s)', async checkpoint => {
    const h = await setup();
    const c = h.start('codex', 'local-rejection', true);
    await c.result;
    await h.app.store.flush();
    let copied: ReturnType<typeof claudeApp> | undefined;
    const send = vi.spyOn(h.rt.handle!, 'send').mockImplementationOnce(async (_item, opts) => {
      opts!.issueReport!();
      expect(users(h.rt)[0].delegateContinuations).toBe(1);
      if (checkpoint) await h.rt.persistDelegate!();
      opts!.release!(true);
      expect(users(h.rt)[0].delegateContinuations).toBe(0);
      copied = claudeApp(h);
    });
    try {
      c.finish();
      await until(() => !!copied, 'copied at the local refusal');
      const restarted = await copied!;
      const row = () => restarted.rt.get<ToolItem>('local-rejection');
      await until(() => !!restarted.pushed.length || !!row()?.delegateRetryId, 'recovered report');
      expect(row()?.delegateReceiptState).toBeFalsy();
      expect(restarted.pushed[0].message.content).toContain('Report for local-rejection');
      expect(users(restarted.rt)[0].delegateContinuations).toBe(1);
    } finally { send.mockRestore(); }
  });

  it('carries a prepared budget-held report after a crash without charging it', async () => {
    const h = await setup();
    h.rt.patch<UserItem>(users(h.rt)[0].id, { delegateContinuations: 2 });
    const c = h.start('codex', 'prepared', true);
    await c.result;
    c.finish();
    await until(() => c.row().delegateWait === 'budget', 'held for next message');
    await h.rt.persistDelegate!();
    const restarted = await claudeApp(h);
    await until(() => !!restarted.rt.get('prepared'), 'restored hold');
    await tick(50);
    expect(restarted.rt.get<ToolItem>('prepared')?.delegateReceiptState).toBeFalsy();
    expect(users(restarted.rt)[0].delegateContinuations).toBe(2);
    await restarted.send('carry it');
    expect(restarted.pushed[0].message.content).toContain('Report for prepared');
  });

  it.each([false, true])('keeps a superseded limit from blocking reports after restart (legacy %s)', async legacy => {
    const h = await setup();
    h.result([h.first]);
    h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Earlier limit', limit: { window: '5-hour limit' } });
    const words = await h.send('new personal turn');
    h.replay(words, 'new personal turn');
    h.result([words]);
    const holds = (a: App, r: SessionRuntime) => (a as unknown as { limitHoldsWake(rt: SessionRuntime): boolean }).limitHoldsWake(r);
    expect(holds(h.app, h.rt)).toBe(false);
    if (legacy) for (const row of users(h.rt)) h.rt.patch<UserItem>(row.id, { completedPersonalTurn: undefined });
    await h.rt.persistDelegate!();
    const restarted = await claudeApp(h);
    await restarted.app.call('session.snapshot', { sessionId: h.id });
    expect(holds(restarted.app, restarted.rt)).toBe(false);
    restarted.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'New limit', limit: { window: '5-hour limit' } });
    expect(holds(restarted.app, restarted.rt)).toBe(true);
  });

  it('holds the third report continuation until the next personal message', async () => {
    const h = await setup();
    for (let n = 1; n <= 3; n++) {
      const c = h.start('codex', 'chain-' + n, true);
      await c.result;
      c.finish();
      if (n < 3) {
        await until(() => h.pushed.length === n + 1, 'report in running turn');
        const m = h.pushed[n];
        h.replay(m.uuid, m.message.content as string);
      } else {
        await tick(100);
        expect(c.row().delegateReport).toBe('pending');
        expect(phoneItem(c.row())).toMatchObject({ delegateReport: 'pending', delegateWait: 'budget', status: 'done' });
        expect(h.pushed).toHaveLength(3);
      }
    }
    h.result(h.pushed.map(m => m.uuid));
    await tick(40);
    expect(h.pushed).toHaveLength(3);
    await h.send('now continue');
    expect(h.pushed.at(-1)!.message.content).toContain('Report for chain-3');
  });

  it('keeps a missing receipt uncertain when Claude history starts after compaction', async () => {
    const h = await setup();
    const messages = [{ type: 'user', uuid: 'summary', isCompactSummary: true, message: { content: 'Earlier conversation summarized' } },
      { type: 'assistant', uuid: 'after', message: { content: [] } }];
    const id = 'fea5b259-ff81-4da5-9670-bf4f16ae95ce';
    const wanted = { ids: new Set([id]), tools: new Map() };
    sdk.history.mockResolvedValueOnce(messages).mockResolvedValueOnce(messages).mockResolvedValueOnce([...messages,
      { type: 'user', message: { content: '<system-reminder>A background sub-agent reported.\nReview (done)\nDelivery ID: ' + id + '\nanswer</system-reminder>' } }]);
    const provider = h.app.provider('claude') as ClaudeProvider;
    expect((await provider.delegateReceipts('compacted', h.rt.meta.cwd, 'before', wanted)).settled).toBe(false);
    expect((await provider.delegateReceipts('compacted', h.rt.meta.cwd, 'after', wanted)).settled).toBe(false);
    expect((await provider.delegateReceipts('compacted', h.rt.meta.cwd, 'after', wanted)).settled).toBe(true);
  });

  it('knows the native report destination before Claude reads its first input', async () => {
    const h = await claude({ live: true });
    const destination = h.session.delegateDestination!();
    expect(destination).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.proc().options).toMatchObject({ sessionId: destination });
    expect(h.proc().pushed).toHaveLength(0);
  });

  it.each([true, false])('reconciles the on-disk report against native input after a crash (recorded %s)', async recorded => {
    const h = await setup();
    const c = h.start('codex', 'durable', true);
    await c.result;
    await h.app.store.flush();
    c.finish();
    await until(() => h.pushed.length === 2, 'report on the wire');
    const disk = new SessionFiles(id => path.join(h.home, 'sessions', id + '.json')).load(h.id);
    const saved = disk.items.find(i => i.id === 'durable') as ToolItem;
    expect(saved.result?.text).toBe('Report for durable');
    const m = h.pushed[1];
    sdk.history.mockResolvedValueOnce([{ type: 'user', uuid: h.first, message: { content: 'delegate the review' } },
      ...(recorded ? [{ type: 'user', uuid: m.uuid, message: m.message }] : [])]);
    const restarted = await claudeApp(h);
    // A lookup that did not complete sends the report again by itself, once, with no notice.
    await until(() => recorded ? restarted.rt.get<ToolItem>('durable')?.delegateReport === 'delivered' : restarted.pushed.length === 1, 'restart reconciliation');
    if (!recorded) {
      expect(restarted.rt.get<ToolItem>('durable')).toMatchObject({ delegateRedelivered: 1 });
      expect(restarted.rt.get<ToolItem>('durable')?.delegateReceiptState).toBeFalsy();
      expect(restarted.rt.items.some(i => i.type === 'notice' && /Delivery unconfirmed|report-retry/.test(i.text + (i.detail ?? '')))).toBe(false);
      expect(restarted.pushed[0].message.content).toContain('If you already have the report with this Delivery ID, ignore this copy.');
    }
    expect(restarted.pushed).toHaveLength(recorded ? 0 : 1);
    if (!recorded) expect(restarted.pushed[0].message.content).toEqual(m.message.content);
  });

  it('leaves a completed foreground result alone when the steer arrives afterwards', async () => {
    const h = await setup();
    const c = h.start('codex', 'first');
    await tick();
    c.finish();
    expect(await c.result).toEqual({ ok: true, text: 'Report for first' });
    await h.send('how did it go?', true);
    expect(c.row().delegateReport).toBeUndefined();
    expect(h.rt.meta.background ?? 0).toBe(0);
    expect(h.rt.pendingDelegateReports.size).toBe(0);
  });
});

describe('interrupt and send now', () => {
  it('round trips quoted reports and file references on import and unmatched replay', async () => {
    const source = await claude();
    await source.send('begin');
    const words = 'I copied this:\n\n<system-reminder>A background sub-agent reported.\nReview (done)\nReady</system-reminder>';
    const file = { id: 'f', name: 'log.txt', path: 'C:/fixture/log.txt', kind: 'file' as const };
    const user = source.rt.add<UserItem>({ type: 'user', state: 'queued', authored: true, steered: true, text: words, attachments: [file] });
    const extra = '\n\n<system-reminder>A background sub-agent reported.\nAnother (done)\nPrivate</system-reminder>';
    await source.session.send({ ...user, text: words + extra }, { personalOffset: 0 });
    const content = source.pushed.at(-1)!.message.content;
    const h = await claude({ meta: { providerSessionId: 'imported' } });
    sdk.history.mockReset().mockResolvedValueOnce([{ type: 'user', uuid: 'old', message: { content } }]);
    await (h.session.loadTranscript as () => Promise<void>)();
    await h.replay('unmatched', content);
    expect(users(h.rt).map(u => u.text)).toEqual([words + '\n\n@' + file.path, words + '\n\n@' + file.path]);
  });

  it('recovers the file references in a legacy split steer on import and replay', async () => {
    const h = await claude({ meta: { providerSessionId: 'imported' } });
    const note = '\n\n' + delegateReport('Private child', 'done', 'not in the quotation');
    const refs = '\n\n@C:/work/first file.txt @C:/work/second.md';
    const content = ['my words', refs + note, STEER_FIRST_BLOCK].map(text => ({ type: 'text', text }));
    sdk.history.mockReset().mockResolvedValueOnce([{ type: 'user', uuid: 'old', message: { content } }]);
    await (h.session.loadTranscript as () => Promise<void>)();
    await h.replay('new', content);
    expect(users(h.rt).map(u => u.text)).toEqual(['my words' + refs, 'my words' + refs]);
  });


  it('preserves the authored SDK block and hides a composed report when importing a transcript', async () => {
    const h = await claude({ meta: { providerSessionId: 'imported' } });
    const note = '<system-reminder>A background sub-agent reported.\nReview (done)\nReady</system-reminder>';
    const report = HANDOVER_HEAD_ACCOUNT + '\nAgent: Done\n' + HANDOVER_TAIL + HANDOVER_JOIN + 'A background sub-agent reported.\n\n' + note;
    const words = 'I saw this ' + STEER_NOW_BLOCK + ' yesterday.';
    sdk.history.mockReset().mockResolvedValueOnce([
      { type: 'user', uuid: 'report', message: { content: report } },
      { type: 'user', uuid: 'with-report', message: { content: [{ type: 'text', text: nativePersonalPrompt(words + '\n\n' + note, words, 0) }, { type: 'text', text: STEER_NOW_BLOCK }] } },
      { type: 'user', uuid: 'quote', message: { content: [{ type: 'text', text: words }, { type: 'text', text: STEER_NOW_BLOCK }] } },
      { type: 'user', uuid: 'literal', message: { content: [{ type: 'text', text: STEER_NOW_BLOCK }, { type: 'text', text: STEER_FIRST_BLOCK }] } },
      { type: 'user', uuid: 'split', message: { content: [{ type: 'text', text: words }, { type: 'text', text: '\n\n' + note }, { type: 'text', text: STEER_NOW_BLOCK }] } },
      { type: 'user', uuid: 'standalone', message: { content: STEER_NOW_BLOCK } },
      { type: 'user', uuid: 'trailing', message: { content: 'My quote\n\n' + STEER_NOW_BLOCK } },
      { type: 'user', uuid: 'unclosed', message: { content: '<system-reminder>' } },
    ]);
    await (h.session.loadTranscript as () => Promise<void>)();
    expect(users(h.rt).map(u => u.text)).toEqual([words, words, STEER_NOW_BLOCK, words, STEER_NOW_BLOCK, 'My quote\n\n' + STEER_NOW_BLOCK, '<system-reminder>']);
    expect(users(h.rt).slice(0, 6).every(u => u.authored)).toBe(true);
  });

  it('caps automatic redelivery of a replacement after two interruptions', async () => {
    const h = await waitingSteer();
    await h.send('second', true);
    const second = users(h.rt).at(-1)!;
    await h.send('third', true);
    const third = users(h.rt).at(-1)!;
    const firstBatch = h.now();
    await until(() => h.interrupt.mock.calls.length === 1, 'first scoped interrupt');
    h.result([h.first], true);
    await firstBatch;
    const replacement = h.pushed.at(-3)!;
    h.replay(replacement.uuid, h.card.text);
    const secondBatch = h.now(second.id);
    await until(() => h.interrupt.mock.calls.length === 2, 'second scoped interrupt');
    h.result([replacement.uuid], true);
    await secondBatch;
    const waiting = h.rt.get<UserItem>(third.id)!;
    expect(waiting.steerAttempts).toBe(2);
    expect(waiting.steerWait?.autoAt).toBeUndefined();
    expect(waiting.steerWait?.reason).toMatch(/limit/i);
  });

  it('rearms one refused deadline, then leaves the reason without an expired time', async () => {
    const h = await waitingSteer(100);
    h.replay(h.uuid, h.card.text);
    vi.useFakeTimers();
    h.request.mockResolvedValue({ response: { cancelled: false } });
    await h.send('check again', true);
    const card = users(h.rt).at(-1)!;
    await vi.advanceTimersByTimeAsync(100);
    expect(card.steerWait?.autoAt).toBeGreaterThan(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(card.steerWait?.autoAt).toBeUndefined();
    expect(card.steerWait?.reason).toMatch(/withdrawal/);
  });
  it('targets the opening UUID and gives the second replacement a fresh deadline', async () => {
    const h = await waitingSteer();
    await h.send('one more', true);
    const last = users(h.rt).at(-1)!;
    const answer = h.now();
    await until(() => !!h.interrupt.mock.calls.length, 'scoped interrupt');
    h.result([h.first], true);
    expect(await answer).toEqual({ ok: true });
    expect(h.interrupt.mock.calls).toEqual([[[h.first]]]);
    expect(h.rt.get<UserItem>(last.id)?.steerWait?.autoAt).toBeGreaterThanOrEqual(last.ts + 30_000);
  });

  it('keeps an unconfirmed survivor manual until its matching cancellation arrives', async () => {
    const h = await waitingSteer();
    const c = await h.send('one more', true);
    const last = users(h.rt).at(-1)!;
    h.request.mockResolvedValueOnce({ response: { cancelled: true } }).mockResolvedValueOnce({ response: { cancelled: false } });
    h.interrupt.mockResolvedValueOnce({ response: { turn: 'stopped', still_queued: [c] } });
    const answer = h.now();
    await until(() => !!h.interrupt.mock.calls.length, 'scoped interrupt');
    h.result([h.first], true);
    await answer;
    expect(h.rt.queue.find(q => q.id === last.id)).toMatchObject({ byHand: true, issuedUuid: c });
    await h.app.call('queue.update', { sessionId: h.id, id: last.id, text: last.text, attachments: [] });
    expect(h.rt.queue.find(q => q.id === last.id)?.issuedUuid).toBe(c);
    expect(await h.app.call('queue.sendNow', { sessionId: h.id, id: last.id })).toEqual({ ok: false });
    expect(h.pushed).toHaveLength(4);
    h.message({ type: 'command_lifecycle', command_uuid: c, state: 'cancelled' });
    expect(h.rt.queue.find(q => q.id === last.id)?.issuedUuid).toBeUndefined();
  });

  it.each(['Stop', 'close'] as const)('aborts a silent recall on %s and releases its reservation', async action => {
    const h = await waitingSteer();
    h.request.mockImplementationOnce(() => new Promise(() => {}));
    const pending = h.now();
    const result = expect(pending).rejects.toThrow(/stopped|closed|changed/i);
    await until(() => !!h.request.mock.calls.length, 'recall request');
    if (action === 'Stop') await h.stop();
    else await h.rt.handle!.close();
    await result;
    expect((h.app as unknown as { steerEnds: WeakMap<SessionRuntime, unknown> }).steerEnds.has(h.rt)).toBe(false);
  });

  it('declines without touching a CLI that cannot target the old turn', async () => {
    const h = await waitingSteer();
    h.message({ type: 'system', subtype: 'init', claude_code_version: '1.0' });
    await expect(h.now()).rejects.toThrow(/target/);
    expect(h.card.steerWait?.reason).toMatch(/target/);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('drains the next message when a silent recall outlives the completed turn', async () => {
    const h = await waitingSteer();
    vi.useFakeTimers();
    h.request.mockImplementationOnce(() => new Promise(() => {}));
    const recall = h.now().catch(() => ({ ok: false }));
    await h.app.call('session.send', { sessionId: h.id, text: 'next message' });
    h.replay(h.uuid, h.card.text);
    h.result([h.first, h.uuid]);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await recall).toEqual({ ok: false });
    await vi.waitFor(() => expect(h.pushed).toHaveLength(3));
    expect(h.pushed.at(-1)!.message.content).toBe('next message');
  });

  it('releases a silent recall and shows its timeout on the card', async () => {
    const h = await waitingSteer();
    vi.useFakeTimers();
    h.request.mockImplementationOnce(() => new Promise(() => {}));
    const answer = h.now().catch(() => ({ ok: false }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.card.steerWait?.reason).toMatch(/timed out/i);
    expect(await answer).toEqual({ ok: false });
    expect(h.interrupt).not.toHaveBeenCalled();
  });

  it('keeps the issued UUID when an unmarked replay has identical personal words', async () => {
    const h = await claudeApp();
    const first = await h.send('begin');
    h.replay(first, 'begin');
    const uuid = await h.send('identical', true);
    const card = users(h.rt).at(-1)!;
    h.replay('other-app', 'identical');
    expect(card).toMatchObject({ state: 'queued', issuedUuid: uuid });
    h.replay(uuid, 'identical');
    expect(card).toMatchObject({ state: 'sent', providerId: uuid });
  });

  it('checkpoints an ordinary held phone send and refuses its release after unpairing', async () => {
    const h = await claudeApp();
    const first = await h.send('begin');
    h.result([first]);
    const session = h.rt.handle as unknown as Session;
    session.held = [];
    let paired = true;
    h.app.phoneStillPaired = () => paired;
    await h.app.call('session.send', { sessionId: h.id, text: 'keep these words', submitId: 'phone-held' }, {
      phoneSender: { deviceId: 'pair', generation: 2 }, allowed: () => true,
    });
    const saved = h.app.store.loadSession(h.id);
    expect(saved.items.find(i => i.id === 'phone-held')).toMatchObject({ state: 'queued', text: 'keep these words' });
    expect(h.pushed).toHaveLength(1);
    const cold = await claudeApp({ home: h.home, id: h.id });
    const snap = await cold.app.call('session.snapshot', { sessionId: h.id });
    expect(snap.queue.filter(q => q.id === 'phone-held')).toMatchObject([{ text: 'keep these words' }]);
    await cold.app.call('session.send', { sessionId: h.id, text: 'keep these words', submitId: 'phone-held' },
      { phoneSender: { deviceId: 'pair', generation: 2 }, allowed: () => true });
    expect(cold.pushed).toHaveLength(0);
    paired = false;
    await (session.release as () => Promise<void>)();
    expect(h.pushed).toHaveLength(1);
    expect(h.rt.queue.find(q => q.id === 'phone-held')?.text).toBe('keep these words');
  });

  it.each(['spare', 'race'])('checkpoints the %s input before acknowledging admission', async route => {
    const h = await claudeApp();
    const persist = h.rt.persistInput!;
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    h.rt.persistInput = async () => { await barrier; await persist(); };
    const host = (h.app as unknown as { races: { host: { send(rt: SessionRuntime, text: string): Promise<void> } } }).races.host;
    const input = route === 'spare' ? h.app.call('spare.send', { sessionId: h.id, text: 'durable work' }) : host.send(h.rt, 'durable work');
    let accepted = false;
    void input.then(() => { accepted = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(accepted).toBe(false);
    expect(h.pushed).toHaveLength(0);
    resume();
    await input;
    const snapshot = h.app.store.loadSession(h.id);
    expect([...snapshot.queue ?? [], ...snapshot.items].some(i => 'text' in i && i.text === 'durable work')).toBe(true);
    if (route === 'race') await until(() => h.pushed.length === 1, 'admitted race input went once');
  });


  it('retains an authored compact quotation through restore', async () => {
    const h = await claudeApp();
    const text = '<local-command-stdout>Compacted</local-command-stdout>';
    h.rt.loadRestored([{ type: 'notice', variant: 'compact', id: 'c', ts: 1, text: 'Conversation compacted' },
      { type: 'user', id: 'u', ts: 2, text, state: 'sent', authored: true }]);
    expect(h.rt.get('u')).toMatchObject({ text });
  });

  it('resumes the idle drain when a phone admission releases the unread hold', async () => {
    const h = await claudeApp();
    const first = await h.send('first');
    h.rt.unreadQueueHeld = true;
    h.app.phoneStillPaired = () => true;
    const persist = h.rt.persistInput!;
    let release!: () => void;
    let checkpoint = false;
    h.rt.persistInput = async () => {
      if (!checkpoint) {
        checkpoint = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      await persist();
    };
    const send = h.app.call('session.send', { sessionId: h.id, text: 'after admission', submitId: 'phone-a' },
      { phoneSender: { deviceId: 'pair', generation: 1 }, allowed: () => true });
    await until(() => checkpoint, 'phone admission');
    h.result([first]);
    expect(h.pushed).toHaveLength(1);
    release();
    await send;
    await until(() => h.pushed.length === 2, 'unread hold lifted');
  });

  it('drains a cancelled survivor when its replacement has already ended', async () => {
    const h = await claudeApp();
    const q = h.rt.enqueue('cancelled survivor');
    q.issuedUuid = 'old';
    q.byHand = true;
    h.rt.confirmDropped('old');
    await until(() => h.pushed.length === 1, 'cancelled survivor sent');
  });

  it('allows an explicit resend after the issuing process disappeared', async () => {
    const h = await claudeApp();
    const q = h.rt.enqueue('survivor');
    q.byHand = true;
    q.issuedUuid = 'old';
    q.issuedTo = { provider: 'claude', cwd: h.rt.meta.cwd, session: 'original-session', stillQueued: true };
    const lookup = vi.spyOn(h.app.providers.get('claude')!, 'steerReceipts').mockResolvedValueOnce([]);
    expect(await h.app.call('queue.sendNow', { sessionId: h.id, id: q.id })).toEqual({ ok: true });
    expect(lookup).toHaveBeenCalledWith('original-session', h.rt.meta.cwd, new Set(['old']));
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0].uuid).not.toBe('old');
  });

  it('drains waiting words when an idle Stop hold is explicitly released', async () => {
    const h = await claudeApp();
    h.rt.stopRequested = true;
    h.rt.enqueue('wait until resumed');
    h.rt.onQueueRunnable?.();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(h.pushed).toHaveLength(0);
    h.rt.stopRequested = false;
    await until(() => h.pushed.length === 1, 'explicit resume');
  });

  it('recovers an ordinary Claude receipt as an ordinary personal card', async () => {
    const h = await claudeApp();
    const uuid = await h.send('ordinary input');
    h.rt.returnUntaken({ all: true });
    const received = h.rt.confirmSteerReceipt(uuid);
    expect(received).toMatchObject({ state: 'sent', text: 'ordinary input', authored: true });
    expect(received?.steered).toBeFalsy();
  });


  it('finishes chat deletion and retries failed receipt cleanup', async () => {
    const h = await claudeApp();
    const receipts = (h.app as unknown as { phoneReceipts: { remove(id: string): void } }).phoneReceipts;
    const removed: string[] = [];
    h.app.subscribe(e => { if (e.type === 'session.removed') removed.push(e.id); });
    const cleanup = h.app as unknown as { lanes: { closed(rt: SessionRuntime): Promise<void> }; races: { closed(rt: SessionRuntime): void } };
    const lane = vi.spyOn(cleanup.lanes, 'closed');
    const rival = vi.spyOn(cleanup.races, 'closed');
    const remove = vi.spyOn(receipts, 'remove').mockImplementationOnce(() => { throw Error('SQLITE_BUSY'); });
    expect(await h.app.call('session.close', { sessionId: h.id, remove: true })).toEqual({ ok: true });
    expect(h.app.sessions.has(h.id)).toBe(false);
    expect(removed).toEqual([h.id]);
    expect(lane).toHaveBeenCalledWith(h.rt);
    expect(rival).toHaveBeenCalledWith(h.rt);
    await until(() => remove.mock.calls.length === 2, 'receipt cleanup retry');
  });

  it('rechecks the pairing of an accepted locally held steer after its socket closes', async () => {
    const h = await waitingSteer();
    const session = h.rt.handle as unknown as Session;
    session.held = [];
    let connected = true;
    h.app.phoneStillPaired = sender => sender.deviceId === 'pair' && sender.generation === 2;
    await h.app.call('session.send', { sessionId: h.id, text: 'after sleep', steer: true }, {
      phoneSender: { deviceId: 'pair', generation: 2 }, allowed: () => connected,
    });
    expect(h.pushed).toHaveLength(2);
    connected = false;
    await (session.release as () => Promise<void>)();
    expect(h.pushed).toHaveLength(3);
    expect(h.pushed[2].message.content).toContainEqual({ type: 'text', text: 'after sleep' });
  });

  it('restores a locally held replacement with its attachment after the interrupt fallback', async () => {
    const h = await waitingSteer();
    const session = h.rt.handle as unknown as Session;
    const picture = { id: 'pic', name: 'pic.png', kind: 'image' as const, dataUrl: 'data:image/png;base64,AAAA' };
    await h.app.call('session.send', { sessionId: h.id, text: 'see this', attachments: [picture], steer: true });
    const last = users(h.rt).at(-1)!;
    Object.defineProperty(session, 'namesMessages', { value: false });
    session.worksNow = () => true;
    const answer = h.now();
    await until(() => !!h.interrupt.mock.calls.length, 'scoped interrupt');
    await answer; // The old CLI never sends its result. Its background work keeps the query alive.
    expect(h.pushed).toHaveLength(3);
    await h.app.store.flush();
    const file = h.app.store.loadSession(h.id);
    for (const id of [h.card.id, last.id]) {
      expect(file.items.find(i => i.id === id)).toMatchObject({ state: 'queued' });
      expect((file.items.find(i => i.id === id) as UserItem).issuedUuid).toBeUndefined();
    }
    await h.app.dispose();
    const restored = new App({ home: h.app.store.dir, quiet: true, providers: [() => h.app.providers.get('claude')!] });
    cleanups.push(() => restored.dispose());
    const snap = await restored.call('session.snapshot', { sessionId: h.id });
    expect(snap.queue.map(q => q.id)).toEqual([h.card.id, last.id]);
    expect(snap.queue[1].attachments).toEqual([picture]);
  });

  it('reconciles a recovered steer with its native transcript UUID before retry', async () => {
    const h = await waitingSteer();
    await h.app.dispose();
    sdk.history.mockReset().mockResolvedValueOnce([{ type: 'user', uuid: h.uuid, message: { content: h.card.text } }]);
    const app = new App({ home: h.home, quiet: true, providers: [() => h.app.providers.get('claude')!] });
    cleanups.push(() => app.dispose());
    await app.call('session.snapshot', { sessionId: h.id });
    const rt = app.runtime(h.id);
    await until(() => rt.get<UserItem>(h.card.id)?.providerId === h.uuid, 'native steer receipt');
    expect(rt.queue.some(q => q.id === h.card.id)).toBe(false);
    expect(rt.get<UserItem>(h.card.id)).toMatchObject({ text: h.card.text, ts: h.card.ts, state: 'sent' });
    expect(h.pushed).toHaveLength(2);
  });

  it('carries the check origin through a deferred send and queue delivery', async () => {
    const h = await claudeApp();
    const app = h.app as unknown as { moving: Set<string>; deliver(rt: SessionRuntime, text: string, attachments: undefined, fields: { until: UserItem['until'] }): Promise<unknown> };
    const until = { check: { command: 'test', round: 1, rounds: 2, durationMs: 1, passed: false } };
    app.moving.add(h.id);
    await app.deliver(h.rt, 'check failed', undefined, { until });
    app.moving.delete(h.id);
    await h.app.call('queue.sendNow', { sessionId: h.id, id: h.rt.queue[0].id });
    expect(users(h.rt)[0].until).toEqual(until);
    expect(users(h.rt)[0].authored).toBeUndefined();
  });

  it('answers a phone submission once across a take and bridge restart', async () => {
    const h = await waitingSteer();
    const phoneSender = { deviceId: 'test-phone', generation: 3 };
    const args = { sessionId: h.id, text: 'only once', submitId: 'phone-test-id' };
    await h.app.call('session.send', args, { phoneSender });
    await h.app.call('queue.take', { sessionId: h.id, id: args.submitId });
    await h.app.dispose();
    const app = new App({ home: h.home, quiet: true, providers: [() => h.app.providers.get('claude')!] });
    cleanups.push(() => app.dispose());
    await app.call('session.snapshot', { sessionId: h.id });
    app.runtime(h.id).beginTurn();
    await app.call('session.send', args, { phoneSender });
    expect(app.runtime(h.id).queue.some(q => q.text === args.text)).toBe(false);
  });

  it('withdraws the staged phone input if its receipt cannot be committed', async () => {
    const h = await waitingSteer();
    const sender = { phoneSender: { deviceId: 'phone', generation: 1 } };
    const args = { sessionId: h.id, submitId: 'phone-failed-commit', text: 'one message' };
    const { phoneReceipts } = h.app as unknown as { phoneReceipts: { record(chat: string, submission: string): void } };
    vi.spyOn(phoneReceipts, 'record').mockImplementationOnce(() => { throw Error('disk full'); });
    await expect(h.app.call('session.send', args, sender)).rejects.toThrow('disk full');
    expect(h.rt.queue.some(q => q.id === args.submitId)).toBe(false);
    expect(h.app.store.loadSession(h.id).queue?.some(q => q.id === args.submitId)).toBe(false);
    await h.app.call('session.send', args, sender);
    expect(h.rt.queue.filter(q => q.id === args.submitId)).toHaveLength(1);
  });

  it("commits a queue edit while another chat's writer is blocked", async () => {
    const h = await waitingSteer();
    const files = (h.app.store as unknown as { sessionFiles: SessionFiles }).sessionFiles;
    const writer = files as unknown as { write: (...args: Parameters<SessionFiles['save']>) => Promise<void> };
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const original = writer.write.bind(writer);
    vi.spyOn(writer, 'write').mockImplementation((...args) => args[0] === 'other-chat' ? gate : original(...args));
    const sibling = files.save('other-chat', () => ({ items: [], todos: [], queue: [], dirty: 'all' }));
    const q = h.rt.enqueue('before');
    let committed = false;
    const edit = h.app.call('queue.update', { sessionId: h.id, id: q.id, text: 'after' }).then(() => { committed = true; });
    try {
      await until(() => committed, 'this edit without the other chat', 1500);
      expect(h.app.store.loadSession(h.id).queue?.[0].text).toBe('after');
    } finally {
      release();
      await Promise.all([sibling, edit]);
    }
  });

  it('commits queue order, edits and desktop takes before the reply', async () => {
    const h = await waitingSteer();
    const a = h.rt.enqueue('first'), b = h.rt.enqueue('second');
    await h.rt.persistInput!();
    const disk = () => h.app.store.loadSession(h.id).queue?.map(q => q.text);
    await h.app.call('queue.reorder', { sessionId: h.id, ids: [b.id] });
    expect(disk()).toEqual(['second', 'first']);
    await h.app.call('queue.update', { sessionId: h.id, id: b.id, text: 'edited' });
    expect(disk()).toEqual(['edited', 'first']);
    await h.app.call('queue.take', { sessionId: h.id, id: a.id });
    expect(disk()).toEqual(['edited']);
  });

  it('applies a late native receipt after Send now stops waiting', async () => {
    const h = await waitingSteer();
    h.rt.returnUntaken({ ids: new Set([h.card.id]) });
    let resolve!: (ids: string[]) => void;
    const history = new Promise<string[]>(done => { resolve = done; });
    h.app.provider('claude').steerReceipts = () => history;
    vi.useFakeTimers();
    const retry = h.app.call('queue.sendNow', { sessionId: h.id, id: h.card.id });
    await vi.advanceTimersByTimeAsync(3100);
    expect(await retry).toEqual({ ok: false });
    expect(h.pushed).toHaveLength(2);
    await h.app.call('queue.update', { sessionId: h.id, id: h.card.id, text: h.card.text, attachments: [] });
    resolve([h.uuid]);
    await vi.waitFor(() => expect(h.rt.get<UserItem>(h.card.id)?.providerId).toBe(h.uuid));
    expect(h.rt.queue).toHaveLength(0);
  });

  it('releases transient guards after take, discard, empty edit and reserved commit', async () => {
    const h = await waitingSteer();
    for (const action of ['take', 'remove', 'empty', 'commit']) {
      await h.app.call('session.send', { sessionId: h.id, text: 'held' }, { allowed: () => true });
      const id = h.rt.queue[0].id;
      expect(h.rt.transientQueueGuards.size).toBe(1);
      if (action === 'empty') await h.app.call('queue.update', { sessionId: h.id, id, text: '' });
      else if (action === 'commit') h.app.takeReserved(h.rt, id, h.rt.reserveQueued(id)!.rev);
      else await h.app.call(action === 'take' ? 'queue.take' : 'queue.remove', { sessionId: h.id, id });
      expect(h.rt.transientQueueGuards.size).toBe(0);
    }
  });

  it.each(['claude', 'codex'] as const)('looks up an edited steer on its issuing account after a move to %s', async provider => {
    const h = await waitingSteer();
    h.rt.returnUntaken({ ids: new Set([h.card.id]) });
    await h.app.call('queue.update', { sessionId: h.id, id: h.card.id, text: 'edited' });
    h.rt.update({ provider, providerSessionId: 'other', accountId: 'other' });
    await h.app.dispose();
    sdk.history.mockReset().mockResolvedValue([{ type: 'user', uuid: h.uuid, message: { content: h.card.text } }]);
    const app = new App({ home: h.home, quiet: true, providers: [() => h.app.providers.get('claude')!, ctx => new CodexProvider(ctx)] });
    cleanups.push(() => app.dispose());
    await app.call('session.snapshot', { sessionId: h.id });
    await until(() => app.runtime(h.id).items.some(row => row.type === 'user' && row.providerId === h.uuid), 'background steer receipt');
    const snap = await app.call('session.snapshot', { sessionId: h.id });
    expect(sdk.history).toHaveBeenCalledWith('cc1', expect.objectContaining({ dir: h.rt.meta.cwd }));
    expect(snap.items).toContainEqual(expect.objectContaining({ type: 'user', providerId: h.uuid, text: h.card.text }));
    expect(snap.queue).toMatchObject([{ text: 'edited', byHand: true }]);
    expect(snap.queue[0].issuedUuid).toBeUndefined();
  });

  it('keeps the card manual and explains an unavailable issuing account', async () => {
    const h = await waitingSteer();
    h.rt.returnUntaken({ ids: new Set([h.card.id]) });
    h.app.provider('claude').steerReceipts = async () => { throw Error('account unavailable'); };
    await (h.app as unknown as { restoreSteerReceipts: (rt: SessionRuntime) => Promise<void> }).restoreSteerReceipts(h.rt);
    expect(h.rt.queue[0]).toMatchObject({ byHand: true, issuedUuid: h.uuid, steerWait: { reason: expect.stringContaining('unavailable') } });
  });

  it('retires terminal cancellation evidence for a confirmed recall', async () => {
    const h = await waitingSteer();
    const sent = h.now();
    await until(() => !!h.interrupt.mock.calls.length, 'scoped interrupt');
    h.message({ type: 'command_lifecycle', state: 'cancelled', command_uuid: h.uuid });
    h.result([h.first], true);
    await sent;
    expect((h.rt.handle as unknown as { cancelledInputs: Set<string> }).cancelledInputs.has(h.uuid)).toBe(false);
  });

  it('commits the discard of an uncertain steer before acknowledging it', async () => {
    const h = await waitingSteer();
    await h.app.dispose();
    sdk.history.mockReset().mockResolvedValueOnce([]);
    const app = new App({ home: h.home, quiet: true, providers: [() => h.app.providers.get('claude')!] });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.snapshot', { sessionId: h.id });
    expect(snap.queue).toMatchObject([{ id: h.card.id, issuedUuid: h.uuid, byHand: true }]);
    await app.store.flush();
    expect(await app.call('queue.remove', { sessionId: h.id, id: h.card.id })).toEqual({ ok: true });
    expect(app.store.loadSession(h.id).queue?.some(q => q.id === h.card.id)).toBeFalsy();
  });

  it('keeps an issued steer uncertain when an older CLI sends unnamed results', async () => {
    const h = await claude();
    const opening = await h.send('begin');
    await h.replay(opening.uuid, 'begin');
    const next = await h.send('please answer first', [picture]);
    await h.message(result());
    await h.message(result());
    expect(h.rt.get<UserItem>(next.item.id)).toMatchObject({ state: 'queued', issuedUuid: next.uuid });
    await h.replay(next.uuid, next.content);
    expect(h.rt.get<UserItem>(next.item.id)).toMatchObject({ state: 'sent', providerId: next.uuid });
  });

  it('stores an issued UUID before accepting a steer and restores it for explicit retry', async () => {
    const h = await waitingSteer();
    const saved = h.app.store.loadSession(h.id);
    expect(saved.items.find(i => i.id === h.card.id)).toMatchObject({ state: 'queued', issuedUuid: h.uuid });
    const rt = new SessionRuntime({ ...h.rt.meta }, () => {}, () => {});
    rt.loadRestored(saved.items, saved.todos, saved.queue ?? []);
    rt.returnUntaken({ all: true, reason: 'closed' });
    expect(rt.queue).toMatchObject([{ id: h.card.id, text: h.card.text, byHand: true, issuedUuid: h.uuid }]);
  });
  it('recalls two steers, interrupts once and starts the person’s turn oldest first with a hidden note', async () => {
    const h = await waitingSteer();
    const later = await h.send('and the tests?', true);
    const last = users(h.rt).at(-1)!;
    const background = h.rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Other work', status: 'running', detail: {}, result: { agent: { background: 'running' } } });
    const answer = h.now(last.id);
    await until(() => h.interrupt.mock.calls.length === 1, 'the foreground interrupt');
    expect(await h.now()).toEqual({ ok: false });
    expect(h.request.mock.calls.map(([r]) => r.message_uuid)).toEqual([later, h.uuid]);
    h.result([h.first], true);
    expect(await answer).toEqual({ ok: true });
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.rt.get<ToolItem>(h.tool.id)?.status).toBe('cancelled');
    expect(h.rt.get<ToolItem>(background.id)?.status).toBe('running');
    expect(h.pushed).toHaveLength(5);
    for (const [i, card] of [h.card, last].entries()) {
      const send = h.pushed[3 + i];
      expect(send.message.content).toEqual([{ type: 'text', text: card.text }, { type: 'text', text: STEER_NOW_BLOCK }]);
      h.message({ type: 'user', isReplay: true, uuid: send.uuid, message: { content: send.message.content } });
    }
    expect(parseSynthetic(STEER_NOW_BLOCK)?.role).toBe('hidden');
    expect(stripWrappers('answer me\n' + STEER_NOW_BLOCK)).toBe('answer me');
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.get<UserItem>(h.card.id)).toMatchObject({ state: 'sent', ts: h.card.ts });
    expect(h.rt.get<UserItem>(h.card.id)?.steered).toBeUndefined();
    expect(users(h.rt).map(u => u.text)).toEqual(['do the work', 'answer me', 'and the tests?']);
    h.result(h.pushed.slice(3).map(m => m.uuid));
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue).toEqual([]);
  });

  it('leaves a steer already taken by the SDK alone, even if its replay arrives late', async () => {
    const h = await waitingSteer();
    h.request.mockResolvedValueOnce({ response: { cancelled: false } });
    expect(await h.now()).toEqual({ ok: false });
    h.replay(h.uuid, h.card.text);
    expect(await h.now()).toEqual({ ok: false });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.pushed).toHaveLength(2);
  });

  it('honors Stop after the old result and before the replacement reaches the SDK', async () => {
    const h = await waitingSteer();
    let release!: () => void;
    h.app.beforeFirstInput = () => new Promise(resolve => { release = resolve; });
    const answer = h.now();
    await until(() => h.interrupt.mock.calls.length === 1, 'interrupt');
    h.result([h.first], true);
    await until(() => !!release, 'replacement waiting for dispatch');
    await h.stop();
    release();
    await expect(answer).rejects.toThrow(/stopped/i);
    expect(h.pushed).toHaveLength(2);
    expect(h.rt.queue.map(q => q.id)).toEqual([h.card.id]);
    expect(h.rt.get(h.card.id)).toBeUndefined();
  });

  it('returns the unread replacement if the new process dies before its replay', async () => {
    const h = await claude({ live: true });
    const item = h.rt.add<UserItem>({ type: 'user', text: 'answer me', state: 'sent' });
    await h.session.send(item, { steerNow: true });
    h.proc().end(new Error('Process ended before replay'));
    await until(() => !h.rt.turnActive, 'process exit');
    expect(h.rt.get(item.id)).toBeUndefined();
    expect(h.rt.queue.map(q => [q.id, q.text])).toEqual([[item.id, item.text]]);
    expect(h.rt.unreadQueueHeld).toBe(true);
  });

  it('refuses before touching the SDK while a move, limit decision or switch is in progress', async () => {
    const h = await waitingSteer();
    const locks = h.app as unknown as { moving: Set<string>; switching: Set<string>; limitDecisions: Map<string, Set<string>> };
    locks.moving.add(h.id);
    await expect(h.now()).rejects.toThrow(/moving/);
    locks.moving.delete(h.id);
    locks.limitDecisions.set(h.id, new Set());
    await expect(h.now()).rejects.toThrow(/limit/);
    locks.limitDecisions.delete(h.id);
    locks.switching.add(h.id);
    await expect(h.now()).rejects.toThrow(/switching/);
    locks.switching.delete(h.id);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
  });

  it.each(['stop', 'unpair', 'send failure'])('keeps the message in the queue after %s', async cause => {
    const h = await waitingSteer();
    let paired = true;
    const answer = h.now(h.card.id, () => paired);
    await until(() => h.interrupt.mock.calls.length === 1, 'interrupt before competing action');
    if (cause === 'stop') await h.stop();
    if (cause === 'unpair') paired = false;
    if (cause === 'send failure') vi.spyOn(h.rt.handle!, 'send').mockRejectedValueOnce(new Error('failed'));
    h.result([h.first], true);
    await expect(answer).rejects.toThrow();
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.pushed).toHaveLength(2);
    expect(h.rt.queue.map(q => [q.id, q.text])).toEqual([[h.card.id, h.card.text]]);
    expect(h.rt.get(h.card.id)).toBeUndefined();
    expect(h.rt.turnActive).toBe(false);
  });
});

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
