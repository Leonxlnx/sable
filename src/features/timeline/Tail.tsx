import { memo, useState } from 'react';
import { workCounts, workLabel } from '@shared/work-label';
import { Tiles } from '@/art/Logo';
import { Icon } from '@/icons';
import { showRailTab } from '@/state/actions';
import { changedSince } from '@/state/revision';
import { useStore, type SessionData } from '@/state/store';
import { useTimeline } from './ctx';
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
  const [since] = useState(commandsSince);
  const oldest = useStore((s) => (commands ? since(s.data[sessionId]) : 0));
  const working = status === 'running' || status === 'starting';
  const now = useTick(working || (!agents && oldest > 0));
  if (!working && status !== 'awaiting') {
    if (!agents && !commands) return null;
    const label = agents ? workLabel({ background: agents, commands }) : `Waiting for ${commands} background ${commands === 1 ? 'command' : 'commands'}`;
    const ran = !agents && oldest ? now - oldest : 0;
    return (
      <button type="button" className="tail tail-bg" onClick={() => showRailTab('agents')} aria-label={`${label}. Open Agents`}>
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
      <div className="tail" data-status="awaiting" role="status">
        <span className="row-slot tail-wait-icon">
          <Icon name="hourglass" size={15} />
        </span>
        <span className="tail-wait">Waiting for you</span>
      </div>
    );
  }

  return (
    <div className="tail" data-status={status} data-quiet={quietRaw === '1' || undefined} role="status" aria-live="off">
      <span className="row-slot">
        <Tiles size={14} />
      </span>
      <span className="tail-label shimmer truncate">{status === 'starting' ? 'Starting' : activity || 'Working'}</span>
      {elapsed >= 1000 && <span className="tail-time num">{shortDuration(elapsed)}</span>}
    </div>
  );
});
