import type { Capabilities, CommandKind, SavedPrompt } from '@shared/protocol';
import type { IconName } from '@/icons';
import { baseName, dirName } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { skillLabeller } from '@/lib/skills';
import type { FileHit } from '@/lib/workspace';
import { fileIcon } from './file-icon';
import { goHome, interrupt, openSettings, renameSession } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { untilCommand } from './until';
import { spareCommand } from './spare';
import { raceCommand } from '@/features/race/race';
import { getPrompts, subscribePrompts } from '@/features/saved/prompts-store';

/** Slash commands Sable handles itself, before anything reaches the agent. */

export interface CommandCtx {
  sessionId: string | null;
  openModel: () => void;
  /** `/model <name>`: picks that model at once (another agent's switches the chat), never sent. */
  setModel?: (name: string) => void;
  openMode: () => void;
  openEffort: () => void;
  /** Switches between standard and the fastest speed the model offers; absent when it offers none. */
  toggleSpeed?: () => void;
}

export interface AppCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Only offered inside a session. */
  session?: boolean;
  /** A saved prompt (Settings › Prompts): listed under Prompts by its name; choosing it puts its text into the composer. */
  prompt?: SavedPrompt;
  run: (ctx: CommandCtx, arg: string) => void;
}

const ui = () => useStore.getState().setUi;

function copyLastAnswer(sessionId: string) {
  const s = useStore.getState();
  const d = s.data[sessionId];
  if (!d) return;
  for (let i = d.roots.length - 1; i >= 0; i--) {
    const item = d.items[d.roots[i]];
    if (item?.type === 'text' && item.text.trim()) {
      navigator.clipboard.writeText(item.text).then(
        () => s.toast('Copied the last answer', 'success'),
        () => s.toast('Could not reach the clipboard', 'error'),
      );
      return;
    }
  }
  s.toast('There is no answer to copy yet');
}

const BUILT_IN: AppCommand[] = [
  {
    name: 'new',
    description: 'Start a new session',
    run: ({ sessionId }) => {
      const s = useStore.getState();
      const meta = sessionId ? s.sessions[sessionId] : undefined;
      if (meta) s.setUi({ homeProvider: meta.provider });
      goHome(meta?.cwd);
    },
  },
  { name: 'model', description: 'Choose the model', run: (c, arg) => (arg && c.setModel ? c.setModel(arg) : c.openModel()) },
  { name: 'effort', description: 'Choose the reasoning effort', run: (c) => c.openEffort() },
  {
    name: 'fast',
    description: 'Switch the fastest speed on or off',
    run: (c) => (c.toggleSpeed ? c.toggleSpeed() : useStore.getState().toast('This model has one speed')),
  },
  { name: 'mode', description: 'Choose how much the agent may do without asking', run: (c) => c.openMode() },
  { name: 'resume', description: 'Resume an earlier conversation', run: () => ui()({ historyOpen: true }) },
  { name: 'settings', description: 'Open settings', run: () => openSettings() },
  { name: 'mcp', description: 'Manage MCP servers', run: () => openSettings('mcp') },
  { name: 'skills', description: 'Browse and toggle skills', run: () => openSettings('skills') },
  { name: 'agents', description: 'Manage subagents', run: () => openSettings('agents') },
  { name: 'memory', description: 'Edit memory files', run: () => openSettings('memory') },
  { name: 'permissions', description: 'Review permission rules', run: () => openSettings('permissions') },
  { name: 'context', description: 'Show how the context window is used', session: true, run: () => ui()({ railOpen: true, railTab: 'context' }) },
  { name: 'diff', description: 'Review changes in this folder', session: true, run: () => ui()({ railOpen: true, railTab: 'changes' }) },
  { name: 'terminal', description: 'Open the terminal panel', session: true, run: () => ui()({ railOpen: true, railTab: 'terminal' }) },
  {
    name: 'browser',
    description: 'Open a page in the panel browser',
    argumentHint: '[url]',
    session: true,
    run: (_c, arg) => ui()({ railOpen: true, railTab: 'browser', ...(arg.trim() ? { browserUrl: arg.trim() } : {}) }),
  },
  {
    name: 'rename',
    description: 'Rename this session',
    argumentHint: '<title>',
    session: true,
    run: ({ sessionId }, arg) => {
      if (!sessionId) return;
      if (!arg) {
        useStore.getState().toast('Add a title after /rename');
        return;
      }
      void renameSession(sessionId, arg);
    },
  },
  {
    name: 'until',
    description: 'Run a check after each turn and send failures back until it passes',
    argumentHint: '<check> [--rounds n]',
    session: true,
    run: ({ sessionId }, arg) => sessionId && void untilCommand(sessionId, arg),
  },
  {
    name: 'spare',
    description: 'Send when an account has quota that would go unused',
    argumentHint: '<message>',
    run: ({ sessionId }, arg) => void spareCommand(sessionId, arg),
  },
  {
    name: 'race',
    description: 'Give the task to two agents at once, each in a lane of its own',
    argumentHint: '<task>',
    run: ({ sessionId }, arg) => void raceCommand(sessionId, arg),
  },
  { name: 'stop', description: 'Stop the current turn', session: true, run: ({ sessionId }) => sessionId && void interrupt(sessionId) },
  { name: 'copy', description: 'Copy the last answer', session: true, run: ({ sessionId }) => sessionId && copyLastAnswer(sessionId) },
  { name: 'help', description: 'Show keyboard shortcuts', run: () => ui()({ shortcutsOpen: true }) },
];

/** The command name a saved prompt goes by inside the menu (never typed, never sent: the prompt's text replaces it). */
const promptName = (p: SavedPrompt) => `prompt:${p.id}`;

/**
 * A saved prompt as a command: the menu removes the "/…" it was chosen from (whatever followed it
 * stays) before this runs, then the prompt's text goes in its place. Nothing is sent.
 */
const promptCommand = (p: SavedPrompt): AppCommand => ({
  name: promptName(p),
  description: '',
  prompt: p,
  run: ({ sessionId }) => {
    const rest = (useStore.getState().drafts[sessionId ?? 'home']?.text ?? '').replace(/^\s+/, '');
    focusComposer(rest ? `${p.text}${/\s$/.test(p.text) ? '' : '\n\n'}${rest}` : p.text);
  },
});

/** Sable's own commands, then the saved prompts (kept in step with them: the composer looks commands up here). */
export const APP_COMMANDS: AppCommand[] = [...BUILT_IN];
const syncPrompts = () => APP_COMMANDS.splice(BUILT_IN.length, Infinity, ...getPrompts().map(promptCommand));
syncPrompts();
subscribePrompts(syncPrompts);

export const appCommandsFor = (sessionId: string | null) => APP_COMMANDS.filter((c) => !c.session || sessionId);

export type RowKind = CommandKind | 'file' | 'dir' | 'skill' | 'agent';

export interface SuggestRow {
  id: string;
  group?: string;
  kind: RowKind;
  /** What the row inserts or runs. */
  name: string;
  label: string;
  indices?: number[];
  hint?: string;
  detail?: string;
  /** Mentions: what the row is (a file's type, a folder, an agent). */
  icon?: IconName;
  /** Mentions: what follows the "@" (a relative path, or `agent-<name>`). */
  value?: string;
}

/**
 * Fuzzy-ranks by the displayed text; an entry whose display name dropped a plugin prefix
 * still matches on its full name (without highlights, since those letters are not shown).
 */
function rank<T>(list: T[], query: string, text: (t: T) => string, full?: (t: T) => string) {
  if (!query) return list.map((t) => ({ t, indices: [] as number[] }));
  const out: { t: T; indices: number[]; score: number }[] = [];
  for (const t of list) {
    const m = fuzzy(query, text(t));
    if (m) out.push({ t, indices: m.indices, score: m.score });
    else if (full && full(t) !== text(t)) {
      const f = fuzzy(query, full(t));
      if (f) out.push({ t, indices: [], score: f.score - 1 });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Rows for "/": the person's saved prompts, Sable's own commands, then the agent's commands and skills. */
export function commandRows(query: string, caps: Capabilities | undefined, sessionId: string | null): SuggestRow[] {
  const all = appCommandsFor(sessionId);
  const app = all.filter((c) => !c.prompt);
  const prompts = all.filter((c) => c.prompt);
  const taken = new Set(BUILT_IN.map((c) => c.name));
  const provider = (caps?.commands ?? []).filter((c) => c.kind !== 'app' && !taken.has(c.name));
  const cmds = provider.filter((c) => c.kind !== 'skill');
  const skillNames = new Set<string>();
  const skills: { name: string; description: string }[] = [];
  for (const c of provider) if (c.kind === 'skill' && !skillNames.has(c.name)) (skillNames.add(c.name), skills.push(c));
  if (caps?.skillTrigger !== '$')
    for (const s of caps?.skills ?? [])
      if (s.enabled !== false && !skillNames.has(s.name) && !cmds.some((c) => c.name === s.name)) (skillNames.add(s.name), skills.push(s));
  // Short names only where they stay unambiguous, Sable's own commands included: what is shown is what is inserted.
  const short = skillLabeller([...taken, ...cmds.map((c) => c.name), ...skillNames]);

  const rows: SuggestRow[] = [];
  const shift = (ix: number[]) => ix.map((i) => i + 1);
  // Saved prompts by their names (the person's own words, so no "/" before them); first, they are few and chosen.
  for (const { t, indices } of rank(prompts, query.replace(/[-_]+/g, ' '), (c) => c.prompt!.name))
    rows.push({ id: `app:${t.name}`, group: 'Prompts', kind: 'app', name: t.name, label: t.prompt!.name, indices });
  for (const { t, indices } of rank(app, query, (c) => c.name))
    rows.push({ id: `app:${t.name}`, group: 'Sable', kind: 'app', name: t.name, label: `/${t.name}`, indices: shift(indices), hint: t.argumentHint });
  // Built-in commands (Sable's and the agent's) need no description: people know them. Only what the
  // user's or the agent's own setup adds (custom commands, skills) keeps one, since its meaning is not known in advance.
  for (const { t, indices } of rank(cmds, query, (c) => short(c.name), (c) => c.name))
    rows.push({ id: `cmd:${t.name}`, group: 'Commands', kind: t.kind, name: short(t.name), label: `/${short(t.name)}`, indices: shift(indices), hint: t.argumentHint, detail: t.kind === 'builtin' ? undefined : t.description });
  for (const { t, indices } of rank(skills, query, (c) => short(c.name), (c) => c.name))
    rows.push({ id: `skill:${t.name}`, group: 'Skills', kind: 'skill', name: short(t.name), label: `/${short(t.name)}`, indices: shift(indices), detail: t.description });
  return rows;
}

/**
 * Rows for "@": files and folders in the session's folder, then the agent's sub-agents where it
 * has any (Claude Code reads `@agent-<name>` in a prompt as "hand this to that agent").
 */
export function mentionRows(files: FileHit[], query: string, caps: Capabilities | undefined): SuggestRow[] {
  const agents = caps?.agents ?? [];
  // "@agent-ex" looks for the agent "Explore"; a path query never matches an agent. An agent is
  // offered when a word of its name starts with what is typed ("ex", "rev" for code-reviewer),
  // not on any scattered letters: the few agents must not crowd out the files.
  const agentQuery = query.replace(/^agent-?/i, '').toLowerCase();
  const short = skillLabeller(agents.map((a) => a.name));
  const words = (name: string) => [name.toLowerCase(), ...name.toLowerCase().split(/[-_:. ]+/)];
  const agentHits = query.includes('/')
    ? []
    : agents.filter((a) => !agentQuery || words(short(a.name)).some((w) => w.startsWith(agentQuery))).map((t) => ({ t, indices: agentQuery ? (fuzzy(agentQuery, short(t.name))?.indices ?? []) : [] }));
  const grouped = agentHits.length > 0 && files.length > 0;
  const agentRows = agentHits.map(
    ({ t, indices }): SuggestRow => ({ id: `agent:${t.name}`, group: grouped ? 'Agents' : undefined, kind: 'agent', name: t.name, label: short(t.name), icon: 'robot', indices, value: `agent-${t.name}` }),
  );
  const fileRows = files.map((f): SuggestRow => {
    const rel = f.rel.replace(/\\/g, '/');
    const name = baseName(rel);
    const dir = dirName(rel);
    return {
      id: `file:${rel}`,
      group: grouped ? 'Files' : undefined,
      kind: f.dir ? 'dir' : 'file',
      name,
      label: name,
      icon: fileIcon(name, f.dir),
      indices: fuzzy(query.split('/').pop() ?? '', name)?.indices,
      detail: dir && dir !== name ? dir : undefined,
      value: f.dir ? `${rel}/` : rel,
    };
  });
  // With nothing typed the files lead (the common case); once something is typed the matching
  // agents, one or two at most, come first so they are never buried under thirty files.
  return agentQuery || /^agent/i.test(query) ? [...agentRows, ...fileRows] : [...fileRows, ...agentRows];
}

/** Every name plus its short form ("cinetic" for "cinetic:cinetic") where that stays unambiguous. */
function withShortNames(names: string[]): Set<string> {
  const short = skillLabeller(names);
  return new Set([...names, ...names.map(short)]);
}

/** What the field may show as a token: commands and skills by their full and their short names. */
export function knownTokens(caps: Capabilities | undefined, sessionId: string | null) {
  const commands = [...appCommandsFor(sessionId).filter((c) => !c.prompt).map((c) => c.name), ...(caps?.commands ?? []).map((c) => c.name)];
  const skills = (caps?.skills ?? []).map((s) => s.name);
  return { commands: withShortNames([...commands, ...skills]), skills: withShortNames(skills), dollar: caps?.skillTrigger === '$' && skills.length > 0 };
}

/**
 * The menus show and insert short names ("/cinetic"), but Claude Code runs a plugin's command or
 * skill only by its full name ("/cinetic:cinetic"): an unqualified one is answered with a "did you
 * mean". A leading short name that stands for exactly one of the agent's entries goes out in full.
 */
export function expandCommand(text: string, caps: Capabilities | undefined): string {
  const m = /^\/([\w.-]+)(?=\s|$)/.exec(text);
  if (!m || !caps) return text;
  const name = m[1];
  const names = new Set([...caps.commands.map((c) => c.name), ...(caps.skillTrigger === '/' ? caps.skills.map((s) => s.name) : [])]);
  if (names.has(name) || APP_COMMANDS.some((c) => c.name === name)) return text;
  const full = [...names].filter((n) => n.endsWith(`:${name}`));
  return full.length === 1 ? `/${full[0]}${text.slice(m[0].length)}` : text;
}

/** Rows for "$" (Codex): skills only. */
export function skillRows(query: string, caps: Capabilities | undefined): SuggestRow[] {
  const skills = (caps?.skills ?? []).filter((s) => s.enabled !== false);
  const short = skillLabeller(skills.map((s) => s.name));
  return rank(skills, query, (s) => short(s.name), (s) => s.name).map(({ t, indices }) => ({
    id: `skill:${t.name}`,
    kind: 'skill' as const,
    name: short(t.name),
    label: `$${short(t.name)}`,
    indices: indices.map((i) => i + 1),
    detail: t.description,
  }));
}
