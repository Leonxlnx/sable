import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { STANDARD_SPEED, type Capabilities, type DirEntry, type Effort, type ModeInfo, type ModelInfo, type ProviderId } from '@shared/protocol';
import { offeredSpeeds } from '@shared/speed';
import { baseName, dirName } from '@desk/lib/format';
import { modelName, visibleModels } from '@desk/lib/models';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { homeFolder } from '@m/lib/race';
import { getState, setState, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { SPRING } from '@m/ui/motion';
import { Choice, Sheet } from '@m/ui/Sheet';

/**
 * What a new chat starts with: the agent, the folder (or none: the desktop makes one for it), the
 * model. The last choice is kept; the field on home shows it as three chips.
 */
const KEY = 'sable.newchat';
type Saved = { agent?: ProviderId; folder?: string; none?: boolean; model?: string; effort?: Effort; mode?: string; speed?: string };
const load = (): Saved => {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved) ?? {};
  } catch {
    return {};
  }
};
const save = (s: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
};

export interface NewChoice {
  agents: ProviderId[];
  agent: ProviderId | null;
  setAgent: (a: ProviderId) => void;
  recent: { path: string; at: number }[];
  /** null: no folder (a chat of its own). */
  folder: string | null;
  setFolder: (p: string | null) => void;
  models: { id: string; name: string }[];
  model?: string;
  setModel: (id: string) => void;
  /** The chosen model's levels of effort, and the one a new chat starts with. */
  efforts: Effort[];
  effort?: Effort;
  setEffort: (e: Effort) => void;
  /** Speeds beyond standard, with standard first (empty when the model has none). */
  speeds: { id: string; name: string }[];
  speed: string;
  setSpeed: (id: string) => void;
  modes: ModeInfo[];
  mode?: string;
  setMode: (id: string) => void;
}

export function useNewChat(active: boolean): NewChoice {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const [saved, setSaved] = useState<Saved>(load);
  const update = (patch: Saved) =>
    setSaved((cur) => {
      const next = { ...cur, ...patch };
      save(next);
      return next;
    });

  const agents = useMemo(
    () => (['claude', 'codex', 'opencode', 'demo'] as ProviderId[]).filter((id) => providers[id]?.installed && (id === 'demo' || providers[id]?.auth.loggedIn)),
    [providers],
  );
  const pick = (id?: ProviderId) => (id && agents.includes(id) ? id : undefined);
  const agent = pick(saved.agent) ?? pick(settings?.defaultProvider as ProviderId) ?? agents[0] ?? null;

  const recent = useMemo(() => {
    const seen = new Map<string, { path: string; at: number }>();
    for (const p of projects) if (!p.hidden) seen.set(p.path.toLowerCase(), { path: p.path, at: p.lastOpened });
    for (const s of Object.values(sessions)) {
      if (s.chat) continue;
      // A chat in a lane counts for the folder it came from, never for its worktree.
      const dir = homeFolder(s);
      const k = dir.toLowerCase();
      const cur = seen.get(k);
      if (!cur || cur.at < s.updatedAt) seen.set(k, { path: dir, at: Math.max(cur?.at ?? 0, s.updatedAt) });
    }
    return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 6);
  }, [projects, sessions]);
  const folder = saved.none ? null : (saved.folder ?? recent[0]?.path ?? null);
  // Models come from the agent's caps for a folder (no folder: the most recent one stands in).
  const capsFolder = folder ?? recent[0]?.path ?? null;
  const capsKey = agent && capsFolder ? `${agent}:${capsFolder}` : '';
  const caps = useStore((s) => (capsKey ? s.caps[capsKey] : undefined));
  useEffect(() => {
    if (!active || !agent || !capsFolder || getState().caps[`${agent}:${capsFolder}`] || getState().conn !== 'open') return;
    let live = true;
    conn
      .call('provider.caps', { provider: agent, cwd: capsFolder })
      .then((c: Capabilities) => live && setState((s) => ({ caps: { ...s.caps, [`${agent}:${capsFolder}`]: c } })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, agent, capsFolder]);

  const models = useMemo(() => (agent && caps ? visibleModels(agent, caps.models, settings?.modelVisibility).map((m) => ({ id: m.id, name: modelName(m) ?? m.name })) : []), [agent, caps, settings?.modelVisibility]);
  const mine = saved.agent === agent;
  const model =
    mine && saved.model && models.some((m) => m.id === saved.model)
      ? saved.model
      : (settings?.defaultModels[agent ?? 'claude'] ?? caps?.models.find((m) => m.isDefault)?.id ?? models[0]?.id);
  const info: ModelInfo | undefined = caps?.models.find((m) => m.id === model);
  const efforts = info?.efforts ?? [];
  const pickEffort = (e?: Effort) => (e && efforts.includes(e) ? e : undefined);
  const effort = pickEffort(mine ? saved.effort : undefined) ?? pickEffort(settings?.defaultEfforts[agent ?? 'claude']) ?? info?.defaultEffort ?? efforts[0];
  const extra = offeredSpeeds(info, false);
  const speeds = extra.length ? [{ id: STANDARD_SPEED, name: 'Standard' }, ...extra.map((x) => ({ id: x.id, name: x.name }))] : [];
  const speed = mine && saved.speed && speeds.some((x) => x.id === saved.speed) ? saved.speed : STANDARD_SPEED;
  const modes = caps?.modes ?? [];
  const pickMode = (m?: string) => (m && modes.some((x) => x.id === m) ? m : undefined);
  const mode = pickMode(mine ? saved.mode : undefined) ?? pickMode(settings?.defaultModes[agent ?? 'claude']) ?? modes[0]?.id;

  return {
    agents,
    agent,
    setAgent: (a) => update({ agent: a, model: undefined, effort: undefined, mode: undefined, speed: undefined }),
    recent,
    folder,
    setFolder: (p) => update(p === null ? { none: true } : { none: false, folder: p }),
    models,
    model,
    setModel: (id) => update({ agent: agent ?? undefined, model: id, effort: undefined, speed: undefined }),
    efforts,
    effort,
    setEffort: (e) => update({ agent: agent ?? undefined, model, effort: e }),
    speeds,
    speed,
    setSpeed: (id) => update({ agent: agent ?? undefined, model, speed: id }),
    modes,
    mode,
    setMode: (id) => update({ agent: agent ?? undefined, model, mode: id }),
  };
}

/** Starts the chat on the desktop: the snapshot comes back (the phone opens it). */
export async function createChat(c: NewChoice, text: string) {
  if (!c.agent) throw new Error('No agent is signed in on the computer');
  const cwd = c.folder ?? c.recent[0]?.path ?? '';
  return conn.call(
    'session.create',
    {
      provider: c.agent,
      cwd,
      ...(c.model ? { model: c.model } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
      ...(c.mode ? { mode: c.mode } : {}),
      ...(c.speed !== STANDARD_SPEED ? { speed: c.speed } : {}),
      ...(c.folder === null ? { chat: { text } } : {}),
    },
    90_000,
  );
}

export function AgentSheet({ open, onClose, c }: { open: boolean; onClose: () => void; c: NewChoice }) {
  return (
    <Sheet open={open} onClose={onClose} title="Agent">
      <div className="setup-list" role="radiogroup" aria-label="Agent">
        {c.agents.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={c.agent === id}
            className="setup-row setup-row-mark"
            data-on={c.agent === id || undefined}
            onClick={() => {
              haptic('select');
              c.setAgent(id);
              onClose();
            }}
          >
            <ProviderMark provider={id} size={20} />
            <span className="setup-row-name">{PROVIDER_NAME[id]}</span>
            <span className="setup-radio" aria-hidden>
              <i />
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** The folder: recent ones, none (a chat of its own), or the desktop's folders one level at a time. */
export function FolderSheet({ open, onClose, c }: { open: boolean; onClose: () => void; c: NewChoice }) {
  const [browse, setBrowse] = useState(false);
  useEffect(() => {
    if (!open) setBrowse(false);
  }, [open]);
  const pick = (p: string | null) => {
    haptic('select');
    c.setFolder(p);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={browse ? 'Choose a folder' : 'Folder'} tall={browse}>
      <AnimatePresence mode="popLayout" initial={false}>
        {browse ? (
          <motion.div key="browse" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={SPRING}>
            <FolderBrowser start={c.folder} onPick={pick} onCancel={() => setBrowse(false)} />
          </motion.div>
        ) : (
          <motion.div key="main" initial={{ opacity: 0, x: -40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={SPRING}>
            <div className="choices">
              {c.recent.map((r) => (
                <Choice key={r.path} selected={c.folder === r.path} onPick={() => pick(r.path)} icon={<Icon name="folder" size={18} />}>
                  <span className="path">
                    <span className="path-name">{baseName(r.path)}</span>
                    <span className="path-dir">{dirName(r.path)}</span>
                  </span>
                </Choice>
              ))}
              {c.folder && !c.recent.some((r) => r.path === c.folder) && (
                <Choice selected onPick={() => pick(c.folder)} icon={<Icon name="folder" size={18} />}>
                  <span className="path">
                    <span className="path-name">{baseName(c.folder)}</span>
                    <span className="path-dir">{dirName(c.folder)}</span>
                  </span>
                </Choice>
              )}
              <Choice selected={c.folder === null} onPick={() => pick(null)} icon={<Icon name="chat" size={18} />}>
                No folder
              </Choice>
              <button type="button" className="choice choice-quiet" onClick={() => (haptic('tap'), setBrowse(true))}>
                <span className="choice-icon">
                  <Icon name="plus" size={18} />
                </span>
                <span className="choice-label">Other folder</span>
                <Icon name="next" size={15} className="choice-caret" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}

/** The desktop's folders, one level at a time (folders only: the phone never lists files). */
function FolderBrowser({ start, onPick, onCancel }: { start: string | null; onPick: (path: string) => void; onCancel: () => void }) {
  const [here, setHere] = useState<{ path: string | null; parent: string | null; entries: DirEntry[] } | null>(null);
  const [error, setError] = useState<string>();
  const [dir, setDir] = useState(1);

  const load = async (p: string | null, d = 1) => {
    setError(undefined);
    try {
      if (p === null) {
        const r = await conn.call('fs.roots', {});
        setDir(d);
        setHere({ path: null, parent: null, entries: r.roots });
      } else {
        const r = await conn.call('fs.list', { path: p });
        setDir(d);
        setHere({ path: r.path, parent: r.parent, entries: r.entries.filter((e) => e.dir && !e.name.startsWith('.')) });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Back goes up one folder, then out of the browser (not out of the sheet).
  useEffect(
    () =>
      pushBack(() => {
        if (here?.path) void load(here.parent ?? null, -1);
        else onCancel();
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [here],
  );

  useEffect(() => {
    void load(start ? dirName(start) || null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="browser">
      <div className="browser-bar">
        <button type="button" className="icon-btn" aria-label="Up one folder" disabled={!here?.path} onClick={() => void load(here?.parent ?? null, -1)}>
          <Icon name="back" size={20} />
        </button>
        <span className="browser-here">{here?.path ? baseName(here.path) || here.path : 'This computer'}</span>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.div
          key={here?.path ?? 'roots'}
          className="choices browser-list"
          custom={dir}
          initial={{ opacity: 0, x: dir * 36 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: dir * -36 }}
          transition={SPRING}
        >
          {here?.path && <NewFolder parent={here.path} onMade={(p) => void load(p, 1)} />}
          {here?.entries.map((e) => (
            <button key={e.path} type="button" className="choice" onClick={() => (haptic('tap'), void load(e.path, 1))}>
              <span className="choice-icon">
                <Icon name="folder" size={18} />
              </span>
              <span className="choice-label">{e.name}</span>
              <Icon name="next" size={15} className="choice-caret" />
            </button>
          ))}
          {here && !here.entries.length && !here.path && <p className="empty">No folders here.</p>}
        </motion.div>
      </AnimatePresence>
      {here?.path && (
        <div className="sheet-foot">
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onPick(here.path!)}>
            Use {baseName(here.path) || here.path}
          </button>
        </div>
      )}
    </div>
  );
}

/** A new folder where the browser stands: the row becomes a name field; made, the browser opens it. */
function NewFolder({ parent, onMade }: { parent: string; onMade: (path: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await conn.call('phone.mkdir', { parent, name: n });
      haptic('success');
      setEditing(false);
      setName('');
      onMade(r.path);
    } catch (err) {
      haptic('deny');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <button type="button" className="choice choice-quiet" onClick={() => (haptic('tap'), setEditing(true))}>
        <span className="choice-icon">
          <Icon name="folderPlus" size={18} />
        </span>
        <span className="choice-label">New folder</span>
      </button>
    );
  return (
    <div className="choice new-folder">
      <span className="choice-icon">
        <Icon name="folderPlus" size={18} />
      </span>
      <input
        className="new-folder-input"
        autoFocus
        value={name}
        placeholder="Folder name"
        aria-label="Folder name"
        enterKeyHint="done"
        autoCapitalize="none"
        onChange={(e) => (setName(e.target.value), setError(undefined))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void make();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || busy} onClick={() => void make()}>
        {busy ? <span className="dots" /> : 'Make'}
      </button>
      {error && <span className="new-folder-error">{error}</span>}
    </div>
  );
}
