import { DEFAULT_ACCOUNT, type AccountCap, type AccountInfo, type Attachment, type FolderGroup, type Project, type BackdropConfig, type BackdropImage, type BrowserAnswer, type Effort, type ProviderId, type QueuedMessage, type SessionMeta, type SessionOptions } from '@shared/protocol';
import { DEFAULT_BACKDROP, normalizeBackdrop } from '@shared/backdrop';
import { bridge } from '@/lib/bridge';
import { addComment, clearReview, editComment, removeComment, reviewMessage, type ReviewComment } from '@/features/review/model';
import { applySnapshot, applyWholeItem, capsKey, loadSession, useStore, type RailTab, type SettingsSection, type Store } from './store';

/** Everything the UI can ask the bridge to do. Components call these, never bridge.call directly. */

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

export function openSession(id: string) {
  const s = useStore.getState();
  s.setUi({ activeSessionId: id, race: null });
  if (!s.data[id]?.loaded) void loadSession(id).catch(fail);
  else if (s.sessions[id]?.unread) void bridge.call('session.update', { sessionId: id, patch: { unread: false } }).catch(() => {});
}

const wholeAsked = new Map<string, Promise<void>>();

/**
 * A step the bridge sent cut (`ToolItem.more`: a long output or result, pictures), fetched whole
 * and put in place of the cut one. Asked once at a time per step; a step that failed to come is
 * asked again the next time it is needed.
 */
export function loadWholeItem(sessionId: string, itemId: string): Promise<void> {
  const key = `${sessionId}\u0000${itemId}`;
  let p = wholeAsked.get(key);
  if (!p) {
    p = bridge
      .call('session.item', { sessionId, itemId })
      .then(({ item }) => applyWholeItem(sessionId, item), () => {})
      .finally(() => wholeAsked.delete(key));
    wholeAsked.set(key, p);
  }
  return p;
}

// The section Settings last showed, so reopening it lands where you left off (for as long as the app is open).
let lastSettings: SettingsSection = 'general';
useStore.subscribe((s) => {
  if (s.ui.settings) lastSettings = s.ui.settings;
});

/** Opens Settings at a section, or where it was last left. */
export function openSettings(section?: SettingsSection) {
  useStore.getState().setUi({ settings: section ?? lastSettings });
}

/** Opens or closes the triage deck: every permission and question waiting across sessions. */
export function setTriage(open: boolean) {
  useStore.getState().setUi({ triageOpen: open });
}

export const toggleTriage = () => setTriage(!useStore.getState().ui.triageOpen);

/** Opens the side panel on a tab (the turn's "2 files changed" opens Changes). */
export function showRailTab(tab: RailTab) {
  useStore.getState().setUi({ railOpen: true, railTab: tab });
}

export function goHome(cwd?: string | null) {
  const s = useStore.getState();
  // A folder chosen for the next session ends "No folder".
  s.setUi({ activeSessionId: null, race: null, ...(cwd !== undefined ? { homeCwd: cwd, homeChat: false } : {}) });
}

/** Home with "No folder": the next session is a chat in a fresh folder of its own (made when it is sent). */
export async function goHomeChat() {
  const s = useStore.getState();
  s.setUi({ activeSessionId: null, race: null });
  try {
    const { path } = await bridge.call('chats.prepare', {});
    useStore.getState().setUi({ homeChat: true, homeCwd: path });
  } catch (err) {
    fail(err);
  }
}

export interface NewSessionChoice {
  provider: ProviderId;
  cwd: string;
  model?: string;
  mode?: string;
  effort?: Effort;
  resume?: string;
  title?: string;
  /** The account to run under; absent means the agent's default account. */
  accountId?: string;
  /** Claude Code: start with ultracode on. */
  ultracode?: boolean;
  /** A chat without a folder: the bridge makes its folder, named after `text` (the first message). */
  chat?: { text?: string };
}

/**
 * Switches the chat to another agent in place: the same chat goes on with `provider` (and `model`,
 * else its last one in this chat or its default). An agent new to the chat runs under the account
 * new sessions of that agent use; one the chat ran with keeps its own. `back`: the switch line's
 * "Switch back" (no model or account chosen).
 */
export async function switchAgent(sessionId: string, provider: ProviderId, model?: string, back = false): Promise<boolean> {
  const s = useStore.getState().sessions[sessionId];
  if (!s || s.provider === provider) return false;
  try {
    await bridge.call('session.switchAgent', { sessionId, provider, ...(model ? { model } : {}), ...(back ? {} : { accountId: homeAccountId(provider) }) });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** `/model <name>` in a chat: the bridge finds the model (this agent's, or another agent's, which switches the chat) and says when there is none. */
export async function modelByName(sessionId: string, name: string) {
  try {
    const r = await bridge.call('session.send', { sessionId, text: `/model ${name}` });
    if (!r.ok && r.error) useStore.getState().toast(r.error);
  } catch (err) {
    fail(err);
  }
}

export async function createSession(choice: NewSessionChoice): Promise<SessionMeta | null> {
  try {
    const snap = await bridge.call('session.create', choice);
    applySnapshot(snap);
    useStore.getState().setUi({ activeSessionId: snap.session.id, race: null });
    return snap.session;
  } catch (err) {
    fail(err);
    return null;
  }
}

/**
 * The account a new session with `provider` runs under from the home screen: the home choice
 * while that account exists, otherwise the agent's default account.
 */
export function homeAccountId(provider: ProviderId, s: Pick<Store, 'ui' | 'providers'> = useStore.getState()): string {
  const accounts = s.providers[provider]?.accounts;
  const chosen = s.ui.homeAccount?.[provider];
  if (chosen && accounts?.some((a) => a.id === chosen)) return chosen;
  return accounts?.find((a) => a.isDefault)?.id ?? DEFAULT_ACCOUNT;
}

/** Chooses the account for new sessions with `provider` from the home screen. */
export function setHomeAccount(provider: ProviderId, accountId: string) {
  const s = useStore.getState();
  s.setUi({ homeAccount: { ...s.ui.homeAccount, [provider]: accountId } });
}

/** What the home composer would start: provider, account, folder, model, mode, effort. */
export function homeChoice(): NewSessionChoice | null {
  const { ui, providerCaps, settings } = useStore.getState();
  if (!ui.homeCwd) return null;
  const provider = ui.homeProvider;
  const accountId = homeAccountId(provider);
  const caps = providerCaps[capsKey(provider, ui.homeCwd, accountId)] ?? providerCaps[capsKey(provider, ui.homeCwd)];
  const model = ui.homeModel[provider] ?? settings.defaultModels[provider] ?? caps?.models.find((m) => m.isDefault)?.id ?? caps?.models[0]?.id;
  const mode = ui.homeMode[provider] ?? settings.defaultModes[provider] ?? caps?.modes[0]?.id;
  const effort = ui.homeEffort[provider] ?? settings.defaultEfforts[provider];
  const ultracode = ui.homeUltracode && caps?.features.ultracode ? true : undefined;
  return { provider, cwd: ui.homeCwd, model, mode, effort, accountId, ...(ultracode ? { ultracode } : {}), ...(ui.homeChat ? { chat: {} } : {}) };
}

/** The home composer's ultracode choice (sent with the next new session where the agent offers it). */
export const setHomeUltracode = (on: boolean) => useStore.getState().setUi({ homeUltracode: on });

/** Sends the first message of a new session from the home screen. */
export async function startFromHome(text: string, attachments: Attachment[] = []): Promise<boolean> {
  const choice = homeChoice();
  if (!choice) {
    useStore.getState().setUi({ projectPicker: true });
    return false;
  }
  const session = await createSession(choice.chat ? { ...choice, chat: { text } } : choice);
  if (!session) return false;
  await sendMessage(session.id, text, attachments);
  return true;
}

/**
 * Sends a message. While the agent works it is queued (sent when the turn ends) unless `steer` is
 * set: then the running agent takes it at its next step and it shows where it was sent
 * (`UserItem.steered`). Resolves `queued: true` when it went to the queue.
 */
export async function sendMessage(sessionId: string, text: string, attachments: Attachment[] = [], opts: { steer?: boolean } = {}): Promise<{ ok: boolean; queued?: boolean }> {
  try {
    return await bridge.call('session.send', { sessionId, text, attachments, ...(opts.steer ? { steer: true } : {}) });
  } catch (err) {
    fail(err);
    return { ok: false };
  }
}

export const interrupt = (sessionId: string) => bridge.call('session.interrupt', { sessionId }).catch(fail);

// ── queued messages (held by the bridge while a turn runs) ──

/** Replaces a queued message's text, and its attachments when given; left empty, it is removed. */
export const updateQueued = (sessionId: string, id: string, text: string, attachments?: Attachment[]) =>
  bridge.call('queue.update', { sessionId, id, text, ...(attachments ? { attachments } : {}) }).catch(fail);
export const removeQueued = (sessionId: string, id: string) => bridge.call('queue.remove', { sessionId, id }).catch(fail);
/** Takes a queued message out to edit it (e.g. back into the composer). Null when it already went out. */
export async function takeQueued(sessionId: string, id: string): Promise<QueuedMessage | null> {
  try {
    return (await bridge.call('queue.take', { sessionId, id })).message ?? null;
  } catch (err) {
    fail(err);
    return null;
  }
}
/** New queue order (drag to reorder): `ids` first, in that order. Applied to the store at once; `queue.updated` confirms it. */
export function reorderQueue(sessionId: string, ids: string[]) {
  useStore.setState((s) => {
    const d = s.data[sessionId];
    if (!d) return s;
    const byId = new Map(d.queue.map((q) => [q.id, q]));
    const front = ids.flatMap((id) => byId.get(id) ?? []);
    const named = new Set(front.map((q) => q.id));
    return { data: { ...s.data, [sessionId]: { ...d, queue: [...front, ...d.queue.filter((q) => !named.has(q.id))] } } };
  });
  return bridge.call('queue.reorder', { sessionId, ids }).catch(fail);
}
/** Gives a queued message to the agent now (mid-turn when one is running). */
export const sendQueuedNow = (sessionId: string, id: string) => bridge.call('queue.sendNow', { sessionId, id }).catch(fail);

// ── review comments on diffs (features/review): kept per session in the window until sent ──

export const addReviewComment = (sessionId: string, c: ReviewComment) => useStore.setState((s) => ({ reviews: addComment(s.reviews, sessionId, c) }));
/** New words for a comment; empty words remove it. */
export const editReviewComment = (sessionId: string, id: string, text: string) => useStore.setState((s) => ({ reviews: editComment(s.reviews, sessionId, id, text) }));
export const removeReviewComment = (sessionId: string, id: string) => useStore.setState((s) => ({ reviews: removeComment(s.reviews, sessionId, id) }));
export const discardReview = (sessionId: string) => useStore.setState((s) => ({ reviews: clearReview(s.reviews, sessionId) }));

/**
 * Sends the chat's pending review as one message: the words in the composer first (not a command or
 * a shell line, those stay where they are), then every comment with its file, lines and quote.
 * While a turn runs it is queued like any message. The comments sent (and the words taken from the
 * composer) are cleared once the bridge has it.
 */
export async function sendReview(sessionId: string): Promise<boolean> {
  const s = useStore.getState();
  const comments = s.reviews[sessionId] ?? [];
  if (!comments.length) return false;
  const typed = s.drafts[sessionId]?.text.trim() ?? '';
  const lead = /^[/!]/.test(typed) ? '' : typed;
  const res = await sendMessage(sessionId, reviewMessage(comments, lead));
  if (!res.ok) return false;
  const sent = new Set(comments.map((c) => c.id));
  useStore.setState((st) => ({ reviews: clearReview(st.reviews, sessionId, sent) }));
  if (lead && useStore.getState().drafts[sessionId]?.text.trim() === lead) useStore.getState().setDraft(sessionId, { text: '' });
  return true;
}

export const setModel = (sessionId: string, model: string) => bridge.call('session.setModel', { sessionId, model }).catch(fail);

/** Claude Code ultracode on or off for a session (where `caps.features.ultracode`). */
export const setUltracode = (sessionId: string, on: boolean) => bridge.call('session.setUltracode', { sessionId, on }).catch(fail);

/** The session's speed; the bridge falls back to standard when the model does not offer it. */
export const setSpeed = (sessionId: string, speed: string) => bridge.call('session.setSpeed', { sessionId, speed }).catch(fail);

export const setEffort = (sessionId: string, effort: Effort) => bridge.call('session.setEffort', { sessionId, effort }).catch(fail);

export const setMode = (sessionId: string, mode: string) => bridge.call('session.setMode', { sessionId, mode }).catch(fail);

export const renameSession = (sessionId: string, title: string) => bridge.call('session.rename', { sessionId, title }).catch(fail);

/** Switches browser control, computer use or remote control for a session. */
export const setSessionOptions = (sessionId: string, options: SessionOptions) => bridge.call('session.setOptions', { sessionId, options }).catch(fail);

/** The window's answer to the agent's browser tool (a `browser.request` event). Silent: the bridge times out without it. */
export const respondBrowser = (sessionId: string, requestId: string, answer: BrowserAnswer) => bridge.call('browser.respond', { sessionId, requestId, answer }).catch(() => {});

/** What the session's Browser tab shows now, for the line the agent gets with the next message. */
export const reportBrowserPage = (sessionId: string, page: { url: string; title: string } | null) => bridge.call('browser.page', { sessionId, page }).catch(() => {});

/** Changes what new sessions with `provider` start with (Settings › General). */
export function setDefaultSessionOptions(provider: ProviderId, patch: SessionOptions) {
  const cur = useStore.getState().settings.sessionOptions ?? {};
  return setSettings({ sessionOptions: { ...cur, [provider]: { ...cur[provider], ...patch } } });
}

/**
 * Starts the agent process for what the home composer would create, so the first reply comes
 * sooner. Silent: a failure just means the first send starts cold.
 */
export function prewarmHome() {
  const s = useStore.getState();
  if (s.settings.prewarm === false || s.ui.homeProvider === 'demo') return;
  const c = homeChoice();
  // A chat's folder does not exist before it is sent: nothing to start the agent in.
  if (!c || c.chat) return;
  void bridge.call('provider.prewarm', { provider: c.provider, accountId: c.accountId, cwd: c.cwd, model: c.model, mode: c.mode, effort: c.effort, ultracode: c.ultracode }).catch(() => {});
}

export const updateSession = (sessionId: string, patch: { pinned?: boolean; archived?: boolean; unread?: boolean }) =>
  bridge.call('session.update', { sessionId, patch }).catch(fail);

export async function closeSession(sessionId: string, remove = false) {
  await bridge.call('session.close', { sessionId, remove }).catch(fail);
}

export const respondPermission = (sessionId: string, requestId: string, optionId: string, message?: string) =>
  bridge.call('permission.respond', { sessionId, requestId, optionId, message }).catch(fail);

export const respondQuestion = (sessionId: string, requestId: string, answers: Record<string, string[]> | null) =>
  bridge.call('question.respond', { sessionId, requestId, answers }).catch(fail);

export async function rewindTo(sessionId: string, itemId: string, restoreFiles: boolean) {
  try {
    const r = await bridge.call('session.rewind', { sessionId, itemId, restoreFiles });
    if (!r.ok && r.message) useStore.getState().toast(r.message, 'error');
    return r.ok;
  } catch (err) {
    fail(err);
    return false;
  }
}

/**
 * "Check with Codex": the other agent reviews the changes of the finished turn that `turnId` (its
 * first message) started, read-only; its block shows under that turn. Answers the check's step id.
 */
export async function checkTurn(sessionId: string, turnId: string): Promise<string | null> {
  try {
    const r = await bridge.call('turn.check', { sessionId, turnId });
    if (!r.ok && r.error) useStore.getState().toast(r.error, 'error');
    return r.itemId ?? null;
  } catch (err) {
    fail(err);
    return null;
  }
}

/** Stops a running turn check (`itemId`: its step). */
export const stopCheck = (sessionId: string, itemId: string) => bridge.call('turn.checkStop', { sessionId, itemId }).catch(fail);

/** Fork at an answer: a new session that continues from the end of that turn, opened at once. The original stays as it is. */
export async function forkAt(sessionId: string, itemId: string): Promise<SessionMeta | null> {
  try {
    const snap = await bridge.call('session.fork', { sessionId, itemId });
    applySnapshot(snap);
    useStore.getState().setUi({ activeSessionId: snap.session.id, race: null });
    return snap.session;
  } catch (err) {
    fail(err);
    return null;
  }
}

export async function addProject(path: string) {
  try {
    const project = await bridge.call('project.add', { path });
    // A folder chosen for the next session ends "No folder".
    useStore.getState().setUi({ homeCwd: project.path, homeChat: false, projectPicker: false });
    return project;
  } catch (err) {
    fail(err);
    return null;
  }
}

export const removeProject = (path: string) => bridge.call('project.remove', { path }).catch(fail);

/**
 * The manual folder order (the sidebar's drag): `paths` in their new order. Applied to the store at
 * once so the list moves under the hand; `projects.updated` confirms it. A drag while the sidebar
 * sorts by recency or name switches it to the manual order it just made.
 */
export function reorderFolders(paths: string[]) {
  const s = useStore.getState();
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const place = new Map(paths.map((p, i) => [norm(p), i]));
  const rest = paths.length;
  useStore.setState({ projects: s.projects.map((p) => ({ ...p, order: place.get(norm(p.path)) ?? rest + (p.order ?? 0) })) });
  if ((s.settings.folderOrder ?? 'manual') !== 'manual') void setSettings({ folderOrder: 'manual' });
  return bridge.call('project.reorder', { paths }).catch(fail);
}

/** Folders dropped onto the sidebar: each becomes a project (files and missing folders are left out). Resolves how many were added. */
export async function addFolders(paths: string[]): Promise<number> {
  const results = await Promise.all(paths.map((path) => bridge.call('project.add', { path }).then(() => true, () => false)));
  return results.filter(Boolean).length;
}

export const pinProject = (path: string, pinned: boolean) => bridge.call('project.pin', { path, pinned }).catch(fail);

// ── projects: folders grouped under one name ──

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The sidebar's arrangement after a drag or a menu (`project.arrange`): `top` entries in their new
 * order (a folder's path, `group:<id>`, `chats`), `inside` a project's folders in order. Applied to
 * the store at once, the same way the bridge does, so the list moves under the hand.
 */
export function arrangeSidebar(top: string[], inside?: Record<string, string[]>) {
  const s = useStore.getState();
  const projects = s.projects.map((p) => ({ ...p }));
  const groups = s.groups.map((g) => ({ ...g }));
  let chatsOrder = s.chatsOrder;
  const find = (dir: string) => projects.find((p) => normPath(p.path) === normPath(dir));
  for (const [id, paths] of Object.entries(inside ?? {})) {
    if (!groups.some((g) => g.id === id)) continue;
    paths.forEach((dir, i) => {
      const p = find(dir);
      if (p) Object.assign(p, { group: id, order: i });
    });
  }
  const live = (p: Project) => !!p.group && groups.some((g) => g.id === p.group);
  type Entry = { order: number | undefined; set: (n: number) => void; key: unknown };
  const named: Entry[] = [];
  const seen = new Set<unknown>();
  const chats: Entry = { order: chatsOrder, set: (n) => (chatsOrder = n), key: 'chats' };
  for (const key of top) {
    let e: Entry | undefined;
    if (key === 'chats') e = chats;
    else if (key.startsWith('group:')) {
      const g = groups.find((x) => x.id === key.slice(6));
      if (g) e = { order: g.order, set: (n) => (g.order = n), key: g };
    } else {
      const p = find(key);
      if (p) {
        delete p.group;
        e = { order: p.order, set: (n) => (p.order = n), key: p };
      }
    }
    if (e && !seen.has(e.key)) {
      seen.add(e.key);
      named.push(e);
    }
  }
  if (named.length) {
    const rest: Entry[] = [
      ...projects.filter((p) => !live(p) && !seen.has(p)).map((p) => ({ order: p.order, set: (n: number) => (p.order = n), key: p })),
      ...groups.filter((g) => !seen.has(g)).map((g) => ({ order: g.order, set: (n: number) => (g.order = n), key: g })),
      ...(seen.has('chats') || typeof chatsOrder !== 'number' ? [] : [chats]),
    ].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    [...named, ...rest].forEach((e, i) => e.set(i));
  }
  useStore.setState({ projects, groups, chatsOrder });
  if ((s.settings.folderOrder ?? 'manual') !== 'manual' && top.length) void setSettings({ folderOrder: 'manual' });
  return bridge.call('project.arrange', { top, ...(inside ? { inside } : {}) }).catch(fail);
}

/** A new project holding `paths` (where the first of them stood). Resolves the project, or null. */
export async function createGroup(name: string, paths: string[] = []): Promise<FolderGroup | null> {
  // Projects are not pinned: a pinned folder that starts one is unpinned.
  const pinned = useStore.getState().projects.filter((p) => p.pinned && paths.some((x) => normPath(x) === normPath(p.path)));
  await Promise.all(pinned.map((p) => pinProject(p.path, false)));
  try {
    return await bridge.call('group.create', { name, paths });
  } catch (err) {
    fail(err);
    return null;
  }
}

/** A project's name; shown at once, `projects.updated` confirms it. */
export function renameGroup(id: string, name: string) {
  const wanted = name.replace(/\s+/g, ' ').trim();
  if (wanted) useStore.setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name: wanted } : g)) }));
  return bridge.call('group.rename', { id, name }).catch(fail);
}

/** Removes a project; its folders stay, loose, where it stood. */
export const removeGroup = (id: string) => bridge.call('group.remove', { id }).catch(fail);

/** Puts a folder into a project, last among its folders (a pinned folder is unpinned: projects are not pinned). */
export function addToGroup(path: string, id: string) {
  const s = useStore.getState();
  if (s.projects.some((p) => p.pinned && normPath(p.path) === normPath(path))) {
    useStore.setState({ projects: s.projects.map((p) => (normPath(p.path) === normPath(path) ? { ...p, pinned: false } : p)) });
    void pinProject(path, false);
  }
  const inside = useStore.getState().projects
    .filter((p) => p.group === id && normPath(p.path) !== normPath(path) && !p.hidden)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    .map((p) => p.path);
  return arrangeSidebar([], { [id]: [...inside, path] });
}

/** Takes a folder out of its project: it stands, loose, right after the project. */
export function removeFromGroup(path: string, topKeys: string[]) {
  const p = useStore.getState().projects.find((x) => normPath(x.path) === normPath(path));
  if (!p?.group) return;
  const at = topKeys.indexOf(`group:${p.group}`);
  const top = [...topKeys];
  top.splice(at < 0 ? top.length : at + 1, 0, path);
  return arrangeSidebar(top);
}

/**
 * The folder's name in the sidebar (the folder on disk is not renamed); empty restores the folder's
 * own name. Shown at once; `projects.updated` confirms it.
 */
export function renameProject(path: string, name: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const key = norm(path);
  const wanted = name.replace(/\s+/g, ' ').trim();
  if (wanted) useStore.setState((s) => ({ projects: s.projects.map((p) => (norm(p.path) === key ? { ...p, name: wanted } : p)) }));
  return bridge.call('project.rename', { path, name }).catch(fail);
}

export async function setSettings(patch: Partial<import('@shared/protocol').AppSettings>) {
  try {
    await bridge.call('app.setSettings', { patch });
  } catch (err) {
    fail(err);
  }
}

// ── backdrop ──

/** The backdrop config as drawn now: a change on its way to the bridge, else the stored one. */
export const selectBackdrop = (s: Store): BackdropConfig => s.backdropLive ?? s.settings.backdropConfig;

const BACKDROP_SAVE_MS = 300;
let backdropTimer = 0;

/**
 * Changes the backdrop. It shows at once (`backdropLive`); the bridge gets the result after a
 * short pause, so dragging a slider sends one request, not one per pointer move.
 */
export function setBackdrop(patch: Partial<BackdropConfig>) {
  const s = useStore.getState();
  const next = normalizeBackdrop({ ...selectBackdrop(s), ...patch }, s.settings.backdropImages.map((i) => i.id));
  useStore.setState({ backdropLive: next });
  clearTimeout(backdropTimer);
  backdropTimer = window.setTimeout(() => {
    void bridge
      .call('app.setSettings', { patch: { backdropConfig: next } })
      .catch(fail)
      .finally(() => {
        // The stored settings carry it now (the bridge's settings event comes before its reply).
        if (useStore.getState().backdropLive === next) useStore.setState({ backdropLive: null });
      });
  }, BACKDROP_SAVE_MS);
}

/** Longest side an uploaded backdrop image is scaled down to. */
const BACKDROP_MAX_SIDE = 2048;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image'));
    r.readAsDataURL(blob);
  });
}

async function encodeImage(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not read the image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const encode = (type: string, quality: number): Promise<Blob | null> =>
    canvas instanceof HTMLCanvasElement ? new Promise((res) => canvas.toBlob(res, type, quality)) : (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  const webp = await encode('image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return webp;
  const jpeg = await encode('image/jpeg', 0.9);
  if (!jpeg) throw new Error('Could not read the image');
  return jpeg;
}

/** Largest file the backdrop takes before decoding (a photo is a few MB; this only guards memory). */
const BACKDROP_MAX_FILE = 80 * 1024 * 1024;

/**
 * Uploads an image for the backdrop: decoded here (EXIF rotation applied), scaled to at most
 * 2048 px on its long side and re-encoded (WebP, else JPEG), then stored by the bridge. Shows it
 * as the backdrop at once. Returns the image, or one plain line saying why not.
 */
export async function addBackdropImage(file: Blob): Promise<BackdropImage | { error: string }> {
  try {
    if (file.type && !file.type.startsWith('image/')) return { error: 'This file is not an image.' };
    if (file.size > BACKDROP_MAX_FILE) return { error: 'This image is larger than 80 MB.' };
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return { error: file.type ? 'This image format cannot be read. Use PNG, JPEG, WebP or AVIF.' : 'This file is not an image.' };
    }
    const k = Math.min(1, BACKDROP_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const blob = await encodeImage(bitmap, w, h);
    bitmap.close();
    const img = await bridge.call('backdrop.add', { data: await blobToBase64(blob), width: w, height: h });
    imageBlobs.set(img.id, Promise.resolve(blob));
    const cur = selectBackdrop(useStore.getState());
    // A picture fills the stage: the default's low glow would show only its lower edge.
    setBackdrop({ source: 'image', image: img.id, ...(cur.source !== 'image' && cur.reach === DEFAULT_BACKDROP.reach ? { reach: 100 } : {}) });
    return img;
  } catch (err) {
    return { error: err instanceof Error && err.message ? err.message : 'The image could not be saved.' };
  }
}

export async function removeBackdropImage(id: string) {
  try {
    // Anything still on its way would bring the removed image back.
    clearTimeout(backdropTimer);
    useStore.setState({ backdropLive: null });
    await bridge.call('backdrop.remove', { id });
    imageBlobs.delete(id);
  } catch (err) {
    fail(err);
  }
}

const imageBlobs = new Map<string, Promise<Blob>>();

/** A stored backdrop image's bytes, fetched once per id. */
export function backdropImageBlob(id: string): Promise<Blob> {
  let p = imageBlobs.get(id);
  if (!p) {
    p = bridge.call('backdrop.get', { id }).then((r) => {
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: r.type });
    });
    p.catch(() => imageBlobs.delete(id));
    imageBlobs.set(id, p);
  }
  return p;
}

// Account id optional everywhere: absent means the agent's built-in default account.
export const login = (provider: ProviderId, accountId?: string) => bridge.call('auth.login', { provider, accountId }).catch(fail);
export const cancelLogin = (provider: ProviderId, accountId?: string) => bridge.call('auth.cancel', { provider, accountId }).catch(fail);
/** The code a browser showed instead of returning to Sable: finishes the sign-in in progress. */
export const submitLoginCode = (provider: ProviderId, accountId: string | undefined, code: string) =>
  bridge.call('auth.code', { provider, accountId, code }).catch((err: Error) => ({ ok: false, error: err.message }));
export const logout = (provider: ProviderId, accountId?: string) => bridge.call('auth.logout', { provider, accountId }).catch(fail);

// ── updates of the desktop app ──
const setUpdate = (state: import('@shared/protocol').UpdateState | undefined) => state && useStore.setState({ update: state });
/** Asks GitHub for a newer release now; one found downloads in the background. Says the outcome when there is nothing to restart into. */
export const checkForUpdate = () =>
  bridge.call('update.check', {}).then((state) => {
    setUpdate(state);
    if (state.status === 'idle') useStore.getState().toast('Sable is up to date', 'success');
    else if (state.status === 'error') useStore.getState().toast(state.error || 'The check failed', 'error');
  }).catch(fail);
/** Installs the downloaded release and restarts Sable (while agents work: once they are done). */
export const installUpdate = () => bridge.call('update.install', {}).then(setUpdate).catch(fail);
/** A restart waiting for the agents to finish: not after all. */
export const cancelUpdate = () => bridge.call('update.install', { cancel: true }).then(setUpdate).catch(fail);
export const refreshProvider = (provider: ProviderId, accountId?: string) => bridge.call('auth.refresh', { provider, accountId }).catch(fail);
export const refreshLimits = (provider: ProviderId, accountId?: string) => bridge.call('provider.limits', { provider, accountId }).catch(() => []);
/** Plan limits read now, even when no agent process runs (it may start a short one; no tokens). For a refresh the user asked for. */
export const readLimitsNow = (provider: ProviderId, accountId?: string) => bridge.call('provider.limits', { provider, accountId, force: true }).catch(() => []);
/** Spends one reset credit of the account. Call only from the user's confirmed click; reuse `key` on a retry. */
export const spendLimitReset =(provider: ProviderId, accountId: string | undefined, key: string) => bridge.call('provider.useReset', { provider, accountId, key }, 60_000);
/** Local token usage for the last 30 days, at once; `refresh` scans the transcripts for changes (the result comes as `usage.updated`). */
export const fetchUsage = (refresh = false) => bridge.call('usage.report', { refresh }, 120_000);
/** Opens the Usage page. */
export const openUsage = () => openSettings('usage');

/** Adds an account with its own empty profile. With `signIn` its sign-in starts right away. */
export async function addAccount(provider: ProviderId, opts: { label?: string; signIn?: boolean } = {}): Promise<AccountInfo | null> {
  try {
    const { account, ...info } = await bridge.call('account.add', { provider, label: opts.label });
    useStore.setState((s) => ({ providers: { ...s.providers, [provider]: info } }));
    if (opts.signIn) void login(provider, account.id);
    return account;
  } catch (err) {
    fail(err);
    return null;
  }
}

export const renameAccount = (provider: ProviderId, accountId: string, label: string) =>
  bridge.call('account.rename', { provider, accountId, label }).catch(fail);

/** Moves an account `by` places in its agent's list (the order used everywhere accounts are listed). */
export async function moveAccount(provider: ProviderId, accountId: string, by: number) {
  const info = useStore.getState().providers[provider];
  const list = info?.accounts ?? [];
  const from = list.findIndex((a) => a.id === accountId);
  const to = from + by;
  if (!info || from < 0 || to < 0 || to >= list.length) return;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  useStore.setState((s) => ({ providers: { ...s.providers, [provider]: { ...info, accounts: next } } }));
  try {
    const fresh = await bridge.call('account.reorder', { provider, ids: next.map((a) => a.id) });
    useStore.setState((s) => ({ providers: { ...s.providers, [provider]: fresh } }));
  } catch (err) {
    fail(err);
  }
}

/** "Use up to" for an account (Settings › Accounts): percents of its weekly and 5-hour windows; 100 or empty clears one. */
export function setAccountCap(provider: ProviderId, accountId: string, patch: AccountCap) {
  const key = `${provider}:${accountId}`;
  const all = { ...useStore.getState().settings.accountCaps };
  const next: AccountCap = { ...all[key], ...patch };
  for (const k of ['weekly', 'session'] as const) if (!(Number(next[k]) >= 1 && Number(next[k]) < 100)) delete next[k];
  if (next.weekly === undefined && next.session === undefined) delete all[key];
  else all[key] = next;
  return setSettings({ accountCaps: all });
}

/** Where chats without a folder get their folders; empty goes back to the default place. */
export const setChatsFolder = (path: string) => setSettings({ chatsFolder: path.trim() });

/** Where lanes' worktrees go; empty goes back to `<Sable home>/lanes`. */
export const setWorktreesFolder = (path: string) => setSettings({ worktreesFolder: path.trim() });

/** Removes an extra account and its folder. Resolves false when the bridge refused (a session is still working). */
export async function removeAccount(provider: ProviderId, accountId: string): Promise<boolean> {
  try {
    await bridge.call('account.remove', { provider, accountId });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Registers a config folder the user already keeps as an account (used in place; removing it only forgets it). */
export async function addExistingAccount(provider: ProviderId, dir: string, label?: string): Promise<AccountInfo | null> {
  try {
    const { account, ...info } = await bridge.call('account.addExisting', { provider, dir, label });
    useStore.setState((s) => ({ providers: { ...s.providers, [provider]: info } }));
    return account;
  } catch (err) {
    fail(err);
    return null;
  }
}

/** Config folders under the home folder that look like the agent's own and are not accounts yet. */
export const accountFolders = (provider: ProviderId) => bridge.call('account.folders', { provider }).catch(() => []);

/**
 * Moves an idle session to another account of its agent (the conversation carries over where it
 * can). `retry` sends the message a plan limit refused again. Resolves null when the bridge refused.
 */
export async function switchSessionAccount(sessionId: string, accountId: string, retry = false) {
  try {
    return await bridge.call('session.switchAccount', { sessionId, accountId, retry });
  } catch (err) {
    fail(err);
    return null;
  }
}

// ── Spare: chats that start by themselves (server/core/spare.ts) ──

/** `/spare`: the message waits in the chat's queue until an account of its agent has spare quota. */
export async function spareSend(sessionId: string, text: string, attachments?: Attachment[]): Promise<boolean> {
  try {
    const r = await bridge.call('spare.send', { sessionId, text, ...(attachments?.length ? { attachments } : {}) });
    if (!r.ok && r.error) useStore.getState().toast(r.error);
    return r.ok;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** "Continue at reset": the chat carries on with the refused turn once its account's window resets. */
export async function continueAtReset(sessionId: string): Promise<boolean> {
  try {
    const r = await bridge.call('spare.atReset', { sessionId });
    if (!r.ok && r.error) useStore.getState().toast(r.error);
    return r.ok;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Stops a chat waiting to start by itself; its held messages stay in the queue. */
export const cancelSpare = (sessionId: string) => bridge.call('spare.cancel', { sessionId }).catch(fail);

/** Sends a waiting chat's first held message now, as an ordinary send. */
export const startSpareNow = (sessionId: string) => bridge.call('spare.startNow', { sessionId }).catch(fail);

/** Makes an account the one new sessions with this agent use. The home choice follows it. */
export function setDefaultAccount(provider: ProviderId, accountId: string) {
  const s = useStore.getState();
  const next = { ...s.settings.defaultAccounts };
  if (accountId === DEFAULT_ACCOUNT) delete next[provider];
  else next[provider] = accountId;
  if (s.ui.homeAccount?.[provider]) {
    const homeAccount = { ...s.ui.homeAccount };
    delete homeAccount[provider];
    s.setUi({ homeAccount });
  }
  return setSettings({ defaultAccounts: next });
}

/** Resumes a conversation stored by the provider (from history) as a Sable session. */
export async function resumeFromHistory(provider: ProviderId, providerSessionId: string, cwd: string, title?: string, accountId?: string) {
  const existing = Object.values(useStore.getState().sessions).find((s) => s.provider === provider && s.providerSessionId === providerSessionId);
  if (existing) {
    openSession(existing.id);
    return existing;
  }
  return createSession({ provider, cwd, resume: providerSessionId, title, accountId });
}
