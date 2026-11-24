import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { STANDARD_SPEED, type Effort, type ModelInfo, type ProviderId, type SpeedInfo } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { fuzzy } from '@/lib/fuzzy';
import { isMac } from '@/lib/format';
import { effortName, modelName } from '@/lib/models';
import { EASE_OUT, play } from '@/lib/motion';
import { setEffort as setSessionEffort, switchAgent } from '@/state/actions';
import { refreshStaleCaps, useStore } from '@/state/store';
import { movedByKeys, pickedByKey } from '@/ui/glide';
import { Tip } from '@/ui';
import { aimsAt, AIM_WAIT_MS, type Pt } from './aim';
import { Chip, type ChipPart, type ChipProps } from './Chip';
import { remember, rememberedEffort, type Choice } from './choice';
import { ChipSkeleton, Hits, MENU_PAD, ROW_H, useMenuPlace, useOtherAgentModels, useReleaseGuard } from './Controls';
import { altGraph, chordKeys, landLevel, landUltra, stepStop, type Setting } from './effort-track';
import { Later } from './later';
import { askLine, confirmPaid, paidConfirmed, takePaidAsk } from './paid-speed';
import { digitLevel, filterTextKey, navigate, panelRows, returnsToTrigger, triggerKey, type Col, type Shape } from './panel-nav';

/**
 * Model and effort: one phrase on the bar, one panel at the phrase.
 *
 * At rest the bar says what the next message runs on, in words: "Opus 5.5 · Extra high", the
 * model, a middle dot, the level a step quieter. It is one chip (the bar's skin and states) that
 * reads tight at every level ("Demo Large · High": one gap each side of the dot) and holds its
 * right end, so it always ends the same distance from the key. Its width follows its words: a new
 * level rolls in by the way it went, like a reel, and what stands left of the word (the dot, the
 * model's name, the ultracode chip) glides by the difference on the reel's clock (Chip.tsx).
 * - One level up or down opens nothing: Up and Down on the focused phrase, Alt+Right and Alt+Left
 *   from the field (Composer.tsx, `levelChord`). The scale ends at its top level and stays there:
 *   the ends hold and the word nudges.
 * - Ultracode is no level. It is a switch of its own beside the phrase (Ultracode.tsx `UltraChip`)
 *   and a switch row in the panel: on or off at any level, and the phrase goes on naming the model
 *   and the level whatever it does (effort-track.ts).
 * - A click (or Enter, or Ctrl+.) opens the panel 8 px off the phrase and flush with its right end
 *   in every frame (it hangs from that end, which a level pointed at never moves): the models on the
 *   left, the levels on the right as a scale (the highest on top), both standing on the line
 *   nearest the phrase, and the switches (ultracode, the speeds) across the whole width at the far
 *   end. The left column drives the right one: resting on a model makes the scale show that
 *   model's own levels and the level it would come back at (an outlined thumb, nothing picked
 *   yet), so a click on the model picks it at the level shown and a click on a level picks that
 *   model at that level. Pointing at a level of the model in use shows its name on the bar a step
 *   dimmer before the click.
 * - The panel keeps the size it opened with (panel-nav.ts `panelRows`): turning to another agent or
 *   resting on another model never moves a row, and a shorter column stands on the same line.
 * - The row in use reads the same in every menu of the bar: ivory, with the check at its end (the
 *   level in use has the scale's thumb for its mark).
 */

export interface PhraseHandle {
  /** One level up or down, the chord from the field. */
  step: (dir: 1 | -1) => void;
  /** Opens the panel with focus on the model in use, the level in use, or a paid speed's question. */
  open: (on: 'model' | 'level' | 'speed') => void;
  /** Ctrl+.: opens the panel on the model in use, or closes it. */
  toggle: () => void;
}

interface Props {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
  ultraOffered: boolean;
  ultracode: boolean;
  onUltracode: (on: boolean) => void;
}

/** A switch's look, for a row that is the switch (the whole row is the target). */
const SwitchLook = ({ on }: { on: boolean }) => (
  <span className="switch mx-switch" data-state={on ? 'checked' : 'unchecked'} aria-hidden>
    <span className="switch-thumb" />
  </span>
);

const NO_EFFORTS: Effort[] = [];
/** The panel's width: its two columns, the gap between them and its padding (composer.css `.mx`, 152 + 4 + 124 + 8). */
export const PANEL_W = 288;
const keyOf = (p: ProviderId, id: string) => `${p}\u0001${id}`;

// RM.Trigger composes our handler with its own ArrowDown/Enter/Space handler. Gate that whole
// handler at the button so modified keys still bubble to their owner with their default intact.
const PhraseTrigger = forwardRef<HTMLButtonElement, ChipProps>(function PhraseTrigger({ onKeyDown, ...props }, ref) {
  return <Chip {...props} ref={ref} onKeyDown={(e) => {
    if (!e.defaultPrevented && !e.nativeEvent.isComposing && e.keyCode !== 229 && triggerKey(e)) onKeyDown?.(e);
  }} />;
});

/** The phrase, or a quiet placeholder while nothing is known of the agent yet. */
export const ModelEffort = memo(
  forwardRef<PhraseHandle, Props>(function ModelEffort(props, ref) {
    const late = useRef(false);
    const { choice } = props;
    if (!choice.caps) late.current = true;
    if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={150} /> : null;
    if (!choice.caps.models.length && !props.ultraOffered && !choice.speeds.length) return null;
    return <Phrase ref={ref} {...props} late={late.current} />;
  }),
);

const Phrase = forwardRef<PhraseHandle, Props & { late: boolean }>(function Phrase({ choice, side, onClosed, ultraOffered, ultracode, onUltracode, late }, ref) {
  const [open, setOpen] = useState(false);
  // What the panel opens on: the level in use for a click, the model in use for the keys.
  const want = useRef<'model' | 'level'>('level');
  // A paid speed waiting on its question (from a click on its row, or `/fast`).
  const [ask, setAsk] = useState<string | null>(null);
  // A level sent and not yet confirmed, so nothing waits on a round trip.
  const [local, setLocal] = useState<Effort | undefined>();
  // The level pointed at in the panel, shown on the bar a step dimmer before the click.
  const [pointed, setPreview] = useState<Effort | null>(null);
  const settleTimer = useRef(0);
  const chip = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const scaleCol = useRef<HTMLDivElement>(null);
  const guard = useReleaseGuard(open);

  // Only while the panel is open: a closing panel still under the pointer can take focus once more.
  const preview = open ? pointed : null;
  const efforts = choice.model?.efforts ?? NO_EFFORTS;
  const committed = local && efforts.includes(local) ? local : choice.effort;
  // Ultracode is a switch of its own: it never changes what the phrase names.
  const ucOn = ultraOffered && ultracode;
  const now: Setting = { level: committed ? efforts.indexOf(committed) : -1, ultra: ucOn };
  const shownLevel = preview ?? committed;
  // A model with levels and none set (the agent decides): "Default", as the agent's own picker says.
  const word = shownLevel ? effortName(shownLevel) : efforts.length ? 'Default' : undefined;
  const name = choice.modelLabel ?? 'Model';

  // A step by key rolls the word the way it went; anything else changes it in place.
  const stepped = useRef<0 | 1 | -1>(0);
  const roll = stepped.current > 0 ? 'up' : stepped.current < 0 ? 'down' : undefined;
  useLayoutEffect(() => {
    stepped.current = 0;
  });

  useEffect(() => {
    if (local && choice.effort === local) setLocal(undefined);
  }, [choice.effort, local]);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const setEffort = choice.setEffort;
  const commit = useCallback(
    (i: number) => {
      const e = efforts[i];
      if (!e) return;
      setLocal(e);
      setEffort(e);
      // Never confirmed (the agent refused it): show what is really in use again.
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setLocal(undefined), 4000);
    },
    [efforts, setEffort],
  );

  /** Lands on a level of the model in use: sends it when it is another one. Ultracode stays as it is. */
  const go = (to: number) => {
    const out = landLevel(now, to, efforts.length);
    if (out.level !== undefined) commit(out.level);
  };

  const nudge = (dir: 1 | -1) => {
    const w = chip.current?.querySelector('.ph-word:not(.chip-ghost)');
    play(w, [{ transform: 'translateY(0px)' }, { transform: `translateY(${-dir * 2}px)`, offset: 0.3 }, { transform: 'translateY(0px)' }], { duration: 260, easing: EASE_OUT });
  };

  const step = (dir: 1 | -1) => {
    const to = stepStop(now.level, dir, efforts.length);
    if (to === null) return nudge(dir);
    stepped.current = dir;
    go(to);
  };

  // Escape can return to the phrase. A pick hands focus to the composer before its exit animation.
  const openedBy = useRef<'keys' | 'pointer' | 'field'>('pointer');
  const escaped = useRef(false);
  const close = () => {
    setOpen(false);
    if (returnsToTrigger(openedBy.current, escaped.current)) chip.current?.focus({ preventScroll: true });
    else onClosed();
  };

  const openOn = (on: 'model' | 'level' | 'speed') => {
    if (on === 'speed') setAsk(takePaidAsk(choice.sessionId) ?? null);
    if (open) return;
    want.current = on === 'model' ? 'model' : 'level';
    openedBy.current = 'field';
    setOpen(true);
  };
  const toggle = () => (open ? close() : openOn('model'));
  const latest = useRef({ step, openOn, toggle });
  latest.current = { step, openOn, toggle };
  useImperativeHandle(ref, () => ({ step: (d) => latest.current.step(d), open: (w) => latest.current.openOn(w), toggle: () => latest.current.toggle() }), []);

  // ── the panel ──

  const others = useOtherAgentModels(choice, open);
  const agents = useMemo(() => [choice.provider, ...others.map((o) => o.provider).filter((p, i, all) => all.indexOf(p) === i)], [choice.provider, others]);
  const speeds = choice.speeds;
  const toggles = (ultraOffered ? 1 : 0) + speeds.length;
  // Fixed when it opens (panel-nav.ts): the longest column of any agent listed, or the longest scale.
  const rowsNow = panelRows(
    agents.map((p) => ({ models: p === choice.provider ? choice.models.length : others.filter((o) => o.provider === p).length })),
    [...choice.models, ...others.map((o) => o.m)].map((m) => m.efforts?.length ?? 0),
  );
  const frozen = useRef(rowsNow);
  const wasOpen = useRef(false);
  // The panel hangs from the phrase's right end (Radix `align="end"`), which holds whatever the
  // phrase says: a level pointed at changes the phrase's width at its left, never where the panel
  // stands, so no row ever moves under the pointer.
  if (open && !wasOpen.current) {
    frozen.current = rowsNow;
    escaped.current = false;
  }
  wasOpen.current = open;
  const rows = open ? frozen.current : rowsNow;
  const need = MENU_PAD + rows * ROW_H + (toggles ? 8 + toggles * ROW_H : 0);
  const place = useMenuPlace(chip, open, side, need);

  const [tab, setTab] = useState<ProviderId>(choice.provider);
  const [query, setQuery] = useState('');
  // The model whose levels the scale shows (null: the model in use), and the column focus is in.
  const [owner, setOwner] = useState<{ p: ProviderId; id: string } | null>(null);
  const [focusCol, setFocusCol] = useState<Col | null>(null);
  const aimTimer = useRef(0);
  const last = useRef<Pt | null>(null);
  useEffect(() => {
    if (open) return;
    window.clearTimeout(aimTimer.current);
    setQuery('');
    setTab(choice.provider);
    setOwner(null);
    setFocusCol(null);
    setPreview(null);
    setAsk(null);
  }, [open, choice.provider]);
  useEffect(() => () => window.clearTimeout(aimTimer.current), []);

  // An hour-old list is asked for again while the panel is open (new models appear without a restart).
  useEffect(() => {
    if (!open) return;
    const s = useStore.getState();
    const meta = choice.provider === s.ui.homeProvider && !s.ui.activeSessionId ? undefined : s.sessions[s.ui.activeSessionId ?? ''];
    refreshStaleCaps(choice.provider, meta ? meta.cwd : s.ui.homeCwd, choice.accountId);
  }, [open, choice.provider, choice.accountId]);
  // The chat switches agents only between turns.
  const busy = useStore((s) => {
    const st = choice.sessionId ? s.sessions[choice.sessionId]?.status : undefined;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });

  const shown = agents.includes(tab) ? tab : choice.provider;
  const q = query.trim();
  const own = choice.models.map((m) => {
    const n = modelName(m) ?? m.id;
    return { provider: choice.provider, m, name: n, hit: q ? fuzzy(q, n) : undefined };
  });
  const away = others.map((o) => {
    const n = modelName(o.m) ?? o.m.id;
    return { ...o, name: n, hit: q ? fuzzy(q, n) : undefined };
  });
  // A filter looks through every agent's models, the chat's own first; else one agent's list.
  const list = q ? [...own, ...away].filter((r) => r.hit) : shown === choice.provider ? own : away.filter((r) => r.provider === shown);
  const agentRows = !q && agents.length > 1 ? agents.filter((p) => p !== shown) : [];

  const ownerKey = owner ?? { p: choice.provider, id: choice.modelId ?? '' };
  const ownerModel: ModelInfo | undefined = ownerKey.p === choice.provider ? (choice.models.find((m) => m.id === ownerKey.id) ?? choice.model) : others.find((o) => o.provider === ownerKey.p && o.m.id === ownerKey.id)?.m;
  const isCurrent = ownerKey.p === choice.provider && ownerKey.id === choice.modelId;
  const levels = ownerModel?.efforts ?? NO_EFFORTS;
  /** The level a model comes back at: the one last used with it, else the one in use where it fits, else its default (choice.ts `pickModel`). */
  const levelFor = (p: ProviderId, m: ModelInfo): Effort | undefined => {
    const fits = (e: Effort | undefined) => (e && m.efforts?.includes(e) ? e : undefined);
    return rememberedEffort(p, m) ?? (p === choice.provider ? fits(choice.effort) : undefined) ?? m.defaultEffort;
  };
  // The thumb: the level in use, solid; for any other model the level it would come back at, outlined.
  const thumbAt = isCurrent ? committed : ownerModel ? levelFor(ownerKey.p, ownerModel) : undefined;
  const thumbIdx = thumbAt ? levels.indexOf(thumbAt) : -1;

  const setOwnerIf = (k: { p: ProviderId; id: string }) => setOwner((o) => (o && o.p === k.p && o.id === k.id ? o : k));

  const pickModelRow = (p: ProviderId, m: ModelInfo) => {
    if (p === choice.provider) return choice.pickModel(m.id);
    // Another agent's model switches the chat to that agent, in place (never while a turn runs).
    const sid = choice.sessionId;
    if (busy || !sid) return;
    const e = levelFor(p, m);
    void switchAgent(sid, p, m.id).then((ok) => {
      if (ok && e) void setSessionEffort(sid, e);
    });
  };
  const pickLevel = (e: Effort) => {
    if (isCurrent) return go(efforts.indexOf(e));
    // That model at that level. Ultracode stays as it is: it belongs to no level.
    if (ownerKey.p === choice.provider) return choice.pickModel(ownerKey.id, e);
    const sid = choice.sessionId;
    if (busy || !sid) return;
    remember(ownerKey.p, ownerKey.id, e);
    void switchAgent(sid, ownerKey.p, ownerKey.id).then((ok) => {
      if (ok) void setSessionEffort(sid, e);
    });
  };
  const pickSpeed = (s: SpeedInfo, ev: Event) => {
    // A switch: the panel stays.
    ev.preventDefault();
    const next = choice.speed === s.id ? STANDARD_SPEED : s.id;
    // A speed billed outside the plan is asked for once per session, in its own row.
    if (next !== STANDARD_SPEED && s.paid && choice.sessionId && !paidConfirmed(choice.sessionId)) return setAsk(s.id);
    choice.setSpeed(next);
  };
  const confirmAsk = (id: string) => {
    if (choice.sessionId) confirmPaid(choice.sessionId);
    setAsk(null);
    choice.setSpeed(id);
    requestAnimationFrame(() => content.current?.querySelector<HTMLElement>(`[data-speed="${id}"]`)?.focus({ preventScroll: true }));
  };
  // The question takes the focus as it comes (the row it replaces had it, or the panel opened on it).
  useEffect(() => {
    if (!ask || !open) return;
    const f = requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('[data-ask]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(f);
  }, [ask, open]);
  const cancelAsk = () => {
    const id = ask;
    setAsk(null);
    requestAnimationFrame(() => content.current?.querySelector<HTMLElement>(`[data-speed="${id}"]`)?.focus({ preventScroll: true }));
  };

  // The rows changed under the keyboard (another agent's list, a filter cleared): the model in use,
  // or the first row, takes focus, so the keys go on working.
  const wasOpenL = useRef(false);
  useLayoutEffect(() => {
    const was = wasOpenL.current;
    wasOpenL.current = open;
    if (!open || !was) return;
    const pop = content.current;
    if (!pop || pop.dataset.state === 'closed') return;
    const a = document.activeElement;
    if (a && a !== pop && pop.contains(a)) return;
    (pop.querySelector<HTMLElement>('[data-col="models"][data-current]') ?? pop.querySelector<HTMLElement>('[data-col="models"]:not([data-disabled])'))?.focus({ preventScroll: true });
  }, [open, shown, q === '']); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter typed with focus on a row: the field appears and takes the keyboard from there.
  useLayoutEffect(() => {
    const f = field.current;
    if (!open || !q || !f || document.activeElement === f) return;
    f.focus({ preventScroll: true });
    f.setSelectionRange(f.value.length, f.value.length);
  }, [open, q]);

  /** Focus landed somewhere in the panel: the column it is in, the scale's owner, the bar's preview. */
  const onFocusIn = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-col]');
    const col = (row?.dataset.col as Col | undefined) ?? null;
    setFocusCol(col);
    if (col === 'models' && row?.dataset.model && movedByKeys()) {
      const [p, id] = row.dataset.model.split('\u0001') as [ProviderId, string];
      window.clearTimeout(aimTimer.current);
      setOwnerIf({ p, id });
    }
    const lv = col === 'scale' ? (row?.dataset.level as Effort | undefined) : undefined;
    setPreview(lv && isCurrent && lv !== committed ? lv : null);
  };

  /** The pointer on a model: the scale becomes its, unless the pointer is on its way into the scale (aim.ts). */
  const onModelPointer = (p: ProviderId, id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    const pt = { x: e.clientX, y: e.clientY };
    const from = last.current;
    window.clearTimeout(aimTimer.current);
    const r = scaleCol.current?.getBoundingClientRect();
    if (from && r && aimsAt(from, pt, { x: r.left, top: r.top, bottom: r.bottom })) {
      aimTimer.current = window.setTimeout(() => setOwnerIf({ p, id }), AIM_WAIT_MS);
      return;
    }
    setOwnerIf({ p, id });
  };

  /** The panel's own keys, before Radix's single list (panel-nav.ts). */
  const onKeyCapture = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (altGraph(e) || e.nativeEvent.isComposing || e.keyCode === 229 || (e.target === field.current && filterTextKey(e))) {
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pop = content.current;
    const t = e.target as HTMLElement;
    if (!pop) return;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const firstModel = () => pop.querySelector<HTMLElement>('[data-col="models"]:not([data-disabled])');
    if (t === field.current) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        consume();
        firstModel()?.focus();
      } else if (e.key === 'Enter') {
        const first = list.find((r) => r.provider === choice.provider || !busy);
        if (!first) return;
        consume();
        pickModelRow(first.provider, first.m);
        close();
        pickedByKey(); // Seal the departing search menu just as Radix seals a picked row.
      }
      return;
    }
    const row = t.closest<HTMLElement>('[data-col]');
    // The paid speed's question: Enter turns it on (Escape is the panel's own, below); its button
    // takes Enter itself.
    if (row?.dataset.ask !== undefined && ask) {
      if (e.key === 'Enter' && t === row) {
        consume();
        confirmAsk(ask);
      }
      return;
    }
    if (!row) return;
    const col = row.dataset.col as Col;
    if (col === 'scale') {
      const d = digitLevel(e.key, levels.length);
      if (d !== null) {
        consume();
        pop.querySelector<HTMLElement>(`[data-col="scale"][data-level="${levels[d]}"]`)?.click();
        return;
      }
    }
    // Typing anywhere in the panel filters the models (Radix's own typeahead would only jump).
    if (e.key.length === 1 && (e.key !== ' ' || query)) {
      consume();
      setQuery((v) => v + e.key);
      return;
    }
    if (e.key === 'Backspace' && query) {
      consume();
      setQuery((v) => v.slice(0, -1));
      return;
    }
    const lists: Record<Col, HTMLElement[]> = {
      models: [...pop.querySelectorAll<HTMLElement>('[data-col="models"]:not([data-disabled])')],
      scale: [...pop.querySelectorAll<HTMLElement>('[data-col="scale"]:not([data-disabled])')],
      toggles: [...pop.querySelectorAll<HTMLElement>('[data-col="toggles"]:not([data-ask])')],
    };
    const shape: Shape = {
      models: lists.models.length,
      scale: lists.scale.length,
      toggles: lists.toggles.length,
      owner: Math.max(0, lists.models.findIndex((el) => el.dataset.owns !== undefined)),
      level: Math.max(0, lists.scale.findIndex((el) => el.dataset.thumb !== undefined)),
    };
    const to = navigate({ col, i: lists[col].indexOf(row) }, e.key, e.shiftKey, shape);
    if (to) {
      consume();
      lists[to.col][to.i]?.focus();
    } else if (/^(Arrow(Up|Down|Left|Right)|Home|End|Tab)$/.test(e.key)) consume();
  };

  // ── the phrase ──

  const hasSpeed = speeds.length > 0;
  const speedInfo = speeds.find((s) => s.id === choice.speed);
  const fast = hasSpeed && choice.speed !== STANDARD_SPEED;
  const parts: ChipPart[] = [];
  if (fast) parts.push({ k: 'bolt', className: 'ph-bolt', node: <Icon name="bolt" size={13} /> });
  parts.push({ k: `model:${name}`, className: 'ph-model', node: <span className="ph-name">{name}</span> });
  if (word) {
    // The dot is one gap each side: it stays when the word changes and rides with the name.
    parts.push({ k: 'dot', className: 'ph-dot', node: '·' });
    parts.push({ k: `word:${word}`, className: 'ph-word', node: <span data-preview={preview ? '' : undefined}>{word}</span> });
  }
  const tip = 'Model and effort' + (fast && speedInfo?.paid ? ` · ${speedInfo.name} on extra usage` : '');
  const aria = `Model and effort: ${name}${word ? `, ${word}` : ''}${fast ? `, ${speedInfo?.name ?? 'fast'} speed${speedInfo?.paid ? ', billed as extra usage' : ''}` : ''}`;

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Radix opens on ArrowDown: here the arrows step the level, and nothing opens.
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      want.current = 'model';
      openedBy.current = 'keys';
    }
  };

  // The panel's first focus, a frame after it opens (Radix's own focus first would be a second
  // move): the model in use for the keys, the level in use for a click. A field or button that
  // already took focus keeps it.
  const firstFocus = {
    onOpenAutoFocus: (e: Event) => {
      e.preventDefault();
      const pop = e.currentTarget as HTMLElement;
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!pop.isConnected || pop.dataset.state === 'closed' || (a && a !== pop && pop.contains(a))) return;
        const target = want.current === 'model' ? pop.querySelector<HTMLElement>('[data-col="models"][data-current]') : pop.querySelector<HTMLElement>('[data-col="scale"][data-current]');
        (target ?? pop.querySelector<HTMLElement>('[data-col="models"][data-current]') ?? pop.querySelector<HTMLElement>('[data-col]') ?? pop).focus({ preventScroll: true });
      });
    },
  } as object;

  const ownerName = ownerModel ? (modelName(ownerModel) ?? ownerModel.id) : name;
  const togglesView = toggles > 0 && (
    <div className="mx-togs" role="group" aria-label="Switches">
      {ultraOffered && (
        <RM.CheckboxItem
          className="menu-item mx-tog"
          data-col="toggles"
          data-uc=""
          checked={ucOn}
          onSelect={(e) => {
            // A switch: the panel stays, and the level stays (ultracode is no level).
            e.preventDefault();
            const out = landUltra(now, !ucOn, ultraOffered);
            if (out.ultra !== undefined) onUltracode(out.ultra);
          }}
        >
          <Icon name="ultracode" size={14} />
          <span className="grow">Ultracode</span>
          <SwitchLook on={ucOn} />
        </RM.CheckboxItem>
      )}
      {speeds.map((s) => {
        const sOn = choice.speed === s.id;
        if (ask === s.id)
          return (
            // The question holds the focus itself (Enter turns it on, Escape leaves it off), so its
            // button stays a plain primary and wears the focus ring only when Tab reaches it.
            <div key={s.id} className="mx-tog mx-ask" data-col="toggles" data-ask="" tabIndex={-1} role="group" aria-label={`Turn on ${s.name.toLowerCase()} mode, billed as extra usage`}>
              <Icon name="bolt" size={14} />
              {/* The speed keeps its name while it asks: the row says what is billed. */}
              <span className="grow truncate mx-ask-q">{askLine(s.name)}</span>
              <button type="button" className="btn btn-primary mx-ask-on" onClick={() => confirmAsk(s.id)}>
                Turn on
              </button>
            </div>
          );
        const row = (
          <RM.CheckboxItem key={s.id} className="menu-item mx-tog" data-col="toggles" data-speed={s.id} checked={sOn} aria-label={s.paid ? `${s.name}, billed as extra usage` : undefined} onSelect={(e) => pickSpeed(s, e)}>
            <Icon name="bolt" size={14} />
            <span className="grow truncate">{s.name}</span>
            <SwitchLook on={sOn} />
          </RM.CheckboxItem>
        );
        // What a speed inside the plan costs (it uses the plan faster) is its tooltip.
        return s.note && !s.paid ? (
          <Tip key={s.id} label={s.note} side="left">
            {row}
          </Tip>
        ) : (
          row
        );
      })}
    </div>
  );

  // A column for the agents' marks stands at the rows' start only where a row has one: the other
  // agents under the models, or a filter that looks through every agent's models.
  const marks = agentRows.length > 0 || (!!q && agents.length > 1);
  const agentRowsView = agentRows.map((p) => (
    // Another agent: its models take the column's place, one step away (the panel keeps its size).
    <RM.Item
      key={p}
      className="menu-item mx-agent"
      data-col="models"
      aria-label={`${PROVIDER_NAME[p]} models`}
      onSelect={(e) => {
        e.preventDefault();
        setTab(p);
      }}
    >
      <span className="mx-lead">
        <ProviderMark provider={p} size={14} className="mm-mark" />
      </span>
      <span className="grow truncate">{PROVIDER_NAME[p]}</span>
      <span className="mx-end">
        <Icon name="caret-right" size={12} className="mx-caret" />
      </span>
    </RM.Item>
  ));

  const columns = (
    <div className="mx-cols">
      <RM.RadioGroup className="mx-models" data-filter={q ? '' : undefined} value={keyOf(choice.provider, choice.modelId ?? '')} aria-label="Model">
        {q && (
          <div className="mm-search mx-search">
            <Icon name="search" size={14} />
            <input
              ref={field}
              className="mm-field"
              value={query}
              aria-label="Search models"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="mx-list scroll">
          {/* The models stand nearest the phrase: above it, the other agents come first. */}
          {place.side === 'top' && agentRowsView}
          {list.map(({ provider, m, name: n, hit }) => {
            const home = provider === choice.provider;
            const k = keyOf(provider, m.id);
            const current = home && m.id === choice.modelId;
            const owns = ownerKey.p === provider && ownerKey.id === m.id;
            const body = (
              <>
                {marks && <span className="mx-lead">{q && !home && <ProviderMark provider={provider} size={14} className="mm-mark" />}</span>}
                <span className="mm-name truncate">
                  <Hits text={n} indices={hit?.indices} />
                </span>
                {/* The row's end: the check of the model in use, as every menu of the bar marks its row; or the arrow of a model that carries the chat over to another agent. */}
                <span className="mx-end">{current ? <Icon name="check" size={14} className="mx-check" /> : !home ? <Icon name="arrow-right" size={13} className="mx-away" /> : null}</span>
              </>
            );
            const attrs = {
              'data-col': 'models',
              'data-model': k,
              'data-current': current || undefined,
              'data-owns': owns || undefined,
              // Lit a step below the highlight only once the person rested on it and went on into its scale.
              'data-owner': (owns && owner !== null && focusCol === 'scale') || undefined,
              onPointerMove: onModelPointer(provider, m.id),
              onSelect: () => pickModelRow(provider, m),
              ...guard,
            };
            return home ? (
              <RM.RadioItem key={k} value={k} className="menu-item mx-row" {...attrs}>
                {body}
              </RM.RadioItem>
            ) : (
              <RM.Item key={k} className="menu-item mx-row" disabled={busy} aria-label={`Switch to ${PROVIDER_NAME[provider]} with ${n}`} {...attrs}>
                {body}
              </RM.Item>
            );
          })}
          {!list.length && <div className="mm-empty">{q ? `No model matches “${q}”.` : 'This agent lists no models.'}</div>}
          {place.side !== 'top' && agentRowsView}
        </div>
      </RM.RadioGroup>
      <RM.RadioGroup ref={scaleCol} className="mx-scale" onPointerEnter={() => window.clearTimeout(aimTimer.current)} value={isCurrent && committed ? committed : ''} aria-label={`Effort for ${ownerName}`}>
        {levels.length ? (
          [...levels].reverse().map((e, j) => {
            const i = levels.length - 1 - j;
            const end = levels.length === 1 ? 'only' : i === levels.length - 1 ? 'top' : i === 0 ? 'bottom' : undefined;
            const lit = isCurrent && thumbIdx >= 0 ? (i < thumbIdx ? 'all' : i === thumbIdx ? 'half' : undefined) : undefined;
            const thumb = i === thumbIdx ? (isCurrent ? 'set' : 'shows') : undefined;
            return (
              // Another agent's model at a level switches the chat to it: never while a turn runs.
              <RM.RadioItem key={e} value={e} className="menu-item mx-rung" data-col="scale" data-level={e} data-current={(isCurrent && e === committed) || undefined} data-thumb={thumb} disabled={ownerKey.p !== choice.provider && busy} onSelect={() => pickLevel(e)} {...guard}>
                <i className="mx-stop" data-end={end} data-lit={lit} data-hole={thumb === 'shows' || undefined} aria-hidden>
                  {thumb && <b data-k={thumb} />}
                </i>
                <span className="truncate">{effortName(e)}</span>
              </RM.RadioItem>
            );
          })
        ) : (
          <div className="mx-none">No effort levels.</div>
        )}
      </RM.RadioGroup>
    </div>
  );

  return (
    <RM.Root open={open} onOpenChange={(next) => next ? setOpen(true) : close()} modal={false}>
      <span className="ph-slot" data-chip-slot="">
        <Tip label={tip} keys={chordKeys(isMac)} side="top">
          <RM.Trigger
            asChild
            onPointerDown={() => {
              want.current = 'level';
              openedBy.current = 'pointer';
            }}
            onKeyDown={onTriggerKey}
          >
            {/* The right end holds: the phrase ends the same distance from the key whatever it says. */}
            <PhraseTrigger
              ref={chip}
              className="tb-chip ph"
              anchor="right"
              data-glide="reel"
              data-word={word ? '' : undefined}
              data-roll={roll}
              data-late={late || undefined}
              aria-label={aria}
              aria-keyshortcuts={`ArrowUp ArrowDown ${isMac ? 'Meta+Alt' : 'Alt'}+ArrowRight ${isMac ? 'Meta+Alt' : 'Alt'}+ArrowLeft ${isMac ? 'Meta' : 'Control'}+Period`}
              parts={parts}
            />
          </RM.Trigger>
        </Tip>
      </span>
      <RM.Portal>
        <RM.Content
          ref={content}
          className="pop cm-pop mx"
          data-spot
          side={place.side}
          align="end"
          sideOffset={place.sideOffset}
          alignOffset={0}
          avoidCollisions={false}
          collisionPadding={10}
          aria-label="Model and effort"
          style={{ ['--mx-rows' as string]: rows }}
          {...firstFocus}
          onKeyDownCapture={onKeyCapture}
          onFocus={onFocusIn}
          onPointerMove={(e) => (last.current = { x: e.clientX, y: e.clientY })}
          onEscapeKeyDown={(e) => {
            if (ask) {
              e.preventDefault();
              cancelAsk();
            } else if (query) {
              e.preventDefault();
              setQuery('');
            } else escaped.current = true;
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            const pointer = e.detail.originalEvent;
            const target = pointer.target as Element | null;
            const hit = target?.closest<HTMLElement>('input, textarea, select, button, a[href], label, [tabindex], [contenteditable]:not([contenteditable="false"])');
            const control = hit?.tagName === 'LABEL' ? (hit as HTMLLabelElement).control : hit;
            // Give a clicked field the keyboard now. Its native pointer action still places the caret.
            control?.focus({ preventScroll: true });
            if (control && document.activeElement === control) setOpen(false);
            else {
              // A click on the background would move focus to body after this handler returns.
              pointer.preventDefault();
              close();
            }
          }}
          onFocusOutside={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Later>
            {() => (
              // The switches stand at the far end from the phrase, so the models and the levels are nearest it.
              <>
                {place.side === 'top' && togglesView}
                {place.side === 'top' && togglesView && <div className="mx-sep" role="separator" />}
                {columns}
                {place.side !== 'top' && togglesView && <div className="mx-sep" role="separator" />}
                {place.side !== 'top' && togglesView}
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});
