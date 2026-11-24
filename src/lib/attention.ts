/**
 * "This chat needs you" and "this chat finished something worth knowing", read in one place.
 *
 * Pure: a tracker fed with the bridge's events (every chat's, loaded or not: the bridge sends them
 * all) that answers with signals, and the rule that decides what a signal does (a notification, a
 * flash of the taskbar). The store feeds it (`state/store.ts` `applyEvent`); `lib/notify.ts` acts on
 * what it answers. Tested with event sequences in `tests/attention.test.ts`.
 *
 * A chat needs the person while a permission (a plan to approve is one) or a question waits, or a
 * limit card owes a decision. It finished something worth knowing when a turn ended (not a turn
 * inside an `/until` loop, not a turn the agent began by itself that changed nothing), when a turn
 * failed, and when work was lost and Sable woke the agent to tell it.
 */
import type { BridgeEvent, NoticeItem, PermissionRequest, QuestionRequest, SessionMeta, SessionStatus, TimelineItem } from '@shared/protocol';
import { isLeadIn } from '@/features/timeline/lead-in';

/** What a chat waits on the person for. `id`: the prompt's or the limit card's id. */
export type Need =
  | { kind: 'permission'; id: string; tool: PermissionRequest['kind']; plan: boolean }
  | { kind: 'question'; id: string; text: string }
  | { kind: 'limit'; id: string; text: string };

export type Signal =
  /** The chat waits on the person for one more thing; `first`: it waited on nothing before. */
  | { kind: 'waiting'; chat: string; need: Need; first: boolean }
  /** A turn ended; `answer`: the first sentence of what it said last, when it said anything. */
  | { kind: 'finished'; chat: string; answer?: string }
  | { kind: 'failed'; chat: string; error?: string }
  /** Work of the chat was lost and Sable woke the agent to tell it. */
  | { kind: 'lost'; chat: string };

/** Longest text kept of a turn's answer: its first sentence is all a notification shows. */
const KEEP = 600;

interface Chat {
  status?: SessionStatus;
  until: boolean;
  /** A message of the person's came since the last turn ended (or the turn's start was not seen). */
  byPerson: boolean;
  /** The turn's start was seen here. */
  sawStart: boolean;
  /** The turn changed files: an edit or a write step, or more to review than when it began. */
  changed: boolean;
  review: number;
  /** The turn's last few root texts, newest last. */
  texts: { id: string; text: string }[];
  /** Prompts known to wait (ids), so a prompt sent again is not news twice. */
  prompts: Set<string>;
  /** Limit cards that owe a decision. */
  limits: Set<string>;
  delivered?: string;
}

const blank = (): Chat => ({ until: false, byPerson: false, sawStart: false, changed: false, review: 0, texts: [], prompts: new Set(), limits: new Set() });

/** A limit card the person still has to decide on: decided by the bridge, and nothing carried it on. */
export function limitOwed(item: TimelineItem | undefined): boolean {
  const l = item?.type === 'notice' ? item.limit : undefined;
  return !!l && !!l.provider && !l.continuedWith && !l.moving && !l.atReset;
}

export class Attention {
  private chats = new Map<string, Chat>();

  private chat(id: string): Chat {
    let c = this.chats.get(id);
    if (!c) this.chats.set(id, (c = blank()));
    return c;
  }

  /** Chats known at start-up (`app.hello`): their state, so the first change is read against it. */
  seed(sessions: SessionMeta[]) {
    for (const s of sessions) {
      const c = this.chat(s.id);
      c.status = s.status;
      c.until = !!s.until;
      c.review = s.review ?? 0;
      c.delivered = s.lossWake?.delivered;
    }
  }

  /** Prompts known at start-up or after a reconnect (`withPrompts`): already waiting, so not news. */
  seedPrompts(perms: PermissionRequest[], questions: QuestionRequest[]) {
    for (const c of this.chats.values()) c.prompts.clear();
    for (const p of perms) this.chat(p.sessionId).prompts.add(p.id);
    for (const q of questions) this.chat(q.sessionId).prompts.add(q.id);
  }

  /** Whether a chat owes a decision on a limit card (the triage deck has no card for it). */
  limitWaits(chat: string): boolean {
    return !!this.chats.get(chat)?.limits.size;
  }

  /** Chats that owe a limit decision. */
  limitChats(): string[] {
    const out: string[] = [];
    for (const [id, c] of this.chats) if (c.limits.size) out.push(id);
    return out;
  }

  /** A streamed piece of a text (`item.delta`): kept only for the turn's newest texts, bounded. */
  delta(chat: string, id: string, field: string, delta: string) {
    if (field !== 'text') return;
    const t = this.chats.get(chat)?.texts.find((x) => x.id === id);
    if (t && t.text.length < KEEP) t.text = (t.text + delta).slice(0, KEEP);
  }

  /** One bridge event; answers what it makes worth knowing. `before`: the chat's meta before a `session.updated`. */
  feed(e: BridgeEvent, before?: SessionMeta): Signal[] {
    switch (e.type) {
      case 'session.added':
        this.seed([e.session]);
        return [];
      case 'session.removed':
        this.chats.delete(e.id);
        return [];
      case 'session.updated':
        return this.updated(e.id, e.patch, before);
      case 'item.added':
        return this.item(e.sessionId, e.item, true);
      case 'item.patch': {
        // A patch carries only what changed: the kind of item is what the tracker already knows.
        const c = this.chats.get(e.sessionId);
        const p = e.patch as Partial<TimelineItem>;
        if (!c) return [];
        const t = c.texts.find((x) => x.id === e.id);
        if (t && typeof (p as { text?: unknown }).text === 'string') t.text = (p as { text: string }).text.slice(0, KEEP);
        if ('limit' in p) return this.item(e.sessionId, { ...p, id: e.id, type: 'notice' } as TimelineItem, false);
        if ('kind' in p && (p.kind === 'edit' || p.kind === 'write')) c.changed = true;
        return [];
      }
      case 'item.removed': {
        const c = this.chats.get(e.sessionId);
        if (c && !e.moving) {
          c.limits.delete(e.id);
          c.texts = c.texts.filter((t) => t.id !== e.id);
        }
        return [];
      }
      case 'timeline.reset': {
        const c = this.chats.get(e.sessionId);
        if (c) {
          c.limits.clear();
          for (const it of e.items) if (limitOwed(it)) c.limits.add(it.id);
        }
        return [];
      }
      case 'permission.added':
        return this.prompt(e.request.sessionId, e.request.id, { kind: 'permission', id: e.request.id, tool: e.request.kind, plan: e.request.kind === 'plan' || e.request.toolName === 'ExitPlanMode' });
      case 'question.added':
        return this.prompt(e.request.sessionId, e.request.id, { kind: 'question', id: e.request.id, text: firstLine(e.request.questions[0]?.question ?? '') });
      case 'permission.removed':
      case 'question.removed':
        this.chats.get(e.sessionId)?.prompts.delete(e.id);
        return [];
      default:
        return [];
    }
  }

  /** Whether the chat waits on anything this tracker knows of (prompts or a limit card). */
  waits(chat: string): boolean {
    const c = this.chats.get(chat);
    return !!c && (c.prompts.size > 0 || c.limits.size > 0);
  }

  private prompt(chat: string, id: string, need: Need): Signal[] {
    const c = this.chat(chat);
    if (c.prompts.has(id)) return [];
    const first = !this.waits(chat);
    c.prompts.add(id);
    if (c.prompts.size > 200) c.prompts.delete(c.prompts.values().next().value as string);
    return [{ kind: 'waiting', chat, need, first }];
  }

  private item(chat: string, item: TimelineItem, added: boolean): Signal[] {
    const c = this.chat(chat);
    if (added && !item.parentId) {
      if (item.type === 'user') c.byPerson = true;
      else if (item.type === 'text') {
        c.texts = [...c.texts.filter((t) => t.id !== item.id), { id: item.id, text: (item.text ?? '').slice(0, KEEP) }].slice(-4);
      }
    }
    if (added && item.type === 'tool' && (item.kind === 'edit' || item.kind === 'write')) c.changed = true;
    if (item.type !== 'notice') return [];
    const owed = limitOwed(item);
    // A patch without the card's limit says nothing about it.
    if (!owed && !('limit' in item)) return [];
    if (!owed) {
      c.limits.delete(item.id);
      return [];
    }
    if (c.limits.has(item.id)) return [];
    const first = !this.waits(chat);
    c.limits.add(item.id);
    const l = (item as NoticeItem).limit!;
    return [{ kind: 'waiting', chat, need: { kind: 'limit', id: item.id, text: l.window ? `${l.window} reached` : 'Limit reached' }, first }];
  }

  private updated(chat: string, patch: Partial<SessionMeta>, before?: SessionMeta): Signal[] {
    const c = this.chat(chat);
    const prev = c.status ?? before?.status;
    const out: Signal[] = [];
    if ('until' in patch) c.until = !!patch.until;
    else if (before && c.status === undefined) c.until = !!before.until;
    if (typeof patch.review === 'number' || patch.review === null) {
      const r = patch.review ?? 0;
      if (r > c.review) c.changed = true;
      c.review = r;
    }
    if (patch.lossWake !== undefined) {
      const delivered = patch.lossWake?.delivered;
      if (delivered && delivered !== c.delivered) out.push({ kind: 'lost', chat });
      if (delivered) c.delivered = delivered;
    }
    // A move away from the person's limit, a spare wait: the card's decision is made.
    if (patch.spare || patch.moving) c.limits.clear();
    const status = patch.status;
    if (!status || status === prev) return out;
    c.status = status;
    if (status === 'running' && prev !== 'awaiting') {
      // A new turn: the person sent something or the agent began by itself; a limit card above it is behind it.
      c.sawStart = true;
      c.limits.clear();
      return out;
    }
    const ended = (prev === 'running' || prev === 'awaiting') && (status === 'idle' || status === 'error');
    if (!ended) return out;
    const byPerson = c.byPerson || !c.sawStart;
    const changed = c.changed;
    const texts = c.texts;
    c.byPerson = false;
    c.sawStart = false;
    c.changed = false;
    c.texts = [];
    if (status === 'error') {
      out.push({ kind: 'failed', chat, error: firstLine(patch.lastError ?? before?.lastError ?? '') || undefined });
      return out;
    }
    // A turn inside an armed `/until` loop is not the end of the work: only the loop's end is news.
    if (c.until) return out;
    // Work the agent began by itself that changed nothing is no news.
    if (!byPerson && !changed) return out;
    // A chat that waits on a decision keeps that as its news.
    if (this.waits(chat)) return out;
    out.push({ kind: 'finished', chat, answer: answerOf(texts) });
    return out;
  }
}

// ── what a signal does ──

export interface Context {
  /** The master switch (`AppSettings.notifyOnDone`). */
  enabled: boolean;
  /** The chat is muted (`SessionMeta.muted`). */
  muted: boolean;
  /** The chat is the one on screen (and the page is not hidden). */
  onScreen: boolean;
  /** Sable's window has the focus. */
  focused: boolean;
  /** The person typed in this chat's composer a moment ago. */
  typing: boolean;
}

export interface Act {
  notify: boolean;
  /** Flash the taskbar button once (a chat started waiting while the window is not focused). */
  flash: boolean;
}

/** The one rule: what a signal does, given where the person is. */
export function decide(sig: Signal, ctx: Context): Act {
  const none = { notify: false, flash: false };
  if (!ctx.enabled || ctx.muted || ctx.typing) return none;
  if (ctx.onScreen && ctx.focused) return none;
  return { notify: true, flash: sig.kind === 'waiting' && sig.first && !ctx.focused };
}

/** How many chats wait on the person: the taskbar's figure (muted ones too: it is a count, not an alert). */
export function waitingChats(promptChats: Iterable<string>, limitChats: Iterable<string>, known: (id: string) => boolean): number {
  const set = new Set<string>();
  for (const id of promptChats) if (known(id)) set.add(id);
  for (const id of limitChats) if (known(id)) set.add(id);
  return set.size;
}

// ── words ──

export interface Words {
  title: string;
  body: string;
}

const permissionKind: Partial<Record<PermissionRequest['kind'], string>> = {
  bash: 'Run a command', edit: 'Edit a file', write: 'Edit a file', read: 'Read a file',
  fetch: 'Read a page', browser: 'Use the browser', search: 'Search files', glob: 'Find files',
  websearch: 'Search the web', agent: 'Start an agent', device: 'Use a device', share: 'Share files',
};

/** The notification's words: the chat's name, and what it needs or did in a few words. */
export function wordsFor(sig: Signal, chatTitle: string): Words {
  const title = cut(chatTitle.trim() || 'Untitled', 64);
  switch (sig.kind) {
    case 'waiting': {
      const n = sig.need;
      if (n.kind === 'permission') return { title, body: n.plan ? 'Plan to approve' : `Waits for approval: ${permissionKind[n.tool] ?? 'Use a tool'}` };
      if (n.kind === 'question') return { title, body: 'Asks you a question' };
      return { title, body: 'Limit reached' };
    }
    case 'finished':
      return { title, body: 'Finished' };
    case 'failed':
      return { title, body: 'Failed' };
    case 'lost':
      return { title, body: 'Background work was lost' };
  }
}

/** The last thing a turn said that is not a lead-in or a nod, as its first sentence, cut at a word. */
export function answerOf(texts: { text: string }[]): string | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i].text.trim();
    if (!t || isLeadIn(t, false)) continue;
    return firstSentence(t);
  }
  return undefined;
}

/** Markdown taken off, the first sentence, cut cleanly at a word. */
export function firstSentence(text: string, max = 110): string | undefined {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2');
  const line = plain.split(/\n\s*\n|\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return cut((m ? m[1] : line).trim(), max);
}

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** Cut at a word with an ellipsis; a sentence that fits stays whole. */
export function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const at = head.lastIndexOf(' ');
  return `${(at > max * 0.5 ? head.slice(0, at) : head).replace(/[\s,;:.\-]+$/, '')}…`;
}
