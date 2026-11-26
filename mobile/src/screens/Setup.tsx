import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { STANDARD_SPEED, type Effort, type ModeInfo, type ModeTone, type ProviderId } from '@shared/protocol';
import { effortName } from '@desk/lib/models';
import { haptic } from '@m/lib/native';
import { Icon, type IconName } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';
import { reduced } from '@m/ui/motion';
import { reel, ROLL_EASE, ROLL_MS } from '@desk/features/composer/reel';

/** The desktop's mode icons (icons/index.tsx MODE_ICON): Bypass is the fire, in red wherever it shows. */
export const MODE_ICON: Record<ModeTone, IconName> = { ask: 'hand', edit: 'edit', plan: 'compass', auto: 'ffwd', danger: 'fire' };

export interface SetupState {
  /** The chat's agent (its mark leads its models). */
  agent?: ProviderId;
  models: { id: string; name: string }[];
  model?: string;
  onModel: (id: string) => void;
  efforts: Effort[];
  effort?: Effort;
  onEffort: (e: Effort) => void;
  speeds: { id: string; name: string }[];
  speed?: string;
  onSpeed: (id: string) => void;
  modes: ModeInfo[];
  mode?: string;
  onMode: (id: string) => void;
  /**
   * In a chat: the other agents' models (null while they are asked for). Picking one switches the
   * chat to that agent in place; `othersOff` while the chat works (it switches between turns).
   */
  others?: { provider: ProviderId; models: { id: string; name: string }[] | null }[];
  onOther?: (provider: ProviderId, id: string) => void;
  othersOff?: boolean;
}

/**
 * The mode on the prompt bar (2.21, the owner: "lieber bypass in klein nur icon"): its icon alone on a
 * disc of one fill step, the desktop's mode chip at hand size; Bypass keeps its red icon. Its name is
 * the button's label and the sheet's. A new mode's icon comes in where the old one stood.
 */
export function ModeChip({ mode, open, onOpen }: { mode?: ModeInfo; open: boolean; onOpen: () => void }) {
  if (!mode) return null;
  return (
    <button
      type="button"
      className="mode-chip"
      data-tone={mode.tone}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`Permissions: ${mode.name}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => (e.stopPropagation(), haptic('tap'), onOpen())}
    >
      <span key={mode.tone} className="mode-chip-glyph">
        <Icon name={MODE_ICON[mode.tone] ?? 'hand'} size={19} className="mode-chip-icon" />
      </span>
    </button>
  );
}

/**
 * Model and effort as ONE phrase on the bar, the desktop's (2.21): "Opus 5.5 · Extra high", the level
 * a step quieter, always whole. Where the bar has no room for all of it the model's name and the dot
 * go and the level stays (the desktop's order of shedding); nothing is ever cut with an ellipsis.
 */
export function ModelPhrase({ model, effort, levels, open, onOpen }: { model?: string; effort?: string; levels?: string[]; open: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useShed(ref, `${model}|${effort}`);
  if (!model) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="phrase"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${model}${effort ? `, ${effort}` : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => (e.stopPropagation(), haptic('tap'), onOpen())}
    >
      <PhraseWords model={model} effort={effort} levels={levels} />
    </button>
  );
}

/**
 * The phrase's words, which change as the desktop's chip does (Chip.tsx, reel.ts): the layout takes the
 * new width at once and the phrase holds its right end; a new level rolls in the way it went (up from
 * below, down from above) while the old one rolls out, one line apart on one clock; the name and the dot
 * glide by the difference on that clock; a new model's name fades in where it stands while the old one
 * fades out where it stood. Transform and opacity only (WAAPI, the compositor's).
 */
export function PhraseWords({ model, effort, levels, anchor = 'right' }: { model: string; effort?: string; levels?: string[]; anchor?: 'left' | 'right' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<{ model: string; effort?: string; at: Map<string, number> } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = new Map<string, number>();
    const w = el.offsetWidth;
    for (const c of el.children) {
      const part = c as HTMLElement;
      const k = part.dataset.k;
      // each part's distance from the end that holds still (the bar's phrase holds its right end, the sheet's head its left)
      if (k && part.dataset.ghost === undefined) at.set(k, anchor === 'right' ? w - part.offsetLeft - part.offsetWidth : part.offsetLeft);
    }
    const p = prev.current;
    prev.current = { model, effort, at };
    if (!p || reduced() || (p.model === model && p.effort === effort)) return;
    const glide = { duration: ROLL_MS, easing: ROLL_EASE };
    const ghost = (k: string, text: string, cls: string) => {
      const g = document.createElement('span');
      g.className = `${cls} phrase-ghost`;
      g.dataset.ghost = '';
      g.textContent = text;
      if (anchor === 'right') g.style.right = `${p.at.get(k) ?? 0}px`;
      else g.style.left = `${p.at.get(k) ?? 0}px`;
      el.appendChild(g);
      return g;
    };
    for (const c of el.children) {
      const part = c as HTMLElement;
      const k = part.dataset.k;
      if (!k || part.dataset.ghost !== undefined) continue;
      const was = p.at.get(k);
      const now = at.get(k)!;
      if (was !== undefined && Math.abs(was - now) > 0.5) part.animate([{ transform: `translateX(${anchor === 'right' ? now - was : was - now}px)` }, { transform: 'none' }], glide);
    }
    if (p.effort !== effort && effort && p.effort) {
      const a = levels?.indexOf(p.effort) ?? -1;
      const b = levels?.indexOf(effort) ?? -1;
      const way: 1 | -1 = b >= a ? -1 : 1;
      const r = reel(way);
      el.querySelector<HTMLElement>(`[data-k="l:${CSS.escape(effort)}"]`)?.animate(r.in, glide);
      const g = ghost(`l:${p.effort}`, p.effort, 'phrase-level');
      g.animate(r.out, { ...glide, fill: 'forwards' }).finished.then(
        () => g.remove(),
        () => g.remove(),
      );
    }
    if (p.model !== model) {
      el.querySelector<HTMLElement>(`[data-k="m:${CSS.escape(model)}"]`)?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: 170, easing: 'ease-out' });
      const g = ghost(`m:${p.model}`, p.model, 'phrase-model');
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 60, easing: 'linear', fill: 'forwards' }).finished.then(
        () => g.remove(),
        () => g.remove(),
      );
    }
  }, [model, effort, levels, anchor]);
  return (
    <span className="phrase-words" ref={ref}>
      <span className="phrase-model" data-k={`m:${model}`} key={`m:${model}`}>
        {model}
      </span>
      {effort && (
        <>
          <span className="phrase-dot" data-k="dot" aria-hidden>
            ·
          </span>
          <span className="phrase-level" data-k={`l:${effort}`} key={`l:${effort}`}>
            {effort}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Sheds the phrase's name (and the dot) when the bar it stands in has no room for all of it, and
 * brings it back once there is: measured when its words change and when the bar's width does.
 */
function useShed(ref: React.RefObject<HTMLElement | null>, words: string) {
  const full = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const bar = el?.parentElement;
    if (!el || !bar) return;
    const check = () => {
      const cs = getComputedStyle(bar);
      const gap = parseFloat(cs.columnGap) || 0;
      const pad = (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.paddingLeft) || 0);
      // what the others take (a spacer that only fills the rest takes nothing; the pinned key is outside)
      let used = 0;
      let n = 0;
      for (const k of bar.children) {
        const kid = k as HTMLElement;
        if (kid.classList.contains('bar-gap') || getComputedStyle(kid).position === 'absolute') continue;
        n++;
        if (kid !== el) used += kid.offsetWidth;
      }
      const room = bar.clientWidth - pad - used - gap * Math.max(0, n - 1);
      if (!el.hasAttribute('data-shed')) {
        full.current = el.offsetWidth;
        if (full.current > room + 0.5) el.setAttribute('data-shed', '');
      } else if (full.current && full.current <= room + 0.5) el.removeAttribute('data-shed');
    };
    el.removeAttribute('data-shed');
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [ref, words]);
}

/**
 * The model panel (2.21), the desktop's panel at hand size, as one bottom sheet: at its head the phrase
 * the bar will say ("Demo Large · High"), which rolls as the level under the thumb changes; the models,
 * each led by its agent's mark with the check at the end of the one in use, the other agents' models
 * under their agent's name; a hairline; the speeds as one row of choices; and at the foot, where the
 * thumb rests, effort as ONE slider of the model's levels (dragged 1:1, a tick per stop, the level's
 * word riding over the thumb). Its rows never move under the finger: the speed row and the slider's row
 * are always there once shown (a model with one level keeps a quiet disabled track).
 */
export function ModelSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: SetupState }) {
  const shown = useRef({ speed: false });
  if (!open) shown.current = { speed: false };
  const hasSpeed = s.speeds.length > 1;
  const hasEffort = s.efforts.length > 1;
  if (open) shown.current.speed ||= hasSpeed;
  const speedRow = hasSpeed || shown.current.speed;
  const [preview, setPreview] = useState<string | null>(null);
  const name = s.models.find((m) => m.id === s.model)?.name;
  const levels = s.efforts.map((e) => effortName(e));
  const level = hasEffort ? (preview ?? (s.effort ? effortName(s.effort) : undefined)) : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Model"
      className="mp-sheet"
      title={
        name ? (
          <span className="mp-title" data-preview={preview ? '' : undefined}>
            <PhraseWords model={name} effort={level} levels={levels} anchor="left" />
          </span>
        ) : (
          <span className="mp-title">Model</span>
        )
      }
    >
      <div className="mp">
        <div className="mp-models" role="radiogroup" aria-label="Model">
          {s.models.length ? (
            s.models.map((m) => (
              <PanelRow key={m.id} mark={s.agent} on={m.id === s.model} onPick={() => s.onModel(m.id)}>
                {m.name}
              </PanelRow>
            ))
          ) : (
            <div className="mp-skel" aria-hidden>
              {[46, 38, 52].map((w) => (
                <span key={w} className="mp-row">
                  <span className="skel" style={{ width: 18, height: 18, borderRadius: 5 }} />
                  <span className="skel" style={{ width: `${w}%` }} />
                </span>
              ))}
            </div>
          )}
          {s.others?.map((o) => (
            <div key={o.provider} className="mp-away">
              <h4 className="mp-away-head">{PROVIDER_NAME[o.provider]}</h4>
              {o.models ? (
                o.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="mp-row"
                    aria-label={`Switch to ${PROVIDER_NAME[o.provider]} with ${m.name}`}
                    aria-disabled={s.othersOff || undefined}
                    onClick={() => {
                      if (s.othersOff) return void haptic('deny');
                      haptic('select');
                      s.onOther?.(o.provider, m.id);
                    }}
                  >
                    <ProviderMark provider={o.provider} size={18} />
                    <span className="mp-name">{m.name}</span>
                  </button>
                ))
              ) : (
                <span className="mp-row" aria-hidden>
                  <span className="skel" style={{ width: 18, height: 18, borderRadius: 5 }} />
                  <span className="skel" style={{ width: '40%' }} />
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="mp-foot">
          {speedRow && <Segmented label="Speed" options={hasSpeed ? s.speeds : [{ id: STANDARD_SPEED, name: 'Standard' }]} value={hasSpeed ? (s.speed ?? STANDARD_SPEED) : STANDARD_SPEED} onPick={s.onSpeed} />}
          {hasEffort ? <EffortSlider efforts={s.efforts} value={s.effort} onPick={s.onEffort} onPreview={setPreview} /> : <Slider label="Effort" stops={NO_STOPS} disabled onPick={() => {}} />}
        </div>
      </div>
    </Sheet>
  );
}

/** The quiet track of a model with one level or none: two stops with no names, nothing to drag. */
const NO_STOPS = [
  { id: 'a', name: '' },
  { id: 'b', name: '' },
];

/** What the agent may do without asking: a row per mode, its icon (Bypass in red), its name, the check at the end of the one in use. */
export function ModeSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: SetupState }) {
  return (
    <Sheet open={open} onClose={onClose} label="Permissions" title={<span className="mp-title">Permissions</span>}>
      <div className="mp">
        <div className="mp-models" role="radiogroup" aria-label="Permissions">
          {s.modes.map((m) => (
            <PanelRow
              key={m.id}
              icon={MODE_ICON[m.tone] ?? 'hand'}
              tone={m.tone}
              on={m.id === s.mode}
              onPick={() => {
                s.onMode(m.id);
                window.setTimeout(onClose, 160);
              }}
            >
              {m.name}
            </PanelRow>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** One choice of a list: 48 px, its mark or icon, its name, the check at its end when it is the one in use. */
function PanelRow({ on, onPick, mark, icon, tone, children }: { on: boolean; onPick: () => void; mark?: ProviderId; icon?: IconName; tone?: ModeTone; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="mp-row"
      data-on={on || undefined}
      data-tone={tone}
      onClick={() => {
        if (on) return;
        haptic('select');
        onPick();
      }}
    >
      {mark && <ProviderMark provider={mark} size={18} />}
      {icon && <Icon name={icon} size={19} className="mp-icon" />}
      <span className="mp-name">{children}</span>
      {on && <Icon name="check" size={17} weight="bold" className="mp-check" />}
    </button>
  );
}

/**
 * Effort: one slider of the model's levels. The thumb follows the finger 1:1 and the level under it is
 * named over the thumb, felt (a tick per stop) and handed to the sheet's head as it passes; letting go
 * settles on the nearest stop. A level let go of shows at once and stays until the chat confirms it (or
 * a few seconds), so the thumb never goes back to the old level while the desktop answers.
 */
function EffortSlider({ efforts, value, onPick, onPreview }: { efforts: Effort[]; value?: Effort; onPick: (e: Effort) => void; onPreview: (name: string | null) => void }) {
  const [held, setHeld] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!held) return;
    if (held.id === value) return setHeld(null);
    const t = window.setTimeout(() => setHeld(null), 4000);
    return () => clearTimeout(t);
  }, [held, value]);
  // The head names the level let go of until the chat has it (or the hold lapses): then it reads the chat's own.
  useEffect(() => {
    if (!held) onPreview(null);
  }, [held, onPreview]);
  const shown = (held?.id ?? value) as Effort | undefined;
  const stops = efforts.map((e) => ({ id: e, name: effortName(e) }));
  return (
    <Slider
      label="Effort"
      stops={stops}
      value={shown}
      onPreview={(id) => onPreview(id ? effortName(id as Effort) : null)}
      onPick={(id) => {
        setHeld({ id, at: Date.now() });
        onPick(id as Effort);
      }}
    />
  );
}

/**
 * A level among a few in order (the desktop's `Slider` with stops): a thin track with a tick per stop,
 * filled to the thumb with a dithered head, the level's word riding over the thumb. Dragged 1:1 (no
 * easing under the finger); let go, the thumb, the fill and the word settle on the nearest stop on one
 * clock (one animated number, `--u`, 140 ms). `disabled`: the quiet track of a model with one level.
 */
export function Slider({ label, stops, value, onPick, onPreview, disabled }: { label: string; stops: { id: string; name: string }[]; value?: string; onPick: (id: string) => void; onPreview?: (id: string | null) => void; disabled?: boolean }) {
  const at = Math.max(0, stops.findIndex((o) => o.id === value));
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const last = useRef(at);
  const dragging = useRef<number | null>(null);
  const n = stops.length;
  const pos = disabled ? 0 : (drag ?? at / Math.max(1, n - 1));
  useLayoutEffect(() => {
    last.current = at;
  }, [at]);
  const read = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  const near = (u: number) => Math.round(u * (n - 1));
  const move = (u: number) => {
    dragging.current = u;
    setDrag(u);
    const i = near(u);
    if (i !== last.current) {
      last.current = i;
      haptic('select');
    }
    onPreview?.(stops[i]?.id ?? null);
  };
  const end = (u: number | null) => {
    dragging.current = null;
    setDrag(null);
    const i = u === null ? -1 : near(u);
    const pick = stops[i] && stops[i].id !== value ? stops[i].id : null;
    // A level let go of stays named (the sheet's head) until the chat has it; nothing picked, the preview ends.
    onPreview?.(pick);
    if (pick) onPick(pick);
  };
  const shownAt = drag !== null ? near(drag) : at;
  return (
    <div
      className="slider no-drag"
      role="slider"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={at}
      aria-valuetext={stops[at]?.name}
      tabIndex={disabled ? -1 : 0}
      data-drag={drag !== null || undefined}
      data-off={disabled || undefined}
      style={{ '--u': pos } as CSSProperties}
      onKeyDown={(e) => {
        if (disabled) return;
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = Math.min(n - 1, Math.max(0, at + d));
        if (i !== at) onPick(stops[i].id);
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        move(read(e.clientX));
      }}
      onPointerMove={(e) => dragging.current !== null && move(read(e.clientX))}
      onPointerUp={(e) => dragging.current !== null && end(read(e.clientX))}
      // The system took the touch (a gesture of its own): the level under the finger is kept, not the old one.
      onPointerCancel={() => dragging.current !== null && end(dragging.current)}
      onLostPointerCapture={() => dragging.current !== null && end(dragging.current)}
    >
      <div className="slider-track" ref={track}>
        {!disabled && (
          <span className="slider-word" aria-hidden>
            {stops[shownAt]?.name}
          </span>
        )}
        <span className="slider-fill" />
        {stops.map((o, i) => (
          <i key={o.id} className="slider-stop" data-on={(!disabled && i <= shownAt) || undefined} style={{ left: `${(i / Math.max(1, n - 1)) * 100}%` }} />
        ))}
        {!disabled && <span className="slider-thumb" />}
      </div>
    </div>
  );
}

/** A few named options with one chosen: the choice is a flat pill that slides to the one you pick. */
export function Segmented({ label, options, value, onPick }: { label: string; options: { id: string; name: string }[]; value?: string; onPick: (id: string) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div className="seg no-drag" role="radiogroup" aria-label={label} style={{ '--n': options.length, '--i': i } as CSSProperties}>
      {value !== undefined && <span className="seg-thumb" aria-hidden />}
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          className="seg-opt"
          data-on={o.id === value || undefined}
          onClick={() => {
            if (o.id === value) return;
            haptic('select');
            onPick(o.id);
          }}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}
