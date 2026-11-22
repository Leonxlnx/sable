import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { STANDARD_SPEED, type Effort, type SpeedInfo } from '@shared/protocol';
import { effortName, isUltraEffort } from '@/lib/models';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { Tip } from '@/ui';
import { Icon } from '@/icons';
import { Chip, type ChipPart } from './Chip';
import { type Choice } from './choice';
import { ChipSkeleton, MENU_EVENT, MENU_PAD, ROW_H, usePanePlace } from './Controls';
import { keyStop, land, lastStop, litLevels, positionOf, SCALE_KEYS, SCRUB_SLOP, scrubStop, type Scale, type Setting } from './effort-track';
import { paidConfirmed, confirmPaid, takePaidAsk } from './paid-speed';
import { Later } from './later';

/**
 * The ladder's first focus: the stop in use. With none set (the agent decides the level) nothing is
 * lit and focus rests on the menu itself, so Enter right after opening changes nothing: the row
 * nearest the chip would be ultracode on home. The arrows start from there.
 */
// DropdownMenu.Content passes this through to the menu's focus scope; its types leave it out.
const FOCUS_STOP = {
  onOpenAutoFocus: (e: Event) => {
    e.preventDefault();
    const pop = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!pop.isConnected || pop.dataset.state === 'closed' || (at && at !== pop && pop.contains(at))) return;
      (pop.querySelector<HTMLElement>('[data-current]') ?? pop).focus({ preventScroll: true });
    });
  },
} as object;

/** How long the scale's own part of ultracode's moment plays (composer.css `th-pip-wave`). */
const BURST_MS = 700;

/**
 * The scale as pips: one per level, lit up to where it stands. What lies past the plain levels (an
 * Ultra level, ultracode) stands a step apart, outlined until it is reached. A change runs along
 * the pips from where the scale stood (`from`), so it reads as a move and never as a swap.
 */
export function Pips({ efforts, pos, ultra, from = pos }: { efforts: Effort[]; pos: number; ultra: boolean; from?: number }) {
  const n = efforts.length;
  const lit = litLevels(pos, { levels: n, ultra });
  const order = (i: number) => ({ '--i': i, '--d': Math.max(0, Math.abs(i - from) - 1) }) as CSSProperties;
  return (
    <span className="th-pips" aria-hidden>
      {efforts.map((e, i) => (
        <i key={e} data-on={i < lit || undefined} data-far={isUltraEffort(e) || undefined} style={order(i)} />
      ))}
      {ultra && <i data-far="" data-on={pos >= n || undefined} style={order(n)} />}
    </span>
  );
}

export interface ThinkingProps {
  efforts: Effort[];
  /** The level in use (the model's default when none was picked); undefined when the agent decides. */
  value: Effort | undefined;
  onChange: (e: Effort) => void;
  /** Ultracode can be switched for this session (`caps.features.ultracode`). */
  ultraOffered: boolean;
  ultracode: boolean;
  onUltracode: (on: boolean) => void;
  /** Speeds beyond standard the model offers; none hides the speed rows. */
  speeds?: SpeedInfo[];
  speed?: string;
  onSpeed?: (id: string) => void;
  /** The session (a paid speed is asked for once per session); null on home. */
  sessionId?: string | null;
  side: 'top' | 'bottom';
  onClosed: () => void;
  /** The chip stood as a placeholder first: it comes in once (composer.css `data-late`). */
  late?: boolean;
}

/**
 * Effort, set on the bar. At rest the chip is the scale itself: its pips and the level's name.
 * - Drag it sideways and the level follows, stop by stop; the keyboard's left and right arrows do
 *   the same while it has focus. Nothing opens, and the field keeps the caret.
 * - Past the last level stands one more stop: ultracode. It keeps the level that was set under it.
 * - A click opens the ladder: every stop by name, the highest on top, and under it the speeds the
 *   model offers beyond standard.
 * Every way in ends in `land()` (effort-track.ts), so what the chip names is what is sent.
 */
export const Thinking = memo(function Thinking({ efforts, value, onChange, ultraOffered, ultracode, onUltracode, speeds = NO_SPEEDS, speed = STANDARD_SPEED, onSpeed, sessionId = null, side, onClosed, late }: ThinkingProps) {
  const [open, setOpen] = useState(false);
  // A level sent and not yet confirmed, so nothing waits on a round trip; and the stop a drag stands on.
  const [local, setLocal] = useState<Effort | undefined>();
  const [preview, setPreview] = useState<number | null>(null);
  const committed = local && efforts.includes(local) ? local : value;
  const ucOn = ultraOffered && ultracode;
  const scale: Scale = { levels: efforts.length, ultra: ultraOffered };
  const now: Setting = { level: committed ? efforts.indexOf(committed) : -1, ultra: ucOn };
  const at = positionOf(now, scale);
  // The chip names what the scale stands on: the dragged stop while a drag runs.
  const pos = preview ?? at;
  const onUltra = ultraOffered && pos === efforts.length;
  const shown = onUltra ? undefined : efforts[pos];
  const look = onUltra || isUltraEffort(shown);
  // A paid speed waiting on its question (from a click on its row or from `/fast`).
  const [ask, setAsk] = useState<string | null>(null);

  const chip = useRef<HTMLButtonElement>(null);
  // The ladder's height: its stops (the step of air before what lies past the levels), then the speeds or their question.
  const need = (efforts.length + (ultraOffered ? 1 : 0)) * ROW_H + 4 + (speeds.length ? 9 + Math.max(speeds.length * ROW_H, ask ? 96 : 0) : 0) + MENU_PAD;
  const place = usePanePlace(chip, open, side, 'end', need);
  const settleTimer = useRef(0);
  // Where the scale stood when it last drew, so a change runs along the pips from there.
  const drawn = useRef(pos);
  const from = drawn.current;
  useEffect(() => {
    drawn.current = pos;
  }, [pos]);

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== 'effort') return;
      const want = takePaidAsk(sessionId);
      if (want) setAsk(want);
      setOpen(true);
    };
    window.addEventListener(MENU_EVENT, on);
    return () => window.removeEventListener(MENU_EVENT, on);
  }, [sessionId]);
  useEffect(() => {
    if (!open) setAsk(null);
  }, [open]);

  // The confirmed value caught up: drop the local one.
  useEffect(() => {
    if (local && value === local) setLocal(undefined);
  }, [value, local]);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const commit = useCallback(
    (i: number) => {
      const e = efforts[i];
      if (!e) return;
      setLocal(e);
      onChange(e);
      // Never confirmed (the agent refused it): show what is really in use again.
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setLocal(undefined), 4000);
    },
    [efforts, onChange],
  );

  /** Lands on a stop: sends what that changes, the level before ultracode. */
  const go = (to: number, via: 'key' | 'drag' | 'pick') => {
    const out = land(now, to, scale, via);
    if (out.level !== undefined) commit(out.level);
    if (out.ultra !== undefined) onUltracode(out.ultra);
  };

  // The "ultra" moment: when it turns on by the person's hand, not when a view opens with it on.
  const [burst, setBurst] = useState(false);
  const wasLook = useRef(look);
  useEffect(() => {
    // While a drag still runs the stop is only passed over: the moment comes with the landing.
    if (preview !== null || look === wasLook.current) return;
    wasLook.current = look;
    if (!look || reducedMotion()) return setBurst(false);
    setBurst(true);
    const t = window.setTimeout(() => setBurst(false), BURST_MS);
    return () => window.clearTimeout(t);
  }, [look, preview]);

  // ── the chip: a click opens the ladder, a drag scrubs the scale ──

  const drag = useRef<{ id: number; x: number; from: number; to: number; moved: boolean; wasOpen: boolean } | null>(null);
  const [scrub, setScrub] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || e.ctrlKey) return;
    // Radix opens a menu on the press itself. This chip opens on a click and scrubs on a drag, so
    // the press is ours; it also leaves focus where it is (the field keeps the caret).
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, from: at, to: at, moved: false, wasOpen: open };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || lastStop(scale) < 0) return;
    const dx = (e.clientX - d.x) / uiZoom();
    if (!d.moved) {
      if (Math.abs(dx) < SCRUB_SLOP) return;
      d.moved = true;
      setScrub(true);
      if (open) setOpen(false);
    }
    const to = scrubStop(d.from, dx, scale);
    if (to === d.to) return;
    d.to = to;
    setPreview(to);
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>, landed: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already let go */
    }
    if (d.moved) {
      setScrub(false);
      setPreview(null);
      if (landed && d.to !== d.from) go(d.to, 'drag');
    } else if (landed) setOpen(!d.wasOpen);
  };
  // Escape while the scale is dragged takes the drag back: nothing is set, and the key goes no
  // further (the field has the focus meanwhile, so the chip's own key handler never sees it).
  useEffect(() => {
    if (!scrub) return;
    const onKey = (e: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const d = drag.current;
      drag.current = null;
      try {
        if (d) chip.current?.releasePointerCapture(d.id);
      } catch {
        /* already let go */
      }
      setScrub(false);
      setPreview(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scrub]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !SCALE_KEYS.test(e.key)) return;
    const to = keyStop(at, e.key, scale);
    e.preventDefault();
    if (to !== null) go(to, 'key');
  };

  const hasSpeed = speeds.length > 0 && !!onSpeed;
  if (!efforts.length && !ultraOffered && !hasSpeed) return null;

  const fast = hasSpeed && speed !== STANDARD_SPEED;
  const speedInfo = speeds.find((s) => s.id === speed);
  const asking = ask ? speeds.find((s) => s.id === ask) : undefined;
  const levelName = shown ? effortName(shown) : 'Default';
  const name = onUltra ? 'Ultracode' : levelName;
  const hasScale = lastStop(scale) >= 0;
  const aria = (hasScale ? (efforts.length ? `Effort: ${onUltra && committed ? `${effortName(committed)}, ultracode on` : name}` : `Ultracode ${ucOn ? 'on' : 'off'}`) : 'Speed') + (fast ? `, ${speedInfo?.name ?? 'fast'} speed${speedInfo?.paid ? ', billed as extra usage' : ''}` : '');
  const tip = (efforts.length ? 'Effort' : ultraOffered ? 'Ultracode' : 'Speed') + (fast && speedInfo?.paid ? ` · ${speedInfo.name} on extra usage` : '');
  // What the chip says, part by part (Chip.tsx): the pips stay while the word changes, so a new
  // level is one glide of the chip's left end and the pips answer in the same frame. The chip
  // hugs its label and its right end (before the cove) holds.
  const parts: ChipPart[] = [];
  if (fast || !hasScale) parts.push({ k: 'bolt', node: <Icon name="bolt" size={13} className="th-bolt" /> });
  if (hasScale) {
    parts.push({ k: 'pips', node: <Pips efforts={efforts} pos={pos} ultra={ultraOffered} from={from} /> });
    parts.push({ k: `word:${name}`, className: 'th-word', node: name });
  }
  const pickSpeed = (s: SpeedInfo, e: Event) => {
    const next = speed === s.id ? STANDARD_SPEED : s.id;
    if (next !== STANDARD_SPEED && s.paid && sessionId && !paidConfirmed(sessionId)) {
      // Asked once per session, in place: the menu stays.
      e.preventDefault();
      setAsk(s.id);
      return;
    }
    onSpeed?.(next);
  };
  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={tip} side="top">
        <RM.Trigger asChild onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(e) => endDrag(e, true)} onPointerCancel={(e) => endDrag(e, false)} onKeyDown={onKeyDown}>
          <Chip
            ref={chip}
            className="tb-chip th-chip"
            anchor="right"
            data-ultra={look || undefined}
            data-burst={burst || undefined}
            data-scrub={scrub || undefined}
            data-bare={!hasScale || undefined}
            data-late={late || undefined}
            aria-label={aria}
            aria-keyshortcuts={hasScale ? 'ArrowLeft ArrowRight' : undefined}
            parts={parts}
          />
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop th-pop"
          data-spot
          side={place.side}
          align="end"
          sideOffset={place.sideOffset}
          alignOffset={place.alignOffset}
          avoidCollisions={place.avoid}
          collisionPadding={10}
          aria-label="Effort"
          {...FOCUS_STOP}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {ultraOffered && (
                  // Past the end of the scale. Picked again while it is on, it only switches off: the level kept under it stands (none, where the agent decides it).
                  <RM.Item className="menu-item th-row th-row-far" data-current={ucOn || undefined} data-lit={ucOn || undefined} onSelect={() => (ucOn ? onUltracode(false) : go(efforts.length, 'pick'))}>
                    <i className="th-seg" aria-hidden />
                    <span className="grow">Ultracode</span>
                  </RM.Item>
                )}
                {efforts
                  .map((e, i) => (
                    <RM.Item
                      key={e}
                      className={isUltraEffort(e) ? 'menu-item th-row th-row-far' : 'menu-item th-row'}
                      data-current={(!ucOn && i === now.level) || undefined}
                      data-lit={ucOn || i <= now.level || undefined}
                      onSelect={() => go(i, 'pick')}
                    >
                      <i className="th-seg" aria-hidden />
                      <span className="grow">{effortName(e)}</span>
                      {/* The level kept under ultracode: where the scale steps back to. */}
                      {ucOn && i === now.level && <Icon name="check" size={13} className="th-kept" />}
                    </RM.Item>
                  ))
                  .reverse()}
                {hasSpeed && hasScale && <RM.Separator className="menu-sep th-sep" />}
                {hasSpeed &&
                  (asking ? (
                    // Its own keys: Tab moves between the two buttons, and no letter reaches the menu's typeahead.
                    <div className="th-ask" role="group" aria-label={`Turn on ${asking.name.toLowerCase()} mode`} onKeyDown={(e) => e.stopPropagation()}>
                      <p className="th-ask-q">{asking.name} mode is billed as extra usage, not from your plan.</p>
                      <div className="th-ask-row">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsk(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          autoFocus
                          onClick={() => {
                            if (sessionId) confirmPaid(sessionId);
                            setAsk(null);
                            onSpeed?.(asking.id);
                            setOpen(false);
                          }}
                        >
                          Turn on
                        </button>
                      </div>
                    </div>
                  ) : (
                    speeds.map((s) => {
                      // A speed is on or off: picked again, it goes back to standard.
                      const row = (
                        <RM.CheckboxItem key={s.id} className="menu-item th-row th-speed" checked={speed === s.id} onSelect={(e) => pickSpeed(s, e)}>
                          <Icon name="bolt" size={13} className="th-lead" />
                          <span className="grow truncate">{s.name}</span>
                          {/* A speed billed outside the plan names its cost on its row. */}
                          {s.paid && speed !== s.id && <span className="th-cost">{s.note ?? 'Extra usage'}</span>}
                          <span className="mm-check">{speed === s.id && <Icon name="check" size={14} />}</span>
                        </RM.CheckboxItem>
                      );
                      // What a speed inside the plan costs (it uses the plan faster) is its tooltip, as before.
                      return s.note && !s.paid ? (
                        <Tip key={s.id} label={s.note} side="left">
                          {row}
                        </Tip>
                      ) : (
                        row
                      );
                    })
                  ))}
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

/** The effort control for the composer's choice, or a quiet placeholder while nothing is known of the agent yet. */
export const ModelEffort = memo(function ModelEffort({
  choice,
  side,
  onClosed,
  ultraOffered,
  ultracode,
  onUltracode,
}: {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
  ultraOffered: boolean;
  ultracode: boolean;
  onUltracode: (on: boolean) => void;
}) {
  const late = useRef(false);
  if (!choice.caps) late.current = true;
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={78} /> : null;
  const efforts = choice.model?.efforts ?? NO_EFFORTS;
  return (
    <Thinking
      efforts={efforts}
      value={choice.effort}
      onChange={choice.setEffort}
      ultraOffered={ultraOffered}
      ultracode={ultracode}
      onUltracode={onUltracode}
      speeds={choice.speeds}
      speed={choice.speed}
      onSpeed={choice.setSpeed}
      sessionId={choice.sessionId}
      side={side}
      onClosed={onClosed}
      late={late.current}
    />
  );
});

const NO_EFFORTS: Effort[] = [];
const NO_SPEEDS: SpeedInfo[] = [];
