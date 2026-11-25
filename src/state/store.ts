import { create } from 'zustand';
import type {
  UpdateState,
  FolderGroup,
  AppSettings,
  BackdropConfig,
  BridgeEvent,
  Capabilities,
  Effort,
  PermissionRequest,
  Project,
  ProviderId,
  QueuedMessage,
  ProviderInfo,
  PendingPrompts,
  QuestionRequest,
  LimitsReport,
  RateLimit,
  ResetRun,
  SessionMeta,
  SessionSnapshot,
  TimelineItem,
  Todo,
} from '@shared/protocol';
import { DEFAULT_ACCOUNT, DEFAULT_SETTINGS } from '@shared/protocol';
import { bridge, type ConnStatus } from '@/lib/bridge';
import { bootMark } from '@/lib/boot';
import { correctsGuess, helloProviders, homeAgent } from '@/lib/sign-in';
import { attention, heard, startNotify } from '@/lib/notify';
import type { Reviews } from '@/features/review/model';

export { changedSince } from './revision';

/**
 * Key for per-account state (`limits`, `auth`): the bare provider id for the built-in default
 * account, so `limits[provider]` and `auth[provider]` keep meaning what they always did.
 */
export const accountKey = (provider: ProviderId, accountId?: string | null) =>
  !accountId || accountId === DEFAULT_ACCOUNT ? provider : `${provider}:${accountId}`;

/** Per-session view state, rebuilt from a snapshot and kept current by events. */
export interface SessionData {
  loaded: boolean;
  incomplete?: boolean;
  rootsBefore?: number;
  itemsBefore?: number;
  provisional?: boolean;
  /**
   * Items by id. The container is changed in place: a streamed word or a patch replaces one item
   * without copying the others (a long chat holds thousands; a copy per frame cost milliseconds).
   * Each item object stays immutable (a change is a new object), so selecting one item works as
   * ever. Never compare `items` by identity or keep it as a memo dependency: compare `rev`.
   */
  items: Record<string, TimelineItem>;
  /** Changes with every change to `items` (a word, a patch, an item added or removed, a new timeline). Never reused, across sessions too. */
  rev: number;
  /**
   * What the write that made `rev` changed: the ids whose items were set or removed, when the
   * revision before it was `since`. Absent after a new timeline (snapshot, reset). See `changedSince`.
   */
  changed?: { since: number; ids: readonly string[] };
  /** Release this timeline on leaving: at least one preview was fetched whole. */
  hydrated?: boolean;
  /** Top-level item ids in order. A new array whenever it changes. */
  roots: string[];
  /** Sub-agent item ids by parent tool id. A new object (and a new array for that parent) whenever one changes. */
  children: Record<string, string[]>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  suggestion?: string;
  caps?: Capabilities;
  /** Messages the bridge holds until the running turn ends. */
  queue: QueuedMessage[];
}

export type RailTab = 'changes' | 'files' | 'browser' | 'device' | 'terminal' | 'tasks' | 'context' | 'agents';
export type SettingsSection = 'general' | 'appearance' | 'accounts' | 'usage' | 'models' | 'permissions' | 'phone' | 'customize' | 'mcp' | 'hooks' | 'skills' | 'agents' | 'memory' | 'profile' | 'prompts' | 'shortcuts' | 'about';

export interface AuthFlow {
  state: 'started' | 'url' | 'done' | 'error' | 'cancelled' | 'timeout';
  url?: string;
  /** The sign-in can also finish with a code the browser shows (see features/connect/LoginCode). */
  codeUrl?: string;
  message?: string;
}

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
  /** How often it was said again while it stood: each time it is read out anew, in place. */
  again?: number;
}

export type Draft = import('@/features/composer/restore').FieldDraft;

interface Ui {
  activeSessionId: string | null;
  sidebarOpen: boolean;
  railOpen: boolean;
  railTab: RailTab;
  railFile?: string;
  /** A page the panel's Browser tab should open (it clears this once taken). */
  browserUrl?: string;
  paletteOpen: boolean;
  settings: SettingsSection | null;
  projectPicker: boolean;
  historyOpen: boolean;
  shortcutsOpen: boolean;
  /** A shell command waiting to be run by the panel's terminal (set by "!cmd" in the composer). */
  pendingCommand?: { id: number; sessionId: string; command: string } | null;
  /** New-session composer choices on the home screen. */
  homeProvider: ProviderId;
  homeCwd: string | null;
  /** The next session from home is a chat without a folder (`homeCwd` then holds the chats folder). */
  homeChat?: boolean;
  homeModel: Partial<Record<ProviderId, string>>;
  homeMode: Partial<Record<ProviderId, string>>;
  homeEffort: Partial<Record<ProviderId, Effort>>;
  /** The account the next session with each agent runs under; absent means the agent's default account. */
  homeAccount: Partial<Record<ProviderId, string>>;
  /** Start the next Claude Code session with ultracode on (only where `caps.features.ultracode`). */
  homeUltracode?: boolean;
  /** The triage deck (every waiting permission and question across sessions) is open. Not persisted. */
  triageOpen?: boolean;
  /** The race view (features/race) shows this race while no session is open. Not persisted. */
  race?: string | null;
}

export interface Store {
  conn: ConnStatus;
  ready: boolean;
  version: string;
  platform: string;
  home: string;
  /** Where the bridge keeps its data (Settings › About); empty until hello, or from an older bridge. */
  dataDir: string;
  providers: Partial<Record<ProviderId, ProviderInfo>>;
  projects: Project[];
  /** Projects grouping folders in the sidebar. */
  groups: FolderGroup[];
  /** The chats group's place in the sidebar's manual order. */
  chatsOrder?: number;
  /** Where chats without a folder go when Settings names no place. */
  chatsDefault: string;
  /** Where lanes' worktrees go when Settings names no place. */
  worktreesDefault: string;
  /** Updates of the desktop app; absent where Sable cannot update itself. */
  update?: UpdateState;
  settings: AppSettings;
  /** The backdrop config while a change is on its way to the bridge (Settings sliders); null otherwise. */
  backdropLive: BackdropConfig | null;
  sessions: Record<string, SessionMeta>;
  data: Record<string, SessionData>;
  providerCaps: Record<string, Capabilities>;
  /** capsKeys whose capabilities could not be loaded (the composer drops those controls instead of waiting). */
  capsFailed: Record<string, true>;
  /** Plan limits per account, keyed by `accountKey(provider, accountId)`. */
  limits: Partial<Record<string, RateLimit[]>>;
  /** Limits as remembered by the bridge, with when they were read, history and pace; keyed like `limits`. */
  limitReports: Partial<Record<string, LimitsReport>>;
  /** Sign-in flows per account, keyed by `accountKey(provider, accountId)`. */
  auth: Partial<Record<string, AuthFlow>>;
  /** A limit reset used in the agent's own dialog (`limit.resetInAgent`), per account, keyed like `auth`. */
  resetRuns: Partial<Record<string, ResetRun>>;
  toasts: Toast[];
  drafts: Record<string, Draft>;
  /** Review comments on diffs not sent yet, per session (features/review; actions `*ReviewComment`, `sendReview`). */
  reviews: Reviews;
  ui: Ui;

  setUi: (patch: Partial<Ui>) => void;
  setDraft: (key: string, patch: Partial<Draft>) => void;
  toast: (text: string, level?: Toast['level']) => void;
  dismissToast: (id: number) => void;
}

const UI_KEY = 'sable.ui.v1';

function loadUi(): Partial<Ui> {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const persistedUi = loadUi();
/** Counts changes of what the stage shows (`setUi` with `activeSessionId` or `race`): see `navigationCount`. */
let navigations = 0;
/** Read before waiting on something; changed afterwards means the person went elsewhere meanwhile. */
export const navigationCount = () => navigations;
/** Whether the user has picked a home agent yet (a fresh profile follows `settings.defaultProvider`). */
let homeChosen = !!persistedUi.homeProvider;

/** Revisions of `SessionData.items`: one counter for every session, so a revision is never seen twice. */
let revSeq = 0;
const nextRev = () => ++revSeq;

const emptyData = (): SessionData => ({ loaded: false, items: {}, rev: nextRev(), roots: [], children: {}, permissions: [], questions: [], todos: [], queue: [] });

/** A whole new timeline: a fresh container and a revision that tells every reader to read it all. */
function indexItems(items: TimelineItem[]): Pick<SessionData, 'items' | 'rev' | 'changed' | 'roots' | 'children'> {
  const map: Record<string, TimelineItem> = {};
  const roots: string[] = [];
  const children: Record<string, string[]> = {};
  for (const item of items) {
    map[item.id] = item;
    if (item.parentId) (children[item.parentId] ??= []).push(item.id);
    else roots.push(item.id);
  }
  return { items: map, rev: nextRev(), changed: undefined, roots, children };
}

/** The next revision of `d` after its items changed in place (`ids` set or removed), with other fields to change. */
function touched(d: SessionData, ids: readonly string[], patch?: Partial<SessionData>): SessionData {
  return { ...d, ...patch, rev: nextRev(), changed: { since: d.rev, ids } };
}

let toastId = 1;
/** When each toast in view leaves by itself (a repeat of its words starts its time anew). */
const toastTimers = new Map<number, number>();

export const useStore = create<Store>((set, get) => ({
  conn: 'connecting',
  ready: false,
  version: '',
  platform: '',
  home: '',
  dataDir: '',
  providers: {},
  projects: [],
  groups: [],
  chatsDefault: '',
  worktreesDefault: '',
  settings: DEFAULT_SETTINGS,
  backdropLive: null,
  sessions: {},
  data: {},
  providerCaps: {},
  capsFailed: {},
  limits: {},
  limitReports: {},
  auth: {},
  resetRuns: {},
  toasts: [],
  drafts: {},
  reviews: {},
  ui: {
    activeSessionId: null,
    sidebarOpen: true,
    railOpen: false,
    railTab: 'changes',
    paletteOpen: false,
    settings: null,
    projectPicker: false,
    historyOpen: false,
    shortcutsOpen: false,
    homeProvider: 'claude',
    homeCwd: null,
    homeModel: {},
    homeMode: {},
    homeEffort: {},
    homeAccount: {},
    ...persistedUi,
  },

  setUi: (patch) => {
    // A change of what the stage shows: an open still waiting for its chat (actions.openSession) yields to it.
    if ('activeSessionId' in patch || 'race' in patch) navigations++;
    set((s) => ({ ui: { ...s.ui, ...patch } }));
    if (patch.homeProvider) homeChosen = true;
    const { activeSessionId, sidebarOpen, railOpen, railTab, homeProvider, homeCwd, homeChat, homeModel, homeMode, homeEffort, homeAccount, homeUltracode } = get().ui;
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ activeSessionId, sidebarOpen, railOpen, railTab, homeProvider: homeChosen ? homeProvider : undefined, homeCwd, homeChat, homeModel, homeMode, homeEffort, homeAccount, homeUltracode }));
    } catch {
      /* private mode */
    }
  },

  setDraft: (key, patch) =>
    set((s) => {
      const cur: Draft = s.drafts[key] ?? { text: '', attachments: [] };
      return { drafts: { ...s.drafts, [key]: { ...cur, ...patch } } };
    }),

  toast: (text, level = 'info') => {
    // The same words while they still stand are one toast, whoever says them again (two watchers,
    // two accounts at one limit, a click repeated): the one in view stays and its time starts anew.
    const same = get().toasts.find((t) => t.text === text && t.level === level);
    const id = same?.id ?? toastId++;
    if (!same) set((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
    else set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, again: (t.again ?? 0) + 1 } : t)) }));
    window.clearTimeout(toastTimers.get(id));
    toastTimers.set(id, window.setTimeout(() => get().dismissToast(id), level === 'error' ? 7000 : level === 'warn' ? 6000 : 3800));
  },

  dismissToast: (id) => {
    window.clearTimeout(toastTimers.get(id));
    toastTimers.delete(id);
    set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s));
  },
}));

// ───────────────────────── event application ─────────────────────────

type DeltaKey = string; // `${sessionId}\u0000${itemId}\u0000${field}`
const deltaBuffer = new Map<DeltaKey, string>();
let deltaFrame = 0;

/**
 * Streaming deltas arrive far faster than frames: coalesce them into one store write per frame.
 * The items they grow are replaced in place (see `SessionData.items`): the write costs what the
 * changed items cost, however long the chat.
 */
export function flushDeltas() {
  deltaFrame = 0;
  if (!deltaBuffer.size) return;
  const batch = [...deltaBuffer];
  deltaBuffer.clear();
  useStore.setState((s) => {
    const ids = new Map<string, string[]>();
    for (const [key, delta] of batch) {
      const [sessionId, itemId, field] = key.split('\u0000');
      const d = s.data[sessionId];
      if (!d?.loaded) continue;
      const item = d.items[itemId] as (TimelineItem & Record<string, unknown>) | undefined;
      if (!item) continue;
      d.items[itemId] = { ...item, [field]: ((item[field] as string | undefined) ?? '') + delta } as TimelineItem;
      const list = ids.get(sessionId);
      if (!list) ids.set(sessionId, [itemId]);
      else if (!list.includes(itemId)) list.push(itemId);
    }
    if (!ids.size) return s;
    const data = { ...s.data };
    for (const [sessionId, list] of ids) data[sessionId] = touched(data[sessionId], list);
    return { data };
  });
}

/** Changes a loaded session's view state (an entry that only holds prompts is not a timeline yet: its snapshot fills it on open). */
function patchData(sessionId: string, fn: (d: SessionData) => Partial<SessionData>) {
  useStore.setState((s) => {
    const d = s.data[sessionId];
    if (!d?.loaded) return s;
    return { data: { ...s.data, [sessionId]: { ...d, ...fn(d) } } };
  });
}

/**
 * Changes a loaded session's items in place: `fn` sets or deletes entries of `d.items` and returns
 * the ids it touched with any other fields to change (`roots`, `children`), or null when it changed
 * nothing (then nothing is written).
 */
function editItems(sessionId: string, fn: (d: SessionData) => { ids: readonly string[]; patch?: Partial<SessionData> } | null) {
  if (batch) {
    // Gathered (flushEvents): the items change in place as ever; the session's new revision is written once.
    const cur = batch.get(sessionId);
    const base = cur?.view ?? useStore.getState().data[sessionId];
    if (!base?.loaded) return;
    const view = cur ? cur.view : { ...base };
    const edit = fn(view);
    if (!edit) return;
    if (edit.patch) Object.assign(view, edit.patch);
    if (cur) for (const id of edit.ids) cur.ids.add(id);
    else batch.set(sessionId, { view, since: base.rev, ids: new Set(edit.ids) });
    return;
  }
  useStore.setState((s) => {
    const d = s.data[sessionId];
    if (!d?.loaded) return s;
    const edit = fn(d);
    if (!edit) return s;
    return { data: { ...s.data, [sessionId]: touched(d, edit.ids, edit.patch) } };
  });
}

/**
 * Prompts reach the window for every session, loaded or not (the triage deck shows them all):
 * a session with no view state gets an entry holding only its prompts (`loaded: false`).
 */
function patchPrompts(sessionId: string, fn: (d: SessionData) => Pick<SessionData, 'permissions'> | Pick<SessionData, 'questions'>) {
  useStore.setState((s) => {
    if (!s.sessions[sessionId]) return s;
    const d = s.data[sessionId] ?? emptyData();
    return { data: { ...s.data, [sessionId]: { ...d, ...fn(d) } } };
  });
}

/**
 * The bridge's list of every open prompt (sent with `app.hello`) replaces what each session held,
 * so prompts answered or dropped while the window was away go, and those of sessions this window
 * never loaded come in. Entries whose prompts did not change keep their identity.
 */
export function withPrompts(data: Record<string, SessionData>, prompts: PendingPrompts, sessions: Record<string, SessionMeta>): Record<string, SessionData> {
  const by = new Map<string, { permissions: PermissionRequest[]; questions: QuestionRequest[] }>();
  const slot = (id: string) => by.get(id) ?? (by.set(id, { permissions: [], questions: [] }).get(id) as { permissions: PermissionRequest[]; questions: QuestionRequest[] });
  for (const p of prompts.permissions) if (sessions[p.sessionId]) slot(p.sessionId).permissions.push(p);
  for (const q of prompts.questions) if (sessions[q.sessionId]) slot(q.sessionId).questions.push(q);
  const same = <T extends { id: string }>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
  let next = data;
  const put = (id: string, d: SessionData) => {
    if (next === data) next = { ...data };
    next[id] = d;
  };
  for (const [id, d] of Object.entries(data)) {
    const want = by.get(id) ?? { permissions: [], questions: [] };
    if (!same(d.permissions, want.permissions) || !same(d.questions, want.questions)) put(id, { ...d, ...want });
  }
  for (const [id, want] of by) if (!data[id]) put(id, { ...emptyData(), ...want });
  return next;
}

/**
 * The rows that opened steps, thinking lines and messages arrived as, per chat. When the chat leaves
 * the screen they are put back (`restoreRows`), so what was opened costs nothing off screen and the
 * chat STAYS loaded: dropping a chat because a step had been opened made every return to it cold.
 */
const rowsOf = new Map<string, Map<string, { row: TimelineItem; whole: TimelineItem }>>();

/** Replace only the row that requested this response. A rewind, patch or newer snapshot wins the race. */
export function applyWholeItem(sessionId: string, item: TimelineItem, asked?: TimelineItem) {
  editItems(sessionId, (d) => {
    const cur = d.items[item.id];
    if (!cur || cur.type !== item.type || !('more' in cur) || !cur.more || (asked && cur !== asked)) return null;
    d.items[item.id] = item;
    let rows = rowsOf.get(sessionId);
    if (!rows) rowsOf.set(sessionId, (rows = new Map()));
    rows.set(item.id, { row: cur, whole: item });
    trimOffscreenSoon(sessionId);
    return { ids: [item.id], patch: { hydrated: true } };
  });
}

/** Puts back the rows of what was fetched whole (only where the whole item still stands: a later change wins). */
function restoreRows(sessionId: string) {
  const rows = rowsOf.get(sessionId);
  rowsOf.delete(sessionId);
  editItems(sessionId, (d) => {
    const ids: string[] = [];
    if (rows) for (const [id, { row, whole }] of rows) {
      if (d.items[id] !== whole) continue;
      d.items[id] = row;
      ids.push(id);
    }
    return { ids, patch: { hydrated: false } };
  });
}


type PageRead = { promise: Promise<void>; wake?: () => void; patches: Map<string, Partial<TimelineItem> | null> };
const pages = new Map<string, PageRead>();
let snapshotThreshold: number | undefined;

function afterPaint(wake: (go: () => void) => void) {
  return new Promise<void>(resolve => {
    let frame = 0;
    const timer = setTimeout(go, 100);
    function go() {
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      resolve();
    }
    wake(go);
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => setTimeout(go, 0));
    else setTimeout(go, 0);
  });
}

function dropTree(id: string, items: SessionData['items'], children: SessionData['children'], ids: string[]) {
  delete items[id];
  ids.push(id);
  const nested = children[id];
  if (nested) {
    delete children[id];
    for (const child of nested) dropTree(child, items, children, ids);
  }
}

/** A page contains current rows from the bridge. Live events on visible items
 * win, and live metadata stays in place throughout the prepend. */
function prependPage(snap: SessionSnapshot, read: PageRead) {
  const id = snap.session.id, page = snap.page!;
  editItems(id, d => {
    const prefix: TimelineItem[] = [];
    const children = { ...d.children };
    const removed: string[] = [];
    for (const item of snap.items) {
      const patch = read.patches.get(item.id);
      if (patch === null || item.parentId && read.patches.get(item.parentId) === null) {
        // A later page can reveal that a child already on screen belonged to
        // this removed subtree. Keep the tombstone through the last page.
        read.patches.set(item.id, null);
        if (children[item.id]) dropTree(item.id, d.items, children, removed);
        continue;
      }
      read.patches.delete(item.id);
      if (!d.items[item.id]) prefix.push(patch ? { ...item, ...patch } as TimelineItem : item);
    }
    const indexed = indexItems(prefix);
    Object.assign(d.items, indexed.items);
    for (const [parent, ids] of Object.entries(indexed.children)) children[parent] = ids.concat(children[parent] ?? []);
    return { ids: removed.concat(prefix.map(i => i.id)), patch: { roots: indexed.roots.concat(d.roots), children,
      incomplete: page.before > 0, rootsBefore: page.rootsBefore, itemsBefore: page.before } };
  });
  trimOffscreenSoon(id);
}

function readOlder(snap: SessionSnapshot) {
  const id = snap.session.id;
  const read: PageRead = { promise: Promise.resolve(), patches: new Map() };
  pages.set(id, read);
  const current = () => pages.get(id) === read && useStore.getState().data[id]?.incomplete;
  read.promise = (async () => {
    await afterPaint(go => { read.wake = go; });
    while (current()) {
      const page = snap.page!;
      const next = await bridge.call('session.snapshot', { sessionId: id, peek: true,
        ...(page.kind === 'provisional' ? { page: 'real' as const, keepFrom: snap.items[0]?.id } :
          { page: { at: page.before, roots: page.rootsBefore, id: snap.items[0].id } }) });
      if (!current()) return;
      if (next.page?.kind !== 'older') { applySnapshot(next); return; }
      prependPage(next, read);
      snap = next;
    }
  })().catch(async () => {
    if (!current() || bridge.status === 'closed') return;
    // A timed-out page gets one authoritative full read. Reconnect also asks whole.
    await loadSession(id, { fresh: true });
  }).finally(() => { if (pages.get(id) === read) pages.delete(id); });
  void read.promise.catch(err => {
    if (useStore.getState().ui.activeSessionId === id) useStore.getState().toast(String(err.message ?? err), 'error');
  });
}

/** Readers that act on the whole timeline share the ongoing read. */
export async function completeSession(id: string) {
  while (useStore.getState().data[id]?.incomplete) {
    const read = pages.get(id);
    if (read) { read.wake?.(); await read.promise; }
    else await loadSession(id, { fresh: true });
    if (bridge.status === 'closed' && useStore.getState().data[id]?.incomplete) throw Error('Connection to the bridge was lost');
  }
  if (!useStore.getState().data[id]?.loaded) throw Error('The conversation is no longer open');
}

export function applySnapshot(snap: SessionSnapshot) {
  pages.delete(snap.session.id);
  rowsOf.delete(snap.session.id);
  // The provisional view is about to be replaced. Only keep identical rows
  // after comparing their actual wire fields, including nested tool results.
  const old = useStore.getState().data[snap.session.id];
  const items = old?.provisional ? snap.items.map(row => {
    const prior = old.items[row.id];
    return prior && JSON.stringify(prior) === JSON.stringify(row) ? prior : row;
  }) : snap.items;
  // A limit card that owes a decision is known once the chat's items are (lib/attention.ts).
  if (snap.page?.kind !== 'provisional') attention.feed({ type: 'timeline.reset', sessionId: snap.session.id, items: snap.items });
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [snap.session.id]: snap.session },
    data: {
      ...s.data,
      [snap.session.id]: {
        loaded: true,
        ...indexItems(items),
        incomplete: !!snap.page && (snap.page.before !== 0 || snap.page.kind === 'provisional'),
        provisional: snap.page?.kind === 'provisional', rootsBefore: snap.page?.rootsBefore ?? 0, itemsBefore: snap.page?.before ?? 0,
        permissions: snap.permissions,
        questions: snap.questions,
        todos: snap.todos,
        suggestion: snap.suggestion,
        queue: snap.queue ?? [],
        caps: snap.caps ?? s.data[snap.session.id]?.caps,
      },
    },
  }));
  // A click sharing this snapshot can put its chat on screen before the budget is applied.
  if (useStore.getState().data[snap.session.id]?.incomplete) readOlder(snap);
  trimOffscreenSoon(snap.session.id);
}

/**
 * A session finished while the user was looking elsewhere: mark it unread. What reaches the system
 * (a notification, the taskbar) is `lib/attention.ts`'s rule, acted on by `lib/notify.ts`.
 */
function onStatusChange(session: SessionMeta, prev: SessionMeta['status']) {
  const s = useStore.getState();
  // A turn inside an armed `/until` loop is not the end of the work: only the loop's end is news.
  const looping = !!session.until && session.status !== 'error';
  const finished = !looping && (prev === 'running' || prev === 'awaiting') && (session.status === 'idle' || session.status === 'error');
  if (!finished) return;
  if (s.ui.activeSessionId === session.id) return;
  void bridge.call('session.update', { sessionId: session.id, patch: { unread: true } }).catch(() => {});
}

/** A full window of an account reset: a toast, and a system notification while Sable is not in view. */
function announceReset(e: Extract<BridgeEvent, { type: 'limit.reset' }>) {
  const s = useStore.getState();
  const info = s.providers[e.provider];
  const account = info?.accounts?.find((a) => a.id === (e.accountId ?? DEFAULT_ACCOUNT));
  const who = (info?.accounts?.length ?? 0) > 1 ? (account?.label ?? account?.auth.email) : undefined;
  const text = `${info?.name ?? 'The agent'}${who ? ` (${who})` : ''}: ${e.window} reset`;
  s.toast(text, 'success');
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification('Limit reset', { body: text, tag: `reset:${e.provider}:${e.accountId ?? ''}` });
  } catch {
    /* notifications are best effort */
  }
}

/**
 * A chat's meta with a `session.updated` patch on it. A field the bridge clears comes as `null`
 * (JSON drops a key whose value is undefined, so a field cleared to undefined would never reach the
 * window: a chat moved back to its default account kept naming the account it left): it is removed.
 */
export function mergeMeta(cur: SessionMeta, patch: Partial<SessionMeta>): SessionMeta {
  const next = { ...cur, ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
  return next as unknown as SessionMeta;
}

/** Applies one bridge event to the store. Exported for tests; the app feeds it from `startBridge`. */
export function applyEvent(e: BridgeEvent) {
  // "This chat needs you" (lib/attention.ts) reads every chat's events, loaded or not.
  if (e.type === 'item.delta') attention.delta(e.sessionId, e.id, e.field, e.delta);
  else heard(attention.feed(e, e.type === 'session.updated' ? useStore.getState().sessions[e.id] : undefined));
  switch (e.type) {
    case 'item.delta': {
      const key = `${e.sessionId}\u0000${e.id}\u0000${e.field}`;
      deltaBuffer.set(key, (deltaBuffer.get(key) ?? '') + e.delta);
      if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
      return;
    }
    case 'item.added':
      // Deltas first: they came before this event (the same for a patch).
      flushDeltas();
      pages.get(e.sessionId)?.patches.delete(e.item.id);
      editItems(e.sessionId, (d) => {
        const known = !!d.items[e.item.id];
        d.items[e.item.id] = e.item;
        const ids = [e.item.id];
        // A root item the bridge moved (a message the agent has just taken): to the end, in this one update.
        if (known && e.moved && !e.item.parentId && d.roots.at(-1) !== e.item.id) return { ids, patch: { roots: [...d.roots.filter((id) => id !== e.item.id), e.item.id] } };
        // An item the timeline already holds is replaced where it stands.
        if (known) return { ids };
        trimOffscreenSoon(e.sessionId);
        if (e.item.parentId) return { ids, patch: { children: { ...d.children, [e.item.parentId]: [...(d.children[e.item.parentId] ?? []), e.item.id] } } };
        return { ids, patch: { roots: [...d.roots, e.item.id] } };
      });
      return;
    case 'item.patch':
      flushDeltas();
      {
        const read = pages.get(e.sessionId);
        if (read && read.patches.get(e.id) !== null && !useStore.getState().data[e.sessionId]?.items[e.id]) {
          read.patches.set(e.id, { ...read.patches.get(e.id), ...e.patch } as Partial<TimelineItem>);
          read.wake?.();
        }
      }
      editItems(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item) return null;
        d.items[e.id] = { ...item, ...e.patch } as TimelineItem;
        return { ids: [e.id] };
      });
      return;
    case 'item.removed':
      // The bridge is moving it: the `item.added` right behind carries it to its place, so no frame is painted without it.
      if (e.moving) return;
      {
        const read = pages.get(e.sessionId);
        if (read) { read.patches.set(e.id, null); read.wake?.(); }
      }
      editItems(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item && !d.children[e.id]) return null;
        const children = { ...d.children };
        const ids: string[] = [];
        // The item goes with everything nested under it, as on the bridge.
        dropTree(e.id, d.items, children, ids);
        const read = pages.get(e.sessionId);
        if (read) for (const id of ids) read.patches.set(id, null);
        const patch: Partial<SessionData> = { children };
        if (item?.parentId) children[item.parentId] = (children[item.parentId] ?? []).filter((x) => x !== e.id);
        else patch.roots = d.roots.filter((x) => x !== e.id);
        return { ids, patch };
      });
      return;
    case 'timeline.reset':
      if (!useStore.getState().data[e.sessionId]?.provisional) pages.delete(e.sessionId);
      deltaBuffer.clear();
      rowsOf.delete(e.sessionId);
      patchData(e.sessionId, d => ({ ...indexItems(e.items), incomplete: !!d.provisional, rootsBefore: 0, itemsBefore: 0, hydrated: false }));
      trimOffscreenSoon(e.sessionId);
      return;
    case 'session.added':
      useStore.setState((s) => ({
        sessions: { ...s.sessions, [e.session.id]: e.session },
        data: s.data[e.session.id] ? s.data : { ...s.data, [e.session.id]: { ...emptyData(), loaded: true } },
      }));
      trimOffscreenSoon(e.session.id);
      return;
    case 'session.updated': {
      const before = useStore.getState().sessions[e.id];
      useStore.setState((s) => {
        const cur = s.sessions[e.id];
        if (!cur) return s;
        return { sessions: { ...s.sessions, [e.id]: mergeMeta(cur, e.patch) } };
      });
      if (before && e.patch.status && e.patch.status !== before.status) onStatusChange({ ...before, ...e.patch }, before.status);
      return;
    }
    case 'session.removed':
      pages.delete(e.id);
      useStore.setState((s) => {
        const sessions = { ...s.sessions };
        const data = { ...s.data };
        delete sessions[e.id];
        delete data[e.id];
        const ui = s.ui.activeSessionId === e.id ? { ...s.ui, activeSessionId: null } : s.ui;
        if (!s.reviews[e.id]) return { sessions, data, ui };
        const reviews = { ...s.reviews };
        delete reviews[e.id];
        return { sessions, data, ui, reviews };
      });
      return;
    case 'session.caps':
      patchData(e.id, () => ({ caps: e.caps }));
      return;
    case 'permission.added':
      patchPrompts(e.request.sessionId, (d) => ({ permissions: [...d.permissions.filter((p) => p.id !== e.request.id), e.request] }));
      return;
    case 'permission.removed':
      if (useStore.getState().data[e.sessionId]?.permissions.some((p) => p.id === e.id)) patchPrompts(e.sessionId, (d) => ({ permissions: d.permissions.filter((p) => p.id !== e.id) }));
      return;
    case 'question.added':
      patchPrompts(e.request.sessionId, (d) => ({ questions: [...d.questions.filter((q) => q.id !== e.request.id), e.request] }));
      return;
    case 'question.removed':
      if (useStore.getState().data[e.sessionId]?.questions.some((q) => q.id === e.id)) patchPrompts(e.sessionId, (d) => ({ questions: d.questions.filter((q) => q.id !== e.id) }));
      return;
    case 'todos.updated':
      patchData(e.sessionId, () => ({ todos: e.todos }));
      return;
    case 'queue.updated':
      patchData(e.sessionId, () => ({ queue: e.queue }));
      return;
    case 'suggestion':
      patchData(e.sessionId, () => ({ suggestion: e.text || undefined }));
      return;
    case 'provider.updated':
      useStore.setState((s) => {
        const providers = { ...s.providers, [e.provider.id]: e.provider };
        // Hello picked home's agent, at a first start from a guess (lib/sign-in.ts): the agent's own answer corrects the pick.
        const homeProvider = correctsGuess(s.providers[e.provider.id], e.provider) ? homeAgent(Object.values(providers), { current: s.ui.homeProvider, chosen: homeChosen, preferred: s.settings.defaultProvider }) : s.ui.homeProvider;
        return { providers, limits: withAccountLimits(s.limits, [e.provider]), ...(homeProvider !== s.ui.homeProvider ? { ui: { ...s.ui, homeProvider } } : {}) };
      });
      return;
    case 'auth.progress': {
      const key = accountKey(e.provider, e.accountId);
      // A new flow starts clean; later steps keep the link the CLI printed.
      const url = e.url ?? (e.state === 'started' ? undefined : useStore.getState().auth[key]?.url);
      const codeUrl = e.codeUrl ?? (e.state === 'started' ? undefined : useStore.getState().auth[key]?.codeUrl);
      const flow: AuthFlow = { state: e.state, url, codeUrl, message: e.message };
      useStore.setState((s) => ({ auth: { ...s.auth, [key]: flow } }));
      // A finished sign-in is history after a moment, so its success state does not linger.
      if (e.state === 'done') {
        window.setTimeout(() => {
          useStore.setState((s) => {
            if (s.auth[key] !== flow) return s;
            const auth = { ...s.auth };
            delete auth[key];
            return { auth };
          });
        }, 4000);
      }
      return;
    }
    case 'projects.updated':
      useStore.setState({ projects: e.projects, ...(e.groups ? { groups: e.groups, chatsOrder: e.chatsOrder } : {}) });
      return;
    case 'settings.updated':
      useStore.setState({ settings: e.settings });
      return;
    case 'limits.report':
      useStore.setState((s) => applyLimitReports(s, [e.report]));
      return;
    case 'limits.updated':
      useStore.setState((s) => ({ limits: { ...s.limits, [accountKey(e.provider, e.accountId)]: e.limits } }));
      return;
    case 'caps.updated':
      useStore.setState((s) => {
        // The bridge may spell the folder differently (resolved path): match it loosely.
        const want = capsKey(e.provider, normPath(e.cwd), e.accountId);
        const providerCaps = { ...s.providerCaps, [capsKey(e.provider, e.cwd ?? null, e.accountId)]: e.caps };
        for (const key of Object.keys(s.providerCaps)) if (normKey(key) === want) providerCaps[key] = e.caps;
        return { providerCaps };
      });
      return;
    case 'toast':
      useStore.getState().toast(e.text, e.level);
      return;
    case 'limit.reset':
      announceReset(e);
      return;
    case 'limit.resetRun': {
      const key = accountKey(e.provider, e.accountId);
      useStore.setState((s) => {
        const resetRuns = { ...s.resetRuns };
        if (e.run) resetRuns[key] = e.run;
        else delete resetRuns[key];
        return { resetRuns };
      });
      return;
    }
    case 'update.state':
      useStore.setState({ update: e.state });
      return;
    default:
      return;
  }
}

/** Terminal output is high-volume and view-local, so it bypasses the store. */
const termListeners = new Set<(e: Extract<BridgeEvent, { type: 'term.data' | 'term.exit' }>) => void>();
export function onTerm(l: (e: Extract<BridgeEvent, { type: 'term.data' | 'term.exit' }>) => void) {
  termListeners.add(l);
  return () => {
    termListeners.delete(l);
  };
}

async function hello() {
  bootMark('hello-sent');
  const app = await bridge.call('app.hello', {});
  bootMark('hello');
  snapshotThreshold = app.snapshotThreshold;
  const again = useStore.getState().ready;
  useStore.setState((s) => {
    const sessions = Object.fromEntries(app.sessions.map((m) => [m.id, m]));
    const active = s.ui.activeSessionId && sessions[s.ui.activeSessionId] ? s.ui.activeSessionId : null;
    // An agent hello says is still `checking` keeps an answer an event already brought (lib/sign-in.ts).
    const providers = helloProviders(s.providers, app.providers);
    // A fresh profile starts on the agent chosen in settings; after that the home choice sticks.
    const homeProvider = homeAgent(Object.values(providers), { current: s.ui.homeProvider, chosen: homeChosen, preferred: app.settings.defaultProvider });
    // Forget home account choices whose account is gone.
    const homeAccount: Partial<Record<ProviderId, string>> = {};
    for (const p of app.providers) {
      const chosen = s.ui.homeAccount?.[p.id];
      if (chosen && (!p.accounts || p.accounts.some((a) => a.id === chosen))) homeAccount[p.id] = chosen;
    }
    // A second hello is a socket that came back: events may have been missed meanwhile, so every
    // kept chat but those on screen is dropped (fetched afresh when opened); those on screen are fetched again below.
    const held = s.ready ? forgetKept(s.data, onScreen({ ...s, sessions, ui: { ...s.ui, activeSessionId: active } })) : s.data;
    return {
      ready: true,
      version: app.version,
      platform: app.platform,
      home: app.home,
      dataDir: app.dataDir ?? '',
      providers,
      limits: withAccountLimits(s.limits, app.providers),
      projects: app.projects,
      groups: app.groups ?? [],
      chatsOrder: app.chatsOrder,
      chatsDefault: app.chatsDefault ?? '',
      worktreesDefault: app.worktreesDefault ?? '',
      update: app.update,
      settings: app.settings,
      sessions,
      // Older bridges send no list: what this window already holds stays.
      data: app.prompts ? withPrompts(held, app.prompts, sessions) : held,
      ui: { ...s.ui, activeSessionId: active, homeProvider, homeAccount, homeCwd: s.ui.homeCwd ?? app.projects[0]?.path ?? null },
    };
  });
  attention.seed(app.sessions);
  if (app.prompts) attention.seedPrompts(app.prompts.permissions, app.prompts.questions);
  // At start the open chat was asked for with hello (`startBridge`): that request is shared, and a
  // chat it has already brought is not asked for again.
  for (const id of onScreen(useStore.getState())) if (again || !useStore.getState().data[id]?.loaded) void loadSession(id, { fresh: again }).catch(() => {});
  // Limits remembered from earlier runs, so nothing waits for an agent to answer.
  void bridge
    .call('usage.limits', {})
    .then((reports) => useStore.setState((s) => applyLimitReports(s, reports)))
    .catch(() => {});
}

// ───────────────────────── events gathered per frame ─────────────────────────
//
// The bridge sends one frame per event, each its own task in the page; applied as they came, every
// event was a store write and a React commit of its own. A burst (the Demo's fleet: 34 sub-agents,
// about 5,800 steps in a few seconds) made thousands of commits, each with the side panel's layout
// reads, and held the page for 1-2 s at a time (perf1). Events are now held and applied together,
// in order, once per frame (and before any answer from the bridge, `bridge.beforeAnswer`, so an
// answer never overtakes the events sent before it): many writes, one commit. A hidden window that
// draws no frames is caught up by a timer.

const heldEvents: BridgeEvent[] = [];
/** While held events are applied: each session's timeline as changed so far, written to the store once (`commitBatch`). */
let batch: Map<string, { view: SessionData; since: number; ids: Set<string> }> | null = null;

function commitBatch() {
  if (!batch?.size) return;
  const done = [...batch];
  batch.clear();
  useStore.setState((s) => {
    const data = { ...s.data };
    for (const [sessionId, b] of done) {
      // Dropped or replaced meanwhile (only item events are gathered, so nothing else wrote it): skip.
      if (!data[sessionId]?.loaded) continue;
      data[sessionId] = { ...b.view, rev: nextRev(), changed: { since: b.since, ids: [...b.ids] } };
    }
    return { data };
  });
}
let heldFrame = 0;
let heldTimer: ReturnType<typeof setTimeout> | undefined;
/** The longest an event waits when no frame comes (a hidden window), ms. */
export const HOLD_EVENTS_MS = 50;

function holdEvent(e: BridgeEvent) {
  heldEvents.push(e);
  if (heldFrame || heldTimer) return;
  if (typeof requestAnimationFrame === 'function') heldFrame = requestAnimationFrame(flushEvents);
  heldTimer = setTimeout(flushEvents, HOLD_EVENTS_MS);
}

/** Applies every event held, in order (also before an answer from the bridge is handed back). */
export function flushEvents() {
  if (heldFrame) cancelAnimationFrame(heldFrame);
  clearTimeout(heldTimer);
  heldFrame = 0;
  heldTimer = undefined;
  if (!heldEvents.length) return;
  const list = heldEvents.splice(0);
  // Words buffered by a direct call come first; from here on the held ones are gathered with the rest.
  if (deltaFrame) cancelAnimationFrame(deltaFrame);
  flushDeltas();
  // Timeline events are gathered per session into one store write; any other event writes what was
  // gathered first, so everything applies in the order it came.
  batch = new Map();
  // One event that throws (in its handler, or in a listener of the store's write) never takes the
  // rest of the frame with it: a prompt behind it would be lost and the agent would wait for ever.
  const safely = (what: string, run: () => void) => {
    try {
      run();
    } catch (err) {
      console.error(`An event could not be applied (${what})`, err);
    }
  };
  try {
    for (const e of list) {
      if (e.type === 'item.delta') {
        attention.delta(e.sessionId, e.id, e.field, e.delta);
        safely(e.type, () =>
          editItems(e.sessionId, (d) => {
            const item = d.items[e.id] as (TimelineItem & Record<string, unknown>) | undefined;
            if (!item) return null;
            d.items[e.id] = { ...item, [e.field]: ((item[e.field] as string | undefined) ?? '') + e.delta } as TimelineItem;
            return { ids: [e.id] };
          }),
        );
        continue;
      }
      if (e.type !== 'item.added' && e.type !== 'item.patch' && e.type !== 'item.removed') safely('write', commitBatch);
      safely(e.type, () => applyEvent(e));
    }
  } finally {
    safely('write', commitBatch);
    batch = null;
  }
}

export function startBridge() {
  bridge.on((e) => {
    if (e.type === 'term.data' || e.type === 'term.exit') {
      for (const l of termListeners) l(e);
      return;
    }
    // The agent's browser tool asks for this window's Browser tab (the handler loads on first use).
    if (e.type === 'browser.request') {
      const request = e.request;
      void import('@/features/rail/browser-agent').then((m) => m.handleBrowserRequest(request)).catch(() => {});
      return;
    }
    holdEvent(e);
  });
  // An answer never overtakes the events sent before it: they are applied first.
  bridge.beforeAnswer = flushEvents;
  startNotify();
  bridge.onStatus((conn) => {
    if (conn === 'closed') pages.clear();
    useStore.setState({ conn });
    if (conn === 'open') bootMark('ws-open');
    if (conn === 'open') void hello().catch((err) => useStore.getState().toast(String(err.message ?? err), 'error'));
    // Starting into a chat (the one open when the window last closed): its conversation is asked
    // right behind hello instead of after hello's answer was applied, so the bridge reads it while
    // the window builds the rest. Applied once hello is (an unknown chat's answer is dropped).
    const first = useStore.getState();
    if (conn === 'open' && !first.ready && first.ui.activeSessionId) void loadSession(first.ui.activeSessionId).catch(() => {});
  });
  bridge.start();
}

// ───────────────────────── chats kept in the window ─────────────────────────
//
// A chat's conversation, once fetched, stays in the store and is kept current by the bridge's
// events (they reach the window for every chat), so opening it again shows it in the first frame.
// Bounded: besides the chats on screen at most `KEEP.chats` stay, holding at most `KEEP.items`
// items between them; the least recently opened (or fetched ahead) go first, back to an entry
// that holds only their waiting prompts. A dropped chat is fetched again when it is opened.
// After the socket dropped, kept chats may have missed events: they are dropped too (`hello`).

/**
 * How many chats stay loaded besides those on screen, and how many items they may hold between them.
 * 120,000 since old turns come as rows (a few hundred bytes a step, `server/core/trim.ts`): with
 * 20,000 a long chat (12,000 to 60,000 items are real) was never kept beside another, so every
 * switch between two long chats fetched tens of megabytes again.
 */
export const KEEP = { chats: 8, items: 120_000 };
/** When each chat was last opened or fetched ahead (a counter, not a clock). */
const used = new Map<string, number>();
let useSeq = 0;
/** Snapshot requests in flight, one per chat. */
const fetching = new Map<string, Promise<void>>();

/** For tests: forgets what was opened and fetched. */
export function resetKept() {
  used.clear();
  fetching.clear();
  pages.clear();
  snapshotThreshold = undefined;
  rowsOf.clear();
  clearTimeout(trimTimer);
  trimTimer = undefined;
}

/** Marks a chat as just used (opened, fetched ahead): the last to be dropped. */
export function touchKept(sessionId: string) {
  used.set(sessionId, ++useSeq);
}

/** The chats on screen: the open one, or both of the race shown. Never dropped. */
export function onScreen(s: Pick<Store, 'ui' | 'sessions'>): string[] {
  if (s.ui.activeSessionId) return [s.ui.activeSessionId];
  const race = s.ui.race;
  if (!race) return [];
  return Object.values(s.sessions)
    .filter((m) => m.race?.id === race)
    .map((m) => m.id);
}

/** A loaded entry back to one that holds only its prompts (what the triage deck needs). */
const unloaded = (d: SessionData): SessionData => ({ ...emptyData(), permissions: d.permissions, questions: d.questions });

/** Every loaded chat but `keep` dropped (after the socket came back). */
function forgetKept(data: Record<string, SessionData>, keep: string[]): Record<string, SessionData> {
  let next = data;
  for (const [id, d] of Object.entries(data)) {
    if (!d.loaded || keep.includes(id)) continue;
    if (next === data) next = { ...data };
    pages.delete(id);
    next[id] = unloaded(d);
    used.delete(id);
  }
  return next;
}

let trimTimer: ReturnType<typeof setTimeout> | undefined;
function trimOffscreenSoon(id: string) {
  if (trimTimer !== undefined || id === useStore.getState().ui.activeSessionId) return;
  trimTimer = setTimeout(() => { trimTimer = undefined; trimKept(); }, 0);
}

/** Drops the least recently used loaded chats beyond `KEEP` (never those on screen). */
export function trimKept() {
  // A chat off screen holds rows only: what was opened in it goes back to its row first.
  const shown = new Set(onScreen(useStore.getState()));
  for (const [id, d] of Object.entries(useStore.getState().data)) if (d.loaded && d.hydrated && !shown.has(id)) restoreRows(id);
  const s = useStore.getState();
  const keep = new Set(onScreen(s));
  const kept = Object.entries(s.data)
    .filter(([id, d]) => d.loaded && !keep.has(id))
    .sort((a, b) => (used.get(b[0]) ?? 0) - (used.get(a[0]) ?? 0));
  const drop: string[] = [];
  let items = 0;
  let chats = 0;
  for (const [id, d] of kept) {
    const count = (d.itemsBefore === -1 ? KEEP.items : d.itemsBefore ?? 0) + d.roots.length + Object.values(d.children).reduce((n, children) => n + children.length, 0);
    if (chats >= KEEP.chats || items + count > KEEP.items) drop.push(id);
    else { chats++; items += count; }
  }
  if (!drop.length) return;
  useStore.setState((st) => {
    const data = { ...st.data };
    for (const id of drop) if (data[id]?.loaded) data[id] = unloaded(data[id]);
    return { data };
  });
  for (const id of drop) {
    used.delete(id);
    pages.delete(id);
    rowsOf.delete(id);
  }
}

/**
 * Fetches a chat's conversation into the store: one request per chat at a time (a fetch ahead and
 * the click that follows share it). `peek`: fetched ahead, so the bridge leaves it unread. An
 * answer for a chat removed meanwhile is dropped. `fresh`: a new request even when one is in
 * flight (the socket came back; the one in flight may hold what was before).
 */
export function loadSession(sessionId: string, opts: { peek?: boolean; fresh?: boolean } = {}): Promise<void> {
  const inFlight = fetching.get(sessionId);
  if (inFlight && !opts.fresh) return inFlight;
  if (pages.has(sessionId) && !opts.fresh) return Promise.resolve();
  if (opts.fresh) pages.delete(sessionId);
  const end = !opts.fresh && !useStore.getState().data[sessionId]?.incomplete && (snapshotThreshold !== undefined || !useStore.getState().ready);
  const p: Promise<void> = bridge
    .call('session.snapshot', { sessionId, ...(opts.peek && { peek: true }), ...(end && { page: 'end' as const }) })
    .then((snap) => {
      // A newer request replaced this one: its answer wins.
      if (fetching.get(sessionId) !== p) return;
      // Asked with hello at start-up and answered first: applied at once, so the events that follow
      // are applied on top of it, and hello then brings the chats' newer meta and what waits on the
      // person. (Held back until hello it went stale: events for a chat that is not loaded are
      // dropped, and the older answer then replaced hello's prompts, so an approval could vanish.)
      if (useStore.getState().ready && !useStore.getState().sessions[sessionId]) return;
      applySnapshot(snap);
      if (!used.has(sessionId)) touchKept(sessionId);
    })
    .finally(() => {
      if (fetching.get(sessionId) === p) fetching.delete(sessionId);
    });
  fetching.set(sessionId, p);
  return p;
}

// Whichever way a chat came on screen (a notification's click, anything that sets it directly): a
// chat whose conversation is not in the window is fetched, never shown empty. `openSession` asks
// before it switches, so its request is the one in flight here and nothing is asked twice.
useStore.subscribe((s, prev) => {
  const id = s.ui.activeSessionId;
  if (id !== prev.ui.activeSessionId || s.ui.race !== prev.ui.race) trimKept();
  if (!id || id === prev.ui.activeSessionId || !s.ready) return;
  if (s.sessions[id] && !s.data[id]?.loaded) void loadSession(id).catch(() => {});
});

/** Stores limit reports, and their limits where the store has none yet or older ones. */
function applyLimitReports(s: Store, reports: LimitsReport[]): Partial<Store> {
  const limitReports = { ...s.limitReports };
  const limits = { ...s.limits };
  for (const r of reports) {
    const key = accountKey(r.provider, r.accountId);
    limitReports[key] = r;
    if (r.limits.length || r.planLimits === false) limits[key] = r.limits;
  }
  return { limitReports, limits };
}

/** Limits the bridge already knows per account (sent with provider info) fill in what the store lacks. */
function withAccountLimits(limits: Store['limits'], providers: ProviderInfo[]): Store['limits'] {
  let next = limits;
  for (const p of providers)
    for (const a of p.accounts ?? []) {
      const key = accountKey(p.id, a.id);
      if (a.limits && !next[key]) next = { ...next, [key]: a.limits };
    }
  return next;
}

/** Capabilities differ per account (plan models, skills, MCP servers): extra accounts get their own cache entry. */
export const capsKey = (provider: ProviderId, cwd: string | null, accountId?: string | null) =>
  `${provider}:${(cwd ?? '').replaceAll('%', '%25').replaceAll('@', '%40')}${accountId && accountId !== DEFAULT_ACCOUNT ? `@${accountId}` : ''}`;

/** A live answer for the same account from another folder. A literal @ in a folder is escaped by capsKey. */
export function capsFromAnywhere(all: Record<string, Capabilities>, provider: ProviderId, accountId?: string): Capabilities | undefined {
  const suffix = accountId && accountId !== DEFAULT_ACCOUNT ? `@${accountId}` : '';
  for (const key in all) {
    if (key.startsWith(`${provider}:`) && (suffix ? key.endsWith(suffix) : !key.includes('@'))) return all[key];
  }
}

export function accountLiveCaps(all: Record<string, Capabilities>, provider: ProviderId, cwd: string | null, accountId?: string): Capabilities | undefined {
  return all[capsKey(provider, cwd, accountId)] ?? all[capsKey(provider, null, accountId)] ?? capsFromAnywhere(all, provider, accountId);
}

const normPath = (p?: string | null) => (p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null);
/** A capsKey with its folder normalized (see `caps.updated`). */
function normKey(key: string) {
  const m = /^(\w+):(.*?)(@[\w-]+)?$/.exec(key);
  return m ? `${m[1]}:${normPath(m[2]) ?? ''}${m[3] ?? ''}` : key;
}

const capsInflight = new Map<string, Promise<void>>();
/** When each home caps key was last answered, so the model menu can ask again after an hour. */
const capsLoadedAt = new Map<string, number>();
const CAPS_STALE_MS = 3600_000;

/**
 * The model menu opened: when the list it shows is older than an hour, the agent is asked again
 * in the background, so a model released meanwhile appears without a restart.
 */
export function refreshStaleCaps(provider: ProviderId, cwd: string | null, accountId?: string | null) {
  const key = capsKey(provider, cwd, accountId);
  if (capsInflight.has(key) || Date.now() - (capsLoadedAt.get(key) ?? Date.now()) < CAPS_STALE_MS) return;
  capsLoadedAt.set(key, Date.now());
  void bridge
    .call('provider.caps', { provider, cwd: cwd ?? undefined, accountId: accountId && accountId !== DEFAULT_ACCOUNT ? accountId : undefined, refresh: true })
    .then((caps) => useStore.setState((s) => ({ providerCaps: { ...s.providerCaps, [key]: caps } })))
    .catch(() => {});
}
const CAPS_RETRIES = 2;
const CAPS_RETRY_MS = 3000;

/**
 * Loads what a provider offers in a folder (models, modes, commands, skills) for the home composer.
 * A failed load is tried again a couple of times, then marked in `capsFailed` so the composer
 * drops its mode and model controls rather than showing skeletons that never resolve.
 */
export function ensureProviderCaps(provider: ProviderId, cwd: string | null, accountId?: string | null, attempt = 0) {
  const key = capsKey(provider, cwd, accountId);
  if (useStore.getState().providerCaps[key] || capsInflight.has(key)) return;
  const p = bridge
    .call('provider.caps', { provider, cwd: cwd ?? undefined, accountId: accountId && accountId !== DEFAULT_ACCOUNT ? accountId : undefined })
    .then((caps) =>
      useStore.setState((s) => {
        capsLoadedAt.set(key, Date.now());
        const { [key]: _, ...capsFailed } = s.capsFailed;
        return { providerCaps: { ...s.providerCaps, [key]: caps }, capsFailed };
      }),
    )
    .catch((err: Error) => {
      // A lost connection or a quick refusal may pass; a probe that timed out will not.
      if (attempt < CAPS_RETRIES && !/timed out/.test(String(err?.message))) window.setTimeout(() => ensureProviderCaps(provider, cwd, accountId, attempt + 1), CAPS_RETRY_MS);
      else useStore.setState((s) => ({ capsFailed: { ...s.capsFailed, [key]: true } }));
    })
    .finally(() => capsInflight.delete(key));
  capsInflight.set(key, p);
}
