import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { baseName, tildePath } from '@/lib/format';
import { modelNameById } from '@/lib/models';
import { openSession, resumeFromHistory } from '@/state/actions';
import { useStore } from '@/state/store';
import { Tooltip as RT } from 'radix-ui';
import { cx, PathLabel, Segmented } from '@/ui';
import { axisLabel, compact, niceScale, summarize, type DayBar, type Grouping, type Namers, type Ranked, type RankedSession, type Summary } from './aggregate';
import { dayLabel, isApiKey, money } from './format';
import { loadUsage, useUsageStore } from './usage-store';

type Range = '7' | '14' | '30';

const RANGES: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
];

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
  { value: 'account', label: 'Account' },
];

const RANGE_KEY = 'sable.usage.range';

function storedRange(): Range {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return v === '7' || v === '30' ? v : '14';
  } catch {
    return '14';
  }
}

/** How groups are named: models by the agent's own names, accounts by agent and label. */
function useNamers(): Namers {
  const providers = useStore((s) => s.providers);
  return useMemo(() => {
    const caps = useStore.getState().providerCaps;
    const modelsOf = (provider: string) => Object.entries(caps).find(([k]) => k.startsWith(`${provider}:`))?.[1]?.models;
    return {
      model: (id, provider) => modelNameById(id, modelsOf(provider)) ?? id,
      account: (provider, accountId) => {
        const p = providers[provider as ProviderId];
        const a = p?.accounts?.find((x) => x.id === accountId);
        const name = PROVIDER_NAME[provider as ProviderId] ?? provider;
        return a && (p?.accounts?.length ?? 0) > 1 ? `${name} · ${a.label}` : name;
      },
      paysPerToken: (provider, accountId) => {
        const p = providers[provider as ProviderId];
        const a = p?.accounts?.find((x) => x.id === accountId);
        return isApiKey(a?.auth ?? (accountId === 'default' ? p?.auth : undefined));
      },
    };
  }, [providers]);
}

/** Tokens per day as bars, the token history in ranked lists, today's and the period's totals. */
export function ActivitySection() {
  const report = useUsageStore((s) => s.report);
  const failed = useUsageStore((s) => s.failed);
  const ready = useStore((s) => s.ready);
  const [range, setRangeState] = useState<Range>(storedRange);
  const [grouping, setGrouping] = useState<Grouping>('model');
  const names = useNamers();

  useEffect(() => {
    if (ready) void loadUsage(false);
  }, [ready]);

  const setRange = (r: Range) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* a convenience only */
    }
  };

  const summary = useMemo(() => (report ? summarize(report, Number(range), grouping, names) : null), [report, range, grouping, names]);
  const scanning = !!report?.scanning;

  let body: ReactNode;
  if (!summary) body = failed ? <p className="ul-empty card">Usage could not be read.</p> : <ActivitySkeleton />;
  else if (!summary.total) body = scanning ? <ActivitySkeleton /> : <p className="ul-empty card">No usage in the last {range} days.</p>;
  else
    body = (
      <>
        <div className="ua-card card" data-spot>
          <div className="ua-figures">
            <Figure value={compact(summary.today)} label="Today" />
            <Figure value={compact(summary.total)} label={`Last ${range} days`} aside={summary.tokens.cacheRead ? `+ ${compact(summary.tokens.cacheRead)} cached` : undefined} />
            {summary.costUsd !== undefined && <Figure value={money(summary.costUsd)} label="Cost" quiet />}
            <div className="ua-grouping">
              <Segmented id="usage-grouping" value={grouping} onChange={setGrouping} options={GROUPINGS} />
            </div>
          </div>
          <Chart summary={summary} grouping={grouping} />
        </div>
        <div className="ua-lists">
          <RankList title="Models" items={summary.models} total={summary.total} marks />
          <RankList title="Projects" items={summary.projects} total={summary.total} project />
          <SessionList items={summary.sessions} />
        </div>
      </>
    );

  return (
    <section className="set-group" aria-labelledby="ua-title">
      <header className="set-group-head">
        <h3 className="set-group-title" id="ua-title">
          Activity
        </h3>
        {scanning && summary?.total ? <span className="ua-scanning shimmer">Reading transcripts</span> : null}
        <div className="set-group-aside">
          <Segmented id="usage-range" value={range} onChange={setRange} options={RANGES} />
        </div>
      </header>
      {body}
    </section>
  );
}

function Figure({ value, label, quiet, aside }: { value: string; label: string; quiet?: boolean; aside?: string }) {
  return (
    <div className="ua-figure" data-quiet={quiet || undefined}>
      <span className="ua-figure-value num">
        {value}
        {aside && <span className="ua-figure-aside">{aside}</span>}
      </span>
      <span className="ua-figure-label">{label}</span>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="ua-card card ua-skel" aria-busy="true" aria-label="Reading usage">
      <div className="ua-figures">
        <div className="ua-figure">
          <span className="skel" style={{ width: 72, height: 20, borderRadius: 6 }} />
          <span className="skel" style={{ width: 40, height: 9 }} />
        </div>
        <div className="ua-figure">
          <span className="skel" style={{ width: 88, height: 20, borderRadius: 6 }} />
          <span className="skel" style={{ width: 64, height: 9 }} />
        </div>
      </div>
      <div className="ua-skel-bars">
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} className="skel" style={{ height: `${18 + ((i * 37) % 60)}%`, borderRadius: 3 }} />
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── chart ─────────────────────────────

const CHART_H = 148;
const LABEL_W = 44;
const TOP_PAD = 10;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.clientWidth));
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

type Tone = 0 | 1 | 2 | 'other';
type Ids = { d50: string; d25: string };

/** A group's tone: solid ivory, then two dither densities, then a flat low tone for "Other". */
const toneOf = (i: number, count: number, other: boolean): Tone => ((other && i === count - 1) || i > 2 ? 'other' : (i as 0 | 1 | 2));
const toneFill = (t: Tone, ids: Ids) => (t === 'other' ? 'var(--ua-tone-other)' : t === 0 ? 'var(--ua-tone-0)' : t === 1 ? `url(#${ids.d50})` : `url(#${ids.d25})`);

/** The two dither patterns, defined once per SVG. */
function DitherDefs({ ids }: { ids: Ids }) {
  return (
    <defs>
      <pattern id={ids.d50} width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" className="ua-dither-ground" />
        <rect width="2" height="2" className="ua-dither-dot" />
        <rect x="2" y="2" width="2" height="2" className="ua-dither-dot" />
      </pattern>
      <pattern id={ids.d25} width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" className="ua-dither-ground" />
        <rect width="2" height="2" className="ua-dither-dot" />
      </pattern>
    </defs>
  );
}

const Chart = memo(function Chart({ summary, grouping }: { summary: Summary; grouping: Grouping }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const uid = useId().replace(/[^\w-]/g, '');
  const ids = { d50: `ua-d50-${uid}`, d25: `ua-d25-${uid}` };
  const bars = summary.bars;
  const n = bars.length;
  const today = summary.days[n - 1];
  const hasOther = summary.groups[summary.groups.length - 1]?.key === '\u0000other';
  const { top, step } = niceScale(Math.max(...bars.map((b) => b.total), 1));
  const plotW = Math.max(0, width - LABEL_W);
  const slot = n ? plotW / n : 0;
  const gap = Math.min(n > 20 ? 3 : 6, slot * 0.35);
  const barW = Math.max(2, slot - gap);
  const y = (v: number) => CHART_H - (v / top) * (CHART_H - TOP_PAD);
  const x = (i: number) => LABEL_W + i * slot + gap / 2;
  const ticks: number[] = [];
  for (let v = step; v <= top + step / 2; v += step) ticks.push(v);
  const shown = active ?? n - 1;
  const tipOpen = active !== null;

  const onKey = (e: KeyboardEvent) => {
    const cur = active ?? n - 1;
    let next = cur;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape' && active !== null) {
      e.stopPropagation();
      setActive(null);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
  };

  const labelStyle = n <= 7 ? 'weekday' : 'date';
  const labelEvery = n <= 7 ? 1 : 7;

  return (
    <div className="ua-chart">
      <div
        ref={wrap}
        className="ua-plot"
        tabIndex={0}
        role="group"
        aria-roledescription="bar chart"
        aria-label={`Tokens per day, last ${n} days. Use the arrow keys to read each day.`}
        onKeyDown={onKey}
        onFocus={() => {
          setFocused(true);
          setActive((a) => a ?? n - 1);
        }}
        onBlur={() => {
          setFocused(false);
          setActive(null);
        }}
        onPointerLeave={() => !focused && setActive(null)}
        style={{ height: CHART_H }}
      >
        {width > 0 && (
          <svg width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`} aria-hidden>
            <DitherDefs ids={ids} />
            {ticks.map((v) => (
              <g key={v}>
                <line x1={LABEL_W} x2={width} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} className="ua-grid" />
                <text x={LABEL_W - 10} y={y(v) + 4} className="ua-axis num" textAnchor="end">
                  {axisLabel(v)}
                </text>
              </g>
            ))}
            <line x1={LABEL_W} x2={width} y1={CHART_H - 0.5} y2={CHART_H - 0.5} className="ua-base" />
            {bars.map((b, i) => (
              <Bar key={b.day} bar={b} x={x(i)} w={barW} y={y} on={i === shown} ids={ids} tone={(gi) => toneOf(gi, summary.groups.length, hasOther)} />
            ))}
            {bars.map((b, i) => (
              <rect key={b.day} x={LABEL_W + i * slot} y={0} width={slot} height={CHART_H} fill="transparent" onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)} />
            ))}
          </svg>
        )}
        {tipOpen && width > 0 && <Tip bar={bars[shown]} summary={summary} grouping={grouping} today={today} left={x(shown) + barW / 2} tone={(gi) => toneOf(gi, summary.groups.length, hasOther)} />}
      </div>
      <div className="ua-xlabels" aria-hidden style={{ paddingLeft: LABEL_W }}>
        {width > 0 &&
          bars.map((b, i) =>
            (n - 1 - i) % labelEvery === 0 ? (
              <span key={b.day} className="ua-xlabel num" data-on={i === shown || undefined} style={{ left: x(i) + barW / 2 }}>
                {dayLabel(b.day, labelStyle, today)}
              </span>
            ) : null,
          )}
      </div>
      <Legend summary={summary} grouping={grouping} tone={(gi) => toneOf(gi, summary.groups.length, hasOther)} />
      <div className="sr-only" aria-live="polite">
        {active !== null ? `${dayLabel(bars[active].day, 'long', today)}: ${compact(bars[active].total)} tokens` : ''}
      </div>
    </div>
  );
});

function Bar({ bar, x, w, y, on, tone, ids }: { bar: DayBar; x: number; w: number; y: (v: number) => number; on: boolean; tone: (gi: number) => Tone; ids: Ids }) {
  if (!bar.total) return <rect x={x} y={CHART_H - 2} width={w} height={2} rx={1} className="ua-bar-empty" />;
  let base = CHART_H;
  let acc = 0;
  const parts = bar.parts.map((v, gi) => ({ v, gi })).filter((p) => p.v > 0);
  return (
    <g className="ua-bar" data-on={on || undefined}>
      {parts.map(({ v, gi }, k) => {
        acc += v;
        const topY = y(acc);
        const h = base - topY;
        // A hairline of ground between stacked parts.
        const sep = k > 0 && h > 3 ? 1 : 0;
        const r = <rect key={gi} x={x} y={topY} width={w} height={Math.max(1, h - sep)} rx={k === parts.length - 1 ? 2 : 0.5} fill={toneFill(tone(gi), ids)} />;
        base = topY;
        return r;
      })}
    </g>
  );
}

function Swatch({ tone }: { tone: Tone }) {
  const uid = useId().replace(/[^\w-]/g, '');
  const ids = { d50: `ua-s50-${uid}`, d25: `ua-s25-${uid}` };
  return (
    <svg className="ua-swatch" width={10} height={10} viewBox="0 0 10 10" aria-hidden>
      {(tone === 1 || tone === 2) && <DitherDefs ids={ids} />}
      <rect width={10} height={10} rx={2.5} fill={toneFill(tone, ids)} />
    </svg>
  );
}

const groupText = (label: string, grouping: Grouping) => (grouping === 'project' ? baseName(label) || label : label);

function Legend({ summary, grouping, tone }: { summary: Summary; grouping: Grouping; tone: (gi: number) => Tone }) {
  return (
    <ul className="ua-legend">
      {summary.groups.map((g, gi) => (
        <li key={g.key} className="ua-legend-item" title={g.label}>
          <Swatch tone={tone(gi)} />
          <span className="truncate">{groupText(g.label, grouping)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The day's figures above the plot, centred on the bar: never over the bars beside it. Floats in a
 * portal (like any tooltip) so the Settings scroller cannot clip it; flips below when there is no room.
 */
function Tip({ bar, summary, grouping, today, left, tone }: { bar: DayBar; summary: Summary; grouping: Grouping; today: string; left: number; tone: (gi: number) => Tone }) {
  const parts = summary.groups.map((g, gi) => ({ g, gi, v: bar.parts[gi] })).filter((p) => p.v > 0);
  return (
    <RT.Root open>
      <RT.Trigger asChild>
        <span className="ua-tip-anchor" style={{ left }} aria-hidden />
      </RT.Trigger>
      <RT.Portal>
        <RT.Content className="ua-tip glass" side="top" align="center" sideOffset={10} collisionPadding={12} updatePositionStrategy="always" aria-label={`${dayLabel(bar.day, 'long', today)}: ${compact(bar.total)} tokens`}>
          <div className="ua-tip-head">
            <span>{dayLabel(bar.day, 'long', today)}</span>
            {bar.day === today && <span className="ua-tip-today">Today</span>}
          </div>
          <div className="ua-tip-total num">
            {compact(bar.total)} <span className="ua-tip-unit">tokens</span>
          </div>
          {parts.length > 0 && (
            <ul className="ua-tip-parts">
              {parts.map(({ g, gi, v }) => (
                <li key={g.key}>
                  <Swatch tone={tone(gi)} />
                  <span className="truncate">{groupText(g.label, grouping)}</span>
                  <span className="num">{compact(v)}</span>
                </li>
              ))}
            </ul>
          )}
          {bar.total > 0 && (
            <div className="ua-tip-split num">
              <span>In {compact(bar.tokens.input)}</span>
              <span>Out {compact(bar.tokens.output)}</span>
              {bar.tokens.cacheWrite > 0 && <span>Cache write {compact(bar.tokens.cacheWrite)}</span>}
              {bar.tokens.cacheRead > 0 && <span>Cache read {compact(bar.tokens.cacheRead)}</span>}
              {bar.costUsd ? <span>{money(bar.costUsd)}</span> : null}
            </div>
          )}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

// ───────────────────────────── ranked lists ─────────────────────────────

const LIST_ROWS = 5;

function RankList({ title, items, total, project, marks }: { title: string; items: Ranked[]; total: number; project?: boolean; marks?: boolean }) {
  const [all, setAll] = useState(false);
  const home = useStore((s) => s.home);
  if (!items.length) return null;
  const max = items[0].total || 1;
  const shown = all ? items : items.slice(0, LIST_ROWS);
  return (
    <section className="ua-list" aria-label={title}>
      <h4 className="ua-list-title">{title}</h4>
      <div className="ua-list-card card" data-spot>
        {shown.map((it) => (
          <div key={it.key} className="ua-rank" title={it.label}>
            <span className="ua-rank-label">
              {project ? (
                <PathLabel path={tildePath(it.label, home)} />
              ) : (
                <span className="ua-rank-name">
                  {marks && it.provider && <ProviderMark provider={it.provider} size={13} className="ua-rank-mark" />}
                  <span className="truncate">{it.label}</span>
                </span>
              )}
            </span>
            <span className="ua-rank-track" aria-hidden>
              <span className="ua-rank-fill" style={{ transform: `scaleX(${it.total / max})` }} />
            </span>
            <span className="ua-rank-value num">{compact(it.total)}</span>
            <span className="ua-rank-share num">{share(it.total, total)}</span>
          </div>
        ))}
        {items.length > LIST_ROWS && (
          <button type="button" className="ua-more" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        )}
      </div>
    </section>
  );
}

function share(v: number, total: number) {
  if (!total) return '';
  const p = (v / total) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

function SessionList({ items }: { items: RankedSession[] }) {
  const home = useStore((s) => s.home);
  const setUi = useStore((s) => s.setUi);
  if (!items.length) return null;
  const max = items[0].total || 1;
  const open = (it: RankedSession) => {
    const s = it.session;
    if (s.sableId && useStore.getState().sessions[s.sableId]) {
      setUi({ settings: null });
      openSession(s.sableId);
    } else if (s.providerSessionId && s.project && s.provider !== 'demo') {
      setUi({ settings: null });
      void resumeFromHistory(s.provider, s.providerSessionId, s.project, s.title, s.accountId);
    }
  };
  return (
    <section className="ua-list" aria-label="Heaviest sessions">
      <h4 className="ua-list-title">Heaviest sessions</h4>
      <div className="ua-list-card card" data-spot>
        {items.map((it) => {
          const s = it.session;
          const canOpen = !!(s.sableId || (s.providerSessionId && s.project && s.provider !== 'demo'));
          const Row = canOpen ? 'button' : 'div';
          return (
            <Row key={it.key} {...(canOpen ? { type: 'button' as const, onClick: () => open(it) } : {})} className={cx('ua-rank ua-session', canOpen && 'is-link')}>
              <ProviderMark provider={s.provider} size={13} className="ua-session-mark" />
              <span className="ua-rank-label ua-session-text">
                <span className="truncate">{it.label}</span>
                {s.project && <PathLabel path={tildePath(s.project, home)} className="ua-session-path" />}
              </span>
              <span className="ua-rank-track" aria-hidden>
                <span className="ua-rank-fill" style={{ transform: `scaleX(${it.total / max})` }} />
              </span>
              <span className="ua-rank-value num">{compact(it.total)}</span>
              <span className="ua-rank-share num">{it.costUsd ? money(it.costUsd) : ''}</span>
            </Row>
          );
        })}
      </div>
    </section>
  );
}
