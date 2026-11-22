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
 * ciphertext through `cipherOf` in-process. Over the bridge there is only `signIn.list` (names, never
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
 * The review of the rebuild (22 Nov 2026, scratch/reviews/out-day5b.md) said no again. Still to clear
 * before the switch goes on; the numbers are that review's:
 *   1. The ciphertext holds the password alone: the entry's origin and user name are plain JSON beside
 *      it, so whoever can write the file can point a saved password at another origin. Encrypt the
 *      origin and the user name with it and check them after decrypting.
 *   2. A second `begin` on a guest that still shows a filled form: its reload is read as the first
 *      fill's new document, which removes the new network guard and tells the window to stop
 *      refusing. Refuse `begin` while a guest has a sign-in pending or filled; one id per hold.
 *   4. The hold is the window's and has holes: `browser_read` (page text, console, failed requests),
 *      the title and address, and a console batch of the old document arriving late still reach the
 *      agent. Enforce the hold in main, on what is delivered as well as on what is asked.
 *   6. The approval names an origin, not the login page or its form: a path change in the same
 *      document, a same-origin redirect, `document.open()` or a form swapped after the stamp, or the
 *      field moved into a frame during the user name's event, all pass. Pin the address and the form.
 *   7. The network guard misses a form-encoded password (`!` and the like) and a `<base target>`;
 *      the destination must hold for the request and each redirect whatever the body looks like.
 *   8. A single saved entry is used after 2.6 s without the person choosing it. Always ask.
 *   9. The tool's step is published before its input is cleaned.
 * And two that no fix here removes; the person must be told before they save anything:
 *   3. What is filled into a page can be read by that page's scripts (a third party's too), as with
 *      any password manager's autofill.
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

  /** The ciphertext of one sign-in, for exactly the origin it was saved for. Electron main only (never an RPC). */
  cipherOf(id: string, origin: string): string | undefined {
    const o = signInOrigin(origin);
    const e = this.load().find((x) => x.id === id);
    return o && e && e.origin === o ? e.secret : undefined;
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
