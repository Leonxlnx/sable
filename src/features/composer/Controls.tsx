import { pickedByKey } from '@/ui/glide';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { useShallow } from 'zustand/react/shallow';
import type { ModelInfo, ProviderId } from '@shared/protocol';
import { isSignedIn } from '@/features/connect/plan';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon, MODE_ICON } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { modelName, visibleModels } from '@/lib/models';
import { uiZoom } from '@/lib/motion';
import { worktrees } from '@/lib/workspace';
import { pathKey } from '@/features/sidebar/groups';
import type { GitWorktree } from '@shared/protocol';
import { goHomeChat, homeAccountId, openSettings, setHomeAccount, switchAgent } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { capsKey, ensureProviderCaps, refreshStaleCaps, useStore } from '@/state/store';
import { PathLabel, Tip } from '@/ui';
import { planWord } from '@/features/accounts/model';
import { LimitDot } from '@/features/usage';
import { type Choice } from './choice';
import { Chip, type ChipPart } from './Chip';
import { Later } from './later';
import { NEAR, placeMenu, type Placed } from './menu-place';

/**
 * A chip of an agent nothing is known of yet (never seen on this machine, caps-seen.ts): a still,
 * quiet pill of the chip's own height, so the line keeps its layout and nothing shimmers.
 */
export const ChipSkeleton = ({ w }: { w: number }) => <span className="chip-skel" style={{ width: w }} aria-hidden />;

/** The model and mode menus share one width so they read as a pair. */
const MENU_W = 232;

/** Slash commands ("/model", "/mode", "/effort") open the toolbar menus through this event. */
export const MENU_EVENT = 'sable:composer-menu';
export const openComposerMenu = (which: 'model' | 'mode' | 'effort') => window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: which }));

/** Open state kept inside the control, so opening a menu re-renders the menu and nothing else. */
function useMenuOpen(which: 'model' | 'mode') {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === which && setOpen(true);
    window.addEventListener(MENU_EVENT, on);
    return () => window.removeEventListener(MENU_EVENT, on);
  }, [which]);
  return [open, setOpen] as const;
}

/**
 * Radix picks an item on pointer-up: the release of the click that opened a menu must never pick
 * one (a menu flipped by the window edge can open under the pointer). A release shortly after
 * opening, with no press inside the menu, is ignored.
 */
function useReleaseGuard(open: boolean) {
  const at = useRef(0);
  const pressed = useRef(false);
  if (open && !at.current) {
    at.current = performance.now();
    pressed.current = false;
  } else if (!open) at.current = 0;
  return {
    onPointerDown: () => void (pressed.current = true),
    onPointerUp: (e: { preventDefault: () => void }) => {
      if (!pressed.current && performance.now() - at.current < 500) e.preventDefault();
    },
  };
}

/**
 * The mode and model menus open above their trigger, aligned to its outer edge, 8px away, like the
 * effort popover. Focus goes to the current row at the start of the next frame, not inside the task
 * that opens the menu (Radix's own focus on the menu first would be a second focus move, and a
 * second forced style pass, there). A search field that already took focus keeps it.
 */
// DropdownMenu.Content passes this through to the menu's focus scope; its types leave it out.
const FOCUS_CURRENT = {
  onOpenAutoFocus: (e: Event) => {
    e.preventDefault();
    const pop = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!pop.isConnected || pop.dataset.state === 'closed' || (at && at !== pop && pop.contains(at))) return;
      (pop.querySelector<HTMLElement>('[data-current]') ?? pop.querySelector<HTMLElement>('[role="menuitem"]'))?.focus({ preventScroll: true });
    });
  },
} as object;

/**
 * Where a menu of the bar stands (menu-place.ts): clear of the pane and flush with its side, on
 * the side it is wanted on when it has the room it needs there (`need`, px), else on the other.
 * Measured once, in the render that opens it, so the menu's first frame is already in its place;
 * a menu placed here never flips by itself (`avoidCollisions={place.avoid}` on its content: only a
 * menu that hangs by its chip keeps itself in the window).
 */
export function usePanePlace(chip: RefObject<HTMLElement | null>, open: boolean, side: 'top' | 'bottom', align: 'start' | 'end', need: number): Placed {
  const place = useRef<Placed>({ side, avoid: true, ...NEAR });
  const was = useRef(false);
  if (open && !was.current) {
    const el = chip.current;
    const pane = el?.closest<HTMLElement>('.cmp-card');
    place.current = el && pane ? placeMenu(el.getBoundingClientRect(), pane.getBoundingClientRect(), side, align, need, window.innerHeight, uiZoom()) : { side, avoid: true, ...NEAR };
  } else if (!open && !was.current) place.current = { ...place.current, side };
  was.current = open;
  return place.current;
}

/** A menu row's height, and a menu's own padding (top and bottom together): what a plain menu needs. */
export const ROW_H = 28;
export const MENU_PAD = 8;

interface MenuProps {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
}

// ───────────────────────── mode ─────────────────────────

export const ModeMenu = memo(function ModeMenu({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('mode');
  const guard = useReleaseGuard(open);
  const chip = useRef<HTMLButtonElement>(null);
  const late = useRef(false);
  const modes = choice.caps?.modes ?? [];
  const place = usePanePlace(chip, open, side, 'start', modes.length * ROW_H + MENU_PAD);
  const cur = choice.mode;
  // The order holds while the menu is open and while it shrinks away; it turns once it is gone.
  const [anchor, setAnchor] = useState(cur?.id);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setAnchor(cur?.id), 180);
    return () => window.clearTimeout(t);
  }, [open, cur?.id]);
  // A chip that stood as a placeholder first comes in once, with the others (composer.css `data-late`).
  if (!choice.caps) late.current = true;
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={84} /> : null;
  if (!modes.length) return null;
  // The list is the Shift+Tab cycle, turned so the mode in use is the row nearest the trigger.
  const at = Math.max(0, modes.findIndex((m) => m.id === anchor));
  const up = place.side === 'top';
  const ordered = up ? [...modes.slice(at + 1), ...modes.slice(0, at + 1)] : [...modes.slice(at), ...modes.slice(0, at)];
  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Mode" keys="shift+tab" side="top">
        <RM.Trigger asChild>
          <Chip
            ref={chip}
            className="tb-chip cm-mode"
            anchor="left"
            data-tone={cur?.tone ?? 'ask'}
            data-late={late.current || undefined}
            aria-label={`Mode: ${cur?.name ?? 'default'}`}
            parts={[
              { k: `icon:${MODE_ICON[cur?.tone ?? 'ask']}`, className: cur?.tone === 'danger' ? 'cm-danger' : undefined, node: <Icon name={MODE_ICON[cur?.tone ?? 'ask']} size={15} /> },
              { k: `label:${cur?.id ?? ''}`, className: cur?.tone === 'danger' ? 'cm-mode-label cm-danger' : 'cm-mode-label', node: cur?.name ?? 'Mode' },
            ]}
          />
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop mm-pop"
          data-spot
          side={place.side}
          align="start"
          sideOffset={place.sideOffset}
          alignOffset={place.alignOffset}
          avoidCollisions={place.avoid}
          collisionPadding={10}
          style={{ width: MENU_W - 24 }}
          {...FOCUS_CURRENT}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {ordered.map((m) => (
                  <RM.Item key={m.id} className="menu-item mm-row" data-current={m.id === anchor || undefined} onSelect={() => choice.setMode(m.id)} {...guard}>
                    <Icon name={MODE_ICON[m.tone] ?? 'shield'} size={15} className="mm-lead" />
                    <span className="mm-name truncate" data-origin-anchor>
                      {m.name}
                    </span>
                    <span className="mm-check">{m.id === cur?.id && <Icon name="check" size={14} />}</span>
                  </RM.Item>
                ))}
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

// ───────────────────────── model ─────────────────────────

/** A name with the characters a filter matched drawn brighter. */
function Hits({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <b key={i} className="mm-hit">
            {ch}
          </b>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        ),
      )}
    </>
  );
}

/** A list this long gets its filter field at once (typing brings it up in any list). */
const LONG_LIST = 9;

/**
 * The model menu, for the keyboard first. It lists the models of one agent: the chat's own when
 * it opens. Where the person is signed in to other agents, their marks stand on the menu's first
 * line: the left and right arrows (or a click) turn the list to another agent's models, one step
 * away, and picking one of those switches the chat to that agent in place. Up and down move, Enter
 * picks, and typing filters every agent's models at once, each row then led by its agent's mark.
 * Picking a model keeps the effort last used with it.
 */
export const ModelPopover = memo(function ModelPopover({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('model');
  const guard = useReleaseGuard(open);
  const [query, setQuery] = useState('');
  // The agent whose models the list shows; the chat's own each time the menu opens.
  const [tab, setTab] = useState<ProviderId>(choice.provider);
  const chip = useRef<HTMLButtonElement>(null);
  const late = useRef(false);
  // Its list scrolls: a few rows are room enough to stay on its side.
  const place = usePanePlace(chip, open, side, 'end', Math.min(240, choice.models.length * ROW_H + 68));
  // An hour-old list is asked for again while the menu is open (new models appear without a restart).
  useEffect(() => {
    if (!open) return;
    const s = useStore.getState();
    const meta = choice.provider === s.ui.homeProvider && !s.ui.activeSessionId ? undefined : s.sessions[s.ui.activeSessionId ?? ''];
    refreshStaleCaps(choice.provider, meta ? meta.cwd : s.ui.homeCwd, choice.accountId);
  }, [open, choice.provider, choice.accountId]);
  const content = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const others = useOtherAgentModels(choice, open);
  // The chat switches agents only between turns.
  const busy = useStore((s) => {
    const st = choice.sessionId ? s.sessions[choice.sessionId]?.status : undefined;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });

  useEffect(() => {
    if (open) return;
    setQuery('');
    setTab(choice.provider);
  }, [open, choice.provider]);

  const agents = useMemo(() => [choice.provider, ...others.map((o) => o.provider).filter((p, i, all) => all.indexOf(p) === i)], [choice.provider, others]);
  const shown = agents.includes(tab) ? tab : choice.provider;
  const q = query.trim();
  const mine = shown === choice.provider;

  // The rows changed under the keyboard (another agent's list, a filter cleared): the first row,
  // or the model in use, takes focus, so the arrows and Enter go on working.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    // Not in the commit that opens the menu: its first focus is FOCUS_CURRENT's, a frame later.
    const was = wasOpen.current;
    wasOpen.current = open;
    if (!open || !was) return;
    const pop = content.current;
    if (!pop || pop.dataset.state === 'closed') return;
    const at = document.activeElement;
    if (at && at !== pop && pop.contains(at)) return;
    (pop.querySelector<HTMLElement>('[data-mrow][data-current]') ?? pop.querySelector<HTMLElement>('[data-mrow]:not([data-disabled])'))?.focus({ preventScroll: true });
  }, [open, shown, q === '']); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter typed with focus on a row: the field appears and takes the keyboard from there.
  useLayoutEffect(() => {
    const f = field.current;
    if (!open || !q || !f || document.activeElement === f) return;
    f.focus({ preventScroll: true });
    f.setSelectionRange(f.value.length, f.value.length);
  }, [open, q]);

  if (!choice.caps) late.current = true;
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={96} /> : null;
  if (!choice.caps.models.length) return null;

  const own = choice.models.map((m) => {
    const name = modelName(m) ?? m.id;
    return { provider: choice.provider, m, name, hit: q ? fuzzy(q, name) : undefined };
  });
  const away = others.map((o) => {
    const name = modelName(o.m) ?? o.m.id;
    return { ...o, name, hit: q ? fuzzy(q, name) : undefined };
  });
  // A filter looks through every agent's models, the chat's own first; else one agent's list.
  const rows = q ? [...own, ...away].filter((r) => r.hit) : mine ? own : away.filter((r) => r.provider === shown);
  const withField = !!q || rows.length > LONG_LIST;
  const withTabs = agents.length > 1 && !q;

  const name = choice.modelLabel ?? 'Model';
  const pick = (provider: ProviderId, id: string) => {
    if (provider === choice.provider) {
      choice.pickModel(id);
      setOpen(false);
      return;
    }
    // Another agent's model switches the chat to that agent, in place (never while a turn runs).
    if (busy) return;
    setOpen(false);
    if (choice.sessionId) void switchAgent(choice.sessionId, provider, id);
  };
  const turn = (by: number) => {
    const i = agents.indexOf(shown);
    setTab(agents[(i + by + agents.length) % agents.length]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const inField = e.target === field.current;
    // Left and right turn to the next agent's models (in the field they move its caret once it holds words).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && withTabs && !(inField && query)) {
      e.preventDefault();
      turn(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (inField) return;
    // Typing anywhere in the menu filters (Radix's own typeahead would only jump).
    if (e.key.length === 1 && (e.key !== ' ' || query)) {
      e.preventDefault();
      setQuery((v) => v + e.key);
    } else if (e.key === 'Backspace' && query) {
      e.preventDefault();
      setQuery((v) => v.slice(0, -1));
    }
  };

  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Model" side="top">
        <RM.Trigger asChild>
          <Chip ref={chip} className="tb-chip cm-model" anchor="right" data-late={late.current || undefined} aria-label={`Model: ${name}`} parts={[{ k: name, className: 'chip-give', node: <span data-origin-anchor>{name}</span> }]} />
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          ref={content}
          className="pop cm-pop mm-pop"
          data-spot
          side={place.side}
          align="end"
          sideOffset={place.sideOffset}
          alignOffset={place.alignOffset}
          avoidCollisions={place.avoid}
          collisionPadding={10}
          loop
          style={{ width: MENU_W }}
          aria-label="Model"
          {...FOCUS_CURRENT}
          onKeyDown={onKeyDown}
          onEscapeKeyDown={(e) => {
            if (!query) return;
            e.preventDefault();
            setQuery('');
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {withTabs && (
                  // The agents, as their marks: the one whose models are listed says its name.
                  <div className="mm-agents" role="tablist" aria-label="Agent">
                    {agents.map((p) => (
                      <button key={p} type="button" role="tab" tabIndex={-1} className="mm-agent" aria-selected={p === shown} aria-label={PROVIDER_NAME[p]} onPointerDown={(e) => e.preventDefault()} onClick={() => setTab(p)}>
                        <ProviderMark provider={p} size={14} className="mm-mark" />
                        {p === shown && <span className="mm-agent-name">{PROVIDER_NAME[p]}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {withField && (
                  <div className="mm-search">
                    <Icon name="search" size={14} />
                    <input
                      ref={field}
                      className="mm-field"
                      value={query}
                      placeholder="Search models"
                      aria-label="Search models"
                      spellCheck={false}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') return;
                        // The agents' line answers the arrows while the field is empty (the menu's own handler).
                        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !query) return;
                        e.stopPropagation();
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          content.current?.querySelector<HTMLElement>('[data-mrow]:not([data-disabled])')?.focus();
                        } else if (e.key === 'Enter') {
                          const first = rows.find((r) => r.provider === choice.provider || !busy);
                          if (!first) return;
                          e.preventDefault();
                          pick(first.provider, first.m.id);
                          // What is typed while the menu leaves goes to the composer, as after a row's pick.
                          pickedByKey();
                        }
                      }}
                    />
                  </div>
                )}
                <div className="mm-list scroll">
                  {rows.map(({ provider, m, name, hit }, i) => {
                    const home = provider === choice.provider;
                    const current = home && m.id === choice.modelId;
                    // Models in sections (OpenCode: free, Zen, Go...): a label where a section begins.
                    const section = !q && m.group && m.group !== rows[i - 1]?.m.group ? m.group : undefined;
                    return (
                      <Fragment key={`${provider}:${m.id}`}>
                        {section && (
                          <>
                            {i > 0 && <RM.Separator className="menu-sep" />}
                            <div className="mm-group" role="presentation">
                              {section}
                            </div>
                          </>
                        )}
                        <RM.Item
                          className={home ? 'menu-item mm-row' : 'menu-item mm-row mm-away'}
                          data-mrow
                          data-current={current || undefined}
                          disabled={!home && busy}
                          aria-label={home ? undefined : `Switch to ${PROVIDER_NAME[provider]} with ${name}`}
                          onSelect={() => pick(provider, m.id)}
                          {...guard}
                        >
                          {/* One agent's list needs no mark on every row; a filter across agents does. */}
                          {q && agents.length > 1 && <ProviderMark provider={provider} size={14} className="mm-mark" />}
                          <span className="mm-name truncate" data-origin-anchor={home || undefined}>
                            <Hits text={name} indices={hit?.indices} />
                          </span>
                          <span className="mm-check">{current ? <Icon name="check" size={14} /> : !home && <Icon name="arrow-right" size={13} />}</span>
                        </RM.Item>
                      </Fragment>
                    );
                  })}
                  {!rows.length && <div className="mm-empty">{q ? `No models match “${q}”` : 'No models'}</div>}
                </div>
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

const NO_OTHERS: { provider: ProviderId; m: ModelInfo }[] = [];
const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode'];

/**
 * In a session, the models of the other agents the user is signed in to (what their own pickers
 * list), loaded when the menu first opens. Empty on home, where the agent is chosen beside it.
 */
function useOtherAgentModels(choice: Choice, open: boolean) {
  const sessionId = choice.sessionId;
  const cwd = useStore((s) => (sessionId ? (s.sessions[sessionId]?.cwd ?? null) : null));
  const signedIn = useStore(useShallow((s) => AGENTS.filter((p) => p !== choice.provider && isSignedIn(s.providers[p]))));
  const visibility = useStore((s) => s.settings.modelVisibility);
  const caps = useStore(useShallow((s) => signedIn.map((p) => s.providerCaps[capsKey(p, cwd, homeAccountId(p, s))] ?? s.providerCaps[capsKey(p, cwd)])));
  useEffect(() => {
    if (!open || !sessionId || !cwd) return;
    for (const p of signedIn) ensureProviderCaps(p, cwd, homeAccountId(p));
  }, [open, sessionId, cwd, signedIn]);
  return useMemo(() => {
    if (!sessionId || !cwd) return NO_OTHERS;
    return signedIn.flatMap((p, i) => (caps[i] ? visibleModels(p, caps[i]!.models, visibility).map((m) => ({ provider: p, m })) : []));
  }, [sessionId, cwd, signedIn, caps, visibility]);
}

// ───────────────────────── home chips ─────────────────────────

/** The parts every home chip shares: the caret of a chip that opens a menu, the branch mark. */
const CARET: ChipPart = { k: 'caret', node: <Icon name="caret-down" size={10} className="hc-caret" /> };
const BRANCH: ChipPart = { k: 'branch', node: <Icon name="branch" size={15} className="hc-icon" /> };

function AgentMenu({ onClosed }: { onClosed: () => void }) {
  const provider = useStore((s) => s.ui.homeProvider);
  const providers = useStore((s) => s.providers);
  // Subscribed so the checks follow the choice.
  const homeAccount = useStore((s) => s.ui.homeAccount);
  const setUi = useStore((s) => s.setUi);
  const installed = (Object.values(providers) as NonNullable<(typeof providers)[ProviderId]>[]).filter((p) => p.installed);
  const accountOf = (id: ProviderId) => homeAccountId(id, { ui: { ...useStore.getState().ui, homeAccount }, providers });
  const mine = providers[provider]?.accounts ?? [];
  const chipPick = mine.find((a) => a.id === accountOf(provider));
  // The account shows only when there is a choice; its label, never an address.
  const chipAccount = mine.length > 1 ? accountName(chipPick) : undefined;

  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <Chip
          className="hc"
          anchor="left"
          aria-label={`Agent: ${PROVIDER_NAME[provider]}${chipAccount ? `, ${chipAccount}` : ''}`}
          parts={[
            { k: `mark:${provider}`, node: <ProviderMark provider={provider} size={15} className="hc-mark" /> },
            { k: `name:${provider}`, node: PROVIDER_NAME[provider] },
            ...(chipAccount ? [{ k: `account:${chipAccount}`, className: 'hc-account chip-give', node: chipAccount }] : []),
            ...(chipPick && mine.length > 1 ? [{ k: 'limit', node: <LimitDot provider={provider} accountId={chipPick.id} /> }] : []),
            CARET,
          ]}
        />
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop hc-pop"
          data-spot
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 248 }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {/* Many accounts make a long list: it scrolls inside the room the window has, never past its edge. */}
                <div className="hc-list scroll">
                {installed.map((p) => {
                  const accounts = p.accounts ?? [];
                  const several = accounts.length > 1;
                  const chosen = accountOf(p.id);
                  return (
                    <RM.Group key={p.id} className="hc-group">
                      <RM.Item className="menu-item cm-row" onSelect={() => (p.auth.loggedIn || several ? setUi({ homeProvider: p.id }) : openSettings('accounts'))}>
                        <ProviderMark provider={p.id} size={15} className="hc-mark" />
                        <span className="cm-row-name grow">{PROVIDER_NAME[p.id]}</span>
                        {/* With several accounts the check goes on the account, not twice. */}
                        <span className="cm-check">{p.id === provider && !several ? <Icon name="check" size={14} /> : !p.auth.loggedIn && !several && <span className="hc-signin">Sign in</span>}</span>
                      </RM.Item>
                      {several &&
                        accounts.map((a) => (
                          <RM.Item
                            key={a.id}
                            className="menu-item hc-acct"
                            data-current={(p.id === provider && a.id === chosen) || undefined}
                            onSelect={() => {
                              if (!a.auth.loggedIn) return openSettings('accounts');
                              setHomeAccount(p.id, a.id);
                              setUi({ homeProvider: p.id });
                            }}
                          >
                            <span className="grow truncate">{accountName(a)}</span>
                            <span className="hc-plan">{a.auth.loggedIn ? planWord(a) : 'Sign in'}</span>
                            <span className="hc-acct-end">
                              <LimitDot provider={p.id} accountId={a.id} />
                              {p.id === provider && a.id === chosen && <Icon name="check" size={14} />}
                            </span>
                          </RM.Item>
                        ))}
                    </RM.Group>
                  );
                })}
                </div>
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

function FolderMenu({ onClosed }: { onClosed: () => void }) {
  const cwd = useStore((s) => s.ui.homeCwd);
  const chat = useStore((s) => !!s.ui.homeChat);
  const projects = useStore((s) => s.projects);
  const home = useStore((s) => s.home);
  const setUi = useStore((s) => s.setUi);
  const recent = [...projects]
    .filter((p) => !p.hidden)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpened - a.lastOpened)
    // Seven, with "No folder" above them: the menu still opens below the chip on a 900px tall window at 110%.
    .slice(0, 7);
  const label = chat ? 'No folder' : cwd ? baseName(cwd) : 'Choose a folder';
  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <Chip
          className="hc"
          anchor="left"
          data-missing={(!cwd && !chat) || undefined}
          aria-label={chat ? 'Folder: none, a new chat' : cwd ? `Folder: ${baseName(cwd)}` : 'Choose a folder'}
          parts={[
            { k: `icon:${chat ? 'chat' : cwd ? 'folder' : 'folder-plus'}`, node: <Icon name={chat ? 'chat' : cwd ? 'folder' : 'folder-plus'} size={15} className="hc-icon" /> },
            { k: `label:${chat ? ':chat' : (cwd ?? '')}`, className: 'chip-give', node: label },
            CARET,
          ]}
        />
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop"
          data-spot
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 300 }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {/* A chat with a fresh folder of its own: nothing from another project in its context. */}
                <RM.Item className="menu-item cm-row" onSelect={() => void goHomeChat()}>
                  <Icon name="chat" size={15} className="hc-icon" />
                  <span className="grow">No folder</span>
                  <span className="cm-check">{chat && <Icon name="check" size={14} />}</span>
                </RM.Item>
                <RM.Separator className="menu-sep" />
                {recent.map((p) => (
                  <RM.Item key={p.path} className="menu-item cm-row" onSelect={() => setUi({ homeCwd: p.path, homeChat: false })}>
                    <Icon name={p.pinned ? 'pin' : 'folder'} size={15} className="hc-icon" />
                    <PathLabel fit path={tildePath(p.path, home)} title={p.path} className="cm-row-path grow" />
                    <span className="cm-check">{!chat && p.path === cwd && <Icon name="check" size={14} />}</span>
                  </RM.Item>
                ))}
                {recent.length > 0 && <RM.Separator className="menu-sep" />}
                <RM.Item className="menu-item cm-row" onSelect={() => setUi({ projectPicker: true })}>
                  <Icon name="folder-open" size={15} className="hc-icon" />
                  <span className="grow">Open a folder…</span>
                </RM.Item>
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

/** The working tree a folder is in: the longest worktree path that holds it. */
function treeOf(list: GitWorktree[], folder: string): GitWorktree | undefined {
  const k = pathKey(folder);
  let best: GitWorktree | undefined;
  for (const w of list) {
    const wk = pathKey(w.path);
    if ((k === wk || k.startsWith(`${wk}/`)) && (!best || wk.length > pathKey(best.path).length)) best = w;
  }
  return best;
}

/** A working tree's name: its branch, or where a detached checkout is. */
const treeName = (w: GitWorktree) => w.branch ?? `Detached at ${w.head ?? 'HEAD'}`;

const NO_TREES: GitWorktree[] = [];
const TREES_KEY = 'sable.treesSeen.v1';
/** The working trees last read for a folder (the newest few, kept per browser): the branch chip stands in home's first frame. */
let treesSeen: Map<string, GitWorktree[]> | null = null;

function seenTrees(cwd: string): GitWorktree[] {
  if (!treesSeen) {
    treesSeen = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(TREES_KEY) ?? '{}') as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v) && v.every((w) => w && typeof (w as GitWorktree).path === 'string')) treesSeen.set(k, v as GitWorktree[]);
    } catch {
      /* nothing kept */
    }
  }
  return treesSeen.get(pathKey(cwd)) ?? NO_TREES;
}

function rememberTrees(cwd: string, list: GitWorktree[]) {
  seenTrees(cwd);
  const k = pathKey(cwd);
  treesSeen!.delete(k);
  treesSeen!.set(k, list);
  try {
    localStorage.setItem(TREES_KEY, JSON.stringify(Object.fromEntries([...treesSeen!].slice(-16))));
  } catch {
    /* private mode */
  }
}

/**
 * The repository's working trees for a folder; [] outside a repository. What was read last time
 * shows at once (the chip never pops in a moment after home is there) and is read again.
 */
function useTrees(cwd: string | null): GitWorktree[] {
  const [got, setGot] = useState<{ cwd: string | null; list: GitWorktree[] }>(() => ({ cwd, list: cwd ? seenTrees(cwd) : NO_TREES }));
  useEffect(() => {
    if (!cwd) return;
    let live = true;
    worktrees(cwd)
      .then((l) => {
        if (!live) return;
        rememberTrees(cwd, l);
        setGot({ cwd, list: l });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cwd]);
  // Another folder: what is known of that one, never the last folder's branch for a frame.
  return got.cwd === cwd ? got.list : cwd ? seenTrees(cwd) : NO_TREES;
}

/**
 * The working tree of the chosen folder, beside the folder chip. When the repository has other
 * working trees (a folder per branch), the chip is a menu that switches between them, the main
 * checkout included.
 */
function BranchChip({ onClosed }: { onClosed: () => void }) {
  const cwd = useStore((s) => (s.ui.homeChat ? null : s.ui.homeCwd));
  const setUi = useStore((s) => s.setUi);
  const list = useTrees(cwd);
  const current = cwd ? treeOf(list, cwd) : undefined;
  if (!cwd || !current) return null;
  const label = treeName(current);
  if (list.length < 2) {
    return (
      <Tip label="Current branch" side="bottom">
        <Chip still className="hc hc-static hc-tree" anchor="left" tabIndex={0} aria-label={`Branch: ${label}`} parts={[BRANCH, { k: `label:${label}`, className: 'chip-give', node: label }]} />
      </Tip>
    );
  }
  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <Chip className="hc hc-tree" anchor="left" aria-label={`Working tree: ${label}`} parts={[BRANCH, { k: `label:${label}`, className: 'chip-give', node: label }, CARET]} />
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop"
          data-spot
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 240 }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <Later>
            {() => (
              <>
                {list.map((w) => {
                  const name = treeName(w);
                  const folder = baseName(w.path);
                  return (
                    <RM.Item key={w.path} className="menu-item cm-row" title={w.path} onSelect={() => setUi({ homeCwd: w.path, homeChat: false })}>
                      <Icon name="branch" size={15} className="hc-icon" />
                      <span className="cm-row-name grow truncate">{name}</span>
                      {folder !== name && <span className="cm-row-dim truncate">{folder}</span>}
                      <span className="cm-check">{pathKey(w.path) === pathKey(current.path) && <Icon name="check" size={14} />}</span>
                    </RM.Item>
                  );
                })}
              </>
            )}
          </Later>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

/** The agent chosen on the home screen is installed but its chosen account is not signed in. */
export function useHomeSignedOut(): boolean {
  return useStore((s) => {
    const id = s.ui.homeProvider;
    const p = s.providers[id];
    if (!p?.installed) return false;
    const acct = p.accounts?.find((a) => a.id === homeAccountId(id, s));
    return !(acct ? acct.auth.loggedIn : p.auth.loggedIn);
  });
}

/** Beside the agent chip while that agent is not signed in: one step to Settings › Accounts. */
function SignInChip() {
  if (!useHomeSignedOut()) return null;
  return (
    <button type="button" className="hc" onClick={() => openSettings('accounts')}>
      <span className="hc-signin">Sign in</span>
    </button>
  );
}

/** Agent, folder and branch for the next session, under the home composer. Each chip subscribes to its own slice. */
export const HomeChips = memo(function HomeChips({ onClosed }: { onClosed: () => void }) {
  return (
    <div className="home-chips-row">
      <AgentMenu onClosed={onClosed} />
      <SignInChip />
      <FolderMenu onClosed={onClosed} />
      <BranchChip onClosed={onClosed} />
    </div>
  );
});
