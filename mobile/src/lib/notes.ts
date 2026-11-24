import type { PermissionRequest, QuestionRequest, SessionMeta, TimelineItem } from '@shared/protocol';
import { hasWork, workLabel } from '@shared/work-label';
import { syntheticOf } from '@shared/synthetic';
import { permissionKeys, scopeOf } from './asks';

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
  /** What it does now ("Editing session.ts"), else what still works ("2 sub-agents working"). */
  line: string;
  /** When the phone first saw it at work (ms). */
  since: number;
  /** Steps of its current turn, when the phone has the conversation. */
  steps?: number;
}

/** Chats currently at work, ordered by when the phone first observed their work. */
export interface Live {
  chats: LiveChat[];
  /** Chats waiting on the person (the connection stays for their answers). */
  waiting: number;
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
  steps: (id: string) => number | undefined = () => undefined,
): Live {
  const chats: LiveChat[] = [];
  const seen = new Map(previous.map((chat) => [chat.id, chat.since]));
  let waiting = 0;
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.status === 'awaiting') waiting++;
    const own = s.status === 'running' || s.status === 'starting';
    const between = seen.has(s.id) && betweenLoopTurns(s);
    if (!own && !hasWork(s) && !between) continue;
    const work = workLabel(s);
    const line = own ? (s.activity?.trim() ? cutClean(plainLine(s.activity), 80) : s.status === 'starting' ? 'Starting' : 'Working') : (work ?? 'Between turns');
    const n = own ? steps(s.id) : undefined;
    chats.push({ id: s.id, title: s.title?.trim() || 'Chat', line, since: seen.get(s.id) ?? now, ...(n ? { steps: n } : {}) });
  }
  chats.sort((a, b) => a.since - b.since);
  return { chats, waiting };
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
  };
}

/** Done only when the turn and the work it left running have both ended. */
export function workEnded(previous: SessionMeta, current: SessionMeta): boolean {
  return (previous.status === 'running' || previous.status === 'starting' || previous.status === 'awaiting' || hasWork(previous) || betweenLoopTurns(previous))
    && (current.status === 'idle' || current.status === 'error') && !hasWork(current) && !betweenLoopTurns(current);
}
