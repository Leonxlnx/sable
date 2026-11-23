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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, STEER_FIRST_BLOCK, type NoticeItem, type SessionMeta, type TextItem, type TimelineItem, type TurnItem, type UserItem } from '@shared/protocol';
import { HANDOVER_HEAD_ACCOUNT, HANDOVER_JOIN, HANDOVER_TAIL } from '@shared/synthetic';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import { appPictures, ownReplays, plainWords } from '../server/providers/claude-tools';
import type { ProviderSession } from '../server/providers/types';

/** A fake SDK `query`: a stream a test writes to (`out`) and ends (`end`), ended too by `close()`. */
const sdk = vi.hoisted(() => {
  type Proc = { pushed: unknown[]; out(m: unknown): void; end(err?: Error): void; q: Record<string | symbol, unknown> };
  const procs: Proc[] = [];
  function fakeQuery(p: { prompt: AsyncIterable<unknown> }) {
    const buf: unknown[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const proc: Proc = {
      pushed: [],
      out(m) {
        buf.push(m);
        wake?.();
      },
      end() {
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
            if (done) return;
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
  return { procs, fakeQuery };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), query: (p: { prompt: AsyncIterable<unknown> }) => sdk.fakeQuery(p) }));

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
async function claude(opts: { live?: boolean; meta?: Partial<SessionMeta> } = {}) {
  const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
  const anyP = p as unknown as Obj;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
  anyP.readLimits = async () => [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...opts.meta };
  const rt = new SessionRuntime(meta, () => {}, () => {});
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

  it('a result naming the message before its replay: the replay is the same card, which stands where the agent took it and whose own result ends its turn', async () => {
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
    // It stands where the agent took it: under the line that came first, with its work under it.
    expect(at(h.rt, a.item.id)).toBeGreaterThan(at(h.rt, first.id));
    expect(h.rt.turnActive).toBe(true);
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
    // An older CLI's way of reading a result: it answers the oldest message.
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

describe('a message that never comes back', () => {
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
  const wake = (h: Awaited<ReturnType<typeof claude>>) =>
    h.replay('note-1', '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "Read" completed</summary>\n</task-notification>', { isSynthetic: true });

  it('is not reused by a turn the agent wakes for that is refused: that turn gets a card of its own', async () => {
    const h = await claude();
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit', provider: 'claude', accountId: 'default' } });
    h.rt.limitCard = card.id;
    await wake(h);
    expect(h.rt.turnActive).toBe(true);
    await h.message(refused);
    expect(cards(h.rt)).toHaveLength(2);
    expect(cards(h.rt)[1].limit?.provider).toBeUndefined();
  });

  it('one not decided yet is that turn\'s too', async () => {
    const h = await claude();
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit' } });
    h.rt.limitCard = card.id;
    await wake(h);
    await h.message(refused);
    expect(cards(h.rt)).toHaveLength(1);
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
  return { app, id, rt, pushed, send, replay, result, stop: () => app.call('session.interrupt', { sessionId: id }) };
}

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
