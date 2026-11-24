import { statSync } from 'node:fs';
import type { AgentStats, Attachment, FileDiff, Question, SharedFile, TimelineItem, Todo, ToolDetail, ToolKind, ToolResult, WorkflowAgent, WorkflowRun } from '../../shared/protocol';
import { countChanges, makeFileDiff } from '../../shared/diff';
import { stripWrappers } from '../../shared/synthetic';
import { WIDGET_SERVER, WIDGET_TOOL_ID, describeWidget } from './widget-tool';
import { browserOp, describeBrowser } from './browser-tool';
import { describeDevice, deviceOp } from './device-tool';
import { agentOfTool, describeAgentCall } from './agent-tool';
import { PROFILE_TOOL_ID, describeProfileCall } from './profile-tool';

/** Normalizes Claude Code tool calls and results into Sable's display model. */

export interface ToolView {
  kind: ToolKind;
  title: string;
  detail: ToolDetail;
}

type Obj = Record<string, any>;

const MAX_TEXT = 80_000;

export function baseName(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function clip(text: string | undefined): { text?: string; truncated?: boolean } {
  if (text === undefined) return {};
  if (text.length <= MAX_TEXT) return { text };
  return { text: text.slice(0, MAX_TEXT), truncated: true };
}

export function shortCommand(command?: string): string {
  if (!command) return 'Run command';
  const first = command.trim().split('\n')[0];
  return first.length > 72 ? first.slice(0, 70) + '…' : first;
}

function host(url?: string): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return url ?? 'page';
  }
}

export function describeTool(name: string, input: Obj = {}): ToolView {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return {
        kind: 'bash',
        title: input.description || shortCommand(input.command),
        detail: { command: input.command, description: input.description, background: !!input.run_in_background },
      };
    case 'BashOutput':
    case 'TaskOutput':
      return { kind: 'bash', title: 'Check background output', detail: {} };
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return { kind: 'bash', title: 'Stop background task', detail: {} };
    case 'Read':
      return {
        kind: 'read',
        title: `Read ${baseName(input.file_path) || 'file'}`,
        detail: {
          path: input.file_path,
          range: input.offset ? [Number(input.offset), Number(input.offset) + Number(input.limit ?? 0)] : undefined,
        },
      };
    case 'Edit':
      return {
        kind: 'edit',
        title: `Edit ${baseName(input.file_path) || 'file'}`,
        detail: { path: input.file_path, oldText: input.old_string, newText: input.new_string },
      };
    case 'MultiEdit': {
      // A blank line between edits keeps each old/new pair aligned in the joined diff.
      const edits = multiEdits(input);
      return {
        kind: 'edit',
        title: `Edit ${baseName(input.file_path) || 'file'}`,
        detail: edits.length
          ? { path: input.file_path, oldText: edits.map((e) => e.old).join('\n\n'), newText: edits.map((e) => e.new).join('\n\n') }
          : { path: input.file_path },
      };
    }
    case 'NotebookEdit':
      return { kind: 'edit', title: `Edit ${baseName(input.notebook_path) || 'notebook'}`, detail: { path: input.notebook_path, newText: input.new_source } };
    case 'Write':
      return { kind: 'write', title: `Write ${baseName(input.file_path) || 'file'}`, detail: { path: input.file_path, content: input.content } };
    case 'Glob':
      return { kind: 'glob', title: `Find ${input.pattern ?? 'files'}`, detail: { pattern: input.pattern, path: input.path } };
    case 'Grep':
      return { kind: 'search', title: `Search for ${input.pattern ? `“${clipInline(input.pattern, 40)}”` : 'text'}`, detail: { pattern: input.pattern, path: input.path, glob: input.glob } };
    case 'WebFetch':
      return { kind: 'fetch', title: `Fetch ${host(input.url)}`, detail: { url: input.url, description: input.prompt } };
    case 'WebSearch':
      return { kind: 'websearch', title: input.query ? `Search the web for “${clipInline(input.query, 48)}”` : 'Search the web', detail: { query: input.query } };
    case 'Task':
    case 'Agent':
      return {
        kind: 'agent',
        title: input.description || 'Run a subagent',
        // A background agent (run_in_background, or a remote one, which always runs in the background) keeps working after the call returns.
        detail: { subagent: input.subagent_type, description: input.description, prompt: input.prompt, ...(input.run_in_background || input.isolation === 'remote' ? { background: true } : {}) },
      };
    case 'Workflow': {
      // Multi-agent orchestration in the background: shown as one agent block with its phases and agents.
      const meta = workflowMeta(input.script);
      const name = meta.name ?? (typeof input.name === 'string' ? input.name : undefined);
      const label = meta.description || (name ? humanName(name) : undefined);
      return { kind: 'agent', title: label || 'Run a workflow', detail: { subagent: 'Workflow', description: label, background: true } };
    }
    case 'TodoWrite':
      return { kind: 'todo', title: 'Update the task list', detail: { todos: normalizeTodos(input.todos) } };
    case 'TaskCreate':
      return { kind: 'todo', title: input.subject ? `Add task: ${input.subject}` : 'Add a task', detail: {} };
    case 'TaskUpdate':
      return { kind: 'todo', title: input.status ? `Mark task ${String(input.status).replace('_', ' ')}` : 'Update a task', detail: {} };
    case 'TaskList':
    case 'TaskGet':
      return { kind: 'todo', title: 'Review the task list', detail: {} };
    case 'AskUserQuestion':
      return { kind: 'question', title: 'Ask a question', detail: { questions: normalizeQuestions(input.questions) } };
    case 'ExitPlanMode':
      return { kind: 'plan', title: 'Propose a plan', detail: { plan: input.plan } };
    case 'EnterPlanMode':
      return { kind: 'plan', title: 'Switch to planning', detail: {} };
    case 'Skill':
      return { kind: 'skill', title: `Use the ${input.skill ?? ''} skill`.replace('  ', ' '), detail: { skill: input.skill, description: input.args } };
    case 'ToolSearch':
      return { kind: 'other', title: 'Look up tools', detail: { query: input.query } };
    case 'SendUserFile':
      return describeShare(input);
    case WIDGET_TOOL_ID:
      return describeWidget(input);
    case PROFILE_TOOL_ID:
      return describeProfileCall(input);
    default: {
      if (name.startsWith(`mcp__${WIDGET_SERVER}__browser_`) && browserOp(name)) return describeBrowser(name, input);
      if (name.startsWith(`mcp__${WIDGET_SERVER}__device_`) && deviceOp(name)) return describeDevice(name, input);
      const agent = agentOfTool(name);
      if (agent) return describeAgentCall(agent, input);
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        const tool = rest.join('__');
        return { kind: 'mcp', title: tool.replace(/[_-]+/g, ' '), detail: { server, tool } };
      }
      return { kind: 'other', title: name.replace(/([a-z])([A-Z])/g, '$1 $2'), detail: {} };
    }
  }
}

function clipInline(s: string, n: number) {
  const one = String(s).replace(/\s+/g, ' ');
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function normalizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: Obj) => ({
    id: t.id ? String(t.id) : undefined,
    content: String(t.content ?? t.subject ?? ''),
    activeForm: t.activeForm ? String(t.activeForm) : undefined,
    status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
  }));
}

export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q: Obj) => ({
    question: String(q.question ?? ''),
    header: q.header ? String(q.header) : undefined,
    multiSelect: !!q.multiSelect,
    options: Array.isArray(q.options)
      ? q.options.map((o: Obj) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined }))
      : [],
  }));
}

/** Flattens a tool_result `content` (string or content blocks) into text + images. */
export function flattenContent(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: string[] = [];
  let text = '';
  if (Array.isArray(content)) {
    for (const block of content as Obj[]) {
      if (block?.type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text;
      else if (block?.type === 'image' && block.source?.type === 'base64') {
        images.push(`data:${block.source.media_type};base64,${block.source.data}`);
      }
    }
  }
  return { text, images };
}

function patchToDiff(path: string, patch: Obj[] | undefined, status: FileDiff['status']): FileDiff | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined;
  const hunks = patch.map((h) => ({
    oldStart: Number(h.oldStart ?? 1),
    oldLines: Number(h.oldLines ?? 0),
    newStart: Number(h.newStart ?? 1),
    newLines: Number(h.newLines ?? 0),
    lines: Array.isArray(h.lines) ? h.lines.map(String) : [],
  }));
  return { path, status, hunks, ...countChanges(hunks) };
}

function multiEdits(input: Obj): { old: string; new: string }[] {
  if (!Array.isArray(input.edits)) return [];
  return input.edits.filter((e: unknown) => e && typeof e === 'object').map((e: Obj) => ({ old: String(e.old_string ?? ''), new: String(e.new_string ?? '') }));
}

/** A best-effort diff from a tool's *input*, shown before the tool has run (permission prompts). */
export function previewDiff(name: string, input: Obj, currentFile?: string | null): FileDiff[] | undefined {
  if (name === 'Edit' && typeof input.file_path === 'string') {
    const oldText = String(input.old_string ?? '');
    const newText = String(input.new_string ?? '');
    let startLine = 1;
    if (currentFile) {
      const at = currentFile.indexOf(oldText);
      if (at >= 0) startLine = currentFile.slice(0, at).split('\n').length;
    }
    return [makeFileDiff(input.file_path, oldText, newText, { startLine })];
  }
  if (name === 'MultiEdit' && typeof input.file_path === 'string') {
    const edits = multiEdits(input);
    if (!edits.length) return undefined;
    if (currentFile) {
      // Apply the edits in order, as the tool does, and diff the whole file.
      let text: string | null = currentFile;
      for (const e of edits) {
        const at: number = text.indexOf(e.old);
        if (!e.old || at < 0) {
          text = null;
          break;
        }
        text = text.slice(0, at) + e.new + text.slice(at + e.old.length);
      }
      if (text !== null) return [makeFileDiff(input.file_path, currentFile, text)];
    }
    // Without the file: one hunk per edit.
    const hunks = edits.flatMap((e) => makeFileDiff(input.file_path, e.old, e.new).hunks);
    return [{ path: input.file_path, status: 'modified', hunks, ...countChanges(hunks) }];
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    return [makeFileDiff(input.file_path, currentFile ?? null, String(input.content ?? ''))];
  }
  return undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Splits a sub-agent's result text into the report and the figures Claude Code appends for the model
 * (`agentId: …` and `<usage>total_tokens: …, tool_uses: …, duration_ms: …</usage>`). A stored
 * transcript keeps only this text, so it is where a loaded conversation gets its figures from.
 */
export function splitAgentUsage(text: string): { text: string; stats: AgentStats } {
  const m = /\n*(?:agentId:[^\n]*\n+)?<usage>([\s\S]*?)<\/usage>\s*$/.exec(text);
  if (!m) return { text, stats: {} };
  const read = (key: string) => {
    const hit = new RegExp(`${key}:\\s*(\\d+)`).exec(m[1]);
    return hit ? Number(hit[1]) : undefined;
  };
  const stats: AgentStats = {};
  const tokens = read('total_tokens');
  const steps = read('tool_uses');
  const durationMs = read('duration_ms');
  if (tokens !== undefined) stats.tokens = tokens;
  if (steps !== undefined) stats.steps = steps;
  if (durationMs !== undefined) stats.durationMs = durationMs;
  return { text: text.slice(0, m.index).trimEnd(), stats };
}

export function mapResult(name: string, input: Obj, structured: unknown, content: unknown, isError: boolean): ToolResult {
  const flat = flattenContent(content);
  const r: Obj = structured && typeof structured === 'object' ? (structured as Obj) : {};
  const out: ToolResult = {};
  if (isError) out.isError = true;
  if (flat.images.length) out.images = flat.images;

  if (isError) {
    Object.assign(out, clip(flat.text || (typeof structured === 'string' ? structured : '')));
    if (name === 'Task' || name === 'Agent') {
      const limit = agentLimitOf(out.text);
      if (limit) out.agent = { limit };
    }
    const code = flat.text.match(/Exit code (\d+)/);
    if (code) out.exitCode = Number(code[1]);
    return out;
  }

  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      Object.assign(out, clip(typeof r.stdout === 'string' ? r.stdout : flat.text));
      if (r.stderr) out.stderr = String(r.stderr).slice(0, MAX_TEXT);
      if (r.interrupted) out.interrupted = true;
      out.exitCode = 0;
      return out;
    }
    case 'Read': {
      if (r.file && typeof r.file === 'object') {
        const c = clip(typeof r.file.content === 'string' ? r.file.content : undefined);
        out.file = {
          path: String(r.file.filePath ?? input.file_path ?? ''),
          content: c.text,
          startLine: r.file.startLine,
          numLines: r.file.numLines,
          totalLines: r.file.totalLines,
        };
        if (c.truncated) out.truncated = true;
      } else if (!flat.images.length) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = String(r.filePath ?? input.file_path ?? input.notebook_path ?? '');
      const created = r.type === 'create' || (name === 'Write' && r.originalFile == null && !r.structuredPatch?.length);
      const diff =
        patchToDiff(path, r.structuredPatch, created ? 'added' : 'modified') ??
        (created && typeof (r.content ?? input.content) === 'string' ? makeFileDiff(path, null, String(r.content ?? input.content)) : undefined) ??
        previewDiff(name, input)?.[0];
      if (diff) out.diff = [diff];
      return out;
    }
    case 'Glob': {
      if (Array.isArray(r.filenames)) out.files = r.filenames.slice(0, 400).map(String);
      out.count = Number(r.numFiles ?? out.files?.length ?? 0);
      if (r.truncated) out.truncated = true;
      if (!out.files) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'Grep': {
      if (Array.isArray(r.filenames) && r.filenames.length) out.files = r.filenames.slice(0, 400).map(String);
      if (typeof r.content === 'string' && r.content) Object.assign(out, clip(r.content));
      out.count = Number(r.numMatches ?? r.numLines ?? r.numFiles ?? out.files?.length ?? 0);
      if (!out.files && out.text === undefined) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'WebSearch': {
      const links: { title: string; url: string }[] = [];
      if (Array.isArray(r.results)) {
        for (const entry of r.results) {
          if (entry && typeof entry === 'object' && Array.isArray(entry.content)) {
            for (const hit of entry.content) if (hit?.url) links.push({ title: String(hit.title ?? hit.url), url: String(hit.url) });
          }
        }
      }
      if (links.length) out.links = links.slice(0, 24);
      else Object.assign(out, clip(flat.text));
      out.count = links.length;
      return out;
    }
    case 'WebFetch': {
      Object.assign(out, clip(typeof r.result === 'string' ? r.result : flat.text));
      return out;
    }
    case 'Task':
    case 'Agent': {
      // The text the model reads ends with the agent's id and a usage block: figures, not part of the report.
      const tail = splitAgentUsage(flat.text);
      const agent: AgentStats = { ...tail.stats };
      if (num(r.totalTokens) !== undefined) agent.tokens = num(r.totalTokens);
      if (num(r.totalToolUseCount) !== undefined) agent.steps = num(r.totalToolUseCount);
      if (num(r.totalDurationMs) !== undefined) agent.durationMs = num(r.totalDurationMs);
      // Started in the background: the call returns at once with a placeholder, the agent works on.
      const launched = r.status === 'async_launched' || r.status === 'remote_launched';
      if (launched) agent.background = 'running';
      const limit = launched ? undefined : agentLimitOf(Array.isArray(r.content) ? flattenContent(r.content).text : tail.text);
      if (limit) agent.limit = limit;
      if (Object.keys(agent).length) out.agent = agent;
      if (!launched) Object.assign(out, clip(Array.isArray(r.content) ? flattenContent(r.content).text : tail.text));
      return out;
    }
    case 'Workflow': {
      // Launched: the call returns at once, the run goes on in the background.
      const launched = r.status === 'async_launched' || r.status === 'remote_launched';
      if (launched) out.agent = { background: 'running' };
      if (typeof r.error === 'string' && r.error) Object.assign(out, clip(r.error));
      else if (!launched) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'AskUserQuestion': {
      if (r.answers && typeof r.answers === 'object') {
        out.answers = Object.fromEntries(Object.entries(r.answers as Obj).map(([q, a]) => [q, Array.isArray(a) ? a.map(String) : [String(a)]]));
      }
      return out;
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return out;
    default: {
      Object.assign(out, clip(flat.text));
      return out;
    }
  }
}

/** Pulls early field values out of a still-streaming JSON input so titles can update live. */
export function peekPartialInput(json: string): Obj {
  const out: Obj = {};
  for (const key of ['file_path', 'notebook_path', 'command', 'description', 'pattern', 'url', 'query', 'subagent_type', 'skill', 'subject', 'title']) {
    const m = json.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m) {
      try {
        out[key] = JSON.parse(`"${m[1]}"`);
      } catch {
        /* incomplete escape */
      }
    }
  }
  return out;
}

// ── sub-agents at a plan limit ──

/**
 * A sub-agent the plan stopped: Claude Code ends it with "You've hit your Fable limit · resets
 * Nov 22, 12am" (or "…your weekly limit…", or the older "Claude AI usage limit reached|<epoch>").
 * Returns the window as the limit rows name it ("Weekly · Fable", "5-hour limit") and its reset
 * when the text gives one; undefined for any other text.
 */
export function agentLimitOf(text: string | undefined, now = Date.now()): { window: string; resetsAt?: number } | undefined {
  const t = (text ?? '').trim();
  if (!t || t.length > 600) return undefined;
  const hit = /(?:you(?:'|’)ve|you have) (?:hit|reached) your ([\w .-]*?)\s*(?:usage )?limit(?:\s*[·•|-]\s*resets\s+([^\n]+?))?\s*\.?\s*$/im.exec(t);
  const old = /usage limit reached\|(\d{9,13})/i.exec(t);
  if (!hit && !old) return undefined;
  const what = (hit?.[1] ?? '').trim().replace(/^the\s+/i, '');
  let window: string;
  if (/^(5|five)[- ]?hour$/i.test(what)) window = '5-hour limit';
  else if (/^(weekly|week)$/i.test(what)) window = 'Weekly · all models';
  else if (!what || /^(usage|plan)$/i.test(what)) window = 'Plan limit';
  else window = `Weekly · ${what.replace(/^weekly\s+/i, '').replace(/^\w/, (c) => c.toUpperCase())}`;
  const resetsAt = old ? epochOf(Number(old[1])) : hit?.[2] ? resetFromText(hit[2], now) : undefined;
  return resetsAt ? { window, resetsAt } : { window };
}

const epochOf = (n: number) => (n < 1e12 ? n * 1000 : n);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 22, 12am", "Nov 22 at 3:30pm", "3pm": the next such local time after `now`. */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const t = text.toLowerCase().replace(/\(.*?\)/g, ' ');
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t);
  const date = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(t);
  if (!time && !date) return undefined;
  // The notice names the CLI's time zone. A remote bridge may have a different local clock.
  const zone = /\(([^()]+)\)/.exec(text)?.[1];
  let clock: Intl.DateTimeFormat | undefined;
  if (zone) {
    try {
      clock = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' });
    } catch { /* Older CLIs sometimes print a display name instead of an IANA zone. */ }
  }
  const offsetAt = (utc: number) => {
    if (!clock) return -new Date(utc).getTimezoneOffset() * 60_000;
    const offset = clock.formatToParts(utc).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const parts = /GMT([+-])(\d+):(\d+)/.exec(offset);
    return parts ? (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 60 + Number(parts[3])) * 60_000 : 0;
  };
  const d = new Date(now + offsetAt(now));
  const hour = time ? Number(time[1]) % 12 + (time[3] === 'pm' ? 12 : 0) : 0;
  const wall = new Date(Date.UTC(d.getUTCFullYear(), date ? MONTHS.indexOf(date[1]) : d.getUTCMonth(), date ? Number(date[2]) : d.getUTCDate(), hour, Number(time?.[2] ?? 0)));
  // Resolve the offset on the target date as a reset can cross a daylight-saving transition.
  const instant = () => wall.getTime() - offsetAt(wall.getTime() - offsetAt(wall.getTime()));
  if (instant() <= now) {
    if (date) wall.setUTCFullYear(wall.getUTCFullYear() + 1);
    else wall.setUTCDate(wall.getUTCDate() + 1);
  }
  return instant();
}

// ── background tasks and wake-ups ──

/** What a task of Claude Code's is: a sub-agent or workflow, a background command, a monitor, or anything else. */
export type TaskKind = 'agent' | 'command' | 'monitor' | 'other';

/** A task's kind, from its own `task_type` when that says it, else from the call that started it. */
export function taskKindOf(taskType?: unknown, toolName?: string): TaskKind {
  const t = typeof taskType === 'string' ? taskType.toLowerCase() : '';
  if (/agent|workflow/.test(t)) return 'agent';
  if (/monitor/.test(t)) return 'monitor';
  if (/bash|shell/.test(t)) return 'command';
  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return 'agent';
  if (toolName === 'Monitor') return 'monitor';
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'command';
  return 'other';
}

/**
 * The background task a call left running, read from the call's own result (the tie between task and
 * step that needs no task event): a command's `backgroundTaskId` (run in the background, backgrounded
 * by the person, or by Claude Code at its timeout), a monitor's `taskId`.
 */
export function backgroundTaskOf(name: string, structured: unknown): { id: string; kind: 'command' | 'monitor' } | undefined {
  const r = structured && typeof structured === 'object' ? (structured as Obj) : {};
  if ((name === 'Bash' || name === 'PowerShell') && typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return { id: r.backgroundTaskId, kind: 'command' };
  if (name === 'Monitor' && typeof r.taskId === 'string' && r.taskId) return { id: r.taskId, kind: 'monitor' };
  return undefined;
}

/**
 * A wake-up the agent scheduled or cancelled, read only from the call's own result, never guessed
 * from its input: `loop` the next dynamic wake-up (`ScheduleWakeup`'s `scheduledFor`; null when it
 * stopped the loop), `cron` a scheduled task's next fire (`CronCreate`'s `nextFireAt`; null when it was
 * deleted, or no time was given).
 */
export function wakeOf(name: string, input: Obj, structured: unknown): { loop?: number | null; cron?: { id: string; at: number | null } } | undefined {
  const r = structured && typeof structured === 'object' ? (structured as Obj) : {};
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  if (name === 'ScheduleWakeup') {
    if (r.stopped === true) return { loop: null };
    const at = time(r.scheduledFor);
    return at ? { loop: at } : undefined;
  }
  if (name === 'CronCreate' && typeof r.id === 'string' && r.id) return { cron: { id: r.id, at: time(r.nextFireAt) } };
  if (name === 'CronDelete') {
    const id = typeof r.id === 'string' && r.id ? r.id : typeof input.id === 'string' ? input.id : '';
    if (id) return { cron: { id, at: null }, ...(r.endedLoopWakeup === true ? { loop: null } : {}) };
  }
  return undefined;
}

// ── whose message it is ──

/**
 * A message's words as they are compared with a replay's: without the wrappers the harness adds, the
 * note that asks a steer to be answered first, and the words Sable adds (a handover, the Browser tab's
 * line), with runs of white space as one space.
 */
export function plainWords(text: string): string {
  return stripWrappers(text).replace(/\s+/g, ' ').trim();
}

/** The pictures a message from the app may carry, and how their data must read. */
const PICTURE_KINDS = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The pictures of a message from the Claude app (its base64 image blocks) as attachments, within
 * bounds: at most `count`, none bigger than `each` as a data URL, all of them no more than `total`
 * (review of 23 Nov, C4). What is past a bound, or not a picture in plain base64, is left out.
 */
export function appPictures(content: unknown, limits: { count: number; each: number; total: number }): Attachment[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: Attachment[] = [];
  let total = 0;
  for (const b of content as Obj[]) {
    if (out.length >= limits.count) break;
    const src = b?.type === 'image' ? (b.source as Obj | undefined) : undefined;
    if (src?.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string' || !PICTURE_KINDS.test(src.media_type)) continue;
    const dataUrl = `data:${src.media_type};base64,${src.data}`;
    if (dataUrl.length > limits.each || total + dataUrl.length > limits.total || !BASE64.test(src.data)) continue;
    total += dataUrl.length;
    const pad = src.data.endsWith('==') ? 2 : src.data.endsWith('=') ? 1 : 0;
    out.push({ id: `app-${out.length + 1}-${src.data.length.toString(36)}`, kind: 'image', name: `Picture ${out.length + 1}`, dataUrl, mime: src.media_type, size: Math.max(0, Math.floor((src.data.length * 3) / 4) - pad) });
  }
  return out.length ? out : undefined;
}

/**
 * Cards a chat saved twice for one message of Sable's own (review of 23 Nov, D-own; DIAG messages-M3),
 * for the bridge to drop when it reads the chat: a card from the Claude app (`remote`) whose provider
 * id is that of a card Sable sent before it is that message's replay, shown again by a fault since
 * fixed. Only with that proof: the same words alone never merge a message from the app into Sable's.
 */
export function ownReplays(items: readonly TimelineItem[]): string[] {
  const own = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    if (i.type !== 'user' || i.parentId || !i.providerId) continue;
    if (!i.remote) own.add(i.providerId);
    else if (own.has(i.providerId)) out.push(i.id);
  }
  return out;
}

// ── workflows ──

function humanName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

type WorkflowMeta = { name?: string; description?: string; phases: { title: string; detail?: string }[] };

/** A string value of `key` in a JS object literal's text (single, double or back quotes). */
function literal(key: string, from: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(from);
  return m ? m[2].replace(/\\(.)/g, '$1') : undefined;
}

/**
 * The `export const meta = { name, description, phases }` a workflow script begins with (a plain
 * literal, so it is read as text, nothing runs). Fields it cannot find are left out.
 */
export function workflowMeta(script: unknown): WorkflowMeta {
  const out: WorkflowMeta = { phases: [] };
  if (typeof script !== 'string') return out;
  const start = script.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) return out;
  // The literal ends where its braces balance (strings skipped).
  let depth = 0;
  let end = -1;
  let quote = '';
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    const c = script[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = script.slice(start, end < 0 ? Math.min(script.length, start + 4000) : end + 1);
  const phasesAt = body.search(/\bphases\s*:\s*\[/);
  const head = phasesAt < 0 ? body : body.slice(0, phasesAt);
  const name = literal('name', head);
  const description = literal('description', head);
  if (name) out.name = name;
  if (description) out.description = description;
  if (phasesAt >= 0) {
    for (const m of body.slice(phasesAt).matchAll(/\{([^{}]*)\}/g)) {
      const title = literal('title', m[1]);
      const detail = literal('detail', m[1]);
      if (title) out.phases.push(detail ? { title, detail } : { title });
    }
  }
  return out;
}

/** A new run from the Workflow call's input: its phases as the script declares them, none started yet. */
export function workflowStart(input: Obj): WorkflowRun {
  const meta = workflowMeta(input.script);
  const name = meta.name ?? (typeof input.name === 'string' ? input.name : undefined);
  return { ...(name ? { name } : {}), phases: meta.phases, phase: 0, agents: [], status: 'running' };
}

const AGENT_STATE: Record<string, WorkflowAgent['state']> = { done: 'done', error: 'error', failed: 'error', queued: 'queued' };
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Folds the CLI's `workflow_progress` rows (`workflow_phase` and `workflow_agent`, the latest row
 * per index; `workflow_log` and anything else ignored) into the run as known so far.
 */
export function mergeWorkflow(run: WorkflowRun, rows: unknown): WorkflowRun {
  if (!Array.isArray(rows) || !rows.length) return run;
  const phases = [...run.phases];
  let phase = run.phase;
  const agents = new Map(run.agents.map((a) => [a.index, a]));
  for (const r of rows as Obj[]) {
    if (!r || typeof r !== 'object' || typeof r.index !== 'number') continue;
    if (r.type === 'workflow_phase') {
      if (typeof r.title === 'string' && !phases[r.index - 1]) phases[r.index - 1] = { title: r.title };
      phase = Math.max(phase, r.index);
    } else if (r.type === 'workflow_agent') {
      const prev = agents.get(r.index);
      const a: WorkflowAgent = {
        ...prev,
        index: r.index,
        label: typeof r.label === 'string' && r.label ? r.label : (prev?.label ?? `Agent ${r.index}`),
        state: AGENT_STATE[String(r.state)] ?? (r.blocked ? 'error' : 'running'),
      };
      if (typeof r.phaseIndex === 'number') a.phase = r.phaseIndex;
      if (typeof r.model === 'string') a.model = r.model;
      if (count(r.startedAt)) a.startedAt = count(r.startedAt);
      if (count(r.tokens) !== undefined) a.tokens = count(r.tokens);
      if (count(r.toolCalls) !== undefined) a.steps = count(r.toolCalls);
      if (count(r.durationMs) !== undefined) a.durationMs = count(r.durationMs);
      const said = typeof r.lastToolSummary === 'string' && r.lastToolSummary.trim() ? r.lastToolSummary.trim() : typeof r.lastToolName === 'string' ? r.lastToolName : undefined;
      if (said) a.activity = said.length > 160 ? said.slice(0, 159) + '…' : said;
      if (typeof r.error === 'string' && r.error) a.error = r.error.slice(0, 400);
      agents.set(r.index, a);
      if (typeof r.phaseIndex === 'number') {
        phase = Math.max(phase, r.phaseIndex);
        if (typeof r.phaseTitle === 'string' && !phases[r.phaseIndex - 1]) phases[r.phaseIndex - 1] = { title: r.phaseTitle };
      }
    }
  }
  // A phase the rows skipped keeps its place under a plain name.
  for (let i = 0; i < phases.length; i++) phases[i] ??= { title: `Phase ${i + 1}` };
  return { ...run, phases, phase, agents: [...agents.values()].sort((a, b) => a.index - b.index) };
}

/** Files the agent hands the person (SendUserFile): their names and sizes, read once here. */
function describeShare(input: Record<string, unknown>): { kind: ToolKind; title: string; detail: ToolDetail } {
  const paths = (Array.isArray(input.files) ? input.files : []).filter((f): f is string => typeof f === 'string' && !!f.trim());
  const files: SharedFile[] = paths.map((p) => {
    let size: number | undefined;
    try {
      const st = statSync(p);
      if (st.isFile()) size = st.size;
    } catch {
      /* gone or not readable: shown without a size */
    }
    return { path: p, name: baseName(p), ...(size !== undefined ? { size } : {}) };
  });
  const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : undefined;
  const title = files.length === 1 ? files[0].name : `${files.length} files`;
  return { kind: 'share', title, detail: { files, ...(caption ? { caption } : {}) } };
}
