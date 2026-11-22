import type { SessionMeta, TimelineItem } from '@shared/protocol';
import { syntheticOf } from '@shared/synthetic';

/**
 * The parts of a turn (lib/turns.ts `TurnGroup`) these rules read, written out here so the rules load
 * without the turn model (the root type check reads this file; the turn model resolves `@desk` only
 * through the phone's own config).
 */
interface TurnLike {
  key: string;
  state: 'running' | 'done' | 'failed' | 'interrupted';
  segments: readonly {
    lead: string | null;
    steered: boolean;
    notes: readonly string[];
    flow: readonly ({ kind: 'text' | 'show'; id: string } | { kind: 'steps'; key: string; ids: readonly string[] })[];
  }[];
}

/**
 * Small rules the phone's screens share, kept pure so they can be tested without a page: when a chat
 * counts as working, when it can be stopped, which message the conversation follows, what a turn
 * changed (sub-agents included) and whether it can be checked, and which fold hides an item.
 */

// ───────────────────────── what a piece in view is ─────────────────────────

export type ShowKind = 'user' | 'text' | 'notice' | 'check' | 'plan' | 'share' | 'block';

/**
 * How a piece kept in view is drawn, read from the item's own type (never from where it stands in a
 * turn): what a command printed is a user item Claude Code wrote (`<local-command-stdout>`), drawn as
 * its line, not a step. Null for anything else: it shows nothing rather than break the turn.
 */
export function showKind(it: TimelineItem | undefined): ShowKind | null {
  if (!it) return null;
  switch (it.type) {
    case 'user':
      return 'user';
    case 'text':
      return 'text';
    case 'notice':
      return 'notice';
    case 'tool':
      return it.check ? 'check' : it.kind === 'plan' ? 'plan' : it.kind === 'share' ? 'share' : 'block';
    default:
      return null;
  }
}

// ───────────────────────── a chat at work ─────────────────────────

/**
 * The chat works now: its own turn runs, or its turn has ended while sub-agents it sent to the
 * background still work (`SessionMeta.background`). One predicate for home's row, its count of
 * chats at work and the moment a chat is done.
 */
export const worksNow = (s: Pick<SessionMeta, 'status' | 'background'>): boolean =>
  s.status === 'running' || s.status === 'starting' || (s.status !== 'awaiting' && (s.background ?? 0) > 0);

/** The chat's turn can be stopped (`session.interrupt`): it runs, starts, or waits on a prompt. */
export const canStop = (status: SessionMeta['status'] | undefined): boolean => status === 'running' || status === 'starting' || status === 'awaiting';

// ───────────────────────── the message the conversation follows ─────────────────────────

export interface Sent {
  id: string;
  ts: number;
}

/** A message the person sent (or queued, or steered): not one an agent's harness or Sable wrote in their place. */
export function isSent(it: TimelineItem | undefined): boolean {
  if (it?.type !== 'user' || it.parentId) return false;
  if (it.until) return false;
  return !syntheticOf(it);
}

/** The newest message the person sent among the roots (from the end; at most `limit` roots looked at). */
export function newestSent(roots: readonly string[], items: Record<string, TimelineItem | undefined>, limit = 4000): Sent | undefined {
  for (let i = roots.length - 1, n = 0; i >= 0 && n < limit; i--, n++) {
    const it = items[roots[i]];
    if (isSent(it)) return { id: it!.id, ts: it!.ts };
  }
  return undefined;
}

/**
 * The conversation goes to the newest line because the person sent something: a message newer than
 * the one it followed last. A turn begun by a notification or a tool changes nothing; a rewind that
 * leaves an older message last does not pull a reader down either.
 */
export const followSent = (prev: Sent | undefined, next: Sent | undefined): boolean => !!next && next.id !== prev?.id && (!prev || next.ts >= prev.ts);

/**
 * A search hit opened in its chat whose words are not in what the phone shows of the item: the item
 * came cut (a long text, a long message), so it is fetched whole and the words looked for again.
 */
export function wholeForFind(it: TimelineItem | undefined, found: boolean): boolean {
  if (found || !it) return false;
  if (it.type === 'text' && it.streaming) return false;
  return !!(it as { cut?: boolean }).cut;
}

// ───────────────────────── what a turn changed ─────────────────────────

export interface TurnChanges {
  files: number;
  add: number;
  del: number;
  /** The steps that change files, and sub-agents (whose own steps may): what the turn's changes are read from. */
  edits: string[];
  /** Sub-agents whose steps are not all on the phone: what they changed is known only to the desktop. */
  unknown: string[];
}

/**
 * What a turn's edits changed, sub-agents' edits included (as the desktop's `changesOf`): distinct
 * files, lines added and removed. Steps under a sub-agent count when the phone has them; a sub-agent
 * with steps the phone has not got is listed in `unknown`.
 */
export function turnChanges(items: Record<string, TimelineItem | undefined>, children: Record<string, string[] | undefined>, ids: readonly string[]): TurnChanges {
  const files = new Set<string>();
  let add = 0;
  let del = 0;
  const edits: string[] = [];
  const unknown: string[] = [];
  const walk = (list: readonly string[], depth: number) => {
    for (const id of list) {
      const it = items[id];
      if (it?.type !== 'tool' || it.check) continue;
      if (it.kind === 'agent') {
        if (depth === 0) edits.push(id);
        const kids = children[id] ?? [];
        const told = (it as { kids?: number }).kids ?? 0;
        if (told > kids.length && depth === 0) unknown.push(id);
        if (depth < 4) walk(kids, depth + 1);
        continue;
      }
      if (it.kind !== 'edit' && it.kind !== 'write') continue;
      if (depth === 0) edits.push(id);
      if (it.status !== 'done') continue;
      for (const d of it.result?.diff ?? []) {
        files.add(d.path);
        add += d.additions;
        del += d.deletions;
      }
    }
  };
  walk(ids, 0);
  return { files: files.size, add, del, edits, unknown };
}

/**
 * The turn can be checked by the other agent: it ended, and a message opened it (`turn.check` takes
 * that message's id; a turn the agent began by itself has none to give).
 */
export function checkOpener(turn: TurnLike, items: Record<string, TimelineItem | undefined>): string | null {
  if (turn.state !== 'done') return null;
  const lead = turn.segments[0]?.lead;
  if (!lead || lead !== turn.key) return null;
  const it = items[lead];
  return it?.type === 'user' && !it.parentId ? lead : null;
}

// ───────────────────────── where an item is folded ─────────────────────────

export interface FoldTarget {
  /** The turn holds it. */
  found: boolean;
  /** It folds into the finished turn's line: the line has to be open for it to be there. */
  fold: boolean;
  /** The checkpoint (its run's key) whose steps hold it: that run has to be open too. */
  run: string | null;
}

/** Which folds of `turn` hide item `id`: the turn's line, a checkpoint's steps, or nothing. */
export function foldTarget(turn: Pick<TurnLike, 'segments'>, id: string): FoldTarget {
  for (let si = 0; si < turn.segments.length; si++) {
    const s = turn.segments[si];
    // A notification taken up mid-turn folds with the work; the turn's own message and a steered one never do.
    if (s.lead === id) return { found: true, fold: si > 0 && !s.steered, run: null };
    for (const c of s.flow) {
      if (c.kind === 'steps') {
        if (c.ids.includes(id)) return { found: true, fold: true, run: c.key };
      } else if (c.id === id) return { found: true, fold: c.kind === 'text' && s.notes.includes(id), run: null };
    }
  }
  return { found: false, fold: false, run: null };
}
