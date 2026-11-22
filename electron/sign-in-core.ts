import { randomBytes } from 'node:crypto';

/**
 * Saved sign-ins, the part that holds a password: decrypting, filling and guarding the submission.
 * It lives in Electron's main process (wired in `electron/sign-in.ts`); nothing here touches
 * Electron, so every rule is tested without a window (`tests/sign-in-gate.test.ts`). The bridge
 * (`server/services/sign-ins.ts`) keeps only ciphertext and names; the page view's renderer never
 * gets a saved password; agent scripts never run in the document that is filled.
 *
 * A sign-in, step by step:
 * 1. `begin`: the window that shows the guest asks for a ticket for the guest's current origin. The
 *    hold is armed now, before anything is filled: from here the agent gets no script, no picture
 *    and no log of that page until a new document replaces the filled one (`held`).
 * 2. The person approves (the card, or a saved sign-in). `fill` checks the ticket belongs to that
 *    window, that the guest still shows the same document and the exact origin, then loads the page
 *    again: a fresh credential-entry document no agent script has run in. It stamps that document
 *    (a nonce in an isolated world the page cannot see), checks again that the stamped document is
 *    the one it means, and fills and submits there, only into a same-origin POST form.
 * 3. While the password is in play, every request of that guest that carries it must be a POST to
 *    the exact origin (`requestVerdict`, from the session's webRequest); anything else is cancelled.
 * 4. A new document after the fill releases the hold and the guard. Nothing else does: an input that
 *    was replaced or emptied leaves the hold on.
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

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/** An origin a sign-in may be filled on: https anywhere, http only on this machine. */
export function fillableOrigin(raw: unknown): string | undefined {
  const o = exactOrigin(raw);
  if (!o) return undefined;
  const u = new URL(o);
  if (u.protocol === 'https:') return o;
  return LOCAL.test(u.hostname) ? o : undefined;
}

/** The forms a password takes on the wire: as typed, percent-encoded, and form-encoded. */
export function passwordForms(pw: string): string[] {
  if (!pw) return [];
  const pct = encodeURIComponent(pw);
  const form = pct.replace(/%20/g, '+');
  return [...new Set([pw, pct, form, pct.toLowerCase(), form.toLowerCase()])].filter((x) => x.length >= Math.min(4, pw.length));
}

export interface WireRequest {
  url: string;
  method: string;
  /** The request body's bytes, as far as they are known. */
  body?: Uint8Array[];
}

/**
 * The network rule while a password is in play: a request that carries it (in its address or its
 * body) goes only as a POST to the approved origin. A GET form would put it in the address (and the
 * address in the agent's next outline); a cross-origin action would hand it to another site.
 */
export function requestVerdict(req: WireRequest, guard: { origin: string; password: string }): 'allow' | 'cancel' {
  const forms = passwordForms(guard.password);
  if (!forms.length) return 'allow';
  const inUrl = forms.some((f) => req.url.includes(f) || safeDecode(req.url).includes(guard.password));
  let inBody = false;
  if (!inUrl && req.body?.length) {
    const text = Buffer.concat(req.body.map((b) => Buffer.from(b))).toString('latin1');
    const utf = Buffer.concat(req.body.map((b) => Buffer.from(b))).toString('utf8');
    inBody = forms.some((f) => text.includes(f) || utf.includes(f));
  }
  if (!inUrl && !inBody) return 'allow';
  if (inUrl) return 'cancel';
  return req.method.toUpperCase() === 'POST' && sameOrigin(req.url, guard.origin) ? 'allow' : 'cancel';
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/* ── the scripts main runs in the fresh document, in an isolated world the page cannot reach ── */

/** The isolated world Sable fills from: its globals and prototypes are its own, per document. */
export const SIGN_IN_WORLD = 1087;

/** Marks the document with a nonce only this world can see, and says where it is. */
export function stampScript(nonce: string): string {
  return `(() => { window.__sableSignIn = ${JSON.stringify(nonce)}; return { origin: location.origin, top: window.top === window }; })()`;
}

/**
 * Finds the one sign-in form of the document, checks it is a same-origin POST (the submitter's own
 * formaction, formmethod and formtarget included), fills it with the native setters of this world and
 * submits it. Runs only in the document `stampScript` marked with `nonce` (a replaced document has
 * no mark), and only while it is still at `origin`.
 */
export function fillScript(nonce: string, origin: string, username: string, password: string): string {
  return `(() => {
  if (window.__sableSignIn !== ${JSON.stringify(nonce)}) return { error: 'replaced' };
  if (window.top !== window || location.origin !== ${JSON.stringify(origin)}) return { error: 'moved' };
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
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
  const action = sub && sub.hasAttribute('formaction') ? sub.formAction : form.action;
  const method = String(sub && sub.hasAttribute('formmethod') ? sub.formMethod : form.method).toLowerCase();
  const target = String(sub && sub.hasAttribute('formtarget') ? sub.formTarget : form.target || '');
  let to = '';
  try { to = new URL(action, location.href).origin; } catch (e) { return { error: 'action' }; }
  if (method !== 'post') return { error: 'method' };
  if (to !== ${JSON.stringify(origin)}) return { error: 'action' };
  if (target && target !== '_self') return { error: 'target' };
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set(user, ${JSON.stringify(username)});
  set(pass, ${JSON.stringify(password)});
  if (sub) form.requestSubmit(sub); else form.requestSubmit();
  return { ok: true };
})()`;
}

/** After the submit, in the same stamped document: whether the password field is still there and holding a value. */
export function stillThereScript(nonce: string): string {
  return `(() => {
  if (window.__sableSignIn !== ${JSON.stringify(nonce)}) return { gone: true };
  const el = [...document.querySelectorAll('input[type=password]')].find((x) => x.value);
  if (!el) return { gone: true };
  const r = el.getBoundingClientRect();
  return { gone: r.width < 1 || r.height < 1 };
})()`;
}

/** What a refused fill tells the agent: plain words, never a value. */
export const FILL_REFUSALS: Record<string, string> = {
  replaced: 'the page was replaced before the sign-in could be filled.',
  moved: 'the page moved to another site before the sign-in.',
  several: 'the page has more than one password field, so Sable does not know which form signs in.',
  noform: 'the page shows no sign-in form.',
  nouser: 'the sign-in form has no user name field.',
  method: 'the sign-in form does not send with POST, so Sable does not fill it.',
  action: 'the sign-in form sends to another site, so Sable does not fill it.',
  target: 'the sign-in form sends to another window, so Sable does not fill it.',
};

/* ── the gate: tickets, the hold and the guard, per guest ── */

/** What the gate needs of a guest page (an Electron webview's webContents in the app; a fake in tests). */
export interface GuestPage {
  id: number;
  /** The window (host webContents) that shows it. */
  hostId: number;
  destroyed(): boolean;
  url(): string;
  /** Loads the current address again and resolves once the new document has finished loading. */
  loadFresh(): Promise<void>;
  /** Runs `code` in `SIGN_IN_WORLD` of the current document. */
  isolated(code: string): Promise<unknown>;
}

export interface SignInDeps {
  ships(): boolean;
  canSave(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  /** The ciphertext saved for this id at exactly this origin. */
  cipherOf(id: string, origin: string): string | undefined;
  save(origin: string, username: string, cipher: string): void;
  used(id: string): void;
  /** The hold was released (a new document after the fill, or the sign-in ended before any fill). */
  released(guestId: number): void;
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
  guestId: number;
  hostId: number;
  origin: string;
  /** The document the approval is for. */
  doc: number;
  expires: number;
  used: boolean;
}

/** How long a ticket waits for the person. */
export const TICKET_MS = 5 * 60_000;
/** How long the gate waits for the submitted sign-in to leave its form. */
export const SETTLE_MS = 8_000;
const MAX_PASSWORD = 1_000;
const MAX_USERNAME = 200;

export class SignInGate {
  /** Committed main-frame documents per guest: a navigation or a replacement moves it on. */
  private docs = new Map<number, number>();
  private tickets = new Map<string, Ticket>();
  /** Guests whose agent tools are held: armed at `begin`, released by a new document after the fill. */
  private holds = new Map<number, { filledDoc?: number }>();
  /** The password in play per guest, for the network rule, while the hold lasts. */
  private guards = new Map<number, { origin: string; password: string }>();

  constructor(private deps: SignInDeps) {}

  private now = () => this.deps.now?.() ?? Date.now();
  private sleep = (ms: number) => this.deps.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));

  doc(guestId: number): number {
    return this.docs.get(guestId) ?? 0;
  }

  /** A main-frame document committed in the guest (did-navigate, a crash, a replacement). */
  committed(guestId: number) {
    const doc = this.doc(guestId) + 1;
    this.docs.set(guestId, doc);
    const h = this.holds.get(guestId);
    if (h?.filledDoc !== undefined && doc > h.filledDoc) this.release(guestId);
  }

  gone(guestId: number) {
    this.docs.delete(guestId);
    this.guards.delete(guestId);
    if (this.holds.delete(guestId)) this.deps.released(guestId);
    for (const [id, t] of this.tickets) if (t.guestId === guestId) this.tickets.delete(id);
  }

  held(guestId: number): boolean {
    return this.holds.has(guestId);
  }

  private release(guestId: number) {
    this.guards.delete(guestId);
    if (this.holds.delete(guestId)) this.deps.released(guestId);
  }

  /** The network rule for one request of a guest. */
  verdict(guestId: number | undefined, req: WireRequest): 'allow' | 'cancel' {
    if (guestId === undefined) return 'allow';
    const g = this.guards.get(guestId);
    return g ? requestVerdict(req, g) : 'allow';
  }

  /** Step 1: a ticket for what the guest shows now; the hold is armed here. */
  begin(hostId: number, guest: GuestPage, origin: string): { ticket: string; canSave: boolean } {
    if (!this.deps.ships()) throw new Error('Sign-ins are not available in this version of Sable.');
    if (guest.destroyed() || guest.hostId !== hostId) throw new Error('That page is gone.');
    const o = fillableOrigin(origin);
    if (!o || !sameOrigin(guest.url(), o)) throw new Error('The page is not on that site.');
    const id = randomBytes(16).toString('hex');
    this.tickets.set(id, { id, guestId: guest.id, hostId, origin: o, doc: this.doc(guest.id), expires: this.now() + TICKET_MS, used: false });
    if (!this.holds.has(guest.id)) this.holds.set(guest.id, {});
    return { ticket: id, canSave: this.deps.canSave() };
  }

  /** The person said no (or the card went away): the hold ends when nothing was filled. */
  cancel(hostId: number, ticketId: string) {
    const t = this.tickets.get(ticketId);
    if (!t || t.hostId !== hostId) return;
    this.tickets.delete(ticketId);
    const h = this.holds.get(t.guestId);
    if (h && h.filledDoc === undefined && ![...this.tickets.values()].some((x) => x.guestId === t.guestId)) this.release(t.guestId);
  }

  /** Step 2: the approved fill. Answers only whether it signed in, and the user name. */
  async fill(hostId: number, guest: GuestPage, ticketId: string, cred: Credential): Promise<FillResult> {
    const t = this.tickets.get(ticketId);
    const no = (error: string): FillResult => ({ ok: false, error });
    if (!this.deps.ships()) return no('sign-ins are not available in this version of Sable.');
    if (!t || t.used || t.hostId !== hostId || t.guestId !== guest.id || guest.hostId !== hostId) return no('the sign-in was not approved for this page.');
    t.used = true;
    this.tickets.delete(ticketId);
    const endEarly = (error: string) => {
      const h = this.holds.get(guest.id);
      if (h && h.filledDoc === undefined) this.release(guest.id);
      return no(error);
    };
    if (this.now() > t.expires) return endEarly('the sign-in waited too long.');
    if (guest.destroyed()) return endEarly('the page is gone.');
    // Finding 2: the document the person approved is still the one shown, at exactly that origin.
    if (this.doc(guest.id) !== t.doc || !sameOrigin(guest.url(), t.origin)) return endEarly('the page changed before the sign-in.');

    const username = String(cred.username ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_USERNAME);
    if (!username) return endEarly('no user name was given.');
    let password = '';
    if (cred.kind === 'typed') {
      if (typeof cred.password !== 'string' || !cred.password || cred.password.length > MAX_PASSWORD) return endEarly('no password was given.');
      password = cred.password;
    } else {
      const cipher = this.deps.cipherOf(cred.id, t.origin);
      try {
        password = cipher ? this.deps.decrypt(cipher) : '';
      } catch {
        password = '';
      }
      if (!password) return endEarly('the saved sign-in cannot be read on this computer.');
    }

    // The guard is up before anything could carry the password.
    this.guards.set(guest.id, { origin: t.origin, password });
    // A fresh credential-entry document: the one the agent's scripts ran in is replaced.
    try {
      await guest.loadFresh();
    } catch {
      this.guards.delete(guest.id);
      return endEarly('the page did not load again for the sign-in.');
    }
    const fresh = this.doc(guest.id);
    if (guest.destroyed() || fresh === t.doc || !sameOrigin(guest.url(), t.origin)) {
      this.guards.delete(guest.id);
      return endEarly('the page moved to another site before the sign-in.');
    }
    const nonce = randomBytes(16).toString('hex');
    const stamp = (await guest.isolated(stampScript(nonce)).catch(() => null)) as { origin?: string; top?: boolean } | null;
    // The stamped document is the fresh one, at the approved origin, nothing loaded since.
    if (!stamp || stamp.top !== true || stamp.origin !== t.origin || this.doc(guest.id) !== fresh) {
      this.guards.delete(guest.id);
      return endEarly('the page changed before the sign-in.');
    }
    // From here the password may be in the page: only a new document releases the hold.
    const h = this.holds.get(guest.id) ?? {};
    h.filledDoc = fresh;
    this.holds.set(guest.id, h);
    const r = (await guest.isolated(fillScript(nonce, t.origin, username, password)).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!r?.ok) {
      const why = (r?.error && FILL_REFUSALS[r.error]) || 'the sign-in form could not be filled.';
      // Refused before any value was set (every refusal is checked before the fill): nothing is in the page.
      if (r?.error && FILL_REFUSALS[r.error]) {
        h.filledDoc = undefined;
        this.release(guest.id);
      }
      return no(why);
    }

    // Through: a new document came, or the password field went away. Still there after a while: refused.
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
        this.deps.save(t.origin, username, this.deps.encrypt(password));
      } catch {
        /* signed in all the same; nothing saved */
      }
    }
    if (cred.kind === 'saved') this.deps.used(cred.id);
    password = '';
    return { ok: true, signedIn: true, user: username };
  }
}
