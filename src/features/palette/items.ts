import type { Capabilities, ProviderId, SessionMeta } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import type { IconName } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { skillLabeller } from '@/lib/skills';
import { SECTIONS as SETTINGS_SECTIONS } from '@/features/settings/sections';
import { openImport } from '@/features/history/History';
import { checkForUpdate, goHome, interrupt, openSession, openSettings, switchAgent } from '@/state/actions';
import { RAIL_TABS, railTabKeys } from '@/features/rail/tabs';
import { getScripts, runScriptInPanel } from '@/features/rail/scripts-store';
import { focusComposer } from '@/state/hooks';
import { createLane } from '@/features/session/lane';
import { openRace, raceFolder } from '@/features/race/race';
import { useStore, type RailTab } from '@/state/store';

export type PaletteGroup = 'Recent' | 'Sessions' | 'Projects' | 'Actions' | 'Commands' | 'Skills';

export interface PaletteItem {
  id: string;
  group: Exclude<PaletteGroup, 'Recent'>;
  title: string;
  sub?: string;
  /** Extra words that match but are not shown. */
  keywords?: string;
  icon?: IconName;
  tone?: string;
  keys?: string;
  session?: SessionMeta;
  run: () => void;
}

/** Extra words for the panel's tabs in the palette. */
const RAIL_WORDS: Partial<Record<RailTab, string>> = {
  browser: 'panel show web page preview localhost url',
  device: 'panel show android phone emulator screen app mobile',
  changes: 'panel show diff git review',
};

const SKILL_TONE = 'var(--ember)';

/** Everything the palette can do right now, built fresh each time it opens or the store changes. */
export function buildItems(opts: {
  sessions: SessionMeta[];
  projects: { path: string; name: string }[];
  activeId: string | null;
  active?: SessionMeta;
  installed: ProviderId[];
  homeProvider: ProviderId;
  caps?: Capabilities;
  /** A session's account name, only when its agent has several accounts. */
  accountName?: (s: SessionMeta) => string | undefined;
}): PaletteItem[] {
  const { setUi } = useStore.getState();
  const ui = () => useStore.getState().ui;
  const items: PaletteItem[] = [];

  for (const s of opts.sessions) {
    items.push({
      id: `session:${s.id}`,
      group: 'Sessions',
      title: s.title,
      sub: [baseName(s.cwd), opts.accountName?.(s)].filter(Boolean).join(' · '),
      keywords: `${PROVIDER_NAME[s.provider]}${s.archived ? ' archived' : ''}`,
      session: s,
      run: () => openSession(s.id),
    });
  }

  for (const p of opts.projects) {
    items.push({
      id: `project:${p.path}`,
      group: 'Projects',
      title: p.name || baseName(p.path),
      sub: tildePath(p.path, useStore.getState().home),
      icon: 'folder',
      run: () => goHome(p.path),
    });
  }

  const act = (id: string, title: string, icon: IconName, run: () => void, extra: Partial<PaletteItem> = {}) =>
    items.push({ id: `action:${id}`, group: 'Actions', title, icon, run, ...extra });

  act('new', 'New session', 'compose', () => goHome(), { keys: 'mod+shift+o', keywords: 'start create chat' });
  act('open-folder', 'Open a folder', 'folder-plus', () => setUi({ projectPicker: true }), { keys: 'mod+o', keywords: 'project add browse' });
  act('history', 'History', 'history', () => setUi({ historyOpen: true }), { keywords: 'resume past conversations' });
  act('import', 'Import conversations', 'download', () => openImport(), { keywords: 'continue claude code codex cli desktop app history resume' });
  act('settings', 'Settings', 'settings', () => openSettings(), { keys: 'mod+,', keywords: 'preferences' });
  for (const s of SETTINGS_SECTIONS) {
    if (s.id === 'shortcuts') continue;
    act(`settings:${s.id}`, s.label, s.icon, () => openSettings(s.id), { sub: 'Settings', keywords: `settings preferences ${s.keywords}` });
  }
  act('toggle-sidebar', ui().sidebarOpen ? 'Hide sidebar' : 'Show sidebar', 'sidebar', () => setUi({ sidebarOpen: !ui().sidebarOpen }), {
    keys: 'mod+b',
    keywords: 'toggle sidebar',
  });

  if (opts.active) {
    const id = opts.active.id;
    act('toggle-panel', ui().railOpen ? 'Hide panel' : 'Show panel', 'sidebar', () => setUi({ railOpen: !ui().railOpen }), { keys: 'mod+j', keywords: 'toggle panel rail' });
    for (const t of RAIL_TABS) {
      const title = t.id === 'browser' ? 'Open browser' : t.label;
      act(`panel:${t.id}`, title, t.icon, () => setUi({ railOpen: true, railTab: t.id }), { sub: 'Panel', keys: railTabKeys(t.id), keywords: RAIL_WORDS[t.id] ?? 'panel show open' });
    }
    // Switch agent: the same chat goes on with Claude Code or Codex (and back), from a handover.
    const other: ProviderId | undefined = opts.active.provider === 'claude' ? 'codex' : opts.active.provider === 'codex' ? 'claude' : undefined;
    if (other && opts.installed.includes(other))
      act(`switch:${other}`, `Switch to ${PROVIDER_NAME[other]}`, 'arrow-right', () => void switchAgent(id, other), { keywords: 'continue handover switch agent move conversation' });
    // Lanes: a worktree of its own for this chat, now (its conversation goes along).
    const lane = opts.active.lane;
    if (lane) act('lane:changes', 'Land or discard the lane', 'fork', () => setUi({ railOpen: true, railTab: 'changes' }), { keywords: `lane worktree branch merge land discard ${lane.branch}` });
    else if (!opts.active.chat) act('lane:create', 'Move chat to a lane', 'fork', () => void createLane(id), { keywords: 'lane worktree branch isolate parallel git' });
    const s = opts.active.status;
    if (s === 'running' || s === 'starting' || s === 'awaiting') {
      act('stop', 'Stop the current session', 'stop', () => void interrupt(id), { keywords: 'interrupt cancel halt', tone: 'var(--red)' });
    }
  }

  // Race: one task to two agents at once, each in a lane of its own made from this folder.
  const racing = opts.active?.race && !opts.active.race.outcome ? opts.active.race : null;
  if (racing) act('race:show', 'Show the race', 'compare', () => openRace(racing.id), { keywords: 'race side by side both agents compare' });
  const raceCwd = opts.active ? raceFolder(opts.active, null) : ui().homeChat ? null : ui().homeCwd;
  if (raceCwd && !racing) act('race', 'Race', 'compare', () => focusComposer('/race '), { sub: baseName(raceCwd), keywords: 'race two agents claude code codex both compare lanes worktree' });

  for (const p of opts.installed) {
    if (p === opts.homeProvider && !opts.activeId) continue;
    act(`provider:${p}`, `New session with ${PROVIDER_NAME[p]}`, 'compose', () => (setUi({ homeProvider: p }), goHome()), { sub: 'Switch provider', keywords: 'switch provider agent' });
  }

  act('shortcuts', 'Keyboard shortcuts', 'keyboard', () => openSettings('shortcuts'), { keywords: 'keys hotkeys bindings' });
  // Desktop only: a dev or standalone bridge has no updates to check.
  const update = useStore.getState().update;
  if (update && update.status !== 'unsupported')
    act('update', 'Check for updates', 'reload', () => void checkForUpdate(), { keywords: 'update upgrade version release new' });

  // ── project scripts (run1): "Run dev" for the open session's folder, in its Terminal tab ──
  if (opts.active) {
    const { id: sid, cwd } = opts.active;
    for (const sc of getScripts(cwd)?.scripts ?? []) {
      act(`script:${sc.source}:${sc.name}`, `Run ${sc.name}`, 'play', () => runScriptInPanel(sid, cwd, sc), { sub: sc.run, keywords: `script terminal ${sc.command}` });
    }
  }

  if (opts.caps) {
    const seen = new Set<string>();
    const label = skillLabeller([...opts.caps.commands.map((c) => c.name), ...opts.caps.skills.map((s) => s.name)]);
    for (const c of opts.caps.commands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const isSkill = c.kind === 'skill';
      items.push({
        id: `cmd:${c.name}`,
        group: isSkill ? 'Skills' : 'Commands',
        title: `${isSkill ? opts.caps.skillTrigger : '/'}${label(c.name)}`,
        sub: c.description,
        keywords: c.name,
        icon: isSkill ? 'skill' : 'prompt',
        tone: isSkill ? SKILL_TONE : undefined,
        run: () => focusComposer(`${isSkill ? opts.caps!.skillTrigger : '/'}${label(c.name)} `),
      });
    }
    for (const sk of opts.caps.skills) {
      if (seen.has(sk.name) || sk.enabled === false) continue;
      seen.add(sk.name);
      items.push({
        id: `skill:${sk.name}`,
        group: 'Skills',
        title: `${opts.caps.skillTrigger}${label(sk.name)}`,
        sub: sk.description,
        keywords: sk.name,
        icon: 'skill',
        tone: SKILL_TONE,
        run: () => focusComposer(`${opts.caps!.skillTrigger}${label(sk.name)} `),
      });
    }
  }

  return items;
}

// ── recently used ──

const RECENT_KEY = 'sable.palette.recent.v1';

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string) {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
