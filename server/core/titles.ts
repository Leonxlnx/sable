/**
 * Chat titles by a small model. After a chat's first turn settles, a cheap model of the chat's own
 * agent, on the chat's own account (Claude Code's Haiku, Codex's smallest model), is asked once for
 * a short title from the message that turn answered and the start of its answer, and it replaces the
 * title Sable made from the message. A chat's words never go to another agent or another account:
 * an agent without a small model leaves the title as it is. In the background and one at a time:
 * never in the chat's way. A title the person set is never changed, nor one that changed while the
 * model was asked. `AppSettings.chatTitles` (absent: on).
 */
import { DEFAULT_ACCOUNT, type AppSettings, type ProviderId, type SessionMeta, type TextItem, type TimelineItem, type TurnItem, type UserItem } from '../../shared/protocol';
import { parseSynthetic, userText } from '../../shared/synthetic';
import type { SessionRuntime } from './runtime';

/** What the small model gets: its instructions and one message. */
export interface TitlePrompt {
  system: string;
  user: string;
  /** The chat's folder (a one-shot agent runs there; it reads nothing of it). */
  cwd: string;
}

/** Asks a model for a title: its raw answer, or null when it gave none. */
export type TitleModel = (prompt: TitlePrompt, signal: AbortSignal) => Promise<string | null>;

/** Whose small model names a chat: the chat's own agent and account, nobody else's. */
export interface TitleOwner {
  provider: ProviderId;
  accountId: string;
}

/** The person's message as the model sees it: its start is what names a chat. */
const MESSAGE_CHARS = 2000;
/** The start of the answer: enough to tell what the chat became. */
const ANSWER_CHARS = 800;
/** A title is short; anything much longer is not one (the model answered the message instead). */
const MAX_WORDS = 9;
const MAX_CHARS = 80;
/** How long one title may take before it is given up (the chat keeps the title it has). */
export const TITLE_TIMEOUT_MS = 45_000;

export const TITLE_SYSTEM = [
  'You name chats between a person and a coding agent.',
  'Reply with the title only: 3 to 6 words, sentence case, no quotes, no trailing period, no emoji.',
  'Write it in the language of the person\'s message.',
  'Name the subject or the task, not the person and not the agent.',
].join(' ');

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);

/** A command (`/cost`, `/context`, `/compact`, a skill's `/name`): it names no subject, and a local one's output is no answer. */
const COMMAND = /^\/[\w:.-]+(\s|$)/;

/** A message of the person's that can name a chat: their own words at the root, sent, not a command, not what a harness or an until loop wrote. */
export function titleMessage(it: TimelineItem | undefined): it is UserItem {
  if (!it || it.type !== 'user' || it.parentId || it.until || it.state === 'queued') return false;
  if (parseSynthetic(it.text)) return false;
  const text = userText(it.text).trim();
  return !!text && !COMMAND.test(text);
}

/**
 * The message a chat is named from and the start of the answer to it (root items only); null when
 * there is none. `consumed`: the messages the turn that just settled took (the bridge's own record
 * of what it handed to the agent): the first of them that is the person's own words. A message that
 * was stopped before the agent had it, or one of a turn that failed or was stopped, is never among
 * them. Without `consumed`, the first message of the person's in the timeline.
 */
export function titleAsk(items: readonly TimelineItem[], consumed?: readonly string[]): { message: string; answer: string; itemId: string } | null {
  let at = -1;
  if (consumed) {
    const ids = new Set(consumed);
    at = items.findIndex((i) => ids.has(i.id) && titleMessage(i));
  } else at = items.findIndex((i) => titleMessage(i));
  if (at < 0) return null;
  const msg = items[at] as UserItem;
  const message = userText(msg.text).trim();
  const answer: string[] = [];
  for (const it of items.slice(at + 1)) {
    if (it.parentId) continue;
    // The answer is this turn's: it ends at the turn's end or the next message of the person's.
    if (it.type === 'turn') break;
    if (it.type === 'user' && !parseSynthetic((it as UserItem).text)) break;
    if (it.type === 'text' && (it as TextItem).text.trim()) answer.push((it as TextItem).text.trim());
    if (answer.join('\n\n').length > ANSWER_CHARS) break;
  }
  return { message, answer: answer.join('\n\n'), itemId: msg.id };
}

/** The prompt for one chat. */
export function titlePrompt(ask: { message: string; answer: string }, cwd: string): TitlePrompt {
  const parts = ['The person\'s first message:', '<message>', cut(ask.message, MESSAGE_CHARS), '</message>'];
  if (ask.answer) parts.push('', 'The start of the answer:', '<answer>', cut(ask.answer, ANSWER_CHARS), '</answer>');
  parts.push('', 'The title:');
  return { system: TITLE_SYSTEM, user: parts.join('\n'), cwd };
}

const QUOTES = /^["'`“”„«»‘’‚‹›「」『』]+|["'`“”„«»‘’‚‹›「」『』]+$/g;
const NOT_A_TITLE = /^(i('m| am)? (can(no|')t|cannot|won't|am unable)|sorry\b|as an ai\b|here('s| is) (a|the) title)/i;

/**
 * The model's answer as a title: its first line, without a "Title:" lead, quotes, markdown or a
 * trailing period, the first letter capitalised. Null when it is no title (empty, a sentence, a refusal).
 */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  let t = line
    .replace(/^#+\s*/, '')
    .replace(/^(\*\*|__)?\s*(chat\s+)?title\s*(\*\*|__)?\s*[:：]\s*/i, '')
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim();
  // No trailing period (nor colon, comma, ellipsis): a question mark may stay.
  t = t.replace(/[\s.。:;,，…!！]+$/u, '').replace(QUOTES, '').trim();
  if (!t || NOT_A_TITLE.test(t)) return null;
  if (t.length > MAX_CHARS || t.split(' ').length > MAX_WORDS) return null;
  return t.charAt(0).toLocaleUpperCase() + t.slice(1);
}

/** A turn that settled: it ended without an error and was not stopped. */
const settledTurn = (i: TimelineItem): i is TurnItem => i.type === 'turn' && !i.parentId && !(i as TurnItem).error && (i as TurnItem).stopReason !== 'interrupted';

/**
 * Whether this chat gets its title from the small model now: once, after its first turn that settled
 * with a message of the person's before it (a turn that only ran a command, as `/cost`, names nothing;
 * a message whose turn failed waits for the turn that settles).
 */
export function wantsTitle(meta: SessionMeta, items: readonly TimelineItem[], settings: Pick<AppSettings, 'chatTitles'>): boolean {
  if (settings.chatTitles === false) return false;
  // Never a title the person gave (sub-agents' titles count as given), never twice.
  if (meta.titleSource !== 'auto' || meta.titleAsked) return false;
  // A race's two chats keep the task's name, alike.
  if (meta.race) return false;
  let named = 0;
  let said = false;
  let last: 'named' | 'other' | undefined;
  for (const it of items) {
    if (it.parentId) continue;
    if (titleMessage(it)) said = true;
    else if (it.type === 'turn') {
      if (!settledTurn(it)) last = 'other';
      else if (said) {
        named++;
        said = false;
        last = 'named';
      } else last = 'other';
    }
  }
  return named === 1 && last === 'named';
}

export interface TitleDeps {
  settings(): Pick<AppSettings, 'chatTitles'>;
  /** The small model of exactly this agent and account (its own smallest), or none: never another's. */
  model(owner: TitleOwner): TitleModel | undefined;
  /** The chat is still open in this bridge. */
  open(rt: SessionRuntime): boolean;
  log(...args: unknown[]): void;
}

/** A title asked for, with what it was asked under: checked again right before the model is asked and before the title is written. */
interface Asked {
  rt: SessionRuntime;
  owner: TitleOwner;
  /** The turn that settled (its TurnItem): a chat rewound past it is not named from it. */
  turnId: string;
  /** The message it is named from. */
  itemId: string;
  prompt: TitlePrompt;
  /** The title the chat had when it was asked. */
  title: string;
}

const ownerOf = (meta: SessionMeta): TitleOwner => ({ provider: meta.provider, accountId: meta.accountId ?? DEFAULT_ACCOUNT });

/** One title at a time, in the background. */
export class ChatTitles {
  private queue: Asked[] = [];
  private busy = false;
  private current?: AbortController;
  private disposed = false;

  constructor(private deps: TitleDeps) {}

  /** A turn ended without error and was not stopped; `consumed`: the messages it took. The chat's first is named. */
  turnEnded(rt: SessionRuntime, consumed: readonly string[]) {
    if (!wantsTitle(rt.meta, rt.items, this.deps.settings())) return;
    const turn = rt.items.findLast((i) => i.type === 'turn' && !i.parentId);
    if (!turn || !settledTurn(turn)) return;
    const ask = titleAsk(rt.items, consumed);
    const owner = ownerOf(rt.meta);
    if (!ask || !this.deps.model(owner)) return;
    // Asked once, whatever comes of it: a failed call is not tried again.
    rt.update({ titleAsked: true });
    this.queue.push({ rt, owner, turnId: turn.id, itemId: ask.itemId, prompt: titlePrompt(ask, rt.meta.cwd), title: rt.meta.title });
    void this.next();
  }

  /** Whether what the title was asked under still holds: the chat open, the setting on, its title its own and unchanged, the same agent and account, the turn and the message still there. */
  private holds(a: Asked): boolean {
    const { rt } = a;
    if (this.disposed || !this.deps.open(rt) || this.deps.settings().chatTitles === false) return false;
    if (rt.meta.titleSource !== 'auto' || rt.meta.title !== a.title) return false;
    const now = ownerOf(rt.meta);
    if (now.provider !== a.owner.provider || now.accountId !== a.owner.accountId) return false;
    return !!rt.get(a.turnId) && !!rt.get(a.itemId);
  }

  private async next() {
    if (this.busy || this.disposed) return;
    const a = this.queue.shift();
    if (!a) return;
    this.busy = true;
    try {
      await this.name(a);
    } catch (err) {
      this.deps.log('title: the small model gave none:', (err as Error).message);
    } finally {
      this.busy = false;
      void this.next();
    }
  }

  private async name(a: Asked) {
    // Right before the chat's words go out: nothing it was asked under may have changed while it waited.
    if (!this.holds(a)) return;
    const model = this.deps.model(a.owner);
    if (!model) return;
    const ctrl = (this.current = new AbortController());
    const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
    try {
      const title = cleanTitle(await model(a.prompt, ctrl.signal));
      // The person renamed it meanwhile, or it changed otherwise, moved, or closed: theirs stays.
      if (!title || ctrl.signal.aborted || !this.holds(a)) return;
      a.rt.update({ title });
    } finally {
      clearTimeout(timer);
      if (this.current === ctrl) this.current = undefined;
    }
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.current?.abort();
  }
}
