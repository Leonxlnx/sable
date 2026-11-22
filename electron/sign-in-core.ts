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
 * 1. `begin`, before any card: refused while the guest is held. The hold is armed (one id per hold);
 *    the page is loaded again at its address, a fresh credential-entry document no agent script has
 *    run in, which must land at that address; main finds its one sign-in form there and stamps it (in
 *    an isolated world the page cannot see: the document's root, the form, its fields, the submitter,
 *    its number of controls). The card shows the address and where the form sends, as main found
 *    them. An unfilled ticket ends by time in main (`TICKET_MS`).
 * 2. The person chooses on the visible card. `fill` checks the ticket belongs to that window, guest
 *    and hold, and that the stamped document is still the one shown at the same address; it fills
 *    there: every check (exact action, same controls, same document) before any value, both values
 *    before any event, everything again after the events, then the submit.
 * 3. While the password is in play, only the approved submission carries a body (the page's own
 *    navigation, a POST to exactly the approved action; a redirect of it judged again by request id),
 *    and no request carries the password in its address or a header (`requestVerdict`, `headerVerdict`).
 * 4. After a fill only the person ends the hold: Continue (they have seen the page) or Close (the page
 *    goes blank first); a page that comes back with the password still in a field is never handed over
 *    by a navigation. `HOLD_MS` closes it by itself. Every outcome is a fixed code (`SIGN_IN_CODES`).
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
  /** Electron's request id: the same request seen again (a redirect) keeps it. */
  id?: number;
  url: string;
  method: string;
  /** 'mainFrame' for the page's own navigation (a form's submission). */
  resourceType?: string;
  /** The request body's parts as far as Electron gives them; present (even empty) when the request has a body. */
  body?: Uint8Array[];
}

/** What a guard knows: the exact submission the person approved, and the password in play. */
export interface Guard {
  origin: string;
  /** The approved form's action: origin, path and query, no fragment. */
  action: string;
  password: string;
  /** Requests already let through as the approved submission (their redirects are judged again by id). */
  passed: Set<number>;
}

/** An address without its fragment, for comparing a request with the approved action. */
export const bareAddress = (raw: string) => {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
};

const holdsPassword = (s: string, password: string) => passwordForms(password).some((f) => s.includes(f)) || safeDecode(s).includes(password);

/**
 * The network rule while a password is in play on a guest. Only the approved submission carries a
 * body: the page's own navigation (`mainFrame`) as a POST to exactly the approved action (origin,
 * path and query). Every other request with a body is cancelled, whatever the body holds; every
 * request whose address holds the password is cancelled. A request seen again under the same id is a
 * redirect: with a body (a 307 or 308 keeps it) it must still be the approved action, so a body that
 * would go anywhere else is cancelled; without a body (a 303) it goes on.
 */
export function requestVerdict(req: WireRequest, guard: Guard): 'allow' | 'cancel' {
  if (holdsPassword(req.url, guard.password)) return 'cancel';
  if (req.body === undefined) return 'allow';
  const ok = req.method.toUpperCase() === 'POST' && req.resourceType === 'mainFrame' && bareAddress(req.url) === guard.action;
  if (!ok) return 'cancel';
  if (typeof req.id === 'number') guard.passed.add(req.id);
  return 'allow';
}

/** Request headers while a password is in play: a header that holds it cancels the request (a bodyless request carries it no other way). */
export function headerVerdict(headers: Record<string, string | string[] | undefined>, guard: Guard): 'allow' | 'cancel' {
  for (const v of Object.values(headers)) {
    const all = Array.isArray(v) ? v : [v ?? ''];
    if (all.some((x) => holdsPassword(String(x), guard.password))) return 'cancel';
  }
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

/** The form as main found it in the fresh document: what the card shows and what the fill must still find. */
export interface FormSeen {
  /** Where it sends (origin, path and query). */
  action: string;
  user: string;
  pass: string;
  /** How many controls the form has: a form whose controls changed is not the one approved. */
  controls: number;
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

/**
 * In the fresh document main loaded: finds the sign-in form, checks it is a same-origin POST that
 * stays in the page, keeps the document's root, the form, its fields and the submitter as references
 * in this world under `nonce`, and says what it found (where the form sends, its fields, how many
 * controls it has) for the card. A document opened anew or a form replaced later no longer matches.
 */
export function stampScript(nonce: string, origin: string): string {
  return `(() => {${FIND}
  if (window.top !== window || location.origin !== ${JSON.stringify(origin)}) return { error: 'moved' };
  const p = pick();
  if (p.error) return p;
  const bad = check(p.form, p.sub, ${JSON.stringify(origin)});
  if (bad) return { error: bad };
  window.__sableSignIn = { nonce: ${JSON.stringify(nonce)}, root: document.documentElement, form: p.form, user: p.user, pass: p.pass, sub: p.sub, controls: p.form.elements.length };
  return { ok: true, origin: location.origin, top: true, action: sends(p.form, p.sub).bare, user: nameOf(p.user), pass: nameOf(p.pass), controls: p.form.elements.length };
})()`;
}

/**
 * Fills the stamped form and submits it. Every check comes before any value is set, among them that
 * the form still sends exactly to the approved action and has the same controls; both values are set
 * before any event is dispatched (setting a value runs no page code); after the events everything is
 * checked again, and only then is it submitted. A refusal before the values answers its reason; one
 * after them answers `changed` (the password may be in the page: the hold stays).
 */
export function fillScript(nonce: string, origin: string, action: string, username: string, password: string): string {
  return `(() => {${FIND}
  const s = window.__sableSignIn;
  if (!s || s.nonce !== ${JSON.stringify(nonce)}) return { error: 'replaced' };
  const same = () => window.top === window && location.origin === ${JSON.stringify(origin)} && document.documentElement === s.root && s.form.isConnected && s.user.isConnected && s.pass.isConnected
    && s.user.form === s.form && s.pass.form === s.form && s.user.ownerDocument === document && s.pass.ownerDocument === document && s.pass.type === 'password'
    && (!s.sub || (s.sub.isConnected && s.sub.form === s.form)) && s.form.elements.length === s.controls;
  const exact = () => !check(s.form, s.sub, ${JSON.stringify(origin)}) && sends(s.form, s.sub).bare === ${JSON.stringify(action)};
  if (!same()) return { error: 'replaced' };
  const bad = check(s.form, s.sub, ${JSON.stringify(origin)});
  if (bad) return { error: bad };
  if (!exact()) return { error: 'otherform' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(s.user, ${JSON.stringify(username)});
  setter.call(s.pass, ${JSON.stringify(password)});
  for (const el of [s.user, s.pass]) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (!same() || !exact()) return { error: 'changed' };
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

/**
 * Every outcome of a sign-in as a fixed code: main answers with these and nothing else, and the
 * bridge turns them into the agent's words (browser-tool.ts). No free text from a page or a window.
 */
export const SIGN_IN_CODES = [
  'signed-in',
  'cancelled',
  'not-looking',
  'unavailable',
  'busy',
  'not-approved',
  'expired',
  'gone',
  'changed-before',
  'moved-on-load',
  'replaced',
  'moved',
  'several',
  'noform',
  'nouser',
  'otherform',
  'method',
  'action',
  'target',
  'no-user',
  'no-password',
  'unreadable',
  'damaged',
  'changed',
  'failed',
  'still-form',
] as const;
export type SignInCode = (typeof SIGN_IN_CODES)[number];

/** The codes a page script answers with, before any value was set. */
const BEFORE_VALUES: ReadonlySet<string> = new Set(['replaced', 'moved', 'several', 'noform', 'nouser', 'otherform', 'method', 'action', 'target']);

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
  /** That hold was released (by the person, a cancel, a timeout, or before anything was filled). */
  released(guestId: number, holdId: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** A timer (tests give their own). */
  timer?(ms: number, fn: () => void): { cancel(): void };
}

export type Credential = { kind: 'typed'; username: string; password: string; save: boolean } | { kind: 'saved'; id: string; username: string };

export interface FillResult {
  ok: boolean;
  code: SignInCode;
  /** The user name, when signed in. */
  user?: string;
}

export interface BeginResult {
  ticket: string;
  hold: string;
  canSave: boolean;
  /** For the card: the page's address (origin and path) and where its form sends, as main found them. */
  address: string;
  action: string;
}

interface Ticket {
  id: string;
  holdId: string;
  guestId: number;
  hostId: number;
  origin: string;
  address: string;
  action: string;
  nonce: string;
  /** The stamped fresh document. */
  doc: number;
  expires: number;
  timer?: { cancel(): void };
}

interface Hold {
  id: string;
  /** The document that may hold the password, once the fill began writing. */
  filledDoc?: number;
  /** After a fill: ends by the person (continue or close) or by `HOLD_MS`. */
  timer?: { cancel(): void };
}

/** How long a ticket waits for the person; then main cancels it and the hold ends. */
export const TICKET_MS = 3 * 60_000;
/** How long a filled page stays held for the person to look at it; then main closes it. */
export const HOLD_MS = 10 * 60_000;
/** How long the gate waits for the submitted sign-in to leave its form. */
export const SETTLE_MS = 8_000;
const MAX_PASSWORD = 1_000;
const MAX_USERNAME = 200;

const defaultTimer = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class SignInGate {
  /** Committed main-frame documents per guest: a navigation, a replacement or a crash moves it on. */
  private docs = new Map<number, number>();
  private tickets = new Map<string, Ticket>();
  /** Guests whose page is held: armed at `begin`, released only by the person, a cancel or a timeout. */
  private holds = new Map<number, Hold>();
  /** The password in play per guest, for the network rule, while its hold lasts. */
  private guards = new Map<number, Guard & { holdId: string }>();
  /** Holds armed per guest so far: an attestation that saw another number saw a hold begin. */
  private epochs = new Map<number, number>();

  constructor(private deps: SignInDeps) {}

  private now = () => this.deps.now?.() ?? Date.now();
  private sleep = (ms: number) => this.deps.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));
  private timer = (ms: number, fn: () => void) => (this.deps.timer ?? defaultTimer)(ms, fn);

  doc(guestId: number): number {
    return this.docs.get(guestId) ?? 0;
  }

  epoch(guestId: number): number {
    return this.epochs.get(guestId) ?? 0;
  }

  /** A main-frame document committed in the guest (did-navigate, a crash). It releases nothing: a page that comes back with the password still in it stays held. */
  committed(guestId: number) {
    this.docs.set(guestId, this.doc(guestId) + 1);
  }

  gone(guestId: number) {
    this.docs.delete(guestId);
    const h = this.holds.get(guestId);
    if (h) this.release(guestId, h.id);
    this.guards.delete(guestId);
  }

  held(guestId: number): boolean {
    return this.holds.has(guestId);
  }

  /** The hold's id on this guest, if it is held. */
  holdOf(guestId: number): string | undefined {
    return this.holds.get(guestId)?.id;
  }

  /** Any guest held: what the bridge asks when an answer cannot say which guest it came from. */
  anyHeld(): boolean {
    return this.holds.size > 0;
  }

  /** Ends exactly that hold; a release meant for another attempt ends nothing. */
  private release(guestId: number, holdId: string) {
    const h = this.holds.get(guestId);
    if (!h || h.id !== holdId) return;
    h.timer?.cancel();
    this.holds.delete(guestId);
    if (this.guards.get(guestId)?.holdId === holdId) this.guards.delete(guestId);
    for (const [id, t] of this.tickets) {
      if (t.holdId !== holdId) continue;
      t.timer?.cancel();
      this.tickets.delete(id);
    }
    this.deps.released(guestId, holdId);
  }

  /** The network rule for one request of a guest. */
  verdict(guestId: number | undefined, req: WireRequest): 'allow' | 'cancel' {
    if (guestId === undefined) return 'allow';
    const g = this.guards.get(guestId);
    return g ? requestVerdict(req, g) : 'allow';
  }

  /** The header rule for one request of a guest. */
  headers(guestId: number | undefined, headers: Record<string, string | string[] | undefined>): 'allow' | 'cancel' {
    if (guestId === undefined) return 'allow';
    const g = this.guards.get(guestId);
    return g ? headerVerdict(headers, g) : 'allow';
  }

  /**
   * Step 1, before any card: refused while the guest is held. The hold is armed, the page is loaded
   * again at its address (a fresh credential-entry document no agent script has run in, which must
   * land at that address), and main finds and stamps its form there. The card then shows what main
   * found: the address and where the form sends.
   */
  async begin(hostId: number, guest: GuestPage, origin: string): Promise<BeginResult> {
    if (!this.deps.ships()) throw new SignInError('unavailable');
    if (guest.destroyed() || guest.hostId !== hostId) throw new SignInError('gone');
    if (this.holds.has(guest.id)) throw new SignInError('busy');
    const o = fillableOrigin(origin);
    const url = guest.url();
    const address = pageAddress(url);
    if (!o || !address || !sameOrigin(url, o)) throw new SignInError('moved');
    const hold: Hold = { id: randomBytes(12).toString('hex') };
    this.holds.set(guest.id, hold);
    this.epochs.set(guest.id, this.epoch(guest.id) + 1);
    const fail = (code: SignInCode): never => {
      this.release(guest.id, hold.id);
      throw new SignInError(code);
    };
    try {
      await guest.loadFresh(withoutHash(url));
    } catch {
      return fail('moved-on-load');
    }
    const doc = this.doc(guest.id);
    if (guest.destroyed() || pageAddress(guest.url()) !== address) return fail('moved-on-load');
    const nonce = randomBytes(16).toString('hex');
    const seen = (await guest.isolated(stampScript(nonce, o)).catch(() => null)) as (Partial<FormSeen> & { ok?: boolean; error?: string; origin?: string; top?: boolean }) | null;
    if (!seen?.ok || seen.top !== true || seen.origin !== o || typeof seen.action !== 'string') return fail(BEFORE_VALUES.has(seen?.error ?? '') ? (seen!.error as SignInCode) : 'noform');
    if (this.doc(guest.id) !== doc || pageAddress(guest.url()) !== address) return fail('changed-before');
    const id = randomBytes(16).toString('hex');
    const ticket: Ticket = { id, holdId: hold.id, guestId: guest.id, hostId, origin: o, address, action: seen.action, nonce, doc, expires: this.now() + TICKET_MS };
    // An unfilled ticket ends by time in main, whatever the window does (a hidden card, a closed pane).
    ticket.timer = this.timer(TICKET_MS, () => this.cancel(hostId, id));
    this.tickets.set(id, ticket);
    return { ticket: id, hold: hold.id, canSave: this.deps.canSave(), address, action: seen.action };
  }

  /** The person said no (or the card went away, or the ticket ran out): the hold ends when nothing was filled. */
  cancel(hostId: number, ticketId: string) {
    const t = this.tickets.get(ticketId);
    if (!t || t.hostId !== hostId) return;
    t.timer?.cancel();
    this.tickets.delete(ticketId);
    const h = this.holds.get(t.guestId);
    if (h && h.id === t.holdId && h.filledDoc === undefined) this.release(t.guestId, h.id);
  }

  /**
   * After a fill, the person ends the hold: `continue` gives the page back to the agent as it is (they
   * have seen it), `close` first takes the page away (it loads a blank one) so nothing of it reaches the
   * agent. Only the window that hosts the guest, only for the hold it was given.
   */
  async finish(hostId: number, guest: GuestPage, holdId: string, how: 'continue' | 'close') {
    const h = this.holds.get(guest.id);
    if (!h || h.id !== holdId || guest.hostId !== hostId) return false;
    if (how === 'close') await guest.loadFresh('about:blank').catch(() => {});
    this.release(guest.id, holdId);
    return true;
  }

  /** Step 2: the chosen fill. Answers with a fixed code and, when signed in, the user name. */
  async fill(hostId: number, guest: GuestPage, ticketId: string, cred: Credential): Promise<FillResult> {
    const t = this.tickets.get(ticketId);
    const no = (code: SignInCode): FillResult => ({ ok: false, code });
    if (!this.deps.ships()) return no('unavailable');
    if (!t || t.hostId !== hostId || t.guestId !== guest.id || guest.hostId !== hostId) return no('not-approved');
    const hold = this.holds.get(guest.id);
    if (!hold || hold.id !== t.holdId) return no('not-approved');
    t.timer?.cancel();
    this.tickets.delete(ticketId);
    const endEarly = (code: SignInCode) => {
      if (hold.filledDoc === undefined) this.release(guest.id, hold.id);
      return no(code);
    };
    if (this.now() > t.expires) return endEarly('expired');
    if (guest.destroyed()) return endEarly('gone');
    // The stamped document the person approved is still the one shown, at the same address.
    if (this.doc(guest.id) !== t.doc || pageAddress(guest.url()) !== t.address) return endEarly('changed-before');

    const username = String(cred.username ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_USERNAME);
    if (!username) return endEarly('no-user');
    let password = '';
    if (cred.kind === 'typed') {
      if (typeof cred.password !== 'string' || !cred.password || cred.password.length > MAX_PASSWORD) return endEarly('no-password');
      password = cred.password;
    } else {
      const entry = this.deps.entryOf(cred.id, t.origin);
      let plain = '';
      try {
        plain = entry ? this.deps.decrypt(entry.cipher) : '';
      } catch {
        plain = '';
      }
      if (!entry || !plain) return endEarly('unreadable');
      // Bound to its entry: a ciphertext moved to another origin or user name is refused.
      const opened = openPlain(plain, t.origin, entry.username);
      if (!opened || entry.username !== username) {
        this.deps.damaged?.(cred.id);
        return endEarly('damaged');
      }
      password = opened;
    }

    // The guard is up before anything could carry the password: only the approved submission passes.
    this.guards.set(guest.id, { holdId: hold.id, origin: t.origin, action: t.action, password, passed: new Set() });
    // From here the password may be in the page: only the person (or the timeout) ends the hold.
    hold.filledDoc = t.doc;
    hold.timer = this.timer(HOLD_MS, () => void this.finish(hostId, guest, hold.id, 'close'));
    const r = (await guest.isolated(fillScript(t.nonce, t.origin, t.action, username, password)).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!r?.ok) {
      // Refused before any value was set: nothing is in the page, the hold ends.
      if (r?.error && BEFORE_VALUES.has(r.error)) {
        hold.filledDoc = undefined;
        this.release(guest.id, hold.id);
        return no(r.error as SignInCode);
      }
      return no(r?.error === 'changed' ? 'changed' : 'failed');
    }

    // Through: a new document came, or the filled field went away. Still there after a while: refused.
    let signedIn = false;
    const until = this.now() + SETTLE_MS;
    while (this.now() < until) {
      await this.sleep(250);
      if (guest.destroyed()) break;
      if (this.doc(guest.id) > t.doc) {
        signedIn = true;
        break;
      }
      const still = (await guest.isolated(stillThereScript(t.nonce)).catch(() => ({ gone: false }))) as { gone?: boolean };
      if (still?.gone) {
        signedIn = true;
        break;
      }
    }
    if (!signedIn) return no('still-form');
    if (cred.kind === 'typed' && cred.save && this.deps.canSave()) {
      try {
        this.deps.save(t.origin, username, this.deps.encrypt(sealPlain(t.origin, username, password)));
      } catch {
        /* signed in all the same; nothing saved */
      }
    }
    if (cred.kind === 'saved') this.deps.used(cred.id);
    password = '';
    return { ok: true, code: 'signed-in', user: username };
  }
}

/** A refusal of `begin`, carrying only its code (IPC passes the message: the code alone). */
export class SignInError extends Error {
  constructor(readonly code: SignInCode) {
    super(code);
  }
}

/** A code out of an error message from main (the IPC wrapper adds words around it), or 'failed'. */
export function codeOf(message: unknown): SignInCode {
  const m = String(message ?? '');
  const found = SIGN_IN_CODES.filter((c) => new RegExp(`(^|[^a-z-])${c}($|[^a-z-])`).test(m));
  return found.sort((a, b) => b.length - a.length)[0] ?? 'failed';
}

/* ── what the bridge may believe about an answer: attested by main ── */

/** How long an attestation waits for its answer (a card can take minutes). */
export const ATTEST_MS = 6 * 60_000;
const ATTEST_MAX = 2_000;

/**
 * The window asks main for a token before it serves a request of the agent's tools, naming the guest
 * that serves it; main checks the window hosts that guest and notes the guest's hold epoch. The answer
 * carries the token to the bridge, which asks main (in-process, never over the bridge) what it stands
 * for: the guest, whether it is held now or a hold began on it since the request started, and, for a
 * sign-in, main's own outcome as a fixed code. An id a client supplies is never believed: a token is
 * unguessable, single-use, issued only to the app's window over IPC, and it expires.
 */
export class Attestations {
  private tokens = new Map<string, { guestId: number; epoch: number; expires: number; signIn?: { code: SignInCode; user?: string } }>();

  constructor(
    private gate: SignInGate,
    private now: () => number = Date.now,
  ) {}

  issue(guestId: number): string {
    const t = this.now();
    for (const [k, v] of this.tokens) if (v.expires < t) this.tokens.delete(k);
    if (this.tokens.size >= ATTEST_MAX) this.tokens.delete(this.tokens.keys().next().value as string);
    const token = randomBytes(18).toString('hex');
    this.tokens.set(token, { guestId, epoch: this.gate.epoch(guestId), expires: t + ATTEST_MS });
    return token;
  }

  /** Main's outcome of a sign-in, bound to the token of the request it answers and to its guest. */
  record(token: string, guestId: number, code: SignInCode, user?: string) {
    const a = this.tokens.get(token);
    if (a && a.guestId === guestId) a.signIn = { code, ...(code === 'signed-in' && user ? { user } : {}) };
  }

  /** What the token stands for, once: undefined when it is unknown, used or expired. */
  take(token: unknown): { guestId: number; held: boolean; signIn?: { code: SignInCode; user?: string } } | undefined {
    if (typeof token !== 'string') return undefined;
    const a = this.tokens.get(token);
    if (!a) return undefined;
    this.tokens.delete(token);
    if (a.expires < this.now()) return undefined;
    return { guestId: a.guestId, held: this.gate.held(a.guestId) || this.gate.epoch(a.guestId) !== a.epoch, ...(a.signIn ? { signIn: a.signIn } : {}) };
  }
}
