import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/icons';
import { Flood, HeightGuard } from './guard';
import { handlePrompt, linkFrame, postToFrame, type FrameLink } from './host';
import { trackFrame } from './frames';
import { cachedHeight, rememberHeight, useNear } from './near';
import { hasVisibleMarkup, prepareCode } from './partial';
import { baseCss, fontCss } from './theme';
import './genui.css';

export const FRAME_SRC = `${import.meta.env.BASE_URL ?? '/'}widget-frame.html`;

/** Partial renders while the code streams in: at most one per this many ms. */
const PARTIAL_EVERY = 220;
/** A drawn widget measured smaller than its block holds shrinks once that height has stayed this long (ms). */
const SHRINK_MS = 600;
/** Taller than this at rest, a widget is clipped behind "Show all". */
export const WIDGET_CAP = 560;

export interface FrameReport {
  errors: number;
  lastError?: string;
  blocked: number;
  lastBlocked?: string;
  /** Messages the widget tried to send and the app refused. */
  refused: number;
}

const EMPTY_REPORT: FrameReport = { errors: 0, blocked: 0, refused: 0 };

export interface WidgetFrameProps {
  /** Stable key for the remembered height (an item id, or a hash for fenced widgets). */
  cacheKey: string;
  code: string;
  /** The code is complete: scripts run and the widget is revealed. */
  final: boolean;
  title: string;
  /** The session a widget's sendPrompt goes to; without one, it is refused. */
  sessionId?: string;
  /** Height cap at rest (Infinity: never clip). */
  cap?: number;
  /** Shown while nothing can be drawn yet. */
  building?: boolean;
  /** Play the reveal when it completes (default: when it was still incomplete at mount). */
  reveal?: boolean;
  onReport?: (r: FrameReport) => void;
  className?: string;
}

type Phase = 'wait' | 'partial' | 'final';

interface LinkState {
  link: FrameLink;
  inited: boolean;
  sentFinal: boolean;
  lastPost: number;
  timer: number;
}

/**
 * One widget, drawn in a sandboxed frame. The frame exists only while the block is near the
 * viewport; its height is remembered, so the conversation keeps its shape when it is gone.
 * While the code streams: a dither skeleton that grows with the code, then the markup drawn as
 * it arrives (running nothing), then one reveal when the code is complete.
 */
export const WidgetFrame = memo(function WidgetFrame({ cacheKey, code, final, title, sessionId, cap = WIDGET_CAP, building, reveal: revealProp, onReport, className }: WidgetFrameProps) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const near = useNear(box);
  const remembered = useMemo(() => cachedHeight(cacheKey), [cacheKey]);
  const [h, setH] = useState<number | null>(null);
  /**
   * A height measured after the final render. The frame reports its empty page's height before the
   * code is drawn, so until then `h` is not the widget's: a widget opened again with the chat (its
   * height remembered) dropped to that height in the frame its render finished and grew back over
   * 200 ms, and the conversation's last line went with it (day 7, "x sub-agents working jumps").
   */
  const [sized, setSized] = useState(false);
  /**
   * A smaller height than the block holds that has stayed so for `SHRINK_MS`. A widget whose script
   * draws it measures its bare page first when the page is busy (a chat opened while its turn runs):
   * the block keeps what it holds until a smaller height stays.
   */
  const [held, setHeld] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('wait');
  const [stopped, setStopped] = useState<false | 'flood' | 'left'>(false);
  /** Times the widget navigated its frame: once it is rebuilt, twice it is stopped. */
  const [left, setLeft] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [reveal, setReveal] = useState(false);
  // Arrived whole, just now (the usual case with real agents: the call comes complete after the
  // thinking): the block opens from nothing to its height in one motion, then the reveal plays.
  const [whole] = useState(() => revealProp === true && final && cachedHeight(cacheKey) == null);
  const [anim, setAnim] = useState(whole);
  const floor = useRef(0);
  // Streamed in front of the reader: the end gets the reveal. History appears as it is.
  const streamed = useRef(revealProp ?? !final);
  const report = useRef<FrameReport>(EMPTY_REPORT);
  const latest = useRef({ code, final });
  latest.current = { code, final };
  const st = useRef<LinkState | null>(null);

  const bump = useCallback(
    (patch: Partial<FrameReport>) => {
      report.current = { ...report.current, ...patch };
      onReport?.(report.current);
    },
    [onReport],
  );

  /** Sends the newest code: a final render at once, partial renders paced. */
  const push = useCallback(() => {
    const s = st.current;
    if (!s || !s.inited || s.sentFinal) return;
    const { code: c, final: f } = latest.current;
    if (f) {
      window.clearTimeout(s.timer);
      s.timer = 0;
      s.sentFinal = true;
      postToFrame(s.link, { type: 'render', code: prepareCode(c, true), final: true });
      return;
    }
    const prepared = prepareCode(c, false);
    if (!hasVisibleMarkup(prepared)) return;
    const wait = PARTIAL_EVERY - (performance.now() - s.lastPost);
    if (wait > 0) {
      if (!s.timer)
        s.timer = window.setTimeout(() => {
          s.timer = 0;
          push();
        }, wait);
      return;
    }
    s.lastPost = performance.now();
    postToFrame(s.link, { type: 'render', code: prepared, final: false });
  }, []);

  useEffect(() => push(), [code, final, push]);

  const mounted = near && !stopped;

  // While the conversation scrolls, the frame lets the wheel through (frames.ts).
  useEffect(() => {
    const el = frame.current;
    if (!mounted || !el) return;
    return trackFrame(el);
  }, [mounted, left, final, code === '']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const outer = frame.current;
    if (!mounted || !outer) return;
    let alive = true;
    const guard = new HeightGuard();
    const state: LinkState = { link: undefined as unknown as FrameLink, inited: false, sentFinal: false, lastPost: 0, timer: 0 };
    let ready = false;
    let pendingH: unknown = null;
    let sizeRaf = 0;
    // Whether the final render was reported, and whether the pending height came after it.
    let drawn = false;
    let pendingDrawn = false;
    let lastV: number | null = null;
    let sizeWait = 0;
    const link: FrameLink = {
      outer,
      flood: new Flood(),
      kill: () => {
        if (alive) setStopped('flood');
      },
      receive: (m) => {
        switch (m.type) {
          case 'left':
            if (!alive) return;
            bump({ blocked: report.current.blocked + 1, lastBlocked: 'navigation away from the widget' });
            setLeft((n) => n + 1);
            return;
          case 'ready':
            if (ready) return;
            ready = true;
            void fontCss().then((fonts) => {
              if (!alive) return;
              postToFrame(link, { type: 'init', css: baseCss(), fonts });
              state.inited = true;
              push();
            });
            return;
          case 'size':
            // Coalesced: at most one height per animation frame, however many arrive.
            pendingH = m.h;
            pendingDrawn = drawn;
            sizeRaf ||= requestAnimationFrame(() => {
              sizeRaf = 0;
              const v = guard.push(pendingH, performance.now(), state.sentFinal);
              if (v !== null) lastV = v;
              if (!alive) return;
              if (v !== null) setH(v);
              if (pendingDrawn) {
                window.clearTimeout(sizeWait);
                setSized(true);
              }
            });
            return;
          case 'hover':
            // The bar shows while the pointer is over the frame (the app's :hover cannot see into it).
            box.current?.closest('.gw')?.toggleAttribute('data-hover', m.on === true);
            return;
          case 'rendered':
            if (m.final) {
              guard.settle();
              drawn = true;
              setPhase('final');
              // The frame measures again after drawing; should no height come (an older frame), the last one stands.
              window.clearTimeout(sizeWait);
              sizeWait = window.setTimeout(() => {
                if (!alive) return;
                if (lastV !== null) setH(lastV);
                setSized(true);
              }, 250);
            } else setPhase((p) => (p === 'final' ? p : 'partial'));
            return;
          case 'prompt':
            if (handlePrompt(outer, sessionId, m.text)) bump({ refused: report.current.refused + 1 });
            return;
          case 'error':
            bump({ errors: report.current.errors + 1, lastError: String(m.message ?? '').slice(0, 200) });
            return;
          case 'blocked':
            bump({ blocked: report.current.blocked + 1, lastBlocked: [m.directive, m.uri].filter(Boolean).join(' ').slice(0, 200) });
            return;
          default:
            return;
        }
      },
    };
    state.link = link;
    st.current = state;
    const unlink = linkFrame(link);
    return () => {
      alive = false;
      window.clearTimeout(state.timer);
      window.clearTimeout(sizeWait);
      cancelAnimationFrame(sizeRaf);
      unlink();
      box.current?.closest('.gw')?.removeAttribute('data-hover');
      if (st.current === state) st.current = null;
      setPhase('wait');
      setSized(false);
      setHeld(null);
    };
  }, [mounted, push, sessionId, bump, left]);

  useEffect(() => {
    if (left >= 2) setStopped('left');
  }, [left]);

  // The reveal plays once, when a widget that streamed in front of the reader is complete.
  useEffect(() => {
    if (phase !== 'final' || !streamed.current) return;
    streamed.current = false;
    setReveal(true);
    const t = window.setTimeout(() => setReveal(false), 900);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Height changes animate once this mount has measured something; the first one never does.
  useEffect(() => {
    if (h === null || anim) return;
    const r = requestAnimationFrame(() => setAnim(true));
    return () => cancelAnimationFrame(r);
  }, [h, anim]);

  const done = phase === 'final';
  // Drawn and measured: the widget's own height (see `sized`).
  const settled = done && sized && h !== null;
  const empty = final && !code.trim();
  const reserve = remembered ?? (whole ? 0 : final ? 160 : 200);
  const sizing = frameContent({ off: !!stopped || empty, settled, h, floor: floor.current, reserve, shrink: held !== null && held === h });
  const content = sizing.content;
  floor.current = sizing.floor;
  // Measured smaller than what the block holds: it shrinks once that height has stayed.
  const holding = settled && h !== null && sizing.floor > h;
  useEffect(() => {
    if (!holding || h === null) return;
    const t = window.setTimeout(() => setHeld(h), SHRINK_MS);
    return () => window.clearTimeout(t);
  }, [holding, h]);
  useEffect(() => {
    if (settled && !holding && h !== null && final) rememberHeight(cacheKey, h);
  }, [settled, holding, h, final, cacheKey]);
  const clippable = Number.isFinite(cap) && content > cap + 48 && !stopped;
  const clipped = clippable && !expanded;
  const boxH = clipped ? cap : content;
  const frameH = Math.max(content, 40);
  const skeleton = !stopped && !empty && phase === 'wait' && (!final || building);
  const len = code.length;

  return (
    <div className={`gw-frame ${className ?? ''}`}>
      <div
        ref={box}
        className="gw-box"
        style={{ height: boxH, '--gw-h': `${boxH}px` } as React.CSSProperties}
        data-phase={phase}
        data-anim={anim || undefined}
        data-clipped={clipped || undefined}
        data-reveal={reveal || undefined}
        data-building={(!final && phase === 'partial') || undefined}
      >
        {mounted && !empty && (
          <iframe
            key={left}
            ref={frame}
            className="gw-iframe"
            src={FRAME_SRC}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={title || 'Widget'}
            style={{ height: frameH }}
            tabIndex={0}
          />
        )}
        {skeleton && <Skeleton title={title} len={len} />}
        {stopped && <p className="gw-note">{stopped === 'left' ? 'Stopped: this widget kept trying to open another page.' : 'Stopped: this widget sent too many messages.'}</p>}
        {empty && <p className="gw-note">This widget is empty.</p>}
        {reveal && <span className="gw-sweep" aria-hidden />}        {clipped && <span className="gw-fade" aria-hidden />}
      </div>
      {clippable && (
        <button type="button" className="gw-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show all'}
          <Icon name="caret-down" size={11} />
        </button>
      )}
    </div>
  );
});

/**
 * The widget's height in the conversation, and the floor it keeps: while it builds, and until the
 * drawn widget is measured (`settled`), the block never shrinks, so the conversation below it holds
 * still; once measured it takes its own height, at once when that is as tall or taller, and when it
 * is smaller only once that height has stayed (`shrink`). `off`: stopped or empty (a note's height).
 */
export function frameContent(s: { off: boolean; settled: boolean; h: number | null; floor: number; reserve: number; shrink?: boolean }): { content: number; floor: number } {
  if (s.off) return { content: 52, floor: s.floor };
  if (s.settled && s.h !== null && (s.h >= s.floor || s.shrink)) return { content: s.h, floor: 0 };
  const content = Math.max(s.floor, s.h ?? s.reserve);
  return { content, floor: content };
}

/** Rows of dither light that grow in as the code arrives: a sense of progress without a number. */
function Skeleton({ title, len }: { title: string; len: number }) {
  const rows = Math.max(1, Math.min(5, Math.ceil(len / 900)));
  return (
    <div className="gw-skel" aria-hidden>
      <div className="gw-skel-title shimmer">{title || 'Building'}</div>
      <div className="gw-skel-rows">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="skel gw-skel-row" style={{ width: `${[78, 92, 64, 86, 52][i]}%` }} />
        ))}
      </div>
    </div>
  );
}
