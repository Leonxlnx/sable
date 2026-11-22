import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { veil } from '@/art/veil';
import { Icon, type IconName } from '@/icons';
import { clamp } from '@/lib/format';
import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';
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
import { KEEP, figure, fitRow, guestFigure, rowSeats, sameFit, type RowFit } from './tab-row';
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

/** What the row's own type measures: the longest name's box, a figure's box and each digit after the first. */
interface RowType {
  longest: number;
  count: number;
  digit: number;
}

/**
 * Measured in the row itself with its own classes (the real font, weight and paddings), on an
 * element nobody sees: once when the row mounts and again when the fonts have loaded.
 */
function measureType(row: HTMLElement): RowType {
  const probe = document.createElement('span');
  probe.className = 'rail-tab rail-tab-probe';
  probe.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'rail-tab-name';
  const count = document.createElement('span');
  count.className = 'rail-tab-count num';
  probe.append(name, count);
  row.append(probe);
  const z = uiZoom();
  let longest = 0;
  for (const t of RAIL_TABS) {
    name.textContent = t.label;
    longest = Math.max(longest, name.getBoundingClientRect().width / z);
  }
  count.textContent = '0';
  const one = count.getBoundingClientRect().width / z;
  count.textContent = '00';
  const two = count.getBoundingClientRect().width / z;
  probe.remove();
  return { longest: Math.ceil(longest), count: Math.ceil(one), digit: Math.ceil(two - one) };
}

/** The fit, and whether a tab lent the last seat may show its figure there. */
type Fit = RowFit & { guest: boolean };

/** Before the row is measured: the first tabs, nothing that could be cut. */
const UNMEASURED: Fit = { shown: KEEP, names: false, counts: false, guest: false };

/** The figures a tab usually shows, in digits: their room is kept, so a count that loads moves no tab. */
const USUAL: Partial<Record<RailTab, number>> = { changes: 2, agents: 1, tasks: 1 };

/**
 * The row's layout for its width (`tab-row.ts`): how many tabs stand in it, whether the selected one
 * carries its name, whether figures show. Worked out while rendering from what was last measured, so
 * a change of selection or of a count is laid out in its own commit; the row is observed, and a
 * resize renders only when the decision changes (dragging the panel's edge does not render the row
 * on every move). `figures`: each tab's count as it would show, '' for none. The selection moves
 * nothing but the last seat's tenant.
 */
function useRowFit(ref: React.RefObject<HTMLElement | null>, figures: readonly string[], selected: number): Fit {
  const seen = useRef<{ width: number; type: RowType } | null>(null);
  const [, render] = useReducer((n: number) => n + 1, 0);
  const args = useRef({ figures, selected });
  args.current = { figures, selected };
  const read = (): Fit => {
    const m = seen.current;
    if (!m) return UNMEASURED;
    const a = args.current;
    const room = (digits: number) => (digits ? m.type.count + (digits - 1) * m.type.digit : 0);
    const need = RAIL_TABS.map((_, i) => room(a.figures[i]?.length ?? 0));
    const counts = RAIL_TABS.map((t, i) => Math.max(room(USUAL[t.id] ?? 0), need[i]));
    const fit = fitRow({ width: m.width, longest: m.type.longest, counts });
    return { ...fit, guest: guestFigure(counts, need, fit.shown, a.selected) };
  };
  const fit = read();
  const drawn = useRef(fit);
  drawn.current = fit;
  const check = useRef(() => {});
  check.current = () => {
    const now = read();
    if (!sameFit(now, drawn.current) || now.guest !== drawn.current.guest) render();
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    seen.current = { width: el.clientWidth, type: measureType(el) };
    check.current();
    const ro = new ResizeObserver(([e]) => {
      if (!seen.current) return;
      seen.current.width = e.contentRect.width;
      check.current();
    });
    ro.observe(el);
    // The names were measured in a fallback font when the interface font had not loaded yet.
    void document.fonts?.ready.then(() => {
      if (!live || !seen.current) return;
      seen.current.type = measureType(el);
      check.current();
    });
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [ref]);
  return fit;
}

/** A change of selection travels on the spring the panel's own controls use. */
const GLIDE = spring(520, 40);

/**
 * The motion of a change of selection, by transform and opacity only. The layout takes the new
 * widths at once (the old tab lets go of its name, the new one has it). Each tab that stands
 * elsewhere now glides there from where it stood; the pill, which lies inside the selected tab and
 * so is exactly on it at every width, travels from the old tab's box into the new one (its skin is
 * two doors, `rail.css`: the far end slides, nothing is scaled); a figure that stands after a name
 * that came or went glides to its new place in its tab; the new name comes in behind the pill's
 * edge. Nothing else animates: a row that changes because the panel was resized (a name shed, a
 * tab gone to More) simply is as it must be, in that frame.
 *
 * `layout`: everything but the selection that the boxes follow.
 */
function useRowMotion(ref: React.RefObject<HTMLElement | null>, tab: RailTab, layout: string) {
  const last = useRef<{ tab: RailTab; boxes: Map<string, { l: number; w: number; c: number }> } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout boxes, not rects: a pressed tab is scaled for a moment and a gliding one is moved.
    const seats = [...el.querySelectorAll<HTMLElement>('[data-tab]')];
    // `c`: where its figure stands in it, -1 without one.
    const read = () => new Map(seats.map((b) => [b.dataset.tab ?? '', { l: b.offsetLeft, w: b.offsetWidth, c: b.querySelector<HTMLElement>('.rail-tab-count')?.offsetLeft ?? -1 }]));
    // Only a figure or the fit changed (a sub-agent finished: the count moves many times a second in
    // a big chat): nothing glides, so the boxes are read at the next frame, when the layout is done
    // anyway. Read here they forced a layout of the whole window inside every such commit (perf1:
    // about a third of the main thread with 137 sub-agents and the Agents tab open).
    if (last.current && last.current.tab === tab) {
      const raf = requestAnimationFrame(() => last.current?.tab === tab && (last.current = { tab, boxes: read() }));
      return () => cancelAnimationFrame(raf);
    }
    const boxes = read();
    const was = last.current;
    last.current = { tab, boxes };
    if (!was || was.tab === tab || reducedMotion()) return;
    const opts = { duration: GLIDE.duration, easing: GLIDE.easing };
    let host: HTMLElement | undefined;
    let hostDx = 0;
    for (const b of seats) {
      const id = b.dataset.tab ?? '';
      const from = was.boxes.get(id);
      const to = boxes.get(id);
      if (id === tab) host = b;
      if (!from || !to) continue;
      if (from.c >= 0 && to.c >= 0 && Math.abs(from.c - to.c) >= 0.5) play(b.querySelector('.rail-tab-count'), [{ transform: `translateX(${from.c - to.c}px)` }, { transform: 'translateX(0)' }], opts);
      const dx = from.l - to.l;
      if (Math.abs(dx) < 0.5) continue;
      if (id === tab) hostDx = dx;
      play(b, [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], opts);
    }
    const from = was.boxes.get(was.tab);
    const to = boxes.get(tab);
    const pill = host?.querySelector<HTMLElement>('.rail-tab-pill');
    // A tab that took the last seat in this commit (chosen from More) has no old place: the pill still comes from the old tab's.
    if (!host || !pill || !from || !to) return;
    // The pill rides its own tab's glide: its start is taken from where that tab starts.
    play(pill, [{ transform: `translateX(${from.l - to.l - hostDx}px)` }, { transform: 'translateX(0)' }], opts);
    play(pill.querySelector('.rail-tab-pill-far > i'), [{ transform: `translateX(${from.w - to.w}px)` }, { transform: 'translateX(0)' }], opts);
    // The name waits until the pill's far edge is nearly home (half the spring's time is most of its way): no word outside its pill.
    play(host.querySelector('.rail-tab-name'), [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: GLIDE.duration, easing: 'linear' });
  }, [ref, tab, layout]);
}

/**
 * The header: the tabs as quiet icons, as many as the row holds, the selected one on a dithered
 * pill (with its name when there is room for any tab's), then More, three dots, for those that do
 * not fit. A tab chosen from More takes the row's last seat while it is selected, so the selection
 * always shows in the row and More stays what it is.
 */
function RailTabs({ sessionId, cwd, tab, onPick }: { sessionId: string; cwd: string; tab: RailTab; onPick: (t: RailTab) => void }) {
  const changes = useChangeCount(sessionId, cwd);
  const tasks = useOpenTaskCount(sessionId);
  // Agents: how many are working now.
  const agents = useLiveAgentCount(sessionId);
  const counts: Partial<Record<RailTab, number>> = { changes, tasks, agents };
  const row = useRef<HTMLDivElement>(null);
  const at = Math.max(
    0,
    RAIL_TABS.findIndex((t) => t.id === tab),
  );
  const fit = useRowFit(
    row,
    RAIL_TABS.map((t) => figure(counts[t.id])),
    at,
  );
  const seats = rowSeats(RAIL_TABS.length, fit.shown, at);
  const shown = seats.map((i) => RAIL_TABS[i]);
  const rest = RAIL_TABS.filter((_, i) => !seats.includes(i));
  // A tab lent the last seat shows its figure only where it fits the room kept for that seat.
  const lent = seats.length ? RAIL_TABS[seats[seats.length - 1]].id : undefined;
  const shows = (id: RailTab) => fit.counts && (fit.guest || id !== lent || seats[seats.length - 1] === seats.length - 1);
  useRowMotion(row, tab, `${fit.shown}|${fit.names ? 1 : 0}|${fit.counts ? 1 : 0}|${fit.guest ? 1 : 0}|${changes}|${tasks}|${agents}`);

  // Arrows walk every tab in the row's order; focus follows the selection (a tab from More takes the last seat).
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = RAIL_TABS.length;
    const next = RAIL_TABS[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + n) % n].id;
    onPick(next);
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
  };

  // What More holds, said by its tooltip and to a screen reader: nobody has to open it to find out.
  const hidden = rest.map((t) => t.label).join(', ');

  return (
    <div className="rail-tabs" ref={row} onKeyDown={onKey}>
      <div className="rail-tablist" role="tablist" aria-label="Panel">
        {shown.map((t) => {
          const active = t.id === tab;
          const n = counts[t.id];
          return (
            <Tip key={t.id} label={t.label} keys={railTabKeys(t.id)}>
              <button
                type="button"
                role="tab"
                data-tab={t.id}
                aria-selected={active}
                aria-controls={`rail-pane-${t.id}`}
                aria-label={n ? `${t.label}, ${n}` : t.label}
                tabIndex={active ? 0 : -1}
                className="rail-tab"
                data-on={active || undefined}
                onClick={() => onPick(t.id)}
              >
                <TabFace icon={t.icon} label={t.label} on={active} named={active && fit.names} count={shows(t.id) ? n : undefined} />
              </button>
            </Tip>
          );
        })}
      </div>
      {rest.length > 0 && (
        <Menu>
          <Tip label={hidden}>
            <MenuTrigger className="rail-tab rail-more" data-tab="more" aria-label={`More tabs: ${hidden}`}>
              <Icon name="dots" size={16} />
            </MenuTrigger>
          </Tip>
          <MenuContent align="start" width={208}>
            {rest.map((t) => (
              <MenuItem key={t.id} icon={t.icon} keys={railTabKeys(t.id)} hint={counts[t.id] ? <span className="num">{figure(counts[t.id])}</span> : undefined} onSelect={() => onPick(t.id)}>
                {t.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

/**
 * A tab's face: the pill under it while it is selected (inside the tab, so it has the tab's box at
 * every width), its icon, its name when the row has room for names, and its figure.
 */
function TabFace({ icon, label, on, named, count }: { icon: IconName; label: string; on: boolean; named: boolean; count?: number }) {
  return (
    <>
      {on && (
        <span className="rail-tab-pill" aria-hidden>
          <i className="rail-tab-pill-near">
            <i />
          </i>
          <i className="rail-tab-pill-far">
            <i />
          </i>
        </span>
      )}
      <Icon name={icon} size={16} />
      {named && <span className="rail-tab-name">{label}</span>}
      {!!count && <span className="rail-tab-count num">{figure(count)}</span>}
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
