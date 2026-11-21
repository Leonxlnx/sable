import { create } from 'zustand';
import type {
  UpdateState,
  FolderGroup,
  AppSettings,
  Attachment,
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
  SessionMeta,
  SessionSnapshot,
  TimelineItem,
  Todo,
} from '@shared/protocol';
import { DEFAULT_ACCOUNT, DEFAULT_SETTINGS } from '@shared/protocol';
import { bridge, type ConnStatus } from '@/lib/bridge';
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
export type SettingsSection = 'general' | 'appearance' | 'accounts' | 'usage' | 'models' | 'permissions' | 'phone' | 'mcp' | 'hooks' | 'skills' | 'agents' | 'memory' | 'profile' | 'shortcuts' | 'about';

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
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

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

/** The release whose "New update available" toast this window already showed. */
let announcedUpdate: string | undefined;

/** Once per release and window: a downloaded update says so, whether the start check found it or a later one did. */
function announceUpdate(u: UpdateState | undefined) {
  if (!u || u.status !== 'ready' || !u.latest || announcedUpdate === u.latest) return;
  announcedUpdate = u.latest;
  useStore.getState().toast('New update available');
}

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
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
    window.setTimeout(() => get().dismissToast(id), level === 'error' ? 7000 : level === 'warn' ? 6000 : 3800);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
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
 * A step fetched whole (`session.item`) in place of the cut one the snapshot brought
 * (`ToolItem.more`). Only that item changes; an item that is no longer cut stays as it is.
 */
export function applyWholeItem(sessionId: string, item: TimelineItem) {
  editItems(sessionId, (d) => {
    const cur = d.items[item.id];
    if (cur?.type !== 'tool' || !cur.more) return null;
    d.items[item.id] = item;
    return { ids: [item.id] };
  });
}

export function applySnapshot(snap: SessionSnapshot) {
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [snap.session.id]: snap.session },
    data: {
      ...s.data,
      [snap.session.id]: {
        loaded: true,
        ...indexItems(snap.items),
        permissions: snap.permissions,
        questions: snap.questions,
        todos: snap.todos,
        suggestion: snap.suggestion,
        queue: snap.queue ?? [],
        caps: snap.caps ?? s.data[snap.session.id]?.caps,
      },
    },
  }));
}

/**
 * A session finished or started waiting on the user while they were looking elsewhere:
 * mark it unread and, if they asked for it, raise a system notification.
 */
function onStatusChange(session: SessionMeta, prev: SessionMeta['status']) {
  const s = useStore.getState();
  // A turn inside an armed `/until` loop is not the end of the work: only the loop's end is news.
  const looping = !!session.until && session.status !== 'error';
  const finished = !looping && (prev === 'running' || prev === 'awaiting') && (session.status === 'idle' || session.status === 'error');
  const needsYou = session.status === 'awaiting' && prev !== 'awaiting';
  if (!finished && !needsYou) return;
  const viewing = s.ui.activeSessionId === session.id;
  if (viewing && !document.hidden) return;
  if (finished && !viewing) void bridge.call('session.update', { sessionId: session.id, patch: { unread: true } }).catch(() => {});
  if (!s.settings.notifyOnDone || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const title = needsYou ? 'Waiting for your approval' : session.status === 'error' ? 'Turn ended with an error' : 'Turn finished';
    const n = new Notification(title, { body: session.title, tag: session.id });
    n.onclick = () => {
      window.focus();
      useStore.getState().setUi({ activeSessionId: session.id });
      n.close();
    };
  } catch {
    /* notifications are best effort */
  }
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

/** Applies one bridge event to the store. Exported for tests; the app feeds it from `startBridge`. */
export function applyEvent(e: BridgeEvent) {
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
      editItems(e.sessionId, (d) => {
        const known = !!d.items[e.item.id];
        d.items[e.item.id] = e.item;
        const ids = [e.item.id];
        // An item the timeline already holds is replaced where it stands.
        if (known) return { ids };
        if (e.item.parentId) return { ids, patch: { children: { ...d.children, [e.item.parentId]: [...(d.children[e.item.parentId] ?? []), e.item.id] } } };
        return { ids, patch: { roots: [...d.roots, e.item.id] } };
      });
      return;
    case 'item.patch':
      flushDeltas();
      editItems(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item) return null;
        d.items[e.id] = { ...item, ...e.patch } as TimelineItem;
        return { ids: [e.id] };
      });
      return;
    case 'item.removed':
      editItems(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item) return null;
        const children = { ...d.children };
        const ids: string[] = [];
        // The item goes with everything nested under it, as on the bridge.
        const drop = (id: string) => {
          delete d.items[id];
          ids.push(id);
          const kids = children[id];
          if (kids) {
            delete children[id];
            kids.forEach(drop);
          }
        };
        drop(e.id);
        const patch: Partial<SessionData> = { children };
        if (item.parentId) children[item.parentId] = (children[item.parentId] ?? []).filter((x) => x !== e.id);
        else patch.roots = d.roots.filter((x) => x !== e.id);
        return { ids, patch };
      });
      return;
    case 'timeline.reset':
      deltaBuffer.clear();
      patchData(e.sessionId, () => indexItems(e.items));
      return;
    case 'session.added':
      useStore.setState((s) => ({
        sessions: { ...s.sessions, [e.session.id]: e.session },
        data: s.data[e.session.id] ? s.data : { ...s.data, [e.session.id]: { ...emptyData(), loaded: true } },
      }));
      return;
    case 'session.updated': {
      const before = useStore.getState().sessions[e.id];
      useStore.setState((s) => {
        const cur = s.sessions[e.id];
        if (!cur) return s;
        return { sessions: { ...s.sessions, [e.id]: { ...cur, ...e.patch } } };
      });
      if (before && e.patch.status && e.patch.status !== before.status) onStatusChange({ ...before, ...e.patch }, before.status);
      return;
    }
    case 'session.removed':
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
      useStore.setState((s) => ({ providers: { ...s.providers, [e.provider.id]: e.provider }, limits: withAccountLimits(s.limits, [e.provider]) }));
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
    case 'update.state':
      useStore.setState({ update: e.state });
      announceUpdate(e.state);
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
  const app = await bridge.call('app.hello', {});
  useStore.setState((s) => {
    const sessions = Object.fromEntries(app.sessions.map((m) => [m.id, m]));
    const active = s.ui.activeSessionId && sessions[s.ui.activeSessionId] ? s.ui.activeSessionId : null;
    const installed = app.providers.filter((p) => p.installed);
    // A fresh profile starts on the agent chosen in settings; after that the home choice sticks.
    const wanted = homeChosen || !installed.some((p) => p.id === app.settings.defaultProvider) ? s.ui.homeProvider : app.settings.defaultProvider;
    const homeProvider = installed.some((p) => p.id === wanted) ? wanted : (installed.find((p) => p.id !== 'demo')?.id ?? installed[0]?.id ?? 'claude');
    // Forget home account choices whose account is gone.
    const homeAccount: Partial<Record<ProviderId, string>> = {};
    for (const p of app.providers) {
      const chosen = s.ui.homeAccount?.[p.id];
      if (chosen && (!p.accounts || p.accounts.some((a) => a.id === chosen))) homeAccount[p.id] = chosen;
    }
    return {
      ready: true,
      version: app.version,
      platform: app.platform,
      home: app.home,
      dataDir: app.dataDir ?? '',
      providers: Object.fromEntries(app.providers.map((p) => [p.id, p])),
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
      data: app.prompts ? withPrompts(s.data, app.prompts, sessions) : s.data,
      ui: { ...s.ui, activeSessionId: active, homeProvider, homeAccount, homeCwd: s.ui.homeCwd ?? app.projects[0]?.path ?? null },
    };
  });
  announceUpdate(app.update);
  const active = useStore.getState().ui.activeSessionId;
  if (active) void loadSession(active);
  // Limits remembered from earlier runs, so nothing waits for an agent to answer.
  void bridge
    .call('usage.limits', {})
    .then((reports) => useStore.setState((s) => applyLimitReports(s, reports)))
    .catch(() => {});
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
    applyEvent(e);
  });
  bridge.onStatus((conn) => {
    useStore.setState({ conn });
    if (conn === 'open') void hello().catch((err) => useStore.getState().toast(String(err.message ?? err), 'error'));
  });
  bridge.start();
}

export async function loadSession(sessionId: string) {
  const snap = await bridge.call('session.snapshot', { sessionId });
  applySnapshot(snap);
}

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
  `${provider}:${cwd ?? ''}${accountId && accountId !== DEFAULT_ACCOUNT ? `@${accountId}` : ''}`;

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
