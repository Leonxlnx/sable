import { randomBytes } from 'node:crypto';

/**
 * Saved sign-ins, the part that holds a password: decrypting, filling and guarding the submission.
 * It lives in Electron's main process (wired in `electron/sign-in.ts`); nothing here touches
 * Electron, so every rule is tested without a window (`tests/sign-in-gate.test.ts`, and the page
 * scripts in a real browser in `tests/sign-in-page.test.ts`). The bridge (`server/services/sign-ins.ts`)
 * keeps only ciphertext and names; the window never gets a saved password; agent scripts never run in
 * the document that is filled.
 *
 * A sign-in, step by step:
 * 1. `begin`: the window that shows the guest asks for a ticket for the guest's current page. Refused
 *    while the guest has a sign-in under way or a filled document still shown. The hold is armed now
 *    (one id per hold), before anything is filled; the approved address (origin and path) and the
 *    login form (its action and its fields' names, read in an isolated world) are pinned.
 * 2. The person chooses on the visible card. `fill` checks the ticket belongs to that window and hold,
 *    that the guest still shows the same document at the pinned address, then loads the pinned
 *    address again: a fresh credential-entry document no agent script has run in, which must land at
 *    the pinned address. It stamps that document (in an isolated world the page cannot see: the
 *    document's root, the pinned form and its two fields as references), checks the stamped document
 *    is the one it means, and fills there: both values set before any page code runs, then the events,
 *    then the two fields and the form checked again, then a submit only of a same-origin POST that
 *    stays in the page.
 * 3. While the password is in play, every request of that guest that has a body must be a POST to the
 *    exact origin, every request whose address holds the password is cancelled, and a 307 or 308 of
 *    the form's POST to another origin is cancelled (`requestVerdict`, `redirectVerdict`).
 * 4. A new document after the fill releases that hold (and its guard). Nothing else does.
 */

/** `scheme://host[:port]` exactly as a browser compares origins (host lower-cased and in punycode by URL); http and https only. */
export function exactOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4000) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (!u.hostname) return undefined;
  return u.origin;
}

/** Same scheme, host and port, nothing looser: no prefix, no suffix, no default-port guessing beyond URL's own. */
export function sameOrigin(a: unknown, b: unknown): boolean {
  const x = exactOrigin(a);
  return !!x && x === exactOrigin(b);
}

/** Origin and path: what an approval pins (a query or a fragment may change; the page may not). */
export function pageAddress(raw: unknown): string | undefined {
  const o = exactOrigin(raw);
  if (!o) return undefined;
  return o + new URL(raw as string).pathname;
}

/** The address loaded again for the fresh document: the approved one without its fragment. */
const withoutHash = (raw: string) => {
  const u = new URL(raw);
  u.hash = '';
  return u.href;
};

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/** An origin a sign-in may be filled on: https anywhere, http only on this machine. */
export function fillableOrigin(raw: unknown): string | undefined {
  const o = exactOrigin(raw);
  if (!o) return undefined;
  const u = new URL(o);
  if (u.protocol === 'https:') return o;
  return LOCAL.test(u.hostname) ? o : undefined;
}

/* ── the wire ── */

/**
 * application/x-www-form-urlencoded as the URL standard writes it (what a form's POST and a GET
 * form's query carry): UTF-8, every byte but ASCII alphanumerics and `*-._` percent-encoded in upper
 * case, a space as `+`.
 */
export function formEncode(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9*\-._]/.test(c)) out += c;
    else if (b === 0x20) out += '+';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** The forms a password takes on the wire: as typed, form-encoded (the standard's set), percent-encoded, in either hex case. */
export function passwordForms(pw: string): string[] {
  if (!pw) return [];
  const pct = encodeURIComponent(pw);
  const form = formEncode(pw);
  const all = [pw, form, form.replace(/\+/g, '%20'), pct, pct.replace(/%20/g, '+')];
  return [...new Set(all.flatMap((x) => [x, x.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())]))];
}

export interface WireRequest {
  url: string;
  method: string;
  /** The request body's parts as far as Electron gives them; present (even empty) when the request has a body. */
  body?: Uint8Array[];
}

/**
 * The network rule while a password is in play on a guest. It does not depend on recognising the
 * password in a body: every request of that guest that has a body is a POST to the exact origin or
 * is cancelled, and every request whose address holds the password (in any form above) is cancelled.
 */
export function requestVerdict(req: WireRequest, guard: { origin: string; password: string }): 'allow' | 'cancel' {
  const forms = passwordForms(guard.password);
  const url = req.url;
  if (forms.some((f) => url.includes(f)) || safeDecode(url).includes(guard.password)) return 'cancel';
  if (req.body !== undefined) return req.method.toUpperCase() === 'POST' && sameOrigin(url, guard.origin) ? 'allow' : 'cancel';
  return 'allow';
}

/** A redirect while the password is in play: a 307 or 308 (which keeps the method and the body) only to the exact origin. */
export function redirectVerdict(status: number, to: string, guard: { origin: string }): 'allow' | 'cancel' {
  if ((status === 307 || status === 308) && !sameOrigin(to, guard.origin)) return 'cancel';
  return 'allow';
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/* ── the vault: what is encrypted is bound to its entry ── */

/** The plain text that is encrypted: the password with the canonical origin and the user name it belongs to. */
export function sealPlain(origin: string, username: string, password: string): string {
  return JSON.stringify({ v: 2, origin, username, password });
}

/** The password out of a decrypted entry, only when the entry's own origin and user name are the ones inside it. */
export function openPlain(plain: string, origin: string, username: string): string | undefined {
  let x: { v?: unknown; origin?: unknown; username?: unknown; password?: unknown };
  try {
    x = JSON.parse(plain);
  } catch {
    return undefined;
  }
  if (!x || x.v !== 2 || x.origin !== origin || x.username !== username || typeof x.password !== 'string' || !x.password) return undefined;
  return x.password;
}

/* ── the scripts main runs, in an isolated world the page cannot reach ── */

/** The isolated world Sable fills from: its globals and prototypes are its own, per document. */
export const SIGN_IN_WORLD = 1087;

/** The login form as pinned at `begin`: where it sends and what its two fields are called. */
export interface FormPin {
  action: string;
  user: string;
  pass: string;
}

/**
 * Shared by the scripts below: finds the one visible password field and its form, the user name
 * field before it in that form, the submitter, and where and how the form would send (the
 * submitter's formaction, formmethod and formtarget, the form's own, and `<base target>`).
 */
const FIND = `
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const nameOf = (el) => String(el.getAttribute('name') || el.id || '');
  const pick = () => {
    const pw = [...document.querySelectorAll('input[type=password]')].filter((el) => shown(el) && !el.disabled && !el.readOnly);
    if (pw.length !== 1) return { error: pw.length ? 'several' : 'noform' };
    const pass = pw[0];
    const form = pass.form;
    if (!form) return { error: 'noform' };
    const fields = [...form.elements].filter((el) => el.tagName === 'INPUT' && /^(text|email|tel|)$/.test(el.type || '') && shown(el) && !el.disabled && !el.readOnly);
    const before = fields.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
    const user = before.find((el) => /username|email/.test(String(el.autocomplete || ''))) || before[before.length - 1];
    if (!user) return { error: 'nouser' };
    const subs = [...form.elements].filter((el) => (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit') || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image')));
    const sub = subs.find((el) => shown(el) && !el.disabled) || null;
    return { form, user, pass, sub };
  };
  const sends = (form, sub) => {
    const action = sub && sub.hasAttribute('formaction') ? sub.formAction : form.action;
    const method = String(sub && sub.hasAttribute('formmethod') ? sub.formMethod : form.method).toLowerCase();
    const base = document.querySelector('base[target]');
    const target = String(sub && sub.hasAttribute('formtarget') ? sub.getAttribute('formtarget') : form.hasAttribute('target') ? form.getAttribute('target') : base ? base.getAttribute('target') : '').trim().toLowerCase();
    let to = '', bare = '';
    try { const u = new URL(action, location.href); to = u.origin; u.hash = ''; bare = u.href; } catch (e) {}
    return { to, bare, method, target };
  };
  const check = (form, sub, origin) => {
    const s = sends(form, sub);
    if (s.method !== 'post') return 'method';
    if (s.to !== origin) return 'action';
    if (s.target && s.target !== '_self') return 'target';
    return '';
  };
`;

/** At `begin`, in the document the person sees: the login form to pin. */
export function describeScript(origin: string): string {
  return `(() => {${FIND}
  if (window.top !== window || location.origin !== ${JSON.stringify(origin)}) return { error: 'moved' };
  const p = pick();
  if (p.error) return p;
  const bad = check(p.form, p.sub, ${JSON.stringify(origin)});
  if (bad) return { error: bad };
  return { action: sends(p.form, p.sub).bare, user: nameOf(p.user), pass: nameOf(p.pass) };
})()`;
}

/**
 * In the fresh document: finds the pinned form again (same action, same field names), checks it, and
 * keeps the document's root, the form, its fields and the submitter as references in this world, under
 * `nonce`. A document opened anew or a form replaced later no longer matches them.
 */
export function stampScript(nonce: string, origin: string, pin: FormPin): string {
  return `(() => {${FIND}
  if (window.top !== window || location.origin !== ${JSON.stringify(origin)}) return { error: 'moved' };
  const p = pick();
  if (p.error) return p;
  const pin = ${JSON.stringify(pin)};
  if (sends(p.form, p.sub).bare !== pin.action || nameOf(p.user) !== pin.user || nameOf(p.pass) !== pin.pass) return { error: 'otherform' };
  const bad = check(p.form, p.sub, ${JSON.stringify(origin)});
  if (bad) return { error: bad };
  window.__sableSignIn = { nonce: ${JSON.stringify(nonce)}, root: document.documentElement, form: p.form, user: p.user, pass: p.pass, sub: p.sub };
  return { ok: true, origin: location.origin, top: true };
})()`;
}

/**
 * Fills the stamped form and submits it. Every check comes before any value is set; both values are
 * set before any event is dispatched (setting a value runs no page code); after the events the two
 * fields, the form and where it sends are checked again, and only then is it submitted. A refusal
 * before the values answers its reason; one after them answers `changed` (the password may be in the
 * page: the hold stays).
 */
export function fillScript(nonce: string, origin: string, username: string, password: string): string {
  return `(() => {${FIND}
  const s = window.__sableSignIn;
  if (!s || s.nonce !== ${JSON.stringify(nonce)}) return { error: 'replaced' };
  const same = () => window.top === window && location.origin === ${JSON.stringify(origin)} && document.documentElement === s.root && s.form.isConnected && s.user.isConnected && s.pass.isConnected
    && s.user.form === s.form && s.pass.form === s.form && s.user.ownerDocument === document && s.pass.ownerDocument === document && s.pass.type === 'password'
    && (!s.sub || (s.sub.isConnected && s.sub.form === s.form));
  if (!same()) return { error: 'replaced' };
  const bad = check(s.form, s.sub, ${JSON.stringify(origin)});
  if (bad) return { error: bad };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(s.user, ${JSON.stringify(username)});
  setter.call(s.pass, ${JSON.stringify(password)});
  for (const el of [s.user, s.pass]) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (!same() || check(s.form, s.sub, ${JSON.stringify(origin)})) return { error: 'changed' };
  if (s.sub) s.form.requestSubmit(s.sub); else s.form.requestSubmit();
  return { ok: true };
})()`;
}

/** After the submit, in the same stamped document: whether the filled field is still shown and holding a value. */
export function stillThereScript(nonce: string): string {
  return `(() => {
  const s = window.__sableSignIn;
  if (!s || s.nonce !== ${JSON.stringify(nonce)} || document.documentElement !== s.root) return { gone: true };
  const el = s.pass;
  if (!el.isConnected || !el.value) return { gone: true };
  const r = el.getBoundingClientRect();
  return { gone: r.width < 1 || r.height < 1 };
})()`;
}

/** What a refused sign-in tells the agent: plain words, never a value. */
export const FILL_REFUSALS: Record<string, string> = {
  replaced: 'the page was replaced before the sign-in could be filled.',
  moved: 'the page moved to another site before the sign-in.',
  several: 'the page has more than one password field, so Sable does not know which form signs in.',
  noform: 'the page shows no sign-in form.',
  nouser: 'the sign-in form has no user name field.',
  otherform: 'the page shows another sign-in form than the one approved.',
  method: 'the sign-in form does not send with POST, so Sable does not fill it.',
  action: 'the sign-in form sends to another site, so Sable does not fill it.',
  target: 'the sign-in form sends to another window or frame, so Sable does not fill it.',
};
/** After the values were set: the password may be in the page, so the hold stays. */
const CHANGED = 'the sign-in form changed while it was being filled; it was not sent.';

/* ── the gate: tickets, holds and the guard, per guest ── */

/** What the gate needs of a guest page (an Electron webview's webContents in the app; a fake in tests). */
export interface GuestPage {
  id: number;
  /** The window (host webContents) that shows it. */
  hostId: number;
  destroyed(): boolean;
  url(): string;
  /** Loads `url` and resolves once a new document has committed and finished loading. */
  loadFresh(url: string): Promise<void>;
  /** Runs `code` in `SIGN_IN_WORLD` of the current document. */
  isolated(code: string): Promise<unknown>;
}

export interface SignInDeps {
  ships(): boolean;
  canSave(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  /** The entry saved under this id at exactly this origin: its ciphertext and its user name. */
  entryOf(id: string, origin: string): { cipher: string; username: string } | undefined;
  save(origin: string, username: string, cipher: string): void;
  used(id: string): void;
  /** A saved entry whose sealed origin or user name is not its own: reported, never filled. */
  damaged?(id: string): void;
  /** That hold was released (a new document after the fill, or the sign-in ended before any fill). */
  released(guestId: number, holdId: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export type Credential = { kind: 'typed'; username: string; password: string; save: boolean } | { kind: 'saved'; id: string; username: string };

export interface FillResult {
  ok: boolean;
  signedIn?: boolean;
  user?: string;
  /** Plain words for the agent when not signed in. */
  error?: string;
}

interface Ticket {
  id: string;
  holdId: string;
  guestId: number;
  hostId: number;
  origin: string;
  /** The approved address: loaded again for the fresh document; its origin and path must hold. */
  url: string;
  address: string;
  form: FormPin;
  /** The document the approval is for. */
  doc: number;
  expires: number;
}

interface Hold {
  id: string;
  /** The document that may hold the password, once the fill began writing. */
  filledDoc?: number;
}

/** How long a ticket waits for the person. */
export const TICKET_MS = 5 * 60_000;
/** How long the gate waits for the submitted sign-in to leave its form. */
export const SETTLE_MS = 8_000;
const MAX_PASSWORD = 1_000;
const MAX_USERNAME = 200;

export class SignInGate {
  /** Committed main-frame documents per guest: a navigation, a replacement or a crash moves it on. */
  private docs = new Map<number, number>();
  private tickets = new Map<string, Ticket>();
  /** Guests whose page is held: armed at `begin`, released by a new document after the fill. */
  private holds = new Map<number, Hold>();
  /** The password in play per guest, for the network rule, while its hold lasts. */
  private guards = new Map<number, { holdId: string; origin: string; password: string }>();

  constructor(private deps: SignInDeps) {}

  private now = () => this.deps.now?.() ?? Date.now();
  private sleep = (ms: number) => this.deps.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));

  doc(guestId: number): number {
    return this.docs.get(guestId) ?? 0;
  }

  /** A main-frame document committed in the guest (did-navigate, a crash). */
  committed(guestId: number) {
    const doc = this.doc(guestId) + 1;
    this.docs.set(guestId, doc);
    const h = this.holds.get(guestId);
    if (h?.filledDoc !== undefined && doc > h.filledDoc) this.release(guestId, h.id);
  }

  gone(guestId: number) {
    this.docs.delete(guestId);
    this.guards.delete(guestId);
    const h = this.holds.get(guestId);
    if (h) this.release(guestId, h.id);
    for (const [id, t] of this.tickets) if (t.guestId === guestId) this.tickets.delete(id);
  }

  held(guestId: number): boolean {
    return this.holds.has(guestId);
  }

  /** Any guest held: what the bridge asks when an answer cannot say which guest it came from. */
  anyHeld(): boolean {
    return this.holds.size > 0;
  }

  /** Ends exactly that hold; a release meant for another attempt ends nothing. */
  private release(guestId: number, holdId: string) {
    const h = this.holds.get(guestId);
    if (!h || h.id !== holdId) return;
    this.holds.delete(guestId);
    if (this.guards.get(guestId)?.holdId === holdId) this.guards.delete(guestId);
    for (const [id, t] of this.tickets) if (t.holdId === holdId) this.tickets.delete(id);
    this.deps.released(guestId, holdId);
  }

  /** The network rule for one request of a guest. */
  verdict(guestId: number | undefined, req: WireRequest): 'allow' | 'cancel' {
    if (guestId === undefined) return 'allow';
    const g = this.guards.get(guestId);
    return g ? requestVerdict(req, g) : 'allow';
  }

  /** The redirect rule for one redirect of a guest. */
  redirect(guestId: number | undefined, status: number, to: string): 'allow' | 'cancel' {
    if (guestId === undefined) return 'allow';
    const g = this.guards.get(guestId);
    return g ? redirectVerdict(status, to, g) : 'allow';
  }

  /** Step 1: a ticket for what the guest shows now. The hold is armed here; the address and the form are pinned. */
  async begin(hostId: number, guest: GuestPage, origin: string): Promise<{ ticket: string; hold: string; canSave: boolean }> {
    if (!this.deps.ships()) throw new Error('Sign-ins are not available in this version of Sable.');
    if (guest.destroyed() || guest.hostId !== hostId) throw new Error('That page is gone.');
    // One sign-in at a time per page: not while one is under way or a filled document is still shown.
    if (this.holds.has(guest.id)) throw new Error('A sign-in is already under way on this page.');
    const o = fillableOrigin(origin);
    const url = guest.url();
    const address = pageAddress(url);
    if (!o || !address || !sameOrigin(url, o)) throw new Error('The page is not on that site.');
    const hold: Hold = { id: randomBytes(12).toString('hex') };
    this.holds.set(guest.id, hold);
    const doc = this.doc(guest.id);
    const fail = (why: string): never => {
      this.release(guest.id, hold.id);
      throw new Error(why);
    };
    const pin = (await guest.isolated(describeScript(o)).catch(() => null)) as (Partial<FormPin> & { error?: string }) | null;
    if (!pin || pin.error || typeof pin.action !== 'string' || typeof pin.user !== 'string' || typeof pin.pass !== 'string') return fail(FILL_REFUSALS[pin?.error ?? ''] ?? 'the page shows no sign-in form.');
    if (this.doc(guest.id) !== doc || pageAddress(guest.url()) !== address) return fail('the page changed while the sign-in was being prepared.');
    const id = randomBytes(16).toString('hex');
    this.tickets.set(id, { id, holdId: hold.id, guestId: guest.id, hostId, origin: o, url: withoutHash(url), address, form: { action: pin.action, user: pin.user, pass: pin.pass }, doc, expires: this.now() + TICKET_MS });
    return { ticket: id, hold: hold.id, canSave: this.deps.canSave() };
  }

  /** The person said no (or the card went away): the hold ends when nothing was filled. */
  cancel(hostId: number, ticketId: string) {
    const t = this.tickets.get(ticketId);
    if (!t || t.hostId !== hostId) return;
    this.tickets.delete(ticketId);
    const h = this.holds.get(t.guestId);
    if (h && h.id === t.holdId && h.filledDoc === undefined) this.release(t.guestId, h.id);
  }

  /** Step 2: the chosen fill. Answers only whether it signed in, and the user name. */
  async fill(hostId: number, guest: GuestPage, ticketId: string, cred: Credential): Promise<FillResult> {
    const t = this.tickets.get(ticketId);
    const no = (error: string): FillResult => ({ ok: false, error });
    if (!this.deps.ships()) return no('sign-ins are not available in this version of Sable.');
    if (!t || t.hostId !== hostId || t.guestId !== guest.id || guest.hostId !== hostId) return no('the sign-in was not approved for this page.');
    const hold = this.holds.get(guest.id);
    if (!hold || hold.id !== t.holdId) return no('the sign-in was not approved for this page.');
    this.tickets.delete(ticketId);
    const endEarly = (error: string) => {
      if (hold.filledDoc === undefined) this.release(guest.id, hold.id);
      return no(error);
    };
    if (this.now() > t.expires) return endEarly('the sign-in waited too long.');
    if (guest.destroyed()) return endEarly('the page is gone.');
    // The document the person approved is still the one shown, at the pinned address.
    if (this.doc(guest.id) !== t.doc || pageAddress(guest.url()) !== t.address) return endEarly('the page changed before the sign-in.');

    const username = String(cred.username ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_USERNAME);
    if (!username) return endEarly('no user name was given.');
    let password = '';
    if (cred.kind === 'typed') {
      if (typeof cred.password !== 'string' || !cred.password || cred.password.length > MAX_PASSWORD) return endEarly('no password was given.');
      password = cred.password;
    } else {
      const entry = this.deps.entryOf(cred.id, t.origin);
      let plain = '';
      try {
        plain = entry ? this.deps.decrypt(entry.cipher) : '';
      } catch {
        plain = '';
      }
      if (!entry || !plain) return endEarly('the saved sign-in cannot be read on this computer.');
      // Bound to its entry: a ciphertext moved to another origin or user name is refused.
      const opened = openPlain(plain, t.origin, entry.username);
      if (!opened || entry.username !== username) {
        this.deps.damaged?.(cred.id);
        return endEarly('the saved sign-in is damaged and was not used.');
      }
      password = opened;
    }

    // The guard is up before anything could carry the password.
    this.guards.set(guest.id, { holdId: hold.id, origin: t.origin, password });
    const dropGuard = () => {
      if (this.guards.get(guest.id)?.holdId === hold.id) this.guards.delete(guest.id);
    };
    // A fresh credential-entry document at the pinned address: the one the agent's scripts ran in is replaced.
    try {
      await guest.loadFresh(t.url);
    } catch {
      dropGuard();
      return endEarly('the page did not load again for the sign-in.');
    }
    const fresh = this.doc(guest.id);
    if (guest.destroyed() || fresh === t.doc || pageAddress(guest.url()) !== t.address) {
      dropGuard();
      return endEarly('the page went somewhere else when it loaded again.');
    }
    const nonce = randomBytes(16).toString('hex');
    const stamp = (await guest.isolated(stampScript(nonce, t.origin, t.form)).catch(() => null)) as { ok?: boolean; error?: string; origin?: string; top?: boolean } | null;
    if (!stamp?.ok || stamp.top !== true || stamp.origin !== t.origin) {
      dropGuard();
      return endEarly((stamp?.error && FILL_REFUSALS[stamp.error]) || 'the page changed before the sign-in.');
    }
    // The stamped document is the fresh one, at the pinned address, nothing committed since.
    if (this.doc(guest.id) !== fresh || pageAddress(guest.url()) !== t.address) {
      dropGuard();
      return endEarly('the page changed before the sign-in.');
    }
    // From here the password may be in the page: only a new document releases the hold.
    hold.filledDoc = fresh;
    const r = (await guest.isolated(fillScript(nonce, t.origin, username, password)).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!r?.ok) {
      // Refused before any value was set: nothing is in the page, the hold ends.
      if (r?.error && FILL_REFUSALS[r.error]) {
        hold.filledDoc = undefined;
        this.release(guest.id, hold.id);
        return no(FILL_REFUSALS[r.error]);
      }
      return no(r?.error === 'changed' ? CHANGED : 'the sign-in form could not be filled.');
    }

    // Through: a new document came, or the filled field went away. Still there after a while: refused.
    let signedIn = false;
    const until = this.now() + SETTLE_MS;
    while (this.now() < until) {
      await this.sleep(250);
      if (guest.destroyed()) break;
      if (this.doc(guest.id) > fresh) {
        signedIn = true;
        break;
      }
      const still = (await guest.isolated(stillThereScript(nonce)).catch(() => ({ gone: false }))) as { gone?: boolean };
      if (still?.gone) {
        signedIn = true;
        break;
      }
    }
    if (!signedIn) return no('the page still shows the sign-in form; it may have refused the user name or password.');
    if (cred.kind === 'typed' && cred.save && this.deps.canSave()) {
      try {
        this.deps.save(t.origin, username, this.deps.encrypt(sealPlain(t.origin, username, password)));
      } catch {
        /* signed in all the same; nothing saved */
      }
    }
    if (cred.kind === 'saved') this.deps.used(cred.id);
    password = '';
    return { ok: true, signedIn: true, user: username };
  }
}
