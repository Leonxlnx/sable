import type { FolderGroup, FolderOrder, Project, ProviderId, SessionMeta } from '@shared/protocol';
import { baseName } from '@/lib/format';

/** Case- and slash-insensitive key for a folder path. */
export const pathKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Whether a folder's sessions differ by agent or by account (rows then name who in their tooltip), or are all alike. */
export type Mix = 'agent' | 'account' | undefined;

/** What a collapsed folder shows in place of its count: the most pressing state inside it. */
export type Attention = 'awaiting' | 'error' | 'working' | 'unread' | undefined;

export interface ProjectGroup {
  key: string;
  path: string;
  name: string;
  pinned: boolean;
  /** Most recent activity in the group, for sorting. */
  last: number;
  /** Place in the manual folder order (Infinity: none yet). */
  order: number;
  sessions: SessionMeta[];
  archived: SessionMeta[];
  mix: Mix;
  attention: Attention;
}

export interface SidebarGroups {
  pinned: SessionMeta[];
  pinnedMix: Mix;
  /** Every folder, in the order shown (a project's folders where the project stands). */
  projects: ProjectGroup[];
  /** What the list shows below the pinned chats, in order: loose folders, projects and the chats group. */
  top: TopEntry[];
  /** Chats started without a folder, together (absent while there are none). */
  chats?: ChatsGroup;
}

/** A project in the sidebar: several folders under one name. */
export interface SetGroup {
  kind: 'group';
  /** `group:<id>`: the key the manual order and the collapsed set use. */
  key: string;
  id: string;
  name: string;
  order: number;
  last: number;
  folders: ProjectGroup[];
  /** The agents of the chats in its folders, in a fixed order. */
  agents: ProviderId[];
  /** Chats in its folders (not archived). */
  count: number;
  attention: Attention;
}

/** The chats started without a folder. */
export interface ChatsGroup {
  key: 'chats';
  name: string;
  order: number;
  last: number;
  sessions: SessionMeta[];
  archived: SessionMeta[];
  mix: Mix;
  attention: Attention;
}

export type TopEntry = { kind: 'folder'; key: string; folder: ProjectGroup } | SetGroup | { kind: 'chats'; key: 'chats'; chats: ChatsGroup };

/** The key of a project's entry in the manual order and the collapsed set. */
export const groupKey = (id: string) => `group:${id}`;

function mixOf(list: SessionMeta[]): Mix {
  if (list.length < 2) return undefined;
  const p = list[0].provider;
  const a = list[0].accountId ?? 'default';
  let accounts = false;
  for (const s of list) {
    if (s.provider !== p) return 'agent';
    if ((s.accountId ?? 'default') !== a) accounts = true;
  }
  return accounts ? 'account' : undefined;
}

const RANK: Record<Exclude<Attention, undefined>, number> = { awaiting: 4, error: 3, working: 2, unread: 1 };

function attentionOf(list: SessionMeta[]): Attention {
  let best: Attention;
  for (const s of list) {
    const a: Attention =
      // A chat waiting for a reset (Spare) after a limit is not an error to look at.
      s.status === 'awaiting' ? 'awaiting' : s.status === 'error' && !s.spare ? 'error' : s.status === 'running' || s.status === 'starting' ? 'working' : s.unread ? 'unread' : undefined;
    if (a && (!best || RANK[a] > RANK[best])) best = a;
  }
  return best;
}

const AGENT_ORDER: ProviderId[] = ['claude', 'codex', 'opencode', 'demo'];

type Sortable = { name: string; last: number; order: number };

/**
 * Pinned sessions float to their own group; chats started without a folder sit together in the
 * chats group; everything else is grouped by folder, and folders by project. Known folders without
 * sessions still appear so they can be started from; a removed folder (`hidden`) and its sessions
 * do not. Pinned loose folders first, then loose folders, projects and the chats group in the
 * chosen order: manual (dragged; entries without a place yet go last, newest first), most recent
 * activity, or name. A project's folders keep the same order among themselves. Chats inside a
 * folder are always newest first.
 */
export function buildGroups(
  sessions: Record<string, SessionMeta>,
  projects: Project[],
  sort: FolderOrder = 'manual',
  sets: FolderGroup[] = [],
  chatsOrder?: number,
): SidebarGroups {
  const byKey = new Map<string, ProjectGroup>();
  const hidden = new Set<string>();
  const member = new Map<string, string>();
  const known = new Set(sets.map((g) => g.id));
  const ensure = (path: string) => {
    const key = pathKey(path);
    let g = byKey.get(key);
    if (!g) {
      g = { key, path, name: baseName(path) || path, pinned: false, last: 0, order: Infinity, sessions: [], archived: [], mix: undefined, attention: undefined };
      byKey.set(key, g);
    }
    return g;
  };

  for (const p of projects) {
    if (p.hidden) {
      hidden.add(pathKey(p.path));
      continue;
    }
    const g = ensure(p.path);
    g.path = p.path;
    g.name = p.name || g.name;
    g.pinned = !!p.pinned;
    g.last = Math.max(g.last, p.lastOpened);
    if (typeof p.order === 'number') g.order = p.order;
    // A folder whose project is gone is loose again.
    if (p.group && known.has(p.group)) member.set(g.key, p.group);
  }

  const pinned: SessionMeta[] = [];
  const chatList: SessionMeta[] = [];
  const chatArchived: SessionMeta[] = [];
  for (const s of Object.values(sessions)) {
    if (s.pinned && !s.archived) {
      pinned.push(s);
      continue;
    }
    if (s.chat) {
      (s.archived ? chatArchived : chatList).push(s);
      continue;
    }
    // A chat in a lane belongs to the folder it came from.
    const home = s.lane?.folder ?? s.cwd;
    if (hidden.has(pathKey(home))) continue;
    const g = ensure(home);
    if (s.archived) g.archived.push(s);
    else {
      g.sessions.push(s);
      g.last = Math.max(g.last, s.updatedAt);
    }
  }

  const recent = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;
  pinned.sort(recent);
  const folders = [...byKey.values()];
  for (const g of folders) {
    g.sessions.sort(recent);
    g.archived.sort(recent);
    if (!g.last) g.last = g.archived[0]?.updatedAt ?? 0;
    g.mix = mixOf(g.sessions);
    g.attention = attentionOf(g.sessions);
  }

  const within =
    sort === 'recent'
      ? (a: Sortable, b: Sortable) => b.last - a.last
      : sort === 'name'
        ? (a: Sortable, b: Sortable) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || b.last - a.last
        : (a: Sortable, b: Sortable) => (a.order === b.order ? b.last - a.last : a.order - b.order);

  // Projects with their folders.
  const setGroups = new Map<string, SetGroup>();
  for (const g of sets) setGroups.set(g.id, { kind: 'group', key: groupKey(g.id), id: g.id, name: g.name, order: g.order, last: 0, folders: [], agents: [], count: 0, attention: undefined });
  const loose: ProjectGroup[] = [];
  for (const f of folders) {
    const id = member.get(f.key);
    const set = id ? setGroups.get(id) : undefined;
    if (set) set.folders.push(f);
    else loose.push(f);
  }
  for (const set of setGroups.values()) {
    set.folders.sort(within);
    const all = set.folders.flatMap((f) => f.sessions);
    const agents = new Set(all.map((s) => s.provider));
    set.agents = [...AGENT_ORDER.filter((p) => agents.has(p)), ...[...agents].filter((p) => !AGENT_ORDER.includes(p))];
    set.count = all.length;
    set.attention = attentionOf(all);
    set.last = Math.max(0, ...set.folders.map((f) => f.last));
  }

  chatList.sort(recent);
  chatArchived.sort(recent);
  const chats: ChatsGroup | undefined =
    chatList.length || chatArchived.length
      ? {
          key: 'chats',
          name: 'Chats',
          order: typeof chatsOrder === 'number' ? chatsOrder : Infinity,
          last: chatList[0]?.updatedAt ?? chatArchived[0]?.updatedAt ?? 0,
          sessions: chatList,
          archived: chatArchived,
          mix: mixOf(chatList),
          attention: attentionOf(chatList),
        }
      : undefined;

  const ranked: { entry: TopEntry; sort: Sortable; pinned: boolean }[] = [
    ...loose.map((f) => ({ entry: { kind: 'folder' as const, key: f.key, folder: f }, sort: f, pinned: f.pinned })),
    ...[...setGroups.values()].map((g) => ({ entry: g, sort: g, pinned: false })),
    ...(chats ? [{ entry: { kind: 'chats' as const, key: 'chats' as const, chats }, sort: chats, pinned: false }] : []),
  ];
  ranked.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : within(a.sort, b.sort)));
  const top = ranked.map((r) => r.entry);
  const flat = top.flatMap((e) => (e.kind === 'folder' ? [e.folder] : e.kind === 'group' ? e.folders : []));
  return { pinned, pinnedMix: mixOf(pinned), projects: flat, top, chats };
}

export const idsOf = (list: SessionMeta[]) => list.map((s) => s.id).join(' ');

const folderSig = (p: ProjectGroup) => `${p.key}|${p.name}|${p.path}|${p.pinned ? 1 : 0}|${p.mix ?? ''}|${p.attention ?? ''}|${idsOf(p.sessions)}|${idsOf(p.archived)}`;

/** Everything the list's structure shows: order, membership, names, marks. Rows show the rest themselves. */
export function groupsSignature(g: SidebarGroups): string {
  let sig = `P${g.pinnedMix ?? ''}:${idsOf(g.pinned)}`;
  for (const e of g.top) {
    if (e.kind === 'folder') sig += `\n${folderSig(e.folder)}`;
    else if (e.kind === 'group') sig += `\n${e.key}|${e.name}|${e.agents.join(',')}|${e.count}|${e.attention ?? ''}` + e.folders.map((f) => `\n  ${folderSig(f)}`).join('');
    else sig += `\nchats|${e.chats.mix ?? ''}|${e.chats.attention ?? ''}|${idsOf(e.chats.sessions)}|${idsOf(e.chats.archived)}`;
  }
  return sig;
}

/**
 * The groups, as the same object until their structure changes. A session's activity, time or
 * usage ticking (several times a second while it streams) leaves the list alone: rows update
 * themselves. Rebuilt only when the sessions map, the folders or the projects change identity.
 */
export function createGroupsSelector() {
  let seenSessions: Record<string, SessionMeta> | undefined;
  let seenProjects: Project[] | undefined;
  let seenSets: FolderGroup[] | undefined;
  let seenChats: number | undefined;
  let seenSort: FolderOrder | undefined;
  let sig = '';
  let groups: SidebarGroups = { pinned: [], pinnedMix: undefined, projects: [], top: [] };
  return (s: { sessions: Record<string, SessionMeta>; projects: Project[]; groups?: FolderGroup[]; chatsOrder?: number; settings?: { folderOrder?: FolderOrder } }): SidebarGroups => {
    const sort = s.settings?.folderOrder ?? 'manual';
    if (s.sessions === seenSessions && s.projects === seenProjects && s.groups === seenSets && s.chatsOrder === seenChats && sort === seenSort) return groups;
    seenSessions = s.sessions;
    seenProjects = s.projects;
    seenSets = s.groups;
    seenChats = s.chatsOrder;
    seenSort = sort;
    const next = buildGroups(s.sessions, s.projects, sort, s.groups, s.chatsOrder);
    const nextSig = groupsSignature(next);
    if (nextSig !== sig) {
      sig = nextSig;
      groups = next;
    }
    return groups;
  };
}

// ── collapsed folders, remembered per machine ──

/** A header clicked: its folder (project, chats group) flips between open and collapsed. Every call flips it. */
export function toggleCollapsed(prev: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** These open (a session opened inside them); the same set when all of them already are. */
export function unfoldKeys(prev: Set<string>, keys: string[]): Set<string> {
  if (!keys.some((k) => prev.has(k))) return prev;
  const next = new Set(prev);
  for (const k of keys) next.delete(k);
  return next;
}

const COLLAPSED_KEY = 'sable.sidebar.collapsed.v1';

export function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode */
  }
}
