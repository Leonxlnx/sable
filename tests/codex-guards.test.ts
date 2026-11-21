/**
 * Codex turns guarded against news that comes late or out of order (review wave 2): a Stop while the
 * thread reloads sends nothing (#12), an idle probe gives way to a newer status and a stale answer is
 * asked again within bounds (#13), and an error belongs to the turn it names (#14). A fake app-server
 * only: no real agent turns.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRuntime } from '../server/core/runtime';
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
/** A gate a fake answer waits on. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

type Answer = {
  /** turn/start's answer for the n-th start (may wait). */
  turnStart?: (n: number) => Promise<unknown> | unknown;
  /** thread/turns/list's answer for the n-th probe (may wait or fail). */
  turnsList?: (n: number) => Promise<unknown> | unknown;
  /** thread/resume's answer (an app-server that restarted reloads the thread). */
  resume?: () => Promise<unknown> | unknown;
};

/** A Codex chat in the bridge on a fake app-server whose answers a test chooses. */
async function codexFake(answer: Answer = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codexguards-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let starts = 0;
  let probes = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return answer.resume ? answer.resume() : { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'turn/start') {
        const n = ++starts;
        return answer.turnStart ? answer.turnStart(n) : { turn: { id: `turn${n}` } };
      }
      if (method === 'thread/turns/list') return answer.turnsList ? answer.turnsList(++probes) : {};
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
  const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
  const status = (type: 'idle' | 'active') => notify('thread/status/changed', { threadId: 'th1', status: type === 'active' ? { type, activeFlags: [] } : { type } });
  const complete = (turn: string, s = 'completed') => notify('turn/completed', { threadId: 'th1', turn: { id: turn, status: s, items: [] } });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  /** The app-server exits: the next turn reloads the thread first (thread/resume). */
  const serverDied = () => (provider as unknown as { onExit(rpc: unknown, info: unknown): void }).onExit(rpc, { code: 1, signal: null, stderr: '' });
  /** The chat's Codex session (to make its rechecks quick). */
  const session = () => provider.sessions.get('th1') as unknown as Record<string, unknown>;
  return { app, id, rt, calls, notify, status, complete, count, serverDied, session, send: (text: string) => app.call('session.send', { sessionId: id, text }), stop: () => app.call('session.interrupt', { sessionId: id }) };
}

const lastTurn = (rt: SessionRuntime) => rt.items.findLast((i) => i.type === 'turn') as { stopReason?: string; error?: string } | undefined;

describe('#12: a Stop while the thread reloads sends nothing', () => {
  it('a message stopped while its thread is resumed after an app-server restart never reaches turn/start', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    expect(h.count('turn/start')).toBe(1);
    h.serverDied();
    void h.send('second').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.stop();
    await tick();
    expect(h.rt.turnActive).toBe(false);
    g.open();
    await tick(50);
    expect(h.count('turn/start')).toBe(1);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a command stopped while its thread is resumed never starts (the command path)', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('/compact').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.stop();
    await tick();
    g.open();
    await tick(50);
    expect(h.count('thread/compact/start')).toBe(0);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a message not stopped goes out once the thread is back', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('second').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    g.open();
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    expect(h.rt.turnActive).toBe(true);
  });
});

describe('#13: an idle probe gives way to newer news, and a stale answer is asked again within bounds', () => {
  for (const [what, answer] of [
    ['finds no record', () => ({})],
    ['fails', () => Promise.reject(new Error('thread/turns/list failed'))],
  ] as const) {
    it(`the thread goes active again while the probe is out and the probe ${what}: the live turn stays open`, async () => {
      const g = gate();
      const h = await codexFake({ turnsList: () => g.wait().then(answer) });
      await h.send('first');
      await tick();
      h.status('idle');
      await until(() => h.count('thread/turns/list') === 1, 'the idle probe', 3000);
      // Codex picks the turn up again before the probe answers.
      h.status('active');
      g.open();
      await tick(50);
      expect(h.rt.turnActive).toBe(true);
      h.complete('turn1');
      await tick();
      expect(h.rt.turnActive).toBe(false);
      expect(lastTurn(h.rt)?.stopReason).toBe('completed');
    });
  }

  it('a stale "inProgress" answer while the thread stays idle is asked again, and the stored end then closes the turn', async () => {
    const h = await codexFake({ turnsList: (n) => ({ data: [{ id: 'turn1', status: n === 1 ? 'inProgress' : 'completed', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [30, 30, 30];
    await h.send('second');
    h.status('idle');
    await until(() => !h.rt.turnActive || h.count('turn/start') === 2, 'the turn closed', 3000);
    await tick(50);
    expect(h.count('thread/turns/list')).toBe(2);
    expect(lastTurn(h.rt)?.stopReason).toBe('completed');
    // It ended as the thread stored it: the queued message went out.
    expect(h.count('turn/start')).toBe(2);
  });

  it('an answer that stays "inProgress" is asked a few times, then the turn stays open, unsure, with the queue held (wave 3, #11)', async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [20, 20];
    await h.send('second');
    h.status('idle');
    await until(() => h.rt.meta.activity === 'Waiting for Codex', 'the turn left unsure', 3000);
    expect(h.rt.turnActive).toBe(true);
    expect(h.count('thread/turns/list')).toBe(3);
    expect(h.count('turn/start')).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
  });

  it('a newer status between rechecks stops them', async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [200, 200];
    h.status('idle');
    await until(() => h.count('thread/turns/list') === 1, 'the idle probe', 3000);
    h.status('active');
    await tick(500);
    expect(h.count('thread/turns/list')).toBe(1);
    expect(h.rt.turnActive).toBe(true);
  });
});

describe('#14: an error belongs to the turn it names', () => {
  it("a late error of the turn that ended does not fail the next one or hold its queue", async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn2', status: 'completed', items: [] }] }) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    await h.send('second');
    await tick();
    await h.send('third');
    // turn1's error arrives after turn2 began.
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'stale failure' } });
    h.status('idle');
    await tick(1700);
    await tick(50);
    expect(h.rt.items.filter((i) => i.type === 'turn').map((t) => (t as { error?: string }).error)).toEqual([undefined, undefined]);
    expect(h.rt.meta.status).not.toBe('error');
    expect(h.count('turn/start')).toBe(3);
    expect(h.rt.items.some((i) => i.type === 'notice' && (i as { text?: string }).text === 'stale failure')).toBe(false);
  });

  it("an error naming the previous turn while the next turn/start awaits its reply is not the new turn's", async () => {
    let release!: (v: unknown) => void;
    const h = await codexFake({
      turnStart: (n) => (n === 1 ? { turn: { id: 'turn1' } } : new Promise((r) => (release = r))),
      turnsList: () => ({ data: [{ id: 'turn2', status: 'completed', items: [] }] }),
    });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    void h.send('second');
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'stale failure' } });
    release({ turn: { id: 'turn2' } });
    await tick();
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'turn2', status: 'inProgress', items: [] } });
    h.status('idle');
    await tick(1700);
    await tick(50);
    expect(h.rt.turnActive).toBe(false);
    expect(lastTurn(h.rt)).toMatchObject({ stopReason: 'completed' });
    expect(lastTurn(h.rt)?.error).toBeUndefined();
  });

  it("an error naming the new turn while its turn/start awaits its reply is kept for it", async () => {
    let release!: (v: unknown) => void;
    const h = await codexFake({ turnStart: () => new Promise((r) => (release = r)) });
    void h.send('first');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'turn1', status: 'inProgress', items: [] } });
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'model overloaded' } });
    release({ turn: { id: 'turn1' } });
    await tick();
    h.status('idle');
    await tick(1700);
    expect(h.rt.turnActive).toBe(false);
    expect(lastTurn(h.rt)?.error).toBe('model overloaded');
  });
});
