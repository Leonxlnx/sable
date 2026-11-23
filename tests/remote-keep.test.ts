/** The Remote Control keeper (server/core/remote-keep.ts): only recently used chats keep their agent process. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_KEEP, enforceRemote, holdRemote, dropRemote, idleSince, remoteToRelease, resetRemoteKeeper, type RemoteHolder } from '../server/core/remote-keep';
import { authGate } from '../server/core/auth-gate';

function holder(id: string, lastActive: number, busy = false) {
  const h = { id, at: lastActive, isBusy: busy, released: 0, decline: false };
  const api: RemoteHolder = {
    id,
    lastActive: () => h.at,
    busy: () => h.isBusy,
    release: () => {
      if (h.decline) return false;
      h.released++;
    },
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
  vi.restoreAllMocks();
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

describe('after a sleep', () => {
  it('idleness counts from the wake, not from the last use before the sleep', () => {
    const now = Date.now();
    const a = holder('a', now - 3 * 3600_000);
    expect(remoteToRelease([a.api], now, REMOTE_KEEP, now - 60_000)).toEqual([]);
    expect(remoteToRelease([a.api], now + REMOTE_KEEP.idleMs, REMOTE_KEEP, now - 60_000).map((h) => h.id)).toEqual(['a']);
  });

  it("the keeper's late timer is a wake: the chat it would have let go stays for another idleMs", () => {
    // The auth gate is shared by the whole process: its wake is played here, not recorded in it.
    vi.spyOn(authGate, 'noteTimer').mockImplementation((expectedAt: number, now = Date.now()) => now - expectedAt > 60_000);
    vi.spyOn(authGate, 'waking').mockReturnValue(false);
    const a = holder('a', Date.now());
    holdRemote(a.api);
    vi.advanceTimersByTime(30 * 60_000);
    // The laptop sleeps for three hours: the timer fires late, when it wakes.
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    vi.advanceTimersByTime(16 * 60_000);
    expect(a.released).toBe(0);
    expect(idleSince(a.at)).toBeGreaterThan(a.at);
    vi.advanceTimersByTime(REMOTE_KEEP.idleMs - 10 * 60_000);
    expect(a.released).toBe(0);
    vi.advanceTimersByTime(12 * 60_000);
    expect(a.released).toBe(1);
  });

  it('a wake the auth gate saw counts too', () => {
    vi.spyOn(authGate, 'waking').mockReturnValue(true);
    vi.spyOn(authGate, 'afterWake').mockImplementation((fn: () => void) => fn());
    const a = holder('a', Date.now() - REMOTE_KEEP.idleMs - 60_000);
    holdRemote(a.api);
    expect(a.released).toBe(0);
  });
});

describe('a release that waits for its slot', () => {
  function deferred() {
    const due: (() => void)[] = [];
    vi.spyOn(authGate, 'afterWake').mockImplementation((fn: () => void) => void due.push(fn));
    vi.spyOn(authGate, 'waking').mockReturnValue(false);
    return due;
  }

  it('a chat that turned busy meanwhile is held again and still counts toward the max', () => {
    const due = deferred();
    const hs = Array.from({ length: REMOTE_KEEP.max }, (_, i) => holder(`s${i}`, Date.now() - (REMOTE_KEEP.max - i) * 1000));
    for (const h of hs) holdRemote(h.api);
    holdRemote(holder('fresh', Date.now()).api);
    expect(due).toHaveLength(1);
    // A wake turn began in the oldest chat before its slot came.
    hs[0].isBusy = true;
    due.shift()!();
    expect(hs[0].released).toBe(0);
    // Held again: once idle it is the one over the max, and goes.
    hs[0].isBusy = false;
    enforceRemote();
    expect(due).toHaveLength(1);
    due.shift()!();
    expect(hs[0].released).toBe(1);
  });

  it('a release the holder declines holds it again', () => {
    const due = deferred();
    const a = holder('a', Date.now() - REMOTE_KEEP.idleMs - 60_000);
    a.decline = true;
    holdRemote(a.api);
    due.shift()!();
    expect(a.released).toBe(0);
    a.decline = false;
    enforceRemote();
    due.shift()!();
    expect(a.released).toBe(1);
  });

  it('a chat dropped while its release waited is not released', () => {
    const due = deferred();
    const a = holder('a', Date.now() - REMOTE_KEEP.idleMs - 60_000);
    holdRemote(a.api);
    dropRemote(a.api);
    a.isBusy = true;
    due.shift()!();
    expect(a.released).toBe(0);
    a.isBusy = false;
    enforceRemote();
    expect(due).toHaveLength(0);
  });
});
