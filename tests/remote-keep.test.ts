/** The Remote Control keeper (server/core/remote-keep.ts): only recently used chats keep their agent process. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_KEEP, enforceRemote, holdRemote, dropRemote, remoteToRelease, resetRemoteKeeper, type RemoteHolder } from '../server/core/remote-keep';

function holder(id: string, lastActive: number, busy = false) {
  const h = { id, at: lastActive, isBusy: busy, released: 0 };
  const api: RemoteHolder = {
    id,
    lastActive: () => h.at,
    busy: () => h.isBusy,
    release: () => void h.released++,
  };
  return Object.assign(h, { api });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T02:00:00Z'));
  resetRemoteKeeper();
});
afterEach(() => {
  resetRemoteKeeper();
  vi.useRealTimers();
});

describe('remoteToRelease', () => {
  it('keeps the most recently used up to the max, releases the rest and the long idle', () => {
    const now = Date.now();
    const hs = Array.from({ length: 9 }, (_, i) => holder(`s${i}`, now - i * 60_000));
    const out = remoteToRelease(hs.map((h) => h.api), now).map((h) => h.id);
    expect(out).toEqual(['s6', 's7', 's8']);
    const old = holder('old', now - REMOTE_KEEP.idleMs - 1);
    expect(remoteToRelease([old.api], now).map((h) => h.id)).toEqual(['old']);
  });

  it('never releases a busy chat, which still counts toward the max', () => {
    const now = Date.now();
    const busy = Array.from({ length: REMOTE_KEEP.max }, (_, i) => holder(`b${i}`, now - i, true));
    const idle = holder('idle', now - 10_000);
    const longBusy = holder('long', now - REMOTE_KEEP.idleMs * 3, true);
    const out = remoteToRelease([...busy, idle, longBusy].map((h) => h.api), now).map((h) => h.id);
    expect(out).toEqual(['idle']);
  });
});

describe('the keeper', () => {
  it('releases a chat once it has been idle for idleMs, and not before', () => {
    const a = holder('a', Date.now());
    holdRemote(a.api);
    vi.advanceTimersByTime(REMOTE_KEEP.idleMs - 60_000);
    expect(a.released).toBe(0);
    vi.advanceTimersByTime(2 * 60_000);
    expect(a.released).toBe(1);
  });

  it('a chat used again stays longer', () => {
    const a = holder('a', Date.now());
    holdRemote(a.api);
    vi.advanceTimersByTime(30 * 60_000);
    a.at = Date.now();
    holdRemote(a.api);
    vi.advanceTimersByTime(30 * 60_000);
    expect(a.released).toBe(0);
    vi.advanceTimersByTime(20 * 60_000);
    expect(a.released).toBe(1);
  });

  it('a seventh chat releases the least recently used idle one at once', () => {
    const hs = Array.from({ length: REMOTE_KEEP.max }, (_, i) => holder(`s${i}`, Date.now() - (REMOTE_KEEP.max - i) * 1000));
    for (const h of hs) holdRemote(h.api);
    expect(hs.every((h) => h.released === 0)).toBe(true);
    const fresh = holder('fresh', Date.now());
    holdRemote(fresh.api);
    expect(hs[0].released).toBe(1);
    expect(hs.slice(1).every((h) => h.released === 0)).toBe(true);
    expect(fresh.released).toBe(0);
  });

  it('a busy chat is looked at again later and released once idle and old', () => {
    const a = holder('a', Date.now(), true);
    holdRemote(a.api);
    vi.advanceTimersByTime(REMOTE_KEEP.idleMs + 60_000);
    expect(a.released).toBe(0);
    a.isBusy = false;
    vi.advanceTimersByTime(REMOTE_KEEP.idleMs + 60_000);
    expect(a.released).toBe(1);
  });

  it('dropped chats are never released by the keeper', () => {
    const a = holder('a', Date.now());
    holdRemote(a.api);
    dropRemote(a.api);
    vi.advanceTimersByTime(REMOTE_KEEP.idleMs * 2);
    enforceRemote();
    expect(a.released).toBe(0);
  });
});
