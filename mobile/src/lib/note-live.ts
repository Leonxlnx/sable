import type { ProviderId, SessionMeta, TimelineItem, TurnLive as BridgeTurnLive } from '@shared/protocol';
import { syntheticOf } from '@shared/synthetic';
import { turnLive as readTurn } from '@shared/turn-live';

/**
 * The live notification of a chat at work, free of Android (KeepAliveService.java draws it; lib/notes.ts
 * `livePayload` sends it), so every rule can be tested:
 *
 * - The turn as the phone reads it (`turnLive`): its steps, the checkpoints closed so far (a run of
 *   work closed by something in view, as the conversation reads them, lib/turns.ts), the open
 *   checkpoint's steps and when it began, the files its settled edits changed, and what it does now.
 * - What it does now names the KIND of step, never its content (`doingLine`): "Editing 3 files",
 *   "Running a command", "Searching the code", "Thinking", "Writing". From the chat's own activity
 *   line when the phone does not have the conversation (`activityLine`): its first verb only, so a
 *   file name, a command or a search term never reaches the shade or the lock screen.
 * - One card per chat at work (`liveCard`): the chat's name and agent, the line, the turn's clock, the
 *   checkpoint's steps and a segment per checkpoint closed, the other chats at work or waiting, and
 *   which keys the card may carry (`cardKeys`): Open always, Stop only while the chat's own turn runs
 *   (a sub-agent or a command left running is stopped from the chat). Allow once and Deny never ride
 *   on a live card: a chat that waits leaves the live set and its waiting notification takes the
 *   card's place (lib/notes.ts `noteAsk` decides when those keys are safe).
 * - When the turn ends the same notification becomes its result (`resultLine`: "Finished · 3 files
 *   changed"), not ongoing any more; a chat that only serves a local address is at rest
 *   (`SessionMeta.serving` is no work, shared/work-label.ts), so its card goes.
 */

/** What a chat does now, by kind of step. */
export type Doing =
  | { kind: 'edit' | 'read'; files: number }
  | { kind: 'agents' | 'commands'; count: number }
  | { kind: 'command' | 'search' | 'web' | 'browser' | 'device' | 'tool' | 'plan' | 'tasks' | 'share' | 'widget' | 'thinking' | 'writing' | 'waiting' | 'starting' | 'stopping' | 'compacting' | 'working' };

/** The running turn as the live card reads it. */
export interface TurnLive {
  /** Tool calls in the turn so far (sub-agents' own steps not counted, as the "Worked" line counts). */
  steps: number;
  /** Checkpoints closed: runs of work, each closed by something in view (a note, a widget, files, a plan, an error). */
  done: number;
  /** Steps of the open checkpoint (the live line's run). */
  cpSteps: number;
  /** When the open checkpoint began (its first item), or when the newest closed one ended. */
  at?: number;
  /** When the turn began (its message, or its first item when the agent began by itself). */
  startedAt?: number;
  /** Files the turn's settled edits changed so far (sub-agents' edits included). */
  files: number;
  doing: Doing;
}

type Page = { roots: readonly string[]; items: Readonly<Record<string, TimelineItem | undefined>>; children?: Readonly<Record<string, string[] | undefined>>; cursor?: string };

/** A message that begins a turn (not a queued one, not a steer, not a notification Claude Code wrote): turnSteps' own rule. */
const opensTurn = (it: TimelineItem) => {
  if (it.type !== 'user' || it.state === 'queued' || it.steered) return false;
  const syn = syntheticOf(it);
  return !syn || syn.role === 'command' || !!it.until;
};

export function doingOf({ doing, doingCount = 1 }: BridgeTurnLive): Doing {
  switch (doing) {
    case 'write':
    case 'edit':
      return { kind: 'edit', files: doingCount };
    case 'read':
      return { kind: 'read', files: doingCount };
    case 'bash':
      return doingCount > 1 ? { kind: 'commands', count: doingCount } : { kind: 'command' };
    case 'agent':
      return { kind: 'agents', count: doingCount };
    case 'search':
    case 'glob':
      return { kind: 'search' };
    case 'fetch':
    case 'websearch':
      return { kind: 'web' };
    case 'todo':
      return { kind: 'tasks' };
    case 'mcp':
    case 'skill':
      return { kind: 'tool' };
    case 'browser':
    case 'device':
    case 'plan':
    case 'share':
    case 'widget':
    case 'waiting':
    case 'thinking':
    case 'writing':
      return { kind: doing };
    default:
      return { kind: 'working' };
  }
}

/** Read just the current turn. A partial page without its boundary has no reliable count. */
export function turnLive(page: Page): TurnLive | undefined {
  const { roots, items, children } = page;
  let start = roots.length - 1;
  while (start >= 0) {
    const it = items[roots[start]];
    if (it && (it.type === 'turn' || opensTurn(it))) break;
    start--;
  }
  if (start < 0 && page.cursor) return;

  // Include nested edits for the file count, in the same four agent levels as Changes.
  function* rows(ids: readonly string[], from: number, depth: number): Generator<TimelineItem> {
    for (let i = from; i < ids.length; i++) {
      const it = items[ids[i]];
      if (!it) continue;
      yield it;
      const kids = children?.[it.id];
      if (kids?.length && depth < 4 && it.type === 'tool' && it.kind === 'agent' && !it.check) {
        yield* rows(kids, 0, depth + 1);
      }
    }
  }
  const live = readTurn(rows(roots, Math.max(start, 0), 0));
  if (!live) return;
  return {
    steps: live.steps, done: live.checkpoints, cpSteps: live.checkpointSteps,
    ...(live.checkpointAt !== undefined && { at: live.checkpointAt }),
    startedAt: live.startedAt, files: live.files, doing: doingOf(live),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What it does now, in a few plain words: the kind of step, never its content. */
export function doingLine(d: Doing): string {
  switch (d.kind) {
    case 'edit':
      return `Editing ${plural(d.files, 'file')}`;
    case 'read':
      return `Reading ${plural(d.files, 'file')}`;
    case 'command':
      return 'Running a command';
    case 'commands':
      return `Running ${d.count} commands`;
    case 'agents':
      return d.count > 1 ? `Running ${d.count} sub-agents` : 'Running a sub-agent';
    case 'search':
      return 'Searching the code';
    case 'web':
      return 'Reading the web';
    case 'browser':
      return 'Using the browser';
    case 'device':
      return 'Using the device';
    case 'tool':
      return 'Using a tool';
    case 'plan':
      return 'Writing a plan';
    case 'tasks':
      return 'Updating its tasks';
    case 'share':
      return 'Handing over files';
    case 'widget':
      return 'Drawing a widget';
    case 'thinking':
      return 'Thinking';
    case 'writing':
      return 'Writing';
    case 'waiting':
      return 'Waiting for you';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    case 'compacting':
      return 'Compacting';
    default:
      return 'Working';
  }
}

/** The chat's own activity line, read by its first verb only (the bridge's line names files, commands and search terms). */
const ACTIVITY: readonly (readonly [RegExp, Doing])[] = [
  [/^waiting for (your )?approval\b/i, { kind: 'waiting' }],
  [/^(edit|editing|write|writing to|update|updating|create|creating|apply|applying|patch|patching|delete|deleting|rename|renaming)\b/i, { kind: 'edit', files: 1 }],
  [/^(read|reading|view|viewing|open|opening)\b/i, { kind: 'read', files: 1 }],
  [/^(run|running|re-running|rerunning|execute|executing|type-checking|testing|building|installing)\b/i, { kind: 'command' }],
  [/^(search|searching|find|finding|grep|grepping|glob|list|listing|look for|looking for)\b/i, { kind: 'search' }],
  [/^(fetch|fetching|browse|browsing|visit|visiting|search the web|web search)\b/i, { kind: 'web' }],
  [/^thinking\b/i, { kind: 'thinking' }],
  [/^writing$/i, { kind: 'writing' }],
  [/^starting\b/i, { kind: 'starting' }],
  [/^stopping\b/i, { kind: 'stopping' }],
  [/^compacting\b/i, { kind: 'compacting' }],
];

/** What the activity line says it does, as a kind (null: nothing known, the card says "Working"). */
export function activityDoing(activity: string | undefined): Doing | null {
  const a = activity?.trim().replace(/^[`*_"“]+/, '');
  if (!a) return null;
  // "Search the web for …" is the web, not the code: the longer verb first.
  if (/^(search the web|web search)\b/i.test(a)) return { kind: 'web' };
  for (const [re, d] of ACTIVITY) if (re.test(a)) return d;
  return null;
}

/** The activity line as the live card says it: its verb only ("Editing", "Running a command"). */
export function activityLine(activity: string | undefined, fallback = 'Working'): string {
  const d = activityDoing(activity);
  if (!d) return fallback;
  if (d.kind === 'edit') return 'Editing';
  if (d.kind === 'read') return 'Reading';
  return doingLine(d);
}

/** "2 other chats working · 1 waiting": the rest of the live set, from one card's view. */
export function othersLine(otherWorking: number, waiting: number): string {
  const parts: string[] = [];
  if (otherWorking > 0) parts.push(`${otherWorking} other ${otherWorking === 1 ? 'chat' : 'chats'} working`);
  if (waiting > 0) parts.push(otherWorking > 0 ? `${waiting} waiting` : `${plural(waiting, 'chat')} waiting for you`);
  return parts.join(' · ');
}

/** The checkpoint as the card's meta line says it: "Checkpoint 3 · 5 steps", "12 steps" before any closed. */
export function checkpointLine(t: Pick<TurnLive, 'done' | 'cpSteps' | 'steps'> | undefined): string {
  if (!t) return '';
  if (t.done === 0) return t.steps ? plural(t.steps, 'step') : '';
  return [`Checkpoint ${t.done + 1}`, t.cpSteps ? plural(t.cpSteps, 'step') : ''].filter(Boolean).join(' · ');
}

/** What the finished turn's notification says in its header: "Finished · 3 files changed". */
export function resultLine(kind: 'done' | 'failed', files: number): string {
  const head = kind === 'failed' ? 'Stopped' : 'Finished';
  return files > 0 ? `${head} · ${plural(files, 'file')} changed` : head;
}

/** The keys a live card may carry. Answers to a permission never ride on it (the waiting notification takes its place). */
export function cardKeys(s: Pick<SessionMeta, 'status'>): ('open' | 'stop')[] {
  return s.status === 'running' || s.status === 'starting' ? ['open', 'stop'] : ['open'];
}

/**
 * Stop now, confirmed on a live card: the chat is stopped only if its own turn still runs (as the card
 * offered it) on a live connection; anything else (it ended, it waits on the person, an unknown chat)
 * stops nothing. The desktop answers `session.interrupt` as the chat's own Stop.
 */
export function noteStop(sessionId: unknown, sessions: Readonly<Record<string, Pick<SessionMeta, 'status'> | undefined>>, live: boolean): { sessionId: string } | null {
  if (!live || typeof sessionId !== 'string' || !sessionId) return null;
  const s = sessions[sessionId];
  return s && cardKeys(s).includes('stop') ? { sessionId } : null;
}

/** At most this many checkpoint segments are drawn; older ones merge into the first. */
export const SEGMENTS_MAX = 10;

/** One chat's live card, as KeepAliveService draws it. */
export interface LiveCard {
  /** The chat's id (its notification's id is reckoned from it, as lib/native.ts reckons it). */
  id: string;
  title: string;
  agent?: ProviderId;
  /** What it does now (the kind of step) or what still works ("2 sub-agents working"). */
  line: string;
  /** When the phone first saw this work (the chip's and the header's clock). */
  since: number;
  /** When the open checkpoint began. */
  at?: number;
  /** "Checkpoint 3 · 5 steps" (empty before anything is known). */
  meta: string;
  /** Steps in the turn (the small icon lights a cell per step). */
  steps: number;
  /** Checkpoints closed (a filled segment each, at most SEGMENTS_MAX). */
  done: number;
  /** Files changed so far. */
  files: number;
  /** The other chats at work or waiting. */
  others: string;
  keys: ('open' | 'stop')[];
  /** What the notification says once the turn ends, by how it ended. */
  result: { done: string; failed: string };
}

export interface CardChat {
  id: string;
  title: string;
  line: string;
  since: number;
  /** Steps of its turn, when only their count is known. */
  steps?: number;
  turn?: TurnLive;
}

/** The card for `chat`, one of `working` chats at work, with `waiting` chats waiting on the person. */
export function liveCard(chat: CardChat, meta: Pick<SessionMeta, 'status' | 'provider'> | undefined, working: number, waiting: number): LiveCard {
  const t = chat.turn;
  const files = t?.files ?? 0;
  return {
    id: chat.id,
    title: chat.title,
    ...(meta?.provider ? { agent: meta.provider } : {}),
    line: chat.line,
    since: chat.since,
    ...(t?.at ? { at: t.at } : {}),
    meta: t ? checkpointLine(t) : chat.steps ? plural(chat.steps, 'step') : '',
    steps: t?.steps ?? chat.steps ?? 0,
    done: Math.min(t?.done ?? 0, SEGMENTS_MAX),
    files,
    others: othersLine(Math.max(0, working - 1), waiting),
    keys: meta ? cardKeys(meta) : ['open'],
    result: { done: resultLine('done', files), failed: resultLine('failed', files) },
  };
}
