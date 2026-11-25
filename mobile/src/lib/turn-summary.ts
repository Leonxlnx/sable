import type { TimelineItem } from '@shared/protocol';

/**
 * A finished turn as plain text to send on (2.18, "Share" under the newest answer): the chat's name,
 * the message that opened the turn, one line of what the work was (the agent, its time, its steps, the
 * files it changed and their lines), the files by name, then the answer. Bounded everywhere, so a
 * turn of thousands of steps or a 4,000-line answer shares as a message, not a file. Nothing of the
 * steps' own output, nothing Sable wrote for the agent.
 */

export interface TurnFile {
  path: string;
  add: number;
  del: number;
}

export interface SummaryInput {
  title: string;
  agent: string;
  prompt?: string;
  /** "3m 12s", when the turn's time is known. */
  worked?: string;
  steps: number;
  files: TurnFile[];
  answer?: string;
  /** The chat's folder: file paths are shown inside it. */
  cwd?: string;
}

export const PROMPT_MAX = 280;
export const ANSWER_MAX = 3500;
export const FILES_MAX = 8;

const cut = (s: string, max: number) => {
  const t = s.trim();
  if (t.length <= max) return t;
  const at = t.lastIndexOf(' ', max - 1);
  return `${t.slice(0, at > max * 0.6 ? at : max - 1).trimEnd()}…`;
};

const inside = (path: string, cwd?: string) => {
  if (!cwd) return path;
  const p = path.replace(/\\/g, '/');
  const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return p.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? p.slice(c.length + 1) : p;
};

/** The files a turn's edits changed, sub-agents' edits included, each with its lines, in the order first touched. */
export function turnFiles(items: Record<string, TimelineItem | undefined>, children: Record<string, string[] | undefined>, ids: readonly string[]): TurnFile[] {
  const by = new Map<string, TurnFile>();
  const walk = (list: readonly string[], depth: number) => {
    for (const id of list) {
      const it = items[id];
      if (it?.type !== 'tool' || it.check) continue;
      if (it.kind === 'agent') {
        if (depth < 4) walk(children[id] ?? [], depth + 1);
        continue;
      }
      if ((it.kind !== 'edit' && it.kind !== 'write') || it.status !== 'done') continue;
      for (const d of it.result?.diff ?? []) {
        const f = by.get(d.path) ?? { path: d.path, add: 0, del: 0 };
        f.add += d.additions;
        f.del += d.deletions;
        by.set(d.path, f);
      }
    }
  };
  walk(ids, 0);
  return [...by.values()];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function turnSummary(i: SummaryInput): string {
  const out: string[] = [i.title.trim() || 'Chat'];
  if (i.prompt?.trim()) out.push('', cut(i.prompt, PROMPT_MAX));
  const add = i.files.reduce((n, f) => n + f.add, 0);
  const del = i.files.reduce((n, f) => n + f.del, 0);
  const work = [i.agent, i.worked ? `worked ${i.worked}` : 'worked', ...(i.steps ? [plural(i.steps, 'step')] : []), ...(i.files.length ? [`${plural(i.files.length, 'file')} changed (+${add} −${del})`] : [])];
  out.push('', work.join(' · '));
  for (const f of i.files.slice(0, FILES_MAX)) out.push(`  ${inside(f.path, i.cwd)}  +${f.add} −${f.del}`);
  if (i.files.length > FILES_MAX) out.push(`  and ${plural(i.files.length - FILES_MAX, 'more file')}`);
  if (i.answer?.trim()) out.push('', cut(i.answer, ANSWER_MAX));
  return out.join('\n');
}
