/**
 * Race in the UI: the race a chat is in (`SessionMeta.race`), the view that shows both chats side
 * by side (`ui.race`), each lane's changes file by file (`lane.diff`, asked when a side settles),
 * and the race's actions. The bridge decides everything (server/core/race.ts); this only asks.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Attachment, FileDiff, ProviderId, RaceKeepResult, SessionMeta } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { applySnapshot, loadSession, useStore, type Store } from '@/state/store';
import { useLanes } from '@/features/session/lane';

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/** The race's two chats, left then right, as `left|right` (a string, so a selector stays still while they stream); '' when it is gone. */
export function raceKey(s: Pick<Store, 'sessions'>, raceId: string | null | undefined): string {
  if (!raceId) return '';
  let left = '';
  let right = '';
  for (const m of Object.values(s.sessions)) {
    if (m.race?.id !== raceId) continue;
    if (m.race.side === 0) left = m.id;
    else right = m.id;
  }
  return left && right ? `${left}|${right}` : '';
}

/** The race view's two chats, left then right, or null while there is no such race. */
export function useRacePair(raceId: string | null | undefined): [string, string] | null {
  const key = useStore((s) => raceKey(s, raceId));
  if (!key) return null;
  const [a, b] = key.split('|');
  return [a, b];
}

/** The race view in front, with both chats' conversations loaded. */
export function openRace(raceId: string) {
  const s = useStore.getState();
  for (const id of raceKey(s, raceId).split('|').filter(Boolean)) if (!s.data[id]?.loaded) void loadSession(id).catch(fail);
  s.setUi({ race: raceId, activeSessionId: null });
}

/**
 * `/race <task>` and the palette's Race: two new chats in `cwd`, each in a lane of its own, both
 * sent the task; the race view opens. `provider` picks two models of the Demo when it is the Demo.
 */
export async function startRace(cwd: string, task: string, provider?: ProviderId, modes?: Partial<Record<ProviderId, string>>, attachments?: Attachment[]): Promise<boolean> {
  const s = useStore.getState();
  if (!task.trim()) {
    s.toast('Add a task after /race');
    return false;
  }
  if (attachments?.length) s.toast('Race sends the words only, not attachments');
  try {
    const r = await bridge.call('race.start', { cwd, task, ...(provider ? { provider } : {}), ...(modes ? { modes } : {}) }, 300_000);
    if (!r.ok || !r.sessions || !r.raceId) {
      // A refusal (not a git folder, no agent to race) says so plainly; it is not a failure.
      s.toast(r.error ?? 'Could not start the race.');
      return false;
    }
    for (const snap of r.sessions) applySnapshot(snap);
    useStore.getState().setUi({ race: r.raceId, activeSessionId: null });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Where a race started from a chat or home runs: the chat's folder (the one its lane came from), else the home folder. */
export function raceFolder(meta: SessionMeta | undefined, homeCwd: string | null): string | null {
  if (meta) return meta.chat ? null : (meta.lane?.folder ?? meta.cwd);
  return homeCwd;
}

/**
 * `/race <task>` from a chat (its folder, its agent and mode) or from home (the home folder and
 * choices), and the palette's Race (no task yet: the composer gets `/race `).
 */
export async function raceCommand(sessionId: string | null, task: string): Promise<boolean> {
  const s = useStore.getState();
  const meta = sessionId ? s.sessions[sessionId] : undefined;
  const cwd = raceFolder(meta, s.ui.homeChat ? null : s.ui.homeCwd);
  if (!cwd) {
    if (!meta) s.setUi({ projectPicker: true });
    else s.toast('Race needs a folder in a git repository.');
    return false;
  }
  const provider = meta?.provider ?? s.ui.homeProvider;
  const modes: Partial<Record<ProviderId, string>> = meta ? { [meta.provider]: meta.mode } : { ...s.ui.homeMode };
  // Refused: the composer puts the command back into the field it was typed in (composer/restore.ts),
  // merged with anything typed since.
  return startRace(cwd, task, provider, modes);
}

/** Where the race's follow-up field sends: both lanes, or one side. */
export type RaceTarget = 'both' | '0' | '1';

/**
 * After a follow-up went to `sides` (in that order, `ok` for each): where a retry goes, only the
 * lanes that refused it, or null when every lane took it. A lane that took it never gets it twice.
 */
export function retryTarget(sides: readonly (0 | 1)[], ok: readonly boolean[]): RaceTarget | null {
  const refused = sides.filter((_, i) => !ok[i]);
  if (!refused.length) return null;
  return refused.length > 1 ? 'both' : (String(refused[0]) as RaceTarget);
}

/** Each race's chosen target, kept with the race while the app runs (leaving the view keeps it; its words are a draft, `raceDraftKey`). */
const targets = new Map<string, RaceTarget>();
export const raceTarget = (raceId: string): RaceTarget => targets.get(raceId) ?? 'both';
export const setRaceTarget = (raceId: string, t: RaceTarget) => void targets.set(raceId, t);
/** The race's follow-up field, as a draft in the store (and kept across a restart as drafts are). */
export const raceDraftKey = (raceId: string) => `race:${raceId}`;

/** The lane ends with a land or a discard: the header's mark plays its last moment (see LaneMark). */
const ending = (id: string, ended: 'landed' | 'discarded' | undefined) => useLanes.setState((s) => ({ byId: { ...s.byId, [id]: { loading: false, ...s.byId[id], ended } } }));

/** "Keep this one": lands this side's lane, then the other lane goes and its chat is archived. */
export async function keepRace(sessionId: string, rivalId: string): Promise<RaceKeepResult> {
  ending(sessionId, 'landed');
  ending(rivalId, 'discarded');
  let res: RaceKeepResult;
  try {
    res = await bridge.call('race.keep', { sessionId }, 300_000);
  } catch (err) {
    res = { ok: false, error: (err as Error)?.message || String(err) };
  }
  if (!res.ok) {
    ending(sessionId, undefined);
    ending(rivalId, undefined);
  } else if (res.warning) useStore.getState().toast(res.warning, 'error');
  return res;
}

/** "Discard both": both lanes go with their work; both chats are archived. */
export async function discardRace(sessionId: string, rivalId: string): Promise<{ ok: boolean; error?: string }> {
  ending(sessionId, 'discarded');
  ending(rivalId, 'discarded');
  try {
    const res = await bridge.call('race.discard', { sessionId }, 300_000);
    if (!res.ok) ending(sessionId, undefined), ending(rivalId, undefined);
    return res;
  } catch (err) {
    ending(sessionId, undefined);
    ending(rivalId, undefined);
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

// ── each lane's changes, file by file ──

interface DiffEntry {
  files?: FileDiff[];
  /** The lane they are about (a lane that ended has none). */
  path?: string;
  loading: boolean;
}

export const useRaceDiffs = create<{ byId: Record<string, DiffEntry | undefined> }>(() => ({ byId: {} }));
const inflight = new Map<string, Promise<void>>();

function refreshDiff(sessionId: string, lanePath: string): Promise<void> {
  const running = inflight.get(sessionId);
  if (running) return running;
  const put = (p: Partial<DiffEntry>) => useRaceDiffs.setState((s) => ({ byId: { ...s.byId, [sessionId]: { loading: false, ...s.byId[sessionId], ...p } } }));
  put({ loading: true });
  const p = bridge
    .call('lane.diff', { sessionId }, 60_000)
    .then((files) => put({ files, path: lanePath, loading: false }))
    .catch(() => put({ loading: false }))
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

/** While a side works its list is read again at most this often (each read runs a dozen short git calls). */
const WORKING_EVERY_MS = 4000;

/**
 * A side's changes against the folder's branch: asked when its lane shows, whenever it settles
 * (a turn ended), and while a turn runs a while after a new step (`steps`: how many the chat
 * holds), at most every few seconds, so the list follows the work without asking on every step.
 */
export function useRaceDiff(sessionId: string, lanePath: string | undefined, steps: number): DiffEntry | undefined {
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const entry = useRaceDiffs((s) => s.byId[sessionId]);
  const idle = status === 'idle' || status === 'error';
  const pending = useRef(0);
  useEffect(() => {
    if (!lanePath) return;
    if (idle) {
      window.clearTimeout(pending.current);
      pending.current = 0;
      return void refreshDiff(sessionId, lanePath);
    }
    // One read waits at a time: steps that keep coming do not push it back.
    if (pending.current) return;
    pending.current = window.setTimeout(() => {
      pending.current = 0;
      void refreshDiff(sessionId, lanePath);
    }, WORKING_EVERY_MS);
  }, [sessionId, lanePath, idle, steps]);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  return entry && entry.path === lanePath ? entry : undefined;
}

/** How many entries the chat's conversation holds (one read, however long it is): changes with each new step. */
export const stepCount = (s: Pick<Store, 'data'>, sessionId: string): number => s.data[sessionId]?.roots.length ?? 0;

/** Lines added and removed across a lane's files. */
export function totals(files: FileDiff[] | undefined): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files ?? []) {
    add += f.additions;
    del += f.deletions;
  }
  return { files: files?.length ?? 0, add, del };
}

/** Both lanes' files, by path, in a stable order: the files both changed first, then each side's own. */
export function compareRows(left: FileDiff[] = [], right: FileDiff[] = []): { path: string; left?: FileDiff; right?: FileDiff; same: boolean }[] {
  const by = new Map<string, { path: string; left?: FileDiff; right?: FileDiff }>();
  for (const f of left) by.set(f.path, { path: f.path, left: f });
  for (const f of right) by.set(f.path, { ...by.get(f.path), path: f.path, right: f });
  const rows = [...by.values()].map((r) => ({ ...r, same: !!r.left && !!r.right && sameDiff(r.left, r.right) }));
  const rank = (r: (typeof rows)[number]) => (r.left && r.right ? 0 : r.left ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** Two diffs of one file that bring the same lines. */
export function sameDiff(a: FileDiff, b: FileDiff): boolean {
  if (a.additions !== b.additions || a.deletions !== b.deletions || a.hunks.length !== b.hunks.length) return false;
  return a.hunks.every((h, i) => h.lines.join('\n') === b.hunks[i].lines.join('\n'));
}
