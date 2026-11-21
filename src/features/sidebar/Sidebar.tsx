import { memo, useCallback, useEffect, useMemo, useState, type ComponentType, type CSSProperties, type DragEvent, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { ContextMenu as RC, DropdownMenu as RM } from 'radix-ui';
import type { SessionMeta } from '@shared/protocol';
import { LogoMark, PROVIDER_NAME, ProviderMark, StatusGlyph, Wordmark } from '@/art/Logo';
import { Icon } from '@/icons';
import { QuickSwitch } from '@/features/session/QuickSwitch';
import { pathForFile } from '@/lib/desktop';
import { dissolve } from '@/lib/dissolve';
import { useLaggedStore } from '@/lib/lagged';
import { afterSend } from '@/features/composer/settle';
import { reducedMotion } from '@/lib/motion';
import { baseName } from '@/lib/format';
import { addFolders, addToGroup, arrangeSidebar, closeSession, createGroup, goHome, goHomeChat, openSettings, pinProject, removeFromGroup, removeGroup, removeProject, renameGroup, renameProject } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Modal, Tip } from '@/ui';
import { Flip } from './flip';
import { nudgeFolder, pressFolder, releaseFolderDrag, type FolderDrop } from './folder-drag';
import { SideResize } from './Resize';
import { createGroupsSelector, idsOf, loadCollapsed, pathKey, saveCollapsed, toggleCollapsed, unfoldKeys, type ChatsGroup, type Mix, type ProjectGroup, type SetGroup, type TopEntry } from './groups';
import { NameField } from './NameField';
import { holdFocus, onCloseAutoFocus } from './rename';
import { RowContextMenu, SessionRow, SidebarRowContext, setRenaming, type RowCtx } from './SessionRow';
import { SidebarFooter } from './SidebarFooter';
import './sidebar.css';

const EASE = [0.16, 1, 0.3, 1] as const;

/** Memoized whole: the app shell re-renders on navigation, the sidebar parts subscribe to what they show. */
export const Sidebar = memo(function Sidebar() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const ctx = useMemo<RowCtx>(() => ({ setRenaming, askDelete: setDeleting }), []);
  useStageFreeze();
  const drop = useFolderDrop();

  return (
    <nav className="side" aria-label="Sessions" data-drop={drop.over || undefined} {...drop.handlers}>
      <SidebarTop />
      <SidebarRowContext.Provider value={ctx}>
        {/* The shared row menu wraps the list from outside, so list renders do not re-render the menu. */}
        <RowContextMenu background={<ListItems />}>
          <SidebarList />
        </RowContextMenu>
      </SidebarRowContext.Provider>
      <SidebarFooter />
      <DeleteDialog id={deleting} onClose={() => setDeleting(null)} />
      <SideResize />
      {/* Ctrl+Tab between recent sessions: mounted here because the sidebar is always there. */}
      <QuickSwitch />
    </nav>
  );
});

/**
 * Folders dragged in from the file manager land in the sidebar: each one becomes a folder in it
 * (on top of the manual order). Files in the same drop are left out; only the desktop app knows
 * a dropped item's path.
 */
function useFolderDrop() {
  const [over, setOver] = useState(false);
  const handlers = useMemo(() => {
    let t = 0;
    const files = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
    const onOver = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
      window.clearTimeout(t);
      // dragover repeats while something is held over the sidebar; silence means it left.
      t = window.setTimeout(() => setOver(false), 180);
    };
    return {
      onDragEnter: onOver,
      onDragOver: onOver,
      onDrop: (e: DragEvent) => {
        if (!files(e)) return;
        e.preventDefault();
        window.clearTimeout(t);
        setOver(false);
        const paths = [...e.dataTransfer.files].map((f) => pathForFile(f)).filter((p): p is string => !!p);
        if (!paths.length) return void useStore.getState().toast('Folders can be dropped here in the desktop app', 'info');
        void addFolders(paths).then((n) => {
          if (!n) useStore.getState().toast(paths.length > 1 ? 'None of these is a folder' : 'That is not a folder', 'info');
        });
      },
    };
  }, []);
  return { over, handlers };
}

/** The brand, then one row: a new session, search and history. Nothing here depends on sessions. */
const SidebarTop = memo(function SidebarTop() {
  const setUi = useStore((s) => s.setUi);
  return (
    <div className="side-top">
      <div className="side-brand">
        <button type="button" className="brand" onClick={() => goHome()} aria-label="Sable home">
          <LogoMark size={20} />
          <Wordmark />
        </button>
      </div>
      <div className="side-actions">
        <Tip label="New session" keys="mod+shift+o">
          <button type="button" className="side-new" onClick={() => goHome()}>
            <span className="side-new-icon">
              <Icon name="plus" size={15} />
            </span>
            <span className="truncate">New session</span>
          </button>
        </Tip>
        <IconButton icon="folder-plus" label="Open a folder" className="side-tool" onClick={() => setUi({ projectPicker: true })} />
        <IconButton icon="search" label="Search and commands" keys="mod+k" className="side-tool" onClick={() => setUi({ paletteOpen: true })} />
        <IconButton icon="history" label="History" className="side-tool" onClick={() => setUi({ historyOpen: true })} />
      </div>
    </div>
  );
});

const selectGroups = createGroupsSelector();
const LAG = { gate: afterSend };

/** When the list first drew its rows: sections that mount later (a folder moved into a project) come in. */
let listDrawnAt = 0;
const lateMount = () => listDrawnAt > 0 && performance.now() - listDrawnAt > 400;

/** Props and ref come from the context menu trigger wrapping it. */
function SidebarList(props: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  // A task behind the store, and after a sent message has landed: a new session's row, the re-sort
  // and its slide are drawn once the send's frames are over, never in them (and a burst of updates
  // sorts once). Rows show their own status at once (they subscribe themselves).
  const groups = useLaggedStore(selectGroups, Object.is, LAG);
  const ready = useStore((s) => s.ready);
  // The open session's folder, not its id: switching sessions within a folder does not re-render the list.
  const activeKey = useLaggedStore(selectActiveKey, Object.is, LAG);
  const setUi = useStore((s) => s.setUi);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  // Every click flips it, also while the last fold still runs (the fold turns back from where it is).
  const toggle = useCallback((key: string) => setCollapsed((prev) => toggleCollapsed(prev, key)), []);
  useEffect(() => saveCollapsed(collapsed), [collapsed]);

  // Opening a session that sits in a collapsed folder (or project) unfolds it (also when it was
  // collapsed after an earlier session in it was opened, hence the subscription to the id).
  useEffect(() => {
    const unfold = (key: string | null) => {
      if (!key) return;
      const keys = [key, ...selectGroups(useStore.getState()).top.flatMap((e) => (e.kind === 'group' && e.folders.some((f) => f.key === key) ? [e.key] : []))];
      setCollapsed((prev) => unfoldKeys(prev, keys));
    };
    unfold(selectActiveKey(useStore.getState()));
    let stopReveal = () => {};
    const off = useStore.subscribe((s, p) => {
      if (s.ui.activeSessionId === p.ui.activeSessionId) return;
      unfold(selectActiveKey(s));
      stopReveal();
      if (s.ui.activeSessionId) stopReveal = revealRow(s.ui.activeSessionId);
    });
    return () => {
      off();
      stopReveal();
    };
  }, []);

  useEffect(() => {
    if (ready && !listDrawnAt) listDrawnAt = performance.now();
  }, [ready]);

  const empty = ready && !groups.pinned.length && !groups.top.length;
  // Any change of membership, not only of order: an entry that grows or shrinks moves the ones below it.
  const order = `pinned:${idsOf(groups.pinned)}` + groups.top.map(entryOrder).join('');

  return (
    <div {...props} className="side-list scroll" tabIndex={0} aria-label="Sessions list" onKeyDown={onListKey} onFocus={onListFocus} onBlur={onListBlur} onScroll={onListScroll} onWheel={onListWheel}>
      {!ready ? (
        <SkeletonRows />
      ) : empty ? (
        <div className="side-empty">
          <p>Open a folder to start your first session.</p>
          <button type="button" className="btn btn-sm" onClick={() => setUi({ projectPicker: true })}>
            <Icon name="folder-plus" size={14} />
            Open a folder
          </button>
        </div>
      ) : (
        <MotionConfig reducedMotion="user">
          <div className="side-shield" aria-hidden />
          <Flip order={order} className="side-rows" beforeMeasure={releaseFolderDrag}>
            {groups.pinned.length > 0 && (
              <section className="sgroup" data-flip="pinned" aria-label="Pinned">
                <div className="sgroup-head sgroup-head-static">
                  <span className="sgroup-icon">
                    <Icon name="pin" size={15} />
                  </span>
                  <span className="sgroup-name">Pinned</span>
                </div>
                <SessionList ids={idsOf(groups.pinned)} mix={groups.pinnedMix} />
              </section>
            )}
            {groups.top.map((e) =>
              e.kind === 'folder' ? (
                <ProjectSection key={e.key} group={e.folder} collapsed={collapsed.has(e.key)} onToggle={toggle} current={activeKey === e.key} />
              ) : e.kind === 'group' ? (
                <SetSection key={e.key} set={e} collapsed={collapsed} onToggle={toggle} activeKey={activeKey} />
              ) : (
                <ChatsSection key="chats" chats={e.chats} collapsed={collapsed.has('chats')} onToggle={toggle} current={activeKey === 'chats'} />
              ),
            )}
          </Flip>
        </MotionConfig>
      )}
    </div>
  );
}

const folderOrder = (g: ProjectGroup) => `${g.key}:${idsOf(g.sessions)}:${g.archived.length}`;
const entryOrder = (e: TopEntry) =>
  e.kind === 'folder' ? `\n${folderOrder(e.folder)}` : e.kind === 'group' ? `\n${e.key}{${e.folders.map(folderOrder).join(',')}}` : `\nchats:${idsOf(e.chats.sessions)}:${e.chats.archived.length}`;

function SkeletonRows() {
  return (
    <div className="side-skel" aria-hidden>
      {[62, 78, 54, 70, 46].map((w, i) => (
        <span key={i} className="side-skel-row">
          <span className="skel" style={{ width: `${w}%` }} />
        </span>
      ))}
    </div>
  );
}

function DeleteDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const title = useStore((s) => (id ? s.sessions[id]?.title : undefined));
  const provider = useStore((s) => (id ? s.sessions[id]?.provider : undefined));
  return (
    <Modal
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title="Delete this session?"
      width={400}
      description={
        <>
          <span className="del-title">{title}</span> will be removed from Sable. {provider ? PROVIDER_NAME[provider] : 'The agent'} keeps its own transcript.
        </>
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            autoFocus
            onClick={() => {
              onClose();
              if (id) removeRow(id);
            }}
          >
            <Icon name="trash" size={14} />
            Delete
          </button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

/** The row breaks into dither cells where it stood; its neighbours close the gap as it goes. */
function removeRow(id: string) {
  const row = document.querySelector<HTMLElement>(`.srow[data-row="${CSS.escape(id)}"]`);
  // The next row takes the keyboard focus the deleted one had.
  const focusNext = row?.contains(document.activeElement) || document.activeElement === document.body;
  const next = row && (row.nextElementSibling ?? row.previousElementSibling)?.querySelector<HTMLElement>('.srow-main');
  dissolve(row);
  if (row) {
    row.style.visibility = 'hidden';
    // Should the bridge refuse, the row comes back.
    window.setTimeout(() => row.isConnected && (row.style.visibility = ''), 2500);
  }
  void closeSession(id, true);
  if (focusNext && next) requestAnimationFrame(() => next.focus());
}

function selectActiveKey(s: { ui: { activeSessionId: string | null }; sessions: Record<string, SessionMeta> }): string | null {
  const a = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
  return a && !a.pinned ? (a.chat ? 'chats' : pathKey(a.lane?.folder ?? a.cwd)) : null;
}

/** Rows by id (a space-joined string, so the list re-renders only when membership or order changes). */
const SessionList = memo(function SessionList({ ids, mix }: { ids: string; mix: Mix }) {
  // Rows that arrive after the first paint animate in; the first paint does not.
  const [drawnAt] = useState(() => performance.now());
  const enter = performance.now() - drawnAt > 400;
  return (
    <Flip order={ids} className="srows" role="list">
      {ids ? ids.split(' ').map((id) => <SessionRow key={id} id={id} enter={enter} mix={mix} />) : null}
    </Flip>
  );
});

/**
 * A folder's rows fold open and shut on a spring: a click that comes while the last fold still runs
 * turns it back from where it is, with the speed it had (AnimatePresence brings an exiting body back).
 * Under reduced motion the rows are simply there or not.
 */
const FOLD = { height: { type: 'spring', stiffness: 500, damping: 40 }, opacity: { duration: 0.16, ease: EASE } } as const;
const STILL = { duration: 0 } as const;
const useFold = () => (useReducedMotion() ? STILL : FOLD);
const FOLD_SHUT = { height: 0, opacity: 0, overflow: 'hidden' } as const;
const FOLD_OPEN = { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } } as const;

/** A section's rows and its archived ones, folding open and shut. */
function GroupBody({ open, sessions, archived, mix, children }: { open: boolean; sessions: SessionMeta[]; archived: SessionMeta[]; mix: Mix; children?: ReactNode }) {
  const [showArchived, setShowArchived] = useState(false);
  const fold = useFold();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div key="body" className="sgroup-body" initial={FOLD_SHUT} animate={FOLD_OPEN} exit={FOLD_SHUT} transition={fold}>
          {children}
          {sessions.length > 0 && <SessionList ids={idsOf(sessions)} mix={mix} />}
          {archived.length > 0 && (
            <>
              <button type="button" className="sarchived" data-nav tabIndex={-1} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                <span className="srow-mark">
                  <Icon name="archive" size={14} />
                </span>
                <span className="grow">Archived</span>
                <span className="sarchived-count num">{archived.length}</span>
              </button>
              <AnimatePresence initial={false}>
                {showArchived && (
                  <motion.div key="archived" className="sgroup-body" initial={FOLD_SHUT} animate={FOLD_OPEN} exit={FOLD_SHUT} transition={fold}>
                    <SessionList ids={idsOf(archived)} mix={undefined} />
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface SectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: (key: string) => void;
  /** Holds the open session. */
  current: boolean;
  /** The project this folder sits in. */
  inSet?: string;
}

/** Re-render a project only for what its header and lists show; rows update themselves. */
const sameGroup = (a: ProjectGroup, b: ProjectGroup) =>
  a === b ||
  (a.key === b.key &&
    a.name === b.name &&
    a.path === b.path &&
    a.pinned === b.pinned &&
    a.mix === b.mix &&
    a.attention === b.attention &&
    idsOf(a.sessions) === idsOf(b.sessions) &&
    idsOf(a.archived) === idsOf(b.archived));
const sameSection = (a: SectionProps, b: SectionProps) => a.collapsed === b.collapsed && a.onToggle === b.onToggle && a.current === b.current && a.inSet === b.inSet && sameGroup(a.group, b.group);

const ProjectSection = memo(function ProjectSection({ group, collapsed, onToggle, current, inSet }: SectionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenamingFolder] = useState(false);
  const [enter] = useState(lateMount);
  const rename = useCallback(() => setRenamingFolder(true), []);
  const hasSessions = group.sessions.length > 0 || group.archived.length > 0;
  const open = hasSessions && !collapsed;

  return (
    <section
      className="sgroup"
      data-flip={group.key}
      data-folder={group.key}
      data-kind="folder"
      data-pinned={group.pinned || undefined}
      data-enter={enter || undefined}
      aria-label={group.name}
    >
      <RC.Root>
        <RC.Trigger asChild>
          <div className="sgroup-head" data-collapsed={!open || undefined} data-current={current || undefined} data-menu={menuOpen || undefined} data-renaming={renaming || undefined}>
            {renaming ? (
              <div className="sgroup-toggle">
                <span className="sgroup-icon">
                  <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                </span>
                <FolderRename group={group} onDone={() => setRenamingFolder(false)} />
              </div>
            ) : (
              <button
                type="button"
                className="sgroup-toggle"
                data-nav
                data-folder={group.key}
                tabIndex={-1}
                aria-expanded={hasSessions ? open : undefined}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2"
                title={group.path}
                // Every click counts, however quick the last one was (a double-click is two toggles).
                onClick={(e) => {
                  if (!hasSessions) return goHome(group.path);
                  holdListEnd(e.currentTarget);
                  onToggle(group.key);
                }}
                onPointerDown={(e) => pressFolder(e, group.key, inSet ? innerDrop(inSet) : TOP_DROP)}
                onKeyDown={(e) => {
                  if (e.key === 'F2') {
                    e.preventDefault();
                    rename();
                    return;
                  }
                  if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  nudge(group.key, e.key === 'ArrowUp' ? -1 : 1, inSet);
                }}
              >
                <span className="sgroup-icon">
                  <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                </span>
                <span className="sgroup-name truncate">{group.name}</span>
                {collapsed && hasSessions && (
                  <span className="sgroup-end">
                    {group.attention ? <StatusGlyph tone={group.attention} /> : <span className="sgroup-count num">{group.sessions.length || ''}</span>}
                  </span>
                )}
              </button>
            )}
            <span className="sgroup-tools">
              <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <RM.Trigger className="sgroup-tool" tabIndex={-1} aria-label={`Actions for ${group.name}`}>
                  <Icon name="dots" size={15} />
                </RM.Trigger>
                <RM.Portal>
                  <RM.Content className="pop side-pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 220 }} onCloseAutoFocus={onCloseAutoFocus}>
                    <ProjectItems group={group} inSet={inSet} onRename={rename} M={RM as unknown as MenuParts} />
                  </RM.Content>
                </RM.Portal>
              </RM.Root>
              <Tip label={`New session in ${group.name}`}>
                <button type="button" className="sgroup-tool" tabIndex={-1} aria-label={`New session in ${group.name}`} onClick={() => goHome(group.path)}>
                  <Icon name="plus" size={14} />
                </button>
              </Tip>
            </span>
          </div>
        </RC.Trigger>
        <RC.Portal>
          <RC.Content className="pop side-pop" collisionPadding={10} style={{ minWidth: 220 }} onCloseAutoFocus={onCloseAutoFocus}>
            <ProjectItems group={group} inSet={inSet} onRename={rename} M={RC as unknown as MenuParts} />
          </RC.Content>
        </RC.Portal>
      </RC.Root>

      <GroupBody open={open} sessions={group.sessions} archived={group.archived} mix={group.mix} />
    </section>
  );
}, sameSection);

/** The parts a menu is built from: a dropdown's or a context menu's (the same shapes). */
type MenuParts = {
  Item: ComponentType<{ className?: string; disabled?: boolean; onSelect?: (e: Event) => void; children?: ReactNode }>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; sideOffset?: number; alignOffset?: number; collisionPadding?: number; style?: CSSProperties; children?: ReactNode }>;
  Portal: ComponentType<{ children?: ReactNode }>;
};

/** The folder header's actions, shared by its "…" menu and its context menu. */
function ProjectItems({ group, inSet, onRename, M }: { group: ProjectGroup; inSet?: string; onRename: () => void; M: MenuParts }) {
  const sets = useStore((s) => s.groups);
  const others = sets.filter((g) => g.id !== inSet).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return (
    <>
      <M.Item className="menu-item" onSelect={() => goHome(group.path)}>
        <Icon name="compose" size={16} />
        <span className="grow">New session here</span>
      </M.Item>
      <M.Item className="menu-item" onSelect={holdFocus(onRename)}>
        <Icon name="pencil" size={16} />
        <span className="grow">Rename</span>
      </M.Item>
      {!inSet && (
        <M.Item className="menu-item" onSelect={() => void pinProject(group.path, !group.pinned)}>
          <Icon name={group.pinned ? 'pin-off' : 'pin'} size={16} />
          <span className="grow">{group.pinned ? 'Unpin folder' : 'Pin folder'}</span>
        </M.Item>
      )}
      <M.Sub>
        <M.SubTrigger className="menu-item">
          <Icon name="stack" size={16} />
          <span className="grow">{inSet ? 'Move to project' : 'Add to project'}</span>
          <Icon name="caret-right" size={11} />
        </M.SubTrigger>
        <M.Portal>
          <M.SubContent className="pop side-pop" sideOffset={6} alignOffset={-4} collisionPadding={10} style={{ minWidth: 200 }}>
            {others.map((g) => (
              <M.Item key={g.id} className="menu-item" onSelect={() => void addToGroup(group.path, g.id)}>
                <Icon name="stack" size={16} />
                <span className="grow truncate">{g.name}</span>
              </M.Item>
            ))}
            {others.length > 0 && <M.Separator className="menu-sep" />}
            <M.Item className="menu-item" onSelect={holdFocus(() => void newProject([group.path]))}>
              <Icon name="plus" size={16} />
              <span className="grow">New project</span>
            </M.Item>
          </M.SubContent>
        </M.Portal>
      </M.Sub>
      {inSet && (
        <M.Item className="menu-item" onSelect={() => void removeFromGroup(group.path, topArrangeKeys())}>
          <Icon name="arrow-up" size={16} />
          <span className="grow">Take out of project</span>
        </M.Item>
      )}
      <M.Item className="menu-item" onSelect={() => void navigator.clipboard?.writeText(group.path)}>
        <Icon name="copy" size={16} />
        <span className="grow">Copy path</span>
      </M.Item>
      <M.Separator className="menu-sep" />
      {/* With its sessions, nothing deleted: opening the folder again brings them back. */}
      <M.Item className="menu-item sgroup-remove" onSelect={() => removeFolder(group.key, group.path)}>
        <Icon name="x" size={16} />
        <span className="grow">Remove from sidebar</span>
      </M.Item>
    </>
  );
}

/** Ended from the keyboard: back to the header, so the keys carry on from where they were. */
const backToHeader = (key: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`.sgroup-toggle[data-folder="${CSS.escape(key)}"]`)?.focus());

/**
 * The folder's name in place, as a field (NameField: what ends the edit). An empty field gives the
 * folder its own name back (the placeholder shows it). Only Sable's name for the folder changes;
 * the folder on disk keeps its own.
 */
function FolderRename({ group, onDone }: { group: ProjectGroup; onDone: () => void }) {
  const own = baseName(group.path) || group.path;
  return (
    <NameField
      value={group.name}
      placeholder={own}
      label="Folder name"
      className="sgroup-rename"
      onDone={(name, back) => {
        if (name !== undefined && name !== group.name && (name || group.name !== own)) void renameProject(group.path, name);
        onDone();
        if (back) backToHeader(group.key);
      }}
    />
  );
}

/** The folder dissolves where it stood, then leaves the list with its sessions. */
function removeFolder(key: string, path: string) {
  const el = document.querySelector<HTMLElement>(`section.sgroup[data-folder="${CSS.escape(key)}"]`);
  const head = el?.querySelector<HTMLElement>('.sgroup-head');
  if (head) dissolve(head);
  if (el) el.style.visibility = 'hidden';
  void removeProject(path).finally(() => el?.isConnected && (el.style.visibility = ''));
}

// ── projects: several folders under one name ──

/** A project made from a menu opens its name for typing once its header is there. */
let renameOnMount: string | null = null;
const renameListeners = new Set<(id: string) => void>();

async function newProject(paths: string[]) {
  const g = await createGroup('New project', paths);
  if (!g) return;
  renameOnMount = g.id;
  for (const l of renameListeners) l(g.id);
}

interface SetProps {
  set: SetGroup;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  activeKey: string | null;
}

const SetSection = memo(function SetSection({ set, collapsed, onToggle, activeKey }: SetProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenamingSet] = useState(() => {
    if (renameOnMount !== set.id) return false;
    renameOnMount = null;
    return true;
  });
  const [enter] = useState(lateMount);
  useEffect(() => {
    const l = (id: string) => {
      if (id !== set.id) return;
      renameOnMount = null;
      setRenamingSet(true);
    };
    renameListeners.add(l);
    return () => void renameListeners.delete(l);
  }, [set.id]);
  const rename = useCallback(() => setRenamingSet(true), []);
  const open = !collapsed.has(set.key);
  const fold = useFold();
  const current = set.folders.some((f) => f.key === activeKey);
  const inner = set.folders.map(folderOrder).join('\n');
  const one = set.folders.length === 1 ? set.folders[0] : undefined;

  return (
    <section className="sgroup sset" data-flip={set.key} data-folder={set.key} data-kind="group" data-enter={enter || undefined} aria-label={set.name}>
      <RC.Root>
        <RC.Trigger asChild>
          <div className="sgroup-head" data-collapsed={!open || undefined} data-current={current || undefined} data-menu={menuOpen || addOpen || undefined} data-renaming={renaming || undefined}>
            {renaming ? (
              <div className="sgroup-toggle">
                <span className="sgroup-icon">
                  <Icon name="stack" size={15} />
                </span>
                <NameField
                  value={set.name}
                  label="Project name"
                  className="sgroup-rename"
                  onDone={(name, back) => {
                    setRenamingSet(false);
                    if (name && name !== set.name) void renameGroup(set.id, name);
                    if (back) backToHeader(set.key);
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                className="sgroup-toggle"
                data-nav
                data-folder={set.key}
                tabIndex={-1}
                aria-expanded={open}
                aria-label={`${set.name}, project${set.count ? `, ${set.count} ${set.count === 1 ? 'session' : 'sessions'}` : ''}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2"
                onClick={(e) => {
                  holdListEnd(e.currentTarget);
                  onToggle(set.key);
                }}
                onPointerDown={(e) => pressFolder(e, set.key, TOP_DROP)}
                onKeyDown={(e) => {
                  if (e.key === 'F2') {
                    e.preventDefault();
                    rename();
                    return;
                  }
                  if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  nudge(set.key, e.key === 'ArrowUp' ? -1 : 1);
                }}
              >
                <span className="sgroup-icon">
                  <Icon name="stack" size={15} />
                </span>
                <span className="sgroup-name sset-name truncate">{set.name}</span>
                {/* Folded, like a folder: whose chats are inside and how many (or the most pressing state);
                    open, its folders and rows say it already. */}
                {!open && (set.count > 0 || set.attention) && (
                  <span className="sset-end">
                    {set.agents.length > 0 && (
                      <span className="sset-agents" aria-hidden>
                        {set.agents.map((p) => (
                          <ProviderMark key={p} provider={p} size={11} className="sset-agent" />
                        ))}
                      </span>
                    )}
                    {set.attention ? <StatusGlyph tone={set.attention} /> : <span className="sgroup-count num">{set.count}</span>}
                  </span>
                )}
              </button>
            )}
            <span className="sgroup-tools">
              <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <RM.Trigger className="sgroup-tool" tabIndex={-1} aria-label={`Actions for ${set.name}`}>
                  <Icon name="dots" size={15} />
                </RM.Trigger>
                <RM.Portal>
                  <RM.Content className="pop side-pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 200 }} onCloseAutoFocus={onCloseAutoFocus}>
                    <SetItems set={set} onRename={rename} M={RM as unknown as MenuParts} />
                  </RM.Content>
                </RM.Portal>
              </RM.Root>
              {one ? (
                <Tip label={`New session in ${one.name}`}>
                  <button type="button" className="sgroup-tool" tabIndex={-1} aria-label={`New session in ${one.name}`} onClick={() => goHome(one.path)}>
                    <Icon name="plus" size={14} />
                  </button>
                </Tip>
              ) : set.folders.length > 1 ? (
                <RM.Root modal={false} open={addOpen} onOpenChange={setAddOpen}>
                  <RM.Trigger className="sgroup-tool" tabIndex={-1} aria-label={`New session in ${set.name}`}>
                    <Icon name="plus" size={14} />
                  </RM.Trigger>
                  <RM.Portal>
                    <RM.Content className="pop side-pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 200 }}>
                      <RM.Label className="menu-label">New session in</RM.Label>
                      {set.folders.map((f) => (
                        <RM.Item key={f.key} className="menu-item" onSelect={() => goHome(f.path)}>
                          <Icon name="folder" size={16} />
                          <span className="grow truncate">{f.name}</span>
                        </RM.Item>
                      ))}
                    </RM.Content>
                  </RM.Portal>
                </RM.Root>
              ) : null}
            </span>
          </div>
        </RC.Trigger>
        <RC.Portal>
          <RC.Content className="pop side-pop" collisionPadding={10} style={{ minWidth: 200 }} onCloseAutoFocus={onCloseAutoFocus}>
            <SetItems set={set} onRename={rename} M={RC as unknown as MenuParts} />
          </RC.Content>
        </RC.Portal>
      </RC.Root>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" className="sgroup-body sset-body" initial={FOLD_SHUT} animate={FOLD_OPEN} exit={FOLD_SHUT} transition={fold}>
            {set.folders.length ? (
              <Flip order={inner} className="sset-folders" beforeMeasure={releaseFolderDrag}>
                {set.folders.map((f) => (
                  <ProjectSection key={f.key} group={f} collapsed={collapsed.has(f.key)} onToggle={onToggle} current={activeKey === f.key} inSet={set.id} />
                ))}
              </Flip>
            ) : (
              <p className="sset-empty">Drag a folder here</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
});

/** The project header's actions: new session in one of its folders, rename, ungroup. */
function SetItems({ set, onRename, M }: { set: SetGroup; onRename: () => void; M: MenuParts }) {
  return (
    <>
      {set.folders.length > 0 && (
        <M.Sub>
          <M.SubTrigger className="menu-item">
            <Icon name="compose" size={16} />
            <span className="grow">New session in</span>
            <Icon name="caret-right" size={11} />
          </M.SubTrigger>
          <M.Portal>
            <M.SubContent className="pop side-pop" sideOffset={6} alignOffset={-4} collisionPadding={10} style={{ minWidth: 180 }}>
              {set.folders.map((f) => (
                <M.Item key={f.key} className="menu-item" onSelect={() => goHome(f.path)}>
                  <Icon name="folder" size={16} />
                  <span className="grow truncate">{f.name}</span>
                </M.Item>
              ))}
            </M.SubContent>
          </M.Portal>
        </M.Sub>
      )}
      <M.Item className="menu-item" onSelect={holdFocus(onRename)}>
        <Icon name="pencil" size={16} />
        <span className="grow">Rename</span>
      </M.Item>
      <M.Separator className="menu-sep" />
      {/* Its folders stay in the sidebar, loose, where it stood; an empty one just goes. */}
      <M.Item className="menu-item" onSelect={() => void removeGroup(set.id)}>
        <Icon name="x" size={16} />
        <span className="grow">{set.folders.length ? 'Ungroup' : 'Remove project'}</span>
      </M.Item>
    </>
  );
}

/** The list's empty space: a new project, a folder, a chat. */
function ListItems() {
  const setUi = useStore((s) => s.setUi);
  return (
    <>
      <RC.Item className="menu-item" onSelect={holdFocus(() => void newProject([]))}>
        <Icon name="stack" size={16} />
        <span className="grow">New project</span>
      </RC.Item>
      <RC.Item className="menu-item" onSelect={() => setUi({ projectPicker: true })}>
        <Icon name="folder-plus" size={16} />
        <span className="grow">Open a folder</span>
      </RC.Item>
      <RC.Item className="menu-item" onSelect={() => void goHomeChat()}>
        <Icon name="chat" size={16} />
        <span className="grow">New chat</span>
      </RC.Item>
    </>
  );
}

// ── chats started without a folder ──

const ChatsSection = memo(function ChatsSection({ chats, collapsed, onToggle, current }: { chats: ChatsGroup; collapsed: boolean; onToggle: (key: string) => void; current: boolean }) {
  const [enter] = useState(lateMount);
  const open = !collapsed;
  return (
    <section className="sgroup" data-flip="chats" data-folder="chats" data-kind="chats" data-enter={enter || undefined} aria-label="Chats">
      <RC.Root>
        <RC.Trigger asChild>
          <div className="sgroup-head" data-collapsed={!open || undefined} data-current={current || undefined}>
            <button
              type="button"
              className="sgroup-toggle"
              data-nav
              data-folder="chats"
              tabIndex={-1}
              aria-expanded={open}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onClick={(e) => {
                holdListEnd(e.currentTarget);
                onToggle('chats');
              }}
              onPointerDown={(e) => pressFolder(e, 'chats', TOP_DROP)}
              onKeyDown={(e) => {
                if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                e.stopPropagation();
                nudge('chats', e.key === 'ArrowUp' ? -1 : 1);
              }}
            >
              <span className="sgroup-icon">
                <Icon name="chats" size={15} />
              </span>
              <span className="sgroup-name truncate">Chats</span>
              {collapsed && (
                <span className="sgroup-end">
                  {chats.attention ? <StatusGlyph tone={chats.attention} /> : <span className="sgroup-count num">{chats.sessions.length || ''}</span>}
                </span>
              )}
            </button>
            <span className="sgroup-tools">
              <Tip label="New chat">
                <button type="button" className="sgroup-tool" tabIndex={-1} aria-label="New chat" onClick={() => void goHomeChat()}>
                  <Icon name="plus" size={14} />
                </button>
              </Tip>
            </span>
          </div>
        </RC.Trigger>
        <RC.Portal>
          <RC.Content className="pop side-pop" collisionPadding={10} style={{ minWidth: 200 }} onCloseAutoFocus={onCloseAutoFocus}>
            <RC.Item className="menu-item" onSelect={() => void goHomeChat()}>
              <Icon name="compose" size={16} />
              <span className="grow">New chat</span>
            </RC.Item>
            <RC.Item className="menu-item" onSelect={() => openSettings('general')}>
              <Icon name="folder" size={16} />
              <span className="grow">Chats folder</span>
            </RC.Item>
          </RC.Content>
        </RC.Portal>
      </RC.Root>
      <GroupBody open={open} sessions={chats.sessions} archived={chats.archived} mix={chats.mix} />
    </section>
  );
});

// ── the manual order ──

/** A top entry as `project.arrange` names it. */
const arrangeKey = (e: TopEntry) => (e.kind === 'folder' ? e.folder.path : e.key);

/** The top entries as `project.arrange` names them, in the order shown. */
function topArrangeKeys(): string[] {
  return selectGroups(useStore.getState()).top.map(arrangeKey);
}

const folderByKey = (key: string) => selectGroups(useStore.getState()).projects.find((g) => g.key === key);

/** The top entries in the order shown, with one block (pinned folders, or the rest) in a new order. */
function moveTop(blockKeys: string[]) {
  const { top } = selectGroups(useStore.getState());
  const moved = new Set(blockKeys);
  const byKey = new Map(top.map((e) => [e.key, e]));
  const isPinned = (e: TopEntry) => e.kind === 'folder' && e.folder.pinned;
  const others = top.filter((e) => !moved.has(e.key));
  const block = blockKeys.flatMap((k) => byKey.get(k) ?? []);
  const pinnedBlock = block.some(isPinned);
  const ordered = pinnedBlock ? [...block, ...others] : [...others.filter(isPinned), ...block, ...others.filter((e) => !isPinned(e))];
  void arrangeSidebar(ordered.map(arrangeKey));
}

/** What a drag at the top does: a new order, or a loose folder into a project. */
const TOP_DROP: FolderDrop = {
  reorder: moveTop,
  into: (key, into) => {
    const f = folderByKey(key);
    if (f && into.startsWith('group:')) void addToGroup(f.path, into.slice(6));
  },
};

/** What a drag inside a project does: its folders in a new order, or one out of it, beside it. */
const innerDrops = new Map<string, FolderDrop>();
function innerDrop(setId: string): FolderDrop {
  let d = innerDrops.get(setId);
  if (!d) {
    d = {
      reorder: (keys) => void arrangeSidebar([], { [setId]: keys.flatMap((k) => folderByKey(k)?.path ?? []) }),
      out: (key, from, side) => {
        const f = folderByKey(key);
        if (!f) return;
        const top = topArrangeKeys();
        const at = top.indexOf(from);
        top.splice(at < 0 ? top.length : side === 'before' ? at : at + 1, 0, f.path);
        void arrangeSidebar(top);
      },
    };
    innerDrops.set(setId, d);
  }
  return d;
}

/** Alt+Up / Alt+Down: one place within its block, the focus staying on the header. */
function nudge(key: string, by: -1 | 1, inSet?: string) {
  const { top } = selectGroups(useStore.getState());
  if (inSet) {
    const set = top.find((e): e is SetGroup => e.kind === 'group' && e.id === inSet);
    const next = set && nudgeFolder(set.folders.map((f) => f.key), key, by);
    if (next) innerDrop(inSet).reorder(next);
    return;
  }
  const pinned = (e: TopEntry) => e.kind === 'folder' && e.folder.pinned;
  const me = top.find((e) => e.key === key);
  if (!me) return;
  const block = top.filter((e) => pinned(e) === pinned(me));
  const next = nudgeFolder(
    block.map((e) => e.key),
    key,
    by,
  );
  if (next) moveTop(next);
}

// ── scrolling: rows passing under a still pointer do not hover ──

/**
 * While the list scrolls, rows stop answering the pointer: otherwise every row that slides under
 * it restyles (and builds its tools), which was nine tenths of a scroll's cost with many rows.
 * Only a scroll the wheel (or a touchpad) drives raises the shield: the list also scrolls when a
 * folder near its end folds shut (its end comes up) or a row is brought into view, and a shield
 * then would take the clicks meant for the header under the pointer.
 */
let scrollIdle = 0;
let wheelAt = -Infinity;
function onListWheel(e: { timeStamp: number }) {
  wheelAt = e.timeStamp;
}
function onListScroll(e: { currentTarget: HTMLElement; timeStamp: number }) {
  const list = e.currentTarget;
  if (!scrollIdle) {
    if (e.timeStamp - wheelAt > 250) return;
    list.style.setProperty('--shield-h', `${list.clientHeight}px`);
    list.dataset.scrolling = '';
  }
  window.clearTimeout(scrollIdle);
  scrollIdle = window.setTimeout(() => {
    scrollIdle = 0;
    delete list.dataset.scrolling;
  }, 140);
}

/**
 * A folder folding shut near the end of a scrolled list would bring the list's end up: everything
 * slides down, the header under the pointer with it, and the next quick click lands on the folder
 * above. While the pointer stays in the list its rows keep the height they had (empty ground at the
 * end, if it is scrolled to); they let go when the pointer leaves the list.
 */
function holdListEnd(from: Element) {
  const rows = from.closest<HTMLElement>('.side-rows');
  const list = rows?.closest<HTMLElement>('.side-list');
  if (!rows || !list || list.scrollHeight <= list.clientHeight || !list.matches(':hover')) return;
  const h = rows.offsetHeight;
  if ((parseFloat(rows.style.minHeight) || 0) < h) rows.style.minHeight = `${h}px`;
  if (list.dataset.holdEnd !== undefined) return;
  list.dataset.holdEnd = '';
  list.addEventListener(
    'pointerleave',
    () => {
      rows.style.minHeight = '';
      delete list.dataset.holdEnd;
    },
    { once: true },
  );
}

// ── keyboard: one tab stop for the whole list, arrows inside it ──

/**
 * A session opened from elsewhere (the palette, home, a notice) brings its row into view when it is
 * scrolled out of the list, centred so its folder shows. The row may arrive late (an unfolded folder, a new session drawn after
 * the send's frames), so look a few times; a row already in view is left where it is.
 */
function revealRow(id: string): () => void {
  let timer = 0;
  let tries = 0;
  const look = () => {
    const row = document.querySelector<HTMLElement>(`.side-list .srow-main[data-id="${CSS.escape(id)}"]`);
    const list = row?.closest<HTMLElement>('.side-list');
    if (row && list) {
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      // The list only: scrollIntoView would also move clipped ancestors.
      if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
      return;
    }
    if (++tries < 6) timer = window.setTimeout(look, 250);
  };
  timer = window.setTimeout(look, 60);
  return () => window.clearTimeout(timer);
}

// Collapsed folders unmount their rows, so every match is a visible item (no layout read per key).
const navItems = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-nav]')];

function focusItem(el: HTMLElement | undefined) {
  if (!el) return;
  el.focus();
  el.scrollIntoView({ block: 'nearest' });
}

/** Tabbing into the list lands on the open session (or the first row); the list itself steps aside. */
function onListFocus(e: FocusEvent<HTMLDivElement>) {
  const list = e.currentTarget;
  if (e.target !== list) {
    list.tabIndex = -1;
    return;
  }
  const items = navItems(list);
  focusItem(items.find((el) => el.getAttribute('aria-current') === 'page') ?? items[0]);
}

function onListBlur(e: FocusEvent<HTMLDivElement>) {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.tabIndex = 0;
}

/**
 * Up and Down move between rows and folder headers, Home and End to the ends; Right opens a
 * folder, Left closes it (or, on a row, goes to its folder). Enter and Space activate, F2
 * renames, Delete deletes, the menu key or Shift+F10 opens the row's menu.
 */
function onListKey(e: KeyboardEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT') return;
  const list = e.currentTarget;
  const current = target.closest<HTMLElement>('[data-nav]');
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (!current) return;
    e.preventDefault();
    const folder = current.dataset.folder;
    const expanded = current.getAttribute('aria-expanded');
    if (folder && expanded !== null) {
      if ((e.key === 'ArrowRight') !== (expanded === 'true')) current.click();
      else if (e.key === 'ArrowRight') focusItem(navItems(list)[navItems(list).indexOf(current) + 1]);
    } else if (e.key === 'ArrowLeft') {
      focusItem(current.closest('.sgroup')?.querySelector<HTMLElement>('.sgroup-toggle') ?? undefined);
    }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = navItems(list);
  if (!items.length) return;
  e.preventDefault();
  const i = current ? items.indexOf(current) : -1;
  let next = 0;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (i < 0) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
  else next = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  focusItem(items[next]);
}

// ── collapse: the stage widens or narrows without laying the conversation out every frame ──

/**
 * While the sidebar opens or closes, the stage's box animates its width (the sidebar's width
 * transition in app.css) but the view inside it keeps one width, the wider of the two, anchored
 * to the stage's right edge, and slides by half the difference so its centre column glides
 * exactly where the resizing stage puts it. One layout at the start (when the stage grows) or
 * at the end (when it narrows) instead of one per frame; the backdrop's canvas resizes once.
 */
function useStageFreeze() {
  useEffect(() => {
    let timer = 0;
    let anims: Animation[] = [];
    const release = (body: HTMLElement | null) => {
      window.clearTimeout(timer);
      for (const a of anims) a.cancel();
      anims = [];
      if (body) {
        delete body.dataset.freeze;
        body.style.removeProperty('--freeze-w');
      }
    };
    return useStore.subscribe((s, p) => {
      if (s.ui.sidebarOpen === p.ui.sidebarOpen) return;
      const body = document.querySelector<HTMLElement>('.stage > .stage-body');
      const side = document.querySelector<HTMLElement>('.app-side');
      const inner = side?.firstElementChild as HTMLElement | null;
      release(body);
      if (!body || !side || !inner || reducedMotion()) return;
      const cs = getComputedStyle(side);
      const ms = parseFloat(cs.transitionDuration) * (cs.transitionDuration.trim().endsWith('ms') ? 1 : 1000);
      if (!(ms > 20)) return;
      const opening = s.ui.sidebarOpen;
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 0;
      const w0 = body.clientWidth;
      const delta = inner.offsetWidth + gap;
      const w1 = opening ? w0 - delta : w0 + delta;
      if (w1 <= 0) return;
      const from = opening ? 0 : (w1 - w0) / 2;
      const to = opening ? (w0 - w1) / 2 : 0;
      body.style.setProperty('--freeze-w', `${Math.max(w0, w1)}px`);
      body.dataset.freeze = '';
      const easing = cs.transitionTimingFunction.split(/,(?![^(]*\))/)[0]?.trim() || 'ease-out';
      for (const view of body.querySelectorAll<HTMLElement>(':scope > .stage-view')) {
        anims.push(view.animate([{ translate: `${from}px 0` }, { translate: `${to}px 0` }], { duration: ms, easing }));
      }
      timer = window.setTimeout(() => release(body), ms + 20);
    });
  }, []);
}
