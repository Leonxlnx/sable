import { emptyIndex } from '@/state/revision';
import { HistoryStatus } from '@/features/session/HistoryStatus';
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { TaskMark, ToolItem, WorkflowRun } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { worksInBackground } from '@shared/background';
import { ProviderMark, Ring } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { agentProvider, agentTask, isAgentLive, workflowGlance } from '@/features/timeline/agent-line';
import { TimelineCtx, type TimelineCtxValue } from '@/features/timeline/ctx';
import { foldKey, getFold, setFold, useFold } from '@/features/timeline/fold';
import { revealItem } from '@/features/timeline/reveal';
import { shortDuration, useHeld } from '@/features/timeline/util';
import { clock } from '@/features/usage/format';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { AgentDetail } from './AgentDetail';
import { ShownCtx, indexFor, usePaneTick, useProgress, useShown } from './agents-hooks';
import { OUTCOME_WORD, STATE_MARK, agentState, agentsHeader, commandRowState, commandState, commandsView, figuresOf, liveKey, outcomeOf, overview, ownerAgent, promptLine, readProgress, waveOpen, waveRows, workflowNow, type CommandState, type Progress, type RowState } from './agents-model';
import { LeaveList } from './leave';
import './agents.css';

/** How many sub-agents and workflows are working now: the figure beside the tab's icon. */
export function useLiveAgentCount(sessionId: string): number {
  const { agents } = indexFor(sessionId);
  return useStore((s) => {
    const d = s.data[sessionId];
    const ids = agents(d);
    let n = 0;
    for (const id of ids) if (isAgentLive(d?.items[id] as ToolItem | undefined)) n++;
    return n;
  });
}

/** Where the open state of a row is remembered (apart from the conversation's own blocks). */
const SCOPE = 'agents-tab';

/** The conversation's context, for the opened details (file links in a report). */
const ON = { current: true };

/** More working agents than this and their section scrolls by itself, so the finished ones stay in reach. */
const MANY = 4;

/** The fold of the background commands, among the waves' own. */
const COMMANDS = '\u0000commands';

/**
 * Every sub-agent and workflow of the session, as an overview.
 *
 * Who works now stands first and stays in view while the rest scrolls under it: a card each, the
 * longest runner on top, with its time, what it does now and how far it is when it says (its task
 * list, a workflow's phases). What finished follows as one line each (how it ended or how long it
 * took), gathered into waves: everything one message of the person's set going, the newest wave
 * first and open, older ones folded to a line once the list is long, what failed first in each. A
 * notification the harness wrote ("Background task finished: …") never names a wave. The chat's
 * background commands are a group of their own under the agents. A row opens in place.
 *
 * Long lists are cheap: a folded wave renders one line, an open one at most a few rows until asked
 * for all, and the model behind it (`agents-model.ts`) scans only what joined since it last looked.
 *
 * `active`: the pane is on screen. Hidden (another tab, the panel closed) it holds still.
 */
export function AgentsTab({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const reading = useStore(s => !!s.data[sessionId]?.incomplete);
  if (reading) return <div className="rail-col" role="status"><HistoryStatus sessionId={sessionId} /></div>;
  return (
    <ShownCtx.Provider value={active}>
      <AgentsList sessionId={sessionId} />
    </ShownCtx.Provider>
  );
}

function AgentsList({ sessionId }: { sessionId: string }) {
  const { agents, users, notes, commands } = indexFor(sessionId);
  const ids = useShown((s) => agents(s.data[sessionId]));
  const live = useShown((s) => liveKey(s.data[sessionId]?.items, agents(s.data[sessionId])));
  const asked = useShown((s) => users(s.data[sessionId]));
  // The commands follow their own state too (a task started, ended, lost): see `commandsView`.
  const readCommands = useMemo(() => commandsView(commands, notes), [commands, notes]);
  const cmds = useShown((s) => readCommands(s.data[sessionId]));
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live: ON, stuck: ON }), [sessionId, cwd, home]);

  const view = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    return overview(ids, live, d?.items ?? emptyIndex, asked, d?.roots);
  }, [ids, live, asked, sessionId]);

  // What the person opened or closed (waves, the commands) and where they asked for every row.
  // Remembered with the rows' own folds while the app is open.
  const [, redraw] = useState(0);
  const chosen = (key: string) => getFold(foldKey(sessionId, key, SCOPE));
  const all = (key: string) => !!getFold(foldKey(sessionId, `${key}\u0000all`, SCOPE));
  const flip = useCallback(
    (key: string, to: boolean) => {
      setFold(foldKey(sessionId, key, SCOPE), to);
      redraw((n) => n + 1);
    },
    [sessionId],
  );

  // `key` is the row's place in the list (what moves); `as` tells a card from a row for entrances.
  const rows: { key: string; as: string; node: (fresh: boolean) => ReactNode }[] = [];
  const working = view.working.join('|');
  if (working) rows.push({ key: 'working', as: 'working', node: () => <Working key="working" sessionId={sessionId} order={working} /> });
  // A wave gets its line when there is more than one, or commands beside it: one wave alone is simply the list.
  const headed = view.waves.length > 1 || cmds.ids.length > 0;
  view.waves.forEach((w, i) => {
    const open = !headed || waveOpen(i, view.done, chosen(w.user));
    if (headed) {
      const hk = `h:${w.user}`;
      rows.push({ key: hk, as: hk, node: (fresh) => <WaveHead key={hk} sessionId={sessionId} user={w.user} count={w.ids.length} failed={w.failed} open={open} onFlip={flip} fresh={fresh} /> });
    }
    if (!open) return;
    const shown = waveRows(w, all(w.user));
    for (const id of shown.ids) rows.push({ key: id, as: `D${id}`, node: (fresh) => <DoneRow key={id} sessionId={sessionId} id={id} fresh={fresh} /> });
    if (shown.more) {
      const mk = `m:${w.user}`;
      rows.push({ key: mk, as: mk, node: () => <MoreRow key={mk} id={mk} group={w.user} count={shown.more} onFlip={flip} /> });
    }
  });
  if (cmds.ids.length) {
    // A few stand open; many fold to their line unless one runs or failed.
    const open = chosen(COMMANDS) ?? (cmds.ids.length <= 4 || cmds.running > 0 || cmds.serving > 0 || cmds.failed > 0);
    rows.push({ key: 'h:cmd', as: 'h:cmd', node: (fresh) => <GroupHead key="h:cmd" id="h:cmd" group={COMMANDS} label="Commands" count={cmds.ids.length} running={cmds.running} serving={cmds.serving} failed={cmds.failed} always open={open} onFlip={flip} fresh={fresh} /> });
    if (open) {
      // Everything running shows, as every failure does (`waveRows` lists those first).
      const shown = waveRows({ user: COMMANDS, ids: cmds.ids, failed: cmds.running + cmds.serving + cmds.failed }, all(COMMANDS));
      for (const id of shown.ids) rows.push({ key: `c:${id}`, as: `c:${id}`, node: (fresh) => <CommandRow key={`c:${id}`} sessionId={sessionId} id={id} fresh={fresh} /> });
      if (shown.more) rows.push({ key: 'm:cmd', as: 'm:cmd', node: () => <MoreRow key="m:cmd" id="m:cmd" group={COMMANDS} count={shown.more} onFlip={flip} /> });
    }
  }
  // The tail line's units (sub-agents and commands that work now), then how many ended.
  const head = agentsHeader({ serving: cmds.serving, working: view.working.length, running: cmds.running, agentsDone: view.done, agentsFailed: view.failed, commands: cmds.ids.length, commandsFailed: cmds.failed });
  const keys = rows.map((r) => r.key);
  const arrived = useEntrances(rows.map((r) => r.as));

  if (!ids.length && !cmds.ids.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No agents in this session yet.</p>
      </div>
    );
  }

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title">Agents</span>
        {/* How many work now (and which commands run); once none does, how many there were. What failed is said beside it. */}
        <span className="rail-bar-meta num">
          {head.label}
          {head.failed > 0 && <span className="agx-bar-failed">{head.label ? ' · ' : ''}{head.failed} failed</span>}
        </span>
      </div>
      <div className="rail-scroll scroll agx-scroll">
        <TimelineCtx.Provider value={ctx}>
          <LeaveList className="agx-list" order={keys.join('|')}>
            {rows.map((r) => r.node(arrived.has(r.as)))}
          </LeaveList>
        </TimelineCtx.Provider>
      </div>
    </div>
  );
}

/**
 * Rows that joined a list on screen, which rise into place once (a card among the working, a row
 * among the finished: an agent that ends leaves the one and rises into the other). Not the first
 * set, not a batch, not a run of arrivals in quick succession: those simply appear.
 */
function useEntrances(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const last = useRef(0);
  if (!seen.current) seen.current = new Set(keys);
  else {
    const news = keys.filter((k) => !seen.current!.has(k));
    if (news.length) {
      const now = performance.now();
      const calm = news.length <= 6 && now - last.current > 400;
      last.current = now;
      for (const k of news) {
        seen.current.add(k);
        if (calm) fresh.current.add(k);
      }
    }
  }
  return fresh.current;
}

// ── a group's line ──

/**
 * One line over a group of rows: when it began, what it is, how many, and while folded what failed
 * in it (`always`: also open, with what runs in it, as the commands' line says "1 running 4 failed").
 * It folds the group.
 */
const GroupHead = memo(function GroupHead({ id, group, time, label, count, running = 0, serving = 0, failed, always, open, onFlip, fresh, title }: { id: string; group: string; time?: string; label: string; count: number; running?: number; serving?: number; failed: number; always?: boolean; open: boolean; onFlip: (key: string, to: boolean) => void; fresh: boolean; title?: string }) {
  return (
    <div role="listitem" data-flip={id} className="agx-wave" data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-wave-btn" aria-expanded={open} onClick={() => onFlip(group, !open)} title={title}>
        <span className="agx-mark" aria-hidden>
          <Icon name="caret-right" size={10} weight="bold" className="agx-caret" />
        </span>
        {time && <span className="agx-wave-time num">{time}</span>}
        <span className="agx-wave-label truncate">{label}</span>
        {running > 0 && <span className="agx-wave-count num">{running} running</span>}
        {serving > 0 && <span className="agx-wave-count num">{serving} serving</span>}
        {/* Folded, the line says what failed inside; open, the failed rows stand first under it. */}
        {failed > 0 && (always || !open) && <span className="agx-wave-failed num">{failed} failed</span>}
        <span className="agx-wave-count num">{count}</span>
      </button>
    </div>
  );
});

/** A wave's line: the first words of the message that set its agents going, under the time it was sent. */
const WaveHead = memo(function WaveHead({ sessionId, user, count, failed, open, onFlip, fresh }: { sessionId: string; user: string; count: number; failed: number; open: boolean; onFlip: (key: string, to: boolean) => void; fresh: boolean }) {
  const item = useShown((s) => (user ? s.data[sessionId]?.items[user] : undefined));
  const text = item?.type === 'user' ? promptLine(userItemText(item)) : 'Earlier';
  return <GroupHead id={`h:${user}`} group={user} time={item ? clock(item.ts) : undefined} label={text} title={text} count={count} failed={failed} open={open} onFlip={onFlip} fresh={fresh} />;
});

/** What an open group holds back. */
const MoreRow = memo(function MoreRow({ id, group, count, onFlip }: { id: string; group: string; count: number; onFlip: (key: string, to: boolean) => void }) {
  return (
    <div role="listitem" data-flip={id} className="agx-more-row">
      <button type="button" className="agx-more-btn num" onClick={() => onFlip(`${group}\u0000all`, true)}>
        Show {count} more
      </button>
    </div>
  );
});

// ── working now ──

/**
 * Who works now, as one block that stays at the top of the pane. `order`: their ids, joined: the
 * block renders when that changes (one started, one ended), never when the finished list does.
 */
const Working = memo(function Working({ sessionId, order }: { sessionId: string; order: string }) {
  const ids = useMemo(() => order.split('|'), [order]);
  const arrived = useEntrances(ids);
  const many = ids.length > MANY;
  return (
    <div role="listitem" data-flip="working" className={many ? 'agx-working scroll' : 'agx-working'} data-many={many || undefined} aria-label="Working now">
      <LeaveList className="agx-cards" order={order}>
        {ids.map((id) => (
          <LiveCard key={id} sessionId={sessionId} id={id} fresh={arrived.has(id)} />
        ))}
      </LeaveList>
    </div>
  );
});

const LiveCard = memo(function LiveCard({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  const progress = readProgress(useProgress(sessionId, id));
  if (!item) return null;
  const awaiting = item.status === 'awaiting' || !!progress.waiting;
  const provider = agentProvider(item) ?? item.check?.agent ?? null;
  const toggle = () => setOpen(!open);
  return (
    <div role="listitem" data-flip={id} className="agx-card" data-spot="" data-open={open || undefined} data-new={fresh || undefined} data-awaiting={awaiting || undefined}>
      <button type="button" className="agx-card-btn" aria-expanded={open} onClick={toggle}>
        <span className="agx-line">
          {/* Its state first, as every row: amber while it waits for you, else the ring. */}
          <StateMark state={awaiting ? 'waiting' : 'running'} />
          <span className="sr-only">{awaiting ? 'Waiting for you' : 'Working'}</span>
          <span className="agx-title truncate">{agentTask(item)}</span>
          {provider && <Who provider={provider} />}
          <span className="agx-time num">
            <Since ts={item.ts} />
          </span>
        </span>
        {item.workflow ? <WorkflowLive run={item.workflow} /> : <AgentLive item={item} progress={progress} awaiting={awaiting} />}
      </button>
      <Collapse open={open}>
        <AgentDetail sessionId={sessionId} item={item} live />
      </Collapse>
    </div>
  );
});

/** Its time so far, ticking once a second while the pane shows. */
function Since({ ts }: { ts: number }) {
  const now = usePaneTick();
  const ms = now - ts;
  return ms >= 1000 ? shortDuration(ms) : null;
}

/**
 * A sub-agent's live line: what it does now (its steps are in the opened card). Its own task list,
 * when it keeps one, as a thin meter: the only honest measure of how far it is.
 */
function AgentLive({ item, progress: p, awaiting }: { item: ToolItem; progress: Progress; awaiting: boolean }) {
  // A run of quick steps reads as a calm sequence of titles, not a flicker.
  const now = useHeld(p.now, 700);
  const bg = item.status === 'done' && worksInBackground(item);
  const doing = awaiting ? 'Needs your approval' : now || (bg && !p.steps ? 'Working in the background' : 'Starting');
  return (
    <>
      <span className="agx-sub">
        <span className={awaiting ? 'agx-now agx-now-wait' : 'agx-now'}>
          <span className={awaiting ? undefined : 'shimmer'} key={doing}>
            {doing}
          </span>
        </span>
        {/* How much it has done: the one figure that tells a long runner that works from one that is stuck. */}
        {p.steps > 0 && <span className="agx-steps-n num">{p.steps === 1 ? '1 step' : `${p.steps} steps`}</span>}
      </span>
      {p.todo && (
        <span className="agx-progress">
          <span
            className="meter agx-meter"
            role="progressbar"
            aria-label={`${p.todo.done} of ${p.todo.total} tasks done`}
            aria-valuemin={0}
            aria-valuemax={p.todo.total}
            aria-valuenow={p.todo.done}
          >
            <span className="meter-fill" style={{ '--p': p.todo.done / Math.max(1, p.todo.total) } as CSSProperties} />
          </span>
        </span>
      )}
    </>
  );
}

/** A workflow's live lines: its phase and what one of its agents does now; the phases as segments. */
function WorkflowLive({ run }: { run: WorkflowRun }) {
  const w = workflowNow(run);
  const now = useHeld(w.doing, 700);
  const g = workflowGlance(run);
  const count = Math.max(1, g.phases);
  return (
    <>
      <span className="agx-sub">
        <span className="agx-now">
          {w.title && g.phases > 1 && <span className="agx-phase">{w.title}</span>}
          <span className="shimmer" key={now}>
            {now || 'Starting'}
          </span>
        </span>
        {w.agents > 0 && (
          <span className="agx-steps-n num">
            {w.done} of {w.agents}
          </span>
        )}
      </span>
      <span className="agx-phases" role="img" aria-label={[w.phase || 'One phase', w.agents ? `${w.done} of ${w.agents} agents done` : ''].filter(Boolean).join(', ')}>
        {Array.from({ length: count }, (_, i) => {
          const index = i + 1;
          const state = index < g.phase ? 'done' : index === g.phase || (count === 1 && g.agents > 0) ? 'now' : 'next';
          const mine = run.agents.filter((a) => (a.phase ?? 1) === index);
          const fill = state === 'done' ? 1 : state === 'now' && mine.length ? mine.filter((a) => a.state === 'done' || a.state === 'error').length / mine.length : 0;
          return (
            <span key={index} className="agx-seg" data-state={state}>
              <span className="agx-seg-fill" style={{ transform: `scaleX(${fill})` }} />
            </span>
          );
        })}
      </span>
    </>
  );
}

// ── a row's state ──

/** The mark every row of the tab leads with: where it stands (`STATE_MARK`), never what kind it is. */
function StateMark({ state }: { state: RowState }) {
  const m = STATE_MARK[state];
  return (
    <span className="agx-mark" data-state={state} aria-hidden>
      {m === 'ring' ? <Ring size={12} label={null} /> : m === 'wait' ? <span className="agx-wait-dot" /> : <Icon name={m} size={m === 'x' ? 11 : m === 'check' ? 12 : 13} weight={m === 'x' ? 'bold' : undefined} />}
    </span>
  );
}

/** A hand-over's agent (the other agent did the work), after the task, quiet. */
function Who({ provider }: { provider: NonNullable<ReturnType<typeof agentProvider>> }) {
  return (
    <span className="agx-who" aria-hidden>
      <ProviderMark provider={provider} size={12} />
    </span>
  );
}

// ── done ──

/**
 * A finished agent: its task and one figure, in the cards' columns. A plain done row carries a
 * quiet check; a failure has the red cross, a hand-over its agent's mark, a workflow its tree. An outcome other than done is said in words where the time would stand; its
 * tokens and steps, and when it finished, are in the opened row.
 */
const DoneRow = memo(function DoneRow({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  // A background agent's call returned at once: its notification says when it ended.
  const noted = useShown((s) => indexFor(sessionId).notes(s.data[sessionId]).get(id)?.ts ?? 0);
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!item) return null;
  const outcome = outcomeOf(item);
  const f = figuresOf(item);
  const provider = agentProvider(item) ?? item.check?.agent ?? null;
  const word = outcome === 'done' ? '' : OUTCOME_WORD[outcome];
  const launched = !!item.result?.agent?.background || !!item.detail.background;
  const endedAt = noted || (launched ? 0 : (item.endedAt ?? 0));
  return (
    <div role="listitem" data-flip={id} className="agx-row" data-outcome={outcome} data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-row-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateMark state={agentState(outcome)} />
        <span className="agx-title truncate">{agentTask(item)}</span>
        {provider && <Who provider={provider} />}
        <span className="agx-meta num">
          {word ? <span className="agx-outcome">{word}</span> : <span className="sr-only">Done</span>}
          {!word && f.ms >= 1000 && <span className="agx-dur">{shortDuration(f.ms)}</span>}
        </span>
      </button>
      <Collapse open={open}>
        <AgentDetail sessionId={sessionId} item={item} live={false} endedAt={endedAt} />
      </Collapse>
    </div>
  );
});

// ── background commands ──

/** What a command's row says of where it stands; a running one adds how long it has run, an unknown one when it started. */
const COMMAND_WORD: Record<CommandState, string> = {
  starting: 'Starting',
  running: 'Running',
  serving: 'Serving',
  done: '',
  failed: 'Failed',
  stopped: 'Stopped',
  lost: "Lost with the agent's process",
  unknown: 'Started',
};

/** Why a command was lost (`TaskMark.why`), where it was not simply its process that went. */
const LOST_WORD: Partial<Record<NonNullable<TaskMark['why']>, string>> = {
  move: 'Lost when the chat moved',
  restart: 'Lost when Sable closed',
  limit: 'Lost at the plan limit',
};

/**
 * A command the agent left running in the background: what it is and where it stands, as the
 * bridge says (`ToolItem.task`: running with its time so far, how it ended, lost with the process
 * that held it), or for a chat saved before the bridge kept that, as its notification said. One
 * that gave no word of its end is "Started" with the time: it is never called running without word
 * of it. A command a sub-agent started says whose it is. The row goes to the step in the
 * conversation, where its output is.
 */
const CommandRow = memo(function CommandRow({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const note = useShown((s) => indexFor(sessionId).notes(s.data[sessionId]).get(id));
  // The sub-agent that started it, by its task: a string, so the row does not render when that agent streams.
  const owner = useShown((s) => {
    const d = s.data[sessionId];
    const it = d?.items[id];
    const agent = it?.parentId && d ? ownerAgent(d.items, it) : undefined;
    return agent ? agentTask(agent) : '';
  });
  if (!item) return null;
  const state = commandState(item, note);
  const word = state === 'lost' ? ((item.task?.why && LOST_WORD[item.task.why]) ?? COMMAND_WORD.lost) : state === 'serving' && typeof item.task?.serving === 'string' ? `Serving ${item.task.serving}` : COMMAND_WORD[state];
  const ended = item.task?.endedAt ?? note?.ts;
  const when = state === 'unknown' ? clock(item.ts) : state === 'done' || state === 'failed' || state === 'stopped' ? (ended ? clock(ended) : '') : '';
  const name = item.detail.description || item.title;
  return (
    <div role="listitem" data-flip={`c:${id}`} className="agx-row agx-cmd" data-outcome={state} data-new={fresh || undefined}>
      <button
        type="button"
        className="agx-row-btn"
        title={item.detail.command}
        aria-label={`${name}${owner ? `, started by ${owner}` : ''}. ${word || 'Done'}. Show in conversation`}
        onClick={() => revealItem(sessionId, id)}
      >
        <StateMark state={commandRowState(state)} />
        <span className="agx-title truncate">
          {name}
          {owner && <span className="agx-outcome"> · {owner}</span>}
        </span>
        <span className="agx-meta num">
          {word && <span className="agx-outcome">{word}</span>}
          {(state === 'running' || state === 'serving') && item.task && (
            <span className="agx-dur">
              <Since ts={item.task.since} />
            </span>
          )}
          {when && <span className="agx-dur">{when}</span>}
        </span>
      </button>
    </div>
  );
});
