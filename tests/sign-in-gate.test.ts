import { describe, expect, it } from 'vitest';
import { exactOrigin, fillableOrigin, fillScript, passwordForms, requestVerdict, sameOrigin, SignInGate, stampScript, type GuestPage, type SignInDeps } from '../electron/sign-in-core';
import { originOf as devFrameOrigin } from '../src/features/rail/dev-frame';

/**
 * Saved sign-ins in Electron main (electron/sign-in-core.ts), without a window: a fake guest page
 * stands in for the webview, a fake vault for safeStorage. Made-up sites and secrets only.
 */

const ORIGIN = 'https://portal.example.test';
const PASSWORD = 'made-up-pass 7351&x';

type Doc = { origin: string; stamp?: string; filled?: boolean; formGone?: boolean };

/** A guest whose documents and isolated-world scripts are simulated; `hooks` let a test move it at awkward moments. */
function fakeGuest(gate: () => SignInGate, opts: { hostId?: number; url?: string; fill?: (code: string) => unknown; onFresh?: () => void; onStamp?: () => void } = {}) {
  let url = opts.url ?? `${ORIGIN}/login`;
  let doc: Doc = { origin: new URL(url).origin };
  const ran: string[] = [];
  const page: GuestPage & { navigate(to: string): void; ran: string[]; doc(): Doc } = {
    id: 7,
    hostId: opts.hostId ?? 1,
    destroyed: () => false,
    url: () => url,
    ran,
    doc: () => doc,
    navigate(to: string) {
      url = to;
      doc = { origin: new URL(to).origin };
      gate().committed(7);
    },
    async loadFresh() {
      page.navigate(url);
      opts.onFresh?.();
    },
    async isolated(code: string) {
      ran.push(code);
      if (code.includes('window.__sableSignIn = ')) {
        doc.stamp = /__sableSignIn = "([a-f0-9]+)"/.exec(code)![1];
        opts.onStamp?.();
        return { origin: doc.origin, top: true };
      }
      if (code.includes('requestSubmit')) {
        const nonce = /__sableSignIn !== "([a-f0-9]+)"/.exec(code)![1];
        if (doc.stamp !== nonce) return { error: 'replaced' };
        const r = opts.fill ? opts.fill(code) : { ok: true };
        if ((r as { ok?: boolean }).ok) {
          doc.filled = true;
          doc.formGone = true;
        }
        return r;
      }
      return { gone: !!doc.formGone };
    },
  };
  return page;
}

function setup(extra: Partial<SignInDeps> = {}) {
  const released: number[] = [];
  const saved: { origin: string; username: string; cipher: string }[] = [];
  let t = 0;
  const deps: SignInDeps = {
    ships: () => true,
    canSave: () => true,
    encrypt: (p) => `enc(${Buffer.from(p).toString('base64')})`,
    decrypt: (c) => Buffer.from(/^enc\((.*)\)$/.exec(c)![1], 'base64').toString(),
    cipherOf: (id, origin) => (id === 'aaaaaaaaaaaaaaaa' && origin === ORIGIN ? `enc(${Buffer.from(PASSWORD).toString('base64')})` : undefined),
    save: (origin, username, cipher) => void saved.push({ origin, username, cipher }),
    used: () => {},
    released: (id) => void released.push(id),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    ...extra,
  };
  const gate = new SignInGate(deps);
  return { gate, released, saved };
}

const typed = { kind: 'typed' as const, username: 'student.one', password: PASSWORD, save: true };

describe('finding 1: the secret lives in main, bound to the window and its guest', () => {
  it('a fill needs a ticket of the same window for the same guest; the answer never holds the password', async () => {
    const { gate, saved } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = gate.begin(1, g, ORIGIN);
    // Another window (or a ticket for another page) gets nothing.
    expect(await gate.fill(2, g, ticket, typed)).toMatchObject({ ok: false });
    const { ticket: t2 } = gate.begin(1, g, ORIGIN);
    const r = await gate.fill(1, g, t2, typed);
    expect(r).toEqual({ ok: true, signedIn: true, user: 'student.one' });
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    // Saved encrypted by main, never as typed.
    expect(saved).toHaveLength(1);
    expect(saved[0].cipher).not.toContain(PASSWORD);
    // A ticket is used once.
    expect(await gate.fill(1, g, t2, typed)).toMatchObject({ ok: false });
  });

  it('a saved sign-in is decrypted only in main, for exactly its own origin', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, { kind: 'saved', id: 'aaaaaaaaaaaaaaaa', username: 'student.one' })).toMatchObject({ ok: true, signedIn: true });
    expect(g.ran.some((c) => c.includes(JSON.stringify(PASSWORD)))).toBe(true);
    const other = fakeGuest(() => gate, { url: 'https://portal.example.test:8443/login' });
    const { ticket: t2 } = gate.begin(1, other, 'https://portal.example.test:8443');
    expect(await gate.fill(1, other, t2, { kind: 'saved', id: 'aaaaaaaaaaaaaaaa', username: 'student.one' })).toEqual({ ok: false, error: 'the saved sign-in cannot be read on this computer.' });
  });

  it('nothing is begun while sign-ins do not ship', () => {
    const { gate } = setup({ ships: () => false });
    expect(() => gate.begin(1, fakeGuest(() => gate), ORIGIN)).toThrow(/not available/);
  });
});

describe('finding 2: a fresh credential-entry document, the one approved and stamped', () => {
  it('fills only after loading the page again, and only into the stamped document', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const before = gate.doc(7);
    const { ticket } = gate.begin(1, g, ORIGIN);
    await gate.fill(1, g, ticket, typed);
    // The document the agent's scripts ran in was replaced before the fill.
    expect(gate.doc(7)).toBeGreaterThan(before);
    const stamp = g.ran.findIndex((c) => c.includes('window.__sableSignIn = '));
    const fill = g.ran.findIndex((c) => c.includes('requestSubmit'));
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(fill).toBeGreaterThan(stamp);
  });

  it('a page that navigated between the approval and the fill gets nothing', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate);
    const { ticket } = gate.begin(1, g, ORIGIN);
    g.navigate(`${ORIGIN}/elsewhere`);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the page changed before the sign-in.' });
    expect(g.ran).toHaveLength(0);
  });

  it('a document replaced after the stamp is not filled', async () => {
    const { gate } = setup();
    let g: ReturnType<typeof fakeGuest>;
    g = fakeGuest(() => gate, { onStamp: () => g.navigate(`${ORIGIN}/login`) });
    const { ticket } = gate.begin(1, g, ORIGIN);
    const r = await gate.fill(1, g, ticket, typed);
    expect(r.ok).toBe(false);
    expect(g.ran.some((c) => c.includes('requestSubmit'))).toBe(false);
  });

  it('a reload that lands on another origin is not filled', async () => {
    const { gate } = setup();
    let g: ReturnType<typeof fakeGuest>;
    g = fakeGuest(() => gate, { onFresh: () => g.navigate('https://evil.example.test/login') });
    const { ticket } = gate.begin(1, g, ORIGIN);
    expect((await gate.fill(1, g, ticket, typed)).ok).toBe(false);
    expect(g.ran).toHaveLength(0);
  });
});

describe('finding 3: same-origin POST only', () => {
  it('the fill script refuses GET, another action, a submitter override and another target before setting any value', () => {
    const code = fillScript('n', ORIGIN, 'u', PASSWORD);
    expect(() => new Function(`return ${code}`)).not.toThrow();
    const checks = code.indexOf("if (method !== 'post')");
    expect(checks).toBeGreaterThan(0);
    expect(code.indexOf('set(user,')).toBeGreaterThan(code.indexOf("if (target && target !== '_self')"));
    expect(code).toContain("sub.hasAttribute('formaction')");
    expect(code).toContain("sub.hasAttribute('formmethod')");
    expect(code).toContain("sub.hasAttribute('formtarget')");
  });

  it('on the wire: a request carrying the password goes only as a POST to the exact origin', () => {
    const guard = { origin: ORIGIN, password: PASSWORD };
    const body = (s: string) => [new TextEncoder().encode(s)];
    const form = `username=student.one&password=${encodeURIComponent(PASSWORD).replace(/%20/g, '+')}`;
    expect(requestVerdict({ url: `${ORIGIN}/session`, method: 'POST', body: body(form) }, guard)).toBe('allow');
    expect(requestVerdict({ url: 'https://evil.example.test/collect', method: 'POST', body: body(form) }, guard)).toBe('cancel');
    expect(requestVerdict({ url: 'https://portal.example.test:8443/session', method: 'POST', body: body(form) }, guard)).toBe('cancel');
    expect(requestVerdict({ url: `${ORIGIN}/session?${form}`, method: 'GET' }, guard)).toBe('cancel');
    expect(requestVerdict({ url: `${ORIGIN}/session`, method: 'PUT', body: body(JSON.stringify({ password: PASSWORD })) }, guard)).toBe('cancel');
    // A request without the password is none of the guard's business.
    expect(requestVerdict({ url: 'https://cdn.example.test/app.js', method: 'GET' }, guard)).toBe('allow');
    expect(passwordForms(PASSWORD)).toContain(encodeURIComponent(PASSWORD));
  });

  it('the guard is up from before the fresh load until a new document after the fill', async () => {
    const { gate } = setup();
    let seen: 'allow' | 'cancel' | undefined;
    let g: ReturnType<typeof fakeGuest>;
    g = fakeGuest(() => gate, { onFresh: () => (seen = gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: [new TextEncoder().encode(PASSWORD)] })) });
    const { ticket } = gate.begin(1, g, ORIGIN);
    await gate.fill(1, g, ticket, typed);
    expect(seen).toBe('cancel');
    expect(gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: [new TextEncoder().encode(PASSWORD)] })).toBe('cancel');
    g.navigate(`${ORIGIN}/home`);
    expect(gate.verdict(7, { url: 'https://evil.example.test/x', method: 'POST', body: [new TextEncoder().encode(PASSWORD)] })).toBe('allow');
  });

  it('a form the script refuses ends the sign-in with plain words and releases the hold (nothing was set)', async () => {
    const { gate, released } = setup();
    const g = fakeGuest(() => gate, { fill: () => ({ error: 'method' }) });
    const { ticket } = gate.begin(1, g, ORIGIN);
    expect(await gate.fill(1, g, ticket, typed)).toEqual({ ok: false, error: 'the sign-in form does not send with POST, so Sable does not fill it.' });
    expect(gate.held(7)).toBe(false);
    expect(released).toEqual([7]);
  });
});

describe('finding 4: the hold is armed before the fill and only a new document ends it', () => {
  it('held from begin, through the fill, until a document after the filled one commits', async () => {
    const { gate, released } = setup();
    let heldAtFresh = false;
    let g: ReturnType<typeof fakeGuest>;
    g = fakeGuest(() => gate, { onFresh: () => (heldAtFresh = gate.held(7)) });
    const { ticket } = gate.begin(1, g, ORIGIN);
    expect(gate.held(7)).toBe(true);
    await gate.fill(1, g, ticket, typed);
    expect(heldAtFresh).toBe(true);
    // The input replaced or emptied (a "show password" switch): still held.
    g.doc().filled = false;
    expect(gate.held(7)).toBe(true);
    g.navigate(`${ORIGIN}/home`);
    expect(gate.held(7)).toBe(false);
    expect(released).toEqual([7]);
  });

  it('a fill that throws midway keeps the hold; a cancel before any fill releases it', async () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, { fill: () => { throw new Error('boom'); } });
    const { ticket } = gate.begin(1, g, ORIGIN);
    expect((await gate.fill(1, g, ticket, typed)).ok).toBe(false);
    expect(gate.held(7)).toBe(true);
    const { gate: gate2 } = setup();
    const g2 = fakeGuest(() => gate2);
    const { ticket: t2 } = gate2.begin(1, g2, ORIGIN);
    gate2.cancel(1, t2);
    expect(gate2.held(7)).toBe(false);
  });
});

describe('finding 5: origins compared exactly', () => {
  it('scheme, host and port; no prefix, suffix or case games; punycode as the browser has it', () => {
    expect(sameOrigin('https://portal.example.test/a', 'https://portal.example.test/b?x')).toBe(true);
    expect(sameOrigin('https://PORTAL.example.test', 'https://portal.example.test')).toBe(true);
    expect(sameOrigin('https://portal.example.test:443', 'https://portal.example.test')).toBe(true);
    for (const other of ['https://portal.example.test:8443', 'http://portal.example.test', 'https://portal.example.test.evil.test', 'https://login.portal.example.test', 'https://user@evil.example.test', 'https://xn--prtal-jua.example.test', 'javascript:alert(1)', '']) expect(sameOrigin(other, ORIGIN)).toBe(false);
    expect(exactOrigin('https://pörtal.example.test')).toBe('https://xn--prtal-jua.example.test');
    expect(fillableOrigin('http://portal.example.test')).toBeUndefined();
    expect(fillableOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
    expect(fillableOrigin('http://127.0.0.1.evil.test')).toBeUndefined();
  });

  it('the dev frame takes a page\'s word for where it is only at exactly its own origin', () => {
    expect(devFrameOrigin('http://127.0.0.1:41/x')).toBe('http://127.0.0.1:41');
    expect(devFrameOrigin('http://127.0.0.1:4100/x')).not.toBe(devFrameOrigin('http://127.0.0.1:41/x'));
    expect('http://127.0.0.1:4100/x'.startsWith('http://127.0.0.1:41')).toBe(true);
  });

  it('begin refuses a page that is not at the origin asked for', () => {
    const { gate } = setup();
    const g = fakeGuest(() => gate, { url: 'https://portal.example.test.evil.test/login' });
    expect(() => gate.begin(1, g, ORIGIN)).toThrow();
    expect(() => gate.begin(2, fakeGuest(() => gate), ORIGIN)).toThrow(/gone/);
  });

  it('the stamp script reads the origin from the document itself', () => {
    expect(stampScript('abc')).toContain('location.origin');
  });
});
