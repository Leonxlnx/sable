import { describe, expect, it, vi } from 'vitest';
import {
  Attestations,
  codeOf,
  exactOrigin,
  fillableOrigin,
  formEncode,
  headerVerdict,
  HOLD_MS,
  openPlain,
  pageAddress,
  passwordForms,
  requestVerdict,
  sameOrigin,
  sealPlain,
  SignInGate,
  TICKET_MS,
  type Guard,
  type GuestPage,
  type SignInDeps,
} from '../electron/sign-in-core';
import { askSignIn } from '../src/features/rail/sign-in';

/**
 * Saved sign-ins in Electron main (electron/sign-in-core.ts), without a window: a fake guest page
 * stands in for the webview (its documents, its address, and what each of main's isolated-world
 * scripts finds there), a fake vault for safeStorage, a fake clock and timers. Made-up sites and
 * secrets only. The page scripts themselves run in a real browser in tests/sign-in-page.test.ts.
 */

const ORIGIN = 'https://portal.example.test';
const PASSWORD = 'made-up pass! 7351&x';
const ACTION = `${ORIGIN}/session`;

interface Doc {
  origin: string;
  /** What main finds in this document: the form's action, or none. */
  action: string | null;
  stamp?: string;
  filled?: boolean;
}

interface Hooks {
  /** Runs when main loads the page again, after the new document committed. */
  onFresh?: (g: Fake) => void;
  /** What the fill script answers instead of filling. */
  fill?: () => unknown;
}

type Fake = GuestPage & { navigate(to: string, sameDocument?: boolean): void; ran: string[]; doc(): Doc; loads: string[] };

function fakeGuest(gate: () => SignInGate, id = 7, hooks: Hooks = {}, start = `${ORIGIN}/login`, hostId = 1): Fake {
  let url = start;
  const make = (u: string): Doc => ({ origin: u.startsWith('about:') ? 'null' : new URL(u).origin, action: u.startsWith('about:') ? null : ACTION });
  let doc = make(url);
  const ran: string[] = [];
  const loads: string[] = [];
  const g: Fake = {
    id,
    hostId,
    ran,
    loads,
    doc: () => doc,
    destroyed: () => false,
    url: () => url,
    navigate(to: string, sameDocument = false) {
      url = to;
      if (sameDocument) return;
      doc = make(to);
      gate().committed(id);
    },
    async loadFresh(u: string) {
      loads.push(u);
      g.navigate(u);
      hooks.onFresh?.(g);
    },
    async isolated(code: string) {
      ran.push(code);
      if (code.includes('setter.call')) {
        const nonce = /s\.nonce !== "([a-f0-9]+)"/.exec(code)![1];
        if (doc.stamp !== nonce) return { error: 'replaced' };
        if (hooks.fill) return hooks.fill();
        doc.filled = true;
        return { ok: true };
      }
      if (code.includes('window.__sableSignIn = {')) {
        if (!doc.action) return { error: 'noform' };
        doc.stamp = /nonce: "([a-f0-9]+)"/.exec(code)![1];
        return { ok: true, origin: doc.origin, top: true, action: doc.action, user: 'username', pass: 'password', controls: 3 };
      }
      if (code.includes('return { gone:')) return { gone: !!doc.filled };
      return null;
    },
  };
  return g;
}

function setup(extra: Partial<SignInDeps> = {}) {
  const released: [number, string][] = [];
  const saved: { origin: string; username: string; cipher: string }[] = [];
  const damaged: string[] = [];
  const timers: { at: number; fn: () => void; dead?: boolean }[] = [];
  let t = 0;
  const seal = (o: string, u: string, p: string) => `enc(${Buffer.from(sealPlain(o, u, p)).toString('base64')})`;
  const deps: SignInDeps = {
    ships: () => true,
    canSave: () => true,
    encrypt: (p) => `enc(${Buffer.from(p).toString('base64')})`,
    decrypt: (c) => Buffer.from(/^enc\((.*)\)$/.exec(c)![1], 'base64').toString(),
    entryOf: (id, origin) => (id === 'aaaaaaaaaaaaaaaa' && origin === ORIGIN ? { cipher: seal(ORIGIN, 'student.one', PASSWORD), username: 'student.one' } : undefined),
    save: (origin, username, cipher) => void saved.push({ origin, username, cipher }),
    used: () => {},
    damaged: (id) => void damaged.push(id),
    released: (id, hold) => void released.push([id, hold]),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    timer: (ms, fn) => {
      const x = { at: t + ms, fn };
      timers.push(x);
      return { cancel: () => void ((x as { dead?: boolean }).dead = true) };
    },
    ...extra,
  };
  const gate = new SignInGate(deps);
  /** Moves the fake clock on and runs the timers that are due. */
  const advance = async (ms: number) => {
    t += ms;
    for (const x of timers) if (!x.dead && x.at <= t) {
      x.dead = true;
      x.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return { gate, released, saved, damaged, seal, advance };
}

const typed = { kind: 'typed' as const, username: 'student.one', password: PASSWORD, save: true };
const fills = (g: Fake) => g.ran.filter((c) => c.includes('setter.call')).length;
const guard = (over: Partial<Guard> = {}): Guard => ({ origin: ORIGIN, action: ACTION, password: PASSWORD, passed: new Set(), ...over });
const body = (s: string) => [new TextEncoder().encode(s)];

describe('finding 1 (second review): what is encrypted is bound to its entry', () => {
  it('seals the origin and the user name with the password, and opens only for the same', () => {
    const plain = sealPlain(ORIGIN, 'student.one', PASSWORD);
    expect(openPlain(plain, ORIGIN, 'student.one')).toBe(PASSWORD);
    expect(openPlain(plain, 'https://evil.example.test', 'student.one')).toBeUndefined();
    expect(openPlain(plain, ORIGIN, 'teacher.two')).toBeUndefined();
  });

  it('an entry relabelled in the file is refused as damaged, never filled', async () => {
    const real = setup();
    const moved = setup({ entryOf: (_id, origin) => (origin === 'https://evil.example.test' ? { cipher: real.seal(ORIGIN, 'student.one', PASSWORD), username: 'student.one' } : undefined) });
    const g = fakeGuest(() => moved.gate, 7, {}, 'https://evil.example.test/login');
    g.doc().action = 'https://evil.example.test/session';
    const { ticket } = await moved.gate.begin(1, g, 'https://evil.example.test');
    expect(await moved.gate.fill(1, g, ticket, { kind: 'saved', id: 'aaaaaaaaaaaaaaaa', username: 'student.one' })).toEqual({ ok: false, code: 'damaged' });
    expect(moved.damaged).toEqual(['aaaaaaaaaaaaaaaa']);
    expect(fills(g)).toBe(0);
    expect(moved.gate.held(7)).toBe(false);
  });
});

describe('finding 3: only the approved submission passes the network rule', () => {
  it('a body goes only as the page\'s own POST to exactly the approved action', () => {
    const g = guard();
    expect(requestVerdict({ id: 1, url: ACTION, method: 'POST', resourceType: 'mainFrame', body: body('x') }, g)).toBe('allow');
    // Same origin, another path; the right path from a script (not the page's own navigation); another origin.
    expect(requestVerdict({ id: 2, url: `${ORIGIN}/collect`, method: 'POST', resourceType: 'mainFrame', body: body('x') }, g)).toBe('cancel');
    expect(requestVerdict({ id: 3, url: ACTION, method: 'POST', resourceType: 'xhr', body: body('x') }, g)).toBe('cancel');
    expect(requestVerdict({ id: 4, url: 'https://evil.example.test/session', method: 'POST', resourceType: 'mainFrame', body: body('x') }, g)).toBe('cancel');
    expect(requestVerdict({ id: 5, url: ACTION, method: 'PUT', resourceType: 'mainFrame', body: body('x') }, g)).toBe('cancel');
  });

  it('a redirect of the approved submission is judged again by its request id: a body may only go to the action', () => {
    const g = guard();
    expect(requestVerdict({ id: 9, url: ACTION, method: 'POST', resourceType: 'mainFrame', body: body('x') }, g)).toBe('allow');
    expect(g.passed.has(9)).toBe(true);
    // A 307 keeps the body: to anywhere else it is cancelled. A 303 drops it and goes on.
    expect(requestVerdict({ id: 9, url: 'https://evil.example.test/x', method: 'POST', resourceType: 'mainFrame', body: body('x') }, g)).toBe('cancel');
    expect(requestVerdict({ id: 9, url: `${ORIGIN}/home`, method: 'GET', resourceType: 'mainFrame' }, g)).toBe('allow');
  });

  it('a bodyless request with the password in a header or in its address is refused', () => {
    expect(headerVerdict({ Authorization: `Basic ${PASSWORD}` }, guard())).toBe('cancel');
    expect(headerVerdict({ 'X-Thing': formEncode(PASSWORD) }, guard())).toBe('cancel');
    expect(headerVerdict({ Accept: 'text/html' }, guard())).toBe('allow');
    for (const f of passwordForms(PASSWORD)) expect(requestVerdict({ url: `${ORIGIN}/x?p=${f}`, method: 'GET' }, guard()), f).toBe('cancel');
    expect(formEncode(PASSWORD)).toBe('made-up+pass%21+7351%26x');
  });

  it('the guard holds the approved action from the moment of the fill, per guest', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket, action } = await gate.begin(1, g, ORIGIN);
    expect(action).toBe(ACTION);
    await gate.fill(1, g, ticket, typed);
    expect(gate.verdict(7, { id: 1, url: ACTION, method: 'POST', resourceType: 'mainFrame', body: body('x') })).toBe('allow');
    expect(gate.verdict(7, { id: 2, url: `${ORIGIN}/other`, method: 'POST', resourceType: 'mainFrame', body: body('x') })).toBe('cancel');
    expect(gate.verdict(8, { id: 3, url: `${ORIGIN}/other`, method: 'POST', resourceType: 'mainFrame', body: body('x') })).toBe('allow');
  });
});

describe('finding 4: the bridge believes main, never the answer', () => {
  it('a token stands for the guest main issued it to; a hold that began while the request ran holds the answer back', async () => {
    const { gate } = setup();
    const att = new Attestations(gate);
    const a = fakeGuest(() => gate, 7);
    const tok = att.issue(7);
    expect(att.take(tok)).toEqual({ guestId: 7, held: false });
    // Used once.
    expect(att.take(tok)).toBeUndefined();
    // A request that started before the hold and answers after it began: held, though it carried no claim.
    const early = att.issue(7);
    await gate.begin(1, a, ORIGIN);
    expect(att.take(early)?.held).toBe(true);
    // Another guest's request is its own.
    expect(att.take(att.issue(8))?.held).toBe(false);
    // A made-up token is nobody's.
    expect(att.take('0'.repeat(36))).toBeUndefined();
  });

  it('a sign-in outcome is main\'s fixed code, bound to the token and its guest', () => {
    const { gate } = setup();
    const att = new Attestations(gate);
    const tok = att.issue(7);
    att.record(tok, 8, 'signed-in', 'mallory');
    expect(att.take(tok)?.signIn).toBeUndefined();
    const tok2 = att.issue(7);
    att.record(tok2, 7, 'signed-in', 'student.one');
    expect(att.take(tok2)?.signIn).toEqual({ code: 'signed-in', user: 'student.one' });
    expect(codeOf("Error invoking remote method 'sable:signin-begin': Error: still-form")).toBe('still-form');
    expect(codeOf('free words from somewhere')).toBe('failed');
  });

  it('a token expires', () => {
    let now = 0;
    const { gate } = setup();
    const att = new Attestations(gate, () => now);
    const tok = att.issue(7);
    now += 7 * 60_000;
    expect(att.take(tok)).toBeUndefined();
  });
});

describe('finding 6: the card is for the form main found in the fresh page, checked exactly at submission', () => {
  it('begin loads the page again before any card and answers the address and the action it found', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const before = gate.doc(7);
    const r = await gate.begin(1, g, ORIGIN);
    expect(g.loads).toEqual([`${ORIGIN}/login`]);
    expect(gate.doc(7)).toBeGreaterThan(before);
    expect(r).toMatchObject({ address: `${ORIGIN}/login`, action: ACTION });
  });

  it('the fill script requires exactly the approved action and the same controls, before any value', () => {
    // The page scripts' behaviour is in sign-in-page.test.ts; here: what main passes them.
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    return gate.begin(1, g, ORIGIN).then(async ({ ticket }) => {
      await gate.fill(1, g, ticket, typed);
      const fill = g.ran.find((c) => c.includes('setter.call'))!;
      expect(fill).toContain(JSON.stringify(ACTION));
    });
  });

  it('a navigation between the card and the fill voids it; a same-document change of the address too', async () => {
    const a = setup();
    const g = fakeGuest(() => a.gate);
    const { ticket } = await a.gate.begin(1, g, ORIGIN);
    g.navigate(`${ORIGIN}/login`);
    expect(await a.gate.fill(1, g, ticket, typed)).toEqual({ ok: false, code: 'changed-before' });
    expect(fills(g)).toBe(0);
    const b = setup();
    const h = fakeGuest(() => b.gate);
    const { ticket: t2 } = await b.gate.begin(1, h, ORIGIN);
    h.navigate(`${ORIGIN}/account/delete`, true);
    expect(await b.gate.fill(1, h, t2, typed)).toEqual({ ok: false, code: 'changed-before' });
  });

  it('a stamped document replaced without a commit main could see is not filled', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = await gate.begin(1, g, ORIGIN);
    g.doc().stamp = undefined;
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, code: 'replaced' });
    expect(g.doc().filled).toBeUndefined();
  });

  it('a fresh load that lands on another path voids it before any card', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { onFresh: (x) => x.url() === `${ORIGIN}/login` && x.navigate(`${ORIGIN}/other`) });
    await expect(gate.begin(1, g, ORIGIN)).rejects.toThrow('moved-on-load');
    expect(gate.held(7)).toBe(false);
  });

  it('pins origin and path, not the query or the fragment', () => {
    expect(pageAddress(`${ORIGIN}/login?next=%2F#x`)).toBe(`${ORIGIN}/login`);
  });
});

describe('finding 9 and finding 2: how a hold ends', () => {
  it('an unfilled ticket ends by time in main, and its hold with it', async () => {
    const { gate, released, advance } = setup();
    const g = fakeGuest(() => gate);
    const { hold } = await gate.begin(1, g, ORIGIN);
    await advance(TICKET_MS + 1);
    expect(gate.held(7)).toBe(false);
    expect(released).toEqual([[7, hold]]);
  });

  it('after a fill a new document releases nothing: a page that comes back with the password stays held', async () => {
    const { gate, released } = setup();
    const g = fakeGuest(() => gate);
    const { ticket, hold } = await gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: true, code: 'signed-in', user: 'student.one' });
    g.navigate(`${ORIGIN}/login?error=1`);
    g.navigate(`${ORIGIN}/home`);
    expect(gate.held(7)).toBe(true);
    // Only the person ends it, for that hold, from the window that hosts it.
    expect(await gate.finish(2, g, hold, 'continue')).toBe(false);
    expect(await gate.finish(1, g, 'not-the-hold', 'continue')).toBe(false);
    expect(await gate.finish(1, g, hold, 'continue')).toBe(true);
    expect(gate.held(7)).toBe(false);
    expect(released).toEqual([[7, hold]]);
  });

  it('Close takes the page away before the hold ends; the timeout closes by itself', async () => {
    const { gate, advance } = setup();
    const g = fakeGuest(() => gate);
    const { ticket, hold } = await gate.begin(1, g, ORIGIN);
    await gate.fill(1, g, ticket, typed);
    expect(await gate.finish(1, g, hold, 'close')).toBe(true);
    expect(g.loads.at(-1)).toBe('about:blank');
    const late = setup();
    const h = fakeGuest(() => late.gate);
    const r = await late.gate.begin(1, h, ORIGIN);
    await late.gate.fill(1, h, r.ticket, typed);
    await late.advance(HOLD_MS + 1);
    expect(late.gate.held(7)).toBe(false);
    expect(h.loads.at(-1)).toBe('about:blank');
  });

  it('one sign-in at a time per page; a refusal before any value ends the hold', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { fill: () => ({ error: 'method' }) });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    await expect(gate.begin(1, g, ORIGIN)).rejects.toThrow('busy');
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, code: 'method' });
    expect(gate.held(7)).toBe(false);
  });

  it('a ticket of one guest is nothing on another', async () => {
    const { gate } = setup();
    const a = fakeGuest(() => gate, 7);
    const b = fakeGuest(() => gate, 8);
    const { ticket } = await gate.begin(1, a, ORIGIN);
    expect(await gate.fill(1, b, ticket, typed)).toEqual({ ok: false, code: 'not-approved' });
    expect(b.ran.length).toBe(0);
  });
});

describe('finding 8 of the second review: always asked', () => {
  it('a single saved sign-in waits for the person however long they take', async () => {
    vi.useFakeTimers();
    try {
      let answered = false;
      void askSignIn({ tabId: 't1', origin: ORIGIN, address: `${ORIGIN}/login`, action: ACTION, saved: [{ id: 'aaaaaaaaaaaaaaaa', origin: ORIGIN, username: 'student.one', createdAt: 0 }], canSave: true }).then(() => (answered = true));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answered).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('origins compared exactly', () => {
  it('scheme, host and port; no prefix, suffix or case games; punycode as the browser has it', () => {
    expect(sameOrigin('https://PORTAL.example.test/a', ORIGIN)).toBe(true);
    for (const other of ['https://portal.example.test:8443', 'http://portal.example.test', 'https://portal.example.test.evil.test', 'https://xn--prtal-jua.example.test', '']) expect(sameOrigin(other, ORIGIN)).toBe(false);
    expect(exactOrigin('https://pörtal.example.test')).toBe('https://xn--prtal-jua.example.test');
    expect(fillableOrigin('http://portal.example.test')).toBeUndefined();
  });

  it('begin refuses another window and a page not at the origin', async () => {
    const { gate } = setup();
    await expect(gate.begin(2, fakeGuest(() => gate, 9), ORIGIN)).rejects.toThrow('gone');
    await expect(gate.begin(1, fakeGuest(() => gate, 7, {}, 'https://portal.example.test.evil.test/login'), ORIGIN)).rejects.toThrow('moved');
  });
});
