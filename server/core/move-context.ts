import type { TimelineItem, Todo, ToolItem, UserItem } from '../../shared/protocol';
import { parseSynthetic, stripWrappers } from '../../shared/synthetic';

/**
 * What a chat's context does when it changes account (`session.switchAccount`, a move at a cap or
 * a limit). Pure helpers: when a chat is big enough to compact on the account it leaves, the switch
 * line that says what the move did, and the short note the agent gets with the first message after
 * a move.
 *
 * Why compact first: a carried conversation is read again in full by the new account, with nothing
 * in its prompt cache. On the account it leaves the cache is warm, so a compaction there costs a
 * fraction of one uncached read, and the new account starts from the summary. Below the threshold
 * the re-read is cheap enough that a compaction (a turn of its own, and a summary that loses detail)
 * is not worth it.
 */

/**
 * The context above which a chat compacts before it moves: 150k tokens, or 40% of the model's
 * window when that is smaller. 150k uncached is roughly what a whole 5-hour window of a Pro plan
 * spends on a few turns; on a 1M window a chat of 740k would otherwise be read again at full price
 * on the first message, and again at every later move. 40% keeps small windows (200k) from moving
 * a chat that is about to hit their own automatic compaction.
 */
export const COMPACT_BEFORE_MOVE = 150_000;
export const COMPACT_SHARE = 0.4;

export function compactThreshold(window: number | undefined): number {
  return window && window > 0 ? Math.min(COMPACT_BEFORE_MOVE, Math.round(window * COMPACT_SHARE)) : COMPACT_BEFORE_MOVE;
}

/** Whether a chat of `tokens` in a `window` is big: it compacts before a move, or the line says it is read again. */
export function bigContext(tokens: number | undefined, window: number | undefined): boolean {
  return !!tokens && tokens >= compactThreshold(window);
}

/** How long a compaction before a move may take before the chat moves as it is. */
export const COMPACT_TIMEOUT_MS = 4 * 60_000;

/**
 * The message that opens the compaction turn in the timeline: hidden there (a `<system-reminder>`
 * only, shared/synthetic.ts), while the agent gets its own `/compact`.
 */
export const COMPACT_OPENER = '<system-reminder>\nSable compacts this conversation before it moves to another account.\n</system-reminder>';

/** Tokens the way the context ring says them: 740k, 1.2M, 38k, 900. */
export function shortTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 9_950_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export type MoveOutcome =
  /** Compacted on the old account, then carried. */
  | { kind: 'compacted'; before: number; after?: number }
  /** A compaction was tried and did not finish (failed, stopped, timed out): carried as it is. */
  | { kind: 'notCompacted'; tokens: number }
  /** Too big to carry cheaply, but the old account could not run a turn (at its limit): carried as it is. */
  | { kind: 'asIs'; tokens: number }
  /** Small, or a new conversation with a summary: nothing to say about the context. */
  | { kind: 'plain' };

/**
 * The switch line's context clause. On the line itself after a compaction ("· context 740k → 38k");
 * as its detail when the next message reads the whole conversation again.
 */
export function contextClause(o: MoveOutcome, retry = false): { suffix?: string; detail?: string } {
  const again = retry ? 'Carrying on reads' : 'The next message reads';
  switch (o.kind) {
    case 'compacted':
      return o.after !== undefined && o.after < o.before ? { suffix: ` · context ${shortTokens(o.before)} → ${shortTokens(o.after)}` } : { suffix: ' · context compacted' };
    case 'notCompacted':
      return { detail: `Could not compact first, so ${again.charAt(0).toLowerCase()}${again.slice(1)} all ${shortTokens(o.tokens)} tokens again` };
    case 'asIs':
      return { detail: `${again} all ${shortTokens(o.tokens)} tokens again` };
    default:
      return {};
  }
}

/** At most this many lost commands are named on a switch line; the rest are counted. */
const LOST_NAMED = 8;

/**
 * What a move did to the background commands and monitors that ran in the process it closed
 * (`SessionRuntime.tasksLost`): a clause for the switch line (" · 1 background command lost") and
 * the detail that names them. Lost, never ended: a child of the agent's shell can outlive it.
 */
export function lostClause(names: readonly string[]): { suffix?: string; detail?: string; names?: string } {
  const n = names.length;
  if (!n) return {};
  const shown = `${names.slice(0, LOST_NAMED).join('; ')}${n > LOST_NAMED ? ` and ${n - LOST_NAMED} more` : ''}`;
  return { suffix: ` · ${n === 1 ? '1 background command' : `${n} background commands`} lost`, detail: `Lost when the chat moved: ${shown}`, names: shown };
}

// ── the note after a move ──

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The person's own words in a message (none for what a harness wrote in their place, or an /until round). */
export function personWords(it: TimelineItem): string {
  if (it.type !== 'user' || it.parentId || (it as UserItem).until) return '';
  if (parseSynthetic(it.text)) return '';
  return stripWrappers(it.text).trim();
}

/** The person's last message that no reply of the agent's followed, or undefined. */
export function lastUnanswered(items: readonly TimelineItem[]): UserItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.parentId) continue;
    if (it.type === 'text' && it.text.trim()) return undefined;
    if (it.type === 'notice' && (it.early || it.variant === 'interrupted')) return undefined;
    if (it.type === 'user' && personWords(it)) return it;
  }
  return undefined;
}

/** The most the note quotes of the person's message, and of the todos (a few hundred tokens in all). */
const NOTE_QUOTE = 700;
const NOTE_TODOS = 8;
const NOTE_TODO = 90;

/**
 * The note the agent gets with the first message after a move to another account, after the
 * person's words (hidden in the conversation like any `<system-reminder>`). Bounded: at most about
 * 1,600 characters, whatever the chat holds. `skip`: the message about to go out (never quoted back).
 * `lost`: the same message names background tasks the move lost (shared/synthetic.ts
 * `lostTasksNote`), so the note does not say that nothing else changed.
 */
export function moveNote(items: readonly TimelineItem[], todos: readonly Todo[], opts: { skip?: string; lost?: boolean; wake?: string } = {}): string {
  const lines = [
    opts.lost || opts.wake
      ? 'This conversation moved to another account of the same person, in the same folder with the same files.'
      : 'This conversation moved to another account of the same person. Nothing else changed: the same folder, the same files.',
  ];
  if (opts.wake) lines.push(opts.wake);
  const waiting = lastUnanswered(items.filter((i) => i.id !== opts.skip));
  if (waiting) lines.push(`Their last message before the move has no answer yet: "${clip(personWords(waiting), NOTE_QUOTE)}"`);
  const open = todos.filter((t) => t.status !== 'completed');
  if (open.length) {
    const shown = open.slice(0, NOTE_TODOS).map((t) => `- ${clip(t.content, NOTE_TODO)}${t.status === 'in_progress' ? ' (in progress)' : ''}`);
    lines.push(`Open todos:\n${shown.join('\n')}${open.length > NOTE_TODOS ? `\n- and ${open.length - NOTE_TODOS} more` : ''}`);
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`;
}

/** Whether a message is a slash command (`/compact`, `/context`): nothing may be put before or after it. */
export const isSlashCommand = (text: string) => /^\/[\w:-]+(\s|$)/.test(text.trim());

// ── files changed, for a handover ──

const slash = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');

/** The files edit and write steps changed in `items` (sub-agents' too), relative to `cwd`, in the order first changed. */
export function changedFiles(items: readonly TimelineItem[], cwd: string): string[] {
  const root = slash(cwd).toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p) return;
    let n = slash(p);
    if (root && n.toLowerCase().startsWith(root + '/')) n = n.slice(root.length + 1);
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const it of items) {
    if (it.type !== 'tool') continue;
    const t = it as ToolItem;
    if ((t.kind !== 'edit' && t.kind !== 'write') || t.status !== 'done') continue;
    const diffs = t.result?.diff ?? [];
    if (diffs.length) for (const d of diffs) add(d.path);
    else add(t.detail?.path);
  }
  return out;
}
