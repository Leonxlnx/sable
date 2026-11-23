import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import { ContextMenu as RC, DropdownMenu as RM } from 'radix-ui';
import { DEFAULT_ACCOUNT, type SessionMeta } from '@shared/protocol';
import { hasWork, workLabel } from '@shared/work-label';
import { PROVIDER_NAME, ProviderMark, StatusGlyph, type StatusTone } from '@/art/Logo';
import { fieldBeat } from '@/art/events';
import { SpareClock, spareLine } from '@/features/composer/SpareStrip';
import { Icon, type IconName } from '@/icons';
import { timeAgo } from '@/lib/format';
import { interrupt, openSession, prefetchSession, renameSession, updateSession } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { cueOpen } from '@/app/open-cue';
import { cx } from '@/ui';
import type { Mix } from './groups';
import { leaveRow, liftRow } from './leave';
import { NameField } from './NameField';
import { holdFocus, onCloseAutoFocus, ownName } from './rename';

// ── shared row state (rename / delete confirm) ──

export interface RowCtx {
  setRenaming: (id: string | null) => void;
  askDelete: (id: string) => void;
}

/** Which row is being renamed, outside React state so only the two rows involved re-render. */
let renamingId: string | null = null;
const renameListeners = new Set<() => void>();
export function setRenaming(id: string | null) {
  if (id === renamingId) return;
  renamingId = id;
  for (const l of renameListeners) l();
}
const subscribeRename = (l: () => void) => {
  renameListeners.add(l);
  return () => renameListeners.delete(l);
};
const useRenaming = (id: string) => useSyncExternalStore(subscribeRename, () => renamingId === id);

export const SidebarRowContext = createContext<RowCtx>({ setRenaming, askDelete: () => {} });

/** The fields a row shows. Anything else changing on a session (usage, model, options) must not re-render it. */
const SHOWN = ['id', 'title', 'status', 'unread', 'pinned', 'archived', 'updatedAt', 'activity', 'lastError', 'provider', 'accountId', 'spare', 'background', 'commands'] as const;
const sameShown = (a: SessionMeta, b: SessionMeta) => SHOWN.every((k) => a[k] === b[k]) && a.until?.phase === b.until?.phase;

// ── what each row shows, from one store subscription for the whole list ──

/**
 * Every store update (a streamed token is one) would otherwise run two selectors per row: a few
 * hundred rows made the sidebar the largest script cost while text streamed. Instead one listener
 * looks at the two things rows read, the sessions map and the open session; when neither changed
 * (the usual case while streaming) it returns at once. When one did, only rows whose shown fields
 * or active state changed are told.
 */
interface RowView {
  session: SessionMeta | undefined;
  active: boolean;
}

type StoreState = ReturnType<typeof useStore.getState>;

const rowListeners = new Map<string, Set<() => void>>();
const rowViews = new Map<string, RowView>();
let hubOff: (() => void) | null = null;

function viewOf(id: string, s: StoreState, prev: RowView | undefined): RowView {
  const session = s.sessions[id];
  const active = s.ui.activeSessionId === id;
  if (prev && prev.active === active && (prev.session === session || (prev.session && session && sameShown(prev.session, session)))) return prev;
  return { session, active };
}

function startHub() {
  if (hubOff) return;
  hubOff = useStore.subscribe((s, p) => {
    const activeMoved = s.ui.activeSessionId !== p.ui.activeSessionId;
    if (s.sessions === p.sessions && !activeMoved) return;
    for (const [id, subs] of rowListeners) {
      if (s.sessions[id] === p.sessions[id] && (!activeMoved || (id !== s.ui.activeSessionId && id !== p.ui.activeSessionId))) continue;
      const prev = rowViews.get(id);
      const next = viewOf(id, s, prev);
      if (next === prev) continue;
      rowViews.set(id, next);
      for (const fn of subs) fn();
    }
  });
}

function rowView(id: string): RowView {
  let v = rowViews.get(id);
  if (!v) {
    v = viewOf(id, useStore.getState(), undefined);
    rowViews.set(id, v);
  }
  return v;
}

/** The session as the row shows it (the same object while only unshown fields change) and whether it is open. */
function useRowView(id: string): RowView {
  const subscribe = useCallback(
    (fn: () => void) => {
      startHub();
      let subs = rowListeners.get(id);
      if (!subs) rowListeners.set(id, (subs = new Set()));
      subs.add(fn);
      // A change between the first render and this subscription is caught up here.
      const fresh = viewOf(id, useStore.getState(), rowViews.get(id));
      if (fresh !== rowViews.get(id)) {
        rowViews.set(id, fresh);
        fn();
      }
      return () => {
        subs.delete(fn);
        if (!subs.size) {
          rowListeners.delete(id);
          rowViews.delete(id);
        }
        if (!rowListeners.size && hubOff) {
          hubOff();
          hubOff = null;
        }
      };
    },
    [id],
  );
  return useSyncExternalStore(subscribe, () => rowView(id));
}

// ── relative time: one minute clock; a row's time re-renders only when its label changes ──

let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;
function subscribeClock(l: () => void) {
  clockListeners.add(l);
  clockTimer ??= window.setInterval(() => {
    clockNow = Date.now();
    for (const fn of clockListeners) fn();
  }, 30_000);
  return () => {
    clockListeners.delete(l);
    if (!clockListeners.size && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

function RowTime({ ts }: { ts: number }) {
  // A fresh reading on mount, so a row that appears between ticks is not a minute behind.
  const label = useSyncExternalStore(subscribeClock, () => timeAgo(ts, Math.max(clockNow, ts)));
  return <span className="srow-time num">{label}</span>;
}

// ── sliding active pill ──

/**
 * Where the pill was drawn last, in the list's scroll coordinates, so the next one can slide in
 * from there (a one-element FLIP). Measured in the frame after mounting, never during a commit:
 * forcing layout while a session view is being built is what made opening one slow.
 */
let lastPill: number | null = null;

function ActivePill() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const list = el.closest('.side-list');
      if (!list) return;
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      const dy = lastPill === null ? 0 : lastPill - top;
      lastPill = top;
      el.style.opacity = '';
      if (dy && Math.abs(dy) < 480 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1.02)' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  // Hidden for the one frame before it knows where it slides from. Decided once at mount: reading
  // `lastPill` on a later render (after the frame above set it) would hide the pill again.
  const [hidden] = useState(() => lastPill !== null);
  return <span ref={ref} className="srow-pill" style={hidden ? { opacity: 0 } : undefined} />;
}

// ── status mark ──

export function statusTone(s: SessionMeta): StatusTone {
  // Between an /until loop's turns Sable runs the check: the chat is still at work.
  if (s.status === 'running' || s.status === 'starting' || (s.status === 'idle' && s.until?.phase === 'checking')) return 'working';
  if (s.status === 'awaiting') return 'awaiting';
  // Its own turn ended (also with an error), but sub-agents or background commands it started still
  // work: the chat is not at rest.
  if (hasWork(s)) return 'working';
  if (s.status === 'error') return 'error';
  return s.unread ? 'unread' : 'idle';
}

export function StatusMark({ session }: { session: SessionMeta }) {
  return <StatusGlyph tone={statusTone(session)} />;
}

export function statusLabel(s: SessionMeta): string | null {
  if (s.status === 'running' || s.status === 'starting') return s.activity || 'Working';
  if (s.status === 'idle' && s.until?.phase === 'checking') return 'Running the check';
  if (s.status === 'awaiting') return 'Waiting for you';
  // "2 sub-agents working", "1 command running" (shared/work-label.ts, the phone says the same).
  const work = workLabel(s);
  if (work) return work;
  if (s.status === 'error') return s.lastError ? `Error: ${s.lastError}` : 'Error';
  return null;
}

type RowMix = Mix;

/** A chat waiting to start by itself (Spare), as its row's tooltip says it: "Continues at 14:00 on Ultra2". */
function spareLabel(s: SessionMeta): string | null {
  const wait = s.spare;
  if (!wait) return null;
  const accounts = useStore.getState().providers[s.provider]?.accounts;
  const account = wait.accountId && accounts && accounts.length > 1 ? accountName(accounts.find((a) => a.id === (wait.accountId ?? DEFAULT_ACCOUNT))) : undefined;
  const line = spareLine(wait, Date.now(), account);
  return [line.lead, line.at, line.on && `on ${line.on}`].filter(Boolean).join(' ');
}

/**
 * When a chat that waited starts by itself, the field answers from its row once. Only a start
 * counts: the wait has to end with the chat working (a cancelled wait ends idle).
 */
function useStartBeat(row: { current: HTMLElement | null }, waiting: boolean, working: boolean) {
  const waited = useRef(waiting);
  useEffect(() => {
    if (waiting) {
      waited.current = true;
      return;
    }
    if (!waited.current) return;
    waited.current = false;
    if (working) fieldBeat('pulse', row.current, 0.8);
  }, [waiting, working, row]);
}

// ── row menu (dropdown and context menu share one list) ──

interface MenuAction {
  icon: IconName;
  label: string;
  tone?: 'danger';
  run: () => void;
  sepBefore?: boolean;
}

/** Pinned or let go: the row lifts out of its place (or sinks from Pinned) in the frame of the click (`leave.ts`). */
function togglePin(s: SessionMeta) {
  const row = document.querySelector<HTMLElement>(`.side-list .srow[data-row="${CSS.escape(s.id)}"]`);
  const back = row ? liftRow(row, s.pinned ? 'down' : 'up') : undefined;
  // An archived chat that is pinned comes out of the archive (Pinned lists no archived chat: it would
  // be pinned and nowhere to be seen). A row that is still in the page a moment after the answer was
  // not moved by the list (the bridge refused, or its place did not change): it shows again.
  void updateSession(s.id, { pinned: !s.pinned, ...(s.archived && !s.pinned ? { archived: false } : {}) }).then(() => back && window.setTimeout(back, 500));
}
/**
 * Archived from the list: the row is put away in the frame of the click (`leave.ts`). Brought back
 * from the archive it lifts out of the archived rows, as a pinned row does. Back if the bridge refuses.
 */
function toggleArchive(s: SessionMeta) {
  const row = document.querySelector<HTMLElement>(`.side-list .srow[data-row="${CSS.escape(s.id)}"]`);
  const back = !row ? undefined : s.archived ? liftRow(row, 'up') : leaveRow(row, 'archive');
  const was = !!s.archived;
  void updateSession(s.id, { archived: !s.archived, ...(s.archived ? {} : { pinned: false }) }).then(() => back && window.setTimeout(() => !!useStore.getState().sessions[s.id]?.archived === was && back(), 500));
}

function rowActions(s: SessionMeta, ctx: RowCtx): MenuAction[] {
  const running = s.status === 'running' || s.status === 'starting' || s.status === 'awaiting';
  const list: MenuAction[] = [
    { icon: 'pencil', label: 'Rename', run: () => ctx.setRenaming(s.id) },
    { icon: s.pinned ? 'pin-off' : 'pin', label: s.pinned ? 'Unpin' : 'Pin', run: () => togglePin(s) },
  ];
  if (!s.unread) list.push({ icon: 'circle', label: 'Mark unread', run: () => void updateSession(s.id, { unread: true }) });
  list.push({ icon: 'archive', label: s.archived ? 'Unarchive' : 'Archive', run: () => toggleArchive(s) });
  if (running) list.push({ icon: 'stop', label: 'Stop', run: () => void interrupt(s.id), sepBefore: true });
  list.push({ icon: 'trash', label: 'Delete', tone: 'danger', run: () => ctx.askDelete(s.id), sepBefore: !running });
  return list;
}

function DropdownItems({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Frag key={a.label}>
          {a.sepBefore && <RM.Separator className="menu-sep" />}
          <RM.Item className="menu-item" data-tone={a.tone} onSelect={a.label === 'Rename' ? holdFocus(a.run) : a.run}>
            <Icon name={a.icon} size={16} />
            <span className="grow truncate">{a.label}</span>
          </RM.Item>
        </Frag>
      ))}
    </>
  );
}

function ContextItems({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Frag key={a.label}>
          {a.sepBefore && <RC.Separator className="menu-sep" />}
          <RC.Item className="menu-item" data-tone={a.tone} onSelect={a.label === 'Rename' ? holdFocus(a.run) : a.run}>
            <Icon name={a.icon} size={16} />
            <span className="grow truncate">{a.label}</span>
          </RC.Item>
        </Frag>
      ))}
    </>
  );
}

const Frag = ({ children }: { children: ReactNode }) => <>{children}</>;

// ── rename field ──

/**
 * The chat's title in place (NameField: what ends the edit). An empty field keeps the old title.
 * `onGiven`: the new name, for the row to show until the bridge has said it (taken away again once
 * it has answered, `ownName`): between the field going and the answer the old title stood again for
 * two frames.
 */
function RenameField({ session, title: shown, onGiven, onDone }: { session: SessionMeta; title: string; onGiven: Dispatch<SetStateAction<string | null>>; onDone: () => void }) {
  return (
    <NameField
      value={shown}
      label="Session title"
      className="srow-rename"
      onDone={(title, back) => {
        if (title && title !== shown) {
          onGiven(title);
          void renameSession(session.id, title).finally(() => onGiven(ownName(title)));
        }
        onDone();
        // Ended from the keyboard: back to the row, so the keys carry on from where they were.
        if (back) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.srow[data-row="${CSS.escape(session.id)}"] .srow-main`)?.focus());
      }}
    />
  );
}

// ── the row ──

/** Who a row's session runs as, for the tooltip and screen readers, when its folder mixes them. */
function whoLabel(s: SessionMeta, mix: RowMix): string | null {
  if (mix === 'agent') return PROVIDER_NAME[s.provider];
  if (mix === 'account') {
    const a = useStore.getState().providers[s.provider]?.accounts?.find((x) => x.id === (s.accountId ?? 'default'));
    return a ? accountName(a) : null;
  }
  return null;
}

/**
 * The pointer (or focus) resting on a row this long fetches its chat ahead (`prefetchSession`), so
 * the click finds the conversation here. Passing over rows on the way elsewhere fetches nothing.
 * One timer for the whole list: one row is under the pointer at a time.
 */
export const REST_MS = 70;
let restTimer: ReturnType<typeof setTimeout> | undefined;
let restId = '';
function restOn(id: string) {
  if (restId === id) return;
  clearTimeout(restTimer);
  restId = id;
  restTimer = setTimeout(() => prefetchSession(id), REST_MS);
}
function restOff(id: string) {
  if (restId !== id) return;
  clearTimeout(restTimer);
  restId = '';
}

/**
 * A sidebar row: one line, the agent's mark at the folder icon's column, the title, and at the
 * right end a quiet time, or the session's state in its place (a ring while it works, a dot when
 * it wants you), both of which the hover actions cover. It reads its own session and active state
 * from the store, so a status change in one session re-renders only that row. `enter` is read
 * once: rows added after the list first drew rise in (plain CSS), the first paint does not animate.
 */
export const SessionRow = memo(function SessionRow({ id, enter, mix }: { id: string; enter?: boolean; mix?: RowMix }) {
  const { session, active } = useRowView(id);
  const renaming = useRenaming(id);
  const ctx = useContext(SidebarRowContext);
  const [menuOpen, setMenuOpen] = useState(false);
  // The hover actions are built the first time the row is pointed at or focused, the dropdown the
  // first time it is asked for: a menu per row is most of a row's cost.
  const [armed, setArmed] = useState(false);
  const [menuArmed, setMenuArmed] = useState(false);
  const [animateIn] = useState(!!enter);
  // A name just given, shown until the bridge has answered (its answer comes after the store has it).
  const [given, setGiven] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useStartBeat(rowRef, !!session?.spare, !!session && statusTone(session) === 'working');
  if (!session) return null;
  const tone = statusTone(session);
  const title = given ?? session.title;
  // Waiting to start by itself (Spare): a small clock where the time or the status mark sits. A chat
  // that stopped at a limit and now waits for its reset shows the wait, not the limit's error.
  const waits = !!session.spare && tone !== 'working' && tone !== 'awaiting';
  const label = waits ? spareLabel(session) : statusLabel(session);
  const who = whoLabel(session, mix);
  const arm = armed ? undefined : () => setArmed(true);
  const openMenu = () => {
    setArmed(true);
    setMenuArmed(true);
    setMenuOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'F2') {
      e.preventDefault();
      ctx.setRenaming(session.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      ctx.askDelete(session.id);
    }
  };

  const more = (
    <button type="button" className="srow-act" tabIndex={-1} aria-label={`More actions for ${title}`} aria-haspopup="menu" onClick={menuArmed ? undefined : openMenu}>
      <Icon name="dots" size={15} />
    </button>
  );

  return (
    <div
      ref={rowRef}
      className={cx('srow', session.archived && 'srow-archived')}
      role="listitem"
      data-flip={id}
      data-row={id}
      data-enter={animateIn || undefined}
      data-active={active || undefined}
      data-menu={menuOpen || undefined}
      data-status={session.status}
      data-unread={session.unread || undefined}
      // A moving pointer, not an entering one: rows passing under a still pointer while the list
      // scrolls must not each build their tools.
      onPointerMove={() => {
        arm?.();
        restOn(id);
      }}
      onPointerLeave={() => restOff(id)}
      onFocus={() => {
        arm?.();
        restOn(id);
      }}
      onBlur={() => restOff(id)}
      // Pressed before it rested: the fetch starts with the press, not with the click a moment later.
      onPointerDown={(e) => e.button === 0 && prefetchSession(id)}
    >
      {active && <ActivePill />}
      <div className="srow-in">
        <span className="srow-mark">
          <ProviderMark provider={session.provider} size={12} className="srow-agent" />
        </span>
        {renaming ? (
          <RenameField session={session} title={title} onGiven={setGiven} onDone={() => ctx.setRenaming(null)} />
        ) : (
          <button
            type="button"
            className="srow-main"
            data-nav
            tabIndex={-1}
            data-id={session.id}
            aria-current={active ? 'page' : undefined}
            title={[label, who].filter(Boolean).join(' · ') || undefined}
            onClick={() => {
              // The stage answers in this frame, also when the chat has to be fetched first.
              cueOpen(session.id);
              openSession(session.id);
            }}
            onDoubleClick={() => ctx.setRenaming(session.id)}
            onKeyDown={onKeyDown}
          >
            <span className="srow-title truncate">{title}</span>
            <span className="sr-only">{[who ?? PROVIDER_NAME[session.provider], label].filter(Boolean).join(', ')}</span>
          </button>
        )}
        {/* Kept while the title is edited, only hidden: the menu Rename came from closes as any menu does. */}
        <span className="srow-end" hidden={renaming}>
          {waits ? (
            <span className="srow-state" data-tone="spare">
              <SpareClock size={12} />
            </span>
          ) : tone === 'idle' ? (
            <RowTime ts={session.updatedAt} />
          ) : (
            <span className="srow-state" data-tone={tone}>
              <StatusGlyph tone={tone} />
            </span>
          )}
          {armed && (
            <span className="srow-acts">
              <button type="button" className="srow-act" tabIndex={-1} aria-label={session.pinned ? 'Unpin' : 'Pin'} onClick={() => togglePin(session)}>
                <Icon name={session.pinned ? 'pin-off' : 'pin'} size={14} />
              </button>
              <button type="button" className="srow-act" tabIndex={-1} aria-label={session.archived ? 'Unarchive' : 'Archive'} onClick={() => toggleArchive(session)}>
                <Icon name="archive" size={14} />
              </button>
              {menuArmed ? (
                <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                  <RM.Trigger asChild>{more}</RM.Trigger>
                  <RM.Portal>
                    <RM.Content className="pop side-pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 188 }} onCloseAutoFocus={onCloseAutoFocus}>
                      <DropdownItems actions={rowActions(session, ctx)} />
                    </RM.Content>
                  </RM.Portal>
                </RM.Root>
              ) : (
                more
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}, (a, b) => a.id === b.id && a.mix === b.mix);

/** The context menu's target when it opened on the list's empty space. */
const LIST = ':list';

/**
 * One context menu for every row in the list (a context menu per row costs more than the row).
 * The row under the pointer is found from the event; a renaming row keeps the native menu.
 * The keyboard's menu key and Shift+F10 reach it too: the browser sends the focused row the event.
 */
export function RowContextMenu({ children, background }: { children: ReactNode; /** What the list's empty space offers. */ background?: ReactNode }) {
  const ctx = useContext(SidebarRowContext);
  const [target, setTarget] = useState<string | null>(null);
  const session = useStore((s) => (target ? s.sessions[target] : undefined));
  const mark = (id: string | null, on: boolean) => {
    if (id) document.querySelector(`.srow[data-row="${CSS.escape(id)}"]`)?.toggleAttribute('data-menu', on);
  };
  return (
    <RC.Root onOpenChange={(open) => !open && mark(target, false)}>
      <RC.Trigger
        asChild
        onContextMenu={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('.srow[data-row]');
          // A folder header handled it already: no menu from here.
          if (e.defaultPrevented) return;
          // The list's empty space: what can be added to it.
          if (!row) {
            if (!background || (e.target as HTMLElement).closest('.sgroup-head, .sarchived, input')) return e.preventDefault();
            setTarget(LIST);
            return;
          }
          setTarget(row.dataset.row!);
          mark(row.dataset.row!, true);
        }}
      >
        {children}
      </RC.Trigger>
      <RC.Portal>
        <RC.Content className="pop side-pop" collisionPadding={10} style={{ minWidth: 188 }} onCloseAutoFocus={onCloseAutoFocus}>
          {target === LIST ? background : session && <ContextItems actions={rowActions(session, ctx)} />}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
