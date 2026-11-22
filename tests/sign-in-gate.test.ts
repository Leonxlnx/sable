import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exactOrigin,
  fillableOrigin,
  formEncode,
  openPlain,
  pageAddress,
  passwordForms,
  redirectVerdict,
  requestVerdict,
  sameOrigin,
  sealPlain,
  SignInGate,
  type GuestPage,
  type SignInDeps,
} from '../electron/sign-in-core';
import { askSignIn } from '../src/features/rail/sign-in';

/**
 * Saved sign-ins in Electron main (electron/sign-in-core.ts), without a window: a fake guest page
 * stands in for the webview (its documents, its address, and what each of main's isolated-world
 * scripts finds there), a fake vault for safeStorage. Made-up sites and secrets only. The page
 * scripts themselves run in a real browser in tests/sign-in-page.test.ts.
 */

const ORIGIN = 'https://portal.example.test';
const PASSWORD = 'made-up pass! 7351&x';
const FORM = { action: `${ORIGIN}/session`, user: 'username', pass: 'password' };

interface Doc {
  path: string;
  origin: string;
  /** What the login form looks like in this document. */
  form: typeof FORM | null;
  stamp?: string;
  filled?: boolean;
}

interface Hooks {
  /** Runs when main asks the page to load again, after the new document committed. */
  onFresh?: (g: Fake) => void;
  /** Runs once the stamp is in, before main goes on (its answer arrives after this). */
  afterStamp?: (g: Fake) => void;
  /** What the fill script answers instead of filling. */
  fill?: () => unknown;
  /** The form main finds in a fresh document. */
  freshForm?: typeof FORM | null;
}

type Fake = GuestPage & { navigate(to: string, sameDocument?: boolean): void; ran: string[]; doc(): Doc };

function fakeGuest(gate: () => SignInGate, id = 7, hooks: Hooks = {}, start = `${ORIGIN}/login`): Fake {
  let url = start;
  const make = (u: string, form: typeof FORM | null = FORM): Doc => ({ path: new URL(u).pathname, origin: new URL(u).origin, form });
  let doc = make(url);
  const ran: string[] = [];
  const g: Fake = {
    id,
    hostId: 1,
    ran,
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
      url = u;
      doc = make(u, hooks.freshForm === undefined ? FORM : hooks.freshForm);
      gate().committed(id);
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
        if (!doc.form) return { error: 'noform' };
        const pin = JSON.parse(/const pin = (\{.*?\});/.exec(code)![1]);
        if (pin.action !== doc.form.action || pin.user !== doc.form.user || pin.pass !== doc.form.pass) return { error: 'otherform' };
        doc.stamp = /nonce: "([a-f0-9]+)"/.exec(code)![1];
        const answer = { ok: true, origin: doc.origin, top: true };
        if (!hooks.afterStamp) return answer;
        // The page moves on after the stamp went in and before main reads its answer.
        setTimeout(() => hooks.afterStamp!(g), 0);
        return new Promise((r) => setTimeout(() => r(answer), 0));
      }
      if (code.includes('return { action: sends(')) return doc.form ? { ...doc.form } : { error: 'noform' };
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
    ...extra,
  };
  const gate = new SignInGate(deps);
  return { gate, released, saved, damaged, seal };
}

const typed = { kind: 'typed' as const, username: 'student.one', password: PASSWORD, save: true };
const fills = (g: Fake) => g.ran.filter((c) => c.includes('setter.call')).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('finding 1 (second review): what is encrypted is bound to its entry', () => {
  it('seals the origin and the user name with the password, and opens only for the same', () => {
    const plain = sealPlain(ORIGIN, 'student.one', PASSWORD);
    expect(openPlain(plain, ORIGIN, 'student.one')).toBe(PASSWORD);
    expect(openPlain(plain, 'https://evil.example.test', 'student.one')).toBeUndefined();
    expect(openPlain(plain, ORIGIN, 'teacher.two')).toBeUndefined();
    expect(openPlain(PASSWORD, ORIGIN, 'student.one')).toBeUndefined();
  });

  it('an entry relabelled in the file (its ciphertext moved to another origin or user) is refused as damaged, never filled', async () => {
    const real = setup();
    // The file says evil.example.test, but what is encrypted says portal.example.test.
    const moved = setup({ entryOf: (id, origin) => (origin === 'https://evil.example.test' ? { cipher: real.seal(ORIGIN, 'student.one', PASSWORD), username: 'student.one' } : undefined) });
    const g = fakeGuest(() => moved.gate, 7, {}, 'https://evil.example.test/login');
    const { ticket } = await moved.gate.begin(1, g, 'https://evil.example.test');
    expect(await moved.gate.fill(1, g, ticket, { kind: 'saved', id: 'aaaaaaaaaaaaaaaa', username: 'student.one' })).toEqual({ ok: false, error: 'the saved sign-in is damaged and was not used.' });
    expect(moved.damaged).toEqual(['aaaaaaaaaaaaaaaa']);
    expect(fills(g)).toBe(0);
    expect(moved.gate.held(7)).toBe(false);
    // Another user name in the file than inside: the same.
    const renamed = setup({ entryOf: () => ({ cipher: real.seal(ORIGIN, 'student.one', PASSWORD), username: 'teacher.two' }) });
    const g2 = fakeGuest(() => renamed.gate);
    const { ticket: t2 } = await renamed.gate.begin(1, g2, ORIGIN);
    expect((await renamed.gate.fill(1, g2, t2, { kind: 'saved', id: 'aaaaaaaaaaaaaaaa', username: 'teacher.two' })).error).toMatch(/damaged/);
    expect(fills(g2)).toBe(0);
  });

  it('a typed sign-in is saved sealed with its origin and user name', async () => {
    const { gate, saved } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = await gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: true, signedIn: true, user: 'student.one' });
    expect(saved).toHaveLength(1);
    const plain = Buffer.from(/^enc\((.*)\)$/.exec(saved[0].cipher)![1], 'base64').toString();
    expect(openPlain(plain, ORIGIN, 'student.one')).toBe(PASSWORD);
  });

  it('a ticket of one guest is nothing on another', async () => {
    const { gate } = setup();
    const a = fakeGuest(() => gate, 7);
    const b = fakeGuest(() => gate, 8);
    const { ticket } = await gate.begin(1, a, ORIGIN);
    expect(await gate.fill(1, b, ticket, typed)).toEqual({ ok: false, error: 'the sign-in was not approved for this page.' });
    expect(fills(b)).toBe(0);
    expect(b.ran.length).toBe(0);
  });
});

describe('finding 2: one sign-in at a time per page, one id per hold', () => {
  it('refuses a second begin while one is pending, and while a filled document is still shown', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { fill: () => ({ error: 'changed' }) });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    await expect(gate.begin(1, g, ORIGIN)).rejects.toThrow(/already under way/);
    await gate.fill(1, g, ticket, typed);
    // The fill wrote, the form is still there: still held, and no second sign-in.
    expect(gate.held(7)).toBe(true);
    await expect(gate.begin(1, g, ORIGIN)).rejects.toThrow(/already under way/);
    // Its guard is still up.
    expect(gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: [new Uint8Array([1])] })).toBe('cancel');
  });

  it('a release names its hold; a commit on another guest releases nothing', async () => {
    const { gate, released } = setup();
    const a = fakeGuest(() => gate, 7);
    const b = fakeGuest(() => gate, 8);
    const { ticket, hold } = await gate.begin(1, a, ORIGIN);
    await gate.fill(1, a, ticket, typed);
    b.navigate(`${ORIGIN}/elsewhere`);
    expect(gate.held(7)).toBe(true);
    a.navigate(`${ORIGIN}/home`);
    expect(gate.held(7)).toBe(false);
    expect(released).toEqual([[7, hold]]);
  });
});

describe('finding 6: the approval pins the login page and its form', () => {
  it('a same-document change of the address between the approval and the fill voids it', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = await gate.begin(1, g, ORIGIN);
    g.navigate(`${ORIGIN}/account/delete`, true);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the page changed before the sign-in.' });
    expect(fills(g)).toBe(0);
  });

  it('the fresh load goes to the pinned address; a redirect to another path voids it', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { onFresh: (x) => x.navigate(`${ORIGIN}/other-login`) });
    const { ticket } = await gate.begin(1, g, `${ORIGIN}`);
    expect((await gate.fill(1, g, ticket, typed)).ok).toBe(false);
    expect(fills(g)).toBe(0);
  });

  it('a fresh document that shows another form than the pinned one is not filled', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { freshForm: { ...FORM, action: `${ORIGIN}/other` } });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the page shows another sign-in form than the one approved.' });
    expect(fills(g)).toBe(0);
  });

  it('a navigation between the stamp and the fill voids it: the fill never runs', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, 7, { afterStamp: (x) => x.navigate(`${ORIGIN}/login`) });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the page changed before the sign-in.' });
    expect(fills(g)).toBe(0);
  });

  it('a stamped document replaced before the fill is not filled (the fill script finds no stamp)', async () => {
    const { gate } = setup();
    // Replaced without a commit main could see (as document.open does): the stamp is gone.
    const g = fakeGuest(() => gate, 7, { afterStamp: (x) => void (x.doc().stamp = undefined) });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the page was replaced before the sign-in could be filled.' });
    expect(g.doc().filled).toBeUndefined();
  });

  it('pins origin and path, not the query or the fragment', () => {
    expect(pageAddress(`${ORIGIN}/login?next=%2F#x`)).toBe(`${ORIGIN}/login`);
    expect(pageAddress(`${ORIGIN}/Login`)).not.toBe(pageAddress(`${ORIGIN}/login`));
  });
});

describe('finding 7: the network rule holds whatever the body looks like', () => {
  const guard = { origin: ORIGIN, password: PASSWORD };
  const body = (s: string) => [new TextEncoder().encode(s)];

  it('every request with a body is a POST to the exact origin or is cancelled, password recognised or not', () => {
    expect(requestVerdict({ url: `${ORIGIN}/session`, method: 'POST', body: body('anything') }, guard)).toBe('allow');
    expect(requestVerdict({ url: 'https://evil.example.test/collect', method: 'POST', body: body('nothing that looks like it') }, guard)).toBe('cancel');
    expect(requestVerdict({ url: 'https://evil.example.test/collect', method: 'POST', body: [] }, guard)).toBe('cancel');
    expect(requestVerdict({ url: `${ORIGIN}:8443/session`, method: 'POST', body: body('x') }, guard)).toBe('cancel');
    expect(requestVerdict({ url: `${ORIGIN}/session`, method: 'PUT', body: body('x') }, guard)).toBe('cancel');
    expect(requestVerdict({ url: 'https://cdn.example.test/app.js', method: 'GET' }, guard)).toBe('allow');
  });

  it('an address that holds the password, in the form the HTML standard writes it, is cancelled', () => {
    expect(formEncode('made-up pass! 7351&x')).toBe('made-up+pass%21+7351%26x');
    for (const f of passwordForms(PASSWORD)) expect(requestVerdict({ url: `${ORIGIN}/session?password=${f}`, method: 'GET' }, guard), f).toBe('cancel');
    expect(passwordForms(PASSWORD)).toContain('made-up+pass%21+7351%26x');
  });

  it('a 307 or 308 of the form\'s POST goes only to the exact origin', () => {
    expect(redirectVerdict(307, 'https://evil.example.test/x', guard)).toBe('cancel');
    expect(redirectVerdict(308, 'https://evil.example.test/x', guard)).toBe('cancel');
    expect(redirectVerdict(307, `${ORIGIN}/next`, guard)).toBe('allow');
    expect(redirectVerdict(303, 'https://app.example.test/home', guard)).toBe('allow');
  });

  it('the guard is up from before the fresh load until a new document after the fill', async () => {
    const { gate } = setup();
    let seen: string | undefined;
    const g = fakeGuest(() => gate, 7, { onFresh: () => (seen = gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: body('x') })) });
    const { ticket } = await gate.begin(1, g, ORIGIN);
    await gate.fill(1, g, ticket, typed);
    expect(seen).toBe('cancel');
    expect(gate.redirect(7, 307, 'https://evil.example.test/x')).toBe('cancel');
    g.navigate(`${ORIGIN}/home`);
    expect(gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: body('x') })).toBe('allow');
  });
});

describe('finding 4: the hold, in main', () => {
  it('held from begin, through the fill, until a document after the filled one commits; a refusal before any value ends it', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = await gate.begin(1, g, ORIGIN);
    expect(gate.held(7)).toBe(true);
    expect(gate.anyHeld()).toBe(true);
    await gate.fill(1, g, ticket, typed);
    g.doc().filled = false;
    expect(gate.held(7)).toBe(true);
    g.navigate(`${ORIGIN}/home`);
    expect(gate.held(7)).toBe(false);
    const refused = setup();
    const r = fakeGuest(() => refused.gate, 7, { fill: () => ({ error: 'method' }) });
    const { ticket: t2 } = await refused.gate.begin(1, r, ORIGIN);
    expect((await refused.gate.fill(1, r, t2, typed)).error).toMatch(/POST/);
    expect(refused.gate.held(7)).toBe(false);
  });

  it('a begin on a page without a sign-in form ends its own hold at once', async () => {
    const { gate, released } = setup();
    const g = fakeGuest(() => gate);
    g.doc().form = null;
    await expect(gate.begin(1, g, ORIGIN)).rejects.toThrow(/no sign-in form/);
    expect(gate.held(7)).toBe(false);
    expect(released).toHaveLength(1);
  });
});

describe('finding 8: always asked, never picked by a timer', () => {
  it('a single saved sign-in waits for the person for as long as they take', async () => {
    vi.useFakeTimers();
    let answered = false;
    void askSignIn({ tabId: 't1', origin: ORIGIN, saved: [{ id: 'aaaaaaaaaaaaaaaa', origin: ORIGIN, username: 'student.one', createdAt: 0 }], canSave: true }).then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(answered).toBe(false);
  });
});

describe('finding 5 of the first review: origins compared exactly', () => {
  it('scheme, host and port; no prefix, suffix or case games; punycode as the browser has it', () => {
    expect(sameOrigin('https://portal.example.test/a', 'https://portal.example.test/b?x')).toBe(true);
    expect(sameOrigin('https://PORTAL.example.test', 'https://portal.example.test')).toBe(true);
    expect(sameOrigin('https://portal.example.test:443', 'https://portal.example.test')).toBe(true);
    for (const other of ['https://portal.example.test:8443', 'http://portal.example.test', 'https://portal.example.test.evil.test', 'https://login.portal.example.test', 'https://xn--prtal-jua.example.test', 'javascript:alert(1)', '']) expect(sameOrigin(other, ORIGIN)).toBe(false);
    expect(exactOrigin('https://pörtal.example.test')).toBe('https://xn--prtal-jua.example.test');
    expect(fillableOrigin('http://portal.example.test')).toBeUndefined();
    expect(fillableOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
  });

  it('begin refuses a page that is not at the origin asked for, and another window', async () => {
    const { gate } = setup();
    await expect(gate.begin(1, fakeGuest(() => gate, 7, {}, 'https://portal.example.test.evil.test/login'), ORIGIN)).rejects.toThrow();
    await expect(gate.begin(2, fakeGuest(() => gate, 9), ORIGIN)).rejects.toThrow(/gone/);
  });
});
