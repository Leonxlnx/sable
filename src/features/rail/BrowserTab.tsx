import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu as RM } from 'radix-ui';
import type { Attachment, BrowserConsoleLine } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { devUrlLabel } from '@/lib/dev-url';
import { addressParts, isLocalUrl, normalizeAddress, willSearch } from '@/lib/links';
import * as actions from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Spinner, Tip } from '@/ui';
import { createPointer, type AgentPointer } from './agent-pointer';
import { AgentLine, SignInCard } from './BrowserAgentUi';
import { readScript, registerPage, type PageController } from './browser-agent';
import { connectDevFrame } from './dev-frame';
import { cancelSignIn } from './sign-in';
import { parseKey, pickCancelScript, pickScript, type Picked } from './browser-scripts';
import {
  activeTab,
  closeTab,
  DEVICES,
  failedDropped,
  flushSoon,
  forgetVisit,
  getLog,
  getPage,
  getTabs,
  logDropped,
  logFailed,
  logLine,
  moveTab,
  noteVisit,
  openTab,
  pushHistory,
  reopenTab,
  resetLog,
  selectTab,
  setPage,
  setPageSoon,
  SOON_MS,
  stepHistory,
  TABS_MAX,
  touchVisit,
  useLogVersion,
  usePage,
  usePreviews,
  useRecent,
  useTabs,
  type AgentWork,
  type Device,
  type FeedEntry,
} from './browser-store';
import { useRememberedUrl } from './dev-urls';
import './browser.css';

/**
 * The panel's Browser tab: the pages an agent is building, next to the conversation. Several pages
 * in tabs, each a real browser view (<webview>) in the desktop app, a sandboxed frame in the web
 * build. A tab strip, a toolbar (history, reload or stop, the address, a menu), a progress line,
 * and states of its own: a start view, a failed load, a page that hangs or crashed. The page can be
 * checked at tablet and phone width.
 *
 * A heavy page must never slow the app: the app never waits on a page without a time limit, what
 * a page reports many times a second is gathered and applied a few times a second, its console and
 * failed requests arrive from the shell in capped batches, and only the page in front runs at full
 * speed (the shell mutes and slows down the others).
 */

interface BrowserEvent {
  type: string;
  name?: string;
  id?: number;
  url?: string;
  method?: string;
  status?: number;
  error?: string;
  key?: string;
  on?: boolean;
  count?: number;
  lines?: { level: string; text: string; source?: string }[];
  /** The page's document a batch came from; 'doc' says a new one committed. */
  doc?: number;
  /** 'signin-released': which hold ended. */
  hold?: string;
}

interface DesktopApi {
  platform: string;
  debug?: boolean;
  browser?: {
    capture(webContentsId: number, opts?: { forAgent?: boolean }): Promise<string>;
    clearData(): Promise<void>;
    /** Missing on older shells. */
    setShown?(webContentsId: number, shown: boolean): void;
    onEvent(cb: (e: BrowserEvent) => void): () => void;
  };
}

/** The Electron <webview> element: only the parts used here. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent?(event: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }): Promise<void> | void;
}

/** One tab's page view in the desktop app. */
interface View {
  tabId: string;
  el: WebviewEl;
  /** The page's view is attached and its document started: calls into it can be made. */
  ready: boolean;
  /** The guest's webContents id, once attached (events from the shell carry it). */
  wcId: number;
  /** What the shell was last told: in front or not. */
  shown?: boolean;
  /** Reload after a hang: the old process's crash report that follows must not show. */
  restarting?: boolean;
  /** The shell's count of the page's documents: batches of an older one are dropped. */
  doc?: number;
  navTimer?: ReturnType<typeof setTimeout>;
  visitTimer?: ReturnType<typeof setTimeout>;
  unregister: () => void;
}

/** Key names as the shell's input events spell them. */
const INPUT_KEY: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', ' ': 'Space' };

/** How long the app waits on a page for anything before it gives up (a page can hang). */
const PAGE_MS = 10_000;

function within<T>(p: Promise<T>, ms = PAGE_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => (t = setTimeout(() => no(new Error('The page did not answer in time.')), ms)))]).finally(() => clearTimeout(t));
}

type WebviewEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
  title?: string;
  favicons?: string[];
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  result?: { activeMatchOrdinal: number; matches: number };
};

/** Chromium's zoom steps. */
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const DEVICE_ICON: Record<Device, IconName> = { desktop: 'monitor', tablet: 'tablet', phone: 'phone' };

/** The device strip above a constrained page, and the margin around it. */
const STRIP_H = 36;
const STAGE_PAD = 14;

/** A failed load in plain words, from Chromium's net error code. */
function failure(code: number | undefined, url: string): string {
  const { host } = addressParts(url);
  const c = code ?? 0;
  if (c === -102 || c === -101 || c === -100 || c === -109) return isLocalUrl(url) ? `Nothing is running at ${host}` : `${host} refused to connect`;
  if (c === -105 || c === -137) return `Could not find ${host}`;
  if (c === -106) return 'You are offline';
  if (c === -7 || c === -118) return `${host} took too long to answer`;
  if ((c <= -200 && c > -300) || c === -501) return `${host} has a certificate that cannot be trusted`;
  if (c === -310) return `${host} redirected too many times`;
  if (c === -324) return `${host} sent an empty response`;
  if (c === -20 || c === -27) return 'This page cannot be shown here';
  return `${host} did not load`;
}

/** A console level from the shell, in the log's words. */
function levelOf(lv: string): BrowserConsoleLine['level'] {
  return lv === 'error' ? 'error' : lv === 'warning' ? 'warning' : lv === 'debug' || lv === 'verbose' ? 'debug' : lv === 'info' ? 'info' : 'log';
}

const desktop = (window as { sableDesktop?: DesktopApi }).sableDesktop;
const native = !!desktop?.browser;
const PARTITION = 'persist:sable-browser';

// Verification runs of the desktop app (started with --eval) get the store, since production has no console helpers.
if (desktop?.debug) (window as unknown as Record<string, unknown>).sableDebug = { store: useStore, actions };

/** "localhost:5173/app" for display: no scheme, no lone trailing slash. */
function prettyUrl(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/^([^/?#]+)\/$/, '$1');
}

const isAppOrigin = (url: string) => {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
};

const dataUrlBytes = (url: string) => Math.round(((url.length - url.indexOf(',') - 1) * 3) / 4);

export function BrowserTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const tabs = useTabs(sessionId);
  const tabId = tabs.active;
  const page = usePage(tabId);
  const host = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, View>());
  const input = useRef<HTMLInputElement>(null);
  const toast = useStore((s) => s.toast);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ active: number; total: number } | null>(null);

  /* ── the agent's pointer: one layer over the page, placed in the page's own pixels ── */

  const pointerLayer = useRef<HTMLDivElement>(null);
  const pointer = useRef<AgentPointer | null>(null);
  useEffect(() => {
    const layer = pointerLayer.current;
    if (!layer) return;
    const p = createPointer(layer);
    pointer.current = p;
    return () => {
      p.dispose();
      pointer.current = null;
    };
  }, []);
  /**
   * The pointer for one page view: a point of the page (CSS pixels, its viewport `vw` wide) lands on
   * the view's box as laid out, which takes in the page's zoom and a device size's scale at once
   * (box width / viewport width). Only while this tab is the one in front and the pane shows.
   */
  const pointerFor = (view: () => HTMLElement | null): Pick<PageController, 'point' | 'press'> => ({
    point: async (rect, vw) => {
      const el = view();
      const layer = pointerLayer.current;
      const p = pointer.current;
      if (!el || !layer || !p || !activeRef.current || el.hasAttribute('data-hidden')) return;
      const box = el.getBoundingClientRect();
      const lb = layer.getBoundingClientRect();
      if (box.width < 1 || !(vw > 0)) return;
      const k = box.width / vw;
      await p.moveTo({ x: box.left - lb.left + (rect.x + rect.w / 2) * k, y: box.top - lb.top + (rect.y + rect.h / 2) * k });
    },
    press: async () => {
      if (activeRef.current) await pointer.current?.press();
    },
  });
  const pointerRef = useRef(pointerFor);
  pointerRef.current = pointerFor;

  // The agent drives only within its turn: when the turn ends (or Stop), the page is handed back.
  const provider = useStore((s) => s.sessions[sessionId]?.provider ?? 'demo');
  const running = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'awaiting' || st === 'starting';
  });
  useEffect(() => {
    if (running) return;
    for (const id of getTabs(sessionId).ids) if (getPage(id).driving) setPage(id, { driving: undefined, yielding: undefined });
    pointer.current?.hide();
  }, [running, sessionId]);
  const stopAgent = () => {
    void actions.interrupt(sessionId);
    cancelSignIn(activeTab(sessionId));
    setPage(activeTab(sessionId), { driving: undefined, yielding: undefined });
    pointer.current?.hide();
  };

  /* ── desktop: one webview per tab, created when the tab first shows a page ── */

  /** The view of the tab in front, when its page can take calls. */
  const live = (): View | undefined => {
    const v = views.current.get(activeTab(sessionId));
    return v?.ready ? v : undefined;
  };

  /** Back and forward availability, asked of the shell a few times a second at most (each ask waits on it). */
  const refreshNav = (v: View) => {
    if (v.navTimer) return;
    v.navTimer = setTimeout(() => {
      v.navTimer = undefined;
      if (!v.ready) return;
      try {
        setPage(v.tabId, { canBack: v.el.canGoBack(), canForward: v.el.canGoForward() });
      } catch {
        /* the page went away */
      }
    }, SOON_MS);
  };

  /** The page's title and icon into the recent list, once they settle (it is written to storage). */
  const noteSoon = (v: View) => {
    clearTimeout(v.visitTimer);
    v.visitTimer = setTimeout(() => {
      const p = getPage(v.tabId);
      touchVisit(p.url, { title: p.title, ...(p.favicon ? { favicon: p.favicon } : {}) });
    }, 800);
  };

  /** Which view is in front: the others are hidden (no painting) and the shell mutes and slows them. */
  const syncShown = () => {
    const front = activeTab(sessionId);
    for (const v of views.current.values()) {
      const inFront = v.tabId === front;
      v.el.toggleAttribute('data-hidden', !inFront);
      const shown = inFront && activeRef.current;
      if (!v.wcId || v.shown === shown) continue;
      v.shown = shown;
      desktop?.browser?.setShown?.(v.wcId, shown);
    }
  };
  const activeRef = useRef(active);
  activeRef.current = active;

  const dispose = (v: View) => {
    clearTimeout(v.navTimer);
    clearTimeout(v.visitTimer);
    v.unregister();
    v.ready = false;
    v.el.remove();
    views.current.delete(v.tabId);
  };

  const ensureView = useCallback(
    (tid: string, url: string) => {
      if (views.current.has(tid) || !host.current) return false;
      const el = document.createElement('webview') as WebviewEl;
      el.setAttribute('partition', PARTITION);
      el.setAttribute('src', url);
      // Lets window.open and target=_blank reach the shell, which loads them in this view (never a new window).
      el.setAttribute('allowpopups', '');
      el.className = 'bw-webview';
      if (tid !== activeTab(sessionId)) el.setAttribute('data-hidden', '');
      const v: View = { tabId: tid, el, ready: false, wcId: 0, unregister: () => {} };
      const on = (type: string, fn: (e: WebviewEvent) => void) => el.addEventListener(type, fn as EventListener);
      const learnId = () => {
        if (v.wcId) return;
        try {
          v.wcId = el.getWebContentsId();
        } catch {
          /* not attached yet */
        }
        if (v.wcId) syncShown();
      };
      on('did-attach', learnId);
      on('dom-ready', () => {
        v.ready = true;
        v.restarting = false;
        learnId();
        let zoom = getPage(tid).zoom;
        try {
          // Chromium keeps zoom per site: the page tells us what it is now.
          zoom = el.getZoomFactor();
        } catch {
          /* keep ours */
        }
        setPage(tid, { zoom, ...(getPage(tid).loading ? { phase: 3 as const } : {}) });
        refreshNav(v);
      });
      // Set by a failed main-frame load: the engine then commits its own error page and reports
      // did-finish-load for it, which must not clear the failure.
      let failed = false;
      on('did-start-loading', () => {
        failed = false;
        setPage(tid, { loading: true, phase: 1, crashed: undefined, flooded: undefined });
      });
      on('did-stop-loading', () => {
        setPage(tid, { loading: false });
        refreshNav(v);
      });
      // A failed load keeps its view until a load succeeds, so Retry does not flash the engine's own error page.
      on('did-finish-load', () => {
        if (failed) return;
        flushSoon();
        const p = getPage(tid);
        setPage(tid, { error: undefined, errorCode: undefined });
        noteVisit(p.url, p.title, p.favicon);
      });
      on('did-navigate', (e) => {
        if (!e.url) return;
        // What the old document reported last lands before the new one starts.
        flushSoon();
        // The log starts empty once, on the shell's own `doc` event, in order with the batches.
        // A reload of the same address keeps its title and icon: the engine reports them again only when they change.
        const same = getPage(tid).url === e.url;
        setPage(tid, { url: e.url, ...(same ? {} : { title: '', favicon: undefined }), phase: 2 });
        refreshNav(v);
        if (tid === activeTab(sessionId)) setFound(null);
      });
      // A script can change the address, the title and the icon in a loop: these are gathered (setPageSoon).
      on('did-navigate-in-page', (e) => {
        if (!e.isMainFrame || !e.url) return;
        setPageSoon(tid, { url: e.url });
        refreshNav(v);
      });
      on('page-title-updated', (e) => {
        setPageSoon(tid, { title: (e.title ?? '').slice(0, 300) });
        noteSoon(v);
      });
      on('page-favicon-updated', (e) => {
        setPageSoon(tid, { favicon: e.favicons?.find((f) => /^(https:|data:image\/)/.test(f) && f.length < 100_000) });
        noteSoon(v);
      });
      on('did-fail-load', (e) => {
        // -3 is an aborted load (a new navigation replaced it).
        if (!e.isMainFrame || e.errorCode === -3) return;
        failed = true;
        flushSoon();
        setPage(tid, { loading: false, error: e.errorDescription || 'ERR_FAILED', errorCode: e.errorCode, url: e.validatedURL || getPage(tid).url });
        refreshNav(v);
      });
      on('render-process-gone', () => {
        v.ready = false;
        if (v.restarting) return;
        setPage(tid, { crashed: true, hung: undefined, loading: false });
      });
      on('found-in-page', (e) => e.result && tid === activeTab(sessionId) && setFound({ active: e.result.activeMatchOrdinal, total: e.result.matches }));
      host.current.appendChild(el);
      views.current.set(tid, v);
      resetLog(tid);
      // The agent's browser tools reach the page through this (browser-agent.ts); every call has a time limit.
      v.unregister = registerPage({
        sessionId,
        tabId: tid,
        url: () => {
          try {
            return v.ready ? el.getURL() : getPage(tid).url;
          } catch {
            return getPage(tid).url;
          }
        },
        read: async (selector, max) => {
          if (!v.ready) throw new Error('The page is still starting.');
          const r = (await within(el.executeJavaScript(readScript(selector, max)))) as { title?: unknown; text?: unknown; length?: unknown; missing?: boolean; badSelector?: boolean } | null;
          return {
            title: typeof r?.title === 'string' ? r.title : '',
            text: typeof r?.text === 'string' ? r.text : '',
            length: typeof r?.length === 'number' ? r.length : 0,
            missing: r?.missing === true,
            badSelector: r?.badSelector === true,
          };
        },
        capture: async () => {
          if (!v.ready || !desktop?.browser) throw new Error('The page is still starting.');
          return within(desktop.browser.capture(el.getWebContentsId(), { forAgent: true }));
        },
        run: async (script) => {
          if (!v.ready) throw new Error('The page is still starting.');
          // Callers give their own, shorter limits; this one only makes sure nothing waits forever.
          return within(el.executeJavaScript(script), 60_000);
        },
        key: async (combo) => {
          if (!v.ready || typeof el.sendInputEvent !== 'function') return false;
          const { key, mods } = parseKey(combo);
          const keyCode = INPUT_KEY[key] ?? key;
          const ch = key === 'Space' ? ' ' : key;
          const typed = ch.length === 1 && !mods.some((m) => m !== 'shift');
          const send = (ev: Parameters<NonNullable<WebviewEl['sendInputEvent']>>[0]) => within(Promise.resolve(el.sendInputEvent!(ev)), 5_000);
          await send({ type: 'keyDown', keyCode, modifiers: mods });
          if (typed) await send({ type: 'char', keyCode: ch, modifiers: mods });
          else if (key === 'Enter' && !mods.length) await send({ type: 'char', keyCode: '\u000d' });
          await send({ type: 'keyUp', keyCode, modifiers: mods });
          return true;
        },
        history: (action) => {
          if (!v.ready) return false;
          try {
            if (action === 'back') {
              if (!el.canGoBack()) return false;
              el.goBack();
            } else if (action === 'forward') {
              if (!el.canGoForward()) return false;
              el.goForward();
            } else el.reload();
            return true;
          } catch {
            return false;
          }
        },
        ...pointerRef.current(() => (v.ready ? el : null)),
        guestId: () => v.wcId,
      });
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  // Keys typed inside a page reach the app only through the shell: the same keys as in the tab's own bar.
  const guestKey = useRef<(key: string) => void>(() => {});

  useEffect(() => {
    if (!native) return;
    const byWc = (id?: number) => {
      if (!id) return undefined;
      for (const v of views.current.values()) if (v.wcId === id) return v;
      return undefined;
    };
    const off = desktop?.browser?.onEvent((e) => {
      if (e.type === 'download-blocked') {
        useStore.getState().toast(`Downloads are off in the panel browser${e.name ? ` (${e.name})` : ''}. Open the page in your browser to download.`);
        return;
      }
      const v = byWc(e.id);
      if (!v) return;
      // A batch of a document that is no longer the page's is dropped (it would read as the new page's).
      if ((e.type === 'console' || e.type === 'net' || e.type === 'net-dropped') && typeof e.doc === 'number' && e.doc < (v.doc ?? 0)) return;
      if (e.type === 'doc' && typeof e.doc === 'number') {
        v.doc = e.doc;
        resetLog(v.tabId);
      } else if (e.type === 'find') guestKey.current('f');
      else if (e.type === 'key' && e.key && v.tabId === activeTab(sessionId)) guestKey.current(e.key);
      // A request of this page failed (the shell sends the address without its query, and the status or error).
      else if (e.type === 'net' && e.url) logFailed(v.tabId, { url: e.url, method: e.method, status: e.status, error: e.error });
      else if (e.type === 'net-dropped') failedDropped(v.tabId, e.count ?? 0);
      // What the page logged, in capped batches; errors and warnings also go with browser_read.
      else if (e.type === 'console') {
        for (const l of e.lines ?? []) if (l.text) logLine(v.tabId, { level: levelOf(l.level), text: l.text, source: l.source });
        logDropped(v.tabId, e.count ?? 0);
      } else if (e.type === 'hang') setPage(v.tabId, { hung: e.on ? true : undefined });
      // Electron main ended a sign-in's hold (a new document replaced the filled one, or nothing was filled).
      else if (e.type === 'signin-released' && e.hold && getPage(v.tabId).hold === e.hold) setPage(v.tabId, { filled: undefined, signing: undefined, hold: undefined });
      else if (e.type === 'flood') setPage(v.tabId, { flooded: true });
    });
    const all = views.current;
    return () => {
      off?.();
      for (const v of [...all.values()]) dispose(v);
      for (const id of getTabs(sessionId).ids) setPage(id, { loading: false, hung: undefined });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The tab in front gets its view when it has a page and none yet (a new tab, a reopened one, or the panel opened again).
  useEffect(() => {
    if (!native) return;
    const p = getPage(tabId);
    if (!p.url || views.current.has(tabId)) return;
    setPage(tabId, { loading: true, phase: 1, canBack: false, canForward: false, crashed: undefined, hung: undefined });
    ensureView(tabId, p.url);
  }, [tabId, page.url, ensureView]);

  // Closed tabs lose their view; the one in front shows and runs, the rest are hidden and slowed.
  useEffect(() => {
    for (const v of [...views.current.values()]) if (!tabs.ids.includes(v.tabId)) dispose(v);
    syncShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.ids, tabId, active]);

  // Another tab came to the front: what belonged to the last one's page closes.
  const shownTab = useRef(tabId);
  useEffect(() => {
    if (shownTab.current === tabId) return;
    shownTab.current = tabId;
    setFinding(false);
    setFound(null);
    setRegion(false);
    setPicking(false);
  }, [tabId]);

  /* ── navigation ── */

  const go = useCallback(
    (raw: string) => {
      const url = normalizeAddress(raw);
      if (!url) {
        toast('Only web addresses open here');
        return false;
      }
      const tid = activeTab(sessionId);
      if (native) {
        if (isAppOrigin(url)) {
          toast('Sable itself does not open in the panel browser');
          return false;
        }
        setPage(tid, { url, title: '', favicon: undefined, error: undefined, errorCode: undefined, crashed: undefined, hung: undefined, loading: true, phase: 1 });
        if (!ensureView(tid, url)) load(tid, url);
      } else {
        pushHistory(tid, url);
      }
      // A page asked for from elsewhere replaces whatever was half-typed in the address field.
      input.current?.blur();
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, ensureView, toast],
  );

  /** Loads an address in a tab's existing view. */
  function load(tid: string, url: string) {
    const v = views.current.get(tid);
    if (!v) return;
    if (v.ready) v.el.loadURL(url).catch(() => {});
    else v.el.setAttribute('src', url);
  }

  /** Runs a call on the page's view, if it is there and alive. */
  const withView = (fn: (el: WebviewEl) => void) => {
    const v = live();
    if (!v) return;
    try {
      fn(v.el);
    } catch {
      /* the page went away between the check and the call */
    }
  };

  const back = () => (native ? withView((el) => el.goBack()) : stepHistory(tabId, -1));
  const forward = () => (native ? withView((el) => el.goForward()) : stepHistory(tabId, 1));
  const reload = (hard = false) => {
    if (!native) {
      setPage(tabId, { nonce: page.nonce + 1, loading: true, phase: 1 });
      return;
    }
    const v = views.current.get(tabId);
    // A page that hangs cannot reload itself: its view starts over in a fresh one.
    if (page.hung && v) {
      dispose(v);
      setPage(tabId, { hung: undefined, crashed: undefined, loading: true, phase: 1 });
      ensureView(tabId, page.url);
      return;
    }
    // After a crash or a failed load, load the address again rather than reloading the engine's error page.
    if (page.crashed || page.error) {
      setPage(tabId, { crashed: undefined, flooded: undefined, loading: true, phase: 1 });
      load(tabId, page.url);
    } else withView((el) => (hard ? el.reloadIgnoringCache() : el.reload()));
  };
  const stop = () => withView((el) => el.stop());

  const zoomTo = (zoom: number) =>
    withView((el) => {
      el.setZoomFactor(zoom);
      setPage(tabId, { zoom });
    });
  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > page.zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < page.zoom - 0.001);
    if (next) zoomTo(next);
  };
  const devTools = () => withView((el) => (el.isDevToolsOpened() ? el.closeDevTools() : el.openDevTools()));
  const setDevice = (device: Device) => setPage(tabId, { device });

  /* ── tabs ── */

  const newTab = () => {
    if (!openTab(sessionId)) {
      toast(`Up to ${TABS_MAX} tabs`);
      return;
    }
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  };
  const closeActive = () => closeTab(sessionId, activeTab(sessionId));
  const reopen = () => {
    if (!getTabs(sessionId).closed.length) return;
    if (!reopenTab(sessionId)) toast(`Up to ${TABS_MAX} tabs`);
  };

  /* ── find in page ── */

  const [findKey, setFindKey] = useState(0);
  const openFind = () => {
    setFinding(true);
    setFindKey((k) => k + 1);
  };
  const find = (text: string, dir?: 1 | -1) =>
    withView((el) => {
      if (!text) {
        el.stopFindInPage('clearSelection');
        setFound(null);
      } else el.findInPage(text, dir ? { forward: dir > 0, findNext: false } : { findNext: true });
    });
  const closeFind = () => {
    setFinding(false);
    setFound(null);
    withView((el) => el.stopFindInPage('clearSelection'));
  };

  /* ── device sizes: the page centred at a fixed width, scaled down to fit ── */

  const viewBox = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewBox.current;
    if (page.device === 'desktop' || !el) return;
    setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.device]);

  const dev = DEVICES[page.device];
  let stage: CSSProperties | undefined;
  let stageInfo: { w: number; h: number; pct: number } | null = null;
  if (page.device !== 'desktop' && box.w > 0) {
    const s = Math.min(1, (box.w - STAGE_PAD * 2) / dev.w);
    const h = Math.max(200, Math.round(Math.min(dev.h, (box.h - STRIP_H - STAGE_PAD) / s)));
    stage = { width: dev.w, height: h, top: STRIP_H, transform: `translateX(-50%) scale(${s})` };
    stageInfo = { w: dev.w, h, pct: Math.round(s * 100) };
  }

  // Another part of the app asked for a page (a local link in the conversation, /browser, the palette).
  const wanted = useStore((s) => s.ui.browserUrl);
  useEffect(() => {
    if (!wanted || useStore.getState().ui.browserUrl !== wanted) return;
    useStore.getState().setUi({ browserUrl: undefined });
    go(wanted);
  }, [wanted, go]);

  useEffect(() => {
    if (!active || getPage(tabId).url) return;
    const raf = requestAnimationFrame(() => {
      // A page may have been asked for in the meantime: then the address field stays at rest.
      if (!getPage(activeTab(sessionId)).url) input.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, sessionId, tabId]);

  /* ── page actions ── */

  const copyLink = () =>
    navigator.clipboard.writeText(page.url).then(
      () => toast('Link copied', 'success'),
      () => toast('Could not reach the clipboard', 'error'),
    );

  const openOutside = () => window.open(page.url, '_blank', 'noopener,noreferrer');

  const acceptsImages = () => useStore.getState().data[sessionId]?.caps?.features.images !== false;
  const siteName = () => {
    try {
      return new URL(getPage(activeTab(sessionId)).url).host || 'page';
    } catch {
      return 'page';
    }
  };

  /** A picture into the message being written; false when it has no room for one. */
  const attach = (dataUrl: string, name: string) => {
    const cur = useStore.getState().drafts[sessionId]?.attachments ?? [];
    if (cur.filter((a) => a.kind === 'image').length >= 10) {
      toast('Up to 10 images per message');
      return false;
    }
    const att: Attachment = { id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind: 'image', name, mime: 'image/png', dataUrl, size: dataUrlBytes(dataUrl) };
    useStore.getState().setDraft(sessionId, { attachments: [...cur, att] });
    return true;
  };

  const attachShot = async () => {
    const v = live();
    if (!v || !desktop?.browser) return;
    if (!acceptsImages()) {
      toast('This agent does not accept images');
      return;
    }
    try {
      const dataUrl = await within(desktop.browser.capture(v.el.getWebContentsId()));
      if (!attach(dataUrl, `Screenshot of ${siteName()}.png`)) return;
      toast('Screenshot attached to your message', 'success');
      focusComposer();
    } catch {
      toast('Could not capture the page', 'error');
    }
  };

  /* ── pick an element: hover outlines it in the page, a click puts a reference to it in the message ── */

  const [picking, setPicking] = useState(false);
  const pickRun = useRef(0);
  const pick = async () => {
    const v = live();
    if (!v || !desktop?.browser || page.error || page.crashed || page.hung) return;
    const el = v.el;
    if (picking) {
      // A page that hangs never answers the cancel: the bar lets go of it either way.
      pickRun.current++;
      setPicking(false);
      void within(el.executeJavaScript(pickCancelScript), 3_000).catch(() => {});
      return;
    }
    setRegion(false);
    setPicking(true);
    const run = ++pickRun.current;
    try {
      // Keys go to the page while picking, so Escape ends it there.
      el.focus();
      const r = (await el.executeJavaScript(pickScript)) as Picked | null;
      if (run !== pickRun.current || !r || typeof r.selector !== 'string' || !r.rect) return;
      if (acceptsImages() && r.rect.w >= 1 && r.rect.h >= 1) {
        try {
          const full = await within(desktop.browser.capture(el.getWebContentsId()));
          const shot = await cropImage(full, r.rect, r.vw, 8);
          attach(shot, `${r.tag} on ${siteName()}.png`);
        } catch {
          /* the reference still goes in, without its picture */
        }
      }
      focusComposer(`${pickedText(r, getPage(v.tabId).url)} `, { append: true });
    } catch {
      if (run === pickRun.current) toast('Could not pick an element on this page', 'error');
    } finally {
      if (run === pickRun.current) setPicking(false);
    }
  };

  /* ── a region of the page as a picture ── */

  const [region, setRegion] = useState(false);
  const startRegion = () => {
    const v = live();
    if (!v || !desktop?.browser) return;
    if (!acceptsImages()) {
      toast('This agent does not accept images');
      return;
    }
    if (picking) {
      pickRun.current++;
      setPicking(false);
      void within(v.el.executeJavaScript(pickCancelScript), 3_000).catch(() => {});
    }
    setRegion(true);
  };
  const takeRegion = async (r: { x: number; y: number; w: number; h: number } | null) => {
    setRegion(false);
    const v = live();
    if (!r || !v || !desktop?.browser) return;
    try {
      // The view as laid out (a device size scales it): the picture maps onto this box.
      const box = v.el.getBoundingClientRect();
      const frame = viewBox.current?.getBoundingClientRect();
      if (!frame || box.width < 1) return;
      const full = await within(desktop.browser.capture(v.el.getWebContentsId()));
      const shot = await cropImage(full, { x: r.x + frame.left - box.left, y: r.y + frame.top - box.top, w: r.w, h: r.h }, box.width, 0);
      if (!attach(shot, `Part of ${siteName()}.png`)) return;
      toast('Picture attached to your message', 'success');
      focusComposer();
    } catch {
      toast('Could not capture that part of the page', 'error');
    }
  };

  /* ── the page's console and failed requests, under the page ── */

  const [drawer, setDrawer] = useState(false);

  const clearData = async () => {
    try {
      await desktop?.browser?.clearData();
      toast('Cleared cookies, storage and cache for the panel browser', 'success');
      if (page.url) reload();
    } catch {
      toast('Could not clear browsing data', 'error');
    }
  };

  const canBack = native ? page.canBack : page.index > 0;
  const canForward = native ? page.canForward : page.index < page.history.length - 1;
  const showNote = !native && !!page.url && !isLocalUrl(page.url);
  const busy = page.loading && !page.error;

  /** The Browser's own keys: tabs, the address, find, and the tools on the keys developer tools use. */
  const key = (k: string): boolean => {
    if (k === 't') newTab();
    else if (k === 'w') closeActive();
    else if (k === 'shift+t') reopen();
    else if (k === 'l') {
      input.current?.focus();
      input.current?.select();
    } else if (k === 'f' && native && page.url) openFind();
    else if (native && page.url && (k === 'shift+c' || k === 'shift+s' || k === 'shift+j')) {
      if (k === 'shift+c') void pick();
      else if (k === 'shift+s') startRegion();
      else setDrawer((d) => !d);
    } else return false;
    return true;
  };
  guestKey.current = (k) => void key(k);

  const onKey = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    const combo = e.shiftKey ? `shift+${k}` : k;
    if (!key(combo)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="rail-col bw" onKeyDown={onKey}>
      <div className="bw-bar">
        <IconButton icon="arrow-left" label="Back" size={15} disabled={!canBack} onClick={back} />
        <IconButton icon="arrow-right" label="Forward" size={15} disabled={!canForward} onClick={forward} />
        <Tip label={native && page.loading ? 'Stop' : 'Reload'}>
          <button
            type="button"
            className="icon-btn bw-reload"
            aria-label={native && page.loading ? 'Stop' : 'Reload'}
            data-loading={(native && page.loading) || undefined}
            disabled={!page.url}
            onClick={() => (native && page.loading && !page.hung ? stop() : reload())}
          >
            <Icon name="reload" size={15} className="bw-reload-a" />
            <Icon name="x" size={14} className="bw-reload-b" />
          </button>
        </Tip>
        <AddressField key={`addr:${tabId}`} url={page.url} title={page.title} favicon={page.favicon} zoom={page.zoom} agent={page.agent} picking={picking} onResetZoom={() => zoomTo(1)} inputRef={input} onGo={go} />
        <PagesMenu sessionId={sessionId} ids={tabs.ids} active={tabId} canReopen={tabs.closed.length > 0} onNew={newTab} onReopen={reopen} />
        {native && (
          <>
            <IconButton icon="cursor-click" label={picking ? 'Stop picking' : 'Pick an element'} keys="mod+shift+c" size={15} active={picking} disabled={!page.url || !!page.error || !!page.crashed || !!page.hung} onClick={() => void pick()} />
            <LogToggle tabId={tabId} open={drawer} disabled={!page.url} onToggle={() => setDrawer((d) => !d)} />
          </>
        )}
        <Menu>
          <Tip label="More">
            <MenuTrigger className="icon-btn" aria-label="More" disabled={!page.url}>
              <Icon name="dots" size={15} />
            </MenuTrigger>
          </Tip>
          <MenuContent align="end" width={292}>
            {/* From two pages on, the pages control beside the address has New tab. */}
            {tabs.ids.length < 2 && (
              <>
                <MenuItem icon="plus" keys="mod+t" onSelect={newTab}>
                  New tab
                </MenuItem>
                <MenuSep />
              </>
            )}
            <MenuItem icon="external" onSelect={openOutside}>
              Open in your browser
            </MenuItem>
            <MenuItem icon="link" onSelect={() => void copyLink()}>
              Copy link
            </MenuItem>
            <MenuSep />
            <MenuItem icon="at" onSelect={() => focusComposer(`${page.url} `, { append: true })}>
              Mention this page in chat
            </MenuItem>
            {native && (
              <>
                <MenuItem icon="image" onSelect={() => void attachShot()}>
                  Add screenshot to message
                </MenuItem>
                <MenuItem icon="expand" onSelect={startRegion}>
                  Add region to message
                </MenuItem>
                <MenuSep />
                <MenuItem icon="file-search" onSelect={openFind}>
                  Find in page
                </MenuItem>
                <MenuItem icon="zoom-in" disabled={page.zoom >= ZOOMS[ZOOMS.length - 1]} onSelect={() => zoomStep(1)}>
                  Zoom in
                </MenuItem>
                <MenuItem icon="zoom-out" disabled={page.zoom <= ZOOMS[0]} onSelect={() => zoomStep(-1)}>
                  Zoom out
                </MenuItem>
                <MenuItem icon="search" hint={<span className="num">{Math.round(page.zoom * 100)}%</span>} disabled={page.zoom === 1} onSelect={() => zoomTo(1)}>
                  Actual size
                </MenuItem>
              </>
            )}
            <MenuSep />
            <DeviceMenu device={page.device} onPick={setDevice} />
            <MenuSep />
            <MenuItem icon="refresh" onSelect={() => reload(true)}>
              Hard reload
            </MenuItem>
            {native && (
              <MenuItem icon="code" onSelect={devTools}>
                Developer tools
              </MenuItem>
            )}
            {native && (
              <MenuItem icon="broom" onSelect={() => void clearData()}>
                Clear browsing data
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
        <LoadLine key={`load:${tabId}`} loading={busy} phase={page.phase} />
      </div>

      <AnimatePresence initial={false}>
        {finding && native && page.url && <FindBar key="find" focusKey={findKey} found={found} onFind={find} onClose={closeFind} />}
      </AnimatePresence>

      {showNote && (
        <div className="bw-note">
          <Icon name="info" size={14} />
          <span className="bw-note-text">This site may not load here.</span>
          <button type="button" className="btn btn-sm" onClick={openOutside}>
            Open in your browser
          </button>
        </div>
      )}

      <AgentLine key={`line:${tabId}`} tabId={tabId} provider={provider} running={running} onStop={stopAgent} />

      <div className="bw-view" ref={viewBox} data-device={stage ? page.device : undefined} data-empty={!page.url || undefined}>
        {stageInfo && (
          <div className="bw-device">
            <Icon name={DEVICE_ICON[page.device]} size={14} />
            <span className="bw-device-name">{dev.label}</span>
            <span className="num">
              {stageInfo.w} × {stageInfo.h}
            </span>
            {stageInfo.pct < 100 && <span className="num">{stageInfo.pct}%</span>}
            <IconButton icon="x" label="Back to full width" size={13} className="bw-device-close" onClick={() => setDevice('desktop')} />
          </div>
        )}
        <div className="bw-host" ref={host} style={stage}>
          {!native && tabs.ids.map((id) => <TabFrame key={id} sessionId={sessionId} tabId={id} shown={id === tabId} pointer={pointerRef} />)}
        </div>
        <div className="bw-pointer-layer" ref={pointerLayer} aria-hidden />
        <SignInCard tabId={tabId} />
        {native && page.url && page.crashed ? (
          <PageState title={page.flooded ? 'This page was stopped' : 'This page stopped working'} detail={page.flooded ? 'It logged faster than Sable can keep up' : addressParts(page.url).host}>
            <button type="button" className="btn btn-sm" onClick={() => reload()}>
              <Icon name="reload" size={14} />
              Reload
            </button>
          </PageState>
        ) : native && page.url && page.hung ? (
          <PageState title="This page is not responding" detail={addressParts(page.url).host}>
            <button type="button" className="btn btn-sm" onClick={() => reload()}>
              <Icon name="reload" size={14} />
              Reload
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPage(tabId, { hung: undefined })}>
              Wait
            </button>
          </PageState>
        ) : native && page.url && page.error ? (
          <PageState title={failure(page.errorCode, page.url)} detail={page.error}>
            <button type="button" className="btn btn-sm" disabled={page.loading} onClick={() => reload()}>
              {page.loading ? <Spinner size={12} /> : <Icon name="reload" size={14} />}
              Retry
            </button>
            {!isLocalUrl(page.url) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={openOutside}>
                Open in your browser
              </button>
            )}
          </PageState>
        ) : null}
        {!page.url && <StartView sessionId={sessionId} onGo={go} />}
        {region && native && page.url && <RegionPick onDone={(r) => void takeRegion(r)} />}
      </div>

      <AnimatePresence initial={false}>{drawer && native && page.url && <LogDrawer key="log" tabId={tabId} url={page.url} onClose={() => setDrawer(false)} />}</AnimatePresence>
    </div>
  );
}

/** Web build: one sandboxed frame per tab; only the tab in front is shown. */
function TabFrame({
  sessionId,
  tabId,
  shown,
  pointer,
}: {
  sessionId: string;
  tabId: string;
  shown: boolean;
  pointer: React.RefObject<(view: () => HTMLElement | null) => Pick<PageController, 'point' | 'press'>>;
}) {
  const page = usePage(tabId);
  const frameUrl = page.history[page.index] ?? '';
  const frame = useRef<HTMLIFrameElement>(null);
  const frameKey = `${page.index}:${page.nonce}:${frameUrl}`;
  // Dev build only: a local page that answers Sable's messages can be worked by the agent (dev-frame.ts).
  useEffect(() => {
    const el = frame.current;
    if (!import.meta.env.DEV || !el || !frameUrl) return;
    return connectDevFrame(el, tabId, sessionId, registerPage, pointer.current(() => frame.current));
  }, [frameKey, frameUrl, tabId, sessionId, pointer]);
  if (!frameUrl) return null;
  return (
    <iframe
      ref={frame}
      key={frameKey}
      className="bw-frame"
      data-hidden={!shown || undefined}
      src={frameUrl}
      title={prettyUrl(frameUrl)}
      // The app's own origin runs without allow-same-origin, so a page there cannot reach the app.
      sandbox={isAppOrigin(frameUrl) ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox' : 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'}
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        e.currentTarget.dataset.loaded = '';
        setPage(tabId, { loading: false });
        // A frame reports a load even when the site refused to be embedded: only local pages count as visited.
        if (isLocalUrl(frameUrl)) noteVisit(frameUrl, '');
      }}
    />
  );
}

/**
 * The session's pages, as one control in the address row (no strip of its own): a small framed
 * count that opens the list. Each row shows the page's icon and title, the one in front checked;
 * a close mark answers on hover (Delete from the keyboard, or a middle click). Shown from two pages
 * on; with one, New tab is in the More menu and on Mod+T.
 */
function PagesMenu({
  sessionId,
  ids,
  active,
  canReopen,
  onNew,
  onReopen,
}: {
  sessionId: string;
  ids: string[];
  active: string;
  canReopen: boolean;
  onNew: () => void;
  onReopen: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Kept while its menu is open, so closing pages down to one does not pull the menu away.
  if (ids.length < 2 && !open) return null;
  const label = `${ids.length} ${ids.length === 1 ? 'page' : 'pages'}`;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <MenuTrigger className="icon-btn bw-pages" aria-label={label}>
          <span className="bw-pages-count num" aria-hidden>
            {ids.length}
          </span>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end" width={272} className="bw-pages-menu">
        {ids.map((id) => (
          <PageItem key={id} sessionId={sessionId} tabId={id} active={id === active} />
        ))}
        <MenuSep />
        <MenuItem icon="plus" keys="mod+t" disabled={ids.length >= TABS_MAX} onSelect={onNew}>
          New tab
        </MenuItem>
        {canReopen && (
          <MenuItem icon="rewind" keys="mod+shift+t" onSelect={onReopen}>
            Reopen closed tab
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

function PageItem({ sessionId, tabId, active }: { sessionId: string; tabId: string; active: boolean }) {
  const p = usePage(tabId);
  const parts = p.url ? addressParts(p.url) : null;
  const name = p.title || parts?.search || parts?.host || 'New tab';
  const close = () => closeTab(sessionId, tabId);
  // The close mark is a pointer affordance inside the row: it must not reach the row's own press
  // (which would switch to the page and close the menu).
  const keep = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <RM.Item
      className="menu-item bw-page"
      data-active={active || undefined}
      aria-label={active ? `${name}, in front` : name}
      title={p.url ? `${name}\n${prettyUrl(p.url)}` : undefined}
      onSelect={() => selectTab(sessionId, tabId)}
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        close();
      }}
      onMouseDown={(e) => {
        // The middle button would start the page's auto-scroll.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        close();
      }}
    >
      <span className="bw-tab-icon" aria-hidden>
        {p.loading && !p.error && p.url ? (
          <Spinner size={11} />
        ) : p.crashed || p.hung ? (
          <Icon name="warning" size={13} className="bw-site-icon" />
        ) : p.url ? (
          <SiteIcon src={p.favicon} fallback={siteFallback(p.url)} size={13} />
        ) : (
          <Icon name="globe" size={13} className="bw-site-icon" />
        )}
      </span>
      <span className="grow truncate">{name}</span>
      {active && <Icon name="check" size={14} className="bw-page-check" />}
      <button type="button" className="bw-page-close" tabIndex={-1} aria-hidden onPointerDown={keep} onPointerUp={keep} onClick={(e) => (keep(e), close())}>
        <Icon name="x" size={11} />
      </button>
    </RM.Item>
  );
}

/** A part of a picture of the page: `r` in the page's own pixels, `viewW` the page's width in them. */
async function cropImage(src: string, r: { x: number; y: number; w: number; h: number }, viewW: number, pad: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('no picture'));
    i.src = src;
  });
  const k = img.naturalWidth / Math.max(1, viewW);
  const x0 = Math.max(0, Math.floor((r.x - pad) * k));
  const y0 = Math.max(0, Math.floor((r.y - pad) * k));
  const x1 = Math.min(img.naturalWidth, Math.ceil((r.x + r.w + pad) * k));
  const y1 = Math.min(img.naturalHeight, Math.ceil((r.y + r.h + pad) * k));
  if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('nothing to crop');
  const canvas = document.createElement('canvas');
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  canvas.getContext('2d')!.drawImage(img, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** The picked element in one line for the message: what it is, where, its selector, its text when that says more. */
function pickedText(r: Picked, url: string): string {
  const where = prettyUrl(url.split(/[?#]/)[0]);
  const what = String(r.what || r.tag).slice(0, 120);
  const text = String(r.text || '').replace(/\s+/g, ' ').trim();
  const said = text && !what.includes(text.slice(0, 60)) ? `, text "${text.length > 140 ? `${text.slice(0, 139)}…` : text}"` : '';
  return `The ${what} on ${where} (\`${String(r.selector).slice(0, 200).replace(/`/g, '')}\`${said})`;
}

/** Drag a rectangle over the page; Escape or a plain click gives it up. */
function RegionPick({ onDone }: { onDone: (r: { x: number; y: number; w: number; h: number } | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const at = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)) };
  };
  return (
    <div
      ref={ref}
      className="bw-region"
      tabIndex={-1}
      role="application"
      aria-label="Drag over the part of the page to attach. Escape cancels."
      data-escape-scope=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onDone(null);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = at(e);
        setBox({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        const a = start.current;
        if (!a) return;
        const b = at(e);
        setBox({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
      }}
      onPointerUp={() => {
        const b = box;
        start.current = null;
        onDone(b && b.w >= 6 && b.h >= 6 ? b : null);
      }}
      onPointerCancel={() => onDone(null)}
    >
      {box ? (
        <div className="bw-region-box" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}>
          {box.w > 56 && box.h > 26 && (
            <span className="bw-region-size num">
              {Math.round(box.w)} × {Math.round(box.h)}
            </span>
          )}
        </div>
      ) : (
        <span className="bw-region-hint">Drag over the part to attach</span>
      )}
    </div>
  );
}

/** The drawer's switch in the toolbar; a count shows only while the page has errors. */
function LogToggle({ tabId, open, disabled, onToggle }: { tabId: string; open: boolean; disabled: boolean; onToggle: () => void }) {
  useLogVersion(tabId);
  const errors = disabled ? 0 : getLog(tabId).feed.reduce((n, f) => n + (f.level === 'error' ? 1 : 0), 0);
  const label = open ? 'Hide console' : 'Show console';
  return (
    <Tip label={errors ? `${label} (${errors} error${errors === 1 ? '' : 's'})` : label} keys="mod+shift+j">
      <button type="button" className="icon-btn bw-log-toggle" aria-label={label} aria-pressed={open} data-active={open || undefined} disabled={disabled} onClick={onToggle}>
        <Icon name="terminal" size={15} />
        {errors > 0 && (
          <span className="bw-log-count num" aria-hidden>
            {errors > 99 ? '99+' : errors}
          </span>
        )}
      </button>
    </Tip>
  );
}

/** "app.js:12" from a script's address; the document itself is the page. */
const fileOf = (source?: string) => {
  if (!source) return '';
  const name = source.replace(/^.*\//, '');
  return (name.startsWith(':') || !name ? `page${name}` : name).slice(-48);
};
const feedLine = (f: FeedEntry) => `${f.request ? 'request' : f.level}: ${f.text.length > 300 ? `${f.text.slice(0, 299)}…` : f.text}${f.source ? ` (${fileOf(f.source)})` : ''}`;

/** The page's console lines and failed requests since it loaded, newest last; any line, or all of them, goes to the message. */
function LogDrawer({ tabId, url, onClose }: { tabId: string; url: string; onClose: () => void }) {
  const v = useLogVersion(tabId);
  const log = getLog(tabId);
  const feed = log.feed;
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [v]);

  const errors = feed.filter((f) => f.level === 'error').length;
  const warnings = feed.filter((f) => f.level === 'warning').length;
  const where = prettyUrl(url.split(/[?#]/)[0]);
  const send = (lines: FeedEntry[]) => {
    if (!lines.length) return;
    const text = lines.length === 1 ? `From the console of ${where}:\n\`${feedLine(lines[0]).replace(/`/g, "'")}\`` : `From the console of ${where}:\n${lines.map((f) => `- ${feedLine(f)}`).join('\n')}`;
    focusComposer(`${text}\n`, { append: true });
  };
  // All of it means the problems when there are some: that is what a message about a page needs.
  const sendAll = () => {
    const problems = feed.filter((f) => f.level === 'error' || f.level === 'warning');
    send((problems.length ? problems : feed).slice(-30));
  };

  return (
    <motion.div className="bw-log" initial={{ height: 0, opacity: 0 }} animate={{ height: 208, opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 40 }}>
      <div className="bw-log-bar">
        <span className="bw-log-title">Console</span>
        <span className="bw-log-sum num">{errors || warnings ? [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') : feed.length ? `${feed.length} line${feed.length === 1 ? '' : 's'}` : ''}</span>
        <button type="button" className="btn btn-sm btn-ghost bw-log-send" disabled={!feed.length} onClick={sendAll}>
          <Icon name="chat" size={14} />
          Send to chat
        </button>
        <IconButton icon="broom" label="Clear" size={14} disabled={!feed.length} onClick={() => resetLog(tabId)} />
        <IconButton icon="x" label="Hide console" size={13} onClick={onClose} />
      </div>
      <div
        className="bw-log-list scroll"
        ref={list}
        role="log"
        aria-label="Console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {feed.length === 0 ? (
          <p className="bw-log-empty">Nothing logged since the page loaded.</p>
        ) : (
          <>
            {log.moreFeed > 0 && <p className="bw-log-more">{log.moreFeed} earlier lines left out</p>}
            {feed.map((f) => (
              <div key={f.n} className="bw-log-row" data-level={f.level}>
                <span className="bw-log-mark" aria-hidden>
                  {f.level === 'error' ? <Icon name="x-circle" size={13} /> : f.level === 'warning' ? <Icon name="warning" size={13} /> : null}
                </span>
                <span className="bw-log-text">{f.text}</span>
                {f.source && <span className="bw-log-src">{fileOf(f.source)}</span>}
                <IconButton icon="chat" label="Send to chat" size={13} className="bw-log-act" onClick={() => send([f])} />
              </div>
            ))}
          </>
        )}
      </div>
    </motion.div>
  );
}

/**
 * The progress line under the toolbar. It jumps to a stage as the load comes along (started,
 * committed, document ready) and creeps within it, then completes and fades. Transform and
 * opacity only; a new load starts from zero without animating back.
 */
function LoadLine({ loading, phase }: { loading: boolean; phase: 1 | 2 | 3 }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loading) {
      if (el.dataset.state !== 'on') {
        el.dataset.state = 'reset';
        void el.offsetWidth;
      }
      el.dataset.state = 'on';
      el.dataset.phase = String(phase);
    } else if (el.dataset.state === 'on') el.dataset.state = 'done';
  }, [loading, phase]);
  return <span ref={ref} className="bw-load" aria-hidden />;
}

/** A state in place of the page: what happened in one line, the engine's own words dim, then what to do. */
function PageState({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="bw-state" role="alert">
      <p className="bw-state-title">{title}</p>
      {detail && <p className="bw-state-detail">{detail}</p>}
      <div className="bw-state-acts">{children}</div>
    </div>
  );
}

/** Desktop, tablet or phone width, as a submenu of the page menu. */
function DeviceMenu({ device, onPick }: { device: Device; onPick: (d: Device) => void }) {
  return (
    <RM.Sub>
      <RM.SubTrigger className="menu-item">
        <Icon name={DEVICE_ICON[device]} size={16} />
        <span className="grow truncate">Device size</span>
        <span className="hint">{DEVICES[device].label}</span>
        <Icon name="caret-right" size={11} />
      </RM.SubTrigger>
      <RM.Portal>
        <RM.SubContent className="pop" data-spot="" sideOffset={6} alignOffset={-4} collisionPadding={10} style={{ minWidth: 168, width: 168 }}>
          {(Object.keys(DEVICES) as Device[]).map((d) => (
            <MenuItem key={d} icon={DEVICE_ICON[d]} checked={d === device} onSelect={() => onPick(d)}>
              {DEVICES[d].label}
            </MenuItem>
          ))}
        </RM.SubContent>
      </RM.Portal>
    </RM.Sub>
  );
}

/** Find in page: a slim bar under the toolbar. Enter for the next match, Shift+Enter for the previous one. */
function FindBar({
  focusKey,
  found,
  onFind,
  onClose,
}: {
  focusKey: number;
  found: { active: number; total: number } | null;
  onFind: (text: string, dir?: 1 | -1) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const take = () => {
      ref.current?.focus();
      ref.current?.select();
    };
    take();
    // Opened from the page menu: the menu keeps focus while it closes, then hands it back to its trigger.
    const again = () => {
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('.bw-bar, [role="menu"]')) take();
    };
    const t = [setTimeout(again, 160), setTimeout(again, 320)];
    return () => t.forEach(clearTimeout);
  }, [focusKey]);

  return (
    <motion.div
      className="bw-find"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 40 }}
    >
      <div className="bw-find-row">
        <label className="bw-find-field">
          <Icon name="search" size={14} />
          <input
            ref={ref}
            value={text}
            placeholder="Find in page"
            aria-label="Find in page"
            spellCheck={false}
            data-escape-scope=""
            onChange={(e) => {
              setText(e.target.value);
              onFind(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (text) onFind(text, e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          {text && (
            <span className="bw-find-count num" aria-live="polite">
              {found ? (found.total ? `${found.active} of ${found.total}` : 'No matches') : ''}
            </span>
          )}
        </label>
        <IconButton icon="caret-up" label="Previous match" size={13} disabled={!found?.total} onClick={() => onFind(text, -1)} />
        <IconButton icon="caret-down" label="Next match" size={13} disabled={!found?.total} onClick={() => onFind(text, 1)} />
        <IconButton icon="x" label="Close" size={13} onClick={onClose} />
      </div>
    </motion.div>
  );
}

/** A site's icon, or a plain line icon when it has none or it fails to load. */
function SiteIcon({ src, fallback, size = 14 }: { src?: string; fallback: IconName; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img className="bw-favicon" src={src} alt="" width={size} height={size} draggable={false} onError={() => setFailed(true)} />
  ) : (
    <Icon name={fallback} size={size} className="bw-site-icon" />
  );
}

/** What stands for a page that has no icon of its own: a search, this machine, a plain connection, the web. */
function siteFallback(url: string): IconName {
  if (!url) return 'search';
  if (addressParts(url).search) return 'search';
  if (isLocalUrl(url)) return 'laptop';
  return url.startsWith('http:') ? 'unlock' : 'globe';
}

/** While the agent works on the page: one quiet word in the address field, for that moment only. */
const AGENT_WORD: Record<AgentWork, string> = {
  read: 'Reading',
  screenshot: 'Capturing',
  open: 'Opening',
  snapshot: 'Reading',
  click: 'Clicking',
  type: 'Typing',
  press: 'Pressing',
  scroll: 'Scrolling',
  eval: 'Running',
  logs: 'Reading',
  wait: 'Waiting',
  navigate: 'Loading',
  signIn: 'Signing in',
};
const AGENT_SAYS: Record<AgentWork, string> = {
  read: 'The agent is reading this page',
  screenshot: 'The agent is taking a screenshot of this page',
  open: 'The agent is opening this page',
  snapshot: 'The agent is reading the outline of this page',
  click: 'The agent is clicking on this page',
  type: 'The agent is typing on this page',
  press: 'The agent is pressing a key on this page',
  scroll: 'The agent is scrolling this page',
  eval: 'The agent is running a script on this page',
  logs: "The agent is reading this page's log",
  wait: 'The agent is waiting for this page',
  navigate: 'The agent is moving through this page\'s history',
  signIn: 'The agent is signing in on this page',
};

/**
 * At rest: the site's icon, the host, the rest of the path dim (or the title on a site's front
 * page, or the words of a search). On focus: the whole address, selected. Enter opens it or
 * searches the web; Escape puts the page's address back.
 */
function AddressField({
  url,
  title,
  favicon,
  zoom,
  agent,
  picking,
  onResetZoom,
  inputRef,
  onGo,
}: {
  url: string;
  title: string;
  favicon?: string;
  zoom: number;
  agent?: AgentWork;
  /** Pick mode is on: the field says so until an element is picked or Escape ends it. */
  picking?: boolean;
  onResetZoom: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onGo: (raw: string) => boolean;
}) {
  const [value, setValue] = useState(url);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setValue(url);
    // Focus can leave without a blur event (the pane turning inert moves it to the body): trust the document.
    else if (document.activeElement !== inputRef.current) setFocused(false);
  }, [url, focused, inputRef]);

  const parts = url ? addressParts(url) : null;
  const typed = focused && value.trim() !== '' && value !== url;
  const showTitle = !!parts && !parts.search && !parts.path && !!title && title !== parts.host && title !== url;

  return (
    <form
      className="bw-addr"
      data-focused={focused || undefined}
      data-zoomed={(!focused && zoom !== 1) || undefined}
      data-agent={(!focused && (!!agent || !!picking)) || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (onGo(value)) inputRef.current?.blur();
      }}
    >
      <span className="bw-addr-lead" aria-hidden>
        {focused ? <Icon name={typed && willSearch(value) ? 'search' : 'globe'} size={14} className="bw-site-icon" /> : <SiteIcon src={favicon} fallback={siteFallback(url)} />}
      </span>
      <input
        ref={inputRef}
        value={focused ? value : ''}
        placeholder={url ? '' : 'Search or enter address'}
        aria-label="Address"
        aria-description={!focused && url ? url : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => setValue(e.target.value)}
        onMouseDown={(e) => {
          // The first click selects the whole address; a pointer-up must not collapse the selection.
          if (focused) return;
          e.preventDefault();
          e.currentTarget.focus();
        }}
        onFocus={(e) => {
          setFocused(true);
          setValue(url);
          const el = e.currentTarget;
          // select() focuses the field again: only while it still has focus.
          requestAnimationFrame(() => document.activeElement === el && el.select());
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setValue(url);
            e.currentTarget.blur();
          }
        }}
      />
      {!focused && parts && (
        <span className="bw-addr-view" aria-hidden>
          {parts.search ? (
            <>
              <span className="bw-addr-host">{parts.search}</span>
              <span className="bw-addr-title">{parts.host}</span>
            </>
          ) : (
            <>
              <span className="bw-addr-host">{parts.host}</span>
              {parts.path ? <span className="bw-addr-path">{parts.path}</span> : showTitle && <span className="bw-addr-title">{title}</span>}
            </>
          )}
        </span>
      )}
      {!focused && agent ? (
        <span className="bw-agent shimmer" role="status" aria-label={AGENT_SAYS[agent]}>
          {AGENT_WORD[agent]}
        </span>
      ) : (
        !focused &&
        picking && (
          <span className="bw-agent" role="status" aria-label="Click an element on the page to put it in your message. Escape cancels.">
            Picking
          </span>
        )
      )}
      {!focused && zoom !== 1 && (
        <Tip label="Reset zoom">
          <button type="button" className="bw-zoom num" onClick={onResetZoom}>
            {Math.round(zoom * 100)}%
          </button>
        </Tip>
      )}
    </form>
  );
}

/**
 * Before the first page: the folder's last dev server (one quiet line), local pages this session
 * mentioned, then recently visited pages.
 */
function StartView({ sessionId, onGo }: { sessionId: string; onGo: (raw: string) => boolean }) {
  const previews = usePreviews(sessionId);
  const recent = useRecent();
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const remembered = useRememberedUrl(cwd);
  const shownHosts = new Set(previews.map((p) => p.label));
  // The folder's last server, unless this session already lists it.
  const last = remembered && !previews.some((p) => devUrlLabel(p.url) === devUrlLabel(remembered.url)) ? remembered : undefined;
  // A local page listed above is not repeated under Recent.
  const visits = recent.filter((v) => !(isLocalUrl(v.url) && (shownHosts.has(addressParts(v.url).host) || (last && devUrlLabel(v.url) === devUrlLabel(last.url)))));

  if (!previews.length && !visits.length && !last) {
    return (
      <div className="bw-start">
        <p className="rail-empty">No pages opened yet.</p>
      </div>
    );
  }

  return (
    <div className="bw-start scroll">
      {last && (
        <div className="bw-last">
          <button type="button" className="bw-row" onClick={() => onGo(last.url)} aria-label={`Open ${devUrlLabel(last.url)}${last.from ? `, last printed by ${last.from}` : ''}`}>
            <span className="bw-row-lead">
              <Icon name="laptop" size={15} />
            </span>
            <span className="bw-row-title num">{devUrlLabel(last.url)}</span>
            {last.from && <span className="bw-row-sub bw-last-from">{last.from}</span>}
            <Icon name="arrow-right" size={13} className="bw-row-go" />
          </button>
        </div>
      )}
      {previews.length > 0 && (
        <section className="bw-sec" aria-label="In this session">
          <h3 className="rail-h bw-h">In this session</h3>
          <ul className="bw-list">
            {previews.map((p) => {
              const { host, path } = addressParts(p.url);
              return (
                <li key={p.url}>
                  <button type="button" className="bw-row" onClick={() => onGo(p.url)}>
                    <span className="bw-row-lead">
                      <Icon name="laptop" size={15} />
                    </span>
                    <span className="bw-row-title">{host}</span>
                    {path && <span className="bw-row-sub bw-row-path">{path}</span>}
                    <Icon name="arrow-right" size={13} className="bw-row-go" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {visits.length > 0 && (
        <section className="bw-sec" aria-label="Recent">
          <h3 className="rail-h bw-h">Recent</h3>
          <ul className="bw-list">
            {visits.map((v) => {
              const { host, search } = addressParts(v.url);
              const name = search ?? (v.title || host);
              return (
                <li key={v.url} className="rail-row-host">
                  <button type="button" className="bw-row" onClick={() => onGo(v.url)}>
                    <span className="bw-row-lead">
                      <SiteIcon src={v.favicon} fallback={siteFallback(v.url)} size={15} />
                    </span>
                    <span className="bw-row-title">{name}</span>
                    {name !== host && <span className="bw-row-sub rail-row-deco">{host}</span>}
                  </button>
                  <span className="rail-row-acts">
                    <IconButton icon="x" label="Remove from recent" size={12} onClick={() => forgetVisit(v.url)} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
