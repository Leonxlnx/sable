import { cloneElement, forwardRef, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as RD, DropdownMenu as RM, Popover as RP, Slider as RSl, Switch as RS, Tooltip as RT } from 'radix-ui';
import { Icon, type IconName } from '@/icons';
import { isMac, shortcutKeys } from '@/lib/format';
import { fadeShown, play, reducedMotion, slideLeft, spring, uiZoom } from '@/lib/motion';
import { useStore } from '@/state/store';
import './grow';
import { movedByKeys } from './glide';
import { quietFocus } from '@/lib/quiet-focus';
import { fitDir, watchDir } from './path-fit';
import { holdX, nearestStop, shouldGlide, settleAt, settleMs, stopKey, stopX, wordLeft } from './stops';

/** React wrappers around the primitives in styles/ui.css. Keep this file small and boring. */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ── keyboard hints ──

export function Kbd({ combo, className }: { combo: string; className?: string }) {
  return (
    <span className={cx('kbds', className)} data-mac={isMac || undefined}>
      {shortcutKeys(combo).map((k, i) => (
        <kbd className="kbd" key={i}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

// ── tooltip ──

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    // Not hoverable: a tip closes as the pointer leaves its control, so it never holds the hover
    // of a neighbour it happens to lie over (the sidebar's tools, the composer's field).
    <RT.Provider delayDuration={380} skipDelayDuration={250} disableHoverableContent>
      {children}
    </RT.Provider>
  );
}

/**
 * Whether the focus that is happening now came from keyboard navigation. Focus that a closing
 * menu, popover or dialog hands back to its trigger (after Escape, Enter or a click) is not:
 * a tooltip must not pop up for it. Only Tab and arrow-key moves within the last second count.
 */
let navKeyAt = 0;
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (navKeyAt = NAV_KEYS.has(e.key) ? performance.now() : 0), true);
  window.addEventListener('pointerdown', () => (navKeyAt = 0), true);
}
export const focusFromKeyboard = () => navKeyAt > 0 && performance.now() - navKeyAt < 1000;

type TipSide = 'top' | 'bottom' | 'left' | 'right';
type Woken = { el: HTMLElement; by: 'pointer' | 'focus' };
interface TipHooks {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
}

/**
 * A tooltip on its one child (a control that spreads its props on an element, as a Radix trigger
 * needs). It costs nothing until it is needed: a view holds dozens of these, and a Radix tooltip
 * built for each up front (root, trigger, popper, portal) was most of their weight in every render.
 * The control renders as it is, never wrapped; the first time the pointer or the keyboard focus
 * reaches it, the tooltip mounts beside it and takes the control itself as its trigger (`TipAnchor`),
 * so the control is never remounted and the tooltip behaves exactly as Radix's own.
 */
export function Tip({
  label,
  keys,
  side = 'bottom',
  offset = 7,
  children,
}: {
  label: ReactNode;
  keys?: string;
  side?: TipSide;
  /** How far from the control the tip stands (a control in a corner of a pane keeps its tip off the pane's rim). */
  offset?: number;
  children: ReactNode;
}) {
  const [woken, setWoken] = useState<Woken | null>(null);
  if (!isValidElement<TipHooks>(children)) return <>{children}</>;
  const own = children.props;
  const control = cloneElement(children, {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(e);
      if (e.pointerType !== 'touch' && woken?.el !== e.currentTarget) setWoken({ el: e.currentTarget, by: 'pointer' });
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      own.onFocus?.(e);
      if (focusFromKeyboard() && woken?.el !== e.currentTarget) setWoken({ el: e.currentTarget, by: 'focus' });
    },
  });
  return (
    <>
      {control}
      {woken && (
        <RT.Root>
          <RT.Trigger asChild>
            <TipAnchor el={woken.el} by={woken.by} />
          </RT.Trigger>
          <RT.Portal>
            <RT.Content className="tooltip" side={side} sideOffset={offset} collisionPadding={8}>
              {label}
              {keys && <Kbd combo={keys} />}
            </RT.Content>
          </RT.Portal>
        </RT.Root>
      )}
    </>
  );
}

type Handler = (e: Event) => void;
/** What Radix's trigger hands its child: a ref, the handlers that open and close the tip, the link to it. */
interface AnchorProps {
  el: HTMLElement;
  by: Woken['by'];
  ref?: Ref<HTMLElement>;
  'aria-describedby'?: string;
  onPointerMove?: Handler;
  onPointerLeave?: Handler;
  onPointerDown?: Handler;
  onFocus?: Handler;
  onBlur?: Handler;
  onClick?: Handler;
}

/** The DOM events that drive Radix's trigger, and the handler each one goes to (React's onFocus and onBlur are focusin and focusout). */
const ANCHOR_EVENTS: [string, keyof AnchorProps][] = [
  ['pointermove', 'onPointerMove'],
  ['pointerleave', 'onPointerLeave'],
  ['pointerdown', 'onPointerDown'],
  ['focusin', 'onFocus'],
  ['focusout', 'onBlur'],
  ['click', 'onClick'],
];

function setRef(ref: Ref<HTMLElement> | undefined, el: HTMLElement | null): (() => void) | void {
  if (typeof ref === 'function') return ref(el) as (() => void) | void;
  if (ref) (ref as { current: HTMLElement | null }).current = el;
}

/**
 * Radix's tooltip trigger, played by a control that already exists: renders nothing, hands the
 * element to Radix (it positions on it and tracks it), and listens on it for what the trigger would.
 * Woken by the pointer, the move that brought it there has already passed: it counts as the first.
 * Woken by keyboard focus, the tip opens at once, as Radix's does.
 */
function TipAnchor(props: AnchorProps) {
  const { el, by } = props;
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    // The ref is composed afresh on each render of Radix's slot; the refs inside it are stable, so it is given the element once.
    const undo = setRef(latest.current.ref, el);
    const offs = ANCHOR_EVENTS.map(([type, name]) => {
      const fn = (e: Event) => {
        // Focus that came from a click (or a menu handing it back) does not open a tip.
        if (type === 'focusin' && !focusFromKeyboard()) return;
        (latest.current[name] as Handler | undefined)?.(e);
      };
      el.addEventListener(type, fn);
      return () => el.removeEventListener(type, fn);
    });
    // A frame on, once Radix's own effects have mounted (its timers are cleared when they remount).
    // Not when a click in that frame already opened the control's menu: the tip would lie over it.
    const wake = requestAnimationFrame(() => {
      if (el.getAttribute('aria-expanded') === 'true' || el.dataset.state === 'open') return;
      if (by === 'pointer' && el.matches(':hover')) latest.current.onPointerMove?.(new window.PointerEvent('pointermove', { pointerType: 'mouse' }));
      else if (by === 'focus' && el.contains(document.activeElement)) latest.current.onFocus?.(new window.FocusEvent('focusin'));
    });
    return () => {
      cancelAnimationFrame(wake);
      offs.forEach((off) => off());
      if (typeof undo === 'function') undo();
      else setRef(latest.current.ref, null);
    };
  }, [el, by]);
  const described = props['aria-describedby'];
  useLayoutEffect(() => {
    if (!described) return;
    el.setAttribute('aria-describedby', described);
    return () => el.removeAttribute('aria-describedby');
  }, [el, described]);
  return null;
}

// ── buttons ──

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  keys?: string;
  size?: number;
  active?: boolean;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Why the button cannot be used right now, when that is not obvious. The button stays focusable
   * and hoverable (aria-disabled, clicks ignored) so its tooltip can say so.
   */
  disabledReason?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, keys, size = 16, active, tipSide, className, disabled, disabledReason, onClick, ...rest },
  ref,
) {
  const explain = !!disabled && !!disabledReason;
  return (
    <Tip label={explain ? disabledReason : label} keys={explain ? undefined : keys} side={tipSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-active={active || undefined}
        className={cx('icon-btn', className)}
        disabled={disabled && !explain}
        aria-disabled={explain || undefined}
        onClick={explain ? (e) => e.preventDefault() : onClick}
        {...rest}
      >
        <Icon name={icon} size={size} />
      </button>
    </Tip>
  );
});

/**
 * Text that ends in an ellipsis when it does not fit, with the whole of it as a tooltip only when
 * it was actually cut. The check runs when the pointer arrives, so nothing measures at rest.
 */
export function Truncate({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx('truncate', className)} onPointerEnter={titleIfCut} data-title={title}>
      {children}
    </span>
  );
}

/** Pointer-enter handler: sets `title` to the full text when the element is cut off, clears it otherwise. */
export function titleIfCut(e: { currentTarget: HTMLElement }) {
  const el = e.currentTarget;
  const cut = el.scrollWidth > el.clientWidth + 1 || [...el.children].some((c) => c instanceof HTMLElement && c.scrollWidth > c.clientWidth + 1);
  const full = el.dataset.title || el.textContent || '';
  if (cut) el.title = full;
  else el.removeAttribute('title');
}

// ── menus ──

export const Menu = RM.Root;
export const MenuTrigger = RM.Trigger;

export function MenuContent({
  children,
  align = 'start',
  side = 'bottom',
  className,
  width,
  sideOffset = 6,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  width?: number;
  sideOffset?: number;
}) {
  return (
    <RM.Portal>
      <RM.Content className={cx('pop', className)} data-spot="" align={align} side={side} sideOffset={sideOffset} collisionPadding={10} style={width ? { width } : undefined}>
        {children}
      </RM.Content>
    </RM.Portal>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  keys,
  tone,
  checked,
  disabled,
  onSelect,
}: {
  icon?: IconName;
  children: ReactNode;
  hint?: ReactNode;
  keys?: string;
  tone?: 'danger';
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <RM.Item className="menu-item" data-tone={tone} disabled={disabled} onSelect={onSelect}>
      {icon && <Icon name={icon} size={16} />}
      <span className="grow truncate" onPointerEnter={titleIfCut}>
        {children}
      </span>
      {hint && <span className="hint">{hint}</span>}
      {keys && <Kbd combo={keys} />}
      {checked && <Icon name="check" size={14} />}
    </RM.Item>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <RM.Label className="menu-label">{children}</RM.Label>;
export const MenuSep = () => <RM.Separator className="menu-sep" />;


// ── popover ──

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverClose = RP.Close;

export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  className,
  width,
  sideOffset = 8,
  onOpenAutoFocus,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  width?: number;
  sideOffset?: number;
  onOpenAutoFocus?: (e: Event) => void;
}) {
  return (
    <RP.Portal>
      <RP.Content className={cx('pop', className)} data-spot="" align={align} side={side} sideOffset={sideOffset} collisionPadding={10} style={width ? { width } : undefined} onOpenAutoFocus={onOpenAutoFocus}>
        {children}
      </RP.Content>
    </RP.Portal>
  );
}

// ── dialog ──

const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog's first focus, as Radix would give it (the first control that can take it), but quiet:
 * no ring and no lit field until the person moves focus (`quietFocus`). A dialog that focused one of
 * its own controls as it mounted never gets here.
 */
function quietFirstFocus(e: Event) {
  const root = e.currentTarget as HTMLElement | null;
  const first = [...(root?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])].find((el) => el.checkVisibility?.() ?? el.offsetParent !== null);
  if (!first) return;
  e.preventDefault();
  quietFocus(first);
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width,
  className,
  bare,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
  /** Render children directly, without the standard head/body/foot frame. */
  bare?: boolean;
  /** Called when focus would return to the trigger on close; preventDefault() to move it elsewhere. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="overlay" />
        <RD.Content
          className={cx('dialog', className)}
          data-spot=""
          style={width ? { width } : undefined}

          aria-describedby={undefined}
          onOpenAutoFocus={quietFirstFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={keepForInnerScope}
        >
          {bare ? (
            <>
              <RD.Title className="sr-only">{title}</RD.Title>
              {children}
            </>
          ) : (
            <>
              <div className="dialog-head">
                <RD.Title className="dialog-title">{title}</RD.Title>
                {description && <RD.Description className="dialog-desc">{description}</RD.Description>}
              </div>
              <div className="dialog-body scroll">{children}</div>
              {footer && <div className="dialog-foot">{footer}</div>}
            </>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/**
 * Escape closes the innermost thing first. Radix hears Escape on the document before any element
 * does, so an element that handles Escape itself (an inline confirm, a field that clears) marks
 * itself `data-escape-scope` and the dialog leaves that key press to it.
 */
function keepForInnerScope(e: KeyboardEvent) {
  const t = e.target;
  if (t instanceof Element && t.closest('[data-escape-scope]')) e.preventDefault();
}

// ── switch ──

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <RS.Root className="switch" checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled}>
      <RS.Thumb className="switch-thumb" />
    </RS.Root>
  );
}

// ── slider ──

/**
 * A thin track with an ivory fill and a small solid thumb. Arrow keys step, Page Up/Down step
 * by ten, Home/End go to the ends. `onCommit` fires when a drag or key press ends.
 *
 * With `stops` (their names, lowest first) it is a scale of a few stops instead (StopSlider):
 * `value` is a stop's index (-1: none set), `onChange` says the nearest stop while it is dragged,
 * `onCommit` the stop it lands on.
 */
export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  className,
  stops,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name (the visible label usually says the same). */
  label: string;
  className?: string;
  /** The stops' names, lowest first: a scale of stops with the value's word over the thumb. */
  stops?: readonly string[];
  disabled?: boolean;
}) {
  if (stops) return <StopSlider value={value} stops={stops} onChange={onChange} onCommit={onCommit} label={label} className={className} disabled={disabled} />;
  return (
    <RSl.Root
      className={cx('slider', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      onValueCommit={onCommit ? (v) => onCommit(v[0]) : undefined}
    >
      <RSl.Track className="slider-track">
        <RSl.Range className="slider-range" />
      </RSl.Track>
      <RSl.Thumb className="slider-thumb" aria-label={label} />
    </RSl.Root>
  );
}

/** The stop slider's thumb, a disc of this many px (ui.css `.sls-thumb`). */
const STOP_THUMB = 14;
/** One frame at 60 Hz: a settle starts this far in, so its first painted frame has moved. */
const FRAME_MS = 16;
/** The word's roll: one line, the old word gone and the new one whole by 60 % of the way (composer/reel.ts). */
const ROLL_PX = 14;
const ROLL_MS = 170;
const ROLL_EASE = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

/**
 * A scale of a few stops (an effort's levels): a 4 px track with a mark at each stop, its filled
 * part ivory with the meter's dither edge, a flat disc of a thumb, and the value's word standing
 * over the thumb.
 * - Dragged, the thumb follows the pointer 1:1 (from where it was taken, so it never jumps under
 *   the pointer) and the fill with it; the word is the nearest stop's from the moment it is
 *   nearest, rolling the way the value went. Let go, the thumb settles on that stop (120 to 160 ms,
 *   a hair past) and gives a little as it lands.
 * - A press on the track brings the thumb to the pointer and the drag goes on from there; a press
 *   and release without a move lands on the nearest stop.
 * - Left and Down step down, Right and Up up, Home and End the ends (stops.ts `stopKey`); the wheel
 *   does nothing. Every key it answers stops there, so a menu round it never takes them.
 * Transform and opacity only, set per frame while dragged without a render; a render only when the
 * nearest stop changes.
 */
function StopSlider({
  value,
  stops,
  onChange,
  onCommit,
  label,
  className,
  disabled,
}: {
  value: number;
  stops: readonly string[];
  onChange: (i: number) => void;
  onCommit?: (i: number) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const n = stops.length;
  const rail = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const width = useRef(0);
  const [railW, setRailW] = useState(0);
  // Where the thumb's centre stands now (px from the rail's left), and the settle under way.
  const x = useRef(0);
  // Where the word's anchor stands (its centre, px from the rail's left).
  const anchorX = useRef(0);
  const settle = useRef<{ from: number; to: number; start: number; ms: number; frame: number } | null>(null);
  useEffect(() => () => cancelAnimationFrame(settle.current?.frame ?? 0), []);
  const drag = useRef<{ id: number; grab: number; moved: boolean; startX: number; target?: number } | null>(null);
  // The nearest stop while dragged (shown at once); null at rest, where `value` rules.
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  const latest = useRef({ onChange, onCommit, value, n });
  latest.current = { onChange, onCommit, value, n };

  /** Puts the thumb, the fill, the ticks and the word's anchor where a thumb centred at `cx` stands. */
  const place = (cx: number) => {
    x.current = cx;
    const w = width.current;
    thumb.current?.style.setProperty('translate', `${(cx - STOP_THUMB / 2).toFixed(2)}px 0`);
    // The fill ends at the thumb's near edge, so its dithered end leads into the thumb.
    fill.current?.style.setProperty('translate', `${(cx - STOP_THUMB / 2 + 1 - w).toFixed(2)}px 0`);
    const a = anchor.current;
    if (a) {
      const word = a.querySelector<HTMLElement>('.sls-word:not([data-leaving])');
      const ww = word?.offsetWidth ?? 0;
      anchorX.current = wordLeft(cx, ww, w) + ww / 2;
      a.style.setProperty('translate', `${anchorX.current.toFixed(2)}px 0`);
    }
    const r = rail.current;
    if (r) for (const t of r.querySelectorAll<HTMLElement>('.sls-tick')) t.toggleAttribute('data-on', Number(t.dataset.x) <= cx - STOP_THUMB / 2 + 1);
  };

  /** Where the thumb stands at this moment, a settle under way included (worked out from its own clock, never a computed style). */
  const nowX = () => {
    const s = settle.current;
    return s ? settleAt(s.from, s.to, s.start, s.ms, performance.now()).x : x.current;
  };

  const stopSettle = () => {
    const s = settle.current;
    if (!s) return;
    const at = nowX();
    settle.current = null;
    cancelAnimationFrame(s.frame);
    place(at);
  };

  /**
   * Glides the thumb to stop `i`, and gives as it lands. One clock drives the thumb, the fill, the
   * ticks and the word in the same frame (a thumb on the compositor with the rest following by
   * frame left the fill a frame behind: up to 30 px past the thumb on a key's step). It starts one
   * frame in, so the first painted frame already answers.
   */
  const glideTo = (i: number, give: boolean) => {
    const w = width.current;
    if (!w) return;
    const from = nowX();
    stopSettle();
    const to = stopX(i, n, w, STOP_THUMB);
    if (reducedMotion() || Math.abs(to - from) < 0.5) {
      place(to);
    } else {
      const s = { from, to, start: performance.now() - FRAME_MS, ms: settleMs(to - from), frame: 0 };
      settle.current = s;
      const tick = (now: number) => {
        if (settle.current !== s) return;
        const at = settleAt(s.from, s.to, s.start, s.ms, now);
        // The hair past a stop never takes the thumb past the track's ends.
        place(holdX(at.x, w, STOP_THUMB));
        if (at.done) settle.current = null;
        else s.frame = requestAnimationFrame(tick);
      };
      s.frame = requestAnimationFrame(tick);
    }
    if (give) play(thumb.current, [{ scale: '1' }, { scale: '0.86', offset: 0.35 }, { scale: '1.04', offset: 0.75 }, { scale: '1' }], { duration: 200, easing: 'ease-out' });
  };

  // The rail's width, now and whenever it changes (the panel's size is fixed, so this is rare).
  useLayoutEffect(() => {
    const r = rail.current;
    if (!r) return;
    const measure = () => {
      const w = r.offsetWidth;
      if (w !== width.current && settle.current) stopSettle();
      width.current = w;
      setRailW(width.current);
      if (!drag.current && !settle.current) place(stopX(Math.max(0, latest.current.value), latest.current.n, width.current, STOP_THUMB));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The value changed from outside (a key, another model's scale, the bridge): the thumb glides
  // there. A scale of another length is simply there.
  const was = useRef({ value, n });
  useLayoutEffect(() => {
    const prev = was.current;
    was.current = { value, n };
    if (drag.current || !width.current) return;
    if (prev.n !== n) {
      stopSettle();
      place(stopX(Math.max(0, value), n, width.current, STOP_THUMB));
    } else if (prev.value !== value && shouldGlide(settle.current, stopX(value, n, width.current, STOP_THUMB))) glideTo(Math.max(0, value), false);
  }, [value, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The word rolls the way the value went (the anchor holds both while they hand over).
  const shownWas = useRef(shown);
  useLayoutEffect(() => {
    const from = shownWas.current;
    shownWas.current = shown;
    const wasAt = anchorX.current;
    const a = anchor.current;
    if (!a) return;
    if (from === shown || reducedMotion()) {
      place(x.current);
      return;
    }
    const way = shown > from ? -1 : 1;
    const word = a.querySelector<HTMLElement>('.sls-word:not([data-leaving])');
    const ghost = a.querySelector<HTMLElement>('.sls-word[data-ghost]');
    if (word && ghost) {
      // The old word, kept as a copy that leaves; the new one comes in from the other side.
      ghost.textContent = from >= 0 ? (stops[from] ?? '') : '';
      ghost.setAttribute('data-leaving', '');
      ghost.getAnimations().forEach((g) => g.cancel());
      const out = ghost.animate(
        [
          { opacity: 1, transform: 'translate(-50%, 0px)' },
          { opacity: 0, transform: `translate(-50%, ${way * ROLL_PX * 0.6}px)`, offset: 0.6 },
          { opacity: 0, transform: `translate(-50%, ${way * ROLL_PX}px)` },
        ],
        { duration: ROLL_MS, easing: ROLL_EASE },
      );
      out.onfinish = () => {
        ghost.removeAttribute('data-leaving');
        ghost.textContent = '';
        ghost.style.removeProperty('left');
      };
      word.animate(
        [
          { opacity: 0, transform: `translate(-50%, ${-way * ROLL_PX}px)` },
          { opacity: 1, transform: `translate(-50%, ${-way * ROLL_PX * 0.4}px)`, offset: 0.6 },
          { opacity: 1, transform: 'translate(-50%, 0px)' },
        ],
        { duration: ROLL_MS, easing: ROLL_EASE },
      );
      place(x.current);
      // At an end the word is held inside the track by its own width, so a word of another width
      // stands elsewhere: the leaving one keeps its own place instead of jumping with the anchor.
      ghost.style.setProperty('left', `${(wasAt - anchorX.current).toFixed(2)}px`);
      return;
    }
    place(x.current);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every render (rare: the nearest stop, the width, the stops): the ticks and the word's anchor follow the thumb.
  useLayoutEffect(() => {
    if (width.current && !settle.current) place(x.current);
  });

  /** The thumb's centre for a pointer at clientX, in the rail's own px (Interface size and zoom included). */
  const railX = (clientX: number) => {
    const r = rail.current!;
    const b = r.getBoundingClientRect();
    return ((clientX - b.left) * r.offsetWidth) / (b.width || 1);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || !rail.current || n < 2) return;
    e.preventDefault();
    // Taken by the pointer: focused without the ring, which comes back with the first key.
    e.currentTarget.setAttribute('data-pointer', '');
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const px = railX(e.clientX);
    const retarget = !!settle.current;
    const at = nowX();
    stopSettle();
    // Taken by the thumb: it keeps where it was taken. Elsewhere: it comes to the pointer.
    const onThumb = Math.abs(px - at) <= STOP_THUMB / 2 + 3;
    drag.current = { id: e.pointerId, grab: onThumb ? px - at : 0, moved: false, startX: e.clientX };
    e.currentTarget.setAttribute('data-dragging', '');
    if (!onThumb) {
      const to = holdX(px, width.current, STOP_THUMB);
      const i = nearestStop(to, n, width.current, STOP_THUMB);
      if (retarget) {
        drag.current.target = i;
        glideTo(i, false);
      } else place(to);
      if (i !== shown) {
        setLive(i);
        latest.current.onChange(i);
      } else setLive(i);
    } else setLive(nearestStop(at, n, width.current, STOP_THUMB));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (Math.abs(e.clientX - d.startX) > 2) d.moved = true;
    if (d.target !== undefined && !d.moved) return;
    stopSettle();
    const to = holdX(railX(e.clientX) - d.grab, width.current, STOP_THUMB);
    place(to);
    const i = nearestStop(to, n, width.current, STOP_THUMB);
    if (i !== live) {
      setLive(i);
      latest.current.onChange(i);
    }
  };

  const release = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.removeAttribute('data-dragging');
    const i = !d.moved && d.target !== undefined ? d.target : nearestStop(x.current, n, width.current, STOP_THUMB);
    setLive(null);
    glideTo(commit ? i : Math.max(0, value), true);
    if (commit && i !== value) latest.current.onCommit?.(i);
    else if (!commit) latest.current.onChange(value);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) return;
    e.currentTarget.removeAttribute('data-pointer');
    const to = stopKey(e.key, value, n);
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (to === value) {
      // An end holds: the thumb leans the way it was pushed and comes back.
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'Home' ? -1 : 1;
      play(thumb.current, [{ transform: 'translateX(0px)' }, { transform: `translateX(${dir * 2}px)`, offset: 0.3 }, { transform: 'translateX(0px)' }], { duration: 220, easing: 'ease-out' });
      return;
    }
    latest.current.onChange(to);
    latest.current.onCommit?.(to);
  };

  const ticks = [];
  if (railW && n > 1) {
    for (let i = 0; i < n; i++) {
      const left = stopX(i, n, railW, STOP_THUMB) - 1.5;
      ticks.push(<span key={i} className="sls-tick" data-x={left.toFixed(2)} style={{ translate: `${left.toFixed(2)}px 0` }} />);
    }
  }

  return (
    <div
      className={cx('sls', className)}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, n - 1)}
      aria-valuenow={Math.max(0, shown)}
      aria-valuetext={stops[shown] ?? 'Default'}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      data-unset={shown < 0 || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => release(e, true)}
      onPointerCancel={(e) => release(e, false)}
      onLostPointerCapture={(e) => release(e, true)}
      onKeyDown={onKeyDown}
      onBlur={(e) => e.currentTarget.removeAttribute('data-pointer')}
    >
      <span className="sls-lane" aria-hidden>
        <span ref={anchor} className="sls-anchor">
          <span className="sls-word">{stops[shown] ?? 'Default'}</span>
          <span className="sls-word" data-ghost="" />
        </span>
      </span>
      <span ref={rail} className="sls-rail">
        <span className="sls-track">
          <span ref={fill} className="sls-fill" />
        </span>
        {ticks}
        <span ref={thumb} className="sls-thumb" />
      </span>
    </div>
  );
}

// ── segmented control ──

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  id,
  className,
}: {
  /** null selects nothing. */
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: IconName }[];
  /** Unique id so the sliding pill animates within this control only. */
  id: string;
  className?: string;
}) {
  void id;
  const pill = useSlidePill(value, 5);
  return (
    <div className={cx('seg', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} data-active={o.value === value} className="seg-item" onClick={() => onChange(o.value)}>
          {o.value === value && <span ref={pill} className="seg-pill" />}
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PILL = spring(520, 38);

/**
 * A selection pill that slides from the option that had it to the one that has it now. The pill is
 * rendered inside the selected option (so at rest nothing is measured: mounting a view with many
 * of these costs no layout); when the selection changes, the two options (siblings under one
 * offset parent) are measured once and the
 * pill plays a transform from the old box to the new one, its radius corrected for the scale.
 * Returns the ref for the pill element. `radius` is the pill's border radius in CSS pixels.
 * `when` decides per change whether to slide (a list that follows the pointer passes `byKeys`, so
 * the pill lands under the pointer at once and only travels for arrow keys).
 */
export function useSlidePill(key: unknown, radius: number, when?: () => boolean) {
  const ref = useRef<HTMLElement | null>(null);
  const prev = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement ?? null;
    const from = prev.current;
    prev.current = host;
    if (!pill || !host || !from || from === host || !from.isConnected || from.offsetParent !== host.offsetParent) return;
    if (when && !when()) return;
    // Layout boxes, not rects: a pressed option is scaled for a moment and must not skew the slide.
    const sx = from.offsetWidth / host.offsetWidth;
    const sy = from.offsetHeight / host.offsetHeight;
    const dx = from.offsetLeft - host.offsetLeft;
    const dy = from.offsetTop - host.offsetTop;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !sx || !sy) return;
    play(
      pill,
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: `${radius / sx}px / ${radius / sy}px` },
        { transformOrigin: '0 0', transform: 'none', borderRadius: `${radius}px` },
      ],
      { duration: PILL.duration, easing: PILL.easing },
    );
  }, [key, radius]);
  return ref as RefObject<HTMLSpanElement>;
}

/** For `useSlidePill`'s `when`: slide only for moves made with the keys. */
export const byKeys = movedByKeys;

// ── toasts ──

/** The stack's one spring, the short rise of a toast that arrives alone, and how one leaves (ms, px). */
const TOAST_SPRING = spring(420, 34);
const TOAST_RISE = 14;
const TOAST_SINK = 6;
const TOAST_OUT = 140;
/** A toast that arrives is whole at this share of its slide's way. */
const TOAST_FADE = 0.55;

/** A toast's place: how far its lower edge stands above the stack's (the stack grows upward from there). */
type ToastPlace = { el: HTMLElement; up: number };

/**
 * A slide of a toast that is under way. Two can run on one toast and add up, one on `translate` and
 * one on `transform`: a second change of the stack right behind the first starts nothing again.
 */
interface ToastSlide {
  anim: Animation;
  from: number;
  /** The slide a toast arrives on: it fades in on it. */
  fade: boolean;
}
const toastSlides = new WeakMap<HTMLElement, (ToastSlide | undefined)[]>();

const sliding = (s: ToastSlide | undefined): s is ToastSlide => !!s && s.anim.playState !== 'finished' && s.anim.playState !== 'idle';
const leftOf = (s: ToastSlide | undefined, now: number) => (sliding(s) ? slideLeft(TOAST_SPRING, s.from, s.anim.startTime as number | null, now) : 0);
/** How much of a toast shows at `now`: all of it, unless it still arrives. */
const shownOf = (s: ToastSlide | undefined, now: number) => (sliding(s) && s.fade ? fadeShown(TOAST_SPRING, TOAST_FADE, s.anim.startTime as number | null, now) : 1);

/** Slides `el` home from `by` px off its place, on top of whatever slides it already has. */
function slideToast(el: HTMLElement, by: number, fade = false) {
  // Where the toast will be when this takes over (a frame from now), never a computed style.
  const now = performance.now() + 16;
  const slides = toastSlides.get(el) ?? [];
  const left = [leftOf(slides[0], now), leftOf(slides[1], now)];
  // A free slot, else the one that has less left to go: what it still held goes into the new slide.
  const i = Math.abs(left[0]) < 0.5 ? 0 : Math.abs(left[1]) < 0.5 ? 1 : Math.abs(left[0]) <= Math.abs(left[1]) ? 0 : 1;
  slides[i]?.anim.cancel();
  const from = by + left[i];
  const y = (v: number) => (i === 0 ? { translate: `0 ${v}px` } : { transform: `translateY(${v}px)` });
  const frames: Keyframe[] = fade ? [{ opacity: 0, ...y(from) }, { opacity: 1, offset: TOAST_FADE }, { opacity: 1, ...y(0) }] : [y(from), y(0)];
  const anim = play(el, frames, { duration: TOAST_SPRING.duration, easing: TOAST_SPRING.easing });
  slides[i] = anim ? { anim, from, fade } : undefined;
  toastSlides.set(el, slides);
}

/** The stack's room from the stage's sheet: its bottom-right inset, or above the composer in a chat. */
const TOAST_INSET = 16;

/**
 * The stack belongs to the stage: its right edge 16 px in from the sheet's (the side panel's edge
 * when it is open), its bottom 16 px above the sheet's, or above everything the dock holds in a
 * chat (waiting cards, the task strip, the composer), so a toast covers none of it. Read when a toast comes or goes and when the window
 * changes size, never per frame.
 */
function placeToasts(host: HTMLElement) {
  const stage = document.querySelector('.stage');
  if (!stage) {
    host.style.removeProperty('--toast-r');
    host.style.removeProperty('--toast-b');
    return;
  }
  const z = uiZoom();
  const r = stage.getBoundingClientRect();
  // In a chat: above all the dock holds (waiting cards, the task strip, the composer and its strips).
  const composer = document.querySelector('.stage-dock .dock-inner');
  const top = composer ? composer.getBoundingClientRect().top : r.bottom;
  host.style.setProperty('--toast-r', `${Math.max(0, (window.innerWidth - r.right) / z + TOAST_INSET)}px`);
  host.style.setProperty('--toast-b', `${Math.max(0, (window.innerHeight - top) / z + (composer ? 10 : TOAST_INSET))}px`);
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const box = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, ToastPlace>());
  const order = toasts.map((t) => t.id).join(' ');

  // The stack moves as one body, on one spring, started in one task (opacity, translate and
  // transform only, so it runs on the compositor): a toast that arrives where others stand comes up
  // from one place lower while they go up by its height, so no two ever share a place (a toast used
  // to fade in over the one before it for three frames: two panes, two lines of text in one spot).
  // One that leaves is taken out of the layout at once: its own element stays as a dead copy, held
  // by its lower edge and under the others, sinking and fading, while the ones above come down.
  // Nothing is read back from the page: where a toast stands mid-slide is worked out (`slideLeft`).
  useLayoutEffect(() => {
    const host = box.current;
    if (!host) return;
    if (toasts.length) placeToasts(host);
    const before = places.current;
    const now = new Map<string, ToastPlace>();
    const els = [...host.querySelectorAll<HTMLElement>(':scope > .toast:not([data-gone])')];
    // Reads: each toast's place in the new layout.
    const height = host.offsetHeight;
    const gap = parseFloat(getComputedStyle(host).rowGap) || 0;
    const read = els.map((el) => ({ el, id: el.dataset.toast!, up: height - el.offsetTop - el.offsetHeight, h: el.offsetHeight }));
    const gone = [...before].filter(([id]) => !read.some((r) => r.id === id)).map(([, was]) => was);
    for (const r of read) now.set(r.id, { el: r.el, up: r.up });
    places.current = now;
    if (reducedMotion()) return;
    // Writes.
    const at = performance.now() + 16;
    for (const was of gone) {
      const el = was.el;
      const slides = toastSlides.get(el) ?? [];
      const held = leftOf(slides[0], at) + leftOf(slides[1], at);
      // Dismissed while it still arrived: it goes from what shows of it (from whole, it flashed up for a frame).
      const shown = Math.min(shownOf(slides[0], at), shownOf(slides[1], at));
      for (const s of slides) s?.anim.cancel();
      // React has let go of it: the element itself is the copy, back in the stack but out of its flow,
      // under the others (one that comes up into its place while it goes covers it).
      el.setAttribute('data-gone', '');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
      el.style.cssText = `position:absolute;right:0;bottom:${was.up}px;z-index:-1;margin:0;pointer-events:none;`;
      host.appendChild(el);
      const out = play(el, [{ opacity: shown, translate: `0 ${held}px` }, { opacity: 0, translate: `0 ${held + TOAST_SINK}px` }], { duration: TOAST_OUT, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' });
      const off = () => el.remove();
      if (out) out.finished.then(off, off);
      else off();
    }
    const pushed = read.some((r) => before.has(r.id));
    for (const r of read) {
      const was = before.get(r.id);
      if (!was) {
        // Alone it rises a little; under a stack it comes from one place lower, as the stack makes room.
        slideToast(r.el, pushed ? r.h + gap : TOAST_RISE, true);
      } else if (Math.abs(r.up - was.up) >= 0.5) {
        // Up when the stack grew under it, down when one below it left.
        slideToast(r.el, r.up - was.up);
      }
    }
  }, [order]);

  // A window that changes size while toasts stand moves the stack with the stage.
  const shown = toasts.length > 0;
  useEffect(() => {
    if (!shown) return;
    const on = () => box.current && placeToasts(box.current);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [shown]);

  // On body, above any dialog: `.app` isolates its own stacking context. Pointer events are kept
  // from reaching an open dialog's outside-click handler, so dismissing a toast leaves the dialog open.
  // A toast never takes focus: a click on it moves no focus (the press is kept from doing so) and
  // Tab passes it by, so it cannot close an open popover (focus leaving one dismisses it), take
  // the caret out of the composer, or leave focus on nothing when it goes. It says its text
  // through the live region and leaves by itself.
  return createPortal(
    <div ref={box} className="toasts" aria-live="polite" onPointerDown={(e) => e.nativeEvent.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
      {toasts.map((t) => (
        <button key={t.id} type="button" className="toast" tabIndex={-1} data-toast={t.id} data-level={t.level} aria-label={`${t.text}. Dismiss`} onClick={() => dismiss(t.id)}>
          <Icon name={t.level === 'error' ? 'error' : t.level === 'warn' ? 'warning' : t.level === 'success' ? 'check-circle' : 'info'} size={16} />
          {/* Said again while it stands: the same words in a new node, so the live region reads them out again. */}
          <span key={t.again ?? 0}>{t.text}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ── paths ──

/**
 * A path, folder or file shown as a label: the UI font, the directory dim and the name regular.
 * The directory gives way first (its start is elided), the name stays whole. Pass a path that is
 * already shortened for display (relPath / tildePath). Never monospace: that is for code only.
 * `fit` cuts the directory by whole folders ("…/Local/Temp/", starting on the label's own left
 * edge) instead of mid-name: for menus, settings and dialogs (ui/path-fit.ts says why and at what
 * cost); rows that mount by the hundred keep the plain cut.
 */
export function PathLabel({ path, className, title, fit }: { path: string; className?: string; title?: string; fit?: boolean }) {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  const dir = i >= 0 ? norm.slice(0, i + 1) : '';
  const name = i >= 0 ? norm.slice(i + 1) : norm;
  const dirBox = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = dirBox.current;
    if (!fit || !el) return;
    fitDir(el);
    return watchDir(el);
  }, [fit, dir]);
  // The full path shows as a tooltip only when part of it was cut (or when a different title was asked for).
  return (
    <span className={cx('path', className)} title={title && title !== path ? title : undefined} data-title={path} onPointerEnter={title && title !== path ? undefined : titleIfCut}>
      {/* Left-to-right marks hold the slashes in place inside the right-to-left box that cuts from the start. */}
      {dir &&
        (fit ? (
          // The whole directory unseen in the flow (it gives the box its width); what fits is written over it.
          <span className="path-dir" data-fit="" data-dir={dir} ref={dirBox}>
            <span className="path-dir-full" aria-hidden>
              {dir}
            </span>
            <span className="path-dir-shown" />
          </span>
        ) : (
          <span className="path-dir">{`\u200E${dir}\u200E`}</span>
        ))}
      <span className="path-name">{name || norm}</span>
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {

  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}
