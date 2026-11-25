import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { App } from '../server/app';
import { PhoneService } from '../server/services/phone';
import type { Link } from '../server/services/phone-secure';
import type { BridgeEvent } from '@shared/protocol';

// Enter the real authenticated request and event handlers with an in-memory link and desktop.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanups.splice(0)) await done(); });
function endpoint() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-notice-rpc-'));
  let unread = true;
  let emit!: (event: BridgeEvent) => void;
  let receive!: (json: string) => void;
  let close!: () => void;
  const frames: { ok?: boolean; event?: BridgeEvent; error?: string }[] = [];
  const call = vi.fn(async (method, params, _guard) => {
    if (method !== 'session.snapshot') return { ok: true };
    if (!params.peek) unread = false;
    return { session: { id: params.sessionId, unread }, items: [], queue: [], todos: [], permissions: [], questions: [] };
  });
  const sessions = new Map<string, unknown>([
    ['custom', { meta: { custom: true } }],
    ['s', { meta: { cwd: path.join(tmpdir(), 'ordinary-chat') }, get: (id: string) => id === 'waiting' ? { type: 'user', id, state: 'queued', steered: true, text: 'answer?' } : undefined }],
  ]);
  const app = { store: { dir, state: { settings: {} } }, onDispose: vi.fn(), sessions, call, emit: vi.fn(), subscribe: (f: typeof emit) => { emit = f; return () => {}; } };
  const service = new PhoneService(app as unknown as App);
  const device = { id: 'test', tokenHash: '1'.repeat(64) };
  const host = service as unknown as { data: { enabled: boolean; devices: (typeof device)[] }; authenticated(link: Link, d: typeof device): void };
  host.data = { enabled: true, devices: [device] };
  host.authenticated({
    open: true, secure: true, buffered: 0, ping() {}, close() {}, terminate() {},
    onMessage(f) { receive = f; return () => {}; }, onClose(f) { close = f; }, onPong() {},
    send(json) { frames.push(JSON.parse(json)); },
  }, device);
  cleanups.push(async () => { close(); await service.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const send = async (method: string, params: object) => {
    frames.length = 0;
    await receive(JSON.stringify({ id: 1, method, params }));
    return frames.at(-1);
  };
  const step = () => emit({ type: 'item.delta', field: 'text', sessionId: 's', id: 'm', delta: 'word' });
  return { send, call, step, frames, unread: () => unread, data: host.data };
}

it('peeks without marking read or subscribing, preserves an existing watch, and requires a current pairing', async () => {
  const e = endpoint();
  expect(await e.send('phone.tail', { sessionId: 's', peek: true })).toMatchObject({ ok: true });
  expect(e.unread()).toBe(true);
  e.step();
  expect(e.frames.some((f) => f.event)).toBe(false);
  expect(await e.send('phone.tail', { sessionId: 's' })).toMatchObject({ ok: true });
  expect(e.unread()).toBe(false);
  await e.send('phone.tail', { sessionId: 's', peek: true });
  e.step();
  expect(e.frames.at(-1)?.event?.type).toBe('item.delta');
  e.data.enabled = false;
  for (const peek of [true, false]) expect(await e.send('phone.tail', { sessionId: 's', peek })).toBeUndefined();
  expect(e.call).toHaveBeenCalledTimes(3);
});

it('allows steerNow for a visible card with the live pairing guard, including from a notification', async () => {
  const e = endpoint();
  const p = { sessionId: 's', itemId: 'waiting' };
  expect(await e.send('session.steerNow', p)).toMatchObject({ ok: false });
  expect(await e.send('phone.steerNow', { ...p, sessionId: 'other' })).toMatchObject({ ok: false });
  await e.send('phone.tail', { sessionId: 's', peek: true });
  expect(await e.send('phone.steerNow', { ...p, itemId: 'missing' })).toMatchObject({ ok: false });
  expect(await e.send('phone.steerNow', { ...p, sessionId: 'custom' })).toMatchObject({ ok: false });
  expect(await e.send('phone.steerNow', p)).toMatchObject({ ok: true });
  const forwarded = e.call.mock.lastCall!;
  expect(forwarded.slice(0, 2)).toEqual(['session.steerNow', p]);
  expect(forwarded[2].allowed()).toBe(true);
  e.data.devices.length = 0;
  expect(forwarded[2].allowed()).toBe(false);
});

it('passes the selected refusal to either guarded handler and rejects malformed or unscoped reset requests', async () => {
  const e = endpoint();
  for (const [method, extra] of [['session.switchAccount', { accountId: 'next', retry: true }], ['spare.atReset', {}]] as const) {
    const params = { sessionId: 's', refusalId: 'older-card', ...extra };
    expect(await e.send(method, params)).toMatchObject({ ok: true });
    expect(e.call.mock.lastCall).toEqual([method, params, { allowed: expect.any(Function), settled: true }]);
    expect(await e.send(method, { ...params, refusalId: [] })).toMatchObject({ ok: false });
    expect(await e.send(method, { ...params, sessionId: 'custom' })).toMatchObject({ ok: false });
  }
  expect(await e.send('spare.atReset', { sessionId: 's' })).toMatchObject({ ok: false });
  expect(await e.send('spare.startNow', { sessionId: 's' })).toMatchObject({ ok: false });
  expect(e.call).toHaveBeenCalledTimes(2);
});

it.each([true, false])('rechecks the pairing after a snapshot load with peek=%s', async (peek) => {
  const e = endpoint();
  let release!: () => void;
  const loading = new Promise<void>((resolve) => { release = resolve; });
  e.call.mockImplementationOnce(async () => {
    await loading;
    return { session: { id: 's', unread: true }, items: [], queue: [], todos: [], permissions: [], questions: [] };
  });
  const result = e.send('phone.tail', { sessionId: 's', peek });
  e.data.devices.length = 0;
  release();
  expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('removed') });
  e.step();
  expect(e.frames.some((f) => f.event)).toBe(false);
});
