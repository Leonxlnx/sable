import type { Attachment, ThinkingItem, ToolItem } from '@shared/protocol';
import { relPath } from '@/lib/format';

/**
 * What the row says: the verb, then its target. A file is a path in the interface face (folder dim,
 * name regular); a command or a folder follows as a quieter phrase.
 */
export function rowText(item: ToolItem, cwd: string, home: string): { verb: string; path?: string; sub?: string } {
  const d = item.detail;
  switch (item.kind) {
    case 'read':
    case 'edit':
    case 'write': {
      if (!d.path) return { verb: item.title };
      const rel = relPath(d.path, cwd, home);
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const verb = item.title.endsWith(base) ? item.title.slice(0, -base.length).trim() : '';
      return verb ? { verb, path: rel } : { verb: item.title };
    }
    case 'bash': {
      if (!d.command) return { verb: item.title };
      const text = d.command.slice(0, 400).split('\n')[0];
      const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
      // Codex titles a command with the command itself: say it once.
      return norm(text) && norm(text) !== norm(item.title.slice(0, 400)) ? { verb: item.title, sub: text } : { verb: item.title };
    }
    case 'search': {
      const where = d.glob ?? (d.path ? relPath(d.path, cwd, home) : '');
      return { verb: item.title, sub: where && where !== '.' ? `in ${where}` : undefined };
    }
    // The task strip over the composer carries the live task; the trail only records the list's count.
    case 'todo':
      return { verb: 'Tasks' };
    case 'skill':
      return { verb: item.title, sub: d.description };
    case 'mcp':
      return { verb: item.title, sub: d.server && d.tool && !item.title.includes(d.tool) ? `${d.server} · ${d.tool}` : undefined };
    default:
      return { verb: item.title };
  }
}

/** Whether a row has anything to reveal. */
export function hasDetails(item: ToolItem): boolean {
  const r = item.result;
  const d = item.detail;
  switch (item.kind) {
    case 'bash':
      return !!d.command || !!item.output || !!r?.text;
    case 'edit':
    case 'write':
      return true;
    case 'read':
      return !!r?.file?.content || !!d.path;
    case 'todo':
      return !!d.todos?.length;
    case 'question':
      return !!d.questions?.length;
    case 'skill':
      return !!r?.text || !!d.skill;
    default:
      return !!r || item.input !== undefined || (!!item.more && item.inputText === '…') || !!d.pattern || !!d.query || !!d.url;
  }
}

/** First lines of what went wrong, shown under the row without opening it. */
export function errorText(item: ToolItem): string | null {
  if (item.status !== 'error' || item.kind === 'bash') return null;
  const text = (item.result?.stderr || item.result?.text || '').trim();
  if (!text) return null;
  const lines = text.split('\n');
  return lines.length > 3 ? lines.slice(0, 3).join('\n') + '\n…' : text;
}

export const hasThumbnail = (a: Attachment, cut?: boolean) => a.kind === 'image' && (!!a.dataUrl || (!!cut && a.dataUrl === ''));

export function thinkingRow(item: ThinkingItem, show: boolean) {
  return { label: item.streaming ? 'Thinking' : 'Thought', canOpen: show && !!item.text.trim() };
}
