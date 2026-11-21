import type { Attachment, AuthState, CommandInfo, Effort, LimitsMeta, ModeInfo, ModelInfo, RateLimit, Todo, ToolKind, ToolResult, ToolStatus } from '../../shared/protocol';
import { makeFileDiff } from '../../shared/diff';
import { describeTool, previewDiff, type ToolView } from './claude-tools';

/** Maps what OpenCode says over ACP into Sable's timeline model. Pure: nothing here touches a process. */

type Obj = Record<string, any>;

// ───────────────────────────── modes ─────────────────────────────

/** Sable's own word for "answer every permission prompt yes": OpenCode itself only knows build and plan. */
export const ALLOW_ALL_MODE = 'allow-all';

export const MODES: ModeInfo[] = [
  { id: 'build', name: 'Build', description: 'Works as your OpenCode permissions allow', tone: 'ask' },
  { id: 'plan', name: 'Plan', description: 'Reads and plans without changing anything', tone: 'plan' },
  { id: ALLOW_ALL_MODE, name: 'Allow all', description: 'Answers every permission prompt with yes. Use in sandboxes only', tone: 'danger' },
];

/** The agent mode OpenCode itself runs for one of Sable's modes. */
export const agentModeFor = (mode: string) => (mode === 'plan' ? 'plan' : 'build');

// ───────────────────────────── models ─────────────────────────────

/** How OpenCode's model providers read ("opencode" is its Zen service, "opencode-go" the Go plan). */
const PROVIDER_NAMES: Record<string, string> = { opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter', xai: 'xAI', 'github-copilot': 'GitHub Copilot' };

const providerName = (id: string) =>
  PROVIDER_NAMES[id] ??
  id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

/** The section a model is listed under: the free ones together, the rest by where they come from. */
export function groupOf(value: string): string {
  if (/-free$/i.test(value)) return 'Free';
  const slash = value.indexOf('/');
  return slash > 0 ? providerName(value.slice(0, slash)) : 'Other';
}

/** Free first, then OpenCode's own services, then any other provider by name. */
const groupRank = (g: string) => (g === 'Free' ? 0 : g === 'OpenCode Zen' ? 1 : g === 'OpenCode Go' ? 2 : 3);

/** "opencode/Claude Fable 5.2" → "Claude Fable 5.2". */
function bareName(option: Obj): string {
  const name = String(option.name ?? '').trim();
  const value = String(option.value);
  const slash = value.indexOf('/');
  const prefix = slash > 0 ? value.slice(0, slash) : '';
  if (name && prefix && name.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return name.slice(prefix.length + 1).trim();
  if (name) return name;
  return value.slice(slash + 1);
}

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The efforts an ACP `thought_level` option offers, in Sable's terms (its "default" is the model's own, not a level). */
export function effortsOf(option: Obj | undefined): Effort[] | undefined {
  const values = ((option?.options as Obj[] | undefined) ?? []).map((o) => String(o.value));
  const found = EFFORTS.filter((e) => values.includes(e));
  return found.length ? found : undefined;
}

/**
 * The models of an ACP `model` option, by name without the model provider's prefix, in sections
 * (`ModelInfo.group`): the same name from two providers is told apart by its section.
 */
export function modelsOf(option: Obj | undefined, efforts?: Effort[]): ModelInfo[] {
  const opts = ((option?.options as Obj[] | undefined) ?? []).filter((o) => typeof o?.value === 'string');
  const models = opts.map((o, at) => ({
    at,
    m: { id: String(o.value), name: bareName(o), group: groupOf(String(o.value)), efforts, isDefault: o.value === option?.currentValue } as ModelInfo,
  }));
  // Sections in order, each keeping the agent's own order inside.
  models.sort((a, b) => groupRank(a.m.group!) - groupRank(b.m.group!) || (groupRank(a.m.group!) === 3 ? a.m.group!.localeCompare(b.m.group!) : 0) || a.at - b.at);
  // The same free model offered by two OpenCode services is listed once.
  const seen = new Set<string>();
  return models
    .map((x) => x.m)
    .filter((m) => {
      const key = `${m.group}|${m.name.toLowerCase()}`;
      if (seen.has(key) && !m.isDefault) return false;
      seen.add(key);
      return true;
    });
}

export function commandsOf(list: unknown): CommandInfo[] {
  if (!Array.isArray(list)) return [];
  return (list as Obj[])
    .filter((c) => typeof c?.name === 'string' && c.name)
    .map((c) => ({
      name: String(c.name),
      description: typeof c.description === 'string' ? c.description : '',
      argumentHint: typeof c.input?.hint === 'string' ? c.input.hint : undefined,
      kind: 'command' as const,
    }));
}

// ───────────────────────────── sign-in ─────────────────────────────

/**
 * `opencode auth list`: one line per integration, "Name   CREDENTIAL   stored|environment".
 * OpenCode also runs on its free models with no sign-in, so an empty list still works.
 */
export function parseAuthList(text: string): AuthState {
  const rows = text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim().split(/\s{2,}/))
    .filter((p) => p.length >= 2 && /^(stored|environment|env)$/i.test(p[p.length - 1]));
  if (!rows.length) return { loggedIn: true, method: 'free', plan: 'Free models', org: 'No sign-in needed' };
  const stored = rows.find((r) => /^stored$/i.test(r[r.length - 1])) ?? rows[0];
  const names = [...new Set(rows.map((r) => r[0].replace(/^OpenCode\s+/i, '')))];
  return { loggedIn: true, method: /^stored$/i.test(stored[stored.length - 1]) ? 'account' : 'apiKey', plan: stored[0], org: names.join(' · ') };
}

/**
 * OpenCode Go's plan windows, from `experimental.usage.limits` (`data.go`): a rolling five-hour
 * window, a week and a month, each with its percent used, whether it is limited and its reset.
 * Without a Go plan the answer has no `go` part: the account has no plan limits.
 */
export function mapGoLimits(json: unknown): { limits: RateLimit[]; meta: LimitsMeta } {
  const go = (json as { data?: { go?: Obj | null } } | undefined)?.data?.go;
  if (!go || typeof go !== 'object') return { limits: [], meta: { planLimits: false } };
  const WINDOWS: [key: string, id: string, label: string, windowMins: number][] = [
    ['rolling', 'go-rolling', '5-hour limit', 300],
    ['weekly', 'go-weekly', 'Weekly', 10_080],
    ['monthly', 'go-monthly', 'Monthly', 43_200],
  ];
  const limits: RateLimit[] = [];
  for (const [key, id, label, windowMins] of WINDOWS) {
    const w = go[key] as Obj | undefined;
    if (!w || typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue;
    const percent = Math.max(0, Math.min(100, w.limited ? Math.max(100, w.percent) : w.percent));
    const resetsAt = typeof w.resetsAt === 'number' ? w.resetsAt : undefined;
    limits.push({ id, label, percent, windowMins, ...(resetsAt ? { resetsAt } : {}) });
  }
  return { limits, meta: { planLimits: true } };
}

// ───────────────────────────── prompts ─────────────────────────────

/** A user message as ACP content blocks. */
export function promptBlocks(text: string, attachments?: Attachment[]): Obj[] {
  let body = text;
  const extra: Obj[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === 'image' && a.dataUrl) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(a.dataUrl);
      if (m) extra.push({ type: 'image', mimeType: m[1], data: m[2] });
    } else if (a.kind === 'text' && a.text !== undefined) {
      body += `\n\n<attachment name="${a.name}">\n${a.text}\n</attachment>`;
    } else if (a.path) {
      body += `\n\n[Attached file: ${a.path}]`;
    }
  }
  return [{ type: 'text', text: body }, ...extra];
}

// ───────────────────────────── tools ─────────────────────────────

const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/**
 * OpenCode's tool call in Claude Code's terms, so one describer titles every agent's steps the
 * same way ("Read session.ts", "Run tests").
 */
export function asClaudeCall(name: string, kind: string | undefined, input: Obj): { name: string; input: Obj } {
  const file = pick(input, 'path', 'filePath', 'file_path');
  switch (name) {
    case 'shell':
    case 'bash':
      return { name: 'Bash', input: { command: pick(input, 'command', 'cmd'), description: input.description } };
    case 'read':
      return { name: 'Read', input: { file_path: file, offset: input.offset, limit: input.limit } };
    case 'write':
      return { name: 'Write', input: { file_path: file, content: input.content } };
    case 'edit':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return { name: 'Edit', input: { file_path: file, old_string: pick(input, 'oldString', 'old_string', 'oldText', 'old'), new_string: pick(input, 'newString', 'new_string', 'newText', 'new') } };
    case 'glob':
    case 'list':
    case 'ls':
      return { name: 'Glob', input: { pattern: pick(input, 'pattern') ?? (name === 'glob' ? undefined : file ?? 'files'), path: name === 'glob' ? file : undefined } };
    case 'grep':
    case 'search':
      return { name: 'Grep', input: { pattern: input.pattern ?? input.query, path: file, glob: input.include ?? input.glob } };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: input.url, prompt: input.format } };
    case 'websearch':
    case 'codesearch':
      return { name: 'WebSearch', input: { query: input.query } };
    case 'task':
      return { name: 'Task', input: { description: input.description, subagent_type: input.subagent_type ?? input.agent, prompt: input.prompt } };
    case 'todowrite':
      return { name: 'TodoWrite', input: { todos: input.todos } };
    default: {
      // An MCP server's tool arrives as "server_tool".
      if (kind === 'other' || kind === undefined) return { name, input };
      const by: Record<string, string> = { execute: 'Bash', read: 'Read', edit: 'Edit', search: 'Grep', fetch: 'WebFetch', delete: 'Edit', move: 'Edit' };
      return { name: by[kind] ?? name, input };
    }
  }
}

export function describeCall(name: string, kind: string | undefined, input: Obj, title?: string): ToolView & { claudeName: string } {
  const c = asClaudeCall(name, kind, input);
  const view = describeTool(c.name, c.input);
  // A tool Sable has no wording for keeps OpenCode's own title.
  if (view.kind === 'other' && title && title !== name) view.title = title;
  if (view.kind === 'other' && c.name === name && /^[a-z0-9]+_[a-z0-9_]+$/i.test(name)) {
    const [server, ...rest] = name.split('_');
    return { kind: 'mcp', title: rest.join(' '), detail: { server, tool: rest.join('_') }, claudeName: c.name };
  }
  return { ...view, claudeName: c.name };
}

export const statusOf = (s: unknown): ToolStatus => (s === 'completed' ? 'done' : s === 'failed' ? 'error' : s === 'in_progress' ? 'running' : 'pending');

const MAX_TEXT = 80_000;

/** The text of ACP tool content (`{type:'content', content:{type:'text'}}` blocks). */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as Obj[]) {
    if (c?.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string') parts.push(c.content.text);
    else if (c?.type === 'terminal' && typeof c.output === 'string') parts.push(c.output);
  }
  return parts.join('\n');
}

/** What a finished tool call shows: its text, and for a change the diff (OpenCode's own when it sends one, else from the input). */
export function resultOf(claudeName: string, kind: ToolKind, input: Obj, update: Obj, failed: boolean): ToolResult {
  const out: ToolResult = {};
  const text = contentText(update.content);
  if (failed) out.isError = true;
  if (text) out.text = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  if (text.length > MAX_TEXT) out.truncated = true;
  const exit = update.rawOutput?.metadata?.exit;
  if (typeof exit === 'number') out.exitCode = exit;
  if (kind === 'edit' || kind === 'write') {
    const diffs = ((update.content as Obj[] | undefined) ?? []).filter((c) => c?.type === 'diff' && typeof c.path === 'string');
    if (diffs.length) {
      out.diff = diffs.map((d) => makeFileDiff(d.path, d.oldText ?? null, d.newText ?? ''));
    } else {
      const call = asClaudeCall(claudeName === 'Write' ? 'write' : 'edit', undefined, input);
      const preview = previewDiff(call.name, call.input);
      if (preview) out.diff = preview;
    }
  }
  return out;
}

/** The tool's input as it is known now: OpenCode fills `rawInput` in as the call firms up. */
export function inputOf(update: Obj, before?: Obj): Obj {
  const raw = update.rawInput;
  return raw && typeof raw === 'object' && Object.keys(raw).length ? { ...before, ...raw } : (before ?? {});
}

export function todosOf(entries: unknown): Todo[] {
  if (!Array.isArray(entries)) return [];
  return (entries as Obj[]).map((e) => ({
    content: String(e.content ?? ''),
    status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending',
  }));
}

/** A path as the tool's own `locations` give it. */
export const locationPath = (update: Obj): string | undefined => (typeof update.locations?.[0]?.path === 'string' ? update.locations[0].path : undefined);
