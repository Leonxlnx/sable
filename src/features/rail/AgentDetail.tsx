import { memo, useEffect, useMemo, useState } from 'react';
import type { ToolItem, WorkflowAgent, WorkflowRun } from '@shared/protocol';
import { Ring } from '@/art/Logo';
import { Markdown } from '@/components/Markdown';
import { agentLimitText, agentType, workflowGlance } from '@/features/timeline/agent-line';
import { revealItem } from '@/features/timeline/reveal';
import { shortDuration } from '@/features/timeline/util';
import { clock } from '@/features/usage/format';
import { Icon, TOOL_ICON } from '@/icons';
import { formatTokens, plural } from '@/lib/format';
import { loadWholeItem } from '@/state/actions';
import { useShown } from './agents-hooks';
import { figuresOf, latestSteps, outcomeOf, stepCount } from './agents-model';

/** How many of its latest steps an opened agent lists; the conversation has every one. */
const RECENT = 5;

/** A report longer than this many characters opens folded to its first lines. */
const LONG_REPORT = 700;

/**
 * An opened agent, in place: one quiet line of facts (its kind, when it started and finished, its steps), why it
 * stopped when it did, the task it was given, its latest steps and its report (or a workflow's
 * phases), and a way to it in the conversation.
 */
export function AgentDetail({ sessionId, item, live, endedAt = 0 }: { sessionId: string; item: ToolItem; live: boolean; endedAt?: number }) {
  // A long report or result comes cut to the window: opened, it is asked for whole.
  const more = !!item.more;
  useEffect(() => {
    if (more) void loadWholeItem(sessionId, item.id);
  }, [more, sessionId, item.id]);

  return (
    <div className="agx-detail">
      {item.workflow ? <WorkflowDetail item={item} run={item.workflow} live={live} endedAt={endedAt} /> : <SubAgentDetail sessionId={sessionId} item={item} live={live} endedAt={endedAt} />}
      <button type="button" className="agx-goto" onClick={() => revealItem(sessionId, item.id)}>
        <Icon name="chat" size={13} />
        Show in conversation
      </button>
    </div>
  );
}

/** "Started 14:32" while it works (or when its end is not known), "14:32 to 14:35" once it is; one time when both read the same. */
function span(from: number, to: number): string {
  const a = clock(from);
  if (to <= from) return `Started ${a}`;
  const b = clock(to);
  return a === b ? a : `${a} to ${b}`;
}

function SubAgentDetail({ sessionId, item, live, endedAt }: { sessionId: string; item: ToolItem; live: boolean; endedAt: number }) {
  const recent = useShown((s) => latestSteps(s.data[sessionId]?.items, s.data[sessionId]?.children[item.id], RECENT));
  // Counted under it only when it gave no count of its own, and only again when a step joins.
  const counter = useMemo(() => {
    let kids: unknown = null;
    let n = 0;
    return (items: Parameters<typeof stepCount>[0], arr: readonly string[] | undefined) => {
      if (arr !== kids) {
        kids = arr;
        n = stepCount(items, arr);
      }
      return n;
    };
  }, []);
  const counted = useShown((s) => (live || item.result?.agent?.steps !== undefined ? 0 : counter(s.data[sessionId]?.items, s.data[sessionId]?.children[item.id])));
  // The last thing it wrote is its report when the tool's result does not carry one.
  const lastText = useShown((s) => {
    if (live) return '';
    const d = s.data[sessionId];
    const kids = d?.children[item.id];
    const last = kids?.length ? d?.items[kids[kids.length - 1]] : undefined;
    return last?.type === 'text' ? last.text.trim() : '';
  });

  const outcome = live ? null : outcomeOf(item);
  const f = figuresOf(item);
  const steps = f.steps ?? counted;
  const facts = [agentType(item), span(item.ts, live ? 0 : endedAt), !live && steps > 0 ? plural(steps, 'step') : ''].filter(Boolean);
  const failed = outcome === 'failed';
  const why = agentLimitText(item);
  const errorText = failed ? firstLines((item.result?.stderr || item.result?.text || '').trim(), 4) : '';
  const report = failed || why ? '' : item.result?.text?.trim() || lastText;
  const prompt = item.detail.prompt?.trim();
  const ids = recent ? recent.split(',') : [];

  return (
    <>
      <div className="agx-facts num">
        {facts.join(' · ')}
        {f.tokens > 0 && <span className="agx-facts-tokens"> · {formatTokens(f.tokens)} tokens</span>}
      </div>
      {why && <div className="agx-why">{why}</div>}
      {errorText && <div className="agx-error">{errorText}</div>}
      {prompt && <Prompt text={prompt} />}
      {ids.length > 0 && (
        <div className="agx-steps" aria-label="Latest steps">
          {ids.map((id) => (
            <StepRow key={id} sessionId={sessionId} id={id} />
          ))}
        </div>
      )}
      {report && <Report text={report} />}
    </>
  );
}

function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length > n ? lines.slice(0, n).join('\n') + '\n…' : text;
}

/** The task it was given: three lines, the rest on a click. */
function Prompt({ text }: { text: string }) {
  const [whole, setWhole] = useState(false);
  return (
    <button type="button" className="agx-prompt" data-whole={whole || undefined} aria-expanded={whole} aria-label={whole ? 'Show less of the task' : 'Show the whole task'} onClick={() => setWhole((w) => !w)}>
      {text}
    </button>
  );
}

/** Its report, the first lines of a long one until asked for the rest. */
function Report({ text }: { text: string }) {
  const long = text.length > LONG_REPORT;
  const [whole, setWhole] = useState(false);
  return (
    <div className="agx-report" data-folded={(long && !whole) || undefined}>
      <div className="agx-report-text">
        <Markdown text={text} />
      </div>
      {long && (
        <button type="button" className="agx-more" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>
          {whole ? 'Show less' : 'Show the whole report'}
        </button>
      )}
    </div>
  );
}

/** One of its latest steps: its kind, its title, and how it went. Commands stay in the conversation. */
const StepRow = memo(function StepRow({ sessionId, id }: { sessionId: string; id: string }) {
  const item = useShown((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  if (!item || item.type !== 'tool') return null;
  const running = item.status === 'running' || item.status === 'pending';
  const failed = item.status === 'error';
  const ms = item.endedAt ? Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)) : 0;
  return (
    <div className="agx-step" data-status={item.status}>
      <Icon name={(TOOL_ICON[item.kind] ?? TOOL_ICON.other).icon} size={13} className="agx-step-icon" />
      <span className="agx-step-title truncate">{item.title}</span>
      <span className="agx-step-meta num">{running ? <Ring size={10} label={null} /> : failed ? <Icon name="x" size={10} weight="bold" className="agx-fail" /> : ms >= 1000 ? shortDuration(ms) : null}</span>
    </div>
  );
});

// ── workflows ──

function WorkflowDetail({ item, run, live, endedAt }: { item: ToolItem; run: WorkflowRun; live: boolean; endedAt: number }) {
  const g = workflowGlance(run);
  const f = figuresOf(item);
  const facts = [span(item.ts, live ? 0 : endedAt || (run.durationMs ? item.ts + run.durationMs : 0)), g.agents ? plural(g.agents, 'agent') : '', g.failed ? `${g.failed} failed` : '', !live && f.steps ? plural(f.steps, 'step') : ''].filter(Boolean);
  const count = Math.max(1, g.phases);
  return (
    <>
      <div className="agx-facts num">
        {facts.join(' · ')}
        {f.tokens > 0 && <span className="agx-facts-tokens"> · {formatTokens(f.tokens)} tokens</span>}
      </div>
      {run.limitWait && <div className="agx-why">Waiting for a plan limit{run.limitWait.resetsAt ? ` · resets ${clock(run.limitWait.resetsAt)}` : ''}</div>}
      <div className="agx-wf">
        {Array.from({ length: count }, (_, i) => {
          const index = i + 1;
          const agents = run.agents.filter((a) => (a.phase ?? 1) === index || (count === 1 && !a.phase));
          const state = run.status !== 'running' || index < g.phase ? 'done' : index === g.phase ? 'now' : 'next';
          const done = agents.filter((a) => a.state === 'done' || a.state === 'error').length;
          return (
            <div key={index} className="agx-wf-phase" data-state={state}>
              <div className="agx-wf-head">
                <span className="agx-wf-index num">{index}</span>
                <span className="agx-wf-title truncate">{run.phases[i]?.title ?? `Phase ${index}`}</span>
                {/* How far a phase is, while it is not all done. */}
                <span className="agx-wf-count num">{agents.length && done < agents.length ? `${done} of ${agents.length}` : state === 'next' ? 'Not started' : ''}</span>
              </div>
              {agents.map((a) => (
                <WorkflowAgentRow key={a.index} agent={a} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** "survey:middleware" reads as a dim "survey" and the name. */
function label(text: string) {
  const i = text.lastIndexOf(':');
  if (i <= 0) return <span className="agx-wf-label truncate">{text}</span>;
  return (
    <span className="agx-wf-label truncate">
      <span className="agx-wf-dim">{text.slice(0, i)} </span>
      {text.slice(i + 1)}
    </span>
  );
}

function WorkflowAgentRow({ agent: a }: { agent: WorkflowAgent }) {
  const running = a.state === 'running';
  // One figure, its time: the workflow's tokens are in its facts line.
  const meta = a.state === 'error' || !a.durationMs || a.durationMs < 1000 ? '' : shortDuration(a.durationMs);
  return (
    <div className="agx-wf-agent" data-state={a.state}>
      <span className="agx-wf-mark" aria-hidden>
        {running ? <Ring size={10} label={null} /> : a.state === 'done' ? <Icon name="check" size={10} weight="bold" /> : a.state === 'error' ? <Icon name="x" size={10} weight="bold" /> : <span className="agx-wf-queued" />}
      </span>
      {label(a.label)}
      <span className={running ? 'agx-wf-now truncate shimmer' : 'agx-wf-now truncate'}>{a.state === 'error' ? (a.error ?? 'Failed') : a.state === 'queued' ? 'Waiting to start' : running ? (a.activity ?? '') : ''}</span>
      {meta && <span className="agx-wf-meta num">{meta}</span>}
    </div>
  );
}
