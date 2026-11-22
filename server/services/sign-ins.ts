import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SignInInfo } from '../../shared/protocol';
import type { App } from '../app';

/**
 * Sign-ins for the Browser tab: a user name and a password per site, which Sable fills into the
 * page itself (the agent's `browser_sign_in` names the fields; it never sees or passes a value).
 *
 * Kept on this computer only, in `<home>/sign-ins.json`: the origin, the user name, dates and the
 * password as ciphertext from Electron's `safeStorage` (Windows DPAPI, the macOS keychain, the Linux
 * secret store), which the desktop shell hands over with `setSignInVault` as it does for updates and
 * thumbnails. Without a vault (the dev server, a standalone bridge, a Linux machine with no secret
 * store) nothing is saved: the card says the sign-in is used once. A copied file cannot be read on
 * another machine or account: the vault there cannot decrypt it, and such an entry reads as missing.
 *
 * The password leaves this module only as the answer to `signIn.reveal`, an RPC answer to the one
 * window that asked, for the exact origin it was saved for. Never in an event, a log, an error
 * message or a tool result. None of these methods is on the phone's allowlist.
 *
 * NOT IN THIS VERSION (`SIGN_IN_SHIPS` is false): `browser_sign_in` is offered to no agent and answers
 * that it is not available, every `signIn.*` method answers `SIGN_IN_OFF` (no list, no reveal, no
 * save, nothing read from or written to disk, the vault never called), the window never opens the
 * card, and Settings shows no saved sign-ins. The Demo's portal is signed into with plain typing.
 * Before it is switched on, an independent review (scratch/reviews/out-wave16.md) must be cleared:
 *   1. Any client of the desktop bridge can list the vault and reveal a password: decryption and
 *      filling belong in Electron main, bound to the window and the guest document, never an RPC.
 *   2. A listener left in the page by an earlier `browser_eval` sees the fill, and `browser_logs` keeps
 *      returning console output during the hold: fill only a credential-entry document no agent script
 *      has touched, and hold the logs too.
 *   3. The form's action and method are not checked: a cross-origin action or a GET form leaks the
 *      password. Same-origin POST only.
 *   4. A replaced input releases the hold (the check reads only the element it filled): arm the hold
 *      before the fill and end it only with a new document.
 *   5. The dev frame's origin is compared by prefix (`href.startsWith(target)`): compare exact origins.
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
export const MAX_PASSWORD = 1_000;

/** What the desktop shell gives: encryption bound to this computer and this person's account. */
export interface SignInVault {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

let vault: SignInVault | undefined;

/** The desktop shell's vault (electron/main.ts). Absent: nothing is saved. */
export function setSignInVault(v: SignInVault | undefined) {
  vault = v;
}

interface Entry extends SignInInfo {
  /** The password as the vault's ciphertext (base64). */
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
  return !!x && typeof x === 'object' && typeof x.id === 'string' && /^[a-f0-9]{8,32}$/.test(x.id) && typeof x.username === 'string' && typeof x.secret === 'string' && !!signInOrigin(x.origin);
}

const info = (e: Entry): SignInInfo => ({ id: e.id, origin: e.origin, username: e.username, createdAt: e.createdAt, ...(e.usedAt ? { usedAt: e.usedAt } : {}) });

export class SignInStore {
  readonly file: string;
  private list?: Entry[];

  constructor(
    dir: string,
    private getVault: () => SignInVault | undefined = () => vault,
  ) {
    this.file = path.join(dir, SIGN_INS_FILE);
  }

  /** The vault when it can encrypt on this computer now. */
  private v(): SignInVault | undefined {
    const v = this.getVault();
    try {
      return v && v.available() ? v : undefined;
    } catch {
      return undefined;
    }
  }

  canSave(): boolean {
    return !!this.v();
  }

  private load(): Entry[] {
    if (this.list) return this.list;
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
    this.list = out.slice(0, MAX_SIGN_INS);
    return this.list;
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
    this.list = list;
  }

  /** Every saved sign-in (or one origin's), newest used first; never a password. */
  all(origin?: string): SignInInfo[] {
    const list = this.load().filter((e) => !origin || e.origin === origin);
    return [...list].sort((a, b) => (b.usedAt ?? b.createdAt) - (a.usedAt ?? a.createdAt)).map(info);
  }

  /** The password of one sign-in, for exactly the origin it was saved for; undefined when it cannot be read here. */
  reveal(id: string, origin: string): string | undefined {
    const o = signInOrigin(origin);
    const e = this.load().find((x) => x.id === id);
    if (!o || !e || e.origin !== o) return undefined;
    const v = this.v();
    if (!v) return undefined;
    try {
      const plain = v.decrypt(e.secret);
      return typeof plain === 'string' && plain ? plain : undefined;
    } catch {
      // Another machine's or account's ciphertext, or a damaged entry.
      return undefined;
    }
  }

  /** Saves (or replaces the password of) the sign-in for this origin and user name. False when nothing can be saved here. */
  put(origin: string, username: unknown, password: unknown): boolean {
    const o = signInOrigin(origin);
    const user = cleanUser(username);
    if (!o) throw new Error('Sign-ins are saved only for https sites.');
    if (!user) throw new Error('A sign-in needs a user name.');
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) throw new Error('A sign-in needs a password.');
    const v = this.v();
    if (!v) return false;
    let secret: string;
    try {
      secret = v.encrypt(password);
    } catch {
      return false;
    }
    const now = Date.now();
    const list = this.load();
    const old = list.find((e) => e.origin === o && e.username === user);
    const entry: Entry = { id: old?.id ?? newId(), origin: o, username: user, secret, createdAt: old?.createdAt ?? now, usedAt: now };
    const rest = list.filter((e) => e !== old);
    // Bounded: the least recently used go first.
    const kept = [entry, ...rest].sort((a, b) => (b.usedAt ?? b.createdAt) - (a.usedAt ?? a.createdAt)).slice(0, MAX_SIGN_INS);
    this.save(kept);
    return true;
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

const stores = new WeakMap<App, SignInStore>();

export function signInsOf(app: App): SignInStore {
  let s = stores.get(app);
  if (!s) {
    s = new SignInStore(app.store.dir);
    stores.set(app, s);
  }
  return s;
}

const idOf = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-f0-9]{8,32}$/.test(v)) throw new Error('No such sign-in.');
  return v;
};

export function registerSignIns(app: App) {
  // Off: every method refuses before anything is read, written or asked of the vault.
  const store = () => {
    if (!signInShips()) throw new Error(SIGN_IN_OFF);
    return signInsOf(app);
  };
  app.register('signIn.state', () => ({ canSave: store().canSave() }));
  app.register('signIn.list', ({ origin } = {}) => {
    store();
    if (origin === undefined) return store().all();
    const o = signInOrigin(origin);
    return o ? store().all(o) : [];
  });
  app.register('signIn.reveal', ({ id, origin }) => {
    const password = store().reveal(idOf(id), String(origin ?? ''));
    // The same words whatever failed: nothing about the entry is told.
    if (!password) throw new Error('This sign-in cannot be read on this computer.');
    return { password };
  });
  app.register('signIn.save', ({ origin, username, password }) => {
    const saved = store().put(String(origin ?? ''), username, password);
    return { ok: true, saved };
  });
  app.register('signIn.used', ({ id }) => ({ ok: store().used(idOf(id)) }));
  app.register('signIn.remove', ({ id }) => ({ ok: store().remove(idOf(id)) }));
}
