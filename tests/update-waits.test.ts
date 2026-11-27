/**
 * A restart for an update that waits says what it waits for, looks again by itself, and can be told to
 * go now (27 Nov: a restart waited ten minutes with nothing running anywhere the person could see, and
 * nothing said why).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState, UpdateWait } from '../shared/protocol';
import { boundedHold, COMMAND_UPDATE_WAIT_MS, STEP_HOLDS_MS, Updater, updateHolds, updateWaits, type UpdateSession } from '../server/services/update';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const release = (version: string, bytes = Buffer.from('installer')) => ({
  tag_name: 'v' + version,
  assets: [{ name: `Sable-Setup-${version}.exe`, browser_download_url: `https://github.com/Leonxlnx/sable/releases/download/v${version}/Sable-Setup-${version}.exe`, size: bytes.length }],
});

function updater(opts: { busy: () => boolean; recheckAt?: () => number | undefined; waits?: () => UpdateWait[] }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-update-waits-'));
  dirs.push(dir);
  const bytes = Buffer.from('installer');
  const fetcher = (async (url: string | URL) => String(url).includes('api.github.com')
    ? new Response(JSON.stringify(release('0.2.5', bytes)), { status: 200 })
    : new Response(bytes, { status: 200 })) as typeof fetch;
  const states: UpdateState[] = [];
  const ran: string[] = [];
  const quit = vi.fn();
  const u = new Updater((s) => states.push(s), { host: { quit }, dir, version: '0.2.4', platform: 'win32', fetch: fetcher, run: (f) => { ran.push(f); }, manual: true, ...opts });
  return { u, states, ran, quit };
}

const chat = (id: string, extra: Partial<UpdateSession> = {}): UpdateSession => ({ meta: { id, status: 'idle' }, turnActive: false, ...extra });

describe('what holds a restart, per chat', () => {
  const now = 10 * COMMAND_UPDATE_WAIT_MS;

  it('names each chat once, by the strongest thing it holds', () => {
    const live = (work: object) => ({ liveWork: () => ({ turn: false, agents: 0, commands: 0, ...work }) });
    const holds = updateHolds([
      chat('rest'),
      chat('turn', { turnActive: true }),
      chat('run', { meta: { id: 'run', status: 'running' } }),
      chat('start', { meta: { id: 'start', status: 'starting' } }),
      chat('asks', { meta: { id: 'asks', status: 'awaiting' } }),
      chat('move', { meta: { id: 'move', status: 'idle', moving: true }, turnActive: true }),
      chat('subs', { meta: { id: 'subs', status: 'idle', background: 3 } }),
      chat('one', { meta: { id: 'one', status: 'idle', background: 1 } }),
      chat('word', { handle: live({ turn: true }) }),
      chat('cmd', { meta: { id: 'cmd', status: 'idle', commands: 2 }, newestCommandAt: now - 60_000 }),
      chat('old', { meta: { id: 'old', status: 'idle', commands: 1 }, newestCommandAt: now - COMMAND_UPDATE_WAIT_MS }),
      chat('grace', { handle: live({ notificationUntil: now + 3000 }) }),
    ], now);
    expect(holds).toEqual([
      { sessionId: 'turn', kind: 'turn' },
      { sessionId: 'run', kind: 'turn' },
      { sessionId: 'start', kind: 'starting' },
      { sessionId: 'asks', kind: 'asks' },
      { sessionId: 'move', kind: 'moving' },
      { sessionId: 'subs', kind: 'agents', count: 3 },
      { sessionId: 'one', kind: 'agents' },
      { sessionId: 'word', kind: 'agent' },
      { sessionId: 'cmd', kind: 'command', count: 2, until: now - 60_000 + COMMAND_UPDATE_WAIT_MS },
      { sessionId: 'grace', kind: 'agent', until: now + 3000 },
    ]);
  });

  it('is the rule the restart itself waits by', () => {
    const cases: UpdateSession[][] = [
      [chat('a')],
      [chat('a', { turnActive: true })],
      [chat('a', { meta: { id: 'a', status: 'idle', commands: 1 }, newestCommandAt: now - 1000 })],
      [chat('a', { meta: { id: 'a', status: 'idle', commands: 1 }, newestCommandAt: now - 1000 }), chat('b', { meta: { id: 'b', status: 'idle', commands: 1 }, newestCommandAt: now - 90_000 })],
      [chat('a', { meta: { id: 'a', status: 'idle', commands: 1 }, newestCommandAt: now - 1000 }), chat('b', { meta: { id: 'b', status: 'awaiting' } })],
    ];
    for (const sessions of cases) {
      const holds = updateHolds(sessions, now);
      const waits = updateWaits(sessions, now);
      expect(waits.busy).toBe(holds.length > 0);
      const byAge = holds.length > 0 && holds.every((h) => h.until !== undefined);
      expect(waits.recheckAt).toBe(byAge ? Math.max(...holds.map((h) => h.until!)) : undefined);
    }
  });
});

describe('a restart that waits', () => {
  it('says what it waits for, says a change once, and clears it when it goes', async () => {
    let waits: UpdateWait[] = [{ sessionId: 'a', kind: 'turn' }];
    const { u, states, ran } = updater({ busy: () => waits.length > 0, waits: () => waits });
    await u.check();
    expect(u.install()).toMatchObject({ pending: true, waits: [{ sessionId: 'a', kind: 'turn' }] });
    const said = states.length;
    u.workChanged();
    u.workChanged();
    expect(states).toHaveLength(said);
    waits = [{ sessionId: 'a', kind: 'agents', count: 2 }];
    u.workChanged();
    expect(states).toHaveLength(said + 1);
    expect(u.state.waits).toEqual([{ sessionId: 'a', kind: 'agents', count: 2 }]);
    waits = [];
    u.workChanged();
    expect(ran).toHaveLength(1);
    await Promise.resolve();
    expect(u.state.pending).toBeUndefined();
    expect(u.state.waits).toBeUndefined();
  });

  it('forgets what it waited for when the person cancels', async () => {
    const { u } = updater({ busy: () => true, waits: () => [{ kind: 'sable' }] });
    await u.check();
    expect(u.install().waits).toEqual([{ kind: 'sable' }]);
    const after = u.install(true);
    expect(after.pending).toBeUndefined();
    expect(after.waits).toBeUndefined();
  });

  it('goes now when the person says so, whatever still works', async () => {
    const busy = vi.fn(() => true);
    const { u, ran, quit } = updater({ busy, waits: () => [{ sessionId: 'a', kind: 'turn' }] });
    await u.check();
    expect(u.install().pending).toBe(true);
    expect(ran).toHaveLength(0);
    u.install(false, true);
    expect(ran).toHaveLength(1);
    await Promise.resolve();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(u.state.pending).toBeUndefined();
    // On its way out: a second word starts nothing again.
    u.install(false, true);
    u.workChanged();
    expect(ran).toHaveLength(1);
  });

  it('goes now from rest too, without having waited', async () => {
    const { u, ran } = updater({ busy: () => true });
    await u.check();
    u.install(false, true);
    expect(ran).toHaveLength(1);
  });

  it('notices within a quarter minute that what held it ended without a word', async () => {
    const t0 = Date.now();
    // A young command holds it by its age: the next look would be half an hour away.
    const held: UpdateSession = { meta: { id: 'a', status: 'idle', commands: 1 }, turnActive: false, newestCommandAt: t0 };
    const sessions = [held];
    const { u, ran } = updater({ busy: () => updateWaits(sessions).busy, recheckAt: () => updateWaits(sessions).recheckAt, waits: () => updateHolds(sessions) });
    await u.check();
    vi.useFakeTimers({ now: t0 + 1000 });
    try {
      expect(u.install()).toMatchObject({ pending: true, waits: [{ sessionId: 'a', kind: 'command', until: t0 + COMMAND_UPDATE_WAIT_MS }] });
      // The agent stopped its command; no event of the chat says so.
      held.meta.commands = 0;
      vi.advanceTimersByTime(14_000);
      expect(ran).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      expect(ran).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a step of Sable\'s own', () => {
  it('holds a restart for minutes, not for ever', () => {
    const step = boundedHold(() => true, STEP_HOLDS_MS);
    let t = 0;
    for (; t < STEP_HOLDS_MS; t += 3000) expect(step(t)).toBe(true);
    expect(step(t)).toBe(false);
  });

  it('counts one stretch while someone keeps looking, and starts over after it ended', () => {
    let on = true;
    const step = boundedHold(() => on, 60_000, 10_000);
    let t = 0;
    for (; t < 60_000; t += 3000) expect(step(t)).toBe(true);
    expect(step(t)).toBe(false);
    expect(step(t + 3000)).toBe(false);
    on = false;
    expect(step(t + 6000)).toBe(false);
    on = true;
    expect(step(t + 9000)).toBe(true);
  });

  it('starts over when nobody looked for a while', () => {
    const step = boundedHold(() => true, 60_000, 10_000);
    expect(step(0)).toBe(true);
    expect(step(5000)).toBe(true);
    // An hour later, another wait: the old stretch is not this one's.
    expect(step(3_600_000)).toBe(true);
    expect(step(3_600_000 + 59_000 + 0)).toBe(true);
  });
});
