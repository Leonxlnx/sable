import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { DirEntry } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { bridge } from '@/lib/bridge';
import { relPath } from '@/lib/format';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Spinner } from '@/ui';
import { StatusLetter } from './ChangesTab';
import { FilePreview } from './FilePreview';
import { useRepo } from './git-state';
import { isAbsolute, isImagePath, joinPath } from './util';

type DirState = { entries?: DirEntry[]; loading?: boolean; error?: string };

/** A version control system's own folder is never something to open from here. */
const VCS = new Set(['.git', '.hg', '.svn']);

interface Row {
  entry: DirEntry;
  depth: number;
  parent: string | null;
  /** Folder whose children are loading or failed, shown as a quiet line under it. */
  note?: 'loading' | 'error';
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const normKey = (p: string) => norm(p).toLowerCase();

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|html?|vue|svelte|py|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|ps1|ya?ml|toml|sql|lua)$/i;

function fileIcon(name: string): IconName {
  if (isImagePath(name)) return 'image';
  if (CODE_EXT.test(name)) return 'file-code';
  if (/\.(md|mdx|txt|rst|log)$/i.test(name)) return 'file-text';
  return 'file';
}

export function FilesTab({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  void sessionId;
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const repo = useRepo(cwd);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const load = useCallback((path: string, force = false) => {
    const k = normKey(path);
    const cur = dirsRef.current[k];
    if (!force && (cur?.entries || cur?.loading)) return;
    setDirs((d) => ({ ...d, [k]: { ...d[k], loading: true, error: undefined } }));
    bridge
      .call('fs.list', { path })
      .then((r) => setDirs((d) => ({ ...d, [k]: { entries: r.entries.filter((e) => !VCS.has(e.name)) } })))
      .catch((err: Error) => setDirs((d) => ({ ...d, [k]: { error: err.message || String(err) } })));
  }, []);

  useEffect(() => {
    if (cwd) load(cwd);
  }, [cwd, load]);

  // Files touched elsewhere (the panel was asked to show one): open its preview.
  const railFile = useStore((s) => s.ui.railFile);
  const seenFile = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!railFile || railFile === seenFile.current) return;
    seenFile.current = railFile;
    setPreview(isAbsolute(railFile) ? railFile : joinPath(cwd, railFile));
  }, [railFile, cwd]);

  // Working-tree status per path, and which folders contain changes.
  const changes = useMemo(() => {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    if (repo?.status?.isRepo) {
      for (const f of repo.status.files) {
        const p = norm(f.path).toLowerCase();
        files.set(p, f.status);
        let i = p.lastIndexOf('/');
        while (i > 0) {
          folders.add(p.slice(0, i));
          i = p.lastIndexOf('/', i - 1);
        }
      }
    }
    return { files, folders };
  }, [repo?.status]);

  const q = filter.trim().toLowerCase();

  // Which loaded entries match the filter, directly or through a loaded descendant.
  const matches = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    const through = new Set<string>();
    const visit = (dir: string): boolean => {
      const entries = dirs[normKey(dir)]?.entries;
      if (!entries) return false;
      let any = false;
      for (const e of entries) {
        const self = e.name.toLowerCase().includes(q);
        const below = e.dir && !e.ignored ? visit(e.path) : false;
        if (self || below) {
          keep.add(normKey(e.path));
          if (below) through.add(normKey(e.path));
          any = true;
        }
      }
      return any;
    };
    visit(cwd);
    return { keep, through };
  }, [q, dirs, cwd]);

  const isOpen = useCallback((k: string) => expanded.has(k) || !!matches?.through.has(k), [expanded, matches]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const st = dirs[normKey(dir)];
      const entries = st?.entries;
      if (!entries) return;
      for (const e of entries) {
        const k = normKey(e.path);
        if (matches && !matches.keep.has(k)) continue;
        out.push({ entry: e, depth, parent: depth === 0 ? null : dir });
        if (!e.dir) continue;
        const open = isOpen(k);
        if (!open) continue;
        const child = dirs[k];
        if (child?.entries) walk(e.path, depth + 1);
        else if (child?.loading || child?.error) out.push({ entry: e, depth: depth + 1, parent: e.path, note: child.error ? 'error' : 'loading' });
      }
    };
    walk(cwd, 0);
    return out;
  }, [dirs, cwd, matches, isOpen]);

  const toggle = useCallback(
    (e: DirEntry, open?: boolean) => {
      const k = normKey(e.path);
      setExpanded((s) => {
        const isOpen = s.has(k);
        const want = open ?? !isOpen;
        if (want === isOpen) return s;
        const n = new Set(s);
        if (want) n.add(k);
        else n.delete(k);
        return n;
      });
      if (open !== false) load(e.path);
    },
    [load],
  );

  const activate = useCallback(
    (e: DirEntry) => {
      setFocus(normKey(e.path));
      if (e.dir) toggle(e);
      else setPreview(e.path);
    },
    [toggle],
  );

  const navRows = rows.filter((r) => !r.note);
  const focusIndex = Math.max(
    0,
    navRows.findIndex((r) => normKey(r.entry.path) === focus),
  );

  const focusRow = (i: number) => {
    const r = navRows[Math.max(0, Math.min(navRows.length - 1, i))];
    if (!r) return;
    const k = normKey(r.entry.path);
    setFocus(k);
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)?.focus());
  };

  const onTreeKey = (ev: React.KeyboardEvent) => {
    const r = navRows[focusIndex];
    if (!r) return;
    const k = normKey(r.entry.path);
    const open = r.entry.dir && isOpen(k);
    switch (ev.key) {
      case 'ArrowDown':
        focusRow(focusIndex + 1);
        break;
      case 'ArrowUp':
        if (focusIndex === 0) {
          tree.current?.parentElement?.querySelector<HTMLInputElement>('.fl-filter input')?.focus();
          break;
        }
        focusRow(focusIndex - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(navRows.length - 1);
        break;
      case 'ArrowRight':
        if (r.entry.dir && !open) toggle(r.entry, true);
        else if (r.entry.dir) focusRow(focusIndex + 1);
        break;
      case 'ArrowLeft':
        if (r.entry.dir && open) toggle(r.entry, false);
        else if (r.parent) {
          const pk = normKey(r.parent);
          focusRow(navRows.findIndex((x) => normKey(x.entry.path) === pk));
        }
        break;
      case 'Enter':
      case ' ':
        activate(r.entry);
        break;
      default:
        return;
    }
    ev.preventDefault();
  };

  const root = dirs[normKey(cwd)];

  const back = () => {
    setPreview(null);
    requestAnimationFrame(() => {
      const el = focus ? tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`) : null;
      el?.focus({ preventScroll: true });
    });
  };

  return (
    <div className="rail-col fl">
      <AnimatePresence initial={false}>
        {preview && (
          <motion.div
            key={preview}
            className="rail-col fl-layer fl-preview"
            initial={{ opacity: 0, x: 22 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 22 }}
            transition={{ type: 'spring', stiffness: 460, damping: 38 }}
          >
            <FilePreview path={preview} cwd={cwd} status={changes.files.get(relPath(preview, cwd).toLowerCase())} onBack={back} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="rail-col fl-layer fl-main" data-away={preview ? '' : undefined} inert={!!preview}>
            <div className="rail-bar rail-bar-field">
              <label className="fl-filter">
                <Icon name="search" size={14} />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files"
                  aria-label="Filter files"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      focusRow(0);
                    } else if (e.key === 'Escape' && filter) {
                      e.preventDefault();
                      e.stopPropagation();
                      setFilter('');
                    }
                  }}
                />
                {filter && (
                  <button type="button" className="fl-clear" aria-label="Clear filter" onClick={() => setFilter('')}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </label>
              <span className="rail-bar-actions">
                <IconButton icon="collapse" label="Collapse folders" size={14} disabled={!expanded.size} onClick={() => setExpanded(new Set())} />
                <IconButton
                  icon="refresh"
                  label="Refresh"
                  size={14}
                  onClick={() => {
                    load(cwd, true);
                    for (const k of expanded) {
                      const r = rows.find((x) => normKey(x.entry.path) === k);
                      if (r) load(r.entry.path, true);
                    }
                  }}
                />
              </span>
            </div>
            <div className="rail-scroll scroll">
              {!root || (root.loading && !root.entries) ? (
                <div className="rail-loading">
                  <Spinner />
                  Reading the folder
                </div>
              ) : root.error ? (
                <p className="rail-empty">{root.error}</p>
              ) : rows.length === 0 ? (
                <p className="rail-empty">{q ? 'Nothing matches this filter.' : 'This folder is empty.'}</p>
              ) : (
                <div className="fl-tree" role="tree" aria-label="Files" ref={tree} onKeyDown={onTreeKey}>
                  {rows.map((r, i) =>
                    r.note ? (
                      <div key={`note:${r.entry.path}`} className="fl-note" style={{ '--depth': r.depth } as CSSProperties}>
                        {r.note === 'loading' ? 'Loading' : 'Could not read this folder'}
                      </div>
                    ) : (
                      <TreeRow
                        key={r.entry.path}
                        row={r}
                        open={r.entry.dir && isOpen(normKey(r.entry.path))}
                        focused={i === rows.indexOf(navRows[focusIndex])}
                        status={r.entry.dir ? undefined : changes.files.get(relPath(r.entry.path, cwd).toLowerCase())}
                        changedInside={r.entry.dir && changes.folders.has(relPath(r.entry.path, cwd).toLowerCase())}
                        query={q}
                        cwd={cwd}
                        onActivate={activate}
                        onFocus={setFocus}
                      />
                    ),
                  )}
                </div>
              )}
            </div>
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  row,
  open,
  focused,
  status,
  changedInside,
  query,
  cwd,
  onActivate,
  onFocus,
}: {
  row: Row;
  open: boolean;
  focused: boolean;
  status?: string;
  changedInside: boolean;
  query: string;
  cwd: string;
  onActivate: (e: DirEntry) => void;
  onFocus: (k: string) => void;
}) {
  const { entry, depth } = row;
  const k = normKey(entry.path);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={entry.dir ? open : undefined}
      aria-selected={focused}
      tabIndex={focused ? 0 : -1}
      data-key={k}
      className="fl-row rail-row-host"
      data-ignored={entry.ignored || undefined}
      data-dir={entry.dir || undefined}
      style={{ '--depth': depth } as CSSProperties}
      onClick={() => onActivate(entry)}
      onFocus={() => onFocus(k)}
    >
      <span className="fl-caret" aria-hidden>
        {entry.dir && <Icon name="caret-right" size={10} className={open ? 'is-open' : undefined} />}
      </span>
      <Icon name={entry.dir ? (open ? 'folder-open' : 'folder') : fileIcon(entry.name)} size={14} className="fl-icon" />
      <span className="fl-name truncate">{highlight(entry.name, query)}</span>
      <span className="rail-row-deco fl-deco">
        {status && <StatusLetter status={status} small />}
        {!status && changedInside && <span className="fl-dot" aria-label="Contains changes" />}
      </span>
      <span className="rail-row-acts fl-acts">
        <IconButton
          icon="at"
          label="Mention in chat"
          size={14}
          tabIndex={-1}
          onClick={(ev) => {
            ev.stopPropagation();
            focusComposer('@' + relPath(entry.path, cwd) + (entry.dir ? '/ ' : ' '), { append: true });
          }}
        />
      </span>
    </div>
  );
});

function highlight(name: string, q: string) {
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="fl-mark">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </>
  );
}
