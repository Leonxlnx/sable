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

  it('the navigation A -> B that answers 404 after B committed is B\'s; a sub-resource begun on A is still A\'s', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    log.begin(G, 200); // a sub-resource of A
    log.begin(G, 201, true); // the navigation's own request, begun while A is current
    log.commit(G); // B = 2
    log.net(G, log.end(201, G), { url: 'https://b.test/', method: 'GET', status: 404 });
    log.net(G, log.end(200, G), { url: 'https://a.test/img', method: 'GET', error: 'net::ERR_FAILED' });
    expect(log.flush().filter((e) => e.type === 'net').map((e) => [e.doc, (e as { url: string }).url])).toEqual([
      [1, 'https://a.test/img'],
      [2, 'https://b.test/'],
    ]);
  });

  it('a page that is itself a 404 and whose answer ends BEFORE it commits waits for its document, then goes out after it', () => {
    // Seen in the packaged app: a small page from a near server ends its request first, then commits.
    const log = new GuestLog();
    log.commit(G); // A = 1
    log.console(G, { level: 'error', text: 'a-last' });
    log.begin(G, 300, true);
    log.net(G, log.end(300, G), { url: 'https://b.test/gone', method: 'GET', status: 404 });
    // A beat passes before the commit: A's line goes out, B's own 404 does not (the window would wipe it at the reset).
    expect(log.flush().map((e) => [e.type, e.doc])).toEqual([['console', 1]]);
    expect(log.flush()).toEqual([]);
    // B commits: the new document, then its own failed request, as B's.
    const out = log.commit(G);
    expect(out.map((e) => [e.type, e.doc])).toEqual([
      ['doc', 2],
      ['net', 2],
    ]);
    expect((out[1] as { url: string; status?: number }).url).toBe('https://b.test/gone');
    expect(log.flush()).toEqual([]);
  });

  it('a navigation that got no answer brings no document: its failure is the current page\'s, at once', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    log.begin(G, 400, true);
    // The address refused: no answer, no commit.
    log.net(G, log.end(400, G, false), { url: 'http://127.0.0.1:1/', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' });
    expect(log.flush().map((e) => [e.type, e.doc])).toEqual([['net', 1]]);
  });

  it('an answer whose page never commits (the engine\'s own error page) settles on the current page; a new navigation drops what still waits', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    // A 404 with nothing in it: the engine shows its error page, which is no commit.
    log.begin(G, 500, true);
    log.net(G, log.end(500, G), { url: 'https://b.test/empty', method: 'GET', status: 404 });
    expect(log.flush()).toEqual([]);
    log.settle(G);
    expect(log.flush().map((e) => [e.type, e.doc, (e as { url?: string }).url])).toEqual([['net', 1, 'https://b.test/empty']]);
    // Nothing waits: settling again says nothing.
    log.settle(G);
    expect(log.flush()).toEqual([]);
    // An answer left waiting when the next navigation starts is not that navigation's.
    log.begin(G, 501, true);
    log.net(G, log.end(501, G), { url: 'https://c.test/one', method: 'GET', status: 500 });
    log.begin(G, 502, true);
    const out = log.commit(G); // the second navigation's document = 2
    expect(out.map((e) => e.type)).toEqual(['doc']);
    expect(log.flush()).toEqual([]);
    // A navigation that redirects begins the same request again: still the document after the one it started on.
    log.begin(G, 503, true);
    log.begin(G, 503, true);
    expect(log.end(503, G)).toBe(3);
  });

  it('a redirected request keeps the document it first started on', () => {
    const log = new GuestLog();
    log.commit(G); // A = 1
    // A keepalive request of A; B commits; then the redirect sends its next hop under the same id.
    log.begin(G, 600);
    log.commit(G); // B = 2
    log.begin(G, 600);
    log.net(G, log.end(600, G), { url: 'https://a.test/moved', method: 'POST', status: 404 });
    expect(log.flush().filter((e) => e.type === 'net').map((e) => e.doc)).toEqual([1]);
    // Another guest's request under an id seen before starts afresh.
    log.begin(G, 601);
    log.begin(9, 601);
    log.commit(9);
    expect(log.end(601, 9)).toBe(0);
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
