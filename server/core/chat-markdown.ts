import path from 'node:path';
import type { ProviderId, SessionMeta, TimelineItem, ToolItem, UserItem } from '../../shared/protocol';
import { partOfTurn, stripWrappers, syntheticLine, syntheticOf } from '../../shared/synthetic';

/**
 * A conversation as clean Markdown, for "Export chat" and "Copy as Markdown": the title and a line
 * about the chat, then each turn: what the person wrote, the agent's texts and answers in order
 * (widgets and plans as notes), and under them a compact list of the turn's steps (commands with
 * their exit codes, files changed with their line counts, the rest counted). Thinking, tool output,
 * internal ids and the harness's own messages are left out.
 */

export interface ChatMarkdownOptions {
  /** The agent's name as people know it. */
  agentName?: (provider: ProviderId) => string;
  /** Dates in the header (tests pin it). */
  locale?: string;
  timeZone?: string;
}

const AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', demo: 'Demo' };

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
  durationMs?: number;
}

const newTurn = (): Turn => ({ lines: [], files: new Map(), counts: { read: 0, search: 0, fetch: 0, browser: 0, device: 0, other: 0 }, steps: 0 });

/** A turn's steps as a compact list ('' when it took none). */
function stepsBlock(t: Turn, cwd: string): string {
  // Widgets, plans and questions are notes in the text, not steps.
  if (!t.steps) return '';
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
  const head = `**Steps** (${t.steps}${t.durationMs && t.durationMs >= 1000 ? `, ${duration(t.durationMs)}` : ''})`;
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
  const text = stripWrappers(it.text).trim();
  return text || it.attachments?.length ? { text } : null;
}

/** The conversation as Markdown. `items` is the whole timeline, in order. */
export function chatMarkdown(meta: Pick<SessionMeta, 'title' | 'provider' | 'cwd' | 'chat' | 'createdAt'>, items: TimelineItem[], opts: ChatMarkdownOptions = {}): string {
  const agentName = opts.agentName ?? ((p: ProviderId) => AGENT[p] ?? p);
  const cwd = meta.cwd ?? '';
  const children = new Map<string, TimelineItem[]>();
  for (const it of items) if (it.parentId) (children.get(it.parentId) ?? children.set(it.parentId, []).get(it.parentId)!).push(it);
  const roots = items.filter((it) => !it.parentId);

  // The agent the chat started with: the first switch's `from`, else the chat's own.
  const firstSwitch = roots.find((it) => it.type === 'notice' && it.agentSwitch);
  let agent: ProviderId = firstSwitch?.type === 'notice' && firstSwitch.agentSwitch ? firstSwitch.agentSwitch.from : meta.provider;

  const date = new Date(meta.createdAt || Date.now()).toLocaleDateString(opts.locale ?? 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
  const about = [agentName(meta.provider), !meta.chat && cwd ? path.basename(cwd) : '', date].filter(Boolean).join(' · ');
  const blocks: string[] = [`# ${meta.title.replace(/\s+/g, ' ').trim() || 'Chat'}`, about];

  let turn = newTurn();
  // Whether the agent's heading is up since the person last wrote.
  let speaking = false;
  const speak = () => {
    if (speaking) return;
    blocks.push(`## ${agentName(agent)}`);
    speaking = true;
  };
  const endTurn = () => {
    const b = stepsBlock(turn, cwd);
    if (b) blocks.push(b);
    turn = newTurn();
  };

  /** One step into the turn's list (sub-agents' own edits count as the turn's changes). */
  const step = (t: ToolItem, depth = 0) => {
    if (depth === 0) turn.steps++;
    switch (t.kind) {
      case 'bash':
        if (depth === 0) turn.lines.push(`- Ran ${inlineCode(commandLine(t.detail.command ?? t.title))}: ${outcome(t)}`);
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
          turn.files.set(d.path, f);
        }
        return;
      }
      case 'agent': {
        const kids = (children.get(t.id) ?? []).filter((k): k is ToolItem => k.type === 'tool');
        if (depth === 0) {
          const what = t.detail.description || t.title;
          const n = t.result?.agent?.steps ?? kids.length;
          turn.lines.push(`- Agent: ${what.replace(/\s+/g, ' ').trim()}${n ? ` (${plural(n, 'step')})` : ''}`);
        }
        if (depth < 4) for (const k of kids) step(k, depth + 1);
        return;
      }
      case 'skill':
        if (depth === 0) turn.lines.push(`- Skill: ${t.detail.skill ?? t.title}`);
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

  for (const it of roots) {
    if (it.type === 'user') {
      if (it.state === 'queued' || it.until?.check) continue;
      const said = userWords(it);
      if (!said) continue;
      // A message sent into a running turn belongs to that turn; any other starts the next one.
      if (!it.steered && !partOfTurn(syntheticOf(it))) endTurn();
      const lines = [`## You`];
      if (said.text) lines.push(said.command ? inlineCode(said.text) : said.text);
      const names = (it.attachments ?? []).map((a) => a.name).filter(Boolean);
      if (names.length) lines.push(`_Attached: ${names.join(', ')}_`);
      blocks.push(lines.join('\n\n'));
      speaking = false;
    } else if (it.type === 'text') {
      const text = it.text.trim();
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
        blocks.push(`**Plan**\n\n${it.detail.plan.trim()}`);
      } else if (it.kind === 'question' && it.detail.questions?.length) {
        speak();
        const answers = it.result?.answers ?? {};
        for (const q of it.detail.questions) {
          const a = answers[q.question];
          blocks.push(`> ${q.question.trim()}${a?.length ? `\n>\n> Answer: ${a.join(', ')}` : ''}`);
        }
      } else if (it.kind !== 'todo') step(it);
    } else if (it.type === 'notice') {
      if (it.agentSwitch) {
        agent = it.agentSwitch.to;
        blocks.push(`> Switched to ${agentName(agent)}`);
        speaking = false;
      } else if (it.variant === 'error') blocks.push(`> Error: ${it.text.replace(/\s+/g, ' ').trim()}`);
      else if (it.variant === 'interrupted') blocks.push('> Stopped');
    } else if (it.type === 'turn') {
      // The turn ends here: its steps go under what it said.
      if (it.error) blocks.push(`> Error: ${it.error.replace(/\s+/g, ' ').trim()}`);
      turn.durationMs = (turn.durationMs ?? 0) + (it.durationMs || 0);
      endTurn();
    }
  }
  endTurn();
  return `${blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
