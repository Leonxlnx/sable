import { memo, useMemo, useState, type ReactNode } from 'react';
import type { ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, TOOL_ICON } from '@/icons';
import { lastDevUrl } from '@/lib/dev-url';
import { formatDuration, plural } from '@/lib/format';
import { PathLabel } from '@/ui';
import { DevUrlChip } from '@/features/rail/DevUrlChip';
import { stepOf, useJumpOpen } from '@/features/review/jump';
import { AgentBlock } from './Agent';
import { useTimeline } from './ctx';
import { ToolDetails } from './ToolDetails';
import { errorText, hasDetails, rowText } from './step-row';
import { isActive, partialJsonString, shortDuration, useTick } from './util';

/** Live seconds for a running call. Hidden for the first two seconds: most calls are done by then. */
export function Elapsed({ since }: { since: number }) {
  const now = useTick();
  const ms = now - since;
  if (ms < 2000) return null;
  return <span className="num">{shortDuration(ms)}</span>;
}

/** A finished call's own running time: time it spent waiting for the user (approvals) does not count. */
export const ownMs = (item: ToolItem): number => (item.endedAt ? Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)) : 0);

function duration(item: ToolItem, min = 1000): string | null {
  if (!item.endedAt) return null;
  const ms = ownMs(item);
  return ms >= min ? formatDuration(ms) : null;
}

/** The result at the right edge of a row, in tabular figures. Only the two marks carry colour. */
function ToolMeta({ item }: { item: ToolItem }) {
  const s = item.status;
  // Said once, in amber, by the turn's live line; the row only names what it waits for.
  if (s === 'awaiting') return <span>{item.kind === 'question' ? 'Waiting for your answer' : 'Needs your approval'}</span>;
  if (s === 'pending' || s === 'running') return <Elapsed since={item.ts} />;
  if (s === 'denied') return <span>Denied</span>;
  if (s === 'cancelled') return item.result?.interrupted ? <span>Interrupted</span> : <span>Cancelled</span>;
  const r = item.result;
  const parts: ReactNode[] = [];
  switch (item.kind) {
    case 'edit':
    case 'write': {
      const add = r?.diff?.reduce((n, d) => n + d.additions, 0) ?? 0;
      const del = r?.diff?.reduce((n, d) => n + d.deletions, 0) ?? 0;
      if (add) parts.push(<span className="t-add">+{add}</span>);
      if (del) parts.push(<span className="t-del">−{del}</span>);
      break;
    }
    case 'read':
      if (r?.file?.numLines) parts.push(plural(r.file.numLines, 'line'));
      break;
    case 'search':
      if (r?.count != null) parts.push(r.count ? plural(r.count, 'match', 'matches') : 'No matches');
      break;
    case 'glob':
      if (r?.count != null) parts.push(r.count ? plural(r.count, 'file') : 'No files');
      break;
    case 'websearch':
      if (r?.links) parts.push(plural(r.links.length, 'result'));
      break;
    case 'todo': {
      const todos = item.detail.todos;
      if (todos?.length) parts.push(`${todos.filter((t) => t.status === 'completed').length} of ${todos.length}`);
      break;
    }
    case 'bash':
      if (r?.exitCode) parts.push(<span className="tool-fail">exit {r.exitCode}</span>);
      break;
  }
  if (s === 'error' && item.kind !== 'bash') parts.unshift(<span className="tool-fail">Failed</span>);
  const d = duration(item, item.kind === 'bash' ? 100 : 1000);
  if (d && item.kind !== 'todo' && item.kind !== 'question') parts.push(d);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="num">
          {p}
        </span>
      ))}
    </>
  );
}

/** Rows start folded; an answered question shows its answers, since that is the whole point of it. */
function autoOpen(item: ToolItem): boolean {
  return item.kind === 'question' && item.status === 'done';
}

/** The last lines a running command printed, in a window of fixed height: the trail never jumps. */
function Peek({ text }: { text: string }) {
  const end = text.replace(/\s+$/, '');
  const lines = end.slice(Math.max(0, end.length - 600)).split('\n').slice(-3);
  return (
    <div className="peek" aria-hidden>
      <pre>{lines.join('\n')}</pre>
    </div>
  );
}

/** A running command shows its last lines once it has run this long (ms), as its seconds do. */
const PEEK_AFTER_MS = 2000;

/**
 * The dev server a command step announced (lib/dev-url.ts): in what it printed so far, or in its
 * result. Read again only when that text changes, and only text naming a loopback address is scanned.
 */
function useDevServer(item: ToolItem) {
  const bash = item.kind === 'bash';
  const output = bash ? item.output : undefined;
  const result = bash ? item.result?.text : undefined;
  const command = bash ? item.detail.command : undefined;
  return useMemo(() => (bash ? (lastDevUrl(output, command) ?? lastDevUrl(result, command)) : null), [bash, output, result, command]);
}

function ToolRow({ item }: { item: ToolItem }) {
  const { cwd, home } = useTimeline();
  const [choice, setChoice] = useState<boolean | null>(null);
  const expandable = hasDetails(item);
  const open = expandable && (choice ?? autoOpen(item));
  // The review bar's list jumps to a comment on this edit: the step opens to show it.
  useJumpOpen((r) => stepOf(r.scope) === item.id, () => setChoice(true), item.kind === 'edit' || item.kind === 'write');
  const active = isActive(item);
  const icon = TOOL_ICON[item.kind] ?? TOOL_ICON.other;
  const t = rowText(item, cwd, home);
  const error = errorText(item);
  // Only a command that runs a while opens its window (with the seconds, after 2 s): a quick one
  // never flashes it open and shut under the reader.
  const now = useTick(item.kind === 'bash' && active);
  const peek = item.kind === 'bash' && active && !open && !!item.output?.trim() && now - item.ts >= PEEK_AFTER_MS;
  const server = useDevServer(item);

  return (
    <div className="tool" data-status={item.status} data-open={open || undefined} data-server={server ? '' : undefined}>
      <button type="button" className="row-btn tool-row" aria-expanded={expandable ? open : undefined} data-static={!expandable || undefined} tabIndex={expandable ? undefined : -1} onClick={() => expandable && setChoice(!open)}>
        <span className="tool-icon">
          <Icon name={icon.icon} size={14} />
        </span>
        <span className={active ? 'tool-title shimmer' : 'tool-title'}>{t.verb}</span>
        {t.path && <PathLabel path={t.path} className="tool-target truncate" />}
        {t.sub && <span className="tool-sub truncate">{t.sub}</span>}
        <span className="tool-meta">
          <ToolMeta item={item} />
        </span>
        {expandable && <Icon name="caret-right" size={10} className="row-caret" />}
      </button>
      {/* A command that started a dev server: its address and "Open" answer on hover or focus, over the row's end. */}
      {server && <DevUrlChip url={server.url} label={server.label} cwd={cwd} from={item.detail.command?.split('\n')[0]} className="tool-server" />}
      {error && !open && <pre className="tool-error">{error}</pre>}
      {item.kind === 'bash' && (
        <Collapse open={peek}>
          <Peek text={item.output ?? ''} />
        </Collapse>
      )}
      {expandable && (
        <Collapse open={open}>
          <div className="tool-details" inert={item.more} aria-busy={item.more}>
            <ToolDetails item={item} />
          </div>
        </Collapse>
      )}
    </div>
  );
}

// ─────────────────────────────────── plan ───────────────────────────────────

function PlanCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(true);
  const typing = !item.detail.plan && item.input === undefined;
  const plan = item.detail.plan ?? partialJsonString(item.inputText, 'plan') ?? '';
  const state =
    item.status === 'awaiting'
      ? 'Needs your approval'
      : item.status === 'done'
        ? 'Approved'
        : item.status === 'denied'
          ? 'Kept planning'
          : item.status === 'cancelled'
            ? 'Cancelled'
            : item.status === 'error'
              ? 'Failed'
              : null;

  return (
    <div className="plan" data-status={item.status} data-spot>
      <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="agent-icon">
          <Icon name="compass" size={15} />
        </span>
        <span className={typing ? 'plan-title shimmer' : 'plan-title'}>{typing ? 'Writing the plan' : 'Plan'}</span>
        <span className="tool-meta">{state && <span className={item.status === 'error' ? 'tool-fail' : undefined}>{state}</span>}</span>
        <Icon name="caret-right" size={11} className="row-caret" />
      </button>
      <Collapse open={open && !!plan}>
        <div className="plan-body">
          <Markdown text={plan} streaming={typing} />
        </div>
      </Collapse>
    </div>
  );
}

/** Any tool call. Plans are cards; everything else, sub-agents included, is one compact row. */
export const ToolView = memo(function ToolView({ item }: { item: ToolItem }) {
  if (item.kind === 'agent') return <AgentBlock item={item} />;
  if (item.kind === 'plan') return <PlanCard item={item} />;
  return <ToolRow item={item} />;
});
