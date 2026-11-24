/**
 * Phone 2.16: "Connecting" that never recovered. An attempt whose pairing object was replaced while it
 * ran (the saved pairing read a second time: React's development double effect ran `init` twice) was
 * neither current nor superseded: nobody let go of `connecting`, and every later `connect` returned at
 * once. The pure rule (`attemptEnd`) and the look-up that runs once.
 */
import { describe, expect, it, vi } from 'vitest';

const looks = { n: 0 };
vi.mock('../mobile/src/lib/native', () => ({
  loadMark: async () => null,
  saveMark: async () => {},
  eraseNative: async () => [],
  loadPairing: async () => {
    looks.n++;
    return null;
  },
  savePairing: async () => {},
  removePairing: async () => {},
}));
const g = globalThis as Record<string, unknown>;
g.window ??= { setTimeout, clearTimeout, addEventListener: () => {} };
g.document ??= { hidden: false, visibilityState: 'visible', addEventListener: () => {} };

describe('attemptEnd', async () => {
  const { attemptEnd } = await import('../mobile/src/lib/conn');

  it('an attempt still in use reports for itself', () => {
    expect(attemptEnd({ attempt: 3, attemptId: 3, sameGen: true, samePairing: true })).toBe('mine');
  });

  it('a newer attempt reports for an older one', () => {
    expect(attemptEnd({ attempt: 2, attemptId: 3, sameGen: true, samePairing: true })).toBe('superseded');
    expect(attemptEnd({ attempt: 2, attemptId: 3, sameGen: false, samePairing: false })).toBe('superseded');
  });

  it('an attempt whose pairing was replaced under it, with no newer attempt, is orphaned (it must let go and connect again)', () => {
    expect(attemptEnd({ attempt: 1, attemptId: 1, sameGen: true, samePairing: false })).toBe('orphaned');
  });

  it('an attempt of an older credential generation, with no newer attempt, is stale: it lets go, and connects nothing by itself', () => {
    expect(attemptEnd({ attempt: 1, attemptId: 1, sameGen: false, samePairing: true })).toBe('stale');
    expect(attemptEnd({ attempt: 1, attemptId: 1, sameGen: false, samePairing: false })).toBe('stale');
  });
});

describe('init', () => {
  it('looks up the saved pairing once, however often it is called', async () => {
    vi.resetModules();
    looks.n = 0;
    const { conn } = await import('../mobile/src/lib/conn');
    const a = conn.init();
    const b = conn.init();
    expect(b).toBe(a);
    await a;
    expect(looks.n).toBe(1);
    expect(conn.state).toBe('unpaired');
  });
});
