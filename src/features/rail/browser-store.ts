import { useMemo, useSyncExternalStore } from 'react';
import type { BrowserConsoleLine, BrowserFailedRequest, BrowserLogEntry, TimelineItem } from '@shared/protocol';
import { previewTargets } from '@/lib/links';
import { useStore } from '@/state/store';
import { getRuns, useTermVersion } from './term-store';

/**
 * The panel browser's tabs and pages per session, kept outside React like the terminal transcript
 * so they survive switching panes and closing the panel for the app's lifetime. Pages and logs are
 * keyed by tab id; a session's first tab has the session's own id. In the web build the history is
 * ours (a framed page's own history is not readable cross-origin); in the desktop app the
 * <webview> keeps the real history and reports into this state.
 */

export interface PageState {
  /** Current address; empty before the first page. */
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  /** Web build: our own history. */
  history: string[];
  index: number;
  /** Desktop: from the webview. */
  canBack: boolean;
  canForward: boolean;
  /** Bumped to reload the frame in the web build. */
  nonce: number;
  /** How far a load has come, for the progress line: 1 started, 2 committed, 3 the document is ready. */
  phase: 1 | 2 | 3;
  error?: string;
  errorCode?: number;
  /** Desktop: the page's renderer went away. */
  crashed?: boolean;
  /** Desktop: the page stopped answering (a busy loop); it may come back by itself. */
  hung?: boolean;
  /** Desktop: the shell stopped the page because it flooded its console (it never yielded to be calmed). */
  flooded?: boolean;
  /** Desktop: the page's zoom factor. */
  zoom: number;
  device: Device;
  /** What the agent is doing with the page right now (shown in the bar for that moment). */
  agent?: AgentWork;
  /** The agent acts on this page during its turn: the tab says who is driving, with Stop. */
  driving?: boolean;
  /** The person used the page a moment ago: the agent's next action waits. */
  yielding?: boolean;
  /**
   * A field of this document holds a password Sable filled: until the page loads another document
   * or the field is cleared, the agent's outline lists no values, and scripts and screenshots are refused.
   */
  filled?: boolean;
  /** A sign-in is under way on this page: every agent tool but the sign-in itself is refused. */
  signing?: boolean;
  /** The id of the sign-in hold Electron main armed for this page; only its own release ends it. */
  hold?: string;
  /** One line after a sign-in ("Signed in as name"), for a few seconds. */
  signedInAs?: string;
}

/** The agent's tools, as the bar names them. */
export type AgentWork = 'read' | 'screenshot' | 'open' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'eval' | 'logs' | 'wait' | 'navigate' | 'signIn';

/* ── what a developer looks at next: the page's console problems and failed requests, since it loaded ── */

export interface PageLog {
  console: BrowserLogEntry[];
  failed: BrowserFailedRequest[];
  /** Entries dropped beyond the bound. */
  more: { console: number; failed: number };
  /** Every console line, any level (browser_logs). */
  lines: BrowserConsoleLine[];
  moreLines: number;
  /** Console lines and failed requests in the order they happened (the drawer). */
  feed: FeedEntry[];
  moreFeed: number;
}

export interface FeedEntry {
  n: number;
  level: BrowserConsoleLine['level'];
  text: string;
  source?: string;
  /** A failed request rather than a console line. */
  request?: boolean;
}

let feedN = 0;
function pushFeed(l: PageLog, entry: Omit<FeedEntry, 'n'>) {
  l.feed.push({ ...entry, n: ++feedN });
  if (l.feed.length > LINES_MAX) {
    l.feed.shift();
    l.moreFeed++;
  }
}

/** "GET /api/user 404": a failed request as one line. */
function requestLine(f: BrowserFailedRequest, pageUrl: string): string {
  let where = f.url;
  try {
    const u = new URL(f.url);
    // The page's own requests by their path; others with their host.
    const own = !!pageUrl && new URL(pageUrl).origin === u.origin;
    where = own ? u.pathname : u.pathname.length > 1 ? `${u.host}${u.pathname}` : u.host;
  } catch {
    /* keep the address */
  }
  return `${f.method ?? 'GET'} ${where} ${f.status ? f.status : f.error || 'failed'}`;
}

const LOG_MAX = 50;
const LINES_MAX = 200;
const logs = new Map<string, PageLog>();
const emptyLog = (): PageLog => ({ console: [], failed: [], more: { console: 0, failed: 0 }, lines: [], moreLines: 0, feed: [], moreFeed: 0 });

export const getLog = (tabId: string): PageLog => logs.get(tabId) ?? emptyLog();

/* The drawer follows the log; a chatty page tells it at most ten times a second. */
const logListeners = new Set<() => void>();
const logVersions = new Map<string, number>();
let logTimer: ReturnType<typeof setTimeout> | undefined;
const logDirty = new Set<string>();

function touchLog(tabId: string) {
  logDirty.add(tabId);
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = undefined;
    for (const id of logDirty) logVersions.set(id, (logVersions.get(id) ?? 0) + 1);
    logDirty.clear();
    for (const l of logListeners) l();
  }, 100);
}

/** Changes whenever the tab's page log did. */
export function useLogVersion(tabId: string): number {
  return useSyncExternalStore(
    (l) => {
      logListeners.add(l);
      return () => {
        logListeners.delete(l);
      };
    },
    () => logVersions.get(tabId) ?? 0,
  );
}

/** A new document: its log starts empty. */
export function resetLog(tabId: string) {
  if (gone.has(tabId)) return;
  logs.set(tabId, emptyLog());
  touchLog(tabId);
}

/** One console line of any level; errors and warnings also feed the agent's read. */
export function logLine(tabId: string, entry: BrowserConsoleLine) {
  if (gone.has(tabId)) return;
  const l = logs.get(tabId) ?? emptyLog();
  l.lines.push({ level: entry.level, text: entry.text.slice(0, 1000), source: entry.source?.slice(0, 300) });
  if (l.lines.length > LINES_MAX) {
    l.lines.shift();
    l.moreLines++;
  }
  pushFeed(l, { level: entry.level, text: entry.text.slice(0, 1000), source: entry.source?.slice(0, 300) });
  logs.set(tabId, l);
  if (entry.level === 'error' || entry.level === 'warning') logConsole(tabId, { level: entry.level, text: entry.text, source: entry.source });
  touchLog(tabId);
}

/** Lines a chatty page logged beyond what the shell passes on (it sends at most a few hundred a second). */
export function logDropped(tabId: string, n: number) {
  if (gone.has(tabId) || !(n > 0)) return;
  const l = logs.get(tabId) ?? emptyLog();
  l.moreLines += n;
  l.moreFeed += n;
  logs.set(tabId, l);
  touchLog(tabId);
}

export function logConsole(tabId: string, entry: BrowserLogEntry) {
  if (gone.has(tabId)) return;
  const l = logs.get(tabId) ?? emptyLog();
  l.console.push({ level: entry.level, text: entry.text.slice(0, 1000), source: entry.source?.slice(0, 300) });
  if (l.console.length > LOG_MAX) {
    l.console.shift();
    l.more.console++;
  }
  logs.set(tabId, l);
}

export function logFailed(tabId: string, entry: BrowserFailedRequest) {
  if (gone.has(tabId)) return;
  const l = logs.get(tabId) ?? emptyLog();
  l.failed.push({ url: entry.url.slice(0, 300), method: entry.method, status: entry.status, error: entry.error });
  if (l.failed.length > LOG_MAX) {
    l.failed.shift();
    l.more.failed++;
  }
  pushFeed(l, { level: 'error', text: requestLine(entry, pages.get(tabId)?.url ?? ''), request: true });
  logs.set(tabId, l);
  touchLog(tabId);
}

/** Requests that failed beyond what the shell passes on. */
export function failedDropped(tabId: string, n: number) {
  if (gone.has(tabId) || !(n > 0)) return;
  const l = logs.get(tabId) ?? emptyLog();
  l.more.failed += n;
  l.moreFeed += n;
  logs.set(tabId, l);
  touchLog(tabId);
}

export type Device = 'desktop' | 'tablet' | 'phone';

/** Viewport sizes the page can be checked at; the page is centred and scaled down to fit the panel. */
export const DEVICES: Record<Device, { label: string; w: number; h: number }> = {
  desktop: { label: 'Desktop', w: 0, h: 0 },
  tablet: { label: 'Tablet', w: 768, h: 1024 },
  phone: { label: 'Phone', w: 390, h: 844 },
};

const EMPTY: PageState = { url: '', title: '', loading: false, history: [], index: -1, canBack: false, canForward: false, nonce: 0, phase: 1, zoom: 1, device: 'desktop' };
const pages = new Map<string, PageState>();
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const emit = () => {
  for (const l of listeners) l();
};

export const getPage = (tabId: string): PageState => pages.get(tabId) ?? EMPTY;

/** Hears every change to any tab's page, and to any session's tabs. */
export const onPages = subscribe;

export function setPage(tabId: string, patch: Partial<PageState>) {
  // A closed tab's view may still report on its way out: it must not come back.
  if (gone.has(tabId)) return;
  const cur = getPage(tabId);
  const next = { ...cur, ...patch };
  if ((Object.keys(patch) as (keyof PageState)[]).every((k) => cur[k] === next[k])) return;
  pages.set(tabId, next);
  emit();
}

/*
 * What a page can report many times a second (its title, its icon, an address changed by script,
 * whether there is history to go back to): gathered and applied a few times a second at most, so a
 * page that rewrites its title in a loop costs the app one small update per beat.
 */
const soon = new Map<string, Partial<PageState>>();
let soonTimer: ReturnType<typeof setTimeout> | undefined;
export const SOON_MS = 120;

export function setPageSoon(tabId: string, patch: Partial<PageState>) {
  soon.set(tabId, { ...soon.get(tabId), ...patch });
  soonTimer ??= setTimeout(flushSoon, SOON_MS);
}

/** Applies what setPageSoon gathered now (before a change that must come after it). */
export function flushSoon() {
  clearTimeout(soonTimer);
  soonTimer = undefined;
  const all = [...soon];
  soon.clear();
  for (const [id, patch] of all) setPage(id, patch);
}

export function usePage(tabId: string): PageState {
  return useSyncExternalStore(subscribe, () => getPage(tabId));
}

/** Web build: a new entry in our own history. */
export function pushHistory(tabId: string, url: string) {
  const p = getPage(tabId);
  const history = [...p.history.slice(0, p.index + 1), url].slice(-100);
  setPage(tabId, { url, history, index: history.length - 1, title: '', favicon: undefined, loading: true, phase: 1, error: undefined });
}

export function stepHistory(tabId: string, delta: number) {
  const p = getPage(tabId);
  const index = p.index + delta;
  if (index < 0 || index >= p.history.length) return;
  setPage(tabId, { index, url: p.history[index], title: '', loading: true, phase: 1, error: undefined });
}

/* ── tabs: several pages in one session's Browser tab ── */

export interface ClosedTab {
  url: string;
  title: string;
  favicon?: string;
  /** Where it stood in the strip. */
  index: number;
}

export interface Tabs {
  /** Tab ids in strip order; a session's first tab has the session's id. */
  ids: string[];
  active: string;
  /** Pages closed in this session, newest last (Ctrl+Shift+T brings them back). */
  closed: ClosedTab[];
}

/** Each tab is a page process of its own: enough for real work, not so many that they weigh on the machine. */
export const TABS_MAX = 12;
const CLOSED_MAX = 10;
const tabsBy = new Map<string, Tabs>();
/** Ids of closed tabs: never reused, and reports from their views are dropped. */
const gone = new Set<string>();
let tabSeq = 0;

export function getTabs(sessionId: string): Tabs {
  let t = tabsBy.get(sessionId);
  if (!t) {
    // Created on first sight and kept, so the snapshot stays the same object until it changes.
    t = { ids: [sessionId], active: sessionId, closed: [] };
    tabsBy.set(sessionId, t);
  }
  return t;
}

/** The tab the session's Browser tab shows, which is the one the agent's tools act on. */
export const activeTab = (sessionId: string): string => getTabs(sessionId).active;

export const isTabOpen = (tabId: string): boolean => !gone.has(tabId);

export function useTabs(sessionId: string): Tabs {
  return useSyncExternalStore(subscribe, () => getTabs(sessionId));
}

function setTabs(sessionId: string, next: Tabs) {
  tabsBy.set(sessionId, next);
  emit();
}

/**
 * A new tab, made the active one: at the end of the strip, or at `at`. With `url` its page is set
 * to load that address (the Browser tab gives it a view when it shows it). Undefined at the limit.
 */
export function openTab(sessionId: string, url = '', at?: number): string | undefined {
  const t = getTabs(sessionId);
  if (t.ids.length >= TABS_MAX) return undefined;
  const id = `${sessionId}~${++tabSeq}`;
  if (url) pages.set(id, { ...EMPTY, url, history: [url], index: 0, loading: true, phase: 1 });
  const ids = [...t.ids];
  ids.splice(Math.max(0, Math.min(at ?? ids.length, ids.length)), 0, id);
  setTabs(sessionId, { ...t, ids, active: id });
  return id;
}

export function selectTab(sessionId: string, tabId: string) {
  const t = getTabs(sessionId);
  if (t.active === tabId || !t.ids.includes(tabId)) return;
  setTabs(sessionId, { ...t, active: tabId });
}

/** The tab `delta` places along the strip from the active one, wrapping. */
export function stepTab(sessionId: string, delta: number) {
  const t = getTabs(sessionId);
  if (t.ids.length < 2) return;
  const i = t.ids.indexOf(t.active);
  selectTab(sessionId, t.ids[(((i + delta) % t.ids.length) + t.ids.length) % t.ids.length]);
}

/**
 * Closes a tab: its page joins the closed list, the neighbour on its right (else its left) takes
 * over if it was in front, and closing the last tab leaves one empty tab.
 */
export function closeTab(sessionId: string, tabId: string) {
  const t = getTabs(sessionId);
  const i = t.ids.indexOf(tabId);
  if (i < 0) return;
  const p = getPage(tabId);
  const closed = p.url ? [...t.closed, { url: p.url, title: p.title, favicon: p.favicon, index: i }].slice(-CLOSED_MAX) : t.closed;
  soon.delete(tabId);
  pages.delete(tabId);
  logs.delete(tabId);
  logVersions.delete(tabId);
  gone.add(tabId);
  let ids = t.ids.filter((x) => x !== tabId);
  let active = t.active;
  if (!ids.length) {
    const fresh = `${sessionId}~${++tabSeq}`;
    ids = [fresh];
    active = fresh;
  } else if (active === tabId) active = ids[Math.min(i, ids.length - 1)];
  setTabs(sessionId, { ids, active, closed });
}

/** Brings the last closed page back in a new tab where it stood; its id, or undefined when none is left (or at the limit). */
export function reopenTab(sessionId: string): string | undefined {
  const t = getTabs(sessionId);
  const last = t.closed[t.closed.length - 1];
  if (!last || t.ids.length >= TABS_MAX) return undefined;
  setTabs(sessionId, { ...t, closed: t.closed.slice(0, -1) });
  const id = openTab(sessionId, last.url, last.index);
  if (id) setPage(id, { title: last.title, favicon: last.favicon });
  return id;
}

/** Drag to reorder: the tab moves to `to` in the strip. */
export function moveTab(sessionId: string, tabId: string, to: number) {
  const t = getTabs(sessionId);
  const from = t.ids.indexOf(tabId);
  const at = Math.max(0, Math.min(to, t.ids.length - 1));
  if (from < 0 || from === at) return;
  const ids = [...t.ids];
  ids.splice(from, 1);
  ids.splice(at, 0, tabId);
  setTabs(sessionId, { ...t, ids });
}

/* ── recently visited pages (this viewer's, kept in local storage) ── */

export interface Visit {
  url: string;
  title: string;
  favicon?: string;
  ts: number;
}

const RECENT_KEY = 'sable.browser.recent';
const RECENT_MAX = 6;
const recentListeners = new Set<() => void>();

function loadRecent(): Visit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is Visit => !!v && typeof v.url === 'string' && /^https?:\/\//.test(v.url))
      .map((v) => ({ url: v.url, title: typeof v.title === 'string' ? v.title : '', favicon: typeof v.favicon === 'string' && /^(https:|data:image\/)/.test(v.favicon) ? v.favicon : undefined, ts: Number(v.ts) || 0 }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

let recent: Visit[] | null = null;

const getRecent = () => (recent ??= loadRecent());

function saveRecent(next: Visit[]) {
  recent = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this run only */
  }
  for (const l of recentListeners) l();
}

/** A page finished loading: it moves to the top of the list. */
export function noteVisit(url: string, title: string, favicon?: string) {
  if (!/^https?:\/\//.test(url)) return;
  const prev = getRecent().find((v) => v.url === url);
  saveRecent([{ url, title: title || prev?.title || '', favicon: favicon ?? prev?.favicon, ts: Date.now() }, ...getRecent().filter((v) => v.url !== url)].slice(0, RECENT_MAX));
}

/** Title or icon arrived after the load: update the page's entry if it is still listed. */
export function touchVisit(url: string, patch: Partial<Pick<Visit, 'title' | 'favicon'>>) {
  const list = getRecent();
  const i = list.findIndex((v) => v.url === url);
  if (i < 0 || (Object.keys(patch) as (keyof typeof patch)[]).every((k) => list[i][k] === patch[k])) return;
  saveRecent(list.map((v, j) => (j === i ? { ...v, ...patch } : v)));
}

export function forgetVisit(url: string) {
  saveRecent(getRecent().filter((v) => v.url !== url));
}

export function useRecent(): Visit[] {
  return useSyncExternalStore((l) => {
    recentListeners.add(l);
    return () => {
      recentListeners.delete(l);
    };
  }, getRecent);
}

/* ── local pages mentioned in this session ── */

type Target = { url: string; label: string };
const targetCache = new WeakMap<object, Target[]>();

function itemTargets(item: TimelineItem): Target[] {
  let texts: (string | undefined)[];
  if (item.type === 'text') texts = [item.text];
  else if (item.type === 'tool' && item.kind === 'bash') texts = [item.output, item.result?.text];
  else return [];
  let hit = targetCache.get(item);
  if (!hit) {
    hit = previewTargets(texts, 6);
    targetCache.set(item, hit);
  }
  return hit;
}

/**
 * Local pages this session's answers mention or its commands and the panel terminal printed, one
 * per host and port, newest first. Only call it while the start view shows: it follows streaming.
 */
export function usePreviews(sessionId: string, limit = 4): Target[] {
  // The items change in place: their revision says when (see `SessionData.items`).
  const rev = useStore((s) => s.data[sessionId]?.rev ?? 0);
  const termV = useTermVersion();
  return useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items;
    const found: { t: Target; ts: number; order: number }[] = [];
    let order = 0;
    for (const item of Object.values(items ?? {})) for (const t of itemTargets(item)) found.push({ t, ts: item.ts, order: order++ });
    for (const run of getRuns(sessionId)) for (const u of [...run.urls].reverse()) found.push({ t: { url: u.url, label: u.label }, ts: run.startedAt, order: order++ });
    found.sort((a, b) => b.ts - a.ts || a.order - b.order);
    const out: Target[] = [];
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.t.label)) continue;
      seen.add(f.t.label);
      if (out.push(f.t) >= limit) break;
    }
    return out;
    // rev marks changes of the items, termV of terminal output (the transcript lives outside React).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, sessionId, termV]);
}

