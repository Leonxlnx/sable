/**
 * Chat titles by a small model. After a chat's first turn settles, a cheap model (Claude Code's
 * Haiku, on the chat's own account) is asked once for a short title from the person's first
 * message and the start of the answer, and it replaces the title Sable made from the message.
 * In the background and one at a time: never in the chat's way. A title the person set is never
 * changed, nor one that changed while the model was asked. `AppSettings.chatTitles` (absent: on).
 */
import type { AppSettings, SessionMeta, TextItem, TimelineItem, TurnItem, UserItem } from '../../shared/protocol';
import { parseSynthetic, userText } from '../../shared/synthetic';
import type { SessionRuntime } from './runtime';

/** What the small model gets: its instructions and one message. */
export interface TitlePrompt {
  system: string;
  user: string;
  /** The chat's folder (a one-shot agent runs there; it reads nothing of it). */
  cwd: string;
  /** The output cap in tokens as a string (a title's by default). */
  maxTokens?: string;
}

/** Asks a model for a title: its raw answer, or null when it gave none. */
export type TitleModel = (prompt: TitlePrompt, signal: AbortSignal) => Promise<string | null>;

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

/** The person's first message and the start of the answer to it (root items only); null when there is no message of theirs. */
export function titleAsk(items: readonly TimelineItem[]): { message: string; answer: string } | null {
  const at = items.findIndex((i) => i.type === 'user' && !i.parentId && !(i as UserItem).until && !parseSynthetic((i as UserItem).text) && userText((i as UserItem).text).trim());
  if (at < 0) return null;
  const message = userText((items[at] as UserItem).text).trim();
  const answer: string[] = [];
  for (const it of items.slice(at + 1)) {
    if (it.parentId) continue;
    if (it.type === 'user' && !parseSynthetic((it as UserItem).text)) break;
    if (it.type === 'text' && (it as TextItem).text.trim()) answer.push((it as TextItem).text.trim());
    if (answer.join('\n\n').length > ANSWER_CHARS) break;
  }
  return { message, answer: answer.join('\n\n') };
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

/** Whether this chat gets its title from the small model now: once, after its first turn that settled. */
export function wantsTitle(meta: SessionMeta, items: readonly TimelineItem[], settings: Pick<AppSettings, 'chatTitles'>): boolean {
  if (settings.chatTitles === false) return false;
  // Never a title the person gave (sub-agents' titles count as given), never twice.
  if (meta.titleSource !== 'auto' || meta.titleAsked) return false;
  // A race's two chats keep the task's name, alike.
  if (meta.race) return false;
  const settled = items.filter((i) => i.type === 'turn' && !i.parentId && !(i as TurnItem).error).length;
  return settled === 1;
}

export interface TitleDeps {
  settings(): Pick<AppSettings, 'chatTitles'>;
  /** The model that names this chat (its own agent's smallest, on its own account), or none. */
  model(rt: SessionRuntime): TitleModel | undefined;
  /** The chat is still open in this bridge. */
  open(rt: SessionRuntime): boolean;
  log(...args: unknown[]): void;
}

/** One title at a time, in the background. */
export class ChatTitles {
  private queue: SessionRuntime[] = [];
  private busy = false;
  private current?: AbortController;
  private disposed = false;

  constructor(private deps: TitleDeps) {}

  /** A turn ended without error: the chat's first is named. */
  turnEnded(rt: SessionRuntime) {
    if (!wantsTitle(rt.meta, rt.items, this.deps.settings())) return;
    if (!titleAsk(rt.items) || !this.deps.model(rt)) return;
    // Asked once, whatever comes of it: a failed call is not tried again.
    rt.update({ titleAsked: true });
    this.queue.push(rt);
    void this.next();
  }

  private async next() {
    if (this.busy || this.disposed) return;
    const rt = this.queue.shift();
    if (!rt) return;
    this.busy = true;
    try {
      await this.name(rt);
    } catch (err) {
      this.deps.log('title: the small model gave none:', (err as Error).message);
    } finally {
      this.busy = false;
      void this.next();
    }
  }

  private async name(rt: SessionRuntime) {
    const model = this.deps.model(rt);
    const ask = titleAsk(rt.items);
    if (!model || !ask || !this.deps.open(rt) || this.deps.settings().chatTitles === false) return;
    const before = rt.meta.title;
    const ctrl = (this.current = new AbortController());
    const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
    try {
      const title = cleanTitle(await model(titlePrompt(ask, rt.meta.cwd), ctrl.signal));
      // The person renamed it meanwhile, or it changed otherwise, or it closed: theirs stays.
      if (!title || ctrl.signal.aborted || !this.deps.open(rt) || rt.meta.titleSource !== 'auto' || rt.meta.title !== before) return;
      rt.update({ title });
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
