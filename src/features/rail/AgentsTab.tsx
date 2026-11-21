import { memo, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { ToolItem, WorkflowRun } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { worksInBackground } from '@shared/background';
import { ProviderMark, Ring } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { agentProvider, agentTask, isAgentLive, workflowGlance } from '@/features/timeline/agent-line';
import { TimelineCtx, type TimelineCtxValue } from '@/features/timeline/ctx';
import { foldKey, useFold } from '@/features/timeline/fold';
import { shortDuration, useHeld } from '@/features/timeline/util';
import { clock } from '@/features/usage/format';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { AgentDetail } from './AgentDetail';
import { ShownCtx, indexFor, usePaneTick, useProgress, useShown } from './agents-hooks';
import { OUTCOME_WORD, figuresOf, groupDone, liveKey, outcomeOf, promptLine, readProgress, workflowNow, type Progress } from './agents-model';
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

/**
 * Every sub-agent and workflow of the session. What works now comes first, one card each, oldest
 * first: its time, what it does now, its steps and how far it is when it says (its task list, a
 * workflow's phases). What is done follows as one line each (outcome, time, tokens), newest
 * first, under the message that started it when there are several. A row opens in place.
 *
 * `active`: the pane is on screen. Hidden (another tab, the panel closed) it holds still.
 */
export function AgentsTab({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  return (
    <ShownCtx.Provider value={active}>
      <AgentsList sessionId={sessionId} />
    </ShownCtx.Provider>
  );
}

function AgentsList({ sessionId }: { sessionId: string }) {
  const { agents, users } = indexFor(sessionId);
  const ids = useShown((s) => agents(s.data[sessionId]));
  const live = useShown((s) => liveKey(s.data[sessionId]?.items, agents(s.data[sessionId])));
  const asked = useShown((s) => users(s.data[sessionId]));
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live: ON, stuck: ON }), [sessionId, cwd, home]);

  const view = useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? {};
    const running: string[] = [];
    const done: string[] = [];
    ids.forEach((id, i) => (live[i] === '1' ? running : done).push(id));
    return { running, done: done.length, groups: groupDone(done, items, asked) };
  }, [ids, live, asked, sessionId]);

  // `key` is the row's place in the list (what moves); `as` tells a card from a row for entrances.
  const rows: { key: string; as: string; node: (fresh: boolean) => ReactNode }[] = [];
  for (const id of view.running) rows.push({ key: id, as: `L${id}`, node: (fresh) => <LiveCard key={id} sessionId={sessionId} id={id} fresh={fresh} /> });
  // Headings only where they tell something: the message behind each group, when there are several
  // and at least one of them started more than one agent (one heading per agent tells nothing).
  const grouped = view.groups.length > 1 && view.groups.some((g) => g.ids.length > 1);
  if (!grouped && view.running.length && view.done) rows.push({ key: 'h:done', as: 'h:done', node: (fresh) => <Heading key="h:done" label="Done" fresh={fresh} /> });
  for (const g of view.groups) {
    if (grouped) rows.push({ key: `h:${g.user}`, as: `h:${g.user}`, node: (fresh) => <GroupHeading key={`h:${g.user}`} sessionId={sessionId} user={g.user} fresh={fresh} /> });
    for (const id of g.ids) rows.push({ key: id, as: `D${id}`, node: (fresh) => <DoneRow key={id} sessionId={sessionId} id={id} fresh={fresh} /> });
  }
  const keys = rows.map((r) => r.key);
  const arrived = useEntrances(rows.map((r) => r.as));

  if (!ids.length) {
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
        {/* One figure: how many work now, or once none does, how many there were. */}
        <span className="rail-bar-meta num">{view.running.length ? `${view.running.length} running` : `${view.done} done`}</span>
      </div>
      <div className="rail-scroll scroll">
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
 * Rows that joined the list on screen, which rise into place once. Not the first set, not a batch,
 * not a run of arrivals in quick succession (they simply appear), and not a finished agent whose
 * card it was (it glides from the cards to its row instead).
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
        const wasCard = k[0] === 'D' && seen.current.has(`L${k.slice(1)}`);
        seen.current.add(k);
        if (calm && !wasCard) fresh.current.add(k);
      }
    }
  }
  return fresh.current;
}

function Heading({ label, fresh }: { label: string; fresh: boolean }) {
  return (
    <div role="listitem" data-flip={`h:${label}`} className="agx-head" data-new={fresh || undefined}>
      <span className="agx-head-label truncate">{label}</span>
    </div>
  );
}

/** The message whose turn started the agents under it: its first line (when it was sent shows on hover). */
const GroupHeading = memo(function GroupHeading({ sessionId, user, fresh }: { sessionId: string; user: string; fresh: boolean }) {
  const item = useShown((s) => (user ? s.data[sessionId]?.items[user] : undefined));
  const text = item?.type === 'user' ? promptLine(userItemText(item)) : 'Earlier';
  return (
    <div role="listitem" data-flip={`h:${user}`} className="agx-head" data-new={fresh || undefined} title={item ? `Sent ${clock(item.ts)}` : undefined}>
      <span className="agx-head-label truncate">{text}</span>
    </div>
  );
});

// ── working now ──

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
          {/* One mark: amber while it waits for you, the other agent's mark for a hand-over, else the ring. */}
          <span className="agx-mark" aria-hidden>
            {awaiting ? <span className="agx-wait-dot" /> : provider ? <ProviderMark provider={provider} size={13} /> : <Ring size={12} label={null} />}
          </span>
          <span className="sr-only">{awaiting ? 'Waiting for you' : 'Working'}</span>
          <span className="agx-title truncate">{agentTask(item)}</span>
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

// ── done ──

/**
 * A finished agent: its task and one figure, in the cards' columns. A plain done row carries no
 * mark (being in this list says it); a failure has the red cross, a hand-over its agent's mark, a
 * workflow its tree. An outcome other than done is said in words where the time would stand; its
 * tokens and steps are in the opened row.
 */
const DoneRow = memo(function DoneRow({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!item) return null;
  const outcome = outcomeOf(item);
  const f = figuresOf(item);
  const provider = agentProvider(item) ?? item.check?.agent ?? null;
  const word = outcome === 'done' ? '' : OUTCOME_WORD[outcome];
  const mark = outcome === 'failed' ? <Icon name="x" size={11} weight="bold" /> : provider ? <ProviderMark provider={provider} size={12} /> : item.workflow ? <Icon name="tree" size={13} /> : null;
  return (
    <div role="listitem" data-flip={id} className="agx-row" data-outcome={outcome} data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-row-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agx-mark" aria-hidden>
          {mark}
        </span>
        <span className="agx-title truncate">{agentTask(item)}</span>
        <span className="agx-meta num">
          {word ? <span className="agx-outcome">{word}</span> : <span className="sr-only">Done</span>}
          {!word && f.ms >= 1000 && <span className="agx-dur">{shortDuration(f.ms)}</span>}
        </span>
      </button>
      <Collapse open={open}>
        <AgentDetail sessionId={sessionId} item={item} live={false} />
      </Collapse>
    </div>
  );
});
