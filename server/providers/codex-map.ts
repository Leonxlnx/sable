import path from 'node:path';
import { speedFor } from '../../shared/speed';
import { STANDARD_SPEED } from '../../shared/protocol';
import type {
  Attachment,
  Effort,
  FileDiff,
  HistoryEntry,
  ModeInfo,
  ModelInfo,
  SpeedInfo,
  McpServerInfo,
  LimitsMeta,
  RateLimit,
  SkillInfo,
  TimelineItem,
  Todo,
  ToolItem,
  ToolKind,
  ToolStatus,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import { makeFileDiff, parseUnifiedDiff } from '../../shared/diff';
import { WIDGET_TOOL, describeWidget, isWidgetTool } from './widget-tool';
import { browserOp, describeBrowser } from './browser-tool';
import { describeDevice, deviceOp } from './device-tool';
import { agentOfTool, describeAgentCall } from './agent-tool';
import { describeProfileCall, isProfileTool } from './profile-tool';
import type {
  RateLimitResetCreditsSummary,
  AskForApproval,
  CommandAction,
  FileUpdateChange,
  McpServerStatus,
  Model,
  RateLimitSnapshot,
  SandboxMode,
  SandboxPolicy,
  SkillMetadata,
  Thread,
  ThreadItem,
  Turn,
  TurnPlanUpdatedNotification,
  UserInput,
} from './codex-types';

// ───────────────────────────── modes (presets) ─────────────────────────────

export interface Preset extends ModeInfo {
  approval: AskForApproval;
  sandbox: SandboxMode;
}

export const PRESETS: Preset[] = [
  {
    id: 'read-only',
    name: 'Read only',
    description: 'Can read files and answer questions. Edits and commands that need more access ask first.',
    tone: 'plan',
    approval: 'on-request',
    sandbox: 'read-only',
  },
  {
    id: 'default',
    name: 'Ask',
    description: 'Works in the project, but asks before running commands that are not known to be safe.',
    tone: 'ask',
    approval: 'untrusted',
    sandbox: 'workspace-write',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Edits files and runs commands inside the project; asks only to go beyond it.',
    tone: 'edit',
    approval: 'on-request',
    sandbox: 'workspace-write',
  },
  {
    id: 'full-access',
    name: 'Full access',
    description: 'No sandbox and no approvals. Can touch anything on this machine and the network.',
    tone: 'danger',
    approval: 'never',
    sandbox: 'danger-full-access',
  },
];

export function preset(mode: string | undefined): Preset {
  return PRESETS.find((p) => p.id === mode) ?? PRESETS[1];
}

export function sandboxPolicy(mode: SandboxMode): SandboxPolicy {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  // The session cwd is always writable under workspace-write; no extra roots.
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function modeInfo(p: Preset): ModeInfo {
  return { id: p.id, name: p.name, description: p.description, tone: p.tone };
}

// ───────────────────────────── models / efforts ─────────────────────────────

/** The levels Sable knows, lowest first. Codex also reports `ultra` (above `max`) and `none`/`persistent`, which are not levels. */
const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function toEffort(e: string | null | undefined): Effort | undefined {
  return e && (EFFORTS as string[]).includes(e) ? (e as Effort) : undefined;
}

export function mapModel(m: Model): ModelInfo {
  const efforts = (m.supportedReasoningEfforts ?? []).map((o) => toEffort(o.reasoningEffort)).filter((e): e is Effort => !!e);
  const speeds = codexSpeeds(m);
  return {
    id: m.model || m.id,
    name: m.displayName || m.model || m.id,
    description: m.description || undefined,
    efforts: efforts.length ? efforts : undefined,
    defaultEffort: toEffort(m.defaultReasoningEffort),
    supportsFast: false,
    isDefault: !!m.isDefault,
    // Codex's own picker: not hidden, and not superseded by a newer model it points to.
    picker: !m.hidden && !m.upgrade,
    ...(speeds.length ? { speeds } : {}),
  };
}

/**
 * The `serviceTier` a turn carries for the session's speed: the tier id, null for standard (also
 * when the model does not offer the speed), undefined when the session never chose one.
 */
export function serviceTierFor(model: ModelInfo | undefined, speed: string | undefined): string | null | undefined {
  if (!speed) return undefined;
  const tier = speedFor(model, speed);
  return tier === STANDARD_SPEED ? null : tier;
}

/** Codex's service tiers for a model as speeds, without the standard one. */
export function codexSpeeds(m: Pick<Model, 'serviceTiers' | 'additionalSpeedTiers'>): SpeedInfo[] {
  const tiers = m.serviceTiers?.length ? m.serviceTiers : (m.additionalSpeedTiers ?? []).map((id) => ({ id, name: '', description: '' }));
  return tiers
    .filter((t) => t.id && !/^(default|standard|auto)$/i.test(t.id))
    .map((t) => ({ id: t.id, name: t.name || t.id.charAt(0).toUpperCase() + t.id.slice(1), ...(costNote(t.description) ? { note: costNote(t.description) } : {}) }));
}

/** "Uses credits faster", "2x usage": the part of a tier's description that says it costs more, kept short. */
function costNote(text: string | undefined): string | undefined {
  const t = text?.trim();
  if (!t || !/(cost|credit|usage|price|\dx|×)/i.test(t)) return undefined;
  const first = t.split(/(?<=[.!])\s/)[0];
  return first.length <= 60 ? first.replace(/\.$/, '') : 'Uses more of your plan';
}

export function mapSkill(s: SkillMetadata): SkillInfo {
  return { name: s.name, description: s.shortDescription || s.description, source: s.scope, path: s.path, enabled: s.enabled };
}

export function mapMcp(s: McpServerStatus): McpServerInfo {
  const tools = Object.values(s.tools ?? {})
    .filter((t): t is { name: string; description?: string } => !!t)
    .map((t) => ({ name: t.name, description: t.description?.trim().split('\n')[0] }));
  let status: McpServerInfo['status'];
  switch (s.runtimeStatus) {
    case 'connected':
      status = 'connected';
      break;
    case 'failed':
    case 'cancelled':
      status = 'failed';
      break;
    case 'authenticationRequired':
      status = 'needs-auth';
      break;
    case 'disabled':
      status = 'disabled';
      break;
    case 'notStarted':
    case 'starting':
      status = 'pending';
      break;
    default:
      // No runtime yet (no thread): infer from the inventory probe.
      status = s.authStatus === 'notLoggedIn' ? 'needs-auth' : s.toolsError ? 'failed' : s.serverInfo || tools.length ? 'connected' : 'pending';
  }
  // Servers that come with a plugin name it (newer app-servers): shown as the scope.
  const plugin = (s as { pluginId?: string | null }).pluginId ?? undefined;
  return { name: s.name, status, error: s.toolsError ?? undefined, version: s.serverInfo?.version, tools, ...(plugin ? { scope: plugin } : {}) };
}

// ───────────────────────────── limits / history ─────────────────────────────

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins === 10080) return 'Weekly limit';
  if (mins % 1440 === 0) return mins === 1440 ? 'Daily limit' : `${mins / 1440}-day limit`;
  if (mins % 60 === 0) return `${mins / 60}-hour limit`;
  return `${mins}-minute limit`;
}

export function mapLimits(snapshots: RateLimitSnapshot[]): RateLimit[] {
  const out: RateLimit[] = [];
  for (const s of snapshots) {
    const key = s.limitId ?? 'codex';
    const prefix = key !== 'codex' && (s.limitName || s.limitId) ? `${s.limitName || s.limitId} · ` : '';
    for (const [slot, w] of [
      ['primary', s.primary],
      ['secondary', s.secondary],
    ] as const) {
      if (!w) continue;
      out.push({
        id: `${key}:${slot}`,
        label: prefix + windowLabel(w.windowDurationMins, slot === 'primary' ? 'Usage limit' : 'Secondary limit'),
        percent: Math.max(0, Math.min(100, Math.round(w.usedPercent ?? 0))),
        resetsAt: w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : undefined,
        ...(w.windowDurationMins ? { windowMins: w.windowDurationMins } : {}),
      });
    }
  }
  return out;
}

/** Credits and whether plan limits apply, from the same snapshots. */
export function limitsMeta(snapshots: RateLimitSnapshot[]): LimitsMeta {
  const meta: LimitsMeta = {};
  const credits = snapshots.map((s) => s.credits).find((c) => c && (c.hasCredits || c.unlimited));
  if (credits) {
    // At a full window an account with credits carries on with them (Codex decides, by the account's setting).
    const full = snapshots.some((s) => s.credits === credits && [s.primary, s.secondary].some((w) => w && w.usedPercent >= 100));
    const resets = snapshots.flatMap((s) => [s.primary, s.secondary]).filter((w) => w && w.usedPercent >= 100 && w.resetsAt).map((w) => (w!.resetsAt! < 1e12 ? w!.resetsAt! * 1000 : w!.resetsAt!));
    meta.credits = {
      ...(credits.balance ? { balance: credits.balance } : {}),
      ...(credits.unlimited ? { unlimited: true } : {}),
      has: true,
      ...(full ? { inUse: true } : {}),
      ...(full && resets.length ? { resetsAt: Math.max(...resets) } : {}),
    };
  }
  if (snapshots.some((s) => s.primary || s.secondary)) meta.planLimits = true;
  return meta;
}

/**
 * The account's granted resets, from the same read. A reset of type `codexRateLimits` restores
 * the windows of the `codex` limit (both, per OpenAI's help on banked resets). Undefined when
 * the read carries no summary (older app-server); `{ available: 0 }` when it says there are none.
 */
export function resetsMeta(summary: RateLimitResetCreditsSummary | null | undefined, limits: RateLimit[]): LimitsMeta['resets'] {
  if (!summary) return undefined;
  const n = Number(summary.availableCount);
  const available = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const windows = limits.filter((l) => l.id.startsWith('codex:')).map((l) => l.id);
  return { available, windows };
}

/** A Codex window's name from its length ("5-hour limit", "Weekly limit"), as `mapLimits` names it. */
export function codexWindowLabel(id: string, mins: number | undefined): string {
  const [key, slot] = id.split(':');
  const prefix = key && key !== 'codex' ? `${key} · ` : '';
  return prefix + windowLabel(mins, slot === 'secondary' ? 'Secondary limit' : 'Usage limit');
}

export function firstLine(text: string, max = 80): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/** Absolute paths in a message shortened to their file name (`E:\x\.codex\config.toml` → `config.toml`). */
export function shortenPaths(text: string): string {
  return text
    .replace(/(?:\\\\\?\\)?(?<![\w/])[A-Za-z]:[\\/][^\s()'"`:;,]*/g, (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p)
    .replace(/(^|[\s('"`])(~?\/(?:[^\s/()'"`:;,]+\/)+[^\s/()'"`:;,]+)/g, (_m, pre: string, p: string) => pre + (p.split('/').pop() ?? p));
}

/**
 * Codex's own warning (e.g. unknown keys in config.toml, sent again for every thread) as a quiet
 * notice: paths shortened to the file name, and null when the same warning was already shown
 * (`seen` lives as long as the app run).
 */
export function warningNotice(message: string | null | undefined, seen: Set<string>): { text: string; detail?: string } | null {
  const msg = shortenPaths(message ?? '').trim();
  if (!msg || seen.has(msg)) return null;
  seen.add(msg);
  // The headline is the first line; the detail is what follows it (the whole text only when the headline was cut short).
  const text = firstLine(msg, 120);
  const rest = text.endsWith('…') ? msg : msg.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).join('\n');
  return { text, detail: rest || undefined };
}

export function mapHistory(t: Thread): HistoryEntry {
  return {
    provider: 'codex',
    providerSessionId: t.id,
    title: t.name || firstLine(t.preview, 60) || 'Untitled thread',
    cwd: t.cwd,
    branch: t.gitInfo?.branch ?? undefined,
    updatedAt: (t.updatedAt ?? t.createdAt) * 1000,
    preview: t.preview ? firstLine(t.preview, 200) : undefined,
  };
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
  // Windows and macOS volumes ignore case by default.
  return process.platform === 'win32' || process.platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export function mapPlan(n: TurnPlanUpdatedNotification): Todo[] {
  return (n.plan ?? []).map((s, i) => ({
    id: String(i),
    content: s.step,
    status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending',
  }));
}

// ───────────────────────────── user input ─────────────────────────────

/** A plugin skill's short name: the part after its last colon ("pdf" for "pdf:pdf"). */
const shortSkillName = (name: string) => {
  const i = name.lastIndexOf(':');
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1) : name;
};

/**
 * The skill a `$token` names. Names may contain `.`, `:` and `-`, so trailing punctuation
 * ("$review.") is only dropped when the longer token is not itself a skill: the longest
 * skill name that the token starts with and that ends where a word does wins.
 * Sable's menu shows and inserts plugin skills by their short name ("$pdf" for "pdf:pdf") where
 * no other skill shares it, so a token that is no full name is matched by that short name.
 */
export function matchSkill(token: string, skills: SkillInfo[]): SkillInfo | undefined {
  const longest = (name: (k: SkillInfo) => string, list: SkillInfo[]) => {
    let best: SkillInfo | undefined;
    for (const k of list) {
      const n = name(k);
      if (!n || !token.startsWith(n)) continue;
      const next = token[n.length];
      if (next !== undefined && /\w/.test(next)) continue;
      if (!best || n.length > name(best).length) best = k;
    }
    return best;
  };
  const full = longest((k) => k.name, skills);
  if (full) return full;
  // Counted once per distinct full name, like the menu's labels.
  const counts = new Map<string, number>();
  for (const name of new Set(skills.map((k) => k.name).filter(Boolean))) counts.set(shortSkillName(name), (counts.get(shortSkillName(name)) ?? 0) + 1);
  return longest(
    (k) => shortSkillName(k.name),
    skills.filter((k) => k.name && k.name.includes(':') && counts.get(shortSkillName(k.name)) === 1),
  );
}

export function buildInput(text: string, attachments: Attachment[] | undefined, skills: SkillInfo[]): UserInput[] {
  let body = text;
  const extra: UserInput[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === 'image') {
      if (a.dataUrl) extra.push({ type: 'image', url: a.dataUrl });
      else if (a.path) extra.push({ type: 'localImage', path: a.path });
    } else if (a.kind === 'text' && a.text !== undefined) {
      body += `\n\n<attachment name="${a.name}">\n${a.text}\n</attachment>`;
    } else if (a.path) {
      body += `\n\n[Attached file: ${a.path}]`;
    }
  }
  // `$skill` mentions → explicit skill inputs so Codex loads them.
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)\$([\w.:-]+)/g)) {
    const s = matchSkill(m[1], skills);
    if (s?.path && !seen.has(s.name)) {
      seen.add(s.name);
      extra.push({ type: 'skill', name: s.name, path: s.path });
    }
  }
  return [{ type: 'text', text: body, text_elements: [] }, ...extra];
}

// ───────────────────────────── titles ─────────────────────────────

const base = (p: string) => path.basename(p.replace(/[\\/]+$/, '')) || p;

/** Strips the shell wrapper Codex reports (`powershell.exe -Command "..."`, `bash -lc '...'`). */
export function unwrapCommand(cmd: string): string {
  let c = cmd.trim();
  const m =
    c.match(/^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+)*-Command\s+([\s\S]+)$/i) ??
    c.match(/^(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+\/[cC]\s+([\s\S]+)$/) ??
    c.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (m) {
    c = m[1].trim();
    if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) c = c.slice(1, -1);
  }
  return c;
}

export function commandTitle(command: string, actions: CommandAction[] | null | undefined): string {
  const acts = actions ?? [];
  if (acts.length && acts.every((a) => a.type === 'read')) {
    const names = acts.map((a) => (a as { name: string }).name || base((a as { path: string }).path));
    return names.length === 1 ? `Read ${names[0]}` : `Read ${names.length} files`;
  }
  if (acts.length === 1 && acts[0].type === 'listFiles') return `List ${acts[0].path ? base(acts[0].path) : 'files'}`;
  if (acts.length === 1 && acts[0].type === 'search') return acts[0].query ? `Search “${firstLine(acts[0].query, 40)}”` : 'Search files';
  const c = unwrapCommand(command).replace(/\s+/g, ' ');
  return c.length > 64 ? c.slice(0, 63).trimEnd() + '…' : c || 'Run command';
}

export function activityFor(item: ThreadItem): string | undefined {
  switch (item.type) {
    case 'agentMessage':
      return 'Writing';
    case 'reasoning':
      return 'Thinking';
    case 'commandExecution':
      return firstLine(`Running ${commandTitle(item.command, item.commandActions)}`, 70);
    case 'fileChange': {
      const ps = item.changes ?? [];
      return ps.length === 1 ? `Editing ${base(ps[0].path)}` : ps.length ? `Editing ${ps.length} files` : 'Editing files';
    }
    case 'mcpToolCall':
      return `Calling ${item.server}.${item.tool}`;
    case 'webSearch':
      return 'Searching the web';
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return 'Working with sub-agents';
    case 'contextCompaction':
      return 'Compacting context';
    case 'enteredReviewMode':
      return 'Reviewing';
    default:
      return undefined;
  }
}

// ───────────────────────────── diffs ─────────────────────────────

export function changesToDiffs(changes: FileUpdateChange[] | null | undefined): FileDiff[] {
  const out: FileDiff[] = [];
  for (const ch of changes ?? []) {
    const kind = ch.kind?.type ?? 'update';
    const diff = ch.diff ?? '';
    if (/^@@ /m.test(diff)) {
      const parsed = parseUnifiedDiff(diff);
      if (parsed.length) {
        for (const f of parsed) {
          const movedTo = kind === 'update' ? (ch.kind as { move_path: string | null }).move_path : null;
          out.push({
            ...f,
            path: movedTo ?? ch.path,
            oldPath: movedTo ? ch.path : f.oldPath,
            status: movedTo ? 'renamed' : kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : f.status,
          });
        }
        continue;
      }
    }
    // No hunks: for add/delete Codex sends the whole file content.
    if (kind === 'add') out.push(makeFileDiff(ch.path, null, diff));
    else if (kind === 'delete') out.push(makeFileDiff(ch.path, diff, null));
    else out.push({ path: ch.path, status: 'modified', additions: 0, deletions: 0, hunks: [] });
  }
  return out;
}

function fileChangeTitle(changes: FileUpdateChange[]): { title: string; kind: ToolKind } {
  if (!changes.length) return { title: 'Edit files', kind: 'edit' };
  const allAdd = changes.every((c) => c.kind?.type === 'add');
  if (changes.length === 1) {
    const c = changes[0];
    const verb = c.kind?.type === 'add' ? 'Create' : c.kind?.type === 'delete' ? 'Delete' : 'Edit';
    return { title: `${verb} ${base(c.path)}`, kind: allAdd ? 'write' : 'edit' };
  }
  return { title: `${allAdd ? 'Create' : 'Edit'} ${changes.length} files`, kind: allAdd ? 'write' : 'edit' };
}

// ───────────────────────────── items ─────────────────────────────

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ItemDraft = DistOmit<TimelineItem, 'id' | 'ts'> & { ts?: number };

function toolStatus(s: string | undefined, extra?: { exitCode?: number | null }): ToolStatus {
  switch (s) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return extra?.exitCode ? 'error' : 'done';
    case 'failed':
      return 'error';
    case 'declined':
      return 'denied';
    case 'interrupted':
      return 'cancelled';
    default:
      return 'done';
  }
}

function mcpText(content: unknown[] | undefined): string | undefined {
  if (!content?.length) return undefined;
  const parts = content.map((c) => {
    const x = c as { type?: string; text?: string };
    return x?.type === 'text' && typeof x.text === 'string' ? x.text : x?.type ? `[${x.type}]` : JSON.stringify(c);
  });
  return parts.join('\n');
}

function tool(fields: Partial<ToolItem> & Pick<ToolItem, 'name' | 'kind' | 'title' | 'status'>): ItemDraft {
  return { type: 'tool', detail: {}, ...fields } as ItemDraft;
}

/**
 * Maps one Codex ThreadItem to its timeline shape. Used for live events (started and
 * completed) and for transcript loading, so both look identical. Returns null for items
 * that have no timeline representation (user messages are handled separately).
 */
export function draftItem(item: ThreadItem, opts: { streaming?: boolean } = {}): ItemDraft | null {
  const done = (s: ToolStatus) => (s === 'running' || s === 'pending' || s === 'awaiting' ? undefined : (item.completedAtMs ?? Date.now()));
  switch (item.type) {
    case 'userMessage':
    case 'hookPrompt':
    case 'functionCallOutput':
      return null;
    case 'agentMessage':
      return { type: 'text', text: item.text ?? '', streaming: !!opts.streaming };
    case 'reasoning': {
      const text = (item.summary?.length ? item.summary : (item.content ?? [])).join('\n\n');
      return { type: 'thinking', text, streaming: !!opts.streaming, endedAt: opts.streaming ? undefined : (item.completedAtMs ?? Date.now()) };
    }
    case 'plan':
      return tool({ name: 'plan', kind: 'plan', title: 'Plan', status: 'done', detail: { plan: item.text }, endedAt: done('done') });
    case 'commandExecution': {
      const status = toolStatus(item.status, { exitCode: item.exitCode });
      const finished = status !== 'running';
      const out = item.aggregatedOutput ?? undefined;
      return tool({
        name: 'shell',
        kind: 'bash',
        title: commandTitle(item.command, item.commandActions),
        status,
        detail: { command: unwrapCommand(item.command), cwd: item.cwd },
        input: { command: item.command, cwd: item.cwd },
        ...(out !== undefined ? { output: out } : {}),
        ...(finished
          ? {
              result: {
                text: out,
                exitCode: item.exitCode ?? undefined,
                isError: item.status === 'failed' || item.status === 'declined' || !!item.exitCode,
              },
              endedAt: done(status),
            }
          : {}),
      });
    }
    case 'fileChange': {
      const changes = item.changes ?? [];
      const { title, kind } = fileChangeTitle(changes);
      const status = toolStatus(item.status);
      const diff = changesToDiffs(changes);
      return tool({
        name: 'apply_patch',
        kind,
        title,
        status,
        detail: { path: changes[0]?.path },
        input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type })) },
        result: { diff, isError: status === 'error' || undefined },
        endedAt: done(status),
      });
    }
    case 'mcpToolCall': {
      const status = toolStatus(item.status);
      return tool({
        name: `mcp__${item.server}__${item.tool}`,
        kind: 'mcp',
        title: `${item.server} · ${item.tool}`,
        status,
        detail: { server: item.server, tool: item.tool },
        input: item.arguments,
        ...(status !== 'running'
          ? {
              result: item.error
                ? { text: item.error.message, isError: true }
                : { text: mcpText(item.result?.content) ?? (item.result?.structuredContent ? JSON.stringify(item.result.structuredContent) : undefined) },
              endedAt: done(status),
            }
          : {}),
      });
    }
    case 'dynamicToolCall': {
      const status = item.success === false ? 'error' : toolStatus(item.status);
      const text = item.contentItems?.map((c) => c.text ?? `[${c.type}]`).join('\n');
      // Generative UI: the call is the widget (its arguments are complete when the item starts).
      if (isWidgetTool(item.tool)) {
        return tool({
          name: WIDGET_TOOL,
          ...describeWidget(item.arguments),
          status,
          input: item.arguments,
          ...(status !== 'running' ? { result: { text, isError: status === 'error' || undefined }, endedAt: done(status) } : {}),
        });
      }
      // The Browser tab tools: one line with the host, the picture in the details.
      if (browserOp(item.tool)) {
        const images = (item.contentItems as { type: string; imageUrl?: string }[] | null | undefined)?.flatMap((c) => (c.type === 'inputImage' && c.imageUrl?.startsWith('data:image/') ? [c.imageUrl] : [])) ?? [];
        const plain = item.contentItems?.filter((c) => c.type === 'inputText').map((c) => c.text ?? '').join('\n');
        return tool({
          name: item.tool,
          ...describeBrowser(item.tool, item.arguments, plain),
          status,
          input: item.arguments,
          ...(status !== 'running' ? { result: { text: plain, isError: status === 'error' || undefined, ...(images.length ? { images } : {}) }, endedAt: done(status) } : {}),
        });
      }
      // The Android device tools: one line with what happened, the picture in the details.
      if (deviceOp(item.tool)) {
        const images = (item.contentItems as { type: string; imageUrl?: string }[] | null | undefined)?.flatMap((c) => (c.type === 'inputImage' && c.imageUrl?.startsWith('data:image/') ? [c.imageUrl] : [])) ?? [];
        const plain = item.contentItems?.filter((c) => c.type === 'inputText').map((c) => c.text ?? '').join('\n');
        return tool({
          name: item.tool,
          ...describeDevice(item.tool, item.arguments),
          status,
          input: item.arguments,
          ...(status !== 'running' ? { result: { text: plain, isError: status === 'error' || undefined, ...(images.length ? { images } : {}) }, endedAt: done(status) } : {}),
        });
      }
      // A fact for the user's profile: one line with the fact.
      if (!item.namespace && isProfileTool(item.tool)) {
        return tool({
          name: item.tool,
          ...describeProfileCall(item.arguments),
          status,
          input: item.arguments,
          ...(status !== 'running' ? { result: { text, isError: status === 'error' || undefined }, endedAt: done(status) } : {}),
        });
      }
      // A sub-agent from the other agent (Claude Code): its steps nest under this one.
      const agent = item.namespace ? undefined : agentOfTool(item.tool);
      if (agent) {
        return tool({
          name: item.tool,
          ...describeAgentCall(agent, item.arguments),
          status,
          input: item.arguments,
          ...(status !== 'running' ? { result: { text, isError: status === 'error' || undefined }, endedAt: done(status) } : {}),
        });
      }
      return tool({
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        kind: 'other',
        title: item.tool,
        status,
        detail: { tool: item.tool },
        input: item.arguments,
        ...(status !== 'running' ? { result: { text, isError: status === 'error' || undefined }, endedAt: done(status) } : {}),
      });
    }
    case 'collabAgentToolCall': {
      const status = toolStatus(item.status);
      const verb: Record<string, string> = {
        spawnAgent: 'Spawn agent',
        sendInput: 'Message agent',
        sendMessage: 'Message agent',
        resumeAgent: 'Resume agent',
        wait: 'Wait for agents',
        closeAgent: 'Close agent',
        followupTask: 'Follow-up task',
        interruptAgent: 'Interrupt agent',
        listAgents: 'List agents',
      };
      const states = Object.values(item.agentsStates ?? {}).filter(Boolean) as { status: string; message: string | null }[];
      const text = states
        .map((s) => s.message)
        .filter(Boolean)
        .join('\n\n');
      return tool({
        name: item.tool,
        // Only a spawn is an agent (a block, and a card in the Agents tab); waiting, messaging or closing one is a step.
        kind: item.tool === 'spawnAgent' ? 'agent' : 'other',
        title: verb[item.tool] ?? item.tool,
        status,
        detail: { prompt: item.prompt ?? undefined, subagent: item.model ?? undefined },
        input: { prompt: item.prompt, receivers: item.receiverThreadIds },
        ...(status !== 'running' ? { result: { text: text || undefined }, endedAt: done(status) } : {}),
      });
    }
    case 'subAgentActivity':
      return tool({
        name: 'subagent',
        kind: 'agent',
        title: `Sub-agent ${item.kind}`,
        status: 'done',
        detail: { subagent: item.agentPath || item.model || undefined },
        endedAt: done('done'),
      });
    case 'webSearch': {
      const a = item.action;
      const url = a && (a.type === 'openPage' || a.type === 'findInPage') ? (a.url ?? undefined) : undefined;
      const query = item.query || (a?.type === 'search' ? (a.query ?? a.queries?.join(', ')) : undefined) || undefined;
      const status: ToolStatus = opts.streaming ? 'running' : 'done';
      return tool({
        name: 'web_search',
        kind: url ? 'fetch' : 'websearch',
        title: url ? `Open ${url}` : query ? `Search “${firstLine(query, 50)}”` : 'Web search',
        status,
        detail: { query, url },
        endedAt: done(status),
      });
    }
    case 'imageView':
      return tool({ name: 'view_image', kind: 'read', title: `View ${base(item.path)}`, status: 'done', detail: { path: item.path }, endedAt: done('done') });
    case 'sleep':
      return tool({
        name: 'sleep',
        kind: 'other',
        title: `Wait ${Math.round((item.durationMs ?? 0) / 1000)}s`,
        status: opts.streaming ? 'running' : 'done',
        detail: {},
        endedAt: opts.streaming ? undefined : done('done'),
      });
    case 'imageGeneration': {
      const status: ToolStatus = item.status === 'failed' ? 'error' : opts.streaming ? 'running' : 'done';
      return tool({
        name: 'image_generation',
        kind: 'other',
        title: 'Generate image',
        status,
        detail: { prompt: item.revisedPrompt ?? undefined, path: item.savedPath },
        endedAt: done(status),
      });
    }
    case 'enteredReviewMode':
      return { type: 'notice', variant: 'info', text: 'Review started', detail: item.review || undefined };
    case 'exitedReviewMode':
      return item.review ? { type: 'text', text: item.review, streaming: false } : null;
    case 'contextCompaction':
      return opts.streaming ? null : { type: 'notice', variant: 'compact', text: 'Context compacted' };
    default: {
      const t = (item as { type?: string }).type ?? 'item';
      return tool({ name: t, kind: 'other', title: t.replace(/([a-z])([A-Z])/g, '$1 $2'), status: 'done', detail: {}, input: item, endedAt: Date.now() });
    }
  }
}

// ───────────────────────────── transcript ─────────────────────────────

function userFromItem(item: Extract<ThreadItem, { type: 'userMessage' }>, ts: number): Omit<UserItem, 'id'> {
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const c of item.content ?? []) {
    const x = c as { type: string; text?: string; url?: string; path?: string; name?: string };
    if (x.type === 'text' && x.text) texts.push(x.text);
    else if (x.type === 'image' && x.url) attachments.push({ id: `${item.id}:${attachments.length}`, kind: 'image', name: 'image', dataUrl: x.url });
    else if (x.type === 'localImage' && x.path) attachments.push({ id: `${item.id}:${attachments.length}`, kind: 'image', name: base(x.path), path: x.path });
  }
  return { type: 'user', ts, text: texts.join('\n'), attachments: attachments.length ? attachments : undefined, state: 'sent', providerId: item.id };
}

/** Rebuilds a timeline from stored turns (thread/read or thread/resume with turns). */
export function transcript(turns: Turn[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  // A turn or item without a stored time takes the last known one (never "now", which would be untrue).
  let last = 0;
  for (const turn of turns ?? []) {
    const turnTs = (turn.startedAt ?? 0) * 1000 || last || Date.now();
    last = turnTs;
    for (const item of turn.items ?? []) {
      const ts = item.startedAtMs ?? last;
      last = ts;
      const id = `${turn.id}:${item.id}`;
      if (item.type === 'userMessage') {
        out.push({ ...userFromItem(item, ts), id } as UserItem);
        continue;
      }
      const d = draftItem(item, { streaming: false });
      if (!d) continue;
      if ((d.type === 'thinking' || d.type === 'text') && !d.text.trim()) continue;
      if (d.type === 'tool' && (d.status === 'running' || d.status === 'pending') && turn.status !== 'inProgress') {
        (d as ToolItem).status = 'cancelled';
      }
      out.push({ ts, ...d, id } as TimelineItem);
    }
    if (turn.status !== 'inProgress') {
      const end: TurnItem = {
        type: 'turn',
        id: `${turn.id}:turn`,
        ts: (turn.completedAt ?? turn.startedAt ?? 0) * 1000 || last,
        durationMs: turn.durationMs ?? (turn.completedAt && turn.startedAt ? (turn.completedAt - turn.startedAt) * 1000 : 0),
        stopReason: turn.status,
        error: turn.status === 'failed' ? (turn.error?.message ?? 'Turn failed') : undefined,
      };
      if (turn.status === 'interrupted') out.push({ type: 'notice', id: `${turn.id}:int`, ts: end.ts, variant: 'interrupted', text: 'Interrupted' });
      out.push(end);
    }
  }
  return out;
}
