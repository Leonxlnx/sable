import { memo, useEffect, useMemo, useState } from 'react';
import type { TimelineItem, TurnItem, UserItem } from '@shared/protocol';
import { syntheticLine, syntheticOf } from '@shared/synthetic';
import { CopyButton } from '@/components/CopyButton';
import { BeforeAfter } from '@/features/compare/BeforeAfter';
import { LazyTip } from '@/components/LazyTip';
import { Icon } from '@/icons';
import { PROVIDER_NAME, ProviderMark } from '@/art/Logo';
import { formatCost, formatTokens, isMac } from '@/lib/format';
import { openPreview, previewTargets } from '@/lib/links';
import { checkTurn, forkAt, sendMessage } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Tip } from '@/ui';
import { changesOf } from './changes';
import { canCheckWith, checkedAlready, checkerOf } from './check-turn';
import { useItem, useTimeline } from './ctx';
import type { TurnGroup } from './turns';
import { stampParts } from './util';

const textOf = (it: TimelineItem | undefined) => (it?.type === 'text' ? it.text.trim() : '');

/** What a copy of the response holds: the answers of every segment, or failing that every text. */
function responseText(items: Record<string, TimelineItem>, turn: TurnGroup): string {
  const answers = turn.segments.map((s) => textOf(s.answer ? items[s.answer] : undefined)).filter(Boolean);
  if (answers.length) return answers.join('\n\n');
  return turn.ids
    .map((id) => textOf(items[id]))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Whether a plan limit refused this turn and its window has not reset yet. Its notice then offers
 * what can work (another account, a reset, waiting for it); trying again on the same account would
 * only be refused again. Once the window resets, "Try again" comes back (one timer, set to the reset).
 */
function useLimitHolds(sessionId: string, ids: string[], failed: boolean): boolean {
  const until = useStore((s) => {
    if (!failed) return 0;
    const items = s.data[sessionId]?.items;
    for (const id of ids) {
      const it = items?.[id];
      if (it?.type === 'notice' && it.limit) return it.limit.resetsAt ?? 0;
    }
    return 0;
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.min(left + 250, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [until]);
  return until > Date.now();
}

/** Local pages the turn mentions: in its answers first, then in what its commands printed. */
function previewsOf(items: Record<string, TimelineItem>, turn: TurnGroup) {
  const texts: (string | undefined)[] = turn.segments.map((s) => textOf(s.answer ? items[s.answer] : undefined));
  for (let i = turn.ids.length - 1; i >= 0; i--) {
    const it = items[turn.ids[i]];
    if (it?.type === 'tool' && it.kind === 'bash') texts.push(it.output, it.result?.text);
  }
  return previewTargets(texts);
}

/**
 * Under a turn's answer: Preview controls for local pages it started or mentioned, "Try again"
 * after a failure, and on hover what the turn cost and a copy of the response.
 */
export const TurnFoot = memo(function TurnFoot({ turn }: { turn: TurnGroup }) {
  const { sessionId } = useTimeline();
  const end = useItem<TurnItem>(turn.end ?? '');
  const settled = turn.state !== 'running';
  const previews = useMemo(() => (settled ? previewsOf(useStore.getState().data[sessionId]?.items ?? {}, turn) : []), [settled, sessionId, turn]);
  const [forking, setForking] = useState(false);
  // "Check with Codex": a settled turn that changed files, while the other agent can check.
  const checker = useStore((s) => checkerOf(s.sessions[sessionId]?.provider));
  const checkerReady = useStore((s) => (checker ? canCheckWith(s.providers[checker]) : false));
  const checked = useStore((s) => checkedAlready(s.data[sessionId]?.items, turn.checks));
  const changed = useMemo(() => {
    if (!settled) return false;
    const d = useStore.getState().data[sessionId];
    return changesOf(d?.items ?? {}, d?.children ?? {}, turn.ids).files > 0;
  }, [settled, sessionId, turn]);
  const [checking, setChecking] = useState(false);
  const limitHolds = useLimitHolds(sessionId, turn.ids, turn.state === 'failed');
  if (!settled) return null;
  // A check is asked for by the message that opened the turn: a turn the agent began by itself has none.
  const canCheck = !!checker && checkerReady && changed && !checked && !!turn.segments[0]?.lead;

  const check = async () => {
    if (checking) return;
    setChecking(true);
    await checkTurn(sessionId, turn.key);
    setChecking(false);
  };

  const fork = async () => {
    const last = turn.ids[turn.ids.length - 1];
    if (!last || forking) return;
    setForking(true);
    await forkAt(sessionId, last);
    setForking(false);
  };

  const items = () => useStore.getState().data[sessionId]?.items ?? {};
  const failed = turn.state === 'failed';
  const errorShown = turn.segments.some((s) => s.errors.length > 0);
  const hasAnswer = turn.segments.some((s) => s.answer);

  // What "Try again" sends: the turn's message, or a slash command as it was typed. A turn a
  // notification opened (a background task finished) has nothing of the person's to send again.
  const again = (): UserItem | undefined => {
    const all = items();
    const user = turn.ids.map((id) => all[id]).find((it): it is UserItem => it?.type === 'user' && syntheticOf(it)?.role !== 'hidden');
    const syn = syntheticOf(user);
    if (!user || !syn) return user;
    return syn.role === 'command' ? { ...user, text: syntheticLine(syn) } : undefined;
  };
  const retry = () => {
    const user = again();
    if (user) void sendMessage(sessionId, user.text, user.attachments ?? []);
  };

  const parts: string[] = [];
  const tokens = end?.type === 'turn' ? end.outputTokens || end.inputTokens : 0;
  if (tokens) parts.push(`${formatTokens(tokens)} tokens`);
  if (end?.type === 'turn' && end.costUsd) parts.push(formatCost(end.costUsd));
  const breakdown = end?.type === 'turn' && (end.inputTokens || end.outputTokens) ? `${formatTokens(end.inputTokens)} tokens read, ${formatTokens(end.outputTokens)} written` : undefined;

  const retryShown = failed && !limitHolds && !!again();
  const errorShownHere = failed && end?.type === 'turn' && !!end.error && !errorShown;
  if (!previews.length && !retryShown && !errorShownHere && !hasAnswer && !parts.length && turn.state !== 'interrupted') return null;
  // When the turn ended: shown with the facts where the conversation is too narrow for the times in its margin (timeline.css).
  const when = end?.type === 'turn' && end.ts ? stampParts(end.ts) : null;

  return (
    <div className="tl-item turn" data-state={turn.state}>
      {errorShownHere && end?.type === 'turn' && (
        <div className="notice-error" role="alert">
          <Icon name="error" size={16} />
          <div className="notice-error-body">
            <div className="notice-error-text">The turn ended with an error</div>
            <div className="notice-error-detail">{end.error}</div>
          </div>
        </div>
      )}
      <div className="turn-line">
        {/* One page: "Preview" and its address. Several: each named by its address alone. */}
        {previews.map((p) => (
          <LazyTip key={p.url} label={`Opens in the Browser tab. ${isMac ? 'Cmd' : 'Ctrl'}+click opens your browser`} side="top">
            <button type="button" className="preview-btn" onClick={(e) => openPreview(p.url, e.ctrlKey || e.metaKey)} aria-label={`Preview ${p.label}`}>
              <Icon name="browser" size={14} className="preview-icon" />
              {previews.length === 1 && <span className="preview-name">Preview</span>}
              <span className={previews.length === 1 ? 'preview-host truncate' : 'preview-name truncate'}>{p.label}</span>
            </button>
          </LazyTip>
        ))}
        {/* A turn that edited a local page: its before and after, beside Preview. */}
        <BeforeAfter sessionId={sessionId} turnId={turn.key} />
        {retryShown && (
          <button type="button" className="btn btn-sm" onClick={retry}>
            <Icon name="refresh" size={13} />
            Try again
          </button>
        )}
        {turn.state === 'interrupted' && (
          <span className="turn-note">
            <Icon name="hand" size={12} />
            Interrupted
          </span>
        )}
        {hasAnswer && (
          // Always there under an answer: quiet at rest, brighter on hover.
          <span className="turn-acts">
            <CopyButton text={() => responseText(items(), turn)} label="Copy response" size={13} className="turn-copy" />
            <IconButton icon="fork" label="Fork from here" size={13} tipSide="top" className="turn-fork" disabled={forking} onClick={fork} />
            {canCheck && checker && (
              <Tip label={`Check with ${PROVIDER_NAME[checker]}`} side="top">
                <button type="button" className="icon-btn turn-check" aria-label={`Check with ${PROVIDER_NAME[checker]}`} disabled={checking} onClick={check}>
                  <ProviderMark provider={checker} size={12} />
                </button>
              </Tip>
            )}
          </span>
        )}
        <span className="turn-hover">
          {parts.length > 0 && (
            <LazyTip label={breakdown ?? parts.join(' · ')} side="top">
              <span className="turn-meta num">{parts.join(' · ')}</span>
            </LazyTip>
          )}
          {when && end && (
            <time className="turn-meta turn-when num" data-after={parts.length > 0 || undefined} dateTime={new Date(end.ts).toISOString()}>
              {when.day && <span className="stamp-day">{when.day}</span>}
              {when.time}
            </time>
          )}
        </span>
      </div>
    </div>
  );
});
