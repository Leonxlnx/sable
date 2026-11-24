import { memo, useMemo } from 'react';
import type { ToolItem } from '@shared/protocol';
import { PROVIDER_NAME, ProviderMark } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { FileLinksProvider, useResolvedFiles } from '@/lib/file-links';
import { plural } from '@/lib/format';
import { stopCheck } from '@/state/actions';
import { useStore } from '@/state/store';
import { TrailStep, useTicker } from './Agent';
import { agentLimitText, agentTrail, readTrail } from './agent-line';
import { checkFailure, findingsMessage, hasFindings, withLineRefs } from './check-turn';
import { EMPTY, useTimeline } from './ctx';
import { foldKey, useFold } from './fold';
import { ItemList } from './items';
import { Elapsed, ownMs } from './Tool';
import { shortDuration } from './util';

type Store = ReturnType<typeof useStore.getState>;

/** How many of its latest steps a running check shows under its line. */
const TAIL = 3;

/**
 * A turn checked by the other agent ("Check with Codex"), under the turn it checks. One line with the
 * checker's mark and what it does; while it works its latest steps hang under it, with a stop. When
 * it is done its findings stay in view, `path:line` linked to the files, with one action that puts
 * them in the composer for the chat's own agent. Opened: every step it took.
 */
export const CheckBlock = memo(function CheckBlock({ item, tail = TAIL, scope = 'agent' }: { item: ToolItem; tail?: number; scope?: string }) {
  const { sessionId } = useTimeline();
  const check = item.check!;
  const who = PROVIDER_NAME[check.agent] ?? check.agent;
  const [open, setOpen] = useFold(foldKey(sessionId, item.id, scope), false);
  const live = item.status === 'running' || item.status === 'pending';
  const trail = useStore(useMemo(() => (s: Store) => agentTrail(s.data[sessionId]?.items, s.data[sessionId]?.children[item.id], tail), [sessionId, item.id, tail]));
  const { steps, ids, now } = readTrail(trail);
  const rows = useTicker(trail);
  const shown = ids.length + (now ? 1 : 0);

  const findings = item.status === 'done' ? (item.result?.text ?? '').trim() : '';
  const limit = item.status === 'error' ? agentLimitText(item) : undefined;
  const why = item.status === 'error' ? (limit ?? checkFailure(item)) : '';
  const title = live ? `${who} is checking this turn` : item.status === 'done' ? `${who} checked this turn` : item.status === 'cancelled' ? 'Check stopped' : `${who} could not check this turn`;
  const took = !live && ownMs(item) >= 1000 ? shortDuration(ownMs(item)) : '';

  return (
    <div className="agent check" data-status={item.status} data-live={live || undefined} data-open={open || undefined}>
      <div className="agent-head">
        <button type="button" className="row-btn tool-row agent-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="tool-icon">
            <ProviderMark provider={check.agent} size={13} />
          </span>
          <span className="agent-task truncate">{title}</span>
          <span className="tool-meta">
            {steps > 0 && <span className="num">{plural(steps, 'step')}</span>}
            {live ? <Elapsed since={item.ts} /> : took && <span className="num">{took}</span>}
          </span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
        {/* The word, not a lone 9 px square at the column's far end (it read as a stray pixel). */}
        {live && (
          <button type="button" className="btn btn-sm btn-ghost check-stop" aria-label="Stop the check" onClick={() => void stopCheck(sessionId, item.id)}>
            Stop
          </button>
        )}
      </div>
      <div className="agent-under">
        <Collapse open={!!why}>{why && <div className="agent-line check-why truncate">{why}</div>}</Collapse>
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
          <CheckBody item={item} live={live} findings={findings} />
        </Collapse>
        <Collapse open={!!findings}>{findings && <Findings sessionId={sessionId} checker={who} text={findings} />}</Collapse>
      </div>
    </div>
  );
});

/**
 * Opened: every step it took. Its last words are the findings, shown below the steps: not twice. The
 * brief it was given stays out of view (Sable's own instructions around the turn's diff).
 */
function CheckBody({ item, live, findings }: { item: ToolItem; live: boolean; findings: string }) {
  const { sessionId } = useTimeline();
  const children = useStore((s) => s.data[sessionId]?.children[item.id]) ?? EMPTY;
  // The text that carried the findings (its turn record may follow it).
  const said = useStore((s) => {
    if (live || !findings) return '';
    const items = s.data[sessionId]?.items;
    for (let i = children.length - 1; i >= 0; i--) {
      const it = items?.[children[i]];
      if (it?.type === 'text') return it.text.trim() === findings ? it.id : '';
    }
    return '';
  });
  const thread = useMemo(() => (said ? children.filter((id) => id !== said) : children), [children, said]);
  if (!thread.length) return null;
  return (
    <div className="agent-body">
      <div className="agent-thread">
        <ItemList ids={thread} nested />
      </div>
    </div>
  );
}

/** The findings, their files linked, and the hand-over to the chat's own agent when there is something to fix. */
function Findings({ sessionId, checker, text }: { sessionId: string; checker: string; text: string }) {
  const { cwd } = useTimeline();
  const main = useStore((s) => {
    const p = s.sessions[sessionId]?.provider;
    return p ? (PROVIDER_NAME[p] ?? p) : 'the agent';
  });
  const resolved = useResolvedFiles(text, cwd || undefined, true);
  const links = useMemo(() => withLineRefs(resolved, text), [resolved, text]);
  const found = hasFindings(text);

  const send = () => {
    const st = useStore.getState();
    const msg = findingsMessage(checker, text);
    // Anything already typed stays, with the findings after it.
    const typed = st.drafts[sessionId]?.text ?? '';
    const next = typed.trim() ? `${typed.replace(/\s+$/, '')}\n\n${msg}` : msg;
    st.setDraft(sessionId, { text: next });
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.dock textarea');
      field?.focus();
      field?.setSelectionRange(next.length, next.length);
    });
  };

  return (
    <div className="check-findings" data-found={found || undefined}>
      <FileLinksProvider value={links}>
        <Markdown text={text} />
      </FileLinksProvider>
      {found && (
        <div className="check-acts">
          <button type="button" className="btn btn-sm" onClick={send}>
            <Icon name="reply" size={13} />
            Send to {main}
          </button>
        </div>
      )}
    </div>
  );
}
