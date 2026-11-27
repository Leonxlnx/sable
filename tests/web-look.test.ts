import { expect, it } from 'vitest';
import { LOOK_MS, NetworkLook, nextLookIn } from '../server/services/web-look';
import { readRows, servable } from '../server/services/web-networks';

// The cost of web access at rest (found by the first end-to-end run: a 5 s timer started 4 to 5 PowerShell
// processes every 20 s, and every request waited for one of its own).

it('looks every 30 s while a browser is connected, once a minute while nothing is, never in a loop', () => {
  const t = 1_000_000;
  expect(LOOK_MS).toEqual({ fresh: 30_000, idle: 60_000, hold: 120_000 });
  // Counted from the last look's start: a change of network is seen by the first look that begins after it, 30 s at most.
  expect(nextLookIn(t, true, LOOK_MS, t + 2_000)).toBe(28_000);
  expect(nextLookIn(t, false, LOOK_MS, t + 2_000)).toBe(58_000);
  expect(nextLookIn(undefined, true, LOOK_MS, t)).toBe(30_000);
  expect(nextLookIn(undefined, false, LOOK_MS, t)).toBe(60_000);
  // Overdue (the computer slept, or a look ran long): soon, but never sooner than a second.
  expect(nextLookIn(t, true, LOOK_MS, t + 95_000)).toBe(1_000);
  expect(nextLookIn(t, false, LOOK_MS, t + 600_000)).toBe(1_000);
});

function clock() {
  const c = { now: 0 };
  return { c, now: () => c.now };
}

it('keeps a look for 30 s, keeps the last good one through failing looks for two minutes, then has none', async () => {
  const { c, now } = clock();
  const reads = { fail: false, n: 0 };
  const look = new NetworkLook(async () => {
    reads.n++;
    if (reads.fail) throw Error('Command failed: powershell.exe (timed out)');
    return [`look ${reads.n}`];
  }, LOOK_MS, now);
  expect(look.rows()).toBeUndefined();
  expect(look.stale()).toBe(true);
  expect(await look.ask()).toEqual(['look 1']);
  c.now = 29_999;
  expect([look.rows(), look.stale()]).toEqual([['look 1'], false]);
  c.now = 30_000;
  expect([look.rows(), look.stale()]).toEqual([['look 1'], true]);
  reads.fail = true;
  await expect(look.ask()).rejects.toThrow(/timed out/);
  expect(look.failure).toMatch(/timed out/);
  // The failure changes nothing while the last good look holds.
  c.now = 120_000;
  expect(look.rows()).toEqual(['look 1']);
  c.now = 120_001;
  expect(look.rows()).toBeUndefined();
  expect(look.at).toBe(0);
  reads.fail = false;
  expect(await look.ask()).toEqual(['look 3']);
  expect(look.rows()).toEqual(['look 3']);
  expect(look.failure).toBeUndefined();
});

it('runs one look at a time for every caller, and keeps nothing once forgotten', async () => {
  const { c, now } = clock();
  let release!: () => void, runs = 0;
  const look = new NetworkLook(() => { runs++; return new Promise<string[]>(r => { release = () => r([`look ${runs}`]); }); }, LOOK_MS, now);
  const a = look.ask(), b = look.ask();
  expect(look.looking).toBe(true);
  await new Promise(r => setImmediate(r));
  expect(runs).toBe(1);
  release();
  expect(await Promise.all([a, b])).toEqual([['look 1'], ['look 1']]);
  expect(look.runs).toBe(1);
  expect(look.looking).toBe(false);
  // Off while a look runs: what it brings is not kept, and a look asked after is a new one.
  c.now = 5_000;
  const late = look.ask();
  await new Promise(r => setImmediate(r));
  look.forget();
  expect(look.looking).toBe(false);
  const fresh = look.ask();
  await new Promise(r => setImmediate(r));
  expect(runs).toBe(3);
  release();
  await fresh;
  expect(look.rows()).toEqual(['look 3']);
  void late;
});

it('the request that asks for a look is answered before the look starts its process', async () => {
  let started = false;
  const look = new NetworkLook(() => { started = true; return ['row']; });
  const asked = look.ask();
  // Same turn as the request: nothing started yet (a process start holds the thread 10 to 25 ms).
  expect(started).toBe(false);
  await asked;
  expect(started).toBe(true);
});

it('serves on private Wi-Fi and Ethernet only, names the public ones, and never an address two networks claim', () => {
  const rows = readRows([
    { id: 'p1/a1/192.168.1.20', name: 'Home', address: '192.168.1.20', kind: 'wifi' },
    { id: 'p2/a2/192.168.178.33', name: 'Cafe', address: '192.168.178.33', kind: 'wifi', private: false },
    { id: 'p3/a3/10.0.0.5', name: '', address: '10.0.0.5', kind: 'ethernet' },
    { id: 'p4/a4/8.8.8.8', name: 'Odd', address: '8.8.8.8', kind: 'ethernet' },
    { id: 'p5/a5/172.16.0.2', name: 'Same', address: '172.16.0.2' },
    { id: 'p6/a6/172.16.0.2', name: 'Other', address: '172.16.0.2' },
    { id: 7, name: 'Broken', address: '10.0.0.9' },
    'noise',
  ]);
  expect(rows.map(r => r.name)).toEqual(['Home', 'Cafe', 'Ethernet', 'Same', 'Other']);
  const { networks, publicNames } = servable(rows);
  expect(networks).toEqual([
    { id: 'p1/a1/192.168.1.20', name: 'Home', address: '192.168.1.20', kind: 'wifi' },
    { id: 'p3/a3/10.0.0.5', name: 'Ethernet', address: '10.0.0.5', kind: 'ethernet' },
  ]);
  expect(publicNames).toEqual(['Cafe']);
  expect(readRows({ not: 'rows' })).toEqual([]);
});
