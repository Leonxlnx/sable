import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ProviderId, SessionMeta, TimelineItem, ToolItem } from '@shared/protocol';
import { servingLabel, waited } from '@shared/work-label';
import { jobAgent, progressIndex, readProgress } from '@desk/features/rail/now-model';
import { canStop } from '@m/lib/chat-rules';
import { conn } from '@m/lib/conn';
import { clockOf, liveWords, useSecond } from '@m/lib/live-words';
import { haptic } from '@m/lib/native';
import { applyChildren, fetchItem, sessionData, setState, useStore } from '@m/lib/store';
import { workKey, workNow } from '@m/lib/work-now';
import { PROVIDER_NAME, ProviderMark, Tiles } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';

/**
 * "Working now" (2.22): the desktop's Agents tab at hand size, for one chat. A tap on the chat's
 * working line under its title, or on the conversation's last line while background work goes on,
 * raises it. What works now, in one grammar (the desktop's cards: the working mark, the title, who,
 * how long; under it what it does now): the chat's own turn first while it runs, with Stop (asks
 * once; the phone's only stop, `session.interrupt`), then its sub-agents and workflows, tracked jobs
 * and background commands, the longest runner first (src/features/rail/now-model.ts `nowRows`),
 * servers apart and quiet. The rows are read from the conversation the phone holds; work the bridge
 * counts in an older part of the chat is one quiet line. A working sub-agent's steps are asked of the
 * desktop as the sheet opens, so its line says the step it is on.
 */

let openFor: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Raises the sheet for a chat (its header's working line, the conversation's last line). */
export function openWorkSheet(id: string) {
  openFor = id;
  emit();
}

function useOpenFor(): string | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => openFor,
  );
}

const toast = (text: string) => setState({ toast: { text, level: 'error', at: Date.now() } });

export function WorkSheet({ id }: { id: string }) {
  const open = useOpenFor() === id;
  // Leaving the chat closes it (the next chat's sheet starts closed).
  useEffect(() => () => void (openFor === id && ((openFor = null), emit())), [id]);
  return (
    <Sheet open={open} onClose={() => ((openFor = null), emit())} title="Working now" className="wn-sheet">
      {open && <WorkList id={id} />}
    </Sheet>
  );
}

function WorkList({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  const key = useStore((st) => workKey(workNow(sessionData(st, id).items, st.sessions[id])));
  const w = useMemo(() => {
    const [rows, servers, unseen] = key.split('|');
    return {
      rows: rows ? rows.split(',').map((r) => ({ kind: r.slice(0, r.indexOf(':')) as 'agent' | 'job' | 'command', id: r.slice(r.indexOf(':') + 1) })) : [],
      servers: servers ? servers.split(',') : [],
      unseen: Number(unseen) || 0,
    };
  }, [key]);
  const own = !!s && (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting');
  const now = useSecond(true);
  // A working sub-agent's steps stay on the desktop until asked for: asked once as the sheet opens.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const r of w.rows) {
      if (r.kind !== 'agent' || asked.current.has(r.id)) continue;
      asked.current.add(r.id);
      void fetchItem(id, r.id).then((res) => applyChildren(id, r.id, res.children), () => {});
    }
  }, [id, w.rows]);
  if (!s) return null;
  const nothing = !own && !w.rows.length && !w.servers.length && !w.unseen;
  return (
    <div className="wn-list" role="list">
      {own && <TurnRow s={s} now={now} />}
      {w.rows.map((r) => (r.kind === 'agent' ? <AgentRow key={r.id} sid={id} id={r.id} now={now} /> : r.kind === 'job' ? <JobRow key={r.id} sid={id} id={r.id} now={now} /> : <CommandRow key={r.id} sid={id} id={r.id} now={now} />))}
      {w.unseen > 0 && <p className="wn-more">{w.unseen === 1 ? '1 more in an older part of this chat.' : `${w.unseen} more in an older part of this chat.`}</p>}
      {w.servers.map((sid) => (
        <ServerRow key={sid} sid={id} id={sid} />
      ))}
      {nothing && <p className="wn-empty">Nothing is working.</p>}
    </div>
  );
}

/** One row in the desktop card's grammar: the mark, the title, who, how long; under it what it does now. */
function Row({ mark, title, who, time, now, quiet, end }: { mark: React.ReactNode; title: string; who?: React.ReactNode; time?: string; now?: React.ReactNode; quiet?: boolean; end?: React.ReactNode }) {
  return (
    <div className="wn-row" role="listitem" data-quiet={quiet || undefined}>
      <span className="wn-mark" aria-hidden>
        {mark}
      </span>
      <span className="wn-main">
        <span className="wn-line">
          <span className="wn-title">{title}</span>
          {who}
          {time && <span className="wn-time num">{time}</span>}
        </span>
        {(now || end) && (
          <span className="wn-sub">
            <span className="wn-now">{now}</span>
            {end}
          </span>
        )}
      </span>
    </div>
  );
}

/** The chat's own turn: what it does by kind ("Editing 3 files"), its steps and its clock, and Stop, which asks once. */
function TurnRow({ s, now }: { s: SessionMeta; now: number }) {
  const w = liveWords(s);
  const first = useRef(now);
  const online = useStore((st) => st.conn === 'open');
  const [ask, setAsk] = useState(false);
  const waiting = s.status === 'awaiting';
  const stop = () => {
    if (!ask) {
      haptic('tap');
      setAsk(true);
      window.setTimeout(() => setAsk(false), 3000);
      return;
    }
    haptic('warning');
    setAsk(false);
    void conn.call('session.interrupt', { sessionId: s.id }).catch((err: Error) => toast(err.message));
  };
  return (
    <Row
      mark={waiting ? <i className="wn-wait" /> : <Tiles size={14} />}
      title={PROVIDER_NAME[s.provider]}
      time={clockOf(now - (w.since ?? first.current))}
      now={
        <>
          {waiting ? 'Waiting for you' : w.line}
          {!waiting && w.steps > 0 && <span className="wn-steps num">{w.steps === 1 ? '1 step' : `${w.steps} steps`}</span>}
        </>
      }
      end={
        canStop(s.status) ? (
          <button type="button" className="now-stop wn-stop" data-ask={ask || undefined} disabled={!online} onClick={stop} aria-label={ask ? 'Stop now' : 'Stop'}>
            <span className="stop-square sm" aria-hidden />
            <span>{ask ? 'Stop now' : 'Stop'}</span>
          </button>
        ) : undefined
      }
    />
  );
}

const ago = (now: number, at: number | undefined) => (at && now - at >= 1000 ? waited(now - at) : undefined);

/** The other agent a handed-over task runs on (delegate_to_codex / delegate_to_claude). */
function handedTo(it: ToolItem): ProviderId | undefined {
  const n = (it.name ?? '').toLowerCase();
  if (n.endsWith('delegate_to_codex')) return 'codex';
  if (n.endsWith('delegate_to_claude')) return 'claude';
  return undefined;
}

function AgentRow({ sid, id, now }: { sid: string; id: string; now: number }) {
  const it = useStore((st) => sessionData(st, sid).items[id]) as ToolItem | undefined;
  const [read] = useState(progressIndex);
  // How far it is, as one string: the row renders when that changes, never on a streamed word.
  const p = readProgress(useStore((st) => read(sessionData(st, sid).items as Record<string, TimelineItem | undefined>, sessionData(st, sid).children[id])));
  if (!it) return null;
  const other = handedTo(it);
  const bg = it.status !== 'running' && it.status !== 'pending' && it.status !== 'awaiting';
  const steps = Math.max(p.steps, it.result?.agent?.steps ?? 0);
  const doing = p.waiting ? 'Needs your approval' : p.now || (bg ? 'Working in the background' : 'Starting');
  return (
    <Row
      mark={<Tiles size={14} />}
      title={it.detail?.description || it.title}
      who={other ? <ProviderMark provider={other} size={13} /> : undefined}
      time={ago(now, it.ts)}
      now={
        <>
          {doing}
          {steps > 0 && <span className="wn-steps num">{steps === 1 ? '1 step' : `${steps} steps`}</span>}
        </>
      }
    />
  );
}

function JobRow({ sid, id, now }: { sid: string; id: string; now: number }) {
  const it = useStore((st) => sessionData(st, sid).items[id]) as ToolItem | undefined;
  const t = it?.tracked;
  if (!it || !t) return null;
  const by = t.by ?? it.detail?.description;
  const agent = jobAgent(by);
  return (
    <Row
      mark={<Tiles size={14} />}
      title={it.title}
      who={agent ? <ProviderMark provider={agent} size={13} /> : by ? <span className="wn-by">{by}</span> : undefined}
      time={ago(now, t.since)}
      now={t.line}
    />
  );
}

function CommandRow({ sid, id, now }: { sid: string; id: string; now: number }) {
  const it = useStore((st) => sessionData(st, sid).items[id]) as ToolItem | undefined;
  if (!it) return null;
  const name = it.detail?.description || it.title;
  const command = it.detail?.command && it.detail.command !== name ? it.detail.command : undefined;
  return <Row mark={<Tiles size={14} />} title={name} time={ago(now, it.task?.since ?? it.ts)} now={command ?? (it.task?.kind === 'monitor' ? 'Watching' : 'Running')} />;
}

/** A command that serves (a dev server, a watcher): no work, a quiet row after it. */
function ServerRow({ sid, id }: { sid: string; id: string }) {
  const it = useStore((st) => sessionData(st, sid).items[id]) as ToolItem | undefined;
  if (!it) return null;
  const at = typeof it.task?.serving === 'string' ? it.task.serving : undefined;
  // The row's own word, as the desktop's Agents tab says it: "Serving", with the address when one is known
  // (the chat-level line "Serving 1 local server" counts servers; under one row it read oddly).
  return <Row quiet mark={<i className="wn-dash" />} title={it.detail?.description || it.title} now={at ? (servingLabel({ serving: 1, servingAddress: at }) ?? 'Serving') : 'Serving'} />;
}
