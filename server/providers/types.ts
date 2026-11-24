import type {
  UserItem,
  Capabilities,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  McpServerInfo,
  ProviderId,
  ProviderInfo,
  RateLimit,
  BridgeEvent,
  SessionOptions,
  AppSettings,
  ResetOutcome,
} from '../../shared/protocol';
import type { SessionRuntime } from '../core/runtime';
import type { AgentCall } from './agent-tool';
import type { ProfileAccess } from '../services/profile';
import type { TitlePrompt } from '../core/titles';

/** The account a provider instance serves. One instance exists per (provider, account) in use. */
export interface AccountContext {
  id: string;
  /**
   * The account's own config folder, managed by Sable. Absent for the built-in default
   * account, which uses the CLI's own config exactly as before.
   */
  dir?: string;
}

export interface ProviderContext {
  /** Events from this instance; the app tags auth and limit events with the account id. */
  emit: (event: BridgeEvent) => void;
  log: (...args: unknown[]) => void;
  /** Absent means the built-in default account. */
  account?: AccountContext;
  /** The app's current settings (read when an agent process starts). Absent in bare tests. */
  settings?: () => AppSettings;
  /** Agents a session can hand work to as sub-agents (installed and signed in, as last known); read when an agent process starts. */
  otherAgents?: () => ProviderId[];
  /** The user's profile: its prompt text and the remember_about_user tool (see services/profile.ts). Absent in bare tests. */
  profile?: () => ProfileAccess;
  /** The Customize chat's brief (`services/custom.ts`), appended to the prompt of a session with `SessionMeta.custom` only. */
  customBrief?: () => string;
  /** Runs a sub-agent of another agent for `rt`, nested under the tool step `itemId` (see `agent-tool.ts`). */
  runAgent?: (rt: SessionRuntime, call: AgentCall, itemId: string | undefined, signal?: AbortSignal) => Promise<{ ok: boolean; text: string }>;
}

/** How a message goes to the agent (`ProviderSession.send`). */
export interface SendOptions {
  /** Throws when the sender may no longer act: asked right before the message goes. */
  check?: () => void;
  /** Called once when the agent confirms delivery of this specific input. */
  taken?: () => void;
  /** A legacy result ended the input without enough evidence to retry it safely. */
  uncertain?: () => void;
  /** Release this send's reserved handover when delivery is abandoned. Idempotent. */
  release?: () => void;
}

/** A live connection between one SessionRuntime and the provider's agent process. */
export interface ProviderSession {
  /**
   * Delivers a user message. The UserItem is already on the timeline; when a turn is
   * running its `state` is "queued" and the adapter flips it to "sent" once consumed
   * (`rt.taken`). A `steered` item goes to the running agent now, to be taken at its next step.
   * `opts.check`: called right before the message goes to the agent (after any wait of the adapter's
   * own, as Codex loading its thread); it throws when the sender may no longer act (a phone removed
   * meanwhile), and then nothing goes and `send` rejects with that error.
   */
  send(item: UserItem, opts?: SendOptions): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  setMode(mode: string): Promise<void>;
  setFast?(fast: boolean): Promise<void>;
  /** The session's speed (`rt.meta.speed` already holds it): `standard` or a `SpeedInfo` id of its model. */
  setSpeed?(speed: string): Promise<void>;
  /** Claude Code ultracode on or off (`rt.meta.ultracode` already holds it). */
  setUltracode?(on: boolean): Promise<void>;
  rewind?(itemId: string, restoreFiles: boolean): Promise<{ ok: boolean; message?: string }>;
  /**
   * The agent's own fork at the end of the turn holding `itemId`: the new provider session id
   * (resumable), or null when it cannot (Sable then starts from a summary). The source stays as it is.
   */
  fork?(itemId: string): Promise<string | null>;
  context?(): Promise<ContextBreakdown | null>;
  mcp?(): Promise<McpServerInfo[]>;
  /**
   * Applies changed capabilities (`rt.meta.options` already holds them). Options that need a
   * new agent process restart it when idle and wait for the turn to end otherwise.
   */
  setOptions?(options: SessionOptions): Promise<void>;
  /** Releases the agent process. The session can be re-opened (resumed) later. */
  close(): Promise<void>;
  /**
   * What still runs in the agent's process, as the agent says it: a turn (one Sable began or one the
   * agent began by itself), background sub-agents, background commands and monitors (ambient tasks are
   * nobody's work and never counted), when the oldest of those commands began, and when a wake-up
   * the agent scheduled is due (only when it can be read for certain). Absent: nothing is known
   * (treat as none).
   */
  liveWork?(): { turn: boolean; agents: number; commands: number; oldestCommandAt?: number; newestCommandAt?: number; wakeAt?: number; notificationUntil?: number };
  /**
   * Resolves when the agent's process has exited after `close()`; rejects when it has not within the
   * provider's bound (then its transcript may still be written).
   */
  exited?(): Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  info(force?: boolean): Promise<ProviderInfo>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  /** A code the browser showed instead of returning to the app ("code#state"): finishes the sign-in in progress. */
  submitLoginCode?(code: string): Promise<void>;
  logout(): Promise<void>;
  /** Capabilities before a session exists (used by the home composer). */
  caps(cwd?: string): Promise<Capabilities>;
  /**
   * Plan limits. Emits `limits.updated` with `meta` when it actually read them; returns the last
   * known ones otherwise. `force`: the user asked (the agent may start a short process to read them).
   * `'fresh'`: as `force`, past the agent's own throttles: a reading taken after this call began (a
   * reset's reading after its dialog closed).
   */
  limits(force?: boolean | 'fresh'): Promise<RateLimit[]>;
  /**
   * Spends one of the account's reset credits (only on the user's confirmed click), then reads
   * the limits again. Present only for agents that report resets. `key` makes a retry idempotent.
   */
  useReset?(key: string): Promise<ResetOutcome>;
  /**
   * How to open this account's own agent straight into its limit reset dialog, for a console window
   * of its own (`core/reset-console.ts`): the program, its arguments, and the environment the agent
   * runs with for this account; `line`, the same for a person to type in a terminal. Present only for
   * agents whose resets Sable cannot spend itself.
   */
  limitResetCommand?(): { bin: string; args: string[]; env: NodeJS.ProcessEnv; line: string };
  history(cwd?: string, limit?: number): Promise<HistoryEntry[]>;
  /**
   * Binds a runtime to the provider. When `rt.meta.providerSessionId` is set the
   * provider resumes that conversation; if `loadTranscript` is true it must also
   * fill the runtime's timeline from the provider's stored history.
   */
  open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession>;
  /**
   * Starts an agent process for a session that is about to be created (no prompt is sent, so
   * no tokens). The first session opened with the same choice adopts it. One at a time.
   */
  prewarm?(choice: WarmChoice): Promise<void>;
  /** Stops the warm process, if any. */
  discardWarm?(): Promise<void>;
  /**
   * A chat's title from the agent's smallest model, on this provider's account: one prompt, no
   * tools, nothing kept (core/titles.ts). Resolves to the model's raw answer, or null. `holds`:
   * whether the chat still wants the title, to check right before the prompt goes out.
   */
  quickTitle?(prompt: TitlePrompt, signal: AbortSignal, holds?: () => boolean): Promise<string | null>;
  /** The config folder this account's agent reads and writes (its transcripts live there). */
  configHome?(): string;
  /**
   * Makes a conversation stored under another account of this agent (`fromHome`, that account's
   * `configHome()`) resumable by this one. True when this account can now resume `providerSessionId`.
   */
  adoptConversation?(fromHome: string, providerSessionId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface WarmChoice {
  cwd: string;
  model?: string;
  mode?: string;
  effort?: Effort;
  options?: SessionOptions;
  ultracode?: boolean;
}
