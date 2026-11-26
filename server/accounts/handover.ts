import { carry } from './conversation-files';
import type { TimelineItem, Todo } from '../../shared/protocol';
import { HANDOVER_HEAD_ACCOUNT, HANDOVER_TAIL, handoverHeadAgent, handoverHeadSince, syntheticOf, userItemText, syntheticLine } from '../../shared/synthetic';

/**
 * Carrying a conversation from one account of an agent to another. Both agents keep their
 * transcripts per config folder, keyed by the conversation id, and resume a conversation from
 * there: copying the conversation's own files into the other account's folder lets that account
 * resume the same conversation. Only the files of that one conversation are read and written;
 * nothing that holds a sign-in is ever touched.
 */

export const carryClaudeConversation = (from: string, to: string, id: string) => carry('claude', from, to, id);
export const carryCodexConversation = (from: string, to: string, id: string) => carry('codex', from, to, id);

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * When a conversation cannot be carried over: a short account of it, sent ahead of the next
 * message to the new account's agent (the timeline shows only what the user typed). The newest
 * exchanges are kept when it gets long. `skip` leaves out an item (the message about to be sent again).
 */
export function handoverText(items: TimelineItem[], opts: { skip?: string; maxChars?: number; from?: string; since?: boolean; todos?: readonly Todo[]; files?: readonly string[] } = {}): string {
  const max = opts.maxChars ?? 6000;
  const lines: string[] = [];
  /** The person's last message among `lines`: always kept, the task as they last put it. */
  let task = -1;
  let tools: string[] = [];
  const flushTools = () => {
    if (tools.length) lines.push(`Agent steps: ${clip(tools.slice(-8).join('; '), 400)}`);
    tools = [];
  };
  for (const it of items) {
    if (it.parentId || it.id === opts.skip) continue;
    if (it.type === 'user') {
      if (it.until?.check) continue;
      // What Claude Code wrote in the person's place, in plain words: a task that finished, a
      // command they ran and what it printed. Reminders and caveats are left out.
      const syn = syntheticOf(it);
      const line = syn ? syntheticLine(syn) : '';
      if (syn && !line) continue;
      flushTools();
      if (!syn) {
        task = lines.length;
        lines.push(`User: ${clip(userItemText(it), 700)}`);
      }
      else if (syn.role === 'command') lines.push(`User ran: ${clip(line, 300)}`);
      else if (syn.role === 'output') lines.push(`Output: ${clip(line, 300)}`);
      else lines.push(`Event: ${clip(line, 300)}`);
    } else if (it.type === 'text' && it.text.trim()) {
      flushTools();
      lines.push(`Agent: ${clip(it.text, 900)}`);
    } else if (it.type === 'tool' && it.status === 'done') {
      tools.push(it.title);
    }
  }
  flushTools();
  if (!lines.length) return '';
  // `from`: the conversation began with another agent (a switch of agent); `since`: this agent was
  // part of it before, and only what happened after it left is new to it.
  // Its words live in shared/synthetic.ts, which knows them wherever a transcript is read back.
  const head = opts.since ? handoverHeadSince(opts.from ?? 'another agent') : opts.from ? handoverHeadAgent(opts.from) : HANDOVER_HEAD_ACCOUNT;
  const tail = HANDOVER_TAIL;
  // What stands after the exchanges, each part bounded: the open todos and the files changed.
  const extra: string[] = [];
  const open = (opts.todos ?? []).filter((t) => t.status !== 'completed');
  if (open.length) {
    const shown = open.slice(0, 8).map((t) => `- ${clip(t.content, 90)}${t.status === 'in_progress' ? ' (in progress)' : ''}`);
    extra.push(['Open todos:', ...shown, ...(open.length > 8 ? [`- and ${open.length - 8} more`] : [])].join('\n'));
  }
  const files = opts.files ?? [];
  if (files.length) {
    const shown = files.slice(0, 15).map((f) => clip(f, 80));
    extra.push(`Files changed: ${shown.join(', ')}${files.length > 15 ? `, and ${files.length - 15} more` : ''}`);
  }
  const kept: string[] = [];
  let size = head.length + tail.length + extra.reduce((n, e) => n + e.length + 2, 0);
  // The task as the person last put it is kept whatever came after it.
  const pinned = task >= 0 ? lines[task] : undefined;
  if (pinned) size += pinned.length + 2;
  let first = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i === task) {
      first = i;
      continue;
    }
    if (size + lines[i].length + 2 > max) break;
    first = i;
    size += lines[i].length + 2;
  }
  for (let i = first; i < lines.length; i++) kept.push(lines[i]);
  if (pinned && task < first) kept.unshift(pinned);
  if (first > 0) kept.unshift('(earlier messages left out)');
  return [head, '', ...kept, ...(extra.length ? ['', ...extra] : []), '', tail].join('\n');
}
