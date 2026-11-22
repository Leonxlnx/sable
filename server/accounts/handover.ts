import { existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TimelineItem, Todo } from '../../shared/protocol';
import { HANDOVER_HEAD_ACCOUNT, HANDOVER_TAIL, handoverHeadAgent, handoverHeadSince, parseSynthetic, stripWrappers, syntheticLine } from '../../shared/synthetic';

/**
 * Carrying a conversation from one account of an agent to another. Both agents keep their
 * transcripts per config folder, keyed by the conversation id, and resume a conversation from
 * there: copying the conversation's own files into the other account's folder lets that account
 * resume the same conversation. Only the files of that one conversation are read and written;
 * nothing that holds a sign-in is ever touched.
 */

const SAFE_ID = /^[\w-]{1,128}$/;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Claude Code: `<config>/projects/<folder key>/<id>.jsonl` (the folder key is derived from the
 * working folder, the same for every account on this machine), a folder of the same name next to
 * it (sub-agent transcripts, large tool results) and `<config>/file-history/<id>` (rewind
 * checkpoints). Returns false when the conversation is not in `fromHome`.
 *
 * Asynchronous: a long conversation's files (its transcript, every sub-agent's, large results) run
 * to hundreds of megabytes, and copying them synchronously held the bridge, which is the desktop's
 * main process, so the window stopped answering for seconds at a limit (perf1: 0.9-1.4 s for 574 MB).
 */
export async function carryClaudeConversation(fromHome: string, toHome: string, sessionId: string): Promise<boolean> {
  if (!SAFE_ID.test(sessionId)) return false;
  const projects = path.join(fromHome, 'projects');
  let keys: string[];
  try {
    keys = (await readdir(projects, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }
  const found = keys.filter((k) => existsSync(path.join(projects, k, `${sessionId}.jsonl`)));
  if (!found.length) return false;
  if (samePath(fromHome, toHome)) return true;
  for (const key of found) {
    const src = path.join(projects, key);
    const dst = path.join(toHome, 'projects', key);
    await mkdir(dst, { recursive: true });
    await copyFile(path.join(src, `${sessionId}.jsonl`), path.join(dst, `${sessionId}.jsonl`));
    const side = path.join(src, sessionId);
    if (isDir(side)) await cp(side, path.join(dst, sessionId), { recursive: true, force: true });
  }
  const history = path.join(fromHome, 'file-history', sessionId);
  if (isDir(history)) await cp(history, path.join(toHome, 'file-history', sessionId), { recursive: true, force: true });
  return true;
}

/**
 * Codex: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, copied to the same
 * place under the other CODEX_HOME. Returns false when the thread is not in `fromHome`. Asynchronous,
 * as the Claude Code one (a walk of every day's rollouts and a big copy must not hold the bridge).
 */
export async function carryCodexConversation(fromHome: string, toHome: string, threadId: string): Promise<boolean> {
  if (!SAFE_ID.test(threadId)) return false;
  const root = path.join(fromHome, 'sessions');
  const hits: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(`${threadId}.jsonl`)) hits.push(p);
    }
  };
  await walk(root, 0);
  if (!hits.length) return false;
  if (samePath(fromHome, toHome)) return true;
  for (const file of hits) {
    const dst = path.join(toHome, 'sessions', path.relative(root, file));
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(file, dst);
  }
  return true;
}

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
      // What Claude Code wrote in the person's place, in plain words: a task that finished, a
      // command they ran and what it printed. Reminders and caveats are left out.
      const syn = parseSynthetic(it.text);
      const line = syn ? syntheticLine(syn) : '';
      if (syn && !line) continue;
      flushTools();
      if (!syn) {
        task = lines.length;
        lines.push(`User: ${clip(stripWrappers(it.text), 700)}`);
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
