import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SignInInfo } from '../../shared/protocol';
import type { App } from '../app';

/**
 * Sign-ins for the Browser tab: a user name and a password per site, which Sable fills into the
 * page itself (the agent's `browser_sign_in` names the fields; it never sees or passes a value).
 *
 * This module is the bridge's part and holds no password: `<home>/sign-ins.json` keeps the origin,
 * the user name, dates and the password as ciphertext from Electron's `safeStorage`. Encrypting,
 * decrypting, filling and guarding the submission happen only in Electron's main process
 * (`electron/sign-in-core.ts` `SignInGate`, wired in `electron/sign-in.ts`), which reads the
 * ciphertext through `entryOf` in-process. Over the bridge there is only `signIn.list` (names, never
 * a secret) and `signIn.remove`. None of it is on the phone's allowlist.
 *
 * NOT IN THIS VERSION (`SIGN_IN_SHIPS` is false): `browser_sign_in` is offered to no agent and answers
 * that it is not available, every `signIn.*` method answers `SIGN_IN_OFF` (nothing read from or
 * written to disk), main's sign-in handlers refuse, the window never opens the card, and Settings
 * shows no saved sign-ins. The Demo's portal is signed into with plain typing. It stays off until a
 * review has cleared the rebuild below.
 *
 * The review of wave 16 (scratch/reviews/out-wave16.md), finding by finding: what answers it now, and
 * what is still open.
 *   1. Any client of the desktop bridge could reveal a password. Now: no RPC returns or takes a
 *      password (`signIn.reveal`, `signIn.save` are gone); decryption, encryption and the fill are in
 *      Electron main (`SignInGate.fill`), behind IPC that only the app's own window may call, bound to
 *      a ticket of that window (`begin`) for one guest it hosts. Open: a compromised app renderer can
 *      still ask main to fill a saved sign-in into a page at that sign-in's own origin (it never gets
 *      the value back); any bridge client can still list origins and user names.
 *   2. A listener left by an earlier `browser_eval` saw the fill; `browser_logs` ran during the hold.
 *      Now: on approval main loads the page again and fills only that fresh document, stamped with a
 *      nonce in an isolated world (`SIGN_IN_WORLD`) and checked to be the stamped, same-origin
 *      document; the window refuses every agent tool on the page from `begin` until the hold ends
 *      (`signing` in browser-agent.ts), and eval, screenshots and logs for as long as it is held.
 *      Open: the site's own scripts see what is filled (they are the site the password is for); the
 *      window's refusal is the renderer's (main also refuses the agent's screenshots while held).
 *   3. A cross-origin or GET form could carry the password away. Now: the fill script requires a POST
 *      form whose effective action (the submitter's formaction, formmethod and formtarget included) is
 *      exactly the approved origin and whose target is the page itself (`fillScript`); and while the
 *      password is in play, every request of that guest that carries it (address or body, as typed,
 *      percent- or form-encoded) must be a POST to the exact origin or it is cancelled
 *      (`requestVerdict`, from the session's webRequest). Open: an encoding the guard does not know
 *      (a script of the site that transforms the password first) is not recognised.
 *   4. A replaced input released the hold. Now: the hold is armed at `begin`, before any card or fill,
 *      and after a fill only a new committed document releases it (`SignInGate.committed`); a fill
 *      refused before any value was set, or a cancel, ends it. Open: a site that signs in without a new
 *      document keeps the page held until it navigates or is reloaded.
 *   5. The dev frame's origin was compared by prefix. Now: origins are compared exactly (scheme, host
 *      in punycode, port; `sameOrigin`), the dev frame compares parsed origins, and the dev frame
 *      cannot fill at all (only the desktop's main process fills).
 *
 * The review of the rebuild (22 Nov 2026, scratch/reviews/out-day5b.md) said no again; its numbers.
 * Second rebuild, still off: what answers each finding now, and what is still open.
 *   1. The ciphertext held the password alone. Now: what is encrypted is the password with the
 *      canonical origin and the user name (`sealPlain` in electron/sign-in-core.ts); main checks both
 *      against the entry after decrypting (`openPlain`, `SignInGate.fill`), and an entry relabelled in
 *      this file is refused as damaged, never filled. Open: any desktop bridge client can still read
 *      and delete the file through the bridge's general file and terminal methods (`fs.*`, `term.*`),
 *      and list and remove entries once this is on; safeStorage on Windows is no boundary against code
 *      running as the same user. Restricting those methods to the app's own window is the lead's call.
 *   2. A second sign-in undid the first's guard. Now: `begin` is refused while the guest has a sign-in
 *      under way or a filled document still shown; each hold has an id, a release names it, and the
 *      window ends only the hold whose id it was given (`PageState.hold`).
 *   4. The hold had holes. Now: main holds back everything of a held guest at the point of delivery.
 *      Every answer the window sends carries its page's webContents id (`BrowserAnswer.guestId`); the
 *      bridge asks main's holds when an answer arrives (`deliveryHeld`, `setSignInHolds`;
 *      browser-tool.ts `ask`), for every tool, `state` and `open` included, and an answer that does not
 *      say its page is held back while any page is held; the line with the page's address and title is
 *      left out while a page is held. Main passes no console line or failed request of a held guest to
 *      the window, drops what an old document left in its buffers when the next one commits, and marks
 *      each batch with its document (`doc`, the window drops a batch of an older one). Main refuses the
 *      agent's screenshot of a held guest. Open: the window's own copy of an older log (read before the
 *      hold) is held back only through the delivery check.
 *   6. The approval named an origin only. Now: `begin` pins the address (origin and path) and the form
 *      (its action and its two fields' names, read in an isolated world: `describeScript`); the fresh
 *      load goes to the pinned address and must land there; the stamp finds the pinned form again and
 *      keeps the document's root, the form, its fields and the submitter as references in its world; the
 *      fill sets both values before any event, then checks the fields, the form and where it sends again,
 *      and only then submits (`stampScript`, `fillScript`). A same-document change of the address, a
 *      redirect to another path, `document.open()`, a replaced form or a field moved into a frame void it.
 *      Open: the page's own listeners still run on the two events (finding 3).
 *   7. The network rule leaned on recognising the password. Now: while the password is in play every
 *      request of that guest with a body is a POST to the exact origin or is cancelled, whatever the body
 *      holds; an address holding the password in any form the URL standard's form encoding writes
 *      (`formEncode`, tested against the browser's own serialization of a password with `!` and a space)
 *      is cancelled; a 307 or 308 to another origin is cancelled (`redirectVerdict`, from
 *      `onBeforeRedirect` and `will-redirect`); `<base target>` counts as the form's target. Open: the
 *      redirect path is not verified in the pinned Electron binary; a WebSocket frame, a worker's request
 *      without a guest id and DNS lookups are outside an HTTP rule (finding 3).
 *   8. One saved entry was used after a timer. Now: no timer; every saved entry is offered on the card
 *      and the person picks every time; the card opens only while this window is focused and the
 *      session's Browser tab is on screen, and it closes if the tab leaves the screen.
 *   9. The step was published before its input was cleaned. Now: `cleanToolInput` keeps only valid
 *      references where the providers make the step (claude.ts `toolReady`, codex-map.ts, the Demo), and
 *      Claude's input of browser_sign_in never streams into the timeline (`streamsInput`).
 * Not removable here, so the person is told before saving (`SIGN_IN_RISK`, on the card's Save choice
 * and under Settings › Permissions' list):
 *   3. What is filled into a page can be read by that page's scripts (a third party's too), and a
 *      page may carry it off by means no HTTP rule sees (a WebSocket, storage kept for later).
 *   5. Once signed in, the agent acts in that session, and the Browser tab's pages share one stored
 *      profile: a site that keeps a token where scripts can read it gives it to the agent's eval.
 */

/** Saved sign-ins ship at all. Tests of its code turn it on with `setSignInShips`. */
export const SIGN_IN_SHIPS = false;

let shipsOverride: boolean | undefined;
const shipsListeners = new Set<() => void>();

/** Whether sign-ins are on (the ship switch, or a test's override). */
export const signInShips = () => shipsOverride ?? SIGN_IN_SHIPS;

/** Tests only: turns the feature on or off (undefined: back to `SIGN_IN_SHIPS`). The tool lists follow. */
export function setSignInShips(on: boolean | undefined) {
  shipsOverride = on;
  for (const l of shipsListeners) l();
}

/** Hears the switch change (browser-tool.ts keeps its tool lists in step). */
export function onSignInShips(l: () => void) {
  shipsListeners.add(l);
}

export const SIGN_IN_OFF = 'SIGN_IN_OFF: sign-ins are not available in this version of Sable.';

/**
 * The holds Electron main keeps (electron/sign-in.ts): while a guest is held, nothing of its page goes
 * to the agent. The bridge asks at delivery, when the window's answer arrives (browser-tool.ts).
 * Absent (no desktop shell, or sign-ins off): nothing is held.
 */
export interface SignInHolds {
  held(guestId: number): boolean;
  anyHeld(): boolean;
}

let holds: SignInHolds | undefined;

export function setSignInHolds(h: SignInHolds | undefined) {
  holds = h;
}

/** An answer from that guest (or, when it does not say which, from any guest while one is held) must not reach the agent. */
export function deliveryHeld(guestId: number | undefined): boolean {
  if (!holds) return false;
  return typeof guestId === 'number' && guestId > 0 ? holds.held(guestId) : holds.anyHeld();
}

/** Some page is held: the line about the Browser tab's page (address and title) is left out. */
export const anyPageHeld = () => !!holds?.anyHeld();

export const SIGN_INS_FILE = 'sign-ins.json';
/** How many sign-ins are kept (the oldest used go first). */
export const MAX_SIGN_INS = 200;
export const MAX_USERNAME = 200;
/** The longest ciphertext kept (base64 characters). */
export const MAX_CIPHER = 8_000;

interface Entry extends SignInInfo {
  /** The password as safeStorage's ciphertext (base64); only Electron main can read it. */
  secret: string;
}

interface SignInsFile {
  version: 1;
  signIns: Entry[];
}

/**
 * The origin as the browser has it, when Sable may fill sign-ins there: `https:` anywhere, `http:`
 * only on this machine (for tests). Anything else, or a string that is not already an exact origin
 * (a path, a user name in it, a trailing dot, upper case), is refused rather than made one.
 */
export function signInOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.origin !== raw) return undefined;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return u.origin;
  return undefined;
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

const cleanUser = (raw: unknown) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_USERNAME);

const newId = () => randomBytes(8).toString('hex');

function isEntry(e: unknown): e is Entry {
  const x = e as Entry;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && /^[a-f0-9]{8,32}$/.test(x.id) && typeof x.username === 'string' && typeof x.secret === 'string' && x.secret.length <= MAX_CIPHER && !!signInOrigin(x.origin);
}

const info = (e: Entry): SignInInfo => ({ id: e.id, origin: e.origin, username: e.username, createdAt: e.createdAt, ...(e.usedAt ? { usedAt: e.usedAt } : {}) });

/**
 * The file. Read on every use (it is small), so the bridge and Electron main, which each hold one,
 * never act on a stale copy. Never decrypts: it keeps and hands over ciphertext only.
 */
export class SignInStore {
  readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, SIGN_INS_FILE);
  }

  private load(): Entry[] {
    let f: Partial<SignInsFile> | undefined;
    try {
      f = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SignInsFile>;
    } catch {
      f = undefined;
    }
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const e of Array.isArray(f?.signIns) ? f.signIns : []) {
      if (!isEntry(e) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, origin: e.origin, username: cleanUser(e.username), secret: e.secret, createdAt: Number(e.createdAt) || 0, ...(Number(e.usedAt) ? { usedAt: Number(e.usedAt) } : {}) });
    }
    return out.slice(0, MAX_SIGN_INS);
  }

  /** Written to a file beside it, then moved over it: a cut-off write never leaves half a file. */
  private save(list: Entry[]) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, signIns: list } satisfies SignInsFile, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new Error(`Sign-ins could not be written (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
  }

  /** Every saved sign-in (or one origin's), newest used first; never a secret. */
  all(origin?: string): SignInInfo[] {
    const list = this.load().filter((e) => !origin || e.origin === origin);
    return [...list].sort((a, b) => (b.usedAt ?? b.createdAt) - (a.usedAt ?? a.createdAt)).map(info);
  }

  /**
   * One sign-in's ciphertext and user name, for exactly the origin it was saved for. Electron main only
   * (never an RPC). What is encrypted holds the origin and the user name too (`sealPlain` in
   * electron/sign-in-core.ts): main checks them after decrypting, so an entry relabelled in this file
   * is refused, never filled.
   */
  entryOf(id: string, origin: string): { cipher: string; username: string } | undefined {
    const o = signInOrigin(origin);
    const e = this.load().find((x) => x.id === id);
    return o && e && e.origin === o ? { cipher: e.secret, username: e.username } : undefined;
  }

  /** Saves (or replaces) the ciphertext for this origin and user name. */
  put(origin: string, username: unknown, cipher: unknown): void {
    const o = signInOrigin(origin);
    const user = cleanUser(username);
    if (!o) throw new Error('Sign-ins are saved only for https sites.');
    if (!user) throw new Error('A sign-in needs a user name.');
    if (typeof cipher !== 'string' || !cipher || cipher.length > MAX_CIPHER) throw new Error('Nothing to save.');
    const now = Date.now();
    const list = this.load();
    const old = list.find((e) => e.origin === o && e.username === user);
    const entry: Entry = { id: old?.id ?? newId(), origin: o, username: user, secret: cipher, createdAt: old?.createdAt ?? now, usedAt: now };
    const rest = list.filter((e) => e !== old);
    // Bounded: the least recently used go first.
    this.save([entry, ...rest].sort((a, b) => (b.usedAt ?? b.createdAt) - (a.usedAt ?? a.createdAt)).slice(0, MAX_SIGN_INS));
  }

  used(id: string): boolean {
    const list = this.load();
    const e = list.find((x) => x.id === id);
    if (!e) return false;
    this.save(list.map((x) => (x === e ? { ...x, usedAt: Date.now() } : x)));
    return true;
  }

  remove(id: string): boolean {
    const list = this.load();
    if (!list.some((e) => e.id === id)) return false;
    this.save(list.filter((e) => e.id !== id));
    return true;
  }
}

const idOf = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-f0-9]{8,32}$/.test(v)) throw new Error('No such sign-in.');
  return v;
};

/** The bridge's methods: names to list and remove, nothing that holds a secret. */
export function registerSignIns(app: App) {
  // Off: every method refuses before anything is read or written.
  const store = () => {
    if (!signInShips()) throw new Error(SIGN_IN_OFF);
    return new SignInStore(app.store.dir);
  };
  app.register('signIn.list', ({ origin } = {}) => {
    const s = store();
    if (origin === undefined) return s.all();
    const o = signInOrigin(origin);
    return o ? s.all(o) : [];
  });
  app.register('signIn.remove', ({ id }) => ({ ok: store().remove(idOf(id)) }));
}
