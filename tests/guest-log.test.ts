import { describe, expect, it } from 'vitest';
import { GuestLog, type GuestEvent } from '../electron/guest-log';

const G = 7;
const docOf = (evs: GuestEvent[], type: GuestEvent['type']) => evs.filter((e) => e.type === type).map((e) => e.doc);

describe('guest log: every entry carries its own document', () => {
  it('a request begun on A that fails after B committed is A\'s, never B\'s', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    log.begin(G, 100);
    const commit = log.commit(G); // B = 2
    expect(commit).toEqual([{ type: 'doc', id: G, doc: 2 }]);
    log.net(G, log.end(100, G), { url: 'https://a.test/x', method: 'GET', status: 500 });
    log.begin(G, 101);
    log.net(G, log.end(101, G), { url: 'https://b.test/y', method: 'GET', status: 404 });
    const out = log.flush();
    expect(out.filter((e) => e.type === 'net').map((e) => [e.doc, (e as { url: string }).url])).toEqual([
      [1, 'https://a.test/x'],
      [2, 'https://b.test/y'],
    ]);
  });

  it('the main-frame request of A -> B (never begun, as main.ts skips mainFrame) that answers 404 after B committed is B\'s; a sub-resource begun on A is still A\'s', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    log.begin(G, 200); // a sub-resource of A; the main-frame request 201 is not begun
    log.commit(G); // B = 2
    log.net(G, log.end(201, G), { url: 'https://b.test/', method: 'GET', status: 404 });
    log.net(G, log.end(200, G), { url: 'https://a.test/img', method: 'GET', error: 'net::ERR_FAILED' });
    expect(log.flush().filter((e) => e.type === 'net').map((e) => [e.doc, (e as { url: string }).url])).toEqual([
      [1, 'https://a.test/img'],
      [2, 'https://b.test/'],
    ]);
  });

  it('a request whose start was not seen reads as the document current when it ended', () => {
    const log = new GuestLog();
    log.commit(G);
    expect(log.end(5, G)).toBe(1);
    log.begin(9, 6); // another guest's request id
    expect(log.end(6, G)).toBe(1);
  });

  it('nothing of the outgoing document\'s tail is lost at commit, and it goes out first', () => {
    const log = new GuestLog();
    log.commit(G); // A
    log.console(G, { level: 'error', text: 'a1' });
    log.begin(G, 1);
    log.net(G, log.end(1, G), { url: 'https://a.test/', method: 'GET', error: 'net::ERR_FAILED' });
    const out = log.commit(G); // B
    expect(out.map((e) => [e.type, e.doc])).toEqual([['console', 1], ['net', 1], ['doc', 2]]);
    expect((out[0] as { lines: { text: string }[] }).lines.map((l) => l.text)).toEqual(['a1']);
    log.console(G, { level: 'log', text: 'b1' });
    expect(docOf(log.flush(), 'console')).toEqual([2]);
    expect(log.flush()).toEqual([]);
  });

  it('entries are bounded: lines and requests per beat counted past the limit, starts remembered up to a cap', () => {
    const log = new GuestLog({ lines: 3, net: 2, requests: 5 });
    for (let i = 0; i < 10; i++) log.console(G, { level: 'log', text: `l${i}` });
    for (let i = 0; i < 6; i++) log.net(G, 0, { url: `https://x.test/${i}`, method: 'GET', status: 500 });
    const out = log.flush();
    const c = out.find((e) => e.type === 'console') as { lines: unknown[]; dropped: number };
    expect(c.lines).toHaveLength(3);
    expect(c.dropped).toBe(7);
    expect(out.filter((e) => e.type === 'net')).toHaveLength(2);
    expect(out.find((e) => e.type === 'net-dropped')).toMatchObject({ count: 4, doc: 0 });
    for (let r = 0; r < 50; r++) log.begin(G, r);
    expect(log.size).toBe(5);
    log.end(49, G);
    expect(log.size).toBe(4);
    log.forget(G);
    expect(log.size).toBe(0);
    expect(log.doc(G)).toBe(0);
  });
});
