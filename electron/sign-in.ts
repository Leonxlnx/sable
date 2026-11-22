import { app, ipcMain, safeStorage, session, webContents, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { setSignInHolds, SIGN_IN_OFF, SignInStore, signInShips } from '../server/services/sign-ins';
import { SignInGate, SIGN_IN_WORLD, type Credential, type GuestPage } from './sign-in-core';

/**
 * Saved sign-ins in Electron's main process: the only place a saved password is decrypted and the
 * only place any password is put into a page. The rules are in `sign-in-core.ts` (`SignInGate`);
 * this file connects them to the app's window, its Browser tab's guests, safeStorage and the panel
 * browser's network. Every handler answers only the app's own window, for a guest that window hosts.
 */

let gate: SignInGate | undefined;

/** The agent's tools are held on this guest (a sign-in is under way, or a filled document is still shown). */
export const signInHeld = (guestId: number) => !!gate?.held(guestId);

/** safeStorage that really encrypts: on Linux only with a real secret store, never the plain-text fallback. */
const canEncrypt = () => app.isReady() && safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');

function guestPage(wc: WebContents): GuestPage {
  return {
    id: wc.id,
    hostId: wc.hostWebContents?.id ?? -1,
    destroyed: () => wc.isDestroyed(),
    url: () => (wc.isDestroyed() ? '' : wc.getURL()),
    loadFresh: (url) =>
      new Promise<void>((resolve, reject) => {
        let committed = false;
        const onNav = () => (committed = true);
        const onLoad = () => {
          if (!committed) return;
          done();
          resolve();
        };
        const onFail = (_e: unknown, code: number, _d: string, _u: string, isMain: boolean) => {
          if (!isMain || code === -3) return;
          done();
          reject(new Error('load'));
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error('timeout'));
        }, 15_000);
        const done = () => {
          clearTimeout(timer);
          wc.off('did-navigate', onNav);
          wc.off('did-finish-load', onLoad);
          wc.off('did-fail-load', onFail);
        };
        wc.on('did-navigate', onNav);
        wc.on('did-finish-load', onLoad);
        wc.on('did-fail-load', onFail);
        wc.loadURL(url).catch(() => {});
      }),
    isolated: (code) => wc.executeJavaScriptInIsolatedWorld(SIGN_IN_WORLD, [{ code }]),
  };
}

/**
 * Wires the gate: the guests' documents, the network rule on the panel browser's session, and the
 * window's three calls (begin, fill, cancel). `fromApp`: the event came from the app's own window.
 */
export function installSignIn(opts: { partition: string; home: string; window: () => BrowserWindow | null | undefined; fromApp: (e: IpcMainInvokeEvent) => boolean }) {
  // Off (`SIGN_IN_SHIPS`): nothing is wired. No listener on the guests and no rule on the panel
  // browser's network (a rule there is asked about every request of every page), and the window's
  // calls answer that it is not available.
  if (!signInShips()) {
    for (const call of ['sable:signin-begin', 'sable:signin-fill']) {
      ipcMain.handle(call, () => {
        throw new Error(SIGN_IN_OFF);
      });
    }
    ipcMain.handle('sable:signin-cancel', () => {});
    return;
  }
  const store = new SignInStore(opts.home);
  const tell = (msg: Record<string, unknown>) => {
    const w = opts.window();
    if (w && !w.isDestroyed()) w.webContents.send('sable:browser-event', msg);
  };
  gate = new SignInGate({
    ships: signInShips,
    canSave: canEncrypt,
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
    entryOf: (id, origin) => store.entryOf(id, origin),
    save: (origin, username, cipher) => store.put(origin, username, cipher),
    used: (id) => void store.used(id),
    // Only the hold's id goes to the window, which ends the refusal of exactly that hold.
    released: (id, hold) => tell({ type: 'signin-released', id, hold }),
  });
  const g = gate;
  // The bridge asks these at delivery: while a guest is held, nothing of its page reaches the agent.
  setSignInHolds({ held: (id) => g.held(id), anyHeld: () => g.anyHeld() });

  /** The last redirect each guest's network saw (its status), for the navigation's own redirect check. */
  const lastRedirect = new Map<number, { status: number; to: string }>();

  // Every committed main-frame document (a navigation, a reload, a crash) moves a guest's count on.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    const id = wc.id;
    wc.on('did-navigate', () => g.committed(id));
    wc.on('render-process-gone', () => g.committed(id));
    // A 307 or 308 of the form's POST to another origin, while the password is in play, does not happen.
    wc.on('will-redirect', (e) => {
      const r = lastRedirect.get(id);
      if (r && r.to === e.url && g.redirect(id, r.status, e.url) === 'cancel') e.preventDefault();
    });
    wc.once('destroyed', () => {
      lastRedirect.delete(id);
      g.gone(id);
    });
  });

  // While a password is in play: a request with a body goes only as a POST to the exact origin, and a
  // request whose address holds the password does not go at all.
  const ses = session.fromPartition(opts.partition);
  ses.webRequest.onBeforeRequest((d, cb) => {
    const body = d.uploadData ? d.uploadData.map((u) => u.bytes ?? new Uint8Array()) : undefined;
    cb({ cancel: g.verdict(d.webContentsId, { url: d.url, method: d.method, body }) === 'cancel' });
  });
  ses.webRequest.onBeforeRedirect((d) => {
    if (typeof d.webContentsId === 'number') lastRedirect.set(d.webContentsId, { status: d.statusCode, to: d.redirectURL });
  });

  /** The guest, only when the asking window hosts it. */
  const guestOf = (e: IpcMainInvokeEvent, id: unknown): WebContents => {
    if (!opts.fromApp(e)) throw new Error('Not allowed');
    const wc = webContents.fromId(Number(id));
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) throw new Error('That page is gone');
    return wc;
  };

  ipcMain.handle('sable:signin-begin', (e, id: unknown, origin: unknown) => {
    const wc = guestOf(e, id);
    return g.begin(e.sender.id, guestPage(wc), String(origin ?? ''));
  });
  ipcMain.handle('sable:signin-fill', async (e, id: unknown, ticket: unknown, cred: unknown) => {
    const wc = guestOf(e, id);
    const c = (cred ?? {}) as Record<string, unknown>;
    const credential: Credential | undefined =
      c.kind === 'typed'
        ? { kind: 'typed', username: String(c.username ?? ''), password: typeof c.password === 'string' ? c.password : '', save: c.save === true }
        : c.kind === 'saved' && typeof c.id === 'string'
          ? { kind: 'saved', id: c.id, username: String(c.username ?? '') }
          : undefined;
    if (!credential) return { ok: false, error: 'the sign-in was not understood.' };
    // The answer is whether it signed in and the user name: never the password, in no error either.
    return g.fill(e.sender.id, guestPage(wc), String(ticket ?? ''), credential);
  });
  ipcMain.handle('sable:signin-cancel', (e, ticket: unknown) => {
    if (!opts.fromApp(e)) return;
    g.cancel(e.sender.id, String(ticket ?? ''));
  });
}
