import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { ContextBreakdown, ProviderId } from '@shared/protocol';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatCost, formatTokens } from '@/lib/format';
import { modelNameById } from '@/lib/models';
import { LimitsGlance } from '@/features/usage';
import { useLimitsReport } from '@/state/hooks';
import { openUsage, readLimitsNow, refreshLimits, sendMessage } from '@/state/actions';
import { useLimitsTicker } from '@/features/usage/ticker';
import { accountKey, useStore } from '@/state/store';
import { IconButton, Tip } from '@/ui';

/** Context categories in steps of ivory, brightest first: the interface stays monochrome. */
const STEPS = [0.9, 0.66, 0.48, 0.35, 0.26, 0.19, 0.14, 0.1];
const tint = (i: number) => `rgb(242 241 238 / ${STEPS[Math.min(i, STEPS.length - 1)]})`;

interface Segment {
  name: string;
  tokens: number;
  color: string;
}

export function ContextTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const caps = useStore((s) => s.data[sessionId]?.caps);
  const provider = session?.provider;
  const [ctx, setCtx] = useState<ContextBreakdown | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const status = session?.status;
  const busy = status === 'running' || status === 'starting';
  const usedTokens = session?.usage.contextTokens;

  const load = () => {
    setLoading(true);
    bridge
      .call('session.context', { sessionId })
      .then((r) => setCtx(r))
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  };

  // Refresh when shown, when a turn settles and when the reported context size moves.
  const haveCtx = ctx !== undefined;
  useEffect(() => {
    if (!active || (busy && haveCtx)) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, busy, usedTokens, sessionId]);

  useEffect(() => {
    if (active && provider) void refreshLimits(provider, session?.accountId);
  }, [active, provider, session?.accountId]);
  useLimitsTicker(active && !!provider, () => provider && void refreshLimits(provider, session?.accountId));

  const usage = session?.usage;
  const view = useMemo(() => {
    if (ctx && ctx.maxTokens > 0) {
      const used = ctx.categories.filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
      const segments: Segment[] = used.map((c, i) => ({ name: c.name, tokens: c.tokens, color: tint(i) }));
      const free = ctx.categories.filter((c) => c.kind === 'free').reduce((n, c) => n + c.tokens, 0);
      const buffer = ctx.categories.filter((c) => c.kind === 'buffer').reduce((n, c) => n + c.tokens, 0);
      return { total: ctx.totalTokens, max: ctx.maxTokens, segments, free, buffer, model: ctx.model, detailed: true };
    }
    if (usage?.contextWindow) {
      const total = usage.contextTokens ?? 0;
      return {
        total,
        max: usage.contextWindow,
        segments: total ? [{ name: 'Used', tokens: total, color: tint(0) }] : [],
        free: Math.max(0, usage.contextWindow - total),
        buffer: 0,
        model: session?.model,
        detailed: false,
      };
    }
    return null;
  }, [ctx, usage?.contextTokens, usage?.contextWindow, session?.model]);

  if (!session) return null;
  const pct = view ? Math.min(100, (view.total / view.max) * 100) : 0;

  const modelName = view?.model ? modelNameById(view.model, caps?.models) : session.model ? modelNameById(session.model, caps?.models) : '';

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title truncate">{modelName || 'Context window'}</span>
        <span className="rail-bar-actions">
          <IconButton icon="refresh" label="Refresh" size={14} className={loading ? 'is-spinning' : undefined} onClick={load} />
        </span>
      </div>
    <div className="rail-scroll scroll">
      <div className="rail-stack cx-stack">
        {/* One flat list on the panel, no card: the ring and its figure at a heading's size, then the
            categories, the session's figures and the plan's limits as rows of label and figure. */}
        <section className="cx-sec" aria-label="Context window">
          {view ? (
            <>
              <div className="cx-figure">
                <Ring segments={view.segments} max={view.max} buffer={view.buffer} />
                <div className="cx-numbers">
                  <div className="cx-head num">
                    <span className="cx-pct" data-warn={pct > 80 || undefined}>
                      {pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%
                    </span>
                    <span className="cx-of">
                      {formatTokens(view.total)} of {formatTokens(view.max)}
                    </span>
                  </div>
                  <div className="cx-left num">
                    {view.buffer > 0
                      ? `${formatTokens(Math.max(0, view.max - view.total - view.buffer))} left before it compacts`
                      : `${formatTokens(Math.max(0, view.max - view.total))} free`}
                  </div>
                </div>
              </div>
              {view.detailed ? (
                <ul className="cx-legend">
                  {view.segments.map((s) => (
                    <li key={s.name} className="cx-row">
                      <span className="cx-swatch" style={{ '--c': s.color } as CSSProperties} />
                      <span className="cx-name truncate">{s.name}</span>
                      <span className="cx-tokens num">{formatTokens(s.tokens)}</span>
                      <span className="cx-share num">{share(s.tokens, view.max)}</span>
                    </li>
                  ))}
                  {view.buffer > 0 && (
                    <li className="cx-row cx-row-quiet">
                      <span className="cx-swatch cx-swatch-buffer" />
                      <span className="cx-name truncate">Autocompact buffer</span>
                      <span className="cx-tokens num">{formatTokens(view.buffer)}</span>
                      <span className="cx-share num">{share(view.buffer, view.max)}</span>
                    </li>
                  )}
                  <li className="cx-row cx-row-quiet">
                    <span className="cx-swatch cx-swatch-free" />
                    <span className="cx-name truncate">Free space</span>
                    <span className="cx-tokens num">{formatTokens(view.free)}</span>
                    <span className="cx-share num">{share(view.free, view.max)}</span>
                  </li>
                </ul>
              ) : (
                <p className="cx-note">A breakdown by category appears once the agent process is running.</p>
              )}
            </>
          ) : ctx === undefined ? (
            <div className="rail-loading">
              <span className="spinner" />
              Measuring the context
            </div>
          ) : (
            <p className="cx-note">Context usage appears after the first reply.</p>
          )}
          {caps?.features.compact && (
            <div className="cx-compact">
              {busy ? (
                // A disabled button takes no pointer: the span around it carries the reason.
                <Tip label="Available when this turn ends" side="top">
                  <span className="cx-compact-wrap" tabIndex={0}>
                    <button type="button" className="btn btn-sm" disabled>
                      <Icon name="broom" size={14} />
                      Compact conversation
                    </button>
                  </span>
                </Tip>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => void sendMessage(sessionId, '/compact')}>
                  <Icon name="broom" size={14} />
                  Compact conversation
                </button>
              )}
            </div>
          )}
        </section>

        <section aria-label="Session totals">
          <div className="rail-h">
            <span>This session</span>
          </div>
          <ul className="cx-legend cx-stats">
            <Stat label="Input" value={formatTokens(usage?.inputTokens)} />
            <Stat label="Output" value={formatTokens(usage?.outputTokens)} />
            <Stat label="Cached" value={formatTokens(usage?.cacheReadTokens)} />
            <Stat label="Turns" value={String(usage?.turns ?? 0)} />
            <Stat label="Cost" value={formatCost(usage?.costUsd)} />
          </ul>
        </section>

        {provider && <Limits provider={provider} accountId={session.accountId} />}
      </div>
    </div>
    </div>
  );
}

function share(tokens: number, max: number) {
  const p = (tokens / max) * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/** One of the session's figures: a row of label and figure, as the categories above it. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li className="cx-row">
      <span className="cx-name truncate">{label}</span>
      <span className="cx-tokens num">{value}</span>
    </li>
  );
}

/** The ring's size on the panel (CSS px): beside a heading's figure, not a display. */
const RING = 40;
const R = 52;
const STROKE = 16;
const C = 2 * Math.PI * R;
const GAP = 2.2;

/** The context window as a ring: used categories as tinted arcs, the compact buffer hatched, free space as the track. */
function Ring({ segments, max, buffer }: { segments: Segment[]; max: number; buffer: number }) {
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.tokens / max) * C;
    const arc = { ...s, len, offset };
    offset += len;
    return arc;
  });
  const bufLen = (buffer / max) * C;
  const bufStart = C - bufLen;
  return (
    <svg className="cx-ring" viewBox="0 0 128 128" width={RING} height={RING} aria-hidden>
      <defs>
        <pattern id="cx-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="rgb(255 255 255 / 0.04)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgb(255 255 255 / 0.2)" strokeWidth="1.4" />
        </pattern>
      </defs>
      <g transform="rotate(-90 64 64)">
        <circle cx="64" cy="64" r={R} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={STROKE} />
        {bufLen > 0 && (
          <circle cx="64" cy="64" r={R} fill="none" stroke="url(#cx-hatch)" strokeWidth={STROKE} strokeDasharray={`${Math.max(0, bufLen - GAP)} ${C}`} strokeDashoffset={-bufStart} />
        )}
        {arcs.map((a) => (
          <circle
            key={a.name}
            className="cx-arc"
            cx="64"
            cy="64"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth={STROKE}
            strokeDasharray={`${Math.max(0.8, a.len - (arcs.length > 1 ? GAP : 0))} ${C}`}
            strokeDashoffset={-a.offset}
          />
        ))}
      </g>
    </svg>
  );
}

/**
 * The session's account plan limits, as on the Usage page (compact): every window it has, the pace
 * under each, "as of" when the figures are old. Hidden while nothing is known about them.
 */
function Limits({ provider, accountId }: { provider: ProviderId; accountId?: string }) {
  const report = useLimitsReport(provider, accountId);
  const known = useStore((s) => !!s.limits[accountKey(provider, accountId)]?.length);
  if (!report?.limits.length && !known) return null;
  return (
    <section aria-label="Plan limits">
      <div className="rail-h">
        <span>Plan limits</span>
        <span className="ul-rail-actions">
          <IconButton icon="gauge" label="Usage" size={13} onClick={openUsage} className="rail-h-btn" />
          <IconButton icon="refresh" label="Read limits now" size={13} onClick={() => void readLimitsNow(provider, accountId)} className="rail-h-btn" />
        </span>
      </div>
      <div className="ul-rail cx-limits">
        {/* The tab keeps them current while it is shown; the glance only shows them. */}
        <LimitsGlance provider={provider} accountId={accountId} read={false} />
      </div>
    </section>
  );
}
