import { emptyIndex } from '@/state/revision';
import { HistoryStatus } from '@/features/session/HistoryStatus';
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ProviderId, TaskMark, ToolItem, WorkflowRun } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { worksInBackground } from '@shared/background';
import { ProviderMark, Ring } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { agentProvider, agentTask, delegateRetry, delegateWord, isAgentLive, workflowGlance } from '@/features/timeline/agent-line';
import { TimelineCtx, type TimelineCtxValue } from '@/features/timeline/ctx';
import { foldKey, getFold, setFold, useFold } from '@/features/timeline/fold';
import { ReportAgain } from '@/features/timeline/ReportAgain';
import { revealItem } from '@/features/timeline/reveal';
import { shortDuration, useHeld } from '@/features/timeline/util';
import { clock } from '@/features/usage/format';
import { Icon } from '@/icons';
import { stopTracking } from '@/state/actions';
import { useStore } from '@/state/store';
import { AgentDetail } from './AgentDetail';
import { ShownCtx, indexFor, useLooked, usePaneTick, useProgress, useShown } from './agents-hooks';
import { OUTCOME_WORD, STATE_MARK, agentState, agentsHeader, commandRowState, commandState, commandsView, dayLabel, failureIsNews, figuresOf, historyDays, isJob, jobRan, jobRowState, jobTail, jobsView, lastLine, liveKey, nowRows, outcomeOf, overview, ownerAgent, promptLine, readProgress, waveOpen, waveRows, workflowNow, type CommandState, type Progress, type RowState } from './agents-model';
import { LeaveList } from './leave';
import './agents.css';

/**
 * How much of the chat works now, the figure beside the tab's icon: its sub-agents and workflows
 * (read from the steps), its background commands and the jobs it asked Sable to track (the
 * bridge's own counts).
 */
export function useLiveAgentCount(sessionId: string): number {
  const { agents } = indexFor(sessionId);
  const live = useStore((s) => {
    const d = s.data[sessionId];
    const ids = agents(d);
    let n = 0;
    for (const id of ids) if (isAgentLive(d?.items[id] as ToolItem | undefined)) n++;
    return n;
  });
  const others = useStore((s) => (s.sessions[sessionId]?.commands ?? 0) + (s.sessions[sessionId]?.tracked ?? 0));
  return live + others;
}

/** Where the open state of a row is remembered (apart from the conversation's own blocks). */
const SCOPE = 'agents-tab';

/** The conversation's context, for the opened details (file links in a report). */
const ON = { current: true };

/** More working at once than this and the section scrolls by itself, so history stays in reach. */
const MANY = 4;

/** The folds of the finished commands and jobs, among the waves' own. */
const COMMANDS = '\0commands';
const JOBS = '\0jobs';
const DAY = '\0day:';

/**
 * Everything of the session that works beside its own turn, for a person who glances at it.
 *
 * Now, first: the top of the pane answers "is anything working, and what". Each thing is one card
 * in one grammar, whatever it is (a sub-agent, a workflow, a job the agent started outside its
 * tools and asked Sable to track, a background command): its state, what it is, who runs it, how
 * long, and under it what it does now (an agent's step, the last line of a job's log or of a
 * command's output). The longest runner stands first. Servers are no work: quiet rows after it.
 * "Nothing is working." when so. The block stays in view while history scrolls under it.
 *
 * History is history: what finished folds away under the message of the person's that set it
 * going, newest first, only the newest open; finished commands and jobs are groups of their own.
 * A failure is red only while it is news (the newest wave, or failed since the person last looked
 * at the tab); an older one is a quiet word. The header says what is true now, never a total.
 *
 * Long lists are cheap: a folded wave renders one line, an open one a few rows until asked for
 * all, and the model behind it (`agents-model.ts`) scans only what joined since it last looked.
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
  const { agents, users, notes, commands, jobs } = indexFor(sessionId);
  const ids = useShown((s) => agents(s.data[sessionId]));
  const live = useShown((s) => liveKey(s.data[sessionId]?.items, agents(s.data[sessionId])));
  const asked = useShown((s) => users(s.data[sessionId]));
  // The commands follow their own state too (a task started, ended, lost): see `commandsView`.
  const readCommands = useMemo(() => commandsView(commands, notes), [commands, notes]);
  const cmds = useShown((s) => readCommands(s.data[sessionId]));
  const readJobs = useMemo(() => jobsView(jobs), [jobs]);
  const tracked = useShown((s) => readJobs(s.data[sessionId]));
  const seenAt = useLooked(sessionId);
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live: ON, stuck: ON }), [sessionId, cwd, home]);

  const view = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    return overview(ids, live, d?.items ?? emptyIndex, asked, d?.roots, seenAt);
  }, [ids, live, asked, sessionId, seenAt]);
  // What works now, as one list: `kind:id` joined, so the block renders only when one joins or leaves.
  const now = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    return nowRows(view.working, tracked.running, cmds.live, d?.items ?? emptyIndex).map((r) => `${r.kind}:${r.id}`).join('|');
  }, [view.working, tracked.running, cmds.live, sessionId]);
  const servers = cmds.servers.join('|');

  // What the person opened or closed (waves, the groups) and where they asked for every row.
  // Remembered with the rows' own folds while the app is open.
  const [, redraw] = useState(0);
  const chosen = (key: string) => getFold(foldKey(sessionId, key, SCOPE));
  const all = (key: string) => !!getFold(foldKey(sessionId, `${key}\0all`, SCOPE));
  const flip = useCallback(
    (key: string, to: boolean) => {
      setFold(foldKey(sessionId, key, SCOPE), to);
      redraw((n) => n + 1);
    },
    [sessionId],
  );

  // `key` is the row's place in the list (what moves); `as` tells a card from a row for entrances.
  const rows: { key: string; as: string; node: (fresh: boolean) => ReactNode }[] = [];
  rows.push({ key: 'now', as: 'now', node: () => <Now key="now" sessionId={sessionId} order={now} servers={servers} /> });
  // A wave gets its line when there is more than one, or other groups beside it: one wave alone is simply the list.
  const headed = view.waves.length > 1 || cmds.past.length > 0 || tracked.past.length > 0;
  const wave = (w: (typeof view.waves)[number], i: number, nested: boolean) => {
    const open = !headed || waveOpen(i, view.done, chosen(w.user));
    if (headed) {
      const hk = `h:${w.user}`;
      rows.push({ key: hk, as: hk, node: (fresh) => <WaveHead key={hk} sessionId={sessionId} user={w.user} count={w.ids.length} failed={w.failed} news={w.news} open={open} onFlip={flip} fresh={fresh} nested={nested} /> });
    }
    if (!open) return;
    const shown = waveRows(w, all(w.user));
    for (const id of shown.ids) rows.push({ key: id, as: `D${id}`, node: (fresh) => <DoneRow key={id} sessionId={sessionId} id={id} fresh={fresh} newest={i === 0} seenAt={seenAt} nested={nested} /> });
    if (shown.more) {
      const mk = `m:${w.user}`;
      rows.push({ key: mk, as: mk, node: () => <MoreRow key={mk} id={mk} group={w.user} count={shown.more} onFlip={flip} nested={nested} /> });
    }
  };
  // The newest wave's own day stands as its waves; every earlier day is one line that holds its own.
  const history = useMemo(() => historyDays(view.waves), [view.waves]);
  history.recent.forEach((w, i) => wave(w, i, false));
  let before = history.recent.length;
  const today = Date.now();
  for (const d of history.days) {
    const dk = `${DAY}${d.key}`;
    const open = chosen(dk) ?? false;
    const from = before;
    rows.push({ key: `h:${dk}`, as: `h:${dk}`, node: (fresh) => <GroupHead key={`h:${dk}`} id={`h:${dk}`} group={dk} label={dayLabel(d.at, today)} count={d.count} failed={d.failed} news={d.news} open={open} onFlip={flip} fresh={fresh} /> });
    if (open) d.waves.forEach((w, k) => wave(w, from + k, true));
    before += d.waves.length;
  }
  if (tracked.past.length) {
    const open = chosen(JOBS) ?? tracked.past.length <= 4;
    rows.push({ key: 'h:job', as: 'h:job', node: (fresh) => <GroupHead key="h:job" id="h:job" group={JOBS} label="Jobs" count={tracked.past.length} failed={0} news={0} open={open} onFlip={flip} fresh={fresh} /> });
    if (open) {
      const shown = waveRows({ user: JOBS, ids: tracked.past, failed: 0, news: 0, at: 0 }, all(JOBS));
      for (const id of shown.ids) rows.push({ key: `j:${id}`, as: `j:${id}`, node: (fresh) => <JobRow key={`j:${id}`} sessionId={sessionId} id={id} fresh={fresh} /> });
      if (shown.more) rows.push({ key: 'm:job', as: 'm:job', node: () => <MoreRow key="m:job" id="m:job" group={JOBS} count={shown.more} onFlip={flip} /> });
    }
  }
  if (cmds.past.length) {
    // A few stand open; many fold to their line.
    const open = chosen(COMMANDS) ?? cmds.past.length <= 4;
    rows.push({ key: 'h:cmd', as: 'h:cmd', node: (fresh) => <GroupHead key="h:cmd" id="h:cmd" group={COMMANDS} label="Commands" count={cmds.past.length} failed={cmds.failed} news={0} open={open} onFlip={flip} fresh={fresh} /> });
    if (open) {
      // Every failure shows (`waveRows` lists those first).
      const shown = waveRows({ user: COMMANDS, ids: cmds.past, failed: cmds.failed, news: 0, at: 0 }, all(COMMANDS));
      for (const id of shown.ids) rows.push({ key: `c:${id}`, as: `c:${id}`, node: (fresh) => <CommandRow key={`c:${id}`} sessionId={sessionId} id={id} fresh={fresh} seenAt={seenAt} /> });
      if (shown.more) rows.push({ key: 'm:cmd', as: 'm:cmd', node: () => <MoreRow key="m:cmd" id="m:cmd" group={COMMANDS} count={shown.more} onFlip={flip} /> });
    }
  }
  // What is true now, in the words of the conversation's last line and the sidebar.
  const head = agentsHeader({ serving: cmds.serving, working: view.working.length, running: cmds.live.length, jobs: tracked.running.length });
  const keys = rows.map((r) => r.key);
  const arrived = useEntrances(rows.map((r) => r.as));

  if (!ids.length && !cmds.ids.length && !tracked.running.length && !tracked.past.length) {
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
        {/* What works now, and nothing when nothing does: never a total of what ended or failed. */}
        <span className="rail-bar-meta num truncate">{head}</span>
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
 * in it: in red only while that is news (`news`), else as a quiet word. It folds the group.
 */
const GroupHead = memo(function GroupHead({ id, group, time, label, count, failed, news, open, onFlip, fresh, title, nested }: { id: string; group: string; time?: string; label: string; count: number; failed: number; news: number; open: boolean; onFlip: (key: string, to: boolean) => void; fresh: boolean; title?: string; nested?: boolean }) {
  return (
    <div role="listitem" data-flip={id} className="agx-wave" data-open={open || undefined} data-new={fresh || undefined} data-nested={nested || undefined}>
      <button type="button" className="agx-wave-btn" aria-expanded={open} onClick={() => onFlip(group, !open)} title={title}>
        <span className="agx-mark" aria-hidden>
          <Icon name="caret-right" size={10} weight="bold" className="agx-caret" />
        </span>
        {time && <span className="agx-wave-time num">{time}</span>}
        <span className="agx-wave-label truncate">{label}</span>
        {/* Folded, the line says what failed inside; open, the failed rows stand first under it. */}
        {failed > 0 && !open && <span className="agx-wave-failed num" data-news={news > 0 || undefined}>{failed} failed</span>}
        <span className="agx-wave-count num">{count}</span>
      </button>
    </div>
  );
});

/** A wave's line: the first words of the message that set its agents going, under the time it was sent. */
const WaveHead = memo(function WaveHead({ sessionId, user, count, failed, news, open, onFlip, fresh, nested }: { sessionId: string; user: string; count: number; failed: number; news: number; open: boolean; onFlip: (key: string, to: boolean) => void; fresh: boolean; nested?: boolean }) {
  const item = useShown((s) => (user ? s.data[sessionId]?.items[user] : undefined));
  const text = item?.type === 'user' ? promptLine(userItemText(item)) : 'Earlier';
  return <GroupHead id={`h:${user}`} group={user} time={item ? clock(item.ts) : undefined} label={text} title={text} count={count} failed={failed} news={news} open={open} onFlip={onFlip} fresh={fresh} nested={nested} />;
});

/** What an open group holds back. */
const MoreRow = memo(function MoreRow({ id, group, count, onFlip, nested }: { id: string; group: string; count: number; onFlip: (key: string, to: boolean) => void; nested?: boolean }) {
  return (
    <div role="listitem" data-flip={id} className="agx-more-row" data-nested={nested || undefined}>
      <button type="button" className="agx-more-btn num" onClick={() => onFlip(`${group}\0all`, true)}>
        Show {count} more
      </button>
    </div>
  );
});

// ── now ──

/**
 * What works now, as one block that stays at the top of the pane: a card each, the longest runner
 * first, then the servers as quiet rows; one calm line when nothing works. `order`: `kind:id`
 * joined; `servers`: their ids joined. The block renders when those change (one started, one
 * ended), never when history does.
 */
const Now = memo(function Now({ sessionId, order, servers }: { sessionId: string; order: string; servers: string }) {
  const rows = useMemo(() => (order ? order.split('|').map((r) => ({ kind: r.slice(0, r.indexOf(':')), id: r.slice(r.indexOf(':') + 1) })) : []), [order]);
  const serving = useMemo(() => (servers ? servers.split('|') : []), [servers]);
  const arrived = useEntrances(rows.map((r) => r.id));
  const many = rows.length > MANY;
  return (
    <div role="listitem" data-flip="now" className={many ? 'agx-working scroll' : 'agx-working'} data-many={many || undefined} aria-label="Working now">
      {rows.length > 0 && (
        <LeaveList className="agx-cards" order={order}>
          {rows.map((r) =>
            r.kind === 'job' ? (
              <JobCard key={r.id} sessionId={sessionId} id={r.id} fresh={arrived.has(r.id)} />
            ) : r.kind === 'command' ? (
              <CommandCard key={r.id} sessionId={sessionId} id={r.id} fresh={arrived.has(r.id)} />
            ) : (
              <LiveCard key={r.id} sessionId={sessionId} id={r.id} fresh={arrived.has(r.id)} />
            ),
          )}
        </LeaveList>
      )}
      {!rows.length && <p className="agx-idle">Nothing is working.</p>}
      {serving.length > 0 && (
        <div className="agx-serving" role="list" aria-label="Serving">
          {serving.map((id) => (
            <CommandRow key={id} sessionId={sessionId} id={id} fresh={false} seenAt={Infinity} />
          ))}
        </div>
      )}
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

/** The agent a job's "who" names, when it names one: its mark stands for the word. */
function byProvider(by: string | undefined): ProviderId | null {
  if (!by) return null;
  if (/\bcodex\b/i.test(by)) return 'codex';
  if (/\bclaude\b/i.test(by)) return 'claude';
  if (/\bopencode\b/i.test(by)) return 'opencode';
  return null;
}

/** Who runs a job or started a command, after its title: an agent's mark, else the word, quiet. */
function By({ by }: { by: string | undefined }) {
  const provider = byProvider(by);
  if (provider) {
    return (
      <span className="agx-who" title={by}>
        <span className="sr-only">{by}</span>
        <ProviderMark provider={provider} size={12} />
      </span>
    );
  }
  return by ? <span className="agx-by truncate">{by}</span> : null;
}

/**
 * A job the agent started outside its tools and asked Sable to track: the card of the working
 * agents, with the last line of its log where they say what they do now. What the log holds is
 * untrusted: it is shown as text, one line, cut by the bridge.
 */
const JobCard = memo(function JobCard({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!isJob(item)) return null;
  const t = item.tracked;
  return (
    <div role="listitem" data-flip={id} className="agx-card" data-spot="" data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-card-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agx-line">
          <StateMark state="running" />
          <span className="sr-only">Working</span>
          <span className="agx-title truncate">{item.title}</span>
          <By by={t.by} />
          <span className="agx-time num">
            <Since ts={t.since} />
          </span>
        </span>
        {t.line && (
          <span className="agx-sub">
            <span className="agx-out truncate">{t.line}</span>
          </span>
        )}
      </button>
      <Collapse open={open}>
        <JobDetail sessionId={sessionId} item={item} />
      </Collapse>
    </div>
  );
});

/**
 * An opened job, in place: when it was tracked and ended, the end of its log (the last line while
 * it runs; the lines its report carried once it is over), and its actions: to its step in the
 * conversation, and while it runs to stop the watching (never the process).
 */
function JobDetail({ sessionId, item }: { sessionId: string; item: ToolItem & { tracked: NonNullable<ToolItem['tracked']> } }) {
  const t = item.tracked;
  const lines = t.state === 'running' ? (t.line ? [t.line] : []) : jobTail(item.result?.text, t.line);
  const [stopping, setStopping] = useState(false);
  const from = clock(t.since);
  const facts = t.state === 'ended' && t.endedAt ? `${from} to ${clock(t.endedAt)}` : `Tracked ${from}`;
  return (
    <div className="agx-detail">
      <span className="agx-facts num">
        {facts} · process {t.pid}
      </span>
      {lines.length > 0 && (
        <span className="agx-tail" aria-label="The end of its log">
          {lines.map((line, i) => (
            <span key={i} className="agx-tail-line truncate">
              {line}
            </span>
          ))}
        </span>
      )}
      <span className="agx-acts">
        <button type="button" className="agx-goto" onClick={() => revealItem(sessionId, item.id)}>
          <Icon name="chat" size={13} />
          Show in conversation
        </button>
        {t.state === 'running' && (
          <button
            type="button"
            className="agx-goto"
            aria-disabled={stopping || undefined}
            onClick={() => {
              if (stopping) return;
              setStopping(true);
              void stopTracking(sessionId, item.id).finally(() => setStopping(false));
            }}
          >
            <Icon name="x" size={12} />
            Stop tracking
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A background command that works now (a build, a test run, a monitor): the same card, with the
 * last line of its output where an agent says what it does. A command a sub-agent started says
 * whose it is. Opened: the command and the way to its step in the conversation, where its output is.
 */
const CommandCard = memo(function CommandCard({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  // One plain line, as a string: the card renders when the line changes, not on every chunk.
  const out = useShown((s) => lastLine((s.data[sessionId]?.items[id] as ToolItem | undefined)?.output));
  const owner = useShown((s) => {
    const d = s.data[sessionId];
    const it = d?.items[id];
    const agent = it?.parentId && d ? ownerAgent(d.items, it) : undefined;
    return agent ? agentTask(agent) : '';
  });
  const line = useHeld(out, 700);
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!item) return null;
  const name = item.detail.description || item.title;
  return (
    <div role="listitem" data-flip={id} className="agx-card" data-spot="" data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-card-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agx-line">
          <StateMark state="running" />
          <span className="sr-only">{item.task?.kind === 'monitor' ? 'Watching' : 'Running'}</span>
          <span className="agx-title truncate">{name}</span>
          {owner && <span className="agx-by truncate">{owner}</span>}
          <span className="agx-time num">
            <Since ts={item.task?.since ?? item.ts} />
          </span>
        </span>
        {line && (
          <span className="agx-sub">
            <span className="agx-out truncate">{line}</span>
          </span>
        )}
      </button>
      <Collapse open={open}>
        <div className="agx-detail">
          {item.detail.command && <code className="agx-command">{item.detail.command}</code>}
          <button type="button" className="agx-goto" onClick={() => revealItem(sessionId, id)}>
            <Icon name="chat" size={13} />
            Show in conversation
          </button>
        </div>
      </Collapse>
    </div>
  );
});

/**
 * A sub-agent's live line: what it does now (its steps are in the opened card). Its own task list,
 * when it keeps one, as a thin meter: the only honest measure of how far it is.
 */
function AgentLive({ item, progress: p, awaiting }: { item: ToolItem; progress: Progress; awaiting: boolean }) {
  // A run of quick steps reads as a calm sequence of titles, not a flicker.
  const now = useHeld(p.now, 700);
  const bg = item.status === 'done' && worksInBackground(item);
  // A handed-over task the person stopped says so until its child has wound down.
  const stopping = delegateWord(item) === 'Stopping';
  const doing = awaiting ? 'Needs your approval' : stopping ? 'Stopping' : now || (bg && !p.steps ? 'Working in the background' : 'Starting');
  return (
    <>
      <span className="agx-sub">
        {/* Waiting on you is said in amber once, by the mark: the words stay in the line's own ink. */}
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

// ── history ──

/**
 * A finished agent: its task and one figure, in the cards' columns. A plain done row carries a
 * quiet check; a failure the cross, red only while it is news (`newest`: it stands in the newest
 * wave; else it failed after `seenAt`, when the person last looked), a hand-over its agent's mark.
 * An outcome other than done is said in words where the time would stand; its tokens and steps,
 * and when it finished, are in the opened row.
 */
const DoneRow = memo(function DoneRow({ sessionId, id, fresh, newest, seenAt, nested }: { sessionId: string; id: string; fresh: boolean; newest: boolean; seenAt: number; nested?: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  // A background agent's call returned at once: its notification says when it ended.
  const noted = useShown((s) => indexFor(sessionId).notes(s.data[sessionId]).get(id)?.ts ?? 0);
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!item) return null;
  const outcome = outcomeOf(item);
  const f = figuresOf(item);
  const provider = agentProvider(item) ?? item.check?.agent ?? null;
  // A handed-over task whose report the chat's agent has not read yet says where the report stands
  // ("Report pending", "With your next message"; "Checking delivery" or "Delivery unknown" for one
  // that went out); how it ended is the row's mark.
  const report = delegateWord(item);
  const word = report || (outcome === 'done' ? '' : OUTCOME_WORD[outcome]);
  const launched = !!item.result?.agent?.background || !!item.detail.background;
  const endedAt = noted || (launched ? 0 : (item.endedAt ?? 0));
  const news = outcome === 'failed' && failureIsNews(item, newest, seenAt);
  return (
    <div role="listitem" data-flip={id} className="agx-row" data-outcome={outcome} data-news={news || undefined} data-open={open || undefined} data-new={fresh || undefined} data-nested={nested || undefined}>
      <button type="button" className="agx-row-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateMark state={agentState(outcome)} />
        <span className="agx-title truncate">{agentTask(item)}</span>
        {provider && <Who provider={provider} />}
        <span className="agx-meta num">
          {report && outcome !== 'done' && <span className="sr-only">{OUTCOME_WORD[outcome]}. </span>}
          {word ? <span className="agx-outcome" data-report={report ? '' : undefined}>{word}</span> : <span className="sr-only">Done</span>}
          {!word && f.ms >= 1000 && <span className="agx-dur">{shortDuration(f.ms)}</span>}
        </span>
      </button>
      {/* A report whose delivery is unknown: the person decides, on a line of its own under the row
          (the row itself is one button). */}
      {delegateRetry(item) && (
        <div className="agx-again">
          <ReportAgain sessionId={sessionId} item={item} className="agx-goto" />
        </div>
      )}
      <Collapse open={open}>
        <AgentDetail sessionId={sessionId} item={item} live={false} endedAt={endedAt} />
      </Collapse>
    </div>
  );
});

/**
 * A job that is over: its title and how long Sable saw it run, in the rows' columns; where its
 * report stands while the chat's agent has not read it ("Report pending"), "Not tracked" for one the
 * person let go, "Ended" when the time of its end is not known. It opens in place like an agent.
 */
const JobRow = memo(function JobRow({ sessionId, id, fresh }: { sessionId: string; id: string; fresh: boolean }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [open, setOpen] = useFold(foldKey(sessionId, id, SCOPE), false);
  if (!isJob(item)) return null;
  const t = item.tracked;
  const ran = jobRan(t);
  const report = delegateWord(item);
  const word = report || (t.state === 'left' ? 'Not tracked' : ran >= 1000 ? '' : 'Ended');
  return (
    <div role="listitem" data-flip={`j:${id}`} className="agx-row" data-outcome={t.state} data-open={open || undefined} data-new={fresh || undefined}>
      <button type="button" className="agx-row-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateMark state={jobRowState(t)} />
        <span className="agx-title truncate">{item.title}</span>
        <By by={t.by} />
        <span className="agx-meta num">
          {word ? <span className="agx-outcome" data-report={report ? '' : undefined}>{word}</span> : <span className="sr-only">Ended</span>}
          {!word && <span className="agx-dur">{shortDuration(ran)}</span>}
        </span>
      </button>
      <Collapse open={open}>
        <JobDetail sessionId={sessionId} item={item} />
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
 * A command that serves (in the block of what is now) or is over (in history): what it is and
 * where it stands, as the bridge says (`ToolItem.task`: how it ended, lost with the process that
 * held it), or for a chat saved before the bridge kept that, as its notification said. One that
 * gave no word of its end is "Started" with the time: it is never called running without word of
 * it. A command a sub-agent started says whose it is. A failure is red only while it is news
 * (after `seenAt`). The row goes to the step in the conversation, where its output is.
 */
const CommandRow = memo(function CommandRow({ sessionId, id, fresh, seenAt }: { sessionId: string; id: string; fresh: boolean; seenAt: number }) {
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
  const news = state === 'failed' && (ended ?? item.ts) > seenAt;
  return (
    <div role="listitem" data-flip={`c:${id}`} className="agx-row agx-cmd" data-outcome={state} data-news={news || undefined} data-new={fresh || undefined}>
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
