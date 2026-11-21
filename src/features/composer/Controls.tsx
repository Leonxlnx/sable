import { Fragment, memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { useShallow } from 'zustand/react/shallow';
import type { ModelInfo, ProviderId } from '@shared/protocol';
import { isSignedIn } from '@/features/connect/plan';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon, MODE_ICON } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { modelName, visibleModels } from '@/lib/models';
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
import { Morph } from './Morph';
import { Later } from './later';

export const ChipSkeleton = ({ w }: { w: number }) => <span className="chip-skel skel" style={{ width: w }} aria-hidden />;

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

interface MenuProps {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
}

// ───────────────────────── mode ─────────────────────────

export const ModeMenu = memo(function ModeMenu({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('mode');
  const guard = useReleaseGuard(open);
  const modes = choice.caps?.modes ?? [];
  const cur = choice.mode;
  // The order holds while the menu is open and while it shrinks away; it turns once it is gone.
  const [anchor, setAnchor] = useState(cur?.id);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setAnchor(cur?.id), 140);
    return () => window.clearTimeout(t);
  }, [open, cur?.id]);
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={84} /> : null;
  if (!modes.length) return null;
  // The list is the Shift+Tab cycle, turned so the mode in use is the row nearest the trigger.
  const at = Math.max(0, modes.findIndex((m) => m.id === anchor));
  const up = side === 'top';
  const ordered = up ? [...modes.slice(at + 1), ...modes.slice(0, at + 1)] : [...modes.slice(at), ...modes.slice(0, at)];
  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Mode" keys="shift+tab" side="top">
        <RM.Trigger asChild>
          <button type="button" className="tb-chip cm-mode" data-tone={cur?.tone ?? 'ask'} aria-label={`Mode: ${cur?.name ?? 'default'}`}>
            <Icon name={MODE_ICON[cur?.tone ?? 'ask']} size={15} />
            <Morph k={cur?.id ?? ''} className="cm-mode-label">
              {cur?.name ?? 'Mode'}
            </Morph>
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop mm-pop"
          data-spot
          side={side}
          align="start"
          sideOffset={8}
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

/**
 * The model menu: the list of models and nothing else. Picking one keeps the effort last used
 * with it. Typing filters; a field appears only when the list is long.
 */
export const ModelPopover = memo(function ModelPopover({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('model');
  const guard = useReleaseGuard(open);
  const [query, setQuery] = useState('');
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
    if (!open) setQuery('');
  }, [open]);

  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={96} /> : null;
  if (!choice.caps.models.length) return null;

  const models = choice.models;
  const withField = models.length + others.length > 7;
  const q = query.trim();
  const rows = models
    .map((m) => {
      const name = modelName(m) ?? m.id;
      return { m, name, hit: q ? fuzzy(q, name) : undefined };
    })
    .filter((r) => !q || r.hit);
  // The other agents' models: picking one switches the chat to that agent, in place.
  const away = others
    .map((o) => {
      const name = modelName(o.m) ?? o.m.id;
      return { ...o, name, hit: q ? fuzzy(q, name) : undefined };
    })
    .filter((r) => !q || r.hit);
  const goAway = (provider: ProviderId, id: string) => {
    if (busy) return;
    setOpen(false);
    if (choice.sessionId) void switchAgent(choice.sessionId, provider, id);
  };

  const name = choice.modelLabel ?? 'Model';
  const pick = (id: string) => {
    choice.pickModel(id);
    setOpen(false);
  };

  // Typing anywhere in the menu filters (Radix's own typeahead would only jump).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target === field.current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && (e.key !== ' ' || query)) {
      e.preventDefault();
      setQuery((v) => v + e.key);
      if (withField) field.current?.focus();
    } else if (e.key === 'Backspace' && query) {
      e.preventDefault();
      setQuery((v) => v.slice(0, -1));
    }
  };

  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Model" side="top">
        <RM.Trigger asChild>
          <button type="button" className="tb-chip cm-model" aria-label={`Model: ${name}`}>
            <Morph k={name} className="cm-model-name">
              <span className="truncate" data-origin-anchor>
                {name}
              </span>
            </Morph>
            <Icon name="caret-down" size={11} className="caret" />
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          ref={content}
          className="pop cm-pop mm-pop"
          data-spot
          side={side}
          align="end"
          sideOffset={8}
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
                        e.stopPropagation();
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          content.current?.querySelector<HTMLElement>('[data-mrow]')?.focus();
                        } else if (e.key === 'Enter' && rows[0]) {
                          e.preventDefault();
                          pick(rows[0].m.id);
                        } else if (e.key === 'Enter' && away[0]) {
                          e.preventDefault();
                          goAway(away[0].provider, away[0].m.id);
                        }
                      }}
                    />
                  </div>
                )}
                <div className="mm-list scroll">
                  {rows.map(({ m, name, hit }, i) => {
                    const current = m.id === choice.modelId;
                    // Models in sections (OpenCode: free, Zen, Go...): a label where a section begins.
                    const section = m.group && m.group !== rows[i - 1]?.m.group ? m.group : undefined;
                    return (
                      <Fragment key={m.id}>
                        {section && (
                          <>
                            {i > 0 && <RM.Separator className="menu-sep" />}
                            <div className="mm-group" role="presentation">
                              {section}
                            </div>
                          </>
                        )}
                      <RM.Item className="menu-item mm-row" data-mrow data-current={current || undefined} onSelect={() => pick(m.id)} {...guard}>
                        <ProviderMark provider={choice.provider} size={14} className="mm-mark" />
                        <span className="mm-name truncate" data-origin-anchor>
                          <Hits text={name} indices={hit?.indices} />
                        </span>
                        <span className="mm-check">{current && <Icon name="check" size={14} />}</span>
                      </RM.Item>
                      </Fragment>
                    );
                  })}
                  {away.length > 0 && rows.length > 0 && <RM.Separator className="menu-sep" />}
                  {away.map(({ provider, m, name, hit }) => (
                    <RM.Item
                      key={`${provider}:${m.id}`}
                      className="menu-item mm-row mm-away"
                      data-mrow
                      disabled={busy}
                      aria-label={`Switch to ${PROVIDER_NAME[provider]} with ${name}`}
                      onSelect={() => goAway(provider, m.id)}
                      {...guard}
                    >
                      <ProviderMark provider={provider} size={14} className="mm-mark" />
                      <span className="mm-name truncate">
                        <Hits text={name} indices={hit?.indices} />
                      </span>
                      <span className="mm-check">
                        <Icon name="arrow-right" size={13} />
                      </span>
                    </RM.Item>
                  ))}
                  {!rows.length && !away.length && <div className="mm-empty">No models match “{q}”</div>}
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
        <button type="button" className="hc" aria-label={`Agent: ${PROVIDER_NAME[provider]}${chipAccount ? `, ${chipAccount}` : ''}`}>
          <ProviderMark provider={provider} size={15} className="hc-mark" />
          <Morph k={`${provider}:${chipAccount ?? ''}`}>
            {PROVIDER_NAME[provider]}
            {chipAccount && <span className="hc-account truncate">{chipAccount}</span>}
          </Morph>
          {chipPick && mine.length > 1 && <LimitDot provider={provider} accountId={chipPick.id} />}
          <Icon name="caret-down" size={10} className="hc-caret" />
        </button>
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
        <button type="button" className="hc" data-missing={(!cwd && !chat) || undefined} aria-label={chat ? 'Folder: none, a new chat' : cwd ? `Folder: ${baseName(cwd)}` : 'Choose a folder'}>
          <Icon name={chat ? 'chat' : cwd ? 'folder' : 'folder-plus'} size={15} className="hc-icon" />
          <Morph k={chat ? ':chat' : (cwd ?? '')}>{label}</Morph>
          <Icon name="caret-down" size={10} className="hc-caret" />
        </button>
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
                    <PathLabel path={tildePath(p.path, home)} title={p.path} className="cm-row-path grow" />
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

/** The repository's working trees for a folder; [] outside a repository. */
function useTrees(cwd: string | null): GitWorktree[] {
  const [list, setList] = useState<GitWorktree[]>([]);
  useEffect(() => {
    setList([]);
    if (!cwd) return;
    let live = true;
    worktrees(cwd)
      .then((l) => live && setList(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cwd]);
  return list;
}

/**
 * The working tree of the chosen folder, beside the folder chip. When the repository has other
 * working trees (a folder per branch), the chip is a menu that switches between them, the main
 * checkout included.
 */
function BranchChip() {
  const cwd = useStore((s) => (s.ui.homeChat ? null : s.ui.homeCwd));
  const setUi = useStore((s) => s.setUi);
  const list = useTrees(cwd);
  const current = cwd ? treeOf(list, cwd) : undefined;
  if (!cwd || !current) return null;
  const label = treeName(current);
  if (list.length < 2) {
    return (
      <Tip label="Current branch" side="bottom">
        <span className="hc hc-static" tabIndex={0} aria-label={`Branch: ${label}`}>
          <Icon name="branch" size={15} className="hc-icon" />
          <Morph k={label}>
            <span className="truncate">{label}</span>
          </Morph>
        </span>
      </Tip>
    );
  }
  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <button type="button" className="hc" aria-label={`Working tree: ${label}`}>
          <Icon name="branch" size={15} className="hc-icon" />
          <Morph k={label}>
            <span className="truncate">{label}</span>
          </Morph>
          <Icon name="caret-down" size={10} className="hc-caret" />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content className="pop cm-pop" data-spot side="bottom" align="start" sideOffset={8} collisionPadding={10} style={{ width: 240 }}>
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
      <BranchChip />
    </div>
  );
});
