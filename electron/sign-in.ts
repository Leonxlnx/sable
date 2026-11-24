import { app, ipcMain, safeStorage, session, webContents, type BrowserWindow, type IpcMainInvokeEvent, type OnBeforeRequestListenerDetails, type WebContents } from 'electron';
import { setSignInHolds, SIGN_IN_OFF, SignInStore, signInShips } from '../server/services/sign-ins';
import { Attestations, codeOf, SignInError, SignInGate, SIGN_IN_WORLD, type Credential, type GuestPage, type SignInCode } from './sign-in-core';

/**
 * Saved sign-ins in Electron's main process: the only place a saved password is decrypted and the
 * only place any password is put into a page. The rules are in `sign-in-core.ts` (`SignInGate`);
 * this file connects them to the app's window, its Browser tab's guests, safeStorage and the panel
 * browser's network. Every handler answers only the app's own window, for a guest that window hosts.
 */

let gate: SignInGate | undefined;

/** The agent's tools are held on this guest (a sign-in is under way, or a filled document is still shown). */
export const signInHeld = (guestId: number) => !!gate?.held(guestId);

export function cancelSignInRequest(d: OnBeforeRequestListenerDetails) {
  if (!gate) return false;
  const body = d.uploadData?.map(u => u.bytes ?? new Uint8Array());
  return gate.verdict(d.webContentsId, { id: d.id, url: d.url, method: d.method, resourceType: d.resourceType, body }) === 'cancel';
}

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
    // No attestation and nothing to finish: with sign-ins off the bridge believes no hold anyway.
    ipcMain.handle('sable:browser-attest', () => null);
    ipcMain.handle('sable:signin-finish', () => false);
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
  const att = new Attestations(g);
  // The bridge asks these at delivery, in-process: what an answer's token stands for, and whether any page is held.
  setSignInHolds({ take: (token) => att.take(token), anyHeld: () => g.anyHeld() });

  // Every committed main-frame document (a navigation, a reload, a crash) moves a guest's count on.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    const id = wc.id;
    wc.on('did-navigate', () => g.committed(id));
    wc.on('render-process-gone', () => g.committed(id));
    wc.once('destroyed', () => g.gone(id));
  });

  // While a password is in play: only the approved submission carries a body, judged again by request
  // id when it is redirected; no request carries the password in its address or in a header.
  const ses = session.fromPartition(opts.partition);
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    cb(g.headers(d.webContentsId, d.requestHeaders) === 'cancel' ? { cancel: true } : { requestHeaders: d.requestHeaders });
  });

  /** The guest, only when the asking window hosts it. */
  const guestOf = (e: IpcMainInvokeEvent, id: unknown): WebContents => {
    if (!opts.fromApp(e)) throw new Error('Not allowed');
    const wc = webContents.fromId(Number(id));
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) throw new Error('That page is gone');
    return wc;
  };
  const tokenOf = (v: unknown) => (typeof v === 'string' ? v : '');

  // A token for one request of the agent's tools, for the guest that serves it (see Attestations).
  ipcMain.handle('sable:browser-attest', (e, id: unknown) => att.issue(guestOf(e, id).id));
  ipcMain.handle('sable:signin-begin', async (e, id: unknown, origin: unknown, token: unknown) => {
    const wc = guestOf(e, id);
    try {
      return await g.begin(e.sender.id, guestPage(wc), String(origin ?? ''));
    } catch (err) {
      const code: SignInCode = err instanceof SignInError ? err.code : codeOf((err as Error)?.message);
      att.record(tokenOf(token), wc.id, code);
      throw new Error(code);
    }
  });
  ipcMain.handle('sable:signin-fill', async (e, id: unknown, ticket: unknown, cred: unknown, token: unknown) => {
    const wc = guestOf(e, id);
    const c = (cred ?? {}) as Record<string, unknown>;
    const credential: Credential | undefined =
      c.kind === 'typed'
        ? { kind: 'typed', username: String(c.username ?? ''), password: typeof c.password === 'string' ? c.password : '', save: c.save === true }
        : c.kind === 'saved' && typeof c.id === 'string'
          ? { kind: 'saved', id: c.id, username: String(c.username ?? '') }
          : undefined;
    const r = credential ? await g.fill(e.sender.id, guestPage(wc), String(ticket ?? ''), credential) : { ok: false, code: 'failed' as SignInCode };
    // The outcome goes to the bridge from here, bound to the request's token: a fixed code and the user name.
    att.record(tokenOf(token), wc.id, r.code, 'user' in r ? r.user : undefined);
    return { ok: r.ok, code: r.code, ...('user' in r && r.user ? { user: r.user } : {}) };
  });
  // The card went away: by the person (cancelled) or because they were not looking.
  ipcMain.handle('sable:signin-cancel', (e, id: unknown, ticket: unknown, token: unknown, why: unknown) => {
    const wc = guestOf(e, id);
    if (typeof ticket === 'string' && ticket) g.cancel(e.sender.id, ticket);
    att.record(tokenOf(token), wc.id, why === 'not-looking' ? 'not-looking' : 'cancelled');
  });
  // After a fill, the person ends the hold from the tab's own line: Continue or Close.
  ipcMain.handle('sable:signin-finish', (e, id: unknown, hold: unknown, how: unknown) => {
    const wc = guestOf(e, id);
    return g.finish(e.sender.id, guestPage(wc), String(hold ?? ''), how === 'continue' ? 'continue' : 'close');
  });
}
