/**
 * Codex turns under Stop, an idle thread and a restarted app-server (review wave 3):
 * - #10: `/review` and `/compact` start like a message does: a Stop while their start is out waits for
 *   its answer and interrupts the real command once its id is known, never leaving it running.
 * - #11: news of the running turn's own work makes an idle probe out now moot; when the store keeps
 *   saying the turn runs, the turn stays open and says it is not known how it ended, the queue held,
 *   until its real end comes (honoured) or the person stops it.
 * - #13: reloads of the thread after an app-server restart are one at a time and shared; one no longer
 *   wanted commits nothing and leaves no thread subscribed.
 * A fake app-server only: no real agent turns.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem } from '@shared/protocol';
import { App } from '../server/app';
import { CodexProvider } from '../server/providers/codex';

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

type Answers = Partial<Record<string, (params: Record<string, unknown>, n: number) => unknown>>;

async function codexFake(answers: Answers = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-w3-'));
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
      if (method === 'review/start') return { turn: { id: `rev${n}` } };
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
  const status = (type: 'idle' | 'active', threadId = 'th1') => notify('thread/status/changed', { threadId, status: type === 'active' ? { type, activeFlags: [] } : { type } });
  const started = (turn: string, threadId = 'th1') => notify('turn/started', { threadId, turn: { id: turn, status: 'inProgress', items: [] } });
  const complete = (turn: string, s = 'completed', threadId = 'th1') => notify('turn/completed', { threadId, turn: { id: turn, status: s, items: [] } });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  const serverDied = () => (provider as unknown as { onExit(rpc: unknown, info: unknown): void }).onExit(rpc, { code: 1, signal: null, stderr: '' });
  const session = () => [...provider.sessions.values()][0] as unknown as Record<string, unknown>;
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
    serverDied,
    session,
    provider,
    send: (text: string) => app.call('session.send', { sessionId: id, text }),
    stop: () => app.call('session.interrupt', { sessionId: id }),
    interrupted: (turnId: string) => calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === turnId),
  };
}

describe('#10: a command start is tracked like a message', () => {
  it('a /review stopped while review/start is out is interrupted on the server once its id comes', async () => {
    const g = gate();
    const h = await codexFake({ 'review/start': async () => (await g.wait(), { turn: { id: 'rev1' } }) });
    void h.send('/review');
    await until(() => h.count('review/start') === 1, 'review/start');
    const stopping = h.stop();
    await tick();
    g.open(undefined);
    await stopping;
    expect(h.interrupted('rev1')).toBe(true);
    // Its own end (interrupted) closes it; the next message is a turn of its own.
    h.complete('rev1', 'interrupted');
    expect(h.rt.turnActive).toBe(false);
    await h.send('next');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.started('turn1');
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
  });

  it('a /compact stopped while its start is out: the turn it then starts is interrupted, not shown as a new one', async () => {
    const g = gate();
    const h = await codexFake({ 'thread/compact/start': async () => (await g.wait(), {}) });
    void h.send('/compact');
    await until(() => h.count('thread/compact/start') === 1, 'thread/compact/start');
    const stopping = h.stop();
    await tick();
    g.open(undefined);
    await stopping;
    expect(h.rt.turnActive).toBe(false);
    // The compaction's turn shows itself after the stop: it is stopped too, and the chat stays idle.
    h.started('cmp1');
    await tick();
    expect(h.interrupted('cmp1')).toBe(true);
    expect(h.rt.turnActive).toBe(false);
    // The person's next message is its own turn, with its own id.
    await h.send('next');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.started('turn1');
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
  });
});

describe('#11: an idle thread whose turn is still at work', () => {
  it("news of the turn's own work makes an idle probe out now moot", async () => {
    const g = gate();
    const h = await codexFake({ 'thread/turns/list': async () => (await g.wait(), { data: [{ id: 'turn1', status: 'completed', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.status('idle');
    await until(() => h.count('thread/turns/list') === 1, 'the idle probe', 3000);
    // The turn goes on writing while the probe is out.
    h.notify('item/agentMessage/delta', { turnId: 'turn1', itemId: 'msg1', delta: 'Still ' });
    g.open(undefined);
    await tick(50);
    expect(h.rt.turnActive).toBe(true);
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
  });

  it('a store that keeps saying "running" leaves the turn open and unsure, the queue held, until its real end comes', async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().idleRecheckMs = [20, 20];
    await h.send('second');
    h.status('idle');
    await until(() => h.count('thread/turns/list') === 3, 'the rechecks', 3000);
    await tick(60);
    // Not ended by guess: open, saying it is not known, nothing queued sent.
    expect(h.rt.turnActive).toBe(true);
    expect(h.rt.items.some((i) => i.type === 'notice' && /not said how this turn ended/.test((i as NoticeItem).text))).toBe(true);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
    expect(h.count('turn/start')).toBe(1);
    // Its real end comes after all: honoured, and the queue goes on.
    h.complete('turn1');
    expect(h.rt.turnActive).toBe(false);
    await until(() => h.count('turn/start') === 2, 'the queued message sent');
  });

  it('the person can stop a turn left unsure', async () => {
    const h = await codexFake({ 'thread/turns/list': () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.started('turn1');
    h.session().idleRecheckMs = [20];
    h.status('idle');
    await until(() => h.count('thread/turns/list') === 2, 'the rechecks', 3000);
    await tick(40);
    expect(h.rt.turnActive).toBe(true);
    await h.stop();
    expect(h.interrupted('turn1')).toBe(true);
    h.complete('turn1', 'interrupted');
    expect(h.rt.turnActive).toBe(false);
  });
});

describe('#13: reloads after an app-server restart', () => {
  it('a stopped message and the next one share one reload; the next one ends on its own thread', async () => {
    const g = gate();
    const h = await codexFake({ 'thread/resume': async () => (await g.wait(), Promise.reject(new Error('no rollout found for thread id th1'))) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('A').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.stop();
    expect(h.rt.turnActive).toBe(false);
    void h.send('B').catch(() => {});
    await tick();
    g.open(undefined);
    await until(() => h.count('turn/start') === 2, "B's turn/start");
    await tick();
    // One reload, one new thread, and B's turn on it.
    expect(h.count('thread/start')).toBe(2);
    const thread = h.calls.filter((c) => c.method === 'turn/start').at(-1)!.params.threadId as string;
    expect(thread).toBe('th2');
    h.complete('turn2', 'completed', thread);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a reload whose session closed meanwhile commits nothing and leaves its new thread unsubscribed', async () => {
    const g = gate();
    const h = await codexFake({ 'thread/resume': async () => (await g.wait(), Promise.reject(new Error('no rollout found for thread id th1'))) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('A').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.rt.handle!.close();
    g.open(undefined);
    await until(() => h.count('thread/start') === 2, 'the replacement thread');
    await tick(30);
    expect(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'th2')).toBe(true);
    expect(h.provider.sessions.has('th2')).toBe(false);
    expect(h.count('turn/start')).toBe(1);
  });
});
