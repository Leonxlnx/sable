/** Fork at an answer: a new session that continues from the end of that turn; the source stays as it was. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem, UserItem } from '../shared/protocol';
import { App } from '../server/app';
import { claudeForkPoint, codexForkTurn, cutAt } from '../server/core/fork';
import { DemoProvider } from '../server/providers/demo';
import { orderAccounts } from '../server/accounts/order';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const items: TimelineItem[] = [
  { id: 'u1', ts: 1, type: 'user', text: 'first', state: 'sent', providerId: 'p-u1' },
  { id: 't1:a', ts: 2, type: 'text', text: 'answer one', streaming: false },
  { id: 't1:end', ts: 3, type: 'turn', status: 'completed' } as unknown as TimelineItem,
  { id: 'u2', ts: 4, type: 'user', text: 'second', state: 'sent', providerId: 'p-u2' },
  { id: 't2:a', ts: 5, type: 'text', text: 'answer two', streaming: false },
];

describe('fork points', () => {
  it('keeps the turn that holds the answer and drops the next message on', () => {
    const queued: TimelineItem = { id: 'waiting', type: 'user', ts: 3, text: 'source only', state: 'queued', issuedUuid: 'source-uuid' };
    const cut = cutAt([...items.slice(0, 3), queued, ...items.slice(3)], 't1:a')!;
    expect(cut.kept.map((i) => i.id)).toEqual(['u1', 't1:a', 't1:end']);
    expect(cut.next?.id).toBe('u2');
    expect(cutAt(items, 't2:a')!.next).toBeUndefined();
    expect(cutAt(items, 'gone')).toBeNull();
  });

  it('Claude: forks up to the message before the next prompt, the whole chain at the end', () => {
    const chain = ['p-u1', 'a1', 'a2', 'p-u2', 'b1'];
    expect(claudeForkPoint(chain, cutAt(items, 't1:a')!.next)).toBe('a2');
    expect(claudeForkPoint(chain, undefined)).toBeUndefined();
    // A prompt the chain does not know: no native fork, Sable falls back to a summary.
    expect(claudeForkPoint(['x'], cutAt(items, 't1:a')!.next)).toBeNull();
  });

  it('Codex: forks through the last kept turn', () => {
    expect(codexForkTurn(cutAt(items, 't1:a')!.kept)).toBe('t1');
    expect(codexForkTurn(cutAt(items, 't2:a')!.kept)).toBe('t2');
    expect(codexForkTurn([items[0]])).toBeNull();
  });
});

async function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-fork-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'sable-fork-cwd-'));
  homes.push(home, cwd);
  const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
  apps.push(app);
  const a = await app.call('session.create', { provider: 'demo', cwd });
  for (const text of ['hi', 'hi again']) {
    const n = app.sessions.get(a.session.id)!.items.filter((i) => i.type === 'turn').length;
    await app.call('session.send', { sessionId: a.session.id, text });
    await until(() => app.sessions.get(a.session.id)!.items.filter((i) => i.type === 'turn').length > n && app.sessions.get(a.session.id)!.meta.status === 'idle', `the turn "${text}"`);
  }
  const src = app.sessions.get(a.session.id)!;
  const firstAnswer = src.items.find((i) => i.type === 'text')!;
  return { app, src, firstAnswer };
}

describe('account order', () => {
  it('lists named accounts first in the set order, the rest after in their own', () => {
    const list = [{ id: 'default' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(orderAccounts(list, ['b', 'default']).map((x) => x.id)).toEqual(['b', 'default', 'a', 'c']);
    expect(orderAccounts(list, undefined)).toBe(list);
  });

  it('persists the order in the settings and lists accounts in it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-order-'));
    homes.push(home);
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    apps.push(app);
    const added = await app.call('account.add', { provider: 'demo', label: 'Second' });
    const info = await app.call('account.reorder', { provider: 'demo', ids: [added.account.id, 'default', 'nope'] });
    expect(info.accounts?.map((a) => a.id)).toEqual([added.account.id, 'default']);
    expect(app.accountList('demo').map((a) => a.id)).toEqual([added.account.id, 'default']);
    expect(info.accounts?.find((a) => a.id === 'default')?.isDefault).toBe(true);
  });
});

describe('session.fork', () => {
  it('uses the agent\'s own fork when it has one, and leaves the source untouched', async () => {
    const { app, src, firstAnswer } = await setup();
    src.update({ providerSessionId: 'source-native' });
    let asked: string | undefined;
    src.handle!.fork = async (itemId) => {
      asked = itemId;
      return 'forked-native';
    };
    const before = JSON.stringify(src.items);
    const snap = await app.call('session.fork', { sessionId: src.id, itemId: firstAnswer.id });
    expect(asked).toBe(firstAnswer.id);
    expect(snap.session.id).not.toBe(src.id);
    expect(snap.session.providerSessionId).toBe('forked-native');
    expect(snap.session.title).toMatch(/\(fork\)$/);
    const handovers = (app as unknown as { handovers: Map<string, string> }).handovers;
    expect(handovers.has(snap.session.id)).toBe(false);
    expect(JSON.stringify(src.items)).toBe(before);
  });

  it('writes a fork base without its source queue or issued steer', async () => {
    const { app, src, firstAnswer } = await setup();
    src.beginTurn(); // The source still owns its unread input while the disk base is copied.
    const waiting = src.add<UserItem>({ type: 'user', text: 'only the source owns this', state: 'queued', issuedUuid: 'original-uuid' } as const);
    const history = src.items.filter(row => row !== waiting);
    const at = history.indexOf(firstAnswer);
    // A historical delegate row selects the disk-backed copy path.
    const step = src.add<ToolItem>({ type: 'tool', kind: 'agent', name: 'Agent', title: 'Review', detail: {}, status: 'done', delegateDeliveryId: 'completed-report' } as const);
    history.splice(at + 1, 0, step, waiting);
    src.reset(history);
    src.enqueue('source queue');
    const snap = await app.call('session.fork', { sessionId: src.id, itemId: firstAnswer.id });
    await app.store.flush();
    const file = app.store.loadSession(snap.session.id);
    expect(file.items.some(i => i.id === firstAnswer.id)).toBe(true);
    expect(file.items.some(i => i.id === waiting.id)).toBe(false);
    expect(file.queue ?? []).toEqual([]);
    expect(src.get(waiting.id)).toBe(waiting);
  });

  it('starts from a summary up to that point when the agent cannot fork', async () => {
    const { app, src, firstAnswer } = await setup();
    src.handle!.fork = undefined;
    const before = JSON.stringify(src.items);
    const snap = await app.call('session.fork', { sessionId: src.id, itemId: firstAnswer.id });
    const handovers = (app as unknown as { handovers: Map<string, string> }).handovers;
    const summary = handovers.get(snap.session.id)!;
    expect(summary).toMatch(/User: hi/);
    expect(summary).not.toMatch(/hi again/);
    expect(app.sessions.get(snap.session.id)!.items.some((i) => i.type === 'notice' && /Forked from/.test(i.text))).toBe(true);
    expect(JSON.stringify(src.items)).toBe(before);
  });
});
