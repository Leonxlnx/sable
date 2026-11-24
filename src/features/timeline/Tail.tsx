import { memo, useState } from 'react';
import { worksInBackground } from '@shared/background';
import { tailLabel, workCounts } from '@shared/work-label';
import { Tiles } from '@/art/Logo';
import { Icon } from '@/icons';
import { showRailTab } from '@/state/actions';
import { changedSince } from '@/state/revision';
import { useStore, type SessionData } from '@/state/store';
import { useFresh, useTimeline } from './ctx';

const NO_WORK: WorkSince = { since: 0, monitors: 0 };
import { shortDuration, useTick } from './util';

/** `${turnStart}|${quiet}`: when the running turn began, and whether its last item is streaming prose. */
function tailInfo(data: SessionData | undefined): string {
  if (!data || !data.roots.length) return '0|0';
  const last = data.items[data.roots[data.roots.length - 1]];
  const quiet = !!last && (last.type === 'text' || last.type === 'thinking') && last.streaming;
  // Walking back to the previous turn: the earliest sent message since then started this one.
  let user = 0;
  let first = 0;
  for (let i = data.roots.length - 1, n = 0; i >= 0 && n < 600; i--, n++) {
    const it = data.items[data.roots[i]];
    if (!it) continue;
    if (it.type === 'turn') break;
    if (it.type === 'user' && it.state !== 'queued') user = it.ts;
    first = it.ts;
  }
  return `${user || first}|${quiet ? 1 : 0}`;
}

/**
 * When the oldest background command still running began (`ToolItem.task`, state running), or 0.
 * Follows the items write by write (`changedSince`): a write looks only at the items it changed, a
 * new timeline at every item once.
 */
export function commandsSince() {
  let items: object | null = null;
  let rev = -1;
  const running = new Map<string, number>();
  return (d: Pick<SessionData, 'items' | 'rev' | 'changed'> | undefined): number => {
    if (!d) return 0;
    if (d.items !== items || d.rev !== rev) {
      const changed = d.items === items ? changedSince(d, rev) : null;
      const look = (id: string) => {
        const it = d.items[id];
        if (it?.type === 'tool' && it.task?.state === 'running') running.set(id, it.task.since);
        else running.delete(id);
      };
      if (changed) for (const id of changed) look(id);
      else {
        running.clear();
        for (const id in d.items) look(id);
      }
      items = d.items;
      rev = d.rev;
    }
    let first = 0;
    for (const at of running.values()) if (!first || at < first) first = at;
    return first;
  };
}

/** What still works in the background, read from the items: when the oldest of it began, and how many of the commands are monitors. */
export interface WorkSince {
  /** When the oldest of everything still at work began (sub-agents, workflows, commands, monitors), or 0. */
  since: number;
  /** Running tasks that are monitors (the rest of `SessionMeta.commands` are commands). */
  monitors: number;
}

/**
 * `commandsSince` for all background work: running tasks (`ToolItem.task`) and sub-agents or
 * workflows still at work (`worksInBackground`), followed write by write the same way.
 */
export function workSince() {
  let items: object | null = null;
  let rev = -1;
  const running = new Map<string, { at: number; monitor: boolean }>();
  let out: WorkSince = { since: 0, monitors: 0 };
  return (d: Pick<SessionData, 'items' | 'rev' | 'changed'> | undefined): WorkSince => {
    if (!d) return { since: 0, monitors: 0 };
    if (d.items === items && d.rev === rev) return out;
    const changed = d.items === items ? changedSince(d, rev) : null;
    const look = (id: string) => {
      const it = d.items[id];
      if (it?.type === 'tool' && it.task?.state === 'running') running.set(id, { at: it.task.since, monitor: it.task.kind === 'monitor' });
      else if (it?.type === 'tool' && worksInBackground(it)) running.set(id, { at: it.ts, monitor: false });
      else running.delete(id);
    };
    if (changed) for (const id of changed) look(id);
    else {
      running.clear();
      for (const id in d.items) look(id);
    }
    items = d.items;
    rev = d.rev;
    let since = 0;
    let monitors = 0;
    for (const r of running.values()) {
      if (!since || r.at < since) since = r.at;
      if (r.monitor) monitors++;
    }
    if (since !== out.since || monitors !== out.monitors) out = { since, monitors };
    return out;
  };
}

/** "45s", "4m", "1h 5m": how long a background command has run, to the minute once past one. */
function waited(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The line under the transcript while the agent works: what it is doing and for how long (the
 * stop button and Esc stop it). It steps back while prose is streaming, since the words are the signal.
 * With the chat's own turn over but work it started still going (sub-agents, `SessionMeta.background`;
 * background commands, `SessionMeta.commands`), it says so, and opens the Agents tab: "Waiting for 1
 * background command · 4m" from the oldest command's start, "2 sub-agents working".
 */
export const Tail = memo(function Tail() {
  const { sessionId } = useTimeline();
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const activity = useStore((s) => s.sessions[sessionId]?.activity);
  const info = useStore((s) => tailInfo(s.data[sessionId]));
  const agents = useStore((s) => workCounts(s.sessions[sessionId] ?? {}).agents);
  const commands = useStore((s) => workCounts(s.sessions[sessionId] ?? {}).commands);
  const [read] = useState(workSince);
  const work = useStore((s) => (agents || commands ? read(s.data[sessionId]) : NO_WORK));
  const working = status === 'running' || status === 'starting';
  const background = !working && status !== 'awaiting' && (agents > 0 || commands > 0);
  const now = useTick(working || (background && work.since > 0));
  // Laid out with the chat (history): it simply stands. Only work that begins while the person
  // watches rises in.
  const fresh = useFresh();
  if (!working && status !== 'awaiting') {
    if (!background) return null;
    // The bridge's counts are the truth; the items only tell which commands are monitors.
    const label = tailLabel({ agents, commands, monitors: Math.min(work.monitors, commands) });
    const ran = work.since ? now - work.since : 0;
    return (
      <button type="button" className="tail tail-bg" data-enter={fresh || undefined} onClick={() => showRailTab('agents')} aria-label={`${label}. Open Agents`}>
        <span className="row-slot">
          <Tiles size={14} />
        </span>
        <span className="tail-label truncate">{label}</span>
        {ran >= 1000 && (
          <>
            <span className="tail-time" aria-hidden>
              ·
            </span>
            <span className="tail-time num">{waited(ran)}</span>
          </>
        )}
      </button>
    );
  }

  const [startRaw, quietRaw] = info.split('|');
  const start = Number(startRaw);
  const elapsed = start ? now - start : 0;

  if (status === 'awaiting') {
    return (
      <div className="tail" data-status="awaiting" data-enter={fresh || undefined} role="status">
        <span className="row-slot tail-wait-icon">
          <Icon name="hourglass" size={15} />
        </span>
        <span className="tail-wait">Waiting for you</span>
      </div>
    );
  }

  return (
    <div className="tail" data-status={status} data-enter={fresh || undefined} data-quiet={quietRaw === '1' || undefined} role="status" aria-live="off">
      <span className="row-slot">
        <Tiles size={14} />
      </span>
      <span className="tail-label shimmer truncate">{status === 'starting' ? 'Starting' : activity || 'Working'}</span>
      {elapsed >= 1000 && <span className="tail-time num">{shortDuration(elapsed)}</span>}
    </div>
  );
});
