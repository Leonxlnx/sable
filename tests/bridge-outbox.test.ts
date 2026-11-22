/**
 * Review wave 10, finding 1: a request the UI was told failed is never sent later. The page's
 * bridge client over a fake socket (frames waiting in the outbox while it connects), and the
 * bridge's own memory of submissions (a retry of a send that went out is answered, not sent again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Submissions } from '../server/core/submissions';

vi.mock('../src/lib/boot', () => ({ takeBootSocket: () => undefined }));

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  answer(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id, ok: true, result }) });
  }
}

const methods = (ws: FakeSocket) => ws.sent.map((f) => (JSON.parse(f) as { method: string; params: { text?: string } }).params.text ?? (JSON.parse(f) as { method: string }).method);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
  vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function client() {
  const { Bridge } = await import('../src/lib/bridge');
  const b = new Bridge();
  b.start();
  return b;
}

describe('the outbox (finding 1)', () => {
  it('a send asked while connecting, whose connection then fails, is not sent by the next one', async () => {
    const b = await client();
    const first = FakeSocket.all[0];
    const sent = b.call('session.send', { sessionId: 's', text: 'run the migration' });
    first.close(); // the connection attempt fails: the composer is told, and puts the words back
    await expect(sent).rejects.toThrow(/lost/);
    vi.advanceTimersByTime(400);
    const second = FakeSocket.all[1];
    second.open();
    expect(second.sent).toEqual([]);
  });

  it('a send that timed out while connecting is dropped; one still waiting goes when the socket opens', async () => {
    const b = await client();
    const ws = FakeSocket.all[0];
    const late = b.call('session.send', { sessionId: 's', text: 'timed out' }, 1000);
    vi.advanceTimersByTime(500);
    const live = b.call('session.send', { sessionId: 's', text: 'still wanted' }, 5000);
    vi.advanceTimersByTime(600);
    await expect(late).rejects.toThrow(/timed out/);
    ws.open();
    expect(methods(ws)).toEqual(['still wanted']);
    const id = (JSON.parse(ws.sent[0]) as { id: number }).id;
    ws.answer(id, { ok: true });
    await expect(live).resolves.toEqual({ ok: true });
  });

  it('a reconnect that succeeds sends only what is still asked', async () => {
    const b = await client();
    FakeSocket.all[0].close();
    vi.advanceTimersByTime(400);
    const ws = FakeSocket.all[1];
    const gone = b.call('session.send', { sessionId: 's', text: 'gone' }, 100);
    const kept = b.call('session.send', { sessionId: 's', text: 'kept' }, 10_000);
    vi.advanceTimersByTime(200);
    await expect(gone).rejects.toThrow();
    ws.open();
    expect(methods(ws)).toEqual(['kept']);
    void kept.catch(() => {});
  });
});

describe('submissions on the bridge (finding 1, the connection died after sending)', () => {
  it('a retry with the same id is answered as the first was, without sending again', async () => {
    const subs = new Submissions<{ ok: boolean }>();
    let sends = 0;
    const send = async () => {
      sends++;
      return { ok: true };
    };
    expect(await subs.run('s', 'sub-1', send)).toEqual({ ok: true });
    expect(await subs.run('s', 'sub-1', send)).toEqual({ ok: true });
    expect(sends).toBe(1);
    // Another chat, another id, or none: each runs.
    await subs.run('t', 'sub-1', send);
    await subs.run('s', 'sub-2', send);
    await subs.run('s', undefined, send);
    expect(sends).toBe(4);
  });

  it('a retry while the first still runs waits for it; a refusal is forgotten so its retry runs', async () => {
    const subs = new Submissions<{ ok: boolean }>();
    let sends = 0;
    let release: () => void = () => {};
    const slow = () => {
      sends++;
      return new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })));
    };
    const a = subs.run('s', 'x', slow);
    const b = subs.run('s', 'x', slow);
    release();
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(sends).toBe(1);

    let n = 0;
    const refuse = async () => {
      n++;
      if (n === 1) throw new Error('busy');
      return { ok: n > 2 };
    };
    await expect(subs.run('s', 'y', refuse)).rejects.toThrow('busy');
    expect(await subs.run('s', 'y', refuse)).toEqual({ ok: false });
    expect(await subs.run('s', 'y', refuse)).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it('forgets after its time', async () => {
    let t = 0;
    const subs = new Submissions<{ ok: boolean }>(1000, 500, () => t);
    let sends = 0;
    const send = async () => (sends++, { ok: true });
    await subs.run('s', 'z', send);
    t = 2000;
    await subs.run('s', 'z', send);
    expect(sends).toBe(2);
  });
});
