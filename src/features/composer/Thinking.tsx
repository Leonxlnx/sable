import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Popover as RP } from 'radix-ui';
import { STANDARD_SPEED, type Effort, type SpeedInfo } from '@shared/protocol';
import { effortName, isUltraEffort } from '@/lib/models';
import { reducedMotion } from '@/lib/motion';
import { Segmented, Switch, Tip } from '@/ui';
import { Icon } from '@/icons';
import { Chip, type ChipPart } from './Chip';
import { type Choice } from './choice';
import { ChipSkeleton, MENU_EVENT } from './Controls';
import { headerLevel, step, stopAt, TRACK_KEYS, type TrackEvent, type TrackState } from './effort-track';
import { paidConfirmed, confirmPaid, takePaidAsk } from './paid-speed';
import { Later } from './later';

/** The landed bar's detent. */
const SETTLE_MS = 220;
/** How long the "ultra" moment plays when it turns on. */
const BURST_MS = 900;

/**
 * The "ultra" mark: two stacked heads, the second riding under the first. The same drawing the
 * send key gains, worn by ultracode (Claude Code) and by the Ultra level (Codex) alike.
 */
export function UltraMark({ className }: { className?: string }) {
  return (
    <svg className={className ? `ux-mark ${className}` : 'ux-mark'} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path className="ux-m1" d="M3.6 6.4 7 3l3.4 3.4" />
      <path className="ux-m2" d="M3.6 10.6 7 7.2l3.4 3.4" />
    </svg>
  );
}

/** A level's name, with the ultra mark in front of an Ultra level. */
function LevelName({ effort }: { effort: Effort | undefined }) {
  return (
    <>
      {isUltraEffort(effort) && <UltraMark />}
      {effort ? effortName(effort) : 'Default'}
    </>
  );
}

/** The level as a dial: the arc is the share of the way to the top level (none: the agent decides). */
export function Dial({ level, of }: { level: number; of: number }) {
  const round = 2 * Math.PI * 5;
  const share = of > 0 ? Math.max(0, Math.min(1, level / of)) : 0;
  return (
    <svg className="th-dial" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle className="th-dial-track" cx="7" cy="7" r="5" />
      <circle className="th-dial-arc" cx="7" cy="7" r="5" strokeDasharray={round} strokeDashoffset={round * (1 - share)} opacity={share ? 1 : 0} />
    </svg>
  );
}

interface TrackProps {
  efforts: Effort[];
  /** The confirmed level (or -1 when the agent decides). */
  level: number;
  /** While the pointer drags: the stop it stands on, so the chip names the same level as the track. */
  onPreview: (i: number | null) => void;
  /** A stop settled (release, click or key): save and send it. */
  onCommit: (i: number) => void;
  onDone: () => void;
  trackRef: RefObject<HTMLDivElement | null>;
  burst: boolean;
}

/**
 * The effort steps: one row of cells, one per level, lit up to the level (the current one ivory, an
 * Ultra level outlined until reached). Click a cell, drag across them, or use the arrows, Home, End and number keys: all
 * go through `step()` (effort-track.ts), so what the header names is what lands and is sent.
 */
function Track({ efforts, level, onPreview, onCommit, onDone, trackRef, burst }: TrackProps) {
  const n = efforts.length;
  const [s, setS] = useState<TrackState>({ level, hover: null, dragging: false });
  // The landing: the settled bar takes a short detent (one keyframe, restarted per landing).
  const [settle, setSettle] = useState(false);
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const row = useRef<HTMLSpanElement>(null);
  const sRef = useRef(s);
  sRef.current = s;
  // The level the track drew last, so the lighting runs outward from where it was.
  const prev = useRef(s.level);
  const from = prev.current;
  useEffect(() => {
    prev.current = s.level;
  }, [s.level]);

  // The confirmed value moved from outside: follow it (never mid-drag).
  useEffect(() => {
    if (level !== sRef.current.level) setS((cur) => step(cur, { type: 'sync', level }, n).state);
  }, [level, n]);

  const dispatch = (e: TrackEvent) => {
    const out = step(sRef.current, e, n);
    sRef.current = out.state;
    setS(out.state);
    if (e.type === 'down' || e.type === 'move') onPreview(out.state.dragging ? out.state.level : null);
    if (out.commit !== undefined) {
      onPreview(null);
      onCommit(out.commit);
      setSettle(false);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        setSettle(true);
        settleTimer.current = window.setTimeout(() => setSettle(false), SETTLE_MS);
      }, 0);
    }
    if (out.done) onDone();
  };

  const at = (clientX: number) => {
    const r = row.current?.getBoundingClientRect();
    return r ? stopAt(clientX, r.left, r.width, n) : 0;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
    e.currentTarget.focus({ preventScroll: true });
    dispatch({ type: 'down', at: at(e.clientX) });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const i = at(e.clientX);
    const cur = sRef.current;
    if (cur.dragging ? i !== cur.level : i !== cur.hover) dispatch({ type: 'move', at: i });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!TRACK_KEYS.test(e.key)) return;
    e.preventDefault();
    dispatch({ type: 'key', key: e.key });
  };

  const named = headerLevel(s);
  const shown = efforts[named];
  const still = reducedMotion();

  return (
    <div className="th-body">
      <div className="th-head">
        <span className="th-name" data-preview={named !== s.level || undefined} data-ultra={isUltraEffort(shown) || undefined} key={named}>
          <LevelName effort={shown} />
        </span>
        <span className="th-title">Effort</span>
      </div>
      <div
        ref={trackRef}
        className="th-track"
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={s.level + 1}
        aria-valuetext={effortName(efforts[s.level]) ?? 'Default'}
        data-pressed={s.dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => dispatch({ type: 'up' })}
        onPointerCancel={() => dispatch({ type: 'up' })}
        onLostPointerCapture={() => sRef.current.dragging && dispatch({ type: 'up' })}
        onPointerLeave={() => dispatch({ type: 'leave' })}
        onKeyDown={onKeyDown}
      >
        <span ref={row} className="th-steps">
          {efforts.map((e, i) => {
            const on = i <= s.level;
            const cur = i === s.level;
            return (
              <span
                key={e}
                className="th-col"
                data-on={on || undefined}
                data-cur={cur || undefined}
                data-hover={(i === s.hover && !s.dragging) || undefined}
                data-ultra={isUltraEffort(e) || undefined}
                data-burst={(burst && isUltraEffort(e)) || undefined}
              >
                <i
                  data-settle={(cur && settle && !still) || undefined}
                  style={{ transitionDelay: still ? undefined : `${Math.max(0, Math.abs(i - from) - 1) * 24}ms` }}
                />
              </span>
            );
          })}
        </span>
      </div>
    </div>
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
  /** Speeds beyond standard the model offers; none hides the Speed row. */
  speeds?: SpeedInfo[];
  speed?: string;
  onSpeed?: (id: string) => void;
  /** The session (a paid speed is asked for once per session); null on home. */
  sessionId?: string | null;
  side: 'top' | 'bottom';
  onClosed: () => void;
}

/**
 * Standard and the faster speeds, one segmented row. A speed included in the plan is a plain
 * choice (its cost note in the tooltip); a paid one (Claude's fast mode) names its cost in the row
 * and, the first time in a session, asks before it is turned on.
 */
function SpeedRow({ speeds, speed, onSpeed, sessionId, ask, onAsk }: { speeds: SpeedInfo[]; speed: string; onSpeed: (id: string) => void; sessionId: string | null; ask: string | null; onAsk: (id: string | null) => void }) {
  const asking = ask ? speeds.find((s) => s.id === ask) : undefined;
  const options = [{ id: STANDARD_SPEED, name: 'Standard' } as SpeedInfo, ...speeds].map((s) => ({
    value: s.id,
    label: s.paid ? (
      <span className="th-paid">
        {s.name}
        <span className="th-cost">{s.note ?? 'Extra usage'}</span>
      </span>
    ) : s.note ? (
      <Tip label={s.note} side="bottom">
        <span>{s.name}</span>
      </Tip>
    ) : (
      s.name
    ),
  }));
  const pick = (id: string) => {
    const s = speeds.find((x) => x.id === id);
    if (s?.paid && sessionId && !paidConfirmed(sessionId)) return onAsk(id);
    onAsk(null);
    onSpeed(id);
  };
  return (
    <div className="th-speed">
      <div className="th-head">
        <span className="th-title">Speed</span>
      </div>
      {asking ? (
        <div className="th-ask" role="group" aria-label={`Turn on ${asking.name.toLowerCase()} mode`}>
          <p className="th-ask-q">
            {asking.name} mode is billed as extra usage, not from your plan.
          </p>
          <div className="th-ask-row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAsk(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              autoFocus
              onClick={() => {
                if (sessionId) confirmPaid(sessionId);
                onAsk(null);
                onSpeed(asking.id);
              }}
            >
              Turn on
            </button>
          </div>
        </div>
      ) : (
        <Segmented id="th-speed" className="th-speed-seg" value={speed} onChange={pick} options={options} />
      )}
    </div>
  );
}

/**
 * The thinking control: the level's name at rest; a small popover with the
 * stepped track and, where the agent has it, the ultracode switch. Choices apply live.
 */
export const Thinking = memo(function Thinking({ efforts, value, onChange, ultraOffered, ultracode, onUltracode, speeds = NO_SPEEDS, speed = STANDARD_SPEED, onSpeed, sessionId = null, side, onClosed }: ThinkingProps) {
  const [open, setOpen] = useState(false);
  // A level sent and not yet confirmed, so nothing waits on a round trip; and the stop a drag stands on.
  const [local, setLocal] = useState<Effort | undefined>();
  const [preview, setPreview] = useState<number | null>(null);
  const committed = local && efforts.includes(local) ? local : value;
  const committedLevel = committed ? efforts.indexOf(committed) : -1;
  // The chip names what the track stands for: the dragged stop while a drag runs.
  const shown = preview !== null && efforts[preview] ? efforts[preview] : committed;
  const ucOn = ultraOffered && ultracode;
  const look = ucOn || isUltraEffort(shown);
  // A paid speed waiting on its question (from a click in the row or from `/fast`).
  const [ask, setAsk] = useState<string | null>(null);

  const track = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);

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

  // The "ultra" moment: when it turns on by the user's hand, not when a view opens with it on.
  const [burst, setBurst] = useState(false);
  const wasLook = useRef(look);
  useEffect(() => {
    if (look === wasLook.current) return;
    wasLook.current = look;
    if (!look || reducedMotion()) return setBurst(false);
    setBurst(true);
    const t = window.setTimeout(() => setBurst(false), BURST_MS);
    return () => window.clearTimeout(t);
  }, [look]);

  const hasSpeed = speeds.length > 0 && !!onSpeed;
  if (!efforts.length && !ultraOffered && !hasSpeed) return null;

  const fast = hasSpeed && speed !== STANDARD_SPEED;
  const speedInfo = speeds.find((s) => s.id === speed);
  const name = shown ? effortName(shown) : 'Default';
  const aria = (efforts.length ? `Effort: ${name}${ucOn ? ', ultracode on' : ''}` : ultraOffered ? `Ultracode ${ucOn ? 'on' : 'off'}` : 'Speed') + (fast ? `, ${speedInfo?.name ?? 'fast'} speed${speedInfo?.paid ? ', billed as extra usage' : ''}` : '');
  const tip = (efforts.length ? (ucOn ? `Effort and ultracode` : 'Effort') : ultraOffered ? 'Ultracode' : 'Speed') + (fast && speedInfo?.paid ? ` · ${speedInfo.name} on extra usage` : '');
  // What the chip says, part by part (Chip.tsx): a part that stays keeps showing while the others
  // come and go, so turning ultracode on only adds its mark and the word never blinks. The chip
  // hugs its label and its right end (before the cove) holds, so the popover aligned to it stays put.
  const parts: ChipPart[] = [];
  if (efforts.length > 0) {
    if (fast) parts.push({ k: 'bolt', node: <Icon name="bolt" size={13} className="th-bolt" /> });
    if (look) parts.push({ k: 'mark', node: <UltraMark /> });
    parts.push({ k: 'dial', className: 'th-gauge', node: <Dial level={shown ? efforts.indexOf(shown) + 1 : 0} of={efforts.length} /> });
    parts.push({ k: `word:${shown ?? ''}`, className: 'th-word', node: name });
  } else parts.push(ultraOffered ? { k: 'uc', node: <UltraMark className="th-uc" /> } : { k: 'bolt', node: <Icon name="bolt" size={13} className="th-bolt" /> });
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <Tip label={tip} side="top">
        <RP.Trigger asChild>
          <Chip className="tb-chip th-chip" anchor="right" data-ultra={look || undefined} data-burst={burst || undefined} data-bare={!efforts.length || undefined} aria-label={aria} parts={parts} />
        </RP.Trigger>
      </Tip>
      <RP.Portal>
        <RP.Content
          className="pop cm-pop th-pop"
          data-spot
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={10}
          aria-label="Effort"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (track.current ?? (e.currentTarget as HTMLElement).querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {efforts.length > 0 && <Track efforts={efforts} level={committedLevel} onPreview={setPreview} onCommit={commit} onDone={() => setOpen(false)} trackRef={track} burst={burst && isUltraEffort(shown)} />}
                {efforts.length > 0 && ultraOffered && <div className="menu-sep th-sep" role="separator" />}
                {ultraOffered && (
                  <label className="th-uc-row" data-on={ucOn || undefined} data-burst={(burst && ucOn) || undefined}>
                    <UltraMark className="th-uc-mark" />
                    <span className="grow">Ultracode</span>
                    <Switch checked={ucOn} onChange={onUltracode} label="Ultracode" />
                  </label>
                )}
                {hasSpeed && (efforts.length > 0 || ultraOffered) && <div className="menu-sep th-sep" role="separator" />}
                {hasSpeed && <SpeedRow speeds={speeds} speed={speed} onSpeed={onSpeed!} sessionId={sessionId} ask={ask} onAsk={setAsk} />}
              </>
            )}
          </Later>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
});

/** The thinking control for the composer's choice, or a placeholder while the caps are on their way. */
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
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={74} /> : null;
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
    />
  );
});

const NO_EFFORTS: Effort[] = [];
const NO_SPEEDS: SpeedInfo[] = [];
