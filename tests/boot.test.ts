import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PORT, preferredPort } from '../electron/port';
import { shortWait } from '../src/art/launch-wait';
import { hurryFactor, LAUNCH, LAUNCH_FORMED, launchClock, launchColours, launchGeometry, launchMeasure } from '../src/art/launch-light';

describe('the launch waits for a chat it starts into, and a key or a click ends that wait', () => {
  /** A wait whose end the test decides, as the launch's look for the chat's first frame. */
  const manual = () => {
    const w = { over: null as (() => void) | null, cancelled: 0 };
    const wait = (over: () => void) => {
      w.over = over;
      return () => void w.cancelled++;
    };
    return { w, wait };
  };

  it('opens when the chat is there', () => {
    const { w, wait } = manual();
    let opened = 0;
    shortWait(wait, () => void opened++);
    expect(opened).toBe(0);
    w.over!();
    expect(opened).toBe(1);
    // Never twice, whatever the wait says afterwards.
    w.over!();
    expect(opened).toBe(1);
  });

  it('opens at once on a key or a click, and the look for the chat stops', () => {
    const { w, wait } = manual();
    let opened = 0;
    const s = shortWait(wait, () => void opened++);
    s.now();
    expect(opened).toBe(1);
    expect(w.cancelled).toBe(1);
    // The chat's frame arriving later opens nothing again.
    w.over!();
    s.now();
    expect(opened).toBe(1);
  });

  it('has nothing to wait for on home, and a cancelled wait never opens', () => {
    let opened = 0;
    // Home: the wait is over straight away.
    const home = shortWait(
      (over) => {
        over();
        return () => {};
      },
      () => void opened++,
    );
    expect(opened).toBe(1);
    home.now();
    expect(opened).toBe(1);
    // The layer went (the effect's cleanup): nothing opens later.
    const { w, wait } = manual();
    const s = shortWait(wait, () => void opened++);
    s.cancel();
    w.over!();
    s.now();
    expect(opened).toBe(1);
    expect(w.cancelled).toBe(1);
  });

  it('is wired to the piece: a key before the app, or during the wait, gives way now', () => {
    const layer = readFileSync('src/art/LaunchLayer.tsx', 'utf8').replace(/\r\n/g, '\n');
    const yieldNow = layer.slice(layer.indexOf('function yieldNow'), layer.indexOf('function end('));
    // Not ready yet: the wait for the chat, if that is all that is waited for, ends here.
    expect(yieldNow).toMatch(/if \(!r\.ready\) \{\s*r\.impatient = true;[^}]*r\.readyNow\?\.\(\);\s*return;/);
    const effect = layer.slice(layer.indexOf('const wait = shortWait(whenViewShown'), layer.indexOf('}, [ready]);'));
    // A key that came before the app was there does not wait for the chat either.
    expect(effect).toMatch(/if \(r\.impatient\) wait\.now\(\);\s*else r\.readyNow = wait\.now;/);
    expect(effect).toMatch(/return \(\) => \{\s*r\.readyNow = null;\s*wait\.cancel\(\);/);
    // The window stops being a drag region when the wait starts, not when it ends: a click on a
    // drag region never reaches the page, so on Windows it could not end the wait.
    const ready = layer.slice(layer.indexOf('if (!ready || !r || r.ready) return;'), layer.indexOf('}, [ready]);'));
    expect(ready.indexOf("r.root.dataset.ready = '';")).toBeGreaterThan(-1);
    expect(ready.indexOf("r.root.dataset.ready = '';")).toBeLessThan(ready.indexOf('shortWait(whenViewShown'));
    expect((layer.match(/r\.root\.dataset\.ready = '';/g) ?? []).length).toBe(1);
    // Words typed into a piece that ended before the chat's composer exists are all kept, not the first letter alone.
    const end = layer.slice(layer.indexOf('function end('), layer.indexOf('let settled = false;'));
    expect(end.indexOf('for (const off of r.off) off();')).toBeLessThan(end.indexOf('if (!silent) keepLateKeys(r);'));
    const late = layer.slice(layer.indexOf('function keepLateKeys'), layer.indexOf('/** A key or a click: the piece gives way at once. */'));
    expect(late).toContain('if (at && at !== document.body) return;');
    expect(late).toContain('r.typed += e.key;');
    const hand = layer.slice(layer.indexOf('function handOver'), layer.indexOf('function keepLateKeys'));
    // The listener goes when the words are in the field, or when no field came.
    expect((hand.match(/over\(\)/g) ?? []).length).toBe(3);
    // The reveal is the crest's own length, and clicks belong to the app a third of the way in.
    expect(layer).toContain('const TRAVEL = 300;');
    expect(LAUNCH.burst).toBe(300);
    expect(layer).toContain("cue(r, L.inhale + Math.round(L.burst * 0.35), () => (r.root.dataset.phase = 'open'));");
  });
});

describe('the port a test app asks for', () => {
  it('is taken when it is a user port Chromium loads from', () => {
    expect(preferredPort('47400')).toBe(47400);
    expect(preferredPort(' 5173 ')).toBe(5173);
    expect(preferredPort('65535')).toBe(65535);
  });

  it('falls back to the app\'s own for a port Chromium refuses, a system port or anything else', () => {
    // ERR_UNSAFE_PORT: the window stayed blank.
    for (const p of ['6000', '6665', '6666', '6667', '6668', '6669', '6697', '10080', '2049', '5060', '5061', '4045', '1719', '1720', '1723', '3659', '4190', '6566', '6679']) expect(preferredPort(p)).toBe(DEFAULT_PORT);
    for (const p of ['80', '1023', '65536', '0', '-1', '47317.5', '0x1f90', '1e4', 'abc', '', undefined]) expect(preferredPort(p)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(47317);
    expect(readFileSync('electron/main.ts', 'utf8')).toContain('const PREFERRED_PORT = preferredPort(process.env.SABLE_PORT);');
  });
});

describe('the launch clock', () => {
  it('is real time until the app asks it to hurry', () => {
    for (const t of [0, 50, 200, LAUNCH_FORMED, 2000]) expect(launchClock(t, null)).toBe(t);
    expect(launchClock(80, 120)).toBe(80);
  });

  it('builds the mark faster once hurried, then runs at the real pace again, without a jump', () => {
    const at = 100;
    expect(launchClock(at, at)).toBe(at);
    expect(launchClock(at + 40, at)).toBeCloseTo(at + 40 * hurryFactor(at));
    // Whole sooner than it would be at the real pace.
    const whole = at + (LAUNCH_FORMED - at) / hurryFactor(at);
    expect(whole).toBeLessThan(LAUNCH_FORMED);
    expect(launchClock(whole, at)).toBeCloseTo(LAUNCH_FORMED);
    expect(launchClock(whole + 100, at) - launchClock(whole, at)).toBeCloseTo(100);
    // Never goes back.
    let last = -1;
    for (let t = 0; t < 1200; t += 7) {
      const c = launchClock(t, at);
      expect(c).toBeGreaterThan(last);
      last = c;
    }
  });

  it('stands whole at most LAUNCH.hurryMax after the hurry, never slower than LAUNCH.hurry times', () => {
    for (const at of [0, 20, 100, 250, LAUNCH_FORMED - 30]) {
      expect(hurryFactor(at)).toBeGreaterThanOrEqual(LAUNCH.hurry);
      expect(launchClock(at + LAUNCH.hurryMax + 0.01, at)).toBeGreaterThanOrEqual(LAUNCH_FORMED);
    }
    // Hurried before its first frame (the app was there first): the whole build within the limit.
    expect(launchClock(LAUNCH.hurryMax, 0)).toBeCloseTo(LAUNCH_FORMED);
  });

  it('changes nothing once the mark already stands', () => {
    expect(launchClock(LAUNCH_FORMED + 300, LAUNCH_FORMED + 10)).toBe(LAUNCH_FORMED + 300);
  });
});

describe('the launch geometry the boot script and the layer share', () => {
  it('measures cells as the layer always did', () => {
    const { cell, geometry } = launchMeasure(1360, 860, 1);
    expect(cell).toBe(7);
    expect(geometry).toEqual(launchGeometry(1360, 860, 7));
    // Whole device pixels at 150 %.
    const hi = launchMeasure(1360, 860, 1.5);
    expect(Math.abs(hi.cell * 1.5 - Math.round(hi.cell * 1.5))).toBeLessThan(1e-9);
  });

  it('reads the colours from the tokens, with fallbacks', () => {
    const css = { getPropertyValue: (k: string) => (k === '--bg' ? ' #070708' : '#eef1f2') } as unknown as CSSStyleDeclaration;
    const c = launchColours(css);
    expect(c.ink).toBe(0xff080707);
    expect(c.ivory).toBe(0xfff2f1ee);
    expect(c.dim >>> 24).toBe(0xff);
    const none = launchColours({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration);
    expect(none.ink).toBe(0xff080707);
  });
});

/* ── the bridge client takes over the socket the boot script opened ── */

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

async function freshBridge(boot: object | undefined) {
  vi.resetModules();
  FakeSocket.made = [];
  const g = globalThis as Record<string, unknown>;
  g.window = { ...(boot ? { __sableBoot: boot } : {}), setTimeout, clearTimeout };
  g.location = { protocol: 'http:', host: '127.0.0.1:47317' };
  g.WebSocket = FakeSocket;
  const { bridge } = await import('../src/lib/bridge');
  return bridge;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.location;
  delete g.WebSocket;
});

describe('the bridge client and the boot socket', () => {
  it('uses the answer to app.hello the boot script already has, and replays what came in order', async () => {
    const ws = new FakeSocket('ws://127.0.0.1:47317/__sable');
    ws.readyState = FakeSocket.OPEN;
    const frames = [JSON.stringify({ event: { type: 'toast', text: 'before', level: 'info' } }), JSON.stringify({ id: 0, ok: true, result: { version: 'x' } }), JSON.stringify({ event: { type: 'toast', text: 'after', level: 'info' } })];
    const boot = { socket: { ws, frames, helloId: 0, asked: true } };
    const bridge = await freshBridge(boot);
    const seen: string[] = [];
    let hello: Promise<unknown> | undefined;
    bridge.on((e) => seen.push((e as { text: string }).text));
    bridge.onStatus((s) => {
      if (s === 'open') hello = bridge.call('app.hello', {});
    });
    bridge.start();
    // No socket of its own: the boot socket is the one.
    expect(FakeSocket.made).toHaveLength(0);
    expect(await hello).toEqual({ version: 'x' });
    expect(seen).toEqual(['before', 'after']);
    // Nothing asked twice; the client's own calls go on the same socket with their own ids.
    expect(ws.sent).toEqual([]);
    void bridge.call('session.list' as never, {} as never).catch(() => {});
    expect(JSON.parse(ws.sent[0]).id).toBe(1);
    expect((boot as { socket?: unknown }).socket).toBeUndefined();
  });

  it('asks app.hello itself when the boot socket had not opened yet', async () => {
    const ws = new FakeSocket('ws://127.0.0.1:47317/__sable');
    const bridge = await freshBridge({ socket: { ws, frames: [], helloId: 0, asked: false } });
    let hello: Promise<unknown> | undefined;
    bridge.onStatus((s) => {
      if (s === 'open') hello = bridge.call('app.hello', {});
    });
    bridge.start();
    expect(hello).toBeUndefined();
    ws.open();
    expect(ws.sent.map((f) => JSON.parse(f))).toEqual([{ id: 0, method: 'app.hello', params: {} }]);
    ws.receive({ id: 0, ok: true, result: { version: 'y' } });
    expect(await hello).toEqual({ version: 'y' });
  });

  it('opens a socket of its own when the boot socket closed or there is none', async () => {
    const ws = new FakeSocket('ws://127.0.0.1:47317/__sable');
    ws.readyState = FakeSocket.CLOSED;
    vi.useFakeTimers();
    try {
      const bridge = await freshBridge({ socket: { ws, frames: [], helloId: 0, asked: true } });
      const states: string[] = [];
      bridge.onStatus((s) => states.push(s));
      bridge.start();
      expect(states).toContain('closed');
      vi.advanceTimersByTime(400);
      expect(FakeSocket.made).toHaveLength(1);
      // The reconnect asks app.hello afresh, with an id of its own.
      void bridge.call('app.hello', {}).catch(() => {});
      FakeSocket.made[0].open();
      expect(JSON.parse(FakeSocket.made[0].sent[0]).id).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
    const none = await freshBridge(undefined);
    none.start();
    expect(FakeSocket.made).toHaveLength(1);
  });
});
