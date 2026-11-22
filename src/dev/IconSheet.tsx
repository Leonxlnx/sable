import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ANIMATED_NAMES, ICON_NAMES, Icon, IconOriginal, playIcons, type IconName } from '@/icons';
import { SendGlyphSvg } from '@/features/composer/SendKey';
import { FileCovers } from './FileCovers';

/**
 * Every animated icon at 16, 20 and 24 px: the Phosphor original, the drawing at rest (a button:
 * point at it to play its motion, press it for the press beat), the pixel difference at rest
 * between drawing and original, and at 16 px its motion scrubbed across frames (paused Web
 * Animations) and its press beat across three. Above it the file cards, one of each cover; under
 * it the icons without a drawing, each with its small step.
 */
const SIZES = [16, 20, 24] as const;
const FRAMES = [60, 150, 260, 380, 520, 680, 820];
const PRESS = [50, 110, 190];
/** `?gallery&strip` is the director's sheet: nine frames of each motion and three of its press beat, at 3.5x. */
const STRIP = new URLSearchParams(location.search).has('strip');
const STRIP_FRAMES = [40, 110, 190, 280, 380, 490, 610, 730, 850];
/** `?gallery&live` is the light sheet: only each icon's rest copies, nothing held, so a motion plays at its real pace (for films). */
const LIVE = new URLSearchParams(location.search).has('live');
const WANT = new URLSearchParams(location.search).get('icons')?.split(',') ?? null;

function caption(icon: string, parts: ReactNode) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" data-icon={icon} aria-hidden>
      {parts}
    </svg>
  );
}

/** Glyphs drawn outside the icon set that answer a hover with motion from animated.css: the composer's add and send keys. */
const EXTRAS: { name: string; node: ReactNode }[] = [
  {
    name: 'add-key',
    node: (
      <svg className="cmp-plus" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <path d="M7 2.25v9.5M2.25 7h9.5" />
      </svg>
    ),
  },
  { name: 'send-key', node: <SendGlyphSvg glyph="send" /> },
  // The caption glyphs, as WindowControls.tsx draws them.
  { name: 'wc-min', node: caption('wc-min', <path d="M3.5 8.5h9" />) },
  { name: 'wc-max', node: caption('wc-max', <rect x="3.5" y="3.5" width="9" height="9" rx="1.75" />) },
  {
    name: 'wc-restore',
    node: caption(
      'wc-restore',
      <>
        <rect x="3.5" y="5.5" width="7" height="7" rx="1.5" />
        <path d="M5.5 5.5V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 12.5 5v4a1.5 1.5 0 0 1-1.5 1.5h-.5" />
      </>,
    ),
  },
  { name: 'wc-close', node: caption('wc-close', <path d="M4 4l8 8M12 4l-8 8" />) },
];

/** `?gallery&icons=a,b,c` shows only those icons; `?gallery&icons=26-` a slice by position (for shots). */
function pick(): IconName[] {
  const q = new URLSearchParams(location.search).get('icons');
  if (!q) return ANIMATED_NAMES;
  const range = /^(\d*)-(\d*)$/.exec(q);
  if (range) return ANIMATED_NAMES.slice(Number(range[1] || 0), range[2] ? Number(range[2]) : undefined);
  const want = q.split(',');
  // The light sheet takes any icon by name (one without a drawing shows its small step).
  return (LIVE ? ICON_NAMES : ANIMATED_NAMES).filter((n) => want.includes(n));
}

/** The icons that have no drawn version: each takes one small step in its direction and springs home. */
const OTHERS = ICON_NAMES.filter((n) => !ANIMATED_NAMES.includes(n));

/** A frame of a motion: the icon with its motion started and held at `t` (`kind`: the hover motion or the press beat). */
function Frame({ t, kind = 'h', big, children }: { t: number; kind?: 'h' | 'p'; big?: boolean; children: ReactNode }) {
  return (
    <span className={`isheet-cell${big ? ' isheet-big' : ''}`} data-scrub={kind} data-t={t}>
      {children}
    </span>
  );
}

export function IconSheet() {
  const root = useRef<HTMLDivElement>(null);
  const [names] = useState(pick);
  const [diffs, setDiffs] = useState<Record<string, string>>({});

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Scrub: each frame cell holds its own copy of the motion, started the way play.ts starts it and paused at its time.
    for (const cell of el.querySelectorAll<HTMLElement>('[data-scrub]')) {
      const t = Number(cell.dataset.t);
      const attr = cell.dataset.scrub === 'p' ? 'data-ap' : 'data-ai';
      for (const svg of cell.querySelectorAll('svg')) svg.setAttribute(attr, '');
      for (const a of cell.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = t;
      }
    }
    let live = true;
    void (async () => {
      const out: Record<string, string> = {};
      for (const name of names) {
        const parts: string[] = [];
        for (const s of SIZES) {
          const a = el.querySelector<SVGSVGElement>(`[data-cmp="${name}-${s}"] [data-icon-original]`);
          const b = el.querySelector<SVGSVGElement>(`[data-cmp="${name}-${s}"] [data-anim]`);
          if (!a || !b) continue;
          const [x, y] = await Promise.all([raster(a, s), raster(b, s)]);
          parts.push(compare(x, y));
        }
        out[name] = parts.join('  ');
      }
      if (live) setDiffs(out);
    })();
    return () => {
      live = false;
    };
  }, [names]);

  /** Plays every icon's rest copy at once (the buttons), as a hover or as a press. */
  const playAll = (kind: 'hover' | 'press') => {
    for (const b of root.current?.querySelectorAll('button.isheet-cell') ?? []) playIcons(b, kind);
  };
  const bar = (
    <div className="isheet-bar">
      <button type="button" className="btn btn-sm" onClick={() => playAll('hover')}>
        Play all
      </button>
      <button type="button" className="btn btn-sm" onClick={() => playAll('press')}>
        Press all
      </button>
      <span className="isheet-note">
        {names.length} drawn icons, {EXTRAS.length} glyphs and {OTHERS.length} icons without a drawing. Point at an icon's rest copy to play it, press it for its press beat.
      </span>
    </div>
  );

  if (LIVE) {
    return (
      <div className="isheet isheet-live" ref={root}>
        {bar}
        {[...names.map((name) => ({ name: name as string, node: null as ReactNode })), ...EXTRAS.filter((x) => !WANT || WANT.includes(x.name))].map((x) => (
          <div key={x.name} className="isheet-row" data-name={x.name}>
            <span className="isheet-name">{x.name}</span>
            <span className="isheet-size">
              {(x.node ? [16] : SIZES).map((s) => (
                <button key={s} type="button" className="isheet-cell" aria-label={`Play ${x.name}`}>
                  {x.node ?? <Icon name={x.name as IconName} size={s} />}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (STRIP) {
    return (
      <div className="isheet isheet-strip" ref={root}>
        {WANT?.includes('files') && <FileCovers />}
        {bar}
        {names.map((name) => (
          <div key={name} className="isheet-row" data-name={name}>
            <span className="isheet-name">
              {name}
              <span className="isheet-diff num">{diffs[name] ?? '…'}</span>
            </span>
            <span className="isheet-size">
              <span className="isheet-cell isheet-cmp" data-cmp={`${name}-16`}>
                <IconOriginal name={name} size={16} />
                <span className="isheet-over">
                  <Icon name={name} size={16} />
                </span>
              </span>
              <button type="button" className="isheet-cell" aria-label={`Play ${name}`}>
                <Icon name={name} size={16} />
              </button>
            </span>
            <span className="isheet-size">
              {STRIP_FRAMES.map((t) => (
                <Frame key={t} t={t} big>
                  <Icon name={name} size={56} />
                </Frame>
              ))}
              {PRESS.map((t) => (
                <Frame key={`p${t}`} t={t} kind="p" big>
                  <Icon name={name} size={56} />
                </Frame>
              ))}
            </span>
          </div>
        ))}
        {EXTRAS.filter((x) => !WANT || WANT.includes(x.name)).map((x) => (
          <div key={x.name} className="isheet-row" data-name={x.name}>
            <span className="isheet-name">{x.name}</span>
            <span className="isheet-size">
              <span className="isheet-cell" />
              <button type="button" className="isheet-cell" aria-label={`Play ${x.name}`}>
                {x.node}
              </button>
            </span>
            <span className="isheet-size">
              {STRIP_FRAMES.map((t) => (
                <Frame key={t} t={t} big>
                  <span style={{ zoom: 3.5, display: 'grid' }}>{x.node}</span>
                </Frame>
              ))}
              {PRESS.map((t) => (
                <Frame key={`p${t}`} t={t} kind="p" big>
                  <span style={{ zoom: 3.5, display: 'grid' }}>{x.node}</span>
                </Frame>
              ))}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="isheet" ref={root}>
      <FileCovers />
      {bar}
      <div className="isheet-row isheet-head">
        <span>Icon</span>
        {SIZES.map((s, i) => (
          <span key={s} className="isheet-size">
            {i === 0 ? `${s} px: original, rest, difference, ${FRAMES.length} frames to ${FRAMES[FRAMES.length - 1]} ms, the press beat` : `${s} px`}
          </span>
        ))}
      </div>
      {names.map((name) => (
        <div key={name} className="isheet-row" data-name={name}>
          <span className="isheet-name">
            {name}
            <span className="isheet-diff num">{diffs[name] ?? '…'}</span>
          </span>
          {SIZES.map((s) => (
            <span key={s} className="isheet-size">
              <span className="isheet-cell isheet-orig">
                <IconOriginal name={name} size={s} />
              </span>
              <button type="button" className="isheet-cell" aria-label={`Play ${name}`}>
                <Icon name={name} size={s} />
              </button>
              {/* Both stacked, the drawing in difference blend: what differs from the original lights up. */}
              <span className="isheet-cell isheet-cmp" data-cmp={`${name}-${s}`}>
                <IconOriginal name={name} size={s} />
                <span className="isheet-over">
                  <Icon name={name} size={s} />
                </span>
              </span>
              {/* The motion is the same at every size: its frames stand at the first one only (a held frame is not free). */}
              {s === SIZES[0] &&
                FRAMES.map((t) => (
                  <Frame key={t} t={t}>
                    <Icon name={name as IconName} size={s} />
                  </Frame>
                ))}
              {s === SIZES[0] &&
                PRESS.map((t) => (
                  <Frame key={`p${t}`} t={t} kind="p">
                    <Icon name={name as IconName} size={s} />
                  </Frame>
                ))}
            </span>
          ))}
        </div>
      ))}
      {EXTRAS.map((x) => (
        <div key={x.name} className="isheet-row" data-name={x.name}>
          <span className="isheet-name">{x.name}</span>
          <span className="isheet-size">
            <span className="isheet-cell isheet-orig" />
            <button type="button" className="isheet-cell" aria-label={`Play ${x.name}`}>
              {x.node}
            </button>
            <span className="isheet-cell" />
            {FRAMES.map((t) => (
              <Frame key={t} t={t}>
                {x.node}
              </Frame>
            ))}
          </span>
        </div>
      ))}
      {!WANT && (
        <div className="isheet-others">
          <span className="isheet-note">Without a drawn version ({OTHERS.length}): one small step in the icon's direction and back.</span>
          <div className="isheet-wrap">
            {OTHERS.map((name) => (
              <button key={name} type="button" className="isheet-cell" aria-label={`Play ${name}`} title={name}>
                <Icon name={name} size={16} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Draws an icon's markup into a canvas at its size (1x) and returns its alpha channel. */
async function raster(svg: SVGSVGElement, size: number): Promise<Uint8ClampedArray> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(size));
  copy.setAttribute('height', String(size));
  copy.setAttribute('style', 'color:#000');
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  const alpha = new Uint8ClampedArray(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return alpha;
}

/** Mean alpha difference in percent and the largest single-pixel difference. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): string {
  let sum = 0;
  let max = 0;
  let ink = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    ink += a[i];
    if (d > max) max = d;
  }
  return `${((sum / Math.max(1, ink)) * 100).toFixed(1)}%/${Math.round((max / 255) * 100)}`;
}
