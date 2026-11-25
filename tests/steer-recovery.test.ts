/**
 * A steered message is never lost and never left "Steered, not taken yet" after its turn: when the
 * agent cannot take it in this turn it goes back to the queue with a quiet note, or runs as the next
 * turn, and it is never sent twice. Demo agent, a fake Codex app-server and a fake Claude Code
 * stream: no real agent turns.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type NoticeItem, type SessionMeta, type UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderSession } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function until(pred: () => boolean, what: string, ms = 6000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const tempHome = (tag: string) => {
  const home = mkdtempSync(path.join(tmpdir(), `sable-${tag}-`));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const users = (rt: SessionRuntime) => rt.items.filter((i): i is UserItem => i.type === 'user');
const notes = (rt: SessionRuntime) => rt.items.filter((i): i is NoticeItem => i.type === 'notice' && i.variant === 'info');

// ───────────────────────────────────── Demo ─────────────────────────────────────

async function demo(mode = 'default') {
  const home = tempHome('steer-demo');
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode });
  const id = snap.session.id;
  return { app, home, id, rt: app.runtime(id), send: (text: string, steer?: boolean) => app.call('session.send', { sessionId: id, text, steer }) };
}

describe('steering with the Demo agent', () => {
  it('a turn that fails with a steer not taken: the steer goes back to the queue with a note and is not sent as well', async () => {
    const h = await demo();
    await h.send('Refactor the session expiry logic out of the auth middleware');
    await until(() => h.rt.snapshot().permissions.length === 1, 'permission');
    await h.send('use pnpm, not npm', true);
    const steer = users(h.rt).find((u) => u.text === 'use pnpm, not npm')!;
    expect(steer).toMatchObject({ steered: true, state: 'queued' });

    // The turn fails while the steer still waits for the agent's next step.
    const s = h.rt.handle as unknown as { current?: AbortController; complete(c: AbortController, e?: string): void };
    const ctrl = s.current!;
    ctrl.abort();
    s.complete(ctrl, 'boom');
    await tick(40);

    expect(h.rt.turnActive).toBe(false);
    expect(users(h.rt).map((u) => u.text)).toEqual(['Refactor the session expiry logic out of the auth middleware']);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['use pnpm, not npm']);
    expect(notes(h.rt).at(-1)).toMatchObject({ text: 'Your message is back in the queue', detail: 'The turn failed before the agent took it.' });
  });

  it('a stop before the agent takes a steer puts it back in the queue with a note', async () => {
    const h = await demo();
    await h.send('Refactor the session expiry logic out of the auth middleware');
    await until(() => h.rt.snapshot().permissions.length === 1, 'permission');
    await h.send('one', true);
    await h.send('two', true);
    await h.app.call('session.interrupt', { sessionId: h.id });
    await until(() => !h.rt.turnActive, 'stopped');
    await tick();
    expect(h.rt.queue.map((q) => q.text)).toEqual(['one', 'two']);
    expect(notes(h.rt).at(-1)).toMatchObject({ text: '2 messages are back in the queue', detail: 'The turn stopped before the agent took them.' });
    expect(users(h.rt).some((u) => u.state === 'queued')).toBe(false);
  });

  it('a steer still waiting when Sable closed goes back to the queue on the next start, not stuck in the timeline', async () => {
    const h = await demo('bypassPermissions');
    await h.send('hi');
    await until(() => !h.rt.turnActive && h.rt.meta.status === 'idle', 'idle');
    // The bridge's own look after the turn (it would send a waiting steer) is done.
    await tick(60);
    // As Sable left it mid-turn: a steer the agent had not taken yet.
    h.rt.add<UserItem>({ type: 'user', text: 'and one more thing', state: 'queued', steered: true });
    await h.app.store.flush();
    await h.app.dispose();

    const app2 = new App({ home: h.home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    cleanups.push(() => app2.dispose());
    const snap = await app2.call('session.snapshot', { sessionId: h.id });
    expect(snap.items.some((i) => i.type === 'user' && i.state === 'queued')).toBe(false);
    expect(snap.queue.map((q) => q.text)).toEqual(['and one more thing']);
    expect(snap.items.at(-1)).toMatchObject({ type: 'notice', variant: 'info', text: 'Your message is back in the queue', detail: 'Sable closed before the agent took it.' });
  });
});

// ─────────────────────────────── a bare fake agent ──────────────────────────────

/** An agent whose turns end only when the test says so and which never takes a steer by itself. */
function fakeAgent(opts: { failSteer?: boolean } = {}) {
  const sent: UserItem[] = [];
  let rt!: SessionRuntime;
  const session: ProviderSession = {
    async send(item: UserItem) {
      sent.push(item);
      if (item.steered && rt.turnActive) {
        if (opts.failSteer) throw new Error('steer refused');
        return;
      }
      rt.taken(item.id);
      rt.beginTurn('Thinking');
    },
    async interrupt() {
      rt.endTurn();
    },
    async setModel() {},
    async setMode() {},
    async close() {},
  } as unknown as ProviderSession;
  const provider = {
    id: 'demo',
    info: async () => ({ id: 'demo', name: 'Fake', installed: true, auth: { signedIn: true } }),
    caps: async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } }),
    open: async (r: SessionRuntime) => {
      rt = r;
      return session;
    },
    dispose: async () => {},
  };
  return { provider, sent, end: (error?: string) => rt.endTurn(error) };
}

async function withFake(opts: { failSteer?: boolean } = {}) {
  const home = tempHome('steer-fake');
  const fake = fakeAgent(opts);
  const app = new App({ home, providers: [() => fake.provider as never], quiet: true });
  cleanups.push(() => app.dispose());
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const snap = await app.call('session.create', { provider: 'demo', cwd, mode: 'default' });
  const id = snap.session.id;
  return { app, id, rt: app.runtime(id), fake, send: (text: string, steer?: boolean) => app.call('session.send', { sessionId: id, text, steer }) };
}

describe('steering, whatever the agent does', () => {
  it('a turn that ends normally without taking a steer: the steer runs as the next turn, sent once', async () => {
    const h = await withFake();
    await h.send('first');
    await h.send('steer me', true);
    expect(users(h.rt).at(-1)).toMatchObject({ text: 'steer me', steered: true, state: 'queued' });
    h.fake.end();
    await until(() => h.rt.turnActive, 'the next turn');
    expect(h.fake.sent.map((m) => m.text)).toEqual(['first', 'steer me', 'steer me']);
    // Moved down to where it was taken, as a plain message: nothing is left waiting.
    expect(users(h.rt).map((u) => [u.text, u.state, !!u.steered])).toEqual([
      ['first', 'sent', false],
      ['steer me', 'sent', false],
    ]);
    expect(h.rt.queue).toEqual([]);
    h.fake.end();
  });

  it('a steer the agent refuses does not end the running turn: it waits in the queue and goes next', async () => {
    const h = await withFake({ failSteer: true });
    await h.send('first');
    await h.send('steer me', true);
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.meta.status).toBe('running');
    expect(users(h.rt).map((u) => u.text)).toEqual(['first']);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['steer me']);
    expect(h.rt.items.some((i) => i.type === 'notice' && i.variant === 'error')).toBe(false);
    h.fake.end();
    await until(() => h.rt.turnActive, 'the next turn');
    expect(users(h.rt).at(-1)).toMatchObject({ text: 'steer me', state: 'sent' });
    h.fake.end();
  });
});

// ───────────────────────────────────── Codex ────────────────────────────────────

async function codex(opts: { steer?: 'ok' | 'fail' } = {}) {
  const home = tempHome('steer-codex');
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let turnN = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: `turn${++turnN}` } };
      if (method === 'turn/steer') {
        if (opts.steer === 'fail') throw new Error('expected turn turn1 is not the active turn');
        return {};
      }
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
  const complete = (turn: string, status: string) => notify('turn/completed', { threadId: 'th1', turn: { id: turn, status, items: [] } });
  return { app, id, rt, calls, notify, complete, send: (text: string, steer?: boolean) => app.call('session.send', { sessionId: id, text, steer }) };
}

const count = (calls: { method: string }[], method: string) => calls.filter((c) => c.method === method).length;

describe('steering with Codex', () => {
  it('a refused steer and then a stop: the message goes back to the queue once, no turn starts for it', async () => {
    const h = await codex({ steer: 'fail' });
    await h.send('first');
    await until(() => count(h.calls, 'turn/start') === 1 && h.rt.turnActive, 'turn 1');
    await h.send('steer me', true);
    await until(() => count(h.calls, 'turn/steer') === 1, 'steer attempt');
    await tick();
    await h.app.call('session.interrupt', { sessionId: h.id });
    h.complete('turn1', 'interrupted');
    await tick(40);
    expect(h.rt.turnActive).toBe(false);
    // Before: the adapter's own queue started a turn with it while the bridge also put it back.
    expect(count(h.calls, 'turn/start')).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['steer me']);
    expect(users(h.rt).map((u) => u.text)).toEqual(['first']);
    expect(notes(h.rt).at(-1)?.text).toBe('Your message is back in the queue');
  });

  it('a refused steer and a normal end: it runs as the next turn, marked sent', async () => {
    const h = await codex({ steer: 'fail' });
    await h.send('first');
    await until(() => h.rt.turnActive && count(h.calls, 'turn/start') === 1, 'turn 1');
    await h.send('steer me', true);
    await until(() => count(h.calls, 'turn/steer') === 1, 'steer attempt');
    await tick();
    h.complete('turn1', 'completed');
    await until(() => count(h.calls, 'turn/start') === 2, 'turn 2');
    const second = h.calls.filter((c) => c.method === 'turn/start')[1];
    expect(JSON.stringify(second.params.input)).toContain('steer me');
    await tick(40);
    expect(users(h.rt).find((u) => u.text === 'steer me')?.state).toBe('sent');
    expect(h.rt.queue).toEqual([]);
    h.complete('turn2', 'completed');
  });

  it('a steer while the turn is being stopped is not steered into it; it waits in the queue', async () => {
    const h = await codex({ steer: 'ok' });
    await h.send('first');
    await until(() => h.rt.turnActive && count(h.calls, 'turn/start') === 1, 'turn 1');
    await tick();
    await h.app.call('session.interrupt', { sessionId: h.id });
    expect(h.rt.turnActive).toBe(true);
    await h.send('wait, do this instead', true);
    await tick();
    expect(count(h.calls, 'turn/steer')).toBe(0);
    h.complete('turn1', 'interrupted');
    await tick(40);
    expect(count(h.calls, 'turn/start')).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['wait, do this instead']);
  });

  it('an accepted steer is marked sent where it was written', async () => {
    const h = await codex({ steer: 'ok' });
    await h.send('first');
    await until(() => h.rt.turnActive && count(h.calls, 'turn/start') === 1, 'turn 1');
    await tick();
    await h.send('also add a test', true);
    await until(() => users(h.rt).at(-1)?.state === 'sent', 'steer taken');
    expect(users(h.rt).at(-1)).toMatchObject({ text: 'also add a test', steered: true });
    h.complete('turn1', 'completed');
    await tick(40);
    expect(count(h.calls, 'turn/start')).toBe(1);
  });
});

// ───────────────────────────────────── Claude ───────────────────────────────────

async function claude() {
  const events: BridgeEvent[] = [];
  const p = new ClaudeProvider({ emit: (e) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
  p.seen.names = false; // This fake CLI learns support for named results within its own fixture.
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
  return { rt, session, pushed, message, add };
}

const result = (uuids?: string[]) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage: {}, total_cost_usd: 0, ...(uuids ? { user_message_uuids: uuids } : {}) });

describe('steering with Claude Code', () => {
  it('a steer folded into the turn without a replay is marked taken by the result that lists it', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    const steer = h.add('steer me');
    await h.session.send(steer);
    expect(h.pushed.map((m) => m.priority)).toEqual([undefined, 'next']);
    // The first message is replayed; the steer never is (or under another uuid).
    h.message({ type: 'user', isReplay: true, uuid: h.pushed[0].uuid, parent_tool_use_id: null, message: { role: 'user', content: 'first' } });
    expect(h.rt.get<UserItem>(steer.id)?.state).toBe('queued');
    h.message(result([h.pushed[0].uuid, h.pushed[1].uuid]));
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.get<UserItem>(steer.id)).toMatchObject({ state: 'sent', steered: true });
  });

  it('a steer replayed under another uuid with the same words is taken at once, not shown twice', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    const steer = h.add('steer me');
    await h.session.send(steer);
    h.message({ type: 'user', isReplay: true, uuid: 'some-other-uuid', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'steer me' }] } });
    expect(h.rt.get<UserItem>(steer.id)).toMatchObject({ state: 'sent', providerId: 'some-other-uuid' });
    expect(users(h.rt).map((u) => u.text)).toEqual(['first', 'steer me']);
  });

  it('a message sent from the Claude app joins the conversation and its turn runs here', async () => {
    const h = await claude();
    expect(h.rt.turnActive).toBe(false);
    h.message({ type: 'user', isReplay: true, uuid: 'from-phone', parent_tool_use_id: null, message: { role: 'user', content: 'check the build from my phone' } });
    const remote = users(h.rt).pop();
    expect(remote).toMatchObject({ text: 'check the build from my phone', state: 'sent', remote: true, providerId: 'from-phone' });
    expect(h.rt.turnActive).toBe(true);
    h.message(result(['from-phone']));
    expect(h.rt.turnActive).toBe(false);
  });

  it('a message from the Claude app replayed twice shows once', async () => {
    const h = await claude();
    const msg = { type: 'user', isReplay: true, uuid: 'from-phone-2', parent_tool_use_id: null, message: { role: 'user', content: 'run the tests' } };
    h.message(msg);
    h.message(result(['from-phone-2']));
    expect(h.rt.turnActive).toBe(false);
    h.message(msg);
    expect(users(h.rt).filter((u) => u.providerId === 'from-phone-2')).toHaveLength(1);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a message from the Claude app during a turn keeps the turn open until its own result', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    h.message({ type: 'user', isReplay: true, uuid: 'mid-turn', parent_tool_use_id: null, message: { role: 'user', content: 'also check the docs' } });
    h.message(result([h.pushed[0].uuid]));
    expect(h.rt.turnActive).toBe(true);
    h.message(result(['mid-turn']));
    expect(h.rt.turnActive).toBe(false);
  });

  it('a message from the Claude app folded into the turn does not keep it open once the agent is idle', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    h.message({ type: 'user', isReplay: true, uuid: h.pushed[0].uuid, parent_tool_use_id: null, message: { role: 'user', content: 'first' } });
    h.message({ type: 'user', isReplay: true, uuid: 'folded', parent_tool_use_id: null, message: { role: 'user', content: 'and the readme' } });
    h.message(result([h.pushed[0].uuid]));
    expect(h.rt.turnActive).toBe(true);
    h.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    expect(h.rt.turnActive).toBe(false);
  });

  it('a turn that ends with every result in but no replay for the steer still marks it taken', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    const steer = h.add('steer me');
    await h.session.send(steer);
    // An older CLI: results carry no uuids; the steer ran as its own turn but was never replayed.
    h.message(result());
    expect(h.rt.turnActive).toBe(true);
    h.message(result());
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.get<UserItem>(steer.id)?.state).toBe('sent');
  });

  it('a replayed steer is taken in place at once', async () => {
    const h = await claude();
    const first = h.add('first');
    await h.session.send(first);
    const steer = h.add('steer me');
    await h.session.send(steer);
    h.message({ type: 'user', isReplay: true, uuid: h.pushed[1].uuid, parent_tool_use_id: null, message: { role: 'user', content: 'steer me' } });
    expect(h.rt.get<UserItem>(steer.id)).toMatchObject({ state: 'sent', providerId: h.pushed[1].uuid });
    expect(h.rt.turnActive).toBe(true);
    h.message(result([h.pushed[0].uuid, h.pushed[1].uuid]));
    expect(h.rt.turnActive).toBe(false);
  });
});
