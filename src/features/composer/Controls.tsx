import { Fragment, memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { useShallow } from 'zustand/react/shallow';
import type { ModelInfo, ProviderId } from '@shared/protocol';
import { isSignedIn } from '@/features/connect/plan';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon, MODE_ICON } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { visibleModels } from '@/lib/models';
import { uiZoom } from '@/lib/motion';
import { worktrees } from '@/lib/workspace';
import { pathKey } from '@/features/sidebar/groups';
import type { GitWorktree } from '@shared/protocol';
import { goHomeChat, homeAccountId, openSettings, setHomeAccount } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { accountLiveCaps, ensureProviderCaps, useStore } from '@/state/store';
import { PathLabel, Tip } from '@/ui';
import { planWord } from '@/features/accounts/model';
import { LimitDot } from '@/features/usage';
import { switchModelAccount, type Choice } from './choice';
import { seenCaps } from './caps-seen';
import { Chip, type ChipPart } from './Chip';
import { Later } from './later';
import { GAP, placeMenu, type Placed } from './menu-place';
import { signedOut } from '@/lib/sign-in';

/**
 * A chip of an agent nothing is known of yet (never seen on this machine, caps-seen.ts): a still,
 * quiet pill of the chip's own height, so the line keeps its layout and nothing shimmers.
 */
export const ChipSkeleton = ({ w }: { w: number }) => <span className="chip-skel" style={{ width: w }} aria-hidden />;

/** The mode menu's width. */
const MENU_W = 208;

/** `/mode` opens the mode menu through this event (`/model` and `/effort` open the panel, Phrase.tsx). */
export const MENU_EVENT = 'sable:composer-menu';
export const openComposerMenu = (which: 'mode') => window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: which }));

/** Open state kept inside the control, so opening a menu re-renders the menu and nothing else. */
function useMenuOpen(which: 'mode') {
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
export function useReleaseGuard(open: boolean) {
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
 * The mode menu opens above its trigger, aligned to its outer edge, 8px away, like the model and
 * effort panel. Focus goes to the current row at the start of the next frame, not inside the task
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
 * Where a menu of the bar stands (menu-place.ts): by its chip, 8 px off it and on its edge, on the
 * side it is wanted on when the window has the room it needs there (`need`, px), else on the side
 * with more room. Measured once, in the render that opens it, so the menu's first frame is already
 * in its place and the mode menu's rows are already turned the right way; the menus take that side
 * as it is (`avoidCollisions={false}`), and one whose list scrolls is held to the room there.
 */
export function useMenuPlace(chip: RefObject<HTMLElement | null>, open: boolean, side: 'top' | 'bottom', need: number): Placed {
  const place = useRef<Placed>({ side, sideOffset: GAP, alignOffset: 0 });
  const was = useRef(false);
  if (open && !was.current) {
    const el = chip.current;
    place.current = el ? placeMenu(el.getBoundingClientRect(), side, need, window.innerHeight, uiZoom()) : { side, sideOffset: GAP, alignOffset: 0 };
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
  const place = useMenuPlace(chip, open, side, modes.length * ROW_H + MENU_PAD);
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
          avoidCollisions={false}
          collisionPadding={10}
          style={{ width: MENU_W }}
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

// ───────────────────────── model (the panel is Phrase.tsx) ─────────────────────────

/** A name with the characters a filter matched drawn brighter. */
export function Hits({ text, indices }: { text: string; indices?: number[] }) {
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

const NO_OTHERS: { provider: ProviderId; m: ModelInfo }[] = [];
const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode'];

/**
 * In a session, the models of the other agents the user is signed in to (what their own pickers
 * list), loaded when the menu first opens. Empty on home, where the agent is chosen beside it.
 */
export function useOtherAgentModels(choice: Choice, open: boolean) {
  const sessionId = choice.sessionId;
  const cwd = useStore((s) => (sessionId ? (s.sessions[sessionId]?.cwd ?? null) : null));
  const signedIn = useStore(useShallow((s) => sessionId ? AGENTS.filter((p) => p !== choice.provider && isSignedIn(s.providers[p])) : []));
  const visibility = useStore((s) => s.settings.modelVisibility);
  const accounts = useStore(useShallow((s) => signedIn.map((p) => switchModelAccount(s.sessions[sessionId ?? ''], p, s))));
  const caps = useStore(useShallow((s) => signedIn.map((p, i) => accountLiveCaps(s.providerCaps, p, cwd, accounts[i]) ?? seenCaps(p, accounts[i]))));
  useEffect(() => {
    if (!open || !sessionId || !cwd) return;
    signedIn.forEach((p, i) => ensureProviderCaps(p, cwd, accounts[i]));
  }, [open, sessionId, cwd, signedIn, accounts]);
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
          sideOffset={GAP}
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
                      <RM.Item className="menu-item cm-row" onSelect={() => (!signedOut(p.auth) || several ? setUi({ homeProvider: p.id }) : openSettings('accounts'))}>
                        <ProviderMark provider={p.id} size={15} className="hc-mark" />
                        <span className="cm-row-name grow">{PROVIDER_NAME[p.id]}</span>
                        {/* With several accounts the check goes on the account, not twice. */}
                        <span className="cm-check">{p.id === provider && !several ? <Icon name="check" size={14} /> : signedOut(p.auth) && !several && <span className="hc-signin">Sign in</span>}</span>
                      </RM.Item>
                      {several &&
                        accounts.map((a) => (
                          <RM.Item
                            key={a.id}
                            className="menu-item hc-acct"
                            data-current={(p.id === provider && a.id === chosen) || undefined}
                            onSelect={() => {
                              if (signedOut(a.auth)) return openSettings('accounts');
                              setHomeAccount(p.id, a.id);
                              setUi({ homeProvider: p.id });
                            }}
                          >
                            <span className="grow truncate">{accountName(a)}</span>
                            <span className="hc-plan">{signedOut(a.auth) ? 'Sign in' : planWord(a)}</span>
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
          sideOffset={GAP}
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
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      void worktrees(cwd).then((list) => {
        if (request !== latest) return;
        rememberTrees(cwd, list);
        setGot({ cwd, list });
      }).catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      latest++;
      window.removeEventListener('focus', refresh);
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
          sideOffset={GAP}
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
                    <RM.Item key={w.path} className="menu-item cm-row" title={w.path} onSelect={() => {
                      rememberTrees(w.path, list);
                      setUi({ homeCwd: w.path, homeChat: false });
                    }}>
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
  return useStore(homeSignedOut);
}

export function homeSignedOut(s: Pick<ReturnType<typeof useStore.getState>, 'ui' | 'providers'>): boolean {
  const id = s.ui.homeProvider;
  const p = s.providers[id];
  if (!p?.installed) return false;
  const acct = p.accounts?.find((a) => a.id === homeAccountId(id, s));
  // Not read yet (a first start): neither in nor out, so no Sign in that may vanish a moment later.
  return signedOut(acct ? acct.auth : p.auth);
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
