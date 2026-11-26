import type { ToolItem } from '../../shared/protocol';
import { WIDGET_SERVER } from './widget-tool';

/**
 * `track_work`: the agent tells Sable about work it started outside its own tools (a detached
 * process: a build, a test run, another agent's CLI), so the person sees it wherever a chat's work
 * is read and the agent is told once when it ends. Sable only watches (`server/core/track.ts`): the
 * tool starts, signals and ends nothing and runs no command. Claude Code gets it from the in-process
 * MCP server (`claude-widget.ts`), Codex as a client-defined dynamic tool (`codex.ts`); OpenCode
 * gets none of Sable's tools.
 */

export const TRACK_TOOL = 'track_work';
/** The tool's full name inside Claude Code. */
export const TRACK_TOOL_ID = `mcp__${WIDGET_SERVER}__${TRACK_TOOL}`;

/** A tool name from either agent that is this tool: its exact names only (another server's tool may end the same). */
export function isTrackTool(name: string | undefined): boolean {
  return name === TRACK_TOOL || name === TRACK_TOOL_ID;
}

/** The bounds of a call (`TRACK` in server/core/track.ts holds the watcher's own). */
export const TRACK_TITLE_MAX = 80;
export const TRACK_BY_MAX = 40;
export const TRACK_LOG_MAX = 1024;

/** The agent's only guidance: what it is for, when to use it, what it gets back. */
export const TRACK_DESCRIPTION = `Tell Sable about work you started that goes on outside your own tool calls, so the person can see it and you are told when it ends.

Use it right after you start anything that outlives the call that started it and that Sable does not already track: a detached process (nohup, setsid, Start-Process, a job you disowned), a long build or test run, another agent's CLI you launched from a shell and left running. Without it the chat reads as idle while that work runs. Not for a command you run in the background with your own shell tool, a sub-agent of your own or a delegate_to_* call: Sable tracks those by itself.

Sable only watches: it never starts, signals or stops the process and runs no command. While the process lives the chat shows as working (the sidebar, the chat's last line, the Agents tab, the phone) under \`title\`, with the last line of \`log\` when you name one. When the process is gone you get one message with the title, how long it ran and the last lines of the log, also when your turn has ended meanwhile: you may end your turn and wait for it, do not poll. Sable never learns an exit code: have the job write what you need to know (a result line, its exit status) to the log.

It returns at once. Tracked work is not stopped when the chat moves to another account or Sable restarts. At most 16 at once per chat.`;

export const TRACK_PARAMS = {
  title: { type: 'string', description: `What a person reads in a list, at most ${TRACK_TITLE_MAX} characters: who does what ("Codex builds the sign-in fix").`, required: true },
  pid: { type: 'integer', description: 'The process id to watch: the long-lived process itself, not a shell that started it and has exited.', required: true },
  log: { type: 'string', description: "Optional. A log file the process writes, inside this chat's folder (absolute, or relative to it). Its last line is shown as plain text.", required: false },
  by: { type: 'string', description: 'Optional. Who runs it, in a word or two ("Codex", "build").', required: false },
} as const;

/** JSON Schema of the input (Codex dynamic tool; the Claude server builds the same shape in zod). */
export const TRACK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: TRACK_PARAMS.title.description },
    pid: { type: 'integer', description: TRACK_PARAMS.pid.description },
    log: { type: 'string', description: TRACK_PARAMS.log.description },
    by: { type: 'string', description: TRACK_PARAMS.by.description },
  },
  required: ['title', 'pid'],
  additionalProperties: false,
} as const;

export interface TrackCall {
  title: string;
  pid: number;
  log?: string;
  by?: string;
}

/** One plain line of at most `max` characters: control characters and line breaks out, runs of space one. */
export function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Reads a call's arguments: the call, or the sentence that says why they are not usable. */
export function readTrackCall(args: unknown): TrackCall | string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const title = typeof a.title === 'string' ? oneLine(a.title, TRACK_TITLE_MAX) : '';
  if (!title) return 'Nothing is tracked: give the work a `title` a person can read.';
  const pid = typeof a.pid === 'number' ? a.pid : typeof a.pid === 'string' && /^\d{1,10}$/.test(a.pid.trim()) ? Number(a.pid.trim()) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return 'Nothing is tracked: `pid` must be the id of a running process (a whole number).';
  const log = typeof a.log === 'string' ? a.log.trim() : '';
  if (log.length > TRACK_LOG_MAX || /[\u0000-\u001f]/.test(log)) return 'Nothing is tracked: `log` is not a usable path.';
  const by = typeof a.by === 'string' ? oneLine(a.by, TRACK_BY_MAX) : '';
  return { title, pid, ...(log ? { log } : {}), ...(by ? { by } : {}) };
}

/** How the timeline shows a call: the work's title, who runs it (the log's place stays in the input). */
export function describeTrackCall(input: unknown): Pick<ToolItem, 'kind' | 'title' | 'detail'> {
  const call = readTrackCall(input);
  if (typeof call === 'string') return { kind: 'other', title: 'Track work', detail: {} };
  return { kind: 'other', title: call.title, detail: call.by ? { description: call.by } : {} };
}

/** Codex's `item/tool/call` answer (DynamicToolCallResponse). */
export function trackDynamicAnswer(r: { ok: boolean; text: string }): { contentItems: { type: 'inputText'; text: string }[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text: r.text }], success: r.ok };
}
