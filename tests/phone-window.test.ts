/**
 * The phone endpoint's side of three review findings: a bounded page around a deep search hit and the
 * pages after it (24), questions in the same words answered only on the desktop (W3-16), and a queued
 * message taken back to the phone reserved while its reply goes, so a reply that fails leaves it, its
 * place and its Spare wait as they were (W3-19). Demo agent and local sockets only.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhoneTail, QuestionRequest, TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { phoneQuestion, phoneWindow, PAGE_ITEMS, registerPhone, type PhoneService } from '../server/services/phone';
import type { Link } from '../server/services/phone-secure';
import { pairSecure } from './phone-wire';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A long chat: `turns` turns, each a message, two steps and an answer. */
function long(turns: number): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, ts: t, type: 'user', text: `message ${t}` } as TimelineItem);
    for (let s = 0; s < 2; s++) out.push({ id: `t${t}-${s}`, ts: t, type: 'tool', name: 'Bash', kind: 'bash', title: `step ${s}`, status: 'done', detail: { command: 'ls' } } as TimelineItem);
    out.push({ id: `a${t}`, ts: t, type: 'text', text: `answer ${t}` } as TimelineItem);
    out.push({ id: `e${t}`, ts: t, type: 'turn', status: 'done' } as unknown as TimelineItem);
  }
  return out;
}

describe('a page around a deep search hit (24)', () => {
  const items = long(3000);
  it('is bounded and around the item, whole turns, with the page before and after named', () => {
    const w = phoneWindow(items, { around: 'a120' });
    const ids = w.items.map((i) => i.id);
    expect(ids).toContain('a120');
    expect(w.items.length).toBeLessThanOrEqual(PAGE_ITEMS * 3);
    expect(w.items[0].type).toBe('user');
    expect(ids.indexOf('a120')).toBeGreaterThan(0);
    expect(w.cursor).toBe(w.items[0].id);
    expect(w.next).toMatch(/^u\d+$/);
    expect(w.total).toBe(3000 * 5);
  });

  it('goes on toward the newest from `next`, and the last page has none', () => {
    const w = phoneWindow(items, { around: 'a120' });
    const after = phoneWindow(items, { after: w.next! });
    expect(after.items[0].id).toBe(w.next);
    expect(after.next).toBeTruthy();
    const end = phoneWindow(items, { after: 'u2999' });
    expect(end.items.map((i) => i.id)).toEqual(['u2999', 't2999-0', 't2999-1', 'a2999', 'e2999']);
    expect(end.next).toBeUndefined();
  });

  it('says so when the chat no longer has the item', () => {
    expect(() => phoneWindow(items, { around: 'nope' })).toThrow('That message is no longer in this chat.');
  });

  it('over the socket: `at` names the item, the queue and the page stay within the budget', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-window-'));
    homes.push(home);
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerFs(app);
    registerPhone(app, { port: 0, host: '127.0.0.1' });
    const { port } = await app.call('phone.setEnabled', { on: true });
    const { c } = await pairSecure(app, port);
    mkdirSync(path.join(home, 'chat'));
    const created = (await c.call('session.create', { provider: 'demo', cwd: path.join(home, 'chat') })) as { result: PhoneTail };
    const rt = app.sessions.get(created.result.session.id)!;
    rt.load(long(400), [], []);
    const r = (await c.call('phone.tail', { sessionId: rt.id, around: 'a10' })) as { ok: boolean; result: PhoneTail };
    expect(r.ok).toBe(true);
    expect(r.result.at).toBe('a10');
    expect(r.result.items.some((i) => i.id === 'a10')).toBe(true);
    expect(r.result.next).toBeTruthy();
    const gone = (await c.call('phone.tail', { sessionId: rt.id, around: 'nope' })) as { ok: boolean; error: string };
    expect(gone.error).toBe('That message is no longer in this chat.');
    c.ws.close();
  });
});

describe('questions in the same words (W3-16)', () => {
  it('only the desktop answers them (the answers are keyed by the words)', () => {
    const base: QuestionRequest = { id: 'r', sessionId: 's', createdAt: 1, questions: [] };
    const one = { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] };
    expect(phoneQuestion({ ...base, questions: [one, { ...one, header: 'Second' }] }).incomplete).toBe(true);
    expect(phoneQuestion({ ...base, questions: [one, { ...one, question: 'Which other one?' }] }).incomplete).toBeUndefined();
  });
});

describe('a queued message taken back to the phone (W3-19)', () => {
  async function setup() {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-window-'));
    homes.push(home);
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerFs(app);
    const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
    const { port } = await app.call('phone.setEnabled', { on: true });
    const paired = await pairSecure(app, port);
    mkdirSync(path.join(home, 'chat'));
    const created = (await paired.c.call('session.create', { provider: 'demo', cwd: path.join(home, 'chat') })) as { result: PhoneTail };
    const rt = app.sessions.get(created.result.session.id)!;
    return { app, phone: phone as PhoneService, rt, ...paired };
  }
  const until = async (ok: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('stays queued, in its place, with its Spare wait, when its reply does not go', async () => {
    const { phone, rt, c, deviceId } = await setup();
    const a = rt.enqueue('first');
    const b = rt.enqueue('held for spare');
    const d = rt.enqueue('last');
    const wait = { reason: 'spare' as const, since: 1, held: [b.id] };
    rt.update({ spare: wait });
    // The phone's connection takes no more frames (its reply fails as it goes).
    const links = (phone as unknown as { live: Map<string, Set<Link>> }).live.get(deviceId)!;
    const link = [...links][0];
    const send = link.send.bind(link);
    let refused = 0;
    link.send = (text, cb) => {
      if (text.includes('"held for spare"')) {
        refused++;
        return cb?.(new Error('gone'));
      }
      send(text, cb);
    };
    c.send({ id: 900, method: 'queue.take', params: { sessionId: rt.id, id: b.id } });
    await until(() => refused === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(rt.queue.map((q) => q.id)).toEqual([a.id, b.id, d.id]);
    expect(rt.meta.spare).toEqual(wait);
    // Delivered: taken out by the bridge's own take (its Spare wait ends as on the desktop).
    link.send = send;
    const ok = (await c.call('queue.take', { sessionId: rt.id, id: b.id })) as { ok: boolean; result: { message: { text: string } } };
    expect(ok.result.message.text).toBe('held for spare');
    await until(() => rt.queue.length === 2);
    expect(rt.queue.map((q) => q.id)).toEqual([a.id, d.id]);
    expect(rt.meta.spare ?? null).toBeNull();
    c.ws.close();
  });
});
