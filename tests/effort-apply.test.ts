/**
 * The effort a person picks sticks: it is the session's at once and in the order picked, whatever
 * the agent takes to answer (Claude Code's `applyFlagSettings` can take seconds while its process
 * starts, or fail), and the agent has it before the next message. Before, the bridge stored the
 * choice only after the agent answered: the chip fell back to the old level after its 4 s wait,
 * two quick picks landed in the order they finished, and a refused one was never applied.
 * Demo agent with its effort answer replaced by fakes: no real agent turns.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, Effort } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

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

async function demo() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-effort-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const events: BridgeEvent[] = [];
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  app.subscribe((e) => events.push(structuredClone(e)));
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'proj'), mode: 'default' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  // An agent attached and idle, as after a first message.
  await app.call('session.send', { sessionId: id, text: 'hi' });
  await until(() => !rt.turnActive && !!rt.handle, 'first turn');
  const handle = rt.handle as unknown as { setEffort(e: Effort): Promise<void> };
  const applied: Effort[] = [];
  const efforts = () => events.filter((e): e is Extract<BridgeEvent, { type: 'session.updated' }> => e.type === 'session.updated' && e.id === id && 'effort' in e.patch).map((e) => e.patch.effort);
  return { app, id, rt, handle, applied, efforts, setEffort: (effort: Effort) => app.call('session.setEffort', { sessionId: id, effort }) };
}

describe('the effort a person picks', () => {
  it('is the session\'s at once, while the agent is still answering', async () => {
    const h = await demo();
    let release!: () => void;
    h.handle.setEffort = (e) => new Promise<void>((r) => (release = () => (h.applied.push(e), r())));
    const done = h.setEffort('low');
    // Before the agent answers: the chip, the popover and the phone already read it.
    await until(() => h.rt.meta.effort === 'low', 'stored at once', 200);
    expect(h.efforts().at(-1)).toBe('low');
    release();
    await done;
    expect(h.applied).toEqual(['low']);
  });

  it('two quick picks land in the order they were made, and the agent ends with the last one', async () => {
    const h = await demo();
    const waits: (() => void)[] = [];
    let active = 0;
    let most = 0;
    h.handle.setEffort = (e) => {
      most = Math.max(most, ++active);
      return new Promise<void>((r) => waits.push(() => (active--, h.applied.push(e), r())));
    };
    const before = h.efforts().length;
    const first = h.setEffort('max');
    await until(() => waits.length === 1, 'first asked');
    const second = h.setEffort('low');
    await new Promise((r) => setTimeout(r, 30));
    // One change at a time: the second waits for the agent's answer to the first.
    expect(waits).toHaveLength(1);
    expect(h.rt.meta.effort).toBe('low');
    waits[0]();
    await until(() => waits.length === 2, 'second asked');
    waits[1]();
    await Promise.all([first, second]);
    expect(h.efforts().slice(before)).toEqual(['max', 'low']);
    // What the agent got last is what the session shows, and nothing is left due.
    expect(h.applied).toEqual(['max', 'low']);
    expect(most).toBe(1);
    await h.app.call('session.send', { sessionId: h.id, text: 'hi' });
    expect(h.applied).toEqual(['max', 'low']);
  });

  it('an agent that never answers an effort change holds the next message a few seconds at most', async () => {
    const h = await demo();
    h.handle.setEffort = () => new Promise<void>(() => {});
    void h.setEffort('max');
    const at = Date.now();
    await h.app.call('session.send', { sessionId: h.id, text: 'hi' });
    expect(Date.now() - at).toBeLessThan(9000);
    expect(h.rt.items.filter((i) => i.type === 'user')).toHaveLength(2);
    // The next pick is not stuck behind it for ever.
    h.handle.setEffort = async (e) => void h.applied.push(e);
    await h.setEffort('low');
    expect(h.applied).toEqual(['low']);
  }, 20_000);

  it('picks made while the agent answers coalesce to the latest', async () => {
    const h = await demo();
    const waits: (() => void)[] = [];
    h.handle.setEffort = (e) => new Promise<void>((r) => waits.push(() => (h.applied.push(e), r())));
    const first = h.setEffort('max');
    await until(() => waits.length === 1, 'first asked');
    const rest = [h.setEffort('medium'), h.setEffort('high'), h.setEffort('low')];
    waits[0]();
    await until(() => waits.length === 2, 'the latest asked');
    waits[1]();
    await Promise.all([first, ...rest]);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.applied).toEqual(['max', 'low']);
    expect(h.rt.meta.effort).toBe('low');
  });

  it('one the agent refused goes to it right before the next message', async () => {
    const h = await demo();
    let refuse = true;
    h.handle.setEffort = async (e) => {
      if (refuse) throw new Error('Query closed');
      h.applied.push(e);
    };
    const r = await h.setEffort('xhigh');
    expect(r).toEqual({ ok: true });
    expect(h.rt.meta.effort).toBe('xhigh');
    expect(h.applied).toEqual([]);
    refuse = false;
    await h.app.call('session.send', { sessionId: h.id, text: 'hi' });
    expect(h.applied).toEqual(['xhigh']);
    // Applied once: the message after does not send it again.
    await until(() => !h.rt.turnActive, 'turn');
    await h.app.call('session.send', { sessionId: h.id, text: 'hi again' });
    expect(h.applied).toEqual(['xhigh']);
  });

  it('goes again after a model change reaches the agent, which may reset it to the model\'s own', async () => {
    const h = await demo();
    h.handle.setEffort = async (e) => void h.applied.push(e);
    await h.setEffort('medium');
    expect(h.applied).toEqual(['medium']);
    const other = h.rt.caps?.models.find((m) => m.id !== h.rt.meta.model && m.efforts?.includes('medium'));
    expect(other).toBeTruthy();
    await h.app.call('session.setModel', { sessionId: h.id, model: other!.id });
    await h.app.call('session.send', { sessionId: h.id, text: 'hi there' });
    expect(h.applied).toEqual(['medium', 'medium']);
  });
});
