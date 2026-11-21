import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { veil } from '@/art/veil';
import { Icon, type IconName } from '@/icons';
import { clamp } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { useStore, type RailTab } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/ui';
import { AgentsTab, useLiveAgentCount } from './AgentsTab';
import { BrowserTab } from './BrowserTab';
import { ChangesTab, useChangeCount } from './ChangesTab';
import { ContextTab } from './ContextTab';
import { DeviceTab } from './DeviceTab';
import { FilesTab } from './FilesTab';
import { useGitAutoRefresh } from './git-state';
import { TasksTab, useOpenTaskCount } from './TasksTab';
import { RAIL_TABS, railTabKeys } from './tabs';
import { runCommand } from './term-store';
import { TerminalTab } from './TerminalTab';
import './rail.css';

const WIDTH_KEY = 'sable.rail.w';
const DEFAULT_W = 396;
const MIN_W = 320;
const MAX_W = 720;

function readWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_W ? clamp(v, MIN_W, MAX_W) : null;
  } catch {
    return null;
  }
}

function applyWidth(w: number | null) {
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return;
  if (w === null) app.style.removeProperty('--rail-w');
  else app.style.setProperty('--rail-w', `${Math.round(w)}px`);
}

/**
 * The side panel: working-tree changes, files, a browser, a command runner, tasks, context, sub-agents
 * and a device for one session. `open` is false while the panel is closed but kept (App.tsx): every
 * pane is told it is hidden, and the working tree is not read until it opens again.
 */
export function Rail({ sessionId, open = true }: { sessionId: string; open?: boolean }) {
  return <RailInner key={sessionId} sessionId={sessionId} open={open} />;
}

/** The session whose panel was last on screen, and when it left: tells a change of session from the panel opening. */
const lastPanel = { sessionId: '', leftAt: -1e9 };

function RailInner({ sessionId, open }: { sessionId: string; open: boolean }) {
  const tab = useStore((s) => s.ui.railTab);
  const body = useRef<HTMLDivElement>(null);
  // Another session's panel took this one's place in the same frame: its contents resolve out of
  // the ground, in step with the conversation beside it (the panel's frame and tabs stay put).
  useLayoutEffect(() => {
    if (lastPanel.sessionId && lastPanel.sessionId !== sessionId && performance.now() - lastPanel.leftAt < 80 && !reducedMotion()) {
      void veil(body.current, 'reveal', { duration: 300 });
    }
    return () => {
      lastPanel.sessionId = sessionId;
      lastPanel.leftAt = performance.now();
    };
  }, [sessionId]);
  // Closing by the key while the pointer rests on a tab: its tooltip stood over the dissolving panel
  // until the panel had gone (the pointer never leaves a control that is taken away). It is told
  // the pointer left, as the control's own trigger would be.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) return;
    for (const el of root.current?.querySelectorAll('[aria-describedby]') ?? []) el.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
  }, [open]);
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const setUi = useStore((s) => s.setUi);
  const [visited, setVisited] = useState<ReadonlySet<RailTab>>(() => new Set([tab]));

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set([...v, tab])));
  }, [tab]);

  useGitAutoRefresh(sessionId, open ? cwd : '');
  usePendingCommand(sessionId, cwd);

  // Another part of the app asked to show a file: bring the Files tab forward.
  const railFile = useStore((s) => s.ui.railFile);
  const lastFile = useRef(railFile);
  useEffect(() => {
    if (railFile && railFile !== lastFile.current && useStore.getState().ui.railTab !== 'files') setUi({ railTab: 'files' });
    lastFile.current = railFile;
  }, [railFile, setUi]);

  const at = RAIL_TABS.findIndex((t) => t.id === tab);
  // Which way the selection last travelled along the tab row: the arriving pane comes from that side.
  const [nav, setNav] = useState({ at, dir: 'fwd' });
  if (nav.at !== at) setNav({ at, dir: at < nav.at ? 'back' : 'fwd' });

  return (
    <div className="rail" data-spot="" ref={root}>
      <ResizeHandle />
      <header className="rail-head">
        <RailTabs sessionId={sessionId} cwd={cwd} tab={tab} onPick={(t) => setUi({ railTab: t })} />
        {/* Where the top bar's toggle stands while the panel is closed: one place opens and closes
            it, and nothing that closes sits beside the window's own controls. */}
        <IconButton icon="sidebar" label="Hide panel" keys="mod+j" active className="flip-x rail-hide" onClick={() => setUi({ railOpen: false })} />
      </header>
      <div className="rail-body" ref={body} data-dir={nav.dir}>
        {RAIL_TABS.map((t, i) =>
          visited.has(t.id) ? (
            <section key={t.id} className="rail-pane" data-active={t.id === tab || undefined} data-side={i < at ? 'before' : undefined} inert={t.id !== tab} aria-label={t.label} role="tabpanel" id={`rail-pane-${t.id}`}>
              <Pane id={t.id} sessionId={sessionId} cwd={cwd} active={open && WATCHES_ACTIVE.has(t.id) && t.id === tab} />
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** Panes that pause their own work while hidden: they are told whether they show. */
const WATCHES_ACTIVE: ReadonlySet<RailTab> = new Set(['browser', 'device', 'terminal', 'context', 'agents']);

/**
 * One pane's contents. Memoised: a change of tab re-renders only the panes that are told it (the
 * one leaving and the one arriving, when they watch it), never the settled others.
 */
const Pane = memo(function Pane({ id, sessionId, cwd, active }: { id: RailTab; sessionId: string; cwd: string; active: boolean }) {
  switch (id) {
    case 'changes':
      return <ChangesTab sessionId={sessionId} cwd={cwd} />;
    case 'files':
      return <FilesTab sessionId={sessionId} cwd={cwd} />;
    case 'browser':
      return <BrowserTab sessionId={sessionId} active={active} />;
    case 'device':
      return <DeviceTab active={active} />;
    case 'terminal':
      return <TerminalTab sessionId={sessionId} cwd={cwd} active={active} />;
    case 'tasks':
      return <TasksTab sessionId={sessionId} />;
    case 'context':
      return <ContextTab sessionId={sessionId} active={active} />;
    case 'agents':
      return <AgentsTab sessionId={sessionId} active={active} />;
  }
});

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** A label's width in the tab's own font, without touching layout. */
function textWidth(text: string, el: HTMLElement | null): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || !el) return text.length * 7.5;
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

/**
 * Fixed parts of the row: tabs at 28 px, 2 px apart; a name adds its text and 9 px; a count (two
 * figures) about 20 px; the More button's caret, when it stands for a tab, 14 px.
 */
const TAB = 28;
const TAB_GAP = 2;
const COUNT_ROOM = 20;
const CARET = 14;

/** The selected tab's name opens and closes with the same spring as the panel itself. */
const LABEL_SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const;

const PRIMARY = RAIL_TABS.filter((t) => !t.more);

/**
 * How the row is laid out for its width: how many of the first four fit beside More (room for a
 * count kept), and whether the selected tab shows its name (only when the row fits the longest name,
 * so the decision never flips while counts load or from one tab to the next). Observed, and only a
 * change of decision renders: dragging the panel's edge does not re-render the row on every move.
 */
function useRowLayout(ref: React.RefObject<HTMLElement | null>): { fit: number; labels: boolean } {
  const [key, setKey] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const font = el.querySelector<HTMLElement>('.rail-tab');
    const longest = Math.ceil(Math.max(...RAIL_TABS.map((t) => textWidth(t.label, font))));
    const decide = (w: number) => {
      const fit = clamp(Math.floor((w - TAB - CARET - COUNT_ROOM) / (TAB + TAB_GAP)), 1, PRIMARY.length);
      const labels = w >= fit * (TAB + TAB_GAP) + TAB + CARET + COUNT_ROOM + longest + 9;
      setKey(`${fit}|${labels ? 1 : 0}`);
    };
    decide(el.clientWidth);
    const ro = new ResizeObserver(([e]) => decide(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  if (!key) return { fit: PRIMARY.length, labels: false };
  return { fit: Number(key[0]), labels: key.endsWith('1') };
}

/**
 * The header: the most used tabs as quiet icons (the selected one on a dithered pill, with its name
 * when there is room), then More for the others. A tab chosen from More stands in for the menu's
 * button while it is selected, so the selection always shows in the row.
 */
function RailTabs({ sessionId, cwd, tab, onPick }: { sessionId: string; cwd: string; tab: RailTab; onPick: (t: RailTab) => void }) {
  const changes = useChangeCount(sessionId, cwd);
  const tasks = useOpenTaskCount(sessionId);
  // Agents: how many are working now.
  const agents = useLiveAgentCount(sessionId);
  const counts: Partial<Record<RailTab, number>> = { changes, tasks, agents };
  const row = useRef<HTMLDivElement>(null);
  const { fit, labels } = useRowLayout(row);
  const shown = PRIMARY.slice(0, fit);
  const inRow = shown.some((t) => t.id === tab);
  const rest = RAIL_TABS.filter((t) => !shown.includes(t));
  const current = RAIL_TABS.find((t) => t.id === tab) ?? RAIL_TABS[0];

  // One pill for the row: it glides to the selected tab on the same spring that opens the tab's name.
  // Where it lands is worked out from the row as it will be (each tab without a name, plus the
  // selected one's full name), so it does not wait for the names to finish opening and closing.
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    let x = 0;
    let next: { x: number; w: number } | null = null;
    for (const btn of el.querySelectorAll<HTMLElement>('.rail-tab')) {
      const label = btn.querySelector<HTMLElement>('.rail-tab-label');
      const on = btn.dataset.on != null;
      const base = (btn.getBoundingClientRect().width - (label ? label.getBoundingClientRect().width : 0)) / z;
      const name = on && label?.firstElementChild ? label.firstElementChild.getBoundingClientRect().width / z : 0;
      if (on) next = { x, w: base + name };
      x += base + name + TAB_GAP;
    }
    const to = next as { x: number; w: number } | null;
    setPill((was) => (was && to && Math.abs(was.x - to.x) < 0.05 && Math.abs(was.w - to.w) < 0.05 ? was : to));
  }, [tab, labels, fit, changes, tasks, agents]);

  // Arrows walk every tab in shortcut order; focus follows to the tab, or to More when it stands for it.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = RAIL_TABS.findIndex((t) => t.id === tab);
    const n = RAIL_TABS.length;
    const next = RAIL_TABS[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n].id;
    onPick(next);
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
  };

  return (
    <div className="rail-tabs" ref={row} onKeyDown={onKey}>
      {pill && (
        <motion.span
          className="rail-tabs-pill dither-sel"
          aria-hidden
          initial={false}
          animate={{ x: pill.x, width: pill.w }}
          transition={reducedMotion() ? { duration: 0 } : LABEL_SPRING}
        />
      )}
      <div className="rail-tablist" role="tablist" aria-label="Panel">
        {shown.map((t) => {
          const active = t.id === tab;
          const count = counts[t.id];
          return (
            <Tip key={t.id} label={t.label} keys={railTabKeys(t.id)}>
              <button
                type="button"
                role="tab"
                data-tab={t.id}
                aria-selected={active}
                aria-controls={`rail-pane-${t.id}`}
                aria-label={count ? `${t.label}, ${count}` : t.label}
                tabIndex={active || (!inRow && t === shown[0]) ? 0 : -1}
                className="rail-tab"
                data-on={active || undefined}
                onClick={() => onPick(t.id)}
              >
                <TabFace icon={t.icon} label={t.label} named={active && labels} count={count} />
              </button>
            </Tip>
          );
        })}
      </div>
      <Menu>
        <Tip label={inRow ? 'More' : current.label} keys={inRow ? undefined : railTabKeys(current.id)}>
          <MenuTrigger
            className="rail-tab rail-more"
            data-tab={inRow ? 'more' : current.id}
            data-on={!inRow || undefined}
            aria-label={inRow ? 'More tabs' : `${current.label}, more tabs`}
          >
            {inRow ? (
              <Icon name="dots" size={16} />
            ) : (
              <>
                <TabFace icon={current.icon} label={current.label} named={labels} count={counts[current.id]} />
                <Icon name="caret-down" size={10} className="rail-more-caret" />
              </>
            )}
          </MenuTrigger>
        </Tip>
        <MenuContent align="start" width={208}>
          {rest.map((t) => (
            <MenuItem
              key={t.id}
              icon={t.icon}
              keys={railTabKeys(t.id)}
              checked={t.id === tab}
              hint={counts[t.id] ? <span className="num">{counts[t.id]}</span> : undefined}
              onSelect={() => onPick(t.id)}
            >
              {t.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** A tab's icon, its name while selected (when the row has room) and its count. */
function TabFace({ icon, label, named, count }: { icon: IconName; label: string; named: boolean; count?: number }) {
  return (
    <>
      <Icon name={icon} size={16} />
      <AnimatePresence initial={false}>
        {named && (
          <motion.span
            key="label"
            className="rail-tab-label"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={LABEL_SPRING}
          >
            <span>{label}</span>
          </motion.span>
        )}
      </AnimatePresence>
      {!!count && <span className="rail-tab-count num">{count > 999 ? '999+' : count}</span>}
    </>
  );
}

/** Drag the panel's left edge to resize it (320 to 720 px); double-click restores the default. */
function ResizeHandle() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    applyWidth(readWidth());
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rail = el.closest('.app-rail') as HTMLElement | null;
    // Pointer and box positions are screen pixels; widths are CSS pixels under the Interface size zoom.
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    const startW = rail ? rail.getBoundingClientRect().width / z : DEFAULT_W;
    const startX = e.clientX;
    const max = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth / z - 600));
    let w = startW;
    setDragging(true);
    document.documentElement.dataset.railResizing = '';
    // While dragging, the two boxes that use the width get it inline: --rail-w lives on .app and is
    // inherited, so changing it every move would restyle the whole window (thousands of elements).
    // It is written once, on release.
    const inner = rail?.querySelector<HTMLElement>(':scope > .app-rail-inner') ?? null;
    const railWas = rail?.style.width ?? '';
    const move = (ev: PointerEvent) => {
      w = clamp(startW + (startX - ev.clientX) / z, MIN_W, max);
      const px = `${Math.round(w)}px`;
      if (rail) rail.style.width = px;
      if (inner) inner.style.width = px;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      applyWidth(w);
      if (rail) rail.style.width = railWas;
      inner?.style.removeProperty('width');
      delete document.documentElement.dataset.railResizing;
      setDragging(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        /* private mode */
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = readWidth() ?? DEFAULT_W;
    const w = clamp(cur + (e.key === 'ArrowLeft' ? 24 : -24), MIN_W, MAX_W);
    applyWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* private mode */
    }
  };

  const reset = () => {
    applyWidth(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* private mode */
    }
  };

  return (
    <div
      className="rail-resize"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKey}
    />
  );
}

/** Runs a command the composer handed over ("!cmd"), once, in this session's folder. */
const consumed = new Set<number>();

function usePendingCommand(sessionId: string, cwd: string) {
  const pending = useStore((s) => s.ui.pendingCommand);
  useEffect(() => {
    if (!pending || pending.sessionId !== sessionId || !cwd) return;
    const st = useStore.getState();
    st.setUi({ pendingCommand: null, ...(st.ui.railTab !== 'terminal' ? { railTab: 'terminal' as const } : {}) });
    if (consumed.has(pending.id)) return;
    consumed.add(pending.id);
    runCommand(sessionId, cwd, pending.command);
  }, [pending, sessionId, cwd]);
}
