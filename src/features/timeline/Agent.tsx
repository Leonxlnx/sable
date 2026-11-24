import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ToolItem, WorkflowAgent, WorkflowRun } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { clock } from '@/features/usage/format';
import { useSessionLimits } from '@/features/usage/scope';
import { Icon } from '@/icons';
import { formatTokens, plural } from '@/lib/format';
import { EASE_OUT, play } from '@/lib/motion';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import { agentLine, agentProvider, agentTask, agentTrail, agentType, isAgentLive, readTrail, workflowGlance, workflowProgressText } from './agent-line';
import { CheckBlock } from './Check';
import { EMPTY, useItem, useTimeline, useWhole } from './ctx';
import { foldKey, useFold } from './fold';
import { ItemList } from './items';
import { Elapsed, ToolView } from './Tool';
import { shortDuration } from './util';

/** How many of its latest steps a working sub-agent shows under its line. */
const TAIL = 3;

type Store = ReturnType<typeof useStore.getState>;

/**
 * A sub-agent, in the conversation and in the Agents tab: one line with its kind and its task.
 * While it works its latest steps hang under it on a hairline; when it is done they gather into
 * one line (state, steps, tokens when the agent reported them, time). Opening it shows the task
 * it was given, every step and its report.
 */
/** `scope`: where it is shown, so the conversation and the Agents tab each remember what the reader opened. */
export const AgentBlock = memo(function AgentBlock(props: { item: ToolItem; tail?: number; extra?: ReactNode; scope?: string }) {
  // A turn check ("Check with Codex") reads as its own block: who checks, the findings, the hand-over.
  if (props.item.check) return <CheckBlock item={props.item} tail={props.tail} scope={props.scope} />;
  return props.item.workflow ? <WorkflowBlock {...props} run={props.item.workflow} /> : <SubAgentBlock {...props} />;
});

const SubAgentBlock = memo(function SubAgentBlock({ item, tail = TAIL, extra, scope = 'agent' }: { item: ToolItem; tail?: number; extra?: ReactNode; scope?: string }) {
  const { sessionId } = useTimeline();
  const [open, setOpen] = useFold(foldKey(sessionId, item.id, scope), false);
  const live = isAgentLive(item);
  // One string: the block renders when a step arrives or what it does changes, never on a streamed word.
  const trail = useStore(useMemo(() => (s: Store) => agentTrail(s.data[sessionId]?.items, s.data[sessionId]?.children[item.id], tail), [sessionId, item.id, tail]));
  const { steps, ids, now } = readTrail(trail);
  const provider = agentProvider(item);
  const type = agentType(item);
  const task = agentTask(item);
  const awaiting = item.status === 'awaiting';
  const line = live ? null : agentLine(item, steps);
  const error = !open && item.status === 'error' ? firstLines(item.result?.stderr || item.result?.text) : '';
  const shown = ids.length + (now ? 1 : 0);
  const rows = useTicker(trail);

  return (
    <div className="agent" data-status={item.status} data-live={live || undefined} data-open={open || undefined}>
      <div className="agent-head">
        <button type="button" className="row-btn tool-row agent-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="tool-icon">{provider ? <ProviderMark provider={provider} size={13} /> : <Icon name="robot" size={14} />}</span>
          {type && (
            <>
              <span className="agent-type">{type}</span>
              <span className="agent-dot" aria-hidden>
                ·
              </span>
            </>
          )}
          <span className="agent-task truncate">{task}</span>
          <span className="tool-meta">
            {awaiting ? (
              <span>Needs your approval</span>
            ) : live ? (
              <>
                {steps > 0 && <span className="num">{plural(steps, 'step')}</span>}
                <Elapsed since={item.ts} />
              </>
            ) : null}
          </span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
        {extra}
      </div>
      <div className="agent-under">
        <Collapse open={!!line}>
          {line && (
            <div className="agent-line num">
              <span className={line.why ? 'agent-why' : line.tone === 'error' ? 'tool-fail' : undefined}>{line.why ? `${line.state}: ${line.why}` : line.state}</span>
              {line.parts.map((p) => (
                <Fragment key={p}>
                  <span className="agent-dot" aria-hidden>
                    ·
                  </span>
                  <span>{p}</span>
                </Fragment>
              ))}
            </div>
          )}
          {error && !line?.why && <pre className="tool-error agent-error">{error}</pre>}
          {line?.why && scope === 'agent' && <GoesOn sessionId={sessionId} />}
        </Collapse>
        <Collapse open={live && !open && shown > 0}>
          <div className="agent-trail" aria-label="Latest steps">
            {steps > ids.length && <div className="agent-more num">+{steps - ids.length} earlier</div>}
            <div className="agent-rows" ref={rows}>
              {ids.map((id) => (
                <TrailStep key={id} id={id} />
              ))}
              {now && (
                <div key={now} className="agent-now">
                  <span className="shimmer">{now}</span>
                </div>
              )}
            </div>
          </div>
        </Collapse>
        <Collapse open={open}>
          <AgentBody item={item} live={live} />
        </Collapse>
      </div>
    </div>
  );
});

function firstLines(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const lines = t.split('\n');
  return lines.length > 3 ? lines.slice(0, 3).join('\n') + '\n…' : t;
}

/**
 * The latest steps as a ticker: when the window moves on (the oldest step leaves as a new one
 * arrives), the rows slide up by what left in one short glide instead of jumping a row at once;
 * the newest comes in from under the window's edge.
 */
export function useTicker(trail: string) {
  const ref = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = tops.current;
    const next = new Map<string, number>();
    for (const c of el.children) {
      const id = (c as HTMLElement).dataset.itemId;
      if (id) next.set(id, (c as HTMLElement).offsetTop);
    }
    tops.current = next;
    for (const [id, top] of next) {
      const was = prev.get(id);
      if (was === undefined) continue;
      if (was - top > 1) play(el, [{ transform: `translateY(${was - top}px)` }, { transform: 'translateY(0px)' }], { duration: 240, easing: EASE_OUT });
      break;
    }
  }, [trail]);
  return ref;
}

/** One of the latest steps: the conversation's own step row, a size down. */
export const TrailStep = memo(function TrailStep({ id }: { id: string }) {
  const item = useItem<ToolItem>(id);
  if (!item || item.type !== 'tool') return null;
  return (
    <div className="agent-step" data-item-id={id}>
      <ToolView item={item} />
    </div>
  );
});

/** Opened: the task it was given, every step, and its report. */
function AgentBody({ item, live }: { item: ToolItem; live: boolean }) {
  const { sessionId } = useTimeline();
  // Its report came cut when it is long: opened, it is fetched whole.
  useWhole(item);
  const [whole, setWhole] = useState(false);
  const children = useStore((s) => s.data[sessionId]?.children[item.id]) ?? EMPTY;
  // The last thing it wrote is its report; the tool's result usually repeats it. Read once it is settled.
  const lastText = useStore((s) => {
    if (live) return '';
    const d = s.data[sessionId];
    const last = d?.items[children[children.length - 1]];
    return last?.type === 'text' ? last.text.trim() : '';
  });
  const failed = item.status === 'error';
  const result = item.result?.text?.trim() ?? '';
  const report = failed ? '' : result || lastText;
  const fold = !live && !!lastText && (!result || result === lastText);
  const thread = useMemo(() => (fold ? children.slice(0, -1) : children), [children, fold]);
  const prompt = item.detail.prompt?.trim();
  const errorText = failed ? (item.result?.stderr || item.result?.text || '').trim() : '';

  return (
    <div className="agent-body" inert={item.more} aria-busy={item.more}>
      {prompt && (
        <button type="button" className="agent-prompt" aria-expanded={whole} aria-label={whole ? 'Show less of the task' : 'Show the whole task'} onClick={() => setWhole((w) => !w)}>
          {prompt}
        </button>
      )}
      {thread.length > 0 && (
        <div className="agent-thread">
          <ItemList ids={thread} nested />
        </div>
      )}
      {errorText && <pre className="tool-error agent-error">{errorText}</pre>}
      {report && (
        <div className="agent-report">
          <Markdown text={report} />
        </div>
      )}
    </div>
  );
}

/**
 * Under a sub-agent the plan stopped, in the conversation: one quiet line, only when it is true,
 * that the chat itself can go on (its own model is not held back) and under which account.
 */
function GoesOn({ sessionId }: { sessionId: string }) {
  const lim = useSessionLimits(sessionId);
  const several = useStore((s) => (lim?.provider ? (s.providers[lim.provider]?.accounts?.length ?? 0) > 1 : false));
  const account = useStore((s) => (lim?.provider ? s.providers[lim.provider]?.accounts?.find((a) => a.id === lim.accountId) : undefined));
  if (!lim?.model || lim.level === 'cap') return null;
  return (
    <div className="agent-goes-on">
      {lim.model} is not limited, so this chat goes on{several && account ? ` under ${accountName(account)}` : ''}.
    </div>
  );
}

// ── workflows ──

/**
 * A workflow (Claude Code's Workflow tool): one line with its name, how far it is (phase of phases,
 * agents done of agents started) and the time it has run. While it works a segmented bar shows the
 * phases and the agents that run now hang under it; when it is done it gathers into one line.
 * Opening it lists every phase with its agents.
 */
const WorkflowBlock = memo(function WorkflowBlock({ item, run, tail = TAIL, extra, scope = 'agent' }: { item: ToolItem; run: WorkflowRun; tail?: number; extra?: ReactNode; scope?: string }) {
  const { sessionId } = useTimeline();
  const [open, setOpen] = useFold(foldKey(sessionId, item.id, scope), false);
  const live = isAgentLive(item);
  const g = workflowGlance(run);
  const progress = workflowProgressText(run);
  const line = live ? null : agentLine(item, 0);
  const now = run.agents.filter((a) => a.state === 'running');
  const shown = now.slice(-tail);

  return (
    <div className="agent wf" data-status={live ? 'running' : item.status} data-live={live || undefined} data-open={open || undefined}>
      <div className="agent-head">
        <button type="button" className="row-btn tool-row agent-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="tool-icon">
            <Icon name="tree" size={14} />
          </span>
          <span className="agent-type">Workflow</span>
          <span className="agent-dot" aria-hidden>
            ·
          </span>
          <span className="agent-task truncate">{agentTask(item)}</span>
          <span className="tool-meta">{live && <Elapsed since={item.ts} />}</span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
        {extra}
      </div>
      <div className="agent-under">
        <Collapse open={!!line}>
          {line && (
            <div className="agent-line num">
              <span className={line.tone === 'error' ? 'tool-fail' : undefined}>{line.state}</span>
              {line.parts.map((p) => (
                <Fragment key={p}>
                  <span className="agent-dot" aria-hidden>
                    ·
                  </span>
                  <span>{p}</span>
                </Fragment>
              ))}
            </div>
          )}
        </Collapse>
        <Collapse open={live}>
          <div className="wf-live">
            <PhaseBar run={run} />
            <div className="wf-progress num">
              <span className="truncate">
                {progress[0] ?? 'Starting'}
                {g.current && g.phases > 1 ? <span className="wf-phase-name"> · {g.current}</span> : null}
              </span>
              {progress[1] && <span className="wf-count">{progress[1]}</span>}
            </div>
            {run.limitWait && (
              <div className="wf-wait">
                Waiting for a plan limit{run.limitWait.resetsAt ? ` · resets ${clock(run.limitWait.resetsAt)}` : ''}
              </div>
            )}
            {!open && shown.length > 0 && (
              <div className="wf-now" aria-label="Agents working now">
                {now.length > shown.length && <div className="agent-more num">+{now.length - shown.length} more working</div>}
                {shown.map((a) => (
                  <WorkflowAgentRow key={a.index} agent={a} />
                ))}
              </div>
            )}
          </div>
        </Collapse>
        <Collapse open={open}>
          <WorkflowBody run={run} />
        </Collapse>
      </div>
    </div>
  );
});

/**
 * The phases as segments: done ones full, the one that runs filled by its agents done of started,
 * the ones to come empty. Only what is known: a phase without agents yet shows no fill.
 */
function PhaseBar({ run }: { run: WorkflowRun }) {
  const g = workflowGlance(run);
  const count = Math.max(1, g.phases);
  return (
    <div className="wf-bar" role="img" aria-label={g.phases > 1 ? `Phase ${g.phase} of ${g.phases}` : 'One phase'}>
      {Array.from({ length: count }, (_, i) => {
        const index = i + 1;
        const state = run.status !== 'running' || index < g.phase ? 'done' : index === g.phase || (count === 1 && g.agents > 0) ? 'now' : 'next';
        const mine = run.agents.filter((a) => (a.phase ?? 1) === index);
        const fill = state === 'done' ? 1 : state === 'now' && mine.length ? mine.filter((a) => a.state === 'done' || a.state === 'error').length / mine.length : 0;
        return (
          <span key={index} className="wf-seg" data-state={state}>
            <span className="wf-seg-fill" style={{ transform: `scaleX(${fill})` }} />
          </span>
        );
      })}
    </div>
  );
}

/** "survey:middleware" reads as a dim "survey" and the name. */
function AgentLabel({ label }: { label: string }) {
  const i = label.lastIndexOf(':');
  if (i <= 0) return <span className="wf-label truncate">{label}</span>;
  return (
    <span className="wf-label truncate">
      <span className="wf-label-dim">{label.slice(0, i)} </span>
      {label.slice(i + 1)}
    </span>
  );
}

function agentFigures(a: WorkflowAgent): string {
  const parts: string[] = [];
  if (a.steps) parts.push(plural(a.steps, 'step'));
  if (a.tokens) parts.push(formatTokens(a.tokens));
  return parts.join(' · ');
}

/** One agent of a workflow: its state, its label, what it does (or said last), its figures. */
const WorkflowAgentRow = memo(function WorkflowAgentRow({ agent: a }: { agent: WorkflowAgent }) {
  const running = a.state === 'running';
  const figures = agentFigures(a);
  return (
    <div className="wf-agent" data-state={a.state}>
      <span className="wf-agent-mark" aria-hidden>
        {running ? <Spinner size={10} /> : a.state === 'done' ? <Icon name="check" size={11} /> : a.state === 'error' ? <Icon name="x" size={11} /> : <span className="wf-queued" />}
      </span>
      <AgentLabel label={a.label} />
      <span className={running ? 'wf-agent-now truncate shimmer' : 'wf-agent-now truncate'}>{a.state === 'error' ? (a.error ?? 'Failed') : a.state === 'queued' ? 'Waiting to start' : (a.activity ?? '')}</span>
      <span className="wf-agent-meta num">
        {figures && <span>{figures}</span>}
        {running && a.startedAt ? <Elapsed since={a.startedAt} /> : a.durationMs && a.durationMs >= 1000 ? <span>{shortDuration(a.durationMs)}</span> : null}
      </span>
    </div>
  );
});

/** Opened: every phase in order with its agents under it. */
function WorkflowBody({ run }: { run: WorkflowRun }) {
  const g = workflowGlance(run);
  const count = Math.max(g.phases, 1);
  const loose = run.agents.filter((a) => !a.phase);
  return (
    <div className="wf-body">
      {Array.from({ length: count }, (_, i) => {
        const index = i + 1;
        const phase = run.phases[i];
        const agents = run.agents.filter((a) => a.phase === index || (count === 1 && !a.phase));
        const state = run.status !== 'running' || index < g.phase ? 'done' : index === g.phase ? 'now' : 'next';
        return (
          <div key={index} className="wf-phase" data-state={state}>
            <div className="wf-phase-head">
              <span className="wf-phase-index num">{index}</span>
              <span className="wf-phase-title truncate">{phase?.title ?? `Phase ${index}`}</span>
              <span className="wf-phase-meta num">{agents.length ? plural(agents.length, 'agent') : state === 'next' ? 'Not started' : ''}</span>
            </div>
            {agents.length > 0 && (
              <div className="wf-phase-agents">
                {agents.map((a) => (
                  <WorkflowAgentRow key={a.index} agent={a} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {count > 1 && loose.length > 0 && (
        <div className="wf-phase-agents">
          {loose.map((a) => (
            <WorkflowAgentRow key={a.index} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}
