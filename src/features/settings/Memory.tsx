import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MemoryFile, ProviderId } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { baseName, relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { Kbd, Segmented, Spinner } from '@/ui';
import { oneOfEach } from './files';
import { CodeChip, Empty, Skeleton, useContextTarget, Scope } from './parts';

/** Unsaved edits by file path. Module level, so they survive switching sections or closing Settings. */
const drafts = new Map<string, string>();

const SCOPE_HELP: Record<MemoryFile['scope'], string> = {
  user: 'Applies to every project on this computer. Only you see it.',
  project: 'Shared with everyone who works in this repository. Commit it.',
  local: 'Only for you, in this project. Keep it out of version control.',
};

const SCOPE_NAME: Record<MemoryFile['scope'], string> = { user: 'User', project: 'Project', local: 'Local' };

function labels(files: MemoryFile[], cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const count: Record<string, number> = {};
  for (const f of files) count[f.scope] = (count[f.scope] ?? 0) + 1;
  for (const f of files) {
    const name = SCOPE_NAME[f.scope];
    if (count[f.scope] > 1) {
      const rel = relPath(f.path, cwd).replace(/\\/g, '/');
      out[f.path] = rel.includes('/') ? `${name} (${rel.split('/')[0]})` : name;
    } else out[f.path] = name;
  }
  return out;
}

export function Memory() {
  const { provider, cwd } = useContextTarget();
  const setUi = useStore((s) => s.setUi);
  if (!cwd) {
    return (
      <div className="set-stack">
        <div className="card set-card">
          <Empty>
            Choose a project folder to edit its instruction files.
            <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setUi({ settings: null, projectPicker: true })}>
              <Icon name="folder-plus" size={14} />
              Open a folder
            </button>
          </Empty>
        </div>
      </div>
    );
  }
  return <MemoryEditor key={`${provider}:${cwd}`} provider={provider} cwd={cwd} />;
}

function MemoryEditor({ provider, cwd }: { provider: ProviderId; cwd: string }) {
  const home = useStore((s) => s.home);
  const toast = useStore((s) => s.toast);
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    bridge
      .call('memory.list', { cwd, provider })
      .then((all) => {
        if (!live) return;
        const list = oneOfEach(all);
        setFiles(list);
        // Start on the project file when it exists, else the first one that does.
        setSelected((cur) => cur ?? (list.find((f) => f.scope === 'project' && f.exists) ?? list.find((f) => f.exists) ?? list[0])?.path ?? null);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [cwd, provider]);

  const names = useMemo(() => (files ? labels(files, cwd) : {}), [files, cwd]);
  const file = files?.find((f) => f.path === selected);
  const saved = file?.content ?? '';
  const draft = file ? (drafts.get(file.path) ?? saved) : '';
  const dirty = !!file && drafts.has(file.path) && draft !== saved;
  const showEditor = !!file && (file.exists || creating.has(file.path) || drafts.has(file.path));
  const isDirty = (f: MemoryFile) => drafts.has(f.path) && drafts.get(f.path) !== (f.content ?? '');

  const setDraft = (text: string) => {
    if (!file) return;
    if (text === saved && file.exists) drafts.delete(file.path);
    else drafts.set(file.path, text);
    bump((n) => n + 1);
  };

  const save = useCallback(async () => {
    if (!file || saving || (!dirty && file.exists)) return;
    setSaving(true);
    const content = drafts.get(file.path) ?? saved;
    try {
      await bridge.call('memory.write', { path: file.path, content });
      drafts.delete(file.path);
      setFiles((list) => list?.map((f) => (f.path === file.path ? { ...f, exists: true, content } : f)) ?? null);
      toast(`Saved ${baseName(file.path)}`, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }, [file, saving, dirty, saved, toast]);

  const revert = () => {
    if (!file) return;
    drafts.delete(file.path);
    if (!file.exists) setCreating((s) => (s.delete(file.path), new Set(s)));
    bump((n) => n + 1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
      setDraft(el.value);
    }
  };

  if (error) {
    return (
      <div className="card set-card">
        <Empty>Could not read the instruction files: {error}</Empty>
      </div>
    );
  }
  if (!files) {
    return (
      <div className="card set-card">
        <Skeleton rows={2} />
      </div>
    );
  }
  if (!files.length || !file) {
    return (
      <div className="card set-card">
        <Empty>{PROVIDER_NAME[provider]} has no instruction files.</Empty>
      </div>
    );
  }

  return (
    <div className="mem">
      <div className="set-toolbar">
        <Segmented
          id="set-memory"
          value={file.path}
          onChange={setSelected}
          options={files.map((f) => ({
            value: f.path,
            label: (
              <span className="mem-tab" data-missing={!f.exists || undefined}>
                {names[f.path]}
                {isDirty(f) && <span className="mem-dirty-dot" aria-label="Unsaved changes" />}
              </span>
            ),
          }))}
        />
        <span className="grow" />
        <Scope provider={provider} cwd={cwd} />
      </div>

      <div className="mem-info">
        <CodeChip text={relPath(file.path, cwd, home)} label="Copy path" />
        <span className="mem-scope">{SCOPE_HELP[file.scope]}</span>
      </div>

      {showEditor ? (
        <>
          <textarea
            ref={area}
            className="mem-editor well scroll"
            value={draft}
            spellCheck={false}
            autoFocus={creating.has(file.path)}
            aria-label={`Contents of ${baseName(file.path)}`}
            placeholder={`# Instructions for ${PROVIDER_NAME[provider]}\n\nHow to build, test and lint. Conventions the agent should follow.`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="mem-bar">
            <span className="mem-state" data-state={dirty ? 'dirty' : !file.exists ? 'new' : 'clean'}>
              {dirty ? (
                <>
                  <span className="mem-dirty-dot" />
                  Unsaved changes
                </>
              ) : !file.exists ? (
                'New file, not saved yet'
              ) : (
                <>
                  <Icon name="check" size={13} />
                  Saved
                </>
              )}
            </span>
            <span className="grow" />
            <button type="button" className="btn btn-ghost" disabled={!dirty && file.exists} onClick={revert}>
              {file.exists ? 'Revert' : 'Discard'}
            </button>
            <button type="button" className="btn btn-primary" disabled={saving || (!dirty && file.exists)} onClick={() => void save()}>
              {saving ? <Spinner size={13} /> : null}
              {file.exists ? 'Save' : 'Create file'}
              <Kbd combo="mod+s" className="mem-save-kbd" />
            </button>
          </div>
        </>
      ) : (
        <div className="mem-missing well">
          <Icon name="file-plus" size={20} />
          <p>
            <span className="mem-missing-title">{baseName(file.path)} does not exist yet.</span>
            <span className="faint">{PROVIDER_NAME[provider]} will read it once you create it.</span>
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setCreating((s) => new Set(s).add(file.path));
            }}
          >
            <Icon name="plus" size={14} />
            Create
          </button>
        </div>
      )}
    </div>
  );
}
