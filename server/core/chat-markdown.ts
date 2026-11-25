import path from 'node:path';
import type { ProviderId, SessionMeta, TimelineItem, ToolItem, UserItem } from '../../shared/protocol';
import { userItemText, syntheticLine, syntheticOf } from '../../shared/synthetic';
import { noticeLevel } from '../../shared/notice';
import { workedSpan } from '../../shared/turn-span';
import { rootShape, turnBoundary, type Boundary, type TurnState } from '../../shared/turn-live-index';

/**
 * A conversation as clean Markdown, for "Export chat" and "Copy as Markdown": the title and a line
 * about the chat, then each turn: what the person wrote, the agent's texts and answers in order
 * (widgets and plans as notes), and under them a compact list of the turn's steps (commands with
 * their exit codes, files changed with their line counts, the rest counted). Thinking, tool output,
 * internal ids and the harness's own messages are left out.
 */

export interface ChatMarkdownOptions {
  /** Resolve one disk-backed item while formatting it. The tree holds only resident rows. */
  whole?: (item: TimelineItem) => TimelineItem;
  /** The agent's name as people know it. */
  agentName?: (provider: ProviderId) => string;
  /** Dates in the header (tests pin it). */
  locale?: string;
  timeZone?: string;
}

const AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', demo: 'Demo' };

/** How a notice that stood as a card is named in the export, by its level. */
const NOTICE_WORD = { info: 'Note', warn: 'Warning', error: 'Error' } as const;

/** A name for the file: the chat's title without what file systems refuse, at most 80 characters. */
export function markdownFileName(title: string): string {
  const base = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return `${base || 'Chat'}.md`;
}

/** Inline code that survives backticks in it. */
export function inlineCode(s: string): string {
  const one = s.replace(/\s*\n\s*/g, ' ').trim();
  let fence = '`';
  while (one.includes(fence)) fence += '`';
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}

/** "45 s", "1 min 12 s", "2 h 3 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A message's own text as it goes into the file: byte for byte, only the blank lines before it and
 * the blank space after it dropped (the blocks around it set the spacing), never what is inside it
 * (blank lines in code, indentation).
 */
export function body(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/** A path as the chat shows it: relative to the chat's folder when inside it, with forward slashes. */
function shownPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  const rel = cwd ? path.relative(cwd, abs) : '';
  const out = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
  return out.replace(/\\/g, '/');
}

/** A command on one line for the list: its first line, cut when long. */
function commandLine(cmd: string): string {
  const lines = cmd.trim().split('\n');
  const first = lines[0].trim();
  const cut = first.length > 160 ? `${first.slice(0, 159).trimEnd()}…` : first;
  return lines.length > 1 ? `${cut} …` : cut;
}

/** How a command ended, in a few words. */
function outcome(t: ToolItem): string {
  if (t.status === 'denied') return 'not allowed';
  if (t.status === 'cancelled' || t.result?.interrupted) return 'stopped';
  if (t.status === 'running' || t.status === 'pending' || t.status === 'awaiting') return t.detail.background ? 'in the background' : 'did not finish';
  const code = t.result?.exitCode;
  if (typeof code === 'number') return `exit ${code}`;
  if (t.status === 'error' || t.result?.isError) return 'failed';
  return t.detail.background ? 'in the background' : 'done';
}

interface Turn {
  /** The steps listed one by one: commands, sub-agents, skills. */
  lines: string[];
  /** Changed files in the order they were first changed, with their counts. */
  files: Map<string, { add: number; del: number; created: boolean; deleted: boolean }>;
  counts: { read: number; search: number; fetch: number; browser: number; device: number; other: number };
  steps: number;
  ids: string[];
  lead: string | null;
}

const newTurn = (): Turn => ({ lines: [], files: new Map(), counts: { read: 0, search: 0, fetch: 0, browser: 0, device: 0, other: 0 }, steps: 0, ids: [], lead: null });

/** A turn's steps as a compact list. */
function stepsBlock(t: Turn, cwd: string, ms: number | null): string {
  const out = [...t.lines];
  for (const [p, f] of t.files) {
    const counts = [f.add ? `+${f.add}` : '', f.del ? `−${f.del}` : ''].filter(Boolean).join(' ');
    const verb = f.deleted ? 'Deleted' : f.created ? 'Created' : 'Changed';
    out.push(`- ${verb} ${inlineCode(shownPath(p, cwd))}${counts ? `: ${counts}` : ''}`);
  }
  const c = t.counts;
  const also = [
    c.read ? `read ${plural(c.read, 'file')}` : '',
    c.search ? `searched ${plural(c.search, 'time')}` : '',
    c.fetch ? `fetched ${plural(c.fetch, 'page')}` : '',
    c.browser ? `used the browser ${plural(c.browser, 'time')}` : '',
    c.device ? `used the device ${plural(c.device, 'time')}` : '',
    c.other ? plural(c.other, 'other step') : '',
  ].filter(Boolean);
  if (also.length) {
    const words = also.length > 1 ? `${also.slice(0, -1).join(', ')} and ${also[also.length - 1]}` : also[0];
    out.push(`- ${out.length ? 'Also ' : ''}${out.length ? words : words[0].toUpperCase() + words.slice(1)}`);
  }
  const head = `**Steps** (${t.steps}${ms !== null && ms >= 1000 ? `, ${duration(ms)}` : ''})`;
  return [head, '', ...out].join('\n');
}

/** What a person's message says, as it goes into the file ('' for one the harness wrote that says nothing). */
function userWords(it: UserItem): { text: string; command?: boolean } | null {
  const syn = syntheticOf(it);
  if (syn) {
    // A command the person ran ("/compact") is theirs; notifications, outputs and summaries are not.
    if (syn.role !== 'command') return null;
    const line = syntheticLine(syn);
    return line ? { text: line, command: true } : null;
  }
  const text = body(userItemText(it));
  return text || it.attachments?.length ? { text } : null;
}

/** Format disk-backed content in display order, releasing each whole item before reading the next. */
export function chatMarkdown(meta: Pick<SessionMeta, 'title' | 'provider' | 'cwd' | 'chat' | 'createdAt'>, items: TimelineItem[], opts: ChatMarkdownOptions = {}): string {
  const agentName = opts.agentName ?? ((p: ProviderId) => AGENT[p] ?? p);
  const cwd = meta.cwd ?? '';
  const children = new Map<string, TimelineItem[]>();
  for (const it of items) if (it.parentId) (children.get(it.parentId) ?? children.set(it.parentId, []).get(it.parentId)!).push(it);
  const roots = items.filter((it) => !it.parentId);
  // Times and settlement stamps are resident even when the body is on disk.
  const byId = Object.fromEntries(roots.map(it => [it.id, it]));

  // The agent the chat started with: the first switch's `from`, else the chat's own.
  const firstSwitch = roots.find((it) => it.type === 'notice' && it.agentSwitch);
  let agent: ProviderId = firstSwitch?.type === 'notice' && firstSwitch.agentSwitch ? firstSwitch.agentSwitch.from : meta.provider;

  const date = new Date(meta.createdAt || Date.now()).toLocaleDateString(opts.locale ?? 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
  const about = [agentName(meta.provider), !meta.chat && cwd ? path.basename(cwd) : '', date].filter(Boolean).join(' · ');
  const blocks: string[] = [`# ${meta.title.replace(/\s+/g, ' ').trim() || 'Chat'}`, about];

  let turn = newTurn();
  let state: TurnState = 'closed';
  // Whether the agent's heading is up since the person last wrote.
  let speaking = false;
  const speak = () => {
    if (speaking) return;
    blocks.push(`## ${agentName(agent)}`);
    speaking = true;
  };
  const endTurn = (next?: string) => {
    if (turn.steps) blocks.push(stepsBlock(turn, cwd, workedSpan(byId, turn.ids, turn.lead, next)));
    turn = newTurn();
  };

  /** One step into the turn's list (sub-agents' own edits count as the turn's changes). */
  const step = (t: ToolItem, depth: number, fetched: boolean) => {
    // A short command/path sliced out of a parsed JSON line can keep that entire line
    // alive. Only the formatted words and map keys live beyond this iteration.
    const keep = (s: string) => fetched ? Buffer.from(s, 'utf16le').toString('utf16le') : s;
    if (depth === 0) turn.steps++;
    switch (t.kind) {
      case 'bash':
        if (depth === 0) turn.lines.push(keep(`- Ran ${inlineCode(commandLine(t.detail.command ?? t.title))}: ${outcome(t)}`));
        return;
      case 'edit':
      case 'write': {
        if (t.status !== 'done') {
          if (depth === 0) turn.counts.other++;
          return;
        }
        const diffs = [...(t.result?.diff ?? [])];
        if (!diffs.length && t.detail.path) diffs.push({ path: t.detail.path, status: 'modified', additions: 0, deletions: 0, hunks: [] });
        for (const d of diffs) {
          const f = turn.files.get(d.path) ?? { add: 0, del: 0, created: false, deleted: false };
          if (!turn.files.has(d.path)) f.created = d.status === 'added';
          f.add += d.additions;
          f.del += d.deletions;
          f.deleted = d.status === 'deleted';
          turn.files.set(keep(d.path), f);
        }
        return;
      }
      case 'agent': {
        const kids = (children.get(t.id) ?? []).filter((k): k is ToolItem => k.type === 'tool');
        if (depth === 0) {
          const what = t.detail.description || t.title;
          const n = t.result?.agent?.steps ?? kids.length;
          turn.lines.push(keep(`- Agent: ${what.replace(/\s+/g, ' ').trim()}${n ? ` (${plural(n, 'step')})` : ''}`));
        }
        return;
      }
      case 'skill':
        if (depth === 0) turn.lines.push(keep(`- Skill: ${t.detail.skill ?? t.title}`));
        return;
      default:
        if (depth > 0) return;
        if (t.kind === 'read') turn.counts.read++;
        else if (t.kind === 'search' || t.kind === 'glob' || t.kind === 'websearch') turn.counts.search++;
        else if (t.kind === 'fetch') turn.counts.fetch++;
        else if (t.kind === 'browser') turn.counts.browser++;
        else if (t.kind === 'device') turn.counts.device++;
        else turn.counts.other++;
    }
  };

  function* inOrder(rows: TimelineItem[], depth = 0): Generator<[TimelineItem, number]> {
    for (const row of rows) {
      yield [row, depth];
      if (row.type === 'tool' && row.kind === 'agent' && (depth || !row.check) && depth < 4) {
        yield* inOrder(children.get(row.id) ?? [], depth + 1);
      }
    }
  }
  for (const [row, depth] of inOrder(roots)) {
    const it = ('more' in row && row.more && opts.whole) ? opts.whole(row) : row;
    if (depth) {
      if (it.type === 'tool') step(it, depth, it !== row);
      continue;
    }
    if (it.type === 'user' && it.state === 'queued') continue;
    const shape = rootShape(it);
    const closingRecord = it.type === 'turn' || (it.type === 'notice' && it.early);
    if (shape) {
      const boundary: Boundary<string> = turnBoundary(state, shape, it.id);
      state = boundary.state;
      if (boundary.pos !== undefined && !closingRecord) {
        endTurn(it.id);
        if (state !== 'closed' && it.type === 'user') turn.lead = it.id;
      }
    }
    if (state !== 'closed' || closingRecord) turn.ids.push(it.id);
    if (it.type === 'user') {
      if (it.until?.check) continue;
      const said = userWords(it);
      if (!said) continue;
      const lines = [`## You`];
      if (said.text) lines.push(said.command ? inlineCode(said.text) : said.text);
      const names = (it.attachments ?? []).map((a) => a.name).filter(Boolean);
      if (names.length) lines.push(`_Attached: ${names.join(', ')}_`);
      blocks.push(lines.join('\n\n'));
      speaking = false;
    } else if (it.type === 'text') {
      const text = body(it.text);
      if (!text) continue;
      speak();
      blocks.push(text);
    } else if (it.type === 'tool') {
      if (it.check) continue;
      if (it.kind === 'widget') {
        const title = typeof (it.input as { title?: unknown } | undefined)?.title === 'string' ? ((it.input as { title: string }).title).trim() : '';
        speak();
        blocks.push(`> Widget${title ? `: ${title}` : ''}`);
      } else if (it.kind === 'plan' && it.detail.plan?.trim()) {
        speak();
        blocks.push(`**Plan**\n\n${body(it.detail.plan)}`);
      } else if (it.kind === 'question' && it.detail.questions?.length) {
        speak();
        const answers = it.result?.answers ?? {};
        for (const q of it.detail.questions) {
          const a = answers[q.question];
          blocks.push(`> ${q.question.trim()}${a?.length ? `\n>\n> Answer: ${a.join(', ')}` : ''}`);
        }
      } else if (it.kind !== 'todo') step(it, 0, it !== row);
    } else if (it.type === 'notice') {
      if (it.agentSwitch) {
        agent = it.agentSwitch.to;
        blocks.push(`> Switched to ${agentName(agent)}`);
        speaking = false;
      } else if (it.variant === 'error') blocks.push(`> ${NOTICE_WORD[noticeLevel(it)]}: ${it.text.replace(/\s+/g, ' ').trim()}`);
      else if (it.variant === 'interrupted') blocks.push('> Stopped');
      if (it.early) endTurn();
    } else if (it.type === 'turn') {
      // The turn ends here: its steps go under what it said.
      if (it.error) blocks.push(`> Error: ${it.error.replace(/\s+/g, ' ').trim()}`);
      endTurn();
    }
  }
  endTurn();
  // One blank line between blocks; each block's own text is left as it is (no blank lines at its edges).
  return `${blocks.map((b) => body(b)).filter(Boolean).join('\n\n')}\n`;
}
