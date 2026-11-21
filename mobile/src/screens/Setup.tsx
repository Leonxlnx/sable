import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STANDARD_SPEED, type Effort, type ModeInfo, type ModeTone, type ProviderId } from '@shared/protocol';
import { effortName } from '@desk/lib/models';
import { haptic } from '@m/lib/native';
import { Icon, type IconName } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { AutoHeight } from '@m/ui/AutoHeight';
import { Sheet } from '@m/ui/Sheet';

export const MODE_ICON: Record<ModeTone, IconName> = { ask: 'hand', edit: 'edit', plan: 'plan', auto: 'bolt', danger: 'shield' };

export interface SetupState {
  /** The chat's agent (its mark heads the models). */
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
 * How the agent works, in one sheet: the model, how hard it thinks (a dial with a stop per level,
 * each named under it), how fast it runs, and what it may do without asking. Every choice applies at
 * once; nothing here explains itself (people know their models).
 */
export function SetupSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: SetupState }) {
  return (
    <Sheet open={open} onClose={onClose} label="Model and permissions">
      <div className="setup">
        <section className="setup-sec">
          <h3 className="setup-head">
            {s.agent && <ProviderMark provider={s.agent} size={13} />}
            <span>{s.agent ? PROVIDER_NAME[s.agent] : 'Model'}</span>
          </h3>
          {s.models.length ? (
            <div className="setup-list" role="radiogroup" aria-label="Model">
              {s.models.map((m) => (
                <Row key={m.id} on={m.id === s.model} onPick={() => s.onModel(m.id)}>
                  {m.name}
                </Row>
              ))}
            </div>
          ) : (
            <div className="setup-list setup-skel" aria-hidden>
              <span className="skel" style={{ width: '46%' }} />
              <span className="skel" style={{ width: '38%' }} />
              <span className="skel" style={{ width: '52%' }} />
            </div>
          )}
          {s.others?.map((o) => (
            <div key={o.provider} className="setup-away">
              <h4 className="setup-head setup-away-head">
                <ProviderMark provider={o.provider} size={13} />
                <span>{PROVIDER_NAME[o.provider]}</span>
              </h4>
              <AutoHeight className="setup-list">
                <AnimatePresence initial={false} mode="popLayout">
                  {o.models ? (
                    <motion.div key="rows" className="setup-away-rows" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
                      {o.models.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="setup-row setup-row-away"
                          aria-label={`Switch to ${PROVIDER_NAME[o.provider]} with ${m.name}`}
                          aria-disabled={s.othersOff || undefined}
                          onClick={() => {
                            if (s.othersOff) return void haptic('deny');
                            haptic('select');
                            s.onOther?.(o.provider, m.id);
                          }}
                        >
                          <span className="setup-row-name">{m.name}</span>
                          <Icon name="arrowRight" size={16} className="setup-away-go" />
                        </button>
                      ))}
                    </motion.div>
                  ) : (
                    <motion.div key="skel" className="setup-away-rows setup-away-skel" aria-hidden exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
                      <span className="setup-row">
                        <span className="skel" style={{ width: '34%' }} />
                      </span>
                      <span className="setup-row">
                        <span className="skel" style={{ width: '46%' }} />
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </AutoHeight>
            </div>
          ))}
        </section>

        {s.efforts.length > 1 && <EffortSection efforts={s.efforts} value={s.effort} onPick={s.onEffort} />}

        {s.speeds.length > 1 && (
          <section className="setup-sec">
            <h3 className="setup-head">Speed</h3>
            <Segmented label="Speed" options={s.speeds} value={s.speed ?? STANDARD_SPEED} onPick={s.onSpeed} />
          </section>
        )}

        {s.modes.length > 0 && (
          <section className="setup-sec">
            <h3 className="setup-head">Permissions</h3>
            <div className="setup-list" role="radiogroup" aria-label="Permissions">
              {s.modes.map((m) => (
                <Row key={m.id} on={m.id === s.mode} onPick={() => s.onMode(m.id)} icon={MODE_ICON[m.tone] ?? 'hand'} tone={m.tone}>
                  {m.name}
                </Row>
              ))}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}

/** One choice of a few: a 52 px row, the chosen one bright with a filled mark. */
function Row({ on, onPick, icon, tone, children }: { on: boolean; onPick: () => void; icon?: IconName; tone?: ModeTone; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="setup-row"
      data-on={on || undefined}
      data-tone={tone}
      onClick={() => {
        if (on) return;
        haptic('select');
        onPick();
      }}
    >
      {icon && <Icon name={icon} size={20} className="setup-row-icon" />}
      <span className="setup-row-name">{children}</span>
      <span className="setup-radio" aria-hidden>
        <i />
      </span>
    </button>
  );
}

/**
 * Effort: the dial and the name of the level, which follows the finger. A level let go of shows at
 * once and stays until the chat confirms it (or for a few seconds), so the knob never goes back to the
 * old level while the desktop answers.
 */
function EffortSection({ efforts, value, onPick }: { efforts: Effort[]; value?: Effort; onPick: (e: Effort) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [held, setHeld] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!held) return;
    if (held.id === value) return setHeld(null);
    const t = window.setTimeout(() => setHeld(null), 4000);
    return () => clearTimeout(t);
  }, [held, value]);
  const shown = (held?.id ?? value) as Effort | undefined;
  const live = (preview ?? shown) as Effort | undefined;
  const stops = efforts.map((e) => ({ id: e, name: effortName(e) }));
  const named = stops.length <= 5;
  return (
    <section className="setup-sec">
      <h3 className="setup-head">
        <span>Effort</span>
        {!named && <span className="setup-value">{live ? effortName(live) : ''}</span>}
      </h3>
      <Dial
        label="Effort"
        stops={stops}
        value={shown}
        named={named}
        onPreview={setPreview}
        onPick={(id) => {
          setHeld({ id, at: Date.now() });
          onPick(id as Effort);
        }}
      />
    </section>
  );
}

/**
 * A level among a few in order (effort): a track with a stop per level, filled up to the chosen
 * one, its knob following the finger and settling on the nearest stop with a tick per stop passed.
 * The level under the finger is reported as it moves (`onPreview`); letting go (or the system taking
 * the touch) picks the nearest stop, never the old one.
 */
export function Dial({
  label,
  stops,
  value,
  named = false,
  onPick,
  onPreview,
}: {
  label: string;
  stops: { id: string; name: string }[];
  value?: string;
  named?: boolean;
  onPick: (id: string) => void;
  onPreview?: (id: string | null) => void;
}) {
  const at = Math.max(0, stops.findIndex((o) => o.id === value));
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const last = useRef(at);
  const dragging = useRef<number | null>(null);
  const n = stops.length;
  const pos = drag ?? at / (n - 1);
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
      className="dial no-drag"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={at}
      aria-valuetext={stops[at]?.name}
      tabIndex={0}
      data-drag={drag !== null || undefined}
      data-named={named || undefined}
      style={{ '--u': pos, '--n': n } as React.CSSProperties}
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
      <div className="dial-track" ref={track}>
        <span className="dial-fill" />
        {stops.map((o, i) => (
          <i key={o.id} className="dial-stop" data-on={i <= shownAt || undefined} style={{ left: `${(i / (n - 1)) * 100}%` }} />
        ))}
        <span className="dial-knob" />
      </div>
      {named ? (
        <div className="dial-names" aria-hidden>
          {stops.map((o, i) => (
            <span key={o.id} data-on={i === shownAt || undefined} style={{ left: `${(i / (n - 1)) * 100}%` }} data-end={i === 0 ? 'start' : i === n - 1 ? 'end' : undefined}>
              {o.name}
            </span>
          ))}
        </div>
      ) : (
        <div className="dial-ends" aria-hidden>
          <span>{stops[0]?.name}</span>
          <span>{stops[n - 1]?.name}</span>
        </div>
      )}
    </div>
  );
}

/** A few named options with one chosen: the choice is a solid pill that slides to the one you pick. */
export function Segmented({ label, options, value, onPick }: { label: string; options: { id: string; name: string }[]; value?: string; onPick: (id: string) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div className="seg no-drag" role="radiogroup" aria-label={label} style={{ '--n': options.length, '--i': i } as React.CSSProperties}>
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
