import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, BridgeEvent, PhoneStatus, SessionMeta } from '../shared/protocol';
import { COMMAND_AWAKE_MS, phoneWantsAwake, watchAwake, watchPhoneAwake } from '../server/core/awake';

type S = { meta: SessionMeta; turnActive: boolean; newestCommandAt?: number };

function source() {
  const sessions: S[] = [];
  const listeners = new Set<(e: BridgeEvent) => void>();
  const add = (status: SessionMeta['status'], extra: Partial<SessionMeta> = {}) => {
    const s: S = { meta: { id: String(sessions.length), status, ...extra } as SessionMeta, turnActive: false };
    sessions.push(s);
    return s;
  };
  const set = (s: S, patch: Partial<SessionMeta>) => {
    Object.assign(s.meta, patch);
    for (const l of listeners) l({ type: 'session.updated', id: s.meta.id, patch });
  };
  return {
    src: { sessions, subscribe: (l: (e: BridgeEvent) => void) => (listeners.add(l), () => void listeners.delete(l)) },
    add,
    set,
    listeners,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('keep awake', () => {
  it('blocks sleep while a turn runs and releases a minute after the last one ends', () => {
    vi.useFakeTimers();
    const { src, add, set } = source();
    const a = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    expect(calls).toEqual([]);
    set(a, { status: 'running' });
    expect(calls).toEqual([true]);
    set(a, { status: 'idle' });
    vi.advanceTimersByTime(30_000);
    // Work again within the minute: the block is kept, not taken twice.
    set(a, { status: 'running' });
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true]);
    set(a, { status: 'idle' });
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true, false]);
    stop();
    expect(calls).toEqual([true, false]);
  });

  it('counts an /until check between turns as work, and lets go of everything when stopped', () => {
    vi.useFakeTimers();
    const { src, add, set, listeners } = source();
    const a = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    set(a, { until: { phase: 'checking' } as SessionMeta['until'] });
    expect(calls).toEqual([true]);
    stop();
    expect(calls).toEqual([true, false]);
    expect(listeners.size).toBe(0);
  });
});

describe('keep awake for background commands', () => {
  it('releases sleep after a command starts serving and stays quiet as another server starts', () => {
    vi.useFakeTimers();
    const { src, add, set } = source();
    const chat = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, busy => calls.push(busy));
    chat.newestCommandAt = Date.now();
    set(chat, { commands: 1 });
    set(chat, { commands: 0, serving: 1 });
    vi.advanceTimersByTime(60_000);
    set(chat, { serving: 2 });
    expect(calls).toEqual([true, false]);
    stop();
  });

  it('a command the agent waits on keeps the computer up, until it is two hours old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { src, add, set } = source();
    const a = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    a.newestCommandAt = Date.now();
    set(a, { commands: 1 });
    expect(calls).toEqual([true]);
    vi.advanceTimersByTime(COMMAND_AWAKE_MS - 60_000);
    expect(calls).toEqual([true]);
    // Two hours on, a dev server is no reason to keep the laptop up all night: the minute's grace, then off.
    vi.advanceTimersByTime(60_000 + 60_000 + 1000);
    expect(calls).toEqual([true, false]);
    stop();
  });

  it('a command that ends lets go after the grace; an old one never takes the block', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * COMMAND_AWAKE_MS);
    const { src, add, set } = source();
    const a = add('idle');
    const old = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    old.newestCommandAt = Date.now() - COMMAND_AWAKE_MS - 1;
    set(old, { commands: 1 });
    expect(calls).toEqual([]);
    a.newestCommandAt = Date.now();
    set(a, { commands: 1 });
    expect(calls).toEqual([true]);
    a.newestCommandAt = undefined;
    set(a, { commands: 0 });
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true, false]);
    stop();
  });
});

describe('keep awake for the phone', () => {
  const status = (enabled: boolean, devices: number) => ({ enabled, devices: Array.from({ length: devices }, (_, i) => ({ id: String(i), name: 'p', pairedAt: 0 })) }) as unknown as PhoneStatus;

  it('wants the computer up only with the phone on, a phone paired and the setting not off', () => {
    expect(phoneWantsAwake(status(true, 1), {} as AppSettings)).toBe(true);
    expect(phoneWantsAwake(status(true, 0), {} as AppSettings)).toBe(false);
    expect(phoneWantsAwake(status(false, 1), {} as AppSettings)).toBe(false);
    expect(phoneWantsAwake(status(true, 1), { phoneAwake: false } as AppSettings)).toBe(false);
    expect(phoneWantsAwake(undefined, {} as AppSettings)).toBe(false);
  });

  it('follows the phone and the settings by their events', async () => {
    const listeners = new Set<(e: BridgeEvent) => void>();
    let settings = {} as AppSettings;
    const calls: boolean[] = [];
    const stop = watchPhoneAwake(
      { subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)), phone: async () => status(true, 1), settings: () => settings },
      (on) => calls.push(on),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([true]);
    settings = { phoneAwake: false } as AppSettings;
    for (const l of listeners) l({ type: 'settings.updated', settings });
    expect(calls).toEqual([true, false]);
    settings = {} as AppSettings;
    for (const l of listeners) l({ type: 'phone.updated', status: status(true, 0) });
    expect(calls).toEqual([true, false]);
    stop();
    expect(listeners.size).toBe(0);
  });
});
