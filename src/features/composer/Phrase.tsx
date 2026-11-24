import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { STANDARD_SPEED, type Effort, type ModelInfo, type ProviderId, type SpeedInfo } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { fuzzy, type FuzzyMatch } from '@/lib/fuzzy';
import { isMac } from '@/lib/format';
import { effortName, modelName } from '@/lib/models';
import { EASE_OUT, play } from '@/lib/motion';
import { setEffort as setSessionEffort, switchAgent } from '@/state/actions';
import { refreshStaleCaps, useStore } from '@/state/store';
import { pickedByKey } from '@/ui/glide';
import { Slider, Tip, useSlidePill } from '@/ui';
import { Chip, type ChipPart, type ChipProps } from './Chip';
import { rememberedEffort, type Choice } from './choice';
import { ChipSkeleton, Hits, useMenuPlace, useOtherAgentModels, useReleaseGuard } from './Controls';
import { altGraph, chordKeys, landLevel, stepStop, type Setting } from './effort-track';
import { Later } from './later';
import { askLine, confirmPaid, paidConfirmed, takePaidAsk } from './paid-speed';
import { digitLevel, filterTextKey, listRows, modelDue, navigate, panelReach, panelRows, returnsToTrigger, scaleKey, triggerKey, type Col, type Shape } from './panel-nav';

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
 * - Ultracode is no level and has no row here: its own chip beside the phrase is its control
 *   (Ultracode.tsx `UltraChip`, Alt+U), on or off at any level (effort-track.ts).
 * - A click (or Enter, or Ctrl+.) opens the panel 8 px off the phrase and flush with its right end
 *   in every frame (it hangs from that end). It is one column of 28 px rows. Nearest the phrase the
 *   effort slider, then the speeds, a hairline, and the models: every row led by its agent's mark,
 *   the names on one edge, the check at the end of the model in use; with other agents listed
 *   (switching agent in place), each agent's models stand under its name, the chat's own first.
 *   The effort is one slider of the model's levels (ui/index.tsx `Slider` with `stops`: dragged 1:1, the
 *   level's word over the thumb, the bar naming the level under the thumb a step dimmer and rolling
 *   in step; let go, the thumb settles on its stop and the level is sent); for a model with one
 *   level or none its row stays as a quiet disabled track. The speeds are one row of choices.
 * - A model of the chat's own agent with a scale keeps the panel open (the scale takes its levels in
 *   place); the model in use again, a model with no scale, or another agent's model closes it.
 *   Another agent's model while the chat works says "After this turn" at its row and stays.
 * - The list is as long as it is now (panel-nav.ts `panelRows`, scrolling past twelve rows); the
 *   slider's row never goes, so a pick never moves a row under the pointer.
 * - A model picked while a turn runs is applied with the next message: the bar names it in the
 *   waiting tone with the tooltip "From your next message" (panel-nav.ts `modelDue`).
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
  /** Ultracode is offered: the phrase stands even with no model to name (its chip is beside it). */
  ultraOffered: boolean;
}

const NO_EFFORTS: Effort[] = [];
/** The disabled track of a model with one level or none: two stops with no names. */
const NO_STOPS = ['', ''] as const;
/** The panel's width (composer.css `.mx`): one column of models, the scale and the speeds across it. */
export const PANEL_W = 256;
/** The speed row's pill: the pane's corner (16) less its 4 px inset and the track's 3 px to the pill. */
const SPEED_PILL_R = 9;
const keyOf = (p: ProviderId, id: string) => `${p}\u0001${id}`;

/** A model's row in the panel. */
interface Row {
  provider: ProviderId;
  m: ModelInfo;
  name: string;
  hit?: FuzzyMatch | null;
}

/**
 * The model each chat's running turn started on (the bridge applies a model picked meanwhile
 * right before the next message, `applyDue`, but already names it in the session): kept while
 * the chat works, forgotten when it rests.
 */
const ranWith = new Map<string, string | undefined>();

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

const Phrase = forwardRef<PhraseHandle, Props & { late: boolean }>(function Phrase({ choice, side, onClosed, late }, ref) {
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
  const guard = useReleaseGuard(open);
  // The chat works: another agent's model waits for the turn's end, and a model picked now runs from the next message.
  const busy = useStore((s) => {
    const st = choice.sessionId ? s.sessions[choice.sessionId]?.status : undefined;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const sid = choice.sessionId;
  useEffect(() => {
    if (!sid) return;
    if (!busy) ranWith.delete(sid);
    else if (!ranWith.has(sid)) ranWith.set(sid, choice.modelId);
  }, [busy, sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // A model picked while the turn runs: the bar names it in the waiting tone until the next message.
  const due = modelDue(busy, !!sid && ranWith.has(sid), sid ? ranWith.get(sid) : undefined, choice.modelId);

  // Only while the panel is open: a closing panel still under the pointer can take focus once more.
  const preview = open ? pointed : null;
  const efforts = choice.model?.efforts ?? NO_EFFORTS;
  const committed = local && efforts.includes(local) ? local : choice.effort;
  // Ultracode is a switch of its own (its chip): it never changes what the phrase names or a level.
  const now: Setting = { level: committed ? efforts.indexOf(committed) : -1, ultra: false };
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
  const speeds = choice.speeds;
  // The other agents with models to offer, in the order they come.
  const otherAgents = useMemo(() => others.map((o) => o.provider).filter((p, i, all) => all.indexOf(p) === i), [others]);
  // The effort scale stands for the model in use only when it has more than one level.
  const scaleShown = efforts.length > 1;
  // Which side it opens on is decided once, for the tallest it can come to (panel-nav.ts
  // `panelReach`): every model listed now, and a scale if any of the chat's own models has one.
  const reach = panelReach({
    list: listRows(choice.models.length, otherAgents.map((p) => others.filter((o) => o.provider === p).length)),
    scale: true,
    speeds: speeds.length > 0,
  });
  const wasOpen = useRef(false);
  // The panel hangs from the phrase's right end (Radix `align="end"`), which holds whatever the
  // phrase says: a level dragged to changes the phrase's width at its left, never where the panel
  // stands.
  if (open && !wasOpen.current) escaped.current = false;
  wasOpen.current = open;
  const place = useMenuPlace(chip, open, side, reach);

  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) return;
    setQuery('');
    setPreview(null);
    setAsk(null);
  }, [open, choice.provider]);

  // An hour-old list is asked for again while the panel is open (new models appear without a restart).
  useEffect(() => {
    if (!open) return;
    const s = useStore.getState();
    const meta = choice.provider === s.ui.homeProvider && !s.ui.activeSessionId ? undefined : s.sessions[s.ui.activeSessionId ?? ''];
    refreshStaleCaps(choice.provider, meta ? meta.cwd : s.ui.homeCwd, choice.accountId);
  }, [open, choice.provider, choice.accountId]);

  const q = query.trim();
  const own: Row[] = choice.models.map((m) => {
    const n = modelName(m) ?? m.id;
    return { provider: choice.provider, m, name: n, hit: q ? fuzzy(q, n) : undefined };
  });
  const away: Row[] = others.map((o) => {
    const n = modelName(o.m) ?? o.m.id;
    return { provider: o.provider, m: o.m, name: n, hit: q ? fuzzy(q, n) : undefined };
  });
  // The groups: the chat's own models, then each other agent's under its name. A filter looks
  // through every agent's models as one list, the chat's own first.
  const groups: { p: ProviderId; rows: Row[] }[] = q
    ? [{ p: choice.provider, rows: [...own, ...away].filter((r) => r.hit) }]
    : [{ p: choice.provider, rows: own }, ...otherAgents.map((p) => ({ p, rows: away.filter((r) => r.provider === p) }))];
  const headed = !q && groups.length > 1;
  // Nearest the phrase stand the chat's own models. Above it (a chat) the list is laid out from its
  // end (composer.css: `column-reverse`), so it opens on them and models that arrive later (another
  // agent's list, asked for as the panel opens) come in above, never pushing them away.
  const listCount = groups.reduce((n, g) => n + g.rows.length, 0) + (headed ? groups.length : 0);
  // As tall as its list is now; while a filter is typed, as tall as it was before it.
  const plainRows = useRef(listCount);
  if (!q) plainRows.current = listCount;
  const rows = panelRows(q ? plainRows.current : listCount);

  // Above the phrase the list scrolls from its end: the chat's own models, nearest the phrase, show first.
  // Once per opening, when the list is first there (it comes a frame after the panel, `Later`, in
  // a render of its own, so this is the list's own ref and not an effect of the phrase).
  const listEl = useCallback((l: HTMLDivElement | null) => {
    if (!l) return;
    const cur = l.querySelector<HTMLElement>('[data-current]');
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    const box = l.getBoundingClientRect();
    if (r.top < box.top) l.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) l.scrollTop += r.bottom - box.bottom;
  }, []);

  /** The level a model comes back at: the one last used with it, else the one in use where it fits, else its default (choice.ts `pickModel`). */
  const levelFor = (p: ProviderId, m: ModelInfo): Effort | undefined => {
    const fits = (e: Effort | undefined) => (e && m.efforts?.includes(e) ? e : undefined);
    return rememberedEffort(p, m) ?? (p === choice.provider ? fits(choice.effort) : undefined) ?? m.defaultEffort;
  };

  /** A row's pick: the panel stays open for a model of this agent whose scale is to follow, and for a refusal. */
  const pickModelRow = (p: ProviderId, m: ModelInfo, ev?: Event) => {
    if (p === choice.provider) {
      choice.pickModel(m.id);
      // Another model with a scale: the scale takes its levels in place and the panel stays, so
      // the person may go on to its level. The model in use again, or one with no scale: done.
      if (m.id !== choice.modelId && (m.efforts?.length ?? 0) > 1) ev?.preventDefault();
      return;
    }
    // Another agent's model switches the chat to that agent, in place (never while a turn runs:
    // the row says so and stays).
    const sid = choice.sessionId;
    if (busy || !sid) {
      ev?.preventDefault();
      const row = ev?.target instanceof Element ? ev.target.closest('.mx-row') : null;
      play(row?.querySelector('.mx-why'), [{ transform: 'translateX(0px)' }, { transform: 'translateX(-3px)', offset: 0.3 }, { transform: 'translateX(0px)' }], { duration: 260, easing: EASE_OUT });
      return;
    }
    const e = levelFor(p, m);
    void switchAgent(sid, p, m.id).then((ok) => {
      if (ok && e) void setSessionEffort(sid, e);
    });
  };

  // ── the effort scale ──

  const stopNames = useMemo(() => efforts.map((e) => effortName(e)), [efforts]);
  // The thumb: the level in use, else the model's own default (the bar says "Default").
  const scaleAt = committed ? efforts.indexOf(committed) : choice.model?.defaultEffort ? efforts.indexOf(choice.model.defaultEffort) : -1;
  const shownIdx = shownLevel ? efforts.indexOf(shownLevel) : scaleAt;
  /** Dragged to a stop: the bar names it, a step dimmer, rolling the way it went. */
  const slide = (i: number) => {
    const e = efforts[i];
    if (!e) return;
    stepped.current = i > shownIdx ? 1 : i < shownIdx ? -1 : 0;
    setPreview(e !== committed ? e : null);
  };
  /** Landed on a stop (released, a key, a click on the track): that level, sent when it is another one. */
  const land = (i: number) => {
    stepped.current = i > shownIdx ? 1 : i < shownIdx ? -1 : 0;
    setPreview(null);
    go(i);
  };

  const speedNow = speeds.some((s) => s.id === choice.speed) ? (choice.speed as string) : STANDARD_SPEED;
  const speedPill = useSlidePill(speedNow, SPEED_PILL_R);
  const pickSpeed = (s: SpeedInfo | undefined, ev: Event) => {
    // One of them: the panel stays, and picking the one in use changes nothing.
    ev.preventDefault();
    const next = s?.id ?? STANDARD_SPEED;
    if (next === speedNow) return;
    // A speed billed outside the plan is asked for once per session, in the row's place.
    if (s && s.paid && choice.sessionId && !paidConfirmed(choice.sessionId)) return setAsk(s.id);
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

  // The rows changed under the keyboard (a filter cleared, a model's scale came or went): the model
  // in use, or the first row, takes focus, so the keys go on working.
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
  }, [open, q === '', scaleShown]); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter typed with focus on a row: the field appears and takes the keyboard from there.
  useLayoutEffect(() => {
    const f = field.current;
    if (!open || !q || !f || document.activeElement === f) return;
    f.focus({ preventScroll: true });
    f.setSelectionRange(f.value.length, f.value.length);
  }, [open, q]);

  /** Focus landed somewhere in the panel: the bar's preview goes unless it is the scale's. */
  const onFocusIn = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const col = (e.target as HTMLElement).closest<HTMLElement>('[data-col]')?.dataset.col;
    if (col !== 'scale') setPreview(null);
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
        const first = groups[0]?.rows.find((r) => r.provider === choice.provider || !busy);
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
      const d = digitLevel(e.key, efforts.length);
      if (d !== null) {
        consume();
        land(d);
        return;
      }
      // Left, Right, Home, End and the page keys are the scale's own (ui/stops.ts `stopKey`).
      if (scaleKey(e.key)) return;
      // Enter on the scale: the level stands (it was sent as it landed), the panel goes.
      if (e.key === 'Enter') {
        consume();
        close();
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
      // In the order they stand on screen (above the phrase the groups are laid out from the end).
      models: [...pop.querySelectorAll<HTMLElement>('[data-col="models"]:not([data-disabled])')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top),
      scale: [...pop.querySelectorAll<HTMLElement>('[data-col="scale"] [role="slider"]:not([aria-disabled])')],
      speeds: [...pop.querySelectorAll<HTMLElement>('[data-col="speeds"]:not([data-ask])')],
    };
    const shape: Shape = {
      side: place.side,
      models: lists.models.length,
      scale: lists.scale.length,
      speeds: lists.speeds.length,
      current: Math.max(0, lists.models.findIndex((el) => el.dataset.current !== undefined)),
      speed: Math.max(0, lists.speeds.findIndex((el) => el.dataset.state === 'checked')),
    };
    const at = col === 'scale' ? 0 : lists[col].indexOf(row);
    const to = navigate({ col, i: at }, e.key, e.shiftKey, shape);
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
  parts.push({ k: `model:${name}`, className: 'ph-model', node: <span className="ph-name" data-due={due ? '' : undefined}>{name}</span> });
  if (word) {
    // The dot is one gap each side: it stays when the word changes and rides with the name.
    parts.push({ k: 'dot', className: 'ph-dot', node: '·' });
    parts.push({ k: `word:${word}`, className: 'ph-word', node: <span data-preview={preview ? '' : undefined}>{word}</span> });
  }
  const tip = due ? 'From your next message' : 'Model and effort' + (fast && speedInfo?.paid ? ` · ${speedInfo.name} on extra usage` : '');
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
  // move): the model in use for the keys, the scale for a click. A field or button that already
  // took focus keeps it.
  const firstFocus = {
    onOpenAutoFocus: (e: Event) => {
      e.preventDefault();
      const pop = e.currentTarget as HTMLElement;
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!pop.isConnected || pop.dataset.state === 'closed' || (a && a !== pop && pop.contains(a))) return;
        const target = want.current === 'model' ? pop.querySelector<HTMLElement>('[data-col="models"][data-current]') : pop.querySelector<HTMLElement>('[data-col="scale"] [role="slider"]:not([aria-disabled])');
        // Opened by a click: the scale takes focus without the ring (it shows with the first key).
        if (want.current !== 'model') target?.setAttribute('data-pointer', '');
        (target ?? pop.querySelector<HTMLElement>('[data-col="models"][data-current]') ?? pop.querySelector<HTMLElement>('[data-col]') ?? pop).focus({ preventScroll: true });
      });
    },
  } as object;

  // The speeds: one row of choices, one of them in use, as Settings › Models shows them.
  const asking = ask ? speeds.find((s) => s.id === ask) : undefined;
  const speedsView =
    speeds.length === 0 ? null : asking ? (
      // The question holds the focus itself (Enter turns it on, Escape leaves it off), so its
      // button stays a plain primary and wears the focus ring only when Tab reaches it.
      <div className="mx-tog mx-ask" data-col="speeds" data-ask="" tabIndex={-1} role="group" aria-label={`Turn on ${asking.name.toLowerCase()} mode, billed as extra usage`}>
        <Icon name="bolt" size={14} />
        {/* The speed keeps its name while it asks: the row says what is billed. */}
        <span className="grow truncate mx-ask-q">{askLine(asking.name)}</span>
        <button type="button" className="btn btn-primary mx-ask-on" onClick={() => confirmAsk(asking.id)}>
          Turn on
        </button>
      </div>
    ) : (
      <RM.RadioGroup className="seg mx-speeds" value={speedNow} aria-label="Speed">
        {[undefined, ...speeds].map((s) => {
          const id = s?.id ?? STANDARD_SPEED;
          const label = s?.name ?? 'Standard';
          return (
            <RM.RadioItem key={id} value={id} className="seg-item mx-speed" data-col="speeds" data-speed={id} data-active={id === speedNow} aria-label={s?.paid ? `${label}, billed as extra usage` : undefined} onSelect={(e) => pickSpeed(s, e)}>
              {id === speedNow && <span ref={speedPill} className="seg-pill" />}
              {/* What a speed inside the plan costs (it uses the plan faster) is its tooltip. */}
              {s?.note && !s.paid ? (
                <Tip label={s.note} side="top">
                  <span>{label}</span>
                </Tip>
              ) : (
                label
              )}
            </RM.RadioItem>
          );
        })}
      </RM.RadioGroup>
    );

  // The effort: one slider of the model's levels, its word over the thumb (ui/index.tsx `Slider`
  // with `stops`), nearest the phrase. Dragged, the bar names the level under the thumb a step
  // dimmer; let go, it is sent. Its row is always there: for a model with one level or none it is
  // the quiet disabled track (no word, no thumb), so a pick never changes the panel's height.
  const scaleView = (
    <div className="mx-effort" data-col="scale" data-none={scaleShown ? undefined : ''}>
      {scaleShown ? (
        <Slider stops={stopNames} value={scaleAt} onChange={slide} onCommit={land} label={`Effort for ${name}`} className="mx-slider" />
      ) : (
        <Slider stops={NO_STOPS} value={0} onChange={() => {}} label={`${name} has no effort levels`} className="mx-slider" disabled />
      )}
    </div>
  );

  const rowView = ({ provider, m, name: n, hit }: Row) => {
    const home = provider === choice.provider;
    const k = keyOf(provider, m.id);
    const current = home && m.id === choice.modelId;
    // Another agent's model while the chat works: it says why it waits, at the row.
    const held = !home && (busy || !choice.sessionId);
    const body = (
      <>
        <ProviderMark provider={provider} size={14} className="mm-mark" />
        <span className="mm-name truncate">
          <Hits text={n} indices={hit?.indices} />
        </span>
        {held ? <span className="mx-why">After this turn</span> : <span className="mm-check">{current && <Icon name="check" size={14} />}</span>}
      </>
    );
    const attrs = {
      'data-col': 'models',
      'data-model': k,
      'data-current': current || undefined,
      'data-held': held || undefined,
      onSelect: (ev: Event) => pickModelRow(provider, m, ev),
      ...guard,
    };
    return home ? (
      <RM.RadioItem key={k} value={k} className="menu-item mm-row mx-row" {...attrs}>
        {body}
      </RM.RadioItem>
    ) : (
      <RM.Item key={k} className="menu-item mm-row mx-row" aria-label={`Switch to ${PROVIDER_NAME[provider]} with ${n}`} aria-disabled={held || undefined} {...attrs}>
        {body}
      </RM.Item>
    );
  };

  const listView = (
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
      <div ref={listEl} className="mx-list scroll">
        {groups.map((g) => (
          <div key={g.p} className="mx-group" role="group" aria-label={headed ? PROVIDER_NAME[g.p] : undefined}>
            {/* Every agent's models under its name, once more than one agent is listed. */}
            {headed && <div className="mx-head">{PROVIDER_NAME[g.p]}</div>}
            {g.rows.map(rowView)}
          </div>
        ))}
        {!listCount && <div className="mm-empty">{q ? `No model matches “${q}”.` : 'This agent lists no models.'}</div>}
      </div>
    </RM.RadioGroup>
  );

  // Nearest the phrase what is set for the model: its effort, then the speeds; beyond a hairline
  // the models. The slider's row never goes, so no pick moves a row under the pointer.
  const settings = (
    <div className="mx-set">
      {place.side === 'top' ? speedsView : scaleView}
      {place.side === 'top' ? scaleView : speedsView}
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
              <>
                {place.side !== 'top' && settings}
                {place.side !== 'top' && <div className="mx-sep" role="separator" />}
                {listView}
                {place.side === 'top' && <div className="mx-sep" role="separator" />}
                {place.side === 'top' && settings}
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});
