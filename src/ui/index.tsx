import { cloneElement, forwardRef, isValidElement, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type FocusEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as RD, DropdownMenu as RM, Popover as RP, Slider as RSl, Switch as RS, Tooltip as RT } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { Icon, type IconName } from '@/icons';
import { isMac, shortcutKeys } from '@/lib/format';
import { play, spring } from '@/lib/motion';
import { useStore } from '@/state/store';
import './grow';
import { movedByKeys } from './glide';

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
export function Tip({ label, keys, side = 'bottom', children }: { label: ReactNode; keys?: string; side?: TipSide; children: ReactNode }) {
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
            <RT.Content className="tooltip" side={side} sideOffset={7} collisionPadding={8}>
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
}) {
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
  const pill = useSlidePill(value, 6);
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

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  // On body, above any dialog: `.app` isolates its own stacking context. Pointer events are kept
  // from reaching an open dialog's outside-click handler, so dismissing a toast leaves the dialog open.
  return createPortal(
    <div className="toasts" aria-live="polite" onPointerDown={(e) => e.nativeEvent.stopPropagation()}>
      {/* A toast rises in on a spring and, dismissed or timed out, sinks back and fades while the
          others close the gap; it never just vanishes. */}
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            layout="position"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="toast"
            data-level={t.level}
            aria-label={`${t.text}. Dismiss`}
            onClick={() => dismiss(t.id)}
          >
            <Icon name={t.level === 'error' ? 'error' : t.level === 'warn' ? 'warning' : t.level === 'success' ? 'check-circle' : 'info'} size={16} />
            <span>{t.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

// ── paths ──

/**
 * A path, folder or file shown as a label: the UI font, the directory dim and the name regular.
 * The directory gives way first (its start is elided), the name stays whole. Pass a path that is
 * already shortened for display (relPath / tildePath). Never monospace: that is for code only.
 */
export function PathLabel({ path, className, title }: { path: string; className?: string; title?: string }) {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  const dir = i >= 0 ? norm.slice(0, i + 1) : '';
  const name = i >= 0 ? norm.slice(i + 1) : norm;
  // The full path shows as a tooltip only when part of it was cut (or when a different title was asked for).
  return (
    <span className={cx('path', className)} title={title && title !== path ? title : undefined} data-title={path} onPointerEnter={title && title !== path ? undefined : titleIfCut}>
      {/* Left-to-right marks hold the slashes in place inside the right-to-left box that cuts from the start. */}
      {dir && <span className="path-dir">{`\u200E${dir}\u200E`}</span>}
      <span className="path-name">{name || norm}</span>
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {

  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}
