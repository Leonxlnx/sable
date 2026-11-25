import type { ProviderId, ToolItem } from '../../shared/protocol';
import { WIDGET_SERVER } from './widget-tool';

/**
 * A main Claude or Codex session can delegate to an installed, signed-in agent in the same folder.
 * The child's steps nest under the tool call and its permission prompts come to the parent chat.
 * A foreground call returns its answer. A detached child keeps its row and reports to the parent
 * when its turn ends.
 */

export const AGENT_TOOLS: Partial<Record<ProviderId, string>> = { codex: 'delegate_to_codex', claude: 'delegate_to_claude' };
const NAMES: Partial<Record<ProviderId, string>> = { codex: 'Codex', claude: 'Claude Code' };

/** The agent a tool name hands work to (plain, or as Claude Code names an MCP tool). */
export function agentOfTool(name: string | undefined): ProviderId | undefined {
  if (!name) return undefined;
  const plain = name.startsWith(`mcp__${WIDGET_SERVER}__`) ? name.slice(`mcp__${WIDGET_SERVER}__`.length) : name;
  for (const [p, n] of Object.entries(AGENT_TOOLS)) if (n === plain) return p as ProviderId;
  return undefined;
}

export const agentToolId = (agent: ProviderId) => `mcp__${WIDGET_SERVER}__${AGENT_TOOLS[agent]}`;

export function agentToolDescription(agent: ProviderId): string {
  const who = NAMES[agent] ?? agent;
  return [
    `Hand a self-contained task to ${who}, another coding agent, as a sub-agent working in this same folder.`,
    `Use it when the user asks for ${who}, or for a second opinion, a review, or a task that suits ${who}.`,
    `${who} starts with no memory of this conversation: say everything it needs in \`prompt\` (the goal, the files, the constraints, what to report back).`,
    'Its steps appear as it works and its final answer comes back to you.',
    'Set `background: true` to return immediately and receive its report when it finishes.',
  ].join(' ');
}

export const AGENT_PARAMS = {
  background: { type: 'boolean', description: 'Return immediately and receive the report when the sub-agent finishes.', required: false },
  description: { type: 'string', description: 'A short title for the task, 3 to 6 words.', required: true },
  prompt: { type: 'string', description: 'The whole task for the sub-agent, self-contained.', required: true },
  model: { type: 'string', description: 'A model id of that agent; leave it out for its default.', required: false },
} as const;

export const AGENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    background: { type: 'boolean', description: AGENT_PARAMS.background.description },
    description: { type: 'string', description: AGENT_PARAMS.description.description },
    prompt: { type: 'string', description: AGENT_PARAMS.prompt.description },
    model: { type: 'string', description: AGENT_PARAMS.model.description },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
};

export interface AgentCall {
  agent: ProviderId;
  description: string;
  prompt: string;
  model?: string;
  background?: boolean;
}

/** Reads a call's arguments; null when they are not usable. */
export function readAgentCall(agent: ProviderId, args: unknown): AgentCall | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
  if (!prompt) return null;
  const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : prompt.split('\n')[0].slice(0, 60);
  return { agent, description, prompt, ...(a.background === true && { background: true }), ...(typeof a.model === 'string' && a.model.trim() ? { model: a.model.trim() } : {}) };
}

/** How the timeline shows a call: the sub-agent's title, its prompt in the details. */
export function describeAgentCall(agent: ProviderId, input: unknown): Pick<ToolItem, 'kind' | 'title' | 'detail'> {
  const a = (input ?? {}) as Record<string, unknown>;
  const description = typeof a.description === 'string' && a.description ? a.description : `Ask ${NAMES[agent] ?? agent}`;
  return { kind: 'agent', title: description, detail: { subagent: NAMES[agent] ?? agent, description, prompt: typeof a.prompt === 'string' ? a.prompt : undefined } };
}
