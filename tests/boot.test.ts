import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH, LAUNCH_FORMED, launchClock, launchColours, launchGeometry, launchMeasure } from '../src/art/launch-light';

describe('the launch clock', () => {
  it('is real time until the app asks it to hurry', () => {
    for (const t of [0, 50, 200, LAUNCH_FORMED, 2000]) expect(launchClock(t, null)).toBe(t);
    expect(launchClock(80, 120)).toBe(80);
  });

  it('builds the mark faster once hurried, then runs at the real pace again, without a jump', () => {
    const at = 100;
    expect(launchClock(at, at)).toBe(at);
    expect(launchClock(at + 40, at)).toBeCloseTo(at + 40 * LAUNCH.hurry);
    // Whole sooner than it would be at the real pace.
    const whole = at + (LAUNCH_FORMED - at) / LAUNCH.hurry;
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
