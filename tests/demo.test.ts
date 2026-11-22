import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BridgeEvent,
  NoticeItem,
  QuestionRequest,
  TextItem,
  ToolItem,
  TurnItem,
  UserItem,
} from '@shared/protocol';
import { App } from '../server/app';
import type { SessionRuntime } from '../server/core/runtime';
import { DemoProvider } from '../server/providers/demo';

// ─────────────────────────────────── harness ────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const TERMINAL = new Set(['done', 'error', 'denied', 'cancelled']);

async function until(pred: () => boolean, what = 'condition', ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function setup(mode = 'bypassPermissions', extra: { resume?: string } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-demo-'));
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  const events: BridgeEvent[] = [];
  const listeners: ((e: BridgeEvent) => void)[] = [];
  app.subscribe((e) => {
    // Items are emitted by reference and mutated later; snapshot what was sent.
    events.push(structuredClone(e));
    for (const l of listeners) l(e);
  });
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode, ...extra });
  const id = snap.session.id;
  const rt: SessionRuntime = app.runtime(id);
  cleanups.push(async () => {
    await app.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const h = {
    app,
    events,
    id,
    rt,
    snap,
    on: (l: (e: BridgeEvent) => void) => listeners.push(l),
    send: (text: string) => app.call('session.send', { sessionId: id, text }),
    idle: () => until(() => !rt.turnActive && rt.meta.status !== 'running' && rt.meta.status !== 'awaiting', 'idle session'),
    items: () => rt.items,
    tools: () => rt.items.filter((i): i is ToolItem => i.type === 'tool'),
    texts: () => rt.items.filter((i): i is TextItem => i.type === 'text'),
    turns: () => rt.items.filter((i): i is TurnItem => i.type === 'turn'),
    notices: () => rt.items.filter((i): i is NoticeItem => i.type === 'notice'),
    permissions: () => events.flatMap((e) => (e.type === 'permission.added' ? [e.request] : [])),
    questions: () => events.flatMap((e) => (e.type === 'question.added' ? [e.request] : [])),
    respond: (requestId: string, optionId: string, message?: string) =>
      app.call('permission.respond', { sessionId: id, requestId, optionId, message }),
    /** Answer every permission prompt (and optionally questions) automatically. */
    autoApprove: (optionId = 'allow') =>
      listeners.push((e) => {
        if (e.type === 'permission.added') {
          const opt = e.request.options.find((o) => o.id === optionId) ?? e.request.options.find((o) => o.tone !== 'deny')!;
          setImmediate(() => void app.call('permission.respond', { sessionId: id, requestId: e.request.id, optionId: opt.id }));
        }
        if (e.type === 'question.added') {
          const answers = Object.fromEntries(e.request.questions.map((q) => [q.question, [q.options[0].label]]));
          setImmediate(() => void app.call('question.respond', { sessionId: id, requestId: e.request.id, answers }));
        }
      }),
  };
  return h;
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** Invariants every finished turn must satisfy. */
function expectSettled(h: Harness) {
  for (const item of h.items()) {
    if (item.type === 'text' || item.type === 'thinking') expect(item.streaming, `${item.type} ${item.id} still streaming`).toBe(false);
    if (item.type === 'tool') expect(TERMINAL.has(item.status), `${item.title} ended as ${item.status}`).toBe(true);
  }
  expect(h.rt.meta.status).toBe('idle');
  expect(h.rt.turnActive).toBe(false);
  expect(h.rt.snapshot().permissions).toHaveLength(0);
  expect(h.rt.snapshot().questions).toHaveLength(0);
}

/** Rebuilds every item from the event stream alone, exactly as the UI does. */
function rebuild(events: BridgeEvent[], sessionId: string): Map<string, Record<string, unknown>> {
  const items = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.type === 'timeline.reset' && e.sessionId === sessionId) {
      items.clear();
      for (const i of e.items) items.set(i.id, { ...i });
    } else if (e.type === 'item.added' && e.sessionId === sessionId) items.set(e.item.id, { ...e.item });
    else if (e.type === 'item.delta' && e.sessionId === sessionId) {
      const it = items.get(e.id)!;
      it[e.field] = ((it[e.field] as string | undefined) ?? '') + e.delta;
    } else if (e.type === 'item.patch' && e.sessionId === sessionId) Object.assign(items.get(e.id)!, e.patch);
    else if (e.type === 'item.removed' && e.sessionId === sessionId) items.delete(e.id);
  }
  return items;
}

function expectDeltasReconstruct(h: Harness) {
  const rebuilt = rebuild(h.events, h.id);
  expect([...rebuilt.keys()]).toEqual(h.items().map((i) => i.id));
  for (const item of h.items()) {
    const r = rebuilt.get(item.id)!;
    const live = item as unknown as Record<string, unknown>;
    for (const field of ['text', 'inputText', 'output'] as const) {
      expect(r[field], `${item.type}.${field} of ${item.id}`).toEqual(live[field]);
    }
    expect(r.status).toEqual(live.status);
    expect(r.streaming).toEqual(live.streaming);
  }
}

const REFACTOR = 'Refactor the session expiry logic out of the auth middleware';

// ─────────────────────────────────── provider ───────────────────────────────────

describe('DemoProvider catalog', () => {
  it('reports info, caps, limits and history', async () => {
    const p = new DemoProvider({ emit: () => {}, log: () => {} }, { speed: 0 });
    const info = await p.info();
    expect(info).toMatchObject({ id: 'demo', installed: true, auth: { loggedIn: true, email: 'demo@sable.local' } });

    const caps = await p.caps();
    expect(new Set(caps.models.map((m) => m.id)).size).toBe(4);
    expect(caps.models.filter((m) => m.isDefault)).toHaveLength(1);
    expect(caps.modes.map((m) => [m.id, m.tone])).toEqual([
      ['default', 'ask'],
      ['acceptEdits', 'edit'],
      ['plan', 'plan'],
      ['bypassPermissions', 'danger'],
    ]);
    expect(caps.commands.length).toBeGreaterThanOrEqual(8);
    expect(caps.skills.length).toBeGreaterThanOrEqual(6);
    expect(new Set(caps.mcpServers.map((s) => s.status)).size).toBeGreaterThan(1);
    expect(caps.agents).toHaveLength(3);
    expect(caps.skillTrigger).toBe('/');
    expect(caps.features).toEqual({ images: true, thinking: true, rewind: true, steer: true, compact: true, fast: true, browser: true, computerUse: true, remoteControl: true, ultracode: true });

    expect(await p.limits()).toHaveLength(2);
    const history = await p.history('/work/relay-api');
    expect(history.length).toBeGreaterThanOrEqual(5);
    expect(history.every((h) => h.provider === 'demo' && h.cwd === '/work/relay-api')).toBe(true);
  });

  it('defaults the model, sets a provider session id and grows context per turn', async () => {
    const h = await setup();
    expect(h.rt.meta.model).toBe('demo-large');
    expect(h.rt.meta.providerSessionId).toMatch(/^demo-/);
    expect(h.snap.caps?.models).toHaveLength(4);
    const before = await h.app.call('session.context', { sessionId: h.id });
    await h.send('hello');
    await h.idle();
    const after = await h.app.call('session.context', { sessionId: h.id });
    expect(after!.totalTokens).toBeGreaterThan(before!.totalTokens);
    expect(h.rt.meta.usage.turns).toBe(1);
  });

  it('loads a short transcript when resuming', async () => {
    const history = await new DemoProvider({ emit: () => {}, log: () => {} }).history();
    const h = await setup('default', { resume: history[1].providerSessionId });
    expect(h.rt.meta.providerSessionId).toBe(history[1].providerSessionId);
    const types = h.snap.items.map((i) => i.type);
    expect(types).toEqual(['user', 'tool', 'text', 'turn', 'notice']);
  });
});

// ─────────────────────────────────── flagship ───────────────────────────────────

describe('flagship scenario', () => {
  it('streams thinking, tools, text and a turn in a sane order', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    await h.idle();
    expectSettled(h);

    const items = h.items();
    const types = items.map((i) => i.type);
    expect(types[0]).toBe('user');
    expect(types[1]).toBe('thinking');
    expect(types.at(-1)).toBe('turn');
    const lastTool = types.lastIndexOf('tool');
    const lastText = types.lastIndexOf('text');
    expect(lastTool).toBeGreaterThan(1);
    expect(lastText).toBeGreaterThan(lastTool);

    const tools = h.tools();
    const kinds = new Set(tools.map((t) => t.kind));
    for (const k of ['glob', 'search', 'read', 'todo', 'edit', 'bash']) expect(kinds.has(k as never), k).toBe(true);

    const edits = tools.filter((t) => t.kind === 'edit');
    expect(edits.length).toBe(3);
    for (const e of edits) {
      expect(e.status).toBe('done');
      const diff = e.result!.diff![0];
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.deletions).toBeGreaterThan(0);
      expect(diff.hunks.length).toBeGreaterThan(0);
      expect(e.inputText).toBe(JSON.stringify(e.input));
    }
    expect(edits[0].result!.diff![0].hunks.length).toBeGreaterThan(1);

    const runs = tools.filter((t) => t.kind === 'bash');
    expect(runs.map((r) => r.result?.exitCode)).toEqual([1, 0]);
    expect(runs[0].status).toBe('error');
    expect(runs[0].output).toContain('invalid_session');
    expect(runs[1].status).toBe('done');

    expect(h.rt.todos.length).toBe(4);
    expect(h.rt.todos.every((t) => t.status === 'completed')).toBe(true);

    const turn = h.turns()[0];
    expect(turn.outputTokens).toBeGreaterThan(0);
    expect(turn.costUsd).toBeGreaterThan(0);
    expect(h.rt.meta.usage.outputTokens).toBeGreaterThan(0);
    expect(h.rt.meta.usage.contextTokens).toBeGreaterThan(20_000);
    expect(h.rt.suggestion).toBeTruthy();
    // The closing summary leads with the outcome and stays short (see CONCISE_REPLIES_PROMPT).
    expect(h.texts().at(-1)!.text).toMatch(/^Expiry now lives in/);
    expect(h.texts().at(-1)!.text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
  });

  it('item.delta events concatenate exactly to the final items', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    await h.idle();
    expect(h.events.filter((e) => e.type === 'item.delta').length).toBeGreaterThan(100);
    for (const item of h.items()) {
      if (item.type === 'text' || item.type === 'thinking') {
        const added = h.events.find((e) => e.type === 'item.added' && e.item.id === item.id) as { item: TextItem };
        expect(added.item.text).toBe('');
        const joined = h.events
          .filter((e): e is Extract<BridgeEvent, { type: 'item.delta' }> => e.type === 'item.delta' && e.id === item.id && e.field === 'text')
          .map((e) => e.delta)
          .join('');
        expect(joined).toBe(item.text);
      }
    }
    expectDeltasReconstruct(h);
  });
});

// ────────────────────────────────── permissions ─────────────────────────────────

describe('permissions', () => {
  it('waits for approval in default mode; deny marks the tool denied and the agent reacts', async () => {
    const h = await setup('default');
    await h.send(REFACTOR);
    await until(() => h.permissions().length === 1, 'first permission');
    const req = h.permissions()[0];
    expect(req.kind).toBe('edit');
    expect(req.diff?.[0].additions).toBeGreaterThan(0);
    expect(req.options.map((o) => o.tone)).toEqual(['allow', 'always', 'deny']);
    expect(req.allowFeedback).toBe(true);

    const gated = h.rt.get<ToolItem>(req.itemId!)!;
    expect(gated.status).toBe('awaiting');
    expect(h.rt.meta.status).toBe('awaiting');
    const count = h.items().length;
    await tick();
    expect(h.items().length).toBe(count);

    await h.respond(req.id, 'allow');
    await until(() => h.permissions().length === 2, 'second permission');
    expect(h.rt.get<ToolItem>(req.itemId!)!.status).toBe('done');
    const second = h.permissions()[1];
    await h.respond(second.id, 'deny', 'Keep requireAuth as it is for now');
    await h.idle();
    expectSettled(h);

    expect(h.rt.get<ToolItem>(second.itemId!)!.status).toBe('denied');
    expect(h.texts().at(-1)!.text).toContain('Keep requireAuth as it is for now');
    expect(h.items().at(-1)!.type).toBe('turn');
    expect(h.tools().some((t) => t.kind === 'bash')).toBe(false);
  });

  it('remembers "always" for the rest of the session', async () => {
    const h = await setup('default');
    h.autoApprove('always');
    await h.send(REFACTOR);
    await h.idle();
    expectSettled(h);
    // One prompt for edits and one for `npm test`; the later edits and test run do not ask again.
    expect(h.permissions().map((p) => p.kind)).toEqual(['edit', 'bash']);
    expect(h.tools().filter((t) => t.kind === 'edit')).toHaveLength(3);
  });

  it('acceptEdits only asks for shell commands; bypass never asks', async () => {
    const a = await setup('acceptEdits');
    a.autoApprove('allow');
    await a.send(REFACTOR);
    await a.idle();
    expect(a.permissions().map((p) => p.kind)).toEqual(['bash', 'bash']);

    const b = await setup('bypassPermissions');
    await b.send(REFACTOR);
    await b.idle();
    expect(b.permissions()).toHaveLength(0);
  });
});

// ───────────────────────────────────── plan ─────────────────────────────────────

describe('plan mode', () => {
  it('presents a plan and switches mode on approval', async () => {
    const h = await setup('plan');
    await h.send('Add rate limiting to the login route');
    await until(() => h.permissions().length === 1, 'plan approval');
    const req = h.permissions()[0];
    expect(req.kind).toBe('plan');
    const planTool = h.rt.get<ToolItem>(req.itemId!)!;
    expect(planTool.kind).toBe('plan');
    expect(planTool.detail.plan).toContain('## Plan');
    expect(h.tools().every((t) => ['read', 'search', 'glob', 'plan'].includes(t.kind))).toBe(true);

    h.autoApprove('allow');
    await h.respond(req.id, 'approve-accept-edits');
    await h.idle();
    expectSettled(h);

    expect(h.rt.meta.mode).toBe('acceptEdits');
    expect(h.notices().some((n) => n.variant === 'mode')).toBe(true);
    const writes = h.tools().filter((t) => t.kind === 'write');
    expect(writes).toHaveLength(2);
    expect(writes[0].result!.diff![0].status).toBe('added');
    // In acceptEdits only the test run asked.
    expect(h.permissions().map((p) => p.kind)).toEqual(['plan', 'bash']);
  });

  it('keeps planning when asked, using the feedback', async () => {
    const h = await setup('plan');
    await h.send('Plan the session expiry refactor');
    await until(() => h.permissions().length === 1, 'plan approval');
    const req = h.permissions()[0];
    await h.respond(req.id, 'keep-planning', 'Leave get() public for now');
    await h.idle();
    expectSettled(h);
    expect(h.rt.meta.mode).toBe('plan');
    expect(h.rt.get<ToolItem>(req.itemId!)!.status).toBe('denied');
    expect(h.texts().at(-1)!.text).toContain('Leave get() public for now');
    expect(h.tools().some((t) => t.kind === 'edit')).toBe(false);
  });
});

// ─────────────────────────────────── questions ──────────────────────────────────

describe('questions', () => {
  async function ask(h: Harness): Promise<QuestionRequest> {
    await h.send('Ask me which logger to use before adding request logging');
    await until(() => h.questions().length === 1, 'question');
    return h.questions()[0];
  }

  it('proceeds according to the answers', async () => {
    const h = await setup();
    const req = await ask(h);
    expect(req.questions).toHaveLength(2);
    expect(req.questions[0].options).toHaveLength(3);
    expect(req.questions[0].options.every((o) => o.description)).toBe(true);
    expect(req.questions[1].multiSelect).toBe(true);
    const tool = h.rt.get<ToolItem>(req.itemId!)!;
    expect(tool.kind).toBe('question');
    expect(tool.status).toBe('awaiting');

    const answers = { [req.questions[0].question]: ['console + JSON'], [req.questions[1].question]: ['Request ID', 'Latency'] };
    await h.app.call('question.respond', { sessionId: h.id, requestId: req.id, answers });
    await h.idle();
    expectSettled(h);

    expect(tool.status).toBe('done');
    expect(tool.result?.answers).toEqual(answers);
    const writes = h.tools().filter((t) => t.kind === 'write');
    expect(writes.map((w) => w.detail.path?.replace(/\\/g, '/').split('relay-api/')[1])).toEqual(['src/lib/logger.ts', 'src/server/request-log.ts']);
    const reqLog = writes[1].detail.content!;
    expect(reqLog).toContain('requestId');
    expect(reqLog).toContain('durationMs');
    expect(reqLog).not.toContain('userId');
    expect(h.tools().some((t) => t.detail.command?.startsWith('npm install'))).toBe(false);
  });

  it('waits when the questions are dismissed', async () => {
    const h = await setup();
    const req = await ask(h);
    await h.app.call('question.respond', { sessionId: h.id, requestId: req.id, answers: null });
    await h.idle();
    expectSettled(h);
    expect(h.rt.get<ToolItem>(req.itemId!)!.status).toBe('cancelled');
    expect(h.texts().at(-1)!.text).toMatch(/wait/i);
    expect(h.tools().some((t) => t.kind === 'write')).toBe(false);
  });
});

// ─────────────────────────────────── sub-agents ─────────────────────────────────

describe('sub-agents', () => {
  it('nests interleaved child items under agent tools', async () => {
    const h = await setup();
    await h.send('Research how auth failures are handled, using parallel agents');
    await h.idle();
    expectSettled(h);

    const items = h.items();
    const agents = h.tools().filter((t) => t.kind === 'agent');
    expect(agents).toHaveLength(2);
    for (const a of agents) {
      expect(a.detail.subagent).toBe('Explore');
      expect(a.detail.description).toBeTruthy();
      expect(a.detail.prompt).toBeTruthy();
      expect(a.status).toBe('done');
      expect(a.result?.text).toBeTruthy();
    }
    const children = items.filter((i) => i.parentId);
    expect(children.length).toBeGreaterThan(6);
    const agentIds = new Set(agents.map((a) => a.id));
    for (const c of children) {
      expect(agentIds.has(c.parentId!)).toBe(true);
      expect(items.findIndex((i) => i.id === c.parentId)).toBeLessThan(items.indexOf(c));
    }
    // Interleaved: the two agents' child ranges overlap.
    const range = (id: string) => {
      const idx = items.flatMap((i, n) => (i.parentId === id ? [n] : []));
      return [Math.min(...idx), Math.max(...idx)];
    };
    const [a0, a1] = range(agents[0].id);
    const [b0, b1] = range(agents[1].id);
    expect(a0 < b1 && b0 < a1).toBe(true);
    for (const a of agents) expect(items.some((i) => i.parentId === a.id && i.type === 'text')).toBe(true);

    const final = h.texts().at(-1)!;
    expect(final.parentId).toBeUndefined();
    expect(final.text).toContain('| # |');
    expectDeltasReconstruct(h);
  });
});

// ─────────────────────────────────── interrupt ──────────────────────────────────

describe('interrupt', () => {
  it('stops a streaming turn promptly and settles everything', async () => {
    const h = await setup();
    let fired = false;
    h.on((e) => {
      if (!fired && e.type === 'item.delta' && e.field === 'output') {
        fired = true;
        void h.app.call('session.interrupt', { sessionId: h.id });
      }
    });
    await h.send(REFACTOR);
    await h.idle();
    expect(fired).toBe(true);
    expectSettled(h);
    expect(h.notices().some((n) => n.variant === 'interrupted')).toBe(true);
    expect(h.tools().some((t) => t.status === 'cancelled')).toBe(true);

    const count = h.items().length;
    await tick(40);
    expect(h.items().length).toBe(count);
    expectDeltasReconstruct(h);
  });

  it('cancels a pending permission prompt', async () => {
    const h = await setup('default');
    await h.send(REFACTOR);
    await until(() => h.permissions().length === 1, 'permission');
    const req = h.permissions()[0];
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
    expectSettled(h);
    expect(h.events.some((e) => e.type === 'permission.removed' && e.id === req.id)).toBe(true);
    expect(h.rt.get<ToolItem>(req.itemId!)!.status).toBe('cancelled');

    // The session keeps working afterwards.
    await h.send('hi');
    await h.idle();
    expect(h.texts().at(-1)!.text).toMatch(/^Hi,/);
  });
});

// ──────────────────────────────────── queueing ──────────────────────────────────

describe('queueing', () => {
  const users = (h: Awaited<ReturnType<typeof setup>>) => h.items().filter((i): i is UserItem => i.type === 'user');
  const addedAt = (h: Awaited<ReturnType<typeof setup>>, pred: (e: BridgeEvent) => boolean) => h.events.findIndex(pred);

  it('holds a message sent during a turn on the bridge and sends it when the turn ends', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    await h.send('hi');
    // Not in the timeline yet: the bridge holds it.
    expect(users(h).map((u) => u.text)).toEqual([REFACTOR]);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['hi']);
    const upd = h.events.filter((e) => e.type === 'queue.updated');
    expect(upd.at(-1)).toMatchObject({ type: 'queue.updated', sessionId: h.id, queue: [{ text: 'hi' }] });

    await until(() => h.turns().length === 2, 'two turns');
    await h.idle();
    expectSettled(h);
    expect(h.rt.queue).toEqual([]);

    const second = users(h).find((u) => u.text === 'hi')!;
    expect(second.state).toBe('sent');
    const firstTurnAt = addedAt(h, (e) => e.type === 'item.added' && e.item.type === 'turn');
    const sentAt = addedAt(h, (e) => e.type === 'item.added' && e.item.id === second.id);
    expect(sentAt).toBeGreaterThan(firstTurnAt);
    expect(h.texts().at(-1)!.text).toMatch(/^Hi,/);
  });

  it('sends queued messages in order, one per turn end', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    await h.send('hi');
    await h.send('hi again');
    expect(h.rt.queue.map((q) => q.text)).toEqual(['hi', 'hi again']);

    await until(() => h.turns().length === 3, 'three turns', 8000);
    await h.idle();
    expect(users(h).map((u) => u.text)).toEqual([REFACTOR, 'hi', 'hi again']);
    // Each queued message enters the timeline only after the previous turn closed.
    const turnIds = h.turns().map((t) => t.id);
    const at = (id: string) => addedAt(h, (e) => e.type === 'item.added' && e.item.id === id);
    const [, u2, u3] = users(h);
    expect(at(u2.id)).toBeGreaterThan(at(turnIds[0]));
    expect(at(u3.id)).toBeGreaterThan(at(turnIds[1]));
    expect(at(u3.id)).toBeLessThan(at(turnIds[2]));
  });

  it('sends nothing automatically after an interrupt', async () => {
    const h = await setup('default');
    await h.send(REFACTOR);
    await until(() => h.permissions().length === 1, 'permission');
    await h.send('hi');
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
    await tick(60);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['hi']);
    expect(users(h).map((u) => u.text)).toEqual([REFACTOR]);

    // A new message goes straight out; the queue follows once that turn ends normally.
    await h.send('hello');
    await until(() => users(h).length === 3, 'queued message after the next turn');
    await h.idle();
    expect(users(h).map((u) => u.text)).toEqual([REFACTOR, 'hello', 'hi']);
  });

  it('updates, removes and sends a queued message now', async () => {
    const h = await setup('default');
    await h.send(REFACTOR);
    await until(() => h.permissions().length === 1, 'permission');
    await h.send('first');
    await h.send('second');
    const [a, b] = h.rt.queue;

    // The answer carries the message as the edit found it (review wave 10, #8).
    expect(await h.app.call('queue.update', { sessionId: h.id, id: a.id, text: 'hi there' })).toMatchObject({ ok: true, previous: { id: a.id, text: 'first' } });
    expect(h.rt.queue[0].text).toBe('hi there');
    expect(await h.app.call('queue.remove', { sessionId: h.id, id: b.id })).toEqual({ ok: true });
    expect(h.rt.queue.map((q) => q.id)).toEqual([a.id]);
    expect(await h.app.call('queue.remove', { sessionId: h.id, id: 'nope' })).toEqual({ ok: false });

    // Send now: out of the queue, steered into the running turn (taken at the agent's next step).
    expect(await h.app.call('queue.sendNow', { sessionId: h.id, id: a.id })).toEqual({ ok: true });
    expect(h.rt.queue).toEqual([]);
    const now = users(h).find((u) => u.text === 'hi there')!;
    expect(now).toMatchObject({ state: 'queued', steered: true });

    h.autoApprove();
    await h.respond(h.permissions()[0].id, 'allow');
    await h.idle();
    expect(h.turns()).toHaveLength(1);
    expect(h.rt.get<UserItem>(now.id)!.state).toBe('sent');
  });

  it('keeps the queue across an App restart without sending it', async () => {
    const h = await setup('default');
    await h.send(REFACTOR);
    await until(() => h.permissions().length === 1, 'permission');
    await h.send('kept for later');
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
    const home = h.app.store.dir;
    await h.app.dispose();

    const app2 = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    cleanups.push(() => app2.dispose());
    const snap = await app2.call('session.snapshot', { sessionId: h.id });
    expect(snap.queue.map((q) => q.text)).toEqual(['kept for later']);
    expect(snap.items.some((i) => i.type === 'user' && i.text === 'kept for later')).toBe(false);
    await app2.call('queue.remove', { sessionId: h.id, id: snap.queue[0].id });
    expect(app2.runtime(h.id).queue).toEqual([]);
  });
});

// ─────────────────────────────────── scenarios ──────────────────────────────────

describe('other scenarios', () => {
  it('every scenario settles and reconstructs from deltas', async () => {
    const h = await setup();
    h.autoApprove();
    const prompts = [
      'Search the docs for how to shut down the server gracefully',
      'Write a markdown showcase of the auth architecture',
      'Use the GitHub MCP to find open session issues',
      'Run the migrations and handle any error',
      '/review',
      '/init',
      '/pr-comments',
      '/deploy-check',
      '/changelog',
    ];
    for (const p of prompts) {
      const before = h.turns().length;
      await h.send(p);
      await h.idle();
      expectSettled(h);
      expect(h.turns().length, p).toBe(before + 1);
    }
    const kinds = new Set(h.tools().map((t) => t.kind));
    for (const k of ['websearch', 'fetch', 'mcp', 'skill', 'bash', 'write', 'read', 'todo']) expect(kinds.has(k as never), k).toBe(true);
    const ws = h.tools().find((t) => t.kind === 'websearch')!;
    expect(ws.result?.links?.length).toBeGreaterThan(3);
    const mcp = h.tools().find((t) => t.kind === 'mcp')!;
    expect(mcp.detail.server).toBe('github');
    expect(mcp.detail.tool).toBe('search_issues');
    expect(h.texts().some((t) => /\]\(https:\/\/nodejs\.org/.test(t.text))).toBe(true);
    const md = h.texts().find((t) => t.text.startsWith('# How authentication works'))!.text;
    for (const fence of ['```ts', '```bash', '```json', '```diff', '```python']) expect(md).toContain(fence);
    expect(md).toContain('| Code |');
    expect(md).toContain('\n> ');
    expect(md).toContain('\n---\n');
    expectDeltasReconstruct(h);
  });

  it('error scenario retries, recovers from a failing tool and ends cleanly', async () => {
    const h = await setup();
    await h.send('Run the migrations, there was an error earlier');
    await h.idle();
    expectSettled(h);
    expect(h.notices().some((n) => n.variant === 'retry')).toBe(true);
    const failed = h.tools().find((t) => t.status === 'error')!;
    expect(failed.result?.isError).toBe(true);
    expect(failed.result?.stderr).toContain('ECONNREFUSED');
    expect(h.turns()[0].error).toBeUndefined();
  });

  it('"fail hard" ends the turn with an error, and the session recovers', async () => {
    const h = await setup();
    await h.send('error: fail hard');
    await until(() => !h.rt.turnActive, 'turn end');
    expect(h.rt.meta.status).toBe('error');
    expect(h.rt.meta.lastError).toContain('529');
    expect(h.turns()[0].error).toContain('overloaded');
    await h.send('hello');
    await h.idle();
    expect(h.rt.meta.status).toBe('idle');
  });

  it('greetings get a short reply without tools', async () => {
    const h = await setup();
    await h.send('hey');
    await h.idle();
    expect(h.tools()).toHaveLength(0);
    expect(h.items().map((i) => i.type)).toEqual(['user', 'text', 'turn']);
    expect(h.texts()[0].text.split(/(?<=[.?!])\s/).length).toBe(2);
  });

  it('long answers exceed 2500 words', async () => {
    const h = await setup();
    await h.send('Give me a long stress-test answer');
    await h.idle();
    const words = h.texts().at(-1)!.text.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(2500);
  });

  it('hands over real files with sizes and a caption, never into the project', async () => {
    const h = await setup();
    await h.send('share the audit with me');
    await h.idle();
    expectSettled(h);
    const share = h.tools().find((t) => t.kind === 'share')!;
    expect(share.name).toBe('SendUserFile');
    expect(share.status).toBe('done');
    expect(share.detail.caption).toBeTruthy();
    const files = share.detail.files!;
    expect(files.map((f) => f.name)).toEqual(['auth-audit.pdf', 'latency-by-route.csv']);
    for (const f of files) {
      expect(existsSync(f.path), f.path).toBe(true);
      expect(statSync(f.path).size).toBe(f.size);
      expect(path.relative(h.rt.meta.cwd, f.path).startsWith('..')).toBe(true);
      cleanups.push(async () => rmSync(path.dirname(path.dirname(f.path)), { recursive: true, force: true }));
    }
    expect(readFileSync(files[0].path, 'latin1')).toMatch(/^%PDF-1\.4[\s\S]*%%EOF\n$/);
    // The answer comes after the cards.
    expect(h.items().at(-2)?.type).toBe('text');
  });

  it('rotates through scenarios for generic prompts', async () => {
    const h = await setup();
    await h.send('Take a look at this project');
    await h.idle();
    await h.send('Take a look at this project');
    await h.idle();
    const turnIdx = h.items().findIndex((i) => i.type === 'turn');
    const first = h.items().slice(0, turnIdx).filter((i): i is ToolItem => i.type === 'tool');
    const second = h.items().slice(turnIdx).filter((i): i is ToolItem => i.type === 'tool');
    expect(first.some((t) => t.kind === 'edit')).toBe(true);
    expect(second.some((t) => t.kind === 'agent')).toBe(true);
  });
});

// ──────────────────────────────────── commands ──────────────────────────────────

describe('slash commands', () => {
  it('handles /compact, /context, /cost and unknown commands', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    await h.idle();
    const before = h.rt.meta.usage.contextTokens!;

    await h.send('/compact');
    await h.idle();
    const compact = h.notices().find((n) => n.variant === 'compact')!;
    expect(compact.text).toBe('Conversation compacted');
    expect(compact.detail).toMatch(/→/);
    expect(h.rt.meta.usage.contextTokens!).toBeLessThan(before);

    await h.send('/context');
    await h.idle();
    await h.send('/cost');
    await h.idle();
    const reports = h.notices().filter((n) => n.variant === 'command');
    expect(reports.map((n) => n.text)).toEqual(['Context usage', 'Session cost']);
    expect(reports.every((n) => n.detail?.includes('|'))).toBe(true);

    await h.send('/foo');
    await h.idle();
    expect(h.notices().at(-1)).toMatchObject({ variant: 'error', text: 'Unknown command: /foo' });

    // Built-in reports are not model turns.
    expect(h.turns()).toHaveLength(1);
    expectSettled(h);
  });
});

