import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { STANDARD_SPEED, type Effort, type ModeInfo, type ModeTone, type ProviderId } from '@shared/protocol';
import { effortName } from '@desk/lib/models';
import { haptic } from '@m/lib/native';
import { Icon, type IconName } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';

export const MODE_ICON: Record<ModeTone, IconName> = { ask: 'hand', edit: 'edit', plan: 'plan', auto: 'bolt', danger: 'shield' };

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
 * The mode on the prompt bar (2.18, its own chip again, as on the desktop): its icon and its word, bare
 * until held or its sheet is open; Bypass keeps its red icon. A narrow bar keeps the icon alone.
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
      <Icon name={MODE_ICON[mode.tone] ?? 'hand'} size={17} className="mode-chip-icon" />
      <span className="mode-chip-name">{mode.name}</span>
    </button>
  );
}

/** Model and effort as one phrase on the bar (the desktop's): "Demo Large · High", the level a step quieter. */
export function ModelPhrase({ model, effort, open, onOpen }: { model?: string; effort?: string; open: boolean; onOpen: () => void }) {
  if (!model) return null;
  return (
    <button
      type="button"
      className="phrase"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${model}${effort ? `, ${effort}` : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => (e.stopPropagation(), haptic('tap'), onOpen())}
    >
      <span className="phrase-model">{model}</span>
      {effort && (
        <>
          <span className="phrase-dot" aria-hidden>
            ·
          </span>
          <span className="phrase-level">{effort}</span>
        </>
      )}
    </button>
  );
}

/**
 * The model panel, as the desktop's (2.18; the sheet of radio cards it replaces read as cheap): the
 * models first, each led by its agent's mark with the check at the end of the one in use, the other
 * agents' models under their agent's name; then the speeds as one row of choices; and at the foot,
 * where the thumb rests, effort as ONE slider of the model's levels, its name over it. The sheet keeps
 * its height while it is open: a model without speeds keeps the row (Standard alone), so nothing under
 * the finger moves when a model is picked.
 */
export function ModelSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: SetupState }) {
  const shown = useRef({ speed: false, effort: false });
  if (!open) shown.current = { speed: false, effort: false };
  const hasSpeed = s.speeds.length > 1;
  const hasEffort = s.efforts.length > 1;
  if (open) {
    shown.current.speed ||= hasSpeed;
    shown.current.effort ||= hasEffort;
  }
  const speedRow = hasSpeed || shown.current.speed;
  const effortRow = hasEffort || shown.current.effort;
  return (
    <Sheet open={open} onClose={onClose} label="Model">
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
                  <span className="skel" style={{ width: 16, height: 16, borderRadius: 4 }} />
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
                    <ProviderMark provider={o.provider} size={16} />
                    <span className="mp-name">{m.name}</span>
                  </button>
                ))
              ) : (
                <span className="mp-row" aria-hidden>
                  <span className="skel" style={{ width: 16, height: 16, borderRadius: 4 }} />
                  <span className="skel" style={{ width: '40%' }} />
                </span>
              )}
            </div>
          ))}
        </div>
        {(speedRow || effortRow) && (
          <div className="mp-foot">
            {speedRow && <Segmented label="Speed" options={hasSpeed ? s.speeds : [{ id: STANDARD_SPEED, name: 'Standard' }]} value={hasSpeed ? (s.speed ?? STANDARD_SPEED) : STANDARD_SPEED} onPick={s.onSpeed} />}
            {effortRow && (hasEffort ? <EffortSlider efforts={s.efforts} value={s.effort} onPick={s.onEffort} /> : <p className="mp-fixed">This model has one effort level.</p>)}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** What the agent may do without asking: a row per mode, its icon, its name, the check at the end of the one in use. */
export function ModeSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: SetupState }) {
  return (
    <Sheet open={open} onClose={onClose} label="Permissions">
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
      {mark && <ProviderMark provider={mark} size={16} />}
      {icon && <Icon name={icon} size={18} className="mp-icon" />}
      <span className="mp-name">{children}</span>
      {on && <Icon name="check" size={16} weight="bold" className="mp-check" />}
    </button>
  );
}

/**
 * Effort: one slider of the model's levels, the level's name over it. The thumb follows the finger
 * 1:1 and the level under it is named and felt (a tick per stop) as it passes; letting go settles on
 * the nearest stop. A level let go of shows at once and stays until the chat confirms it (or a few
 * seconds), so the thumb never goes back to the old level while the desktop answers.
 */
function EffortSlider({ efforts, value, onPick }: { efforts: Effort[]; value?: Effort; onPick: (e: Effort) => void }) {
  const [held, setHeld] = useState<{ id: string; at: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!held) return;
    if (held.id === value) return setHeld(null);
    const t = window.setTimeout(() => setHeld(null), 4000);
    return () => clearTimeout(t);
  }, [held, value]);
  const shown = (held?.id ?? value) as Effort | undefined;
  const live = (preview ?? shown) as Effort | undefined;
  const stops = efforts.map((e) => ({ id: e, name: effortName(e) }));
  return (
    <div className="mp-effort">
      <div className="mp-level" aria-hidden>
        {live ? effortName(live) : 'Effort'}
      </div>
      <Slider
        label="Effort"
        stops={stops}
        value={shown}
        onPreview={setPreview}
        onPick={(id) => {
          setHeld({ id, at: Date.now() });
          onPick(id as Effort);
        }}
      />
    </div>
  );
}

/**
 * A level among a few in order: a thin track with a dot per stop, filled to the thumb with a dithered
 * head; the thumb follows the finger 1:1 (no easing while dragged) and settles on the nearest stop.
 */
export function Slider({ label, stops, value, onPick, onPreview }: { label: string; stops: { id: string; name: string }[]; value?: string; onPick: (id: string) => void; onPreview?: (id: string | null) => void }) {
  const at = Math.max(0, stops.findIndex((o) => o.id === value));
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const last = useRef(at);
  const dragging = useRef<number | null>(null);
  const n = stops.length;
  const pos = drag ?? at / Math.max(1, n - 1);
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
    onPreview?.(null);
    if (u === null) return;
    const i = near(u);
    if (stops[i] && stops[i].id !== value) onPick(stops[i].id);
  };
  const shownAt = drag !== null ? near(drag) : at;
  return (
    <div
      className="slider no-drag"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={at}
      aria-valuetext={stops[at]?.name}
      tabIndex={0}
      data-drag={drag !== null || undefined}
      style={{ '--u': pos } as CSSProperties}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = Math.min(n - 1, Math.max(0, at + d));
        if (i !== at) onPick(stops[i].id);
      }}
      onPointerDown={(e) => {
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
        <span className="slider-fill" />
        {stops.map((o, i) => (
          <i key={o.id} className="slider-stop" data-on={i <= shownAt || undefined} style={{ left: `${(i / Math.max(1, n - 1)) * 100}%` }} />
        ))}
        <span className="slider-thumb" />
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
