import type { PermissionRequest, QuestionRequest, SessionMeta, TimelineItem } from '@shared/protocol';
import { hasWork, workLabel } from '@shared/work-label';
import { syntheticOf } from '@shared/synthetic';
import { permissionKeys, scopeOf } from './asks';
import { activityLine, doingLine, liveCard, type LiveCard, type TurnLive } from './note-live';

/**
 * What the phone's notifications say, free of Android (lib/native.ts posts them through
 * android/…/Notes.java), so every rule can be tested:
 *
 * - One notification per chat, its title the chat's name, its line what the chat needs (the
 *   permission's own title, "Run npm test", or a question's words; the header says "Waiting for you") or what the agent said last (its last note, markdown taken
 *   off and cut at a sentence or a word, never mid-word).
 * - Allow once and Deny ride on a permission's notification only when the notification itself shows
 *   all of what allowing reaches: the phone got the request whole (not `incomplete`), it asks for
 *   no change to show (a diff, files, a file's content), reaches nothing beyond its own detail
 *   (`scope`), offers a plain "allow" once and a "deny", and its lines fit the notification. Anything
 *   else opens the chat. The desktop checks the answer again (`phoneAllowed`).
 * - The live notification while chats work: who works, on what, since when, steps done (where the
 *   phone knows them), sub-agents and commands; nothing when nothing works.
 */

/** Markdown as one plain line: code fences, headings, emphasis, links and list marks taken off. */
export function plainLine(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A text cut cleanly to `max` characters: whole sentences when the first ones fit, else whole words
 * with an ellipsis; never a broken word or a dangling space.
 */
export function cutClean(text: string, max = 160): string {
  const t = text.trim();
  if (t.length <= max) return t;
  // Whole sentences, as many as fit (only if that keeps at least a third of the room).
  const sentences = t.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (sentences) {
    let out = '';
    for (const s of sentences) {
      if ((out + s).trim().length > max) break;
      out += s;
    }
    if (out.trim().length >= max / 3) return out.trim();
  }
  const room = t.slice(0, max);
  const space = room.lastIndexOf(' ');
  const words = (space > max / 2 ? room.slice(0, space) : room.slice(0, max - 1)).replace(/[\s,;:.\-–]+$/, '');
  return `${words}…`;
}

/** The agent's last note in a page of the conversation: its newest text that says something, as a clean line. */
export function lastNote(items: readonly TimelineItem[], max = 160): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'user') return null; // nothing said since the person's message
    if (it.type !== 'text' || it.parentId) continue;
    // Its prose: a heading or a code block alone says less than the sentences under it.
    const prose = it.text.split(/\n\s*\n/).filter((p) => !/^\s{0,3}(#{1,6}\s|```|\|)/.test(p));
    const line = plainLine(prose.join('\n\n') || it.text);
    if (line) return cutClean(line, max);
  }
  return null;
}

/** What a notification's Allow once and Deny answer, and the lines that show what allowing reaches. */
export interface NoteAsk {
  requestId: string;
  allow: string;
  deny: string;
  /** The whole request as the notification shows it, one fact a line. */
  detail: string;
}

/** How long a request may be to be answered from its notification: lines, characters a line, characters in all. */
export const ASK_FIT = { lines: 4, line: 200, total: 420 };

const reaches = (req: PermissionRequest) => {
  const sc = req.scope as Record<string, unknown> | undefined;
  if (!sc) return false;
  return Object.values(sc).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
};

/** Allow once and Deny for a permission, or null when only the chat itself may answer it (see above). */
export function noteAsk(req: PermissionRequest): NoteAsk | null {
  const { grants, denials, desktopOnly } = permissionKeys(req);
  if (desktopOnly) return null;
  // The 'allow' tone also covers whole-turn grants and plan approvals.
  const allow = grants.find((o) => o.tone === 'allow' && o.label === 'Allow once');
  const deny = denials.find((o) => o.label === 'Deny' || o.label === 'Decline');
  if (!allow || !deny) return null;
  const d = req.detail ?? {};
  if (req.diff?.length || reaches(req) || Object.keys(d).some((key) => !['command', 'cwd', 'path', 'description'].includes(key))) return null;
  const scope = scopeOf(req);
  const lines = [req.title.trim()];
  if (typeof d.command === 'string' && d.command.trim() && d.command.trim() !== req.title.trim()) lines.push(d.command.trim());
  if (scope.path) lines.push(scope.path);
  if (scope.cwd) lines.push(`in ${scope.cwd}`);
  for (const text of [d.description, req.description, req.reason, allow.hint, deny.hint]) {
    if (text?.trim() && !lines.includes(text.trim())) lines.push(text.trim());
  }
  if (lines.some((l) => !l || l.length > ASK_FIT.line || /[\x00-\x1f\x7f\u2028-\u202e\u2066-\u2069]/u.test(l)) || lines.length > ASK_FIT.lines) return null;
  const detail = lines.join('\n');
  if (detail.length > ASK_FIT.total) return null;
  return { requestId: req.id, allow: allow.id, deny: deny.id, detail };
}

/** What a waiting chat needs, as its notification says it, and the answer keys where they are safe. */
export function waitingNote(sessionId: string, pending: { permissions: PermissionRequest[]; questions: QuestionRequest[] }): { text: string; ask?: NoteAsk } {
  const perms = pending.permissions.filter((p) => p.sessionId === sessionId);
  const qs = pending.questions.filter((q) => q.sessionId === sessionId);
  const more = perms.length + qs.length > 1 ? ` (${perms.length + qs.length} waiting)` : '';
  const perm = perms[0];
  if (perm) {
    const ask = perms.length === 1 && !qs.length ? noteAsk(perm) : null;
    return { text: cutClean(plainLine(perm.title), 120) + more, ...(ask ? { ask } : {}) };
  }
  const q = qs[0]?.questions[0];
  if (q) return { text: cutClean(plainLine(q.question), 140) + more };
  return { text: 'Waiting for you' };
}

export interface NoteAction {
  noteId: number;
  token: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  optionId: string;
  detail: string;
  verb: 'allow' | 'deny';
}

/** Only the request, scope and answer actually displayed may go over the current connection. */
export function noteAnswer(action: NoteAction, pending: { permissions: PermissionRequest[]; questions: QuestionRequest[] }, deviceId?: string) {
  if (!deviceId || action.deviceId !== deviceId) return null;
  const ask = waitingNote(action.sessionId, pending).ask;
  if (!ask || ask.requestId !== action.requestId || ask.detail !== action.detail || ask[action.verb] !== action.optionId) return null;
  return { sessionId: action.sessionId, requestId: action.requestId, optionId: action.optionId };
}

/** One chat in the live notification. */
export interface LiveChat {
  id: string;
  title: string;
  /** What it does now, by kind of step ("Editing 3 files", lib/note-live.ts), else what still works ("2 sub-agents working"). */
  line: string;
  /** When the phone first saw it at work (ms). */
  since: number;
  /** Steps of its current turn, when the phone has the conversation. */
  steps?: number;
  /** Its running turn as the phone reads it (checkpoints, files, what it does), when the phone has the conversation. */
  turn?: TurnLive;
}

/** Chats currently at work, ordered by when the phone first observed their work. */
export interface Live {
  chats: LiveChat[];
  /** Chats waiting on the person (the connection stays for their answers). */
  waiting: number;
  /** The chats' own lists' entries, for the cards (agent, whether the turn can be stopped). */
  metas?: Readonly<Record<string, Pick<SessionMeta, 'status' | 'provider'>>>;
}

type StepPage = { roots: readonly string[]; items: Readonly<Record<string, TimelineItem>>; cursor?: string };

/** Scan back to the turn's start or the previous footer. A steer or queue entry belongs to this turn. */
export function turnSteps(roots: readonly (TimelineItem | undefined)[]): number;
export function turnSteps(page: StepPage): number | undefined;
export function turnSteps(data: readonly (TimelineItem | undefined)[] | StepPage): number | undefined {
  let n = 0;
  const length = 'roots' in data ? data.roots.length : data.length;
  for (let i = length - 1; i >= 0; i--) {
    const it = 'roots' in data ? data.items[data.roots[i]] : data[i];
    if (!it) continue;
    if (it.type === 'turn') return n;
    if (it.type === 'user' && it.state !== 'queued' && !it.steered) {
      const syn = syntheticOf(it);
      if (!syn || syn.role === 'command' || it.until) return n;
    }
    if (it.type === 'tool') n++;
  }
  return 'roots' in data && data.cursor ? undefined : n;
}

// The bridge reports idle first, then patches the loop to checking, paused or cleared.
const betweenLoopTurns = (s: SessionMeta) => s.status === 'idle' && s.until?.phase === 'working';

/**
 * The live state from the chats' list: every chat at work (its own turn or its sub-agents and
 * commands), keeping the clock of each chat that was also working in the previous observation.
 */
export function liveOf(
  sessions: readonly SessionMeta[],
  previous: readonly LiveChat[],
  now: number,
  steps: (id: string) => number | TurnLive | undefined = () => undefined,
): Live {
  const chats: LiveChat[] = [];
  const metas: Record<string, Pick<SessionMeta, 'status' | 'provider'>> = {};
  const seen = new Map(previous.map((chat) => [chat.id, chat.since]));
  const lastTurn = new Map(previous.flatMap((chat) => (chat.turn ? [[chat.id, chat.turn] as const] : [])));
  let waiting = 0;
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.status === 'awaiting') waiting++;
    const own = s.status === 'running' || s.status === 'starting';
    const between = seen.has(s.id) && betweenLoopTurns(s);
    // A chat that only serves a local address is at rest (`serving` is no work: shared/work-label.ts).
    if (!own && !hasWork(s) && !between) continue;
    const work = workLabel(s);
    const got = own ? steps(s.id) : undefined;
    // A reading that is gone keeps the last one: the turn's end item lands a moment before the chat
    // says it is idle, and that moment's card is the one the result ("Finished · 3 files changed") reads.
    const turn = typeof got === 'object' ? got : got === undefined && own ? lastTurn.get(s.id) : undefined;
    const n = typeof got === 'number' ? got : turn?.steps;
    // What it does: the kind of step, never its content (a file name, a command or a search term).
    const fromItems = turn && turn.doing.kind !== 'working' ? doingLine(turn.doing) : undefined;
    const line = own ? (fromItems ?? activityLine(s.activity, s.status === 'starting' ? 'Starting' : 'Working')) : (work ?? 'Between turns');
    chats.push({ id: s.id, title: s.title?.trim() || 'Chat', line, since: seen.get(s.id) ?? now, ...(n ? { steps: n } : {}), ...(turn ? { turn } : {}) });
    metas[s.id] = { status: s.status, provider: s.provider };
  }
  chats.sort((a, b) => a.since - b.since);
  return { chats, waiting, metas };
}

/** The live notification's words: title, line and the short sub-line, for one chat or several. */
export function liveWords(live: Live): { title: string; text: string; sub?: string } | null {
  const [first, ...rest] = live.chats;
  if (!first) return null;
  const steps = (c: LiveChat) => (c.steps ? `${c.steps} ${c.steps === 1 ? 'step' : 'steps'}` : '');
  if (!rest.length) {
    const sub = [steps(first), live.waiting ? `${live.waiting} waiting` : ''].filter(Boolean).join(' · ');
    return { title: first.title, text: first.line, ...(sub ? { sub } : {}) };
  }
  const n = live.chats.length;
  const text = live.chats.map((c) => `${c.title}: ${c.line}`).join('\n');
  return { title: `${n} chats working`, text, ...(live.waiting ? { sub: `${live.waiting} waiting` } : {}) };
}

export interface LiveSpec {
  chats: number;
  waiting: number;
  title?: string;
  text?: string;
  sub?: string;
  since?: number;
  chat?: string;
  /** One card per chat at work, oldest work first (lib/note-live.ts `liveCard`): Android draws each as a notification of its own. */
  cards?: LiveCard[];
  /**
   * The connection was lost at this time (ms) while chats worked or waited: no cards (what they said
   * may no longer be so), the line says it reconnects, and Android keeps the connection and the page
   * awake to hear the end, for `LIVE_LOST_MS` at most (KeepAliveService).
   */
  lost?: number;
}

type LiveSettings = { notify?: boolean; fresh?: boolean; conn: string; listAt?: number };
export const liveEnabled = (s: LiveSettings) => !!s.notify && !!s.fresh && s.conn === 'open' && s.listAt !== undefined;

/** The payload Android should retain, independent of page visibility and notification permission dialogs. */
export function livePayload(settings: LiveSettings, live: Live): LiveSpec | null {
  const chats = live.chats.length;
  if (!liveEnabled(settings) || (!chats && !live.waiting)) return null;
  const words = liveWords(live);
  return {
    chats, waiting: live.waiting,
    ...(words && { ...words, since: live.chats[0].since }),
    ...(chats === 1 && { chat: live.chats[0].id }),
    ...(chats > 0 && { cards: live.chats.slice(0, CARDS_MAX).map((c) => liveCard(c, live.metas?.[c.id], chats, live.waiting)) }),
  };
}

/** At most this many chats get a card of their own (the summary names them all). */
export const CARDS_MAX = 6;

/** How long a connection lost while chats worked is tried again with the app off screen (KeepAliveService's LOST_MS, the same). */
export const LIVE_LOST_MS = 10 * 60_000;

/** What the live notification was last told, across a lost connection (lib/store.ts `watchLive`). */
export interface LiveTrack {
  /** The last word with the connection open had work or a chat waiting. */
  worked: boolean;
  /** When the connection went while it had (0: it has not). */
  lostAt: number;
}

/**
 * What Android is told now. With the connection open and the list read: the work (`livePayload`).
 * With it lost while something worked or waited (the socket died, the desktop slept, the moment
 * between a new socket and its list): `{ lost }`, the time it went: the cards go (never a stale
 * "Working"), and Android keeps the connection and the page awake to hear how it ended, for
 * `LIVE_LOST_MS` from that time (its own clock: KeepAliveService then leaves one quiet line saying
 * it is not connected). Otherwise (nothing worked, notifications off, the phone removed or
 * forgotten): nothing, and a stop.
 */
export function liveStep(settings: LiveSettings, live: Live, track: LiveTrack, now: number): { spec: LiveSpec | null; stop: boolean; track: LiveTrack } {
  if (liveEnabled(settings)) {
    const spec = livePayload(settings, live);
    return { spec, stop: false, track: { worked: !!spec, lostAt: 0 } };
  }
  const trying = !!settings.notify && settings.conn !== 'unpaired' && settings.conn !== 'denied';
  if (track.worked && trying) {
    const lostAt = track.lostAt || now;
    return { spec: { chats: 0, waiting: 0, lost: lostAt }, stop: false, track: { worked: true, lostAt } };
  }
  return { spec: null, stop: true, track: { worked: false, lostAt: 0 } };
}

/** Done only when the turn and the work it left running have both ended. */
export function workEnded(previous: SessionMeta, current: SessionMeta): boolean {
  return (previous.status === 'running' || previous.status === 'starting' || previous.status === 'awaiting' || hasWork(previous) || betweenLoopTurns(previous))
    && (current.status === 'idle' || current.status === 'error') && !hasWork(current) && !betweenLoopTurns(current);
}
