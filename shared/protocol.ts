/**
 * Sable wire protocol — the single contract between the bridge (Node) and the UI.
 *
 * The bridge owns all state (sessions, timelines, pending prompts). The UI is a view:
 * it calls RPC methods and applies pushed events. Every provider (Claude Code, Codex,
 * the scripted demo) is normalized into the same timeline model so the UI never
 * branches on provider.
 */

// ───────────────────────────── providers & auth ─────────────────────────────

export type ProviderId = 'claude' | 'codex' | 'opencode' | 'demo';

export interface AuthState {
  loggedIn: boolean;
  /** e.g. "claude.ai", "chatgpt", "apiKey" */
  method?: string;
  email?: string;
  /**
   * Display-ready name of the connected plan: "Max", "Pro", "Ultra", "Team", "Plus",
   * "Business", "API key", "Console"… Absent when unknown.
   */
  plan?: string;
  /** The agent's raw plan / subscription value ("max", "plus", "Claude Ultra"…), when it reported one. */
  planId?: string;
  org?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  installed: boolean;
  version?: string;
  /** The built-in default account's sign-in (same as `accounts[0].auth`). */
  auth: AuthState;
  /** Set when the CLI is missing or broken. */
  problem?: string;
  /** Every profile of this agent, the built-in `default` first. Absent from older bridges. */
  accounts?: AccountInfo[];
  /**
   * Warnings the agent gave in this app run about its own setup (Codex: unrecognized keys in its
   * config.toml), each once. Shown as a quiet line in Settings › Agents, never in a conversation.
   */
  warnings?: { text: string; detail?: string }[];
}

/** The id of the account every provider always has: the CLI's own config (~/.claude, ~/.codex). */
export const DEFAULT_ACCOUNT = 'default';

/**
 * A named, isolated agent profile. Extra accounts get their own config folder managed by
 * Sable (own sign-in, settings, skills, plugins, MCP servers and history).
 */
export interface AccountInfo {
  id: string;
  provider: ProviderId;
  label: string;
  /** New sessions with this agent use this account unless told otherwise. */
  isDefault: boolean;
  auth: AuthState;
  /** Plan limits, when known. */
  limits?: RateLimit[];
  /** The account's config folder; absent for the built-in default (the CLI's own). */
  dir?: string;
  problem?: string;
  /** A folder the user already had ("Use an existing folder"): removing the account forgets it, never deletes it. */
  external?: boolean;
}

/** A config folder under the home folder that looks like an agent's own, offered by "Use an existing folder". */
export interface AccountFolder {
  dir: string;
  /** The folder's name as shown ("claude-work"). */
  name: string;
}

/** A turn the agent refused because the account is at a plan limit (on the notice that says so). */
export interface LimitHit {
  /** Filled in by the bridge when the turn ends. */
  provider?: ProviderId;
  accountId?: string;
  /** When the window that refused it resets (ms), when known. */
  resetsAt?: number;
  /** Which window, as the limit rows name it ("5-hour limit"). */
  window?: string;
  /** Another signed-in account of the same agent with room, to continue with. */
  next?: string;
  /** The session carried on with this account. */
  continuedWith?: string;
  /** It carried on with the same account once the window reset ("Continue at reset", `SpareWait`). */
  atReset?: boolean;
}

/** Reasoning effort, lowest first. `ultra` is Codex's level above `max` (the model may delegate to sub-agents). */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  efforts?: Effort[];
  defaultEffort?: Effort;
  supportsFast?: boolean;
  isDefault?: boolean;
  /**
   * The agent offers this model in its own picker (Codex: not hidden and not superseded; Claude
   * Code: every model it reports). Absent when the agent does not say (older caches).
   */
  picker?: boolean;
  /** The section the model menu lists it under (OpenCode: where the model comes from, "Free", "OpenCode Go"); models of one group are listed together. */
  group?: string;
  /** Speeds beyond standard the agent can run this model at (Claude Code's fast mode, Codex's service tiers). */
  speeds?: SpeedInfo[];
}

/** A speed beyond standard. Ids are the agent's own (Claude Code: `fast`; Codex: its service tier ids). */
export interface SpeedInfo {
  id: string;
  name: string;
  /** A few words for the tooltip (that it costs more), when the agent says so. */
  note?: string;
  /** Billed outside the plan (Claude Code's fast mode draws on extra usage): offered only with extra usage on, never a default, asked once per session. */
  paid?: boolean;
}

/** The speed every model runs at when nothing else is chosen. */
export const STANDARD_SPEED = 'standard';

export type ModeTone = 'ask' | 'edit' | 'plan' | 'auto' | 'danger';

/** A permission / approval preset. Ids are provider-defined. */
export interface ModeInfo {
  id: string;
  name: string;
  description: string;
  tone: ModeTone;
}

export type CommandKind = 'app' | 'builtin' | 'command' | 'skill';

export interface CommandInfo {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  kind: CommandKind;
  source?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source?: string;
  path?: string;
  enabled?: boolean;
}

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  source?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  /** `configured`: named in the agent's config; the agent does not report whether it started (OpenCode). */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'configured';
  scope?: string;
  error?: string;
  version?: string;
  tools?: McpToolInfo[];
}

export interface Capabilities {
  models: ModelInfo[];
  modes: ModeInfo[];
  commands: CommandInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  tools: string[];
  /** Character that invokes a skill inline: "/" for Claude Code, "$" for Codex. */
  skillTrigger: '/' | '$';
  features: {
    images: boolean;
    thinking: boolean;
    rewind: boolean;
    /** Can a message be injected while a turn is running? */
    steer: boolean;
    compact: boolean;
    fast: boolean;
    /** The agent can drive a web browser in this setup (Claude in Chrome, Codex's browser plugin). */
    browser?: boolean;
    /** The agent can see and control the desktop in this setup. */
    computerUse?: boolean;
    /** The session can be continued from another device (claude.ai/code, the ChatGPT app). */
    remoteControl?: boolean;
    /** Codex: browser and computer use come from one plugin and switch together. */
    linkedBrowserComputer?: boolean;
    /** Claude Code's ultracode mode (standing workflow orchestration) can be switched (`session.setUltracode`). */
    ultracode?: boolean;
  };
}

/** Per-session agent capabilities the user switches on. Applied when the agent process starts. */
export interface SessionOptions {
  /** Set by Sable for a turn check's agent: it may read but has no tool that changes or runs anything, and none of Sable's browser or device tools. */
  readOnly?: boolean;
  browser?: boolean;
  computerUse?: boolean;
  remoteControl?: boolean;
  /** The agent sees Sable's own Browser tab (browser_read, browser_screenshot, browser_open and a line on what it shows). Absent means on. */
  browserTab?: boolean;
  /** The agent sees and works Android devices and the emulator (the device_* tools, the side panel's Device tab). Absent means on when the Android SDK or adb is found. */
  device?: boolean;
}

/** An Android device or emulator adb can reach (`device.list`). */
export interface DeviceInfo {
  /** adb's serial: emulator-5554, a USB serial, or 192.168.1.20:5555 over Wi-Fi. */
  serial: string;
  /** adb's state: device (ready), offline, unauthorized (accept the prompt on the phone), or booting (an emulator Sable started, not ready yet). */
  state: 'device' | 'offline' | 'unauthorized' | 'booting' | 'other';
  kind: 'emulator' | 'usb' | 'wifi';
  /** The model adb reports ("Pixel 8"); for an emulator, its AVD name. */
  name: string;
  /** An emulator Sable started (Sable stops it when it quits). */
  sable?: boolean;
}

/** What `device.list` answers and `device.updated` carries. */
export interface DeviceStatus {
  /** adb was found (ANDROID_HOME's platform-tools, or on the PATH). */
  adb: boolean;
  /** The emulator is installed; `avds` are the virtual devices it can start. */
  emulator: boolean;
  avds: string[];
  devices: DeviceInfo[];
  /** The device the Device tab shows and the agent's tools use when there are several. */
  preferred?: string;
  /** The last emulator start that failed, in a few words. */
  error?: string;
}

/** One picture of a device's screen (`device.screenshot`): a PNG data URL in device pixels. */
export interface DeviceFrame {
  serial: string;
  data: string;
  width: number;
  height: number;
  at: number;
}

/** The keys the device tools press. */
export type DeviceKey = 'back' | 'home' | 'recent' | 'enter' | 'delete' | 'tab' | 'escape' | 'up' | 'down' | 'left' | 'right' | 'menu' | 'power' | 'volume_up' | 'volume_down';

/** A request from the bridge to the window that shows a session's Browser tab (the agent's browser tools). */
export interface BrowserRequest {
  id: string;
  sessionId: string;
  /** state: address and title only; read: the page's text and logs; screenshot: a picture; open: load `url` and wait. */
  op: 'state' | 'read' | 'screenshot' | 'open' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'eval' | 'logs' | 'wait' | 'navigate';
  url?: string;
  /** open: in a new tab rather than the one in front. Every other op works on the tab in front. */
  newTab?: boolean;
  selector?: string;
  /** read and screenshot: refuse when the page moved to another origin since it was checked. */
  expectOrigin?: string;
  /** click, type, scroll: a reference from a snapshot ("e12"). */
  ref?: string;
  /** click: the visible text of the element. */
  find?: string;
  /** type: what to type. */
  text?: string;
  /** type: press Enter in the field afterwards. */
  submit?: boolean;
  /** press: the key ("Enter", "Escape", "Control+K"). */
  key?: string;
  /** scroll: "top", "bottom" (else `ref` or `selector`), or pixels down in `by`. */
  to?: string;
  by?: number;
  /** eval: the body of an async function. */
  script?: string;
  /** logs: which log. */
  kind?: 'console' | 'network';
  /** wait: how long at most. */
  timeoutMs?: number;
  /** navigate. */
  action?: 'back' | 'forward' | 'reload';
}

export interface BrowserLogEntry {
  level: 'error' | 'warning';
  text: string;
  source?: string;
}

/** One line of the page's console, any level. */
export interface BrowserConsoleLine {
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  text: string;
  source?: string;
}

/** One request the page made (address without its query). */
export interface BrowserNetRequest {
  url: string;
  kind?: string;
  method?: string;
  status?: number;
  ms?: number;
  error?: string;
}

export interface BrowserFailedRequest {
  url: string;
  method?: string;
  status?: number;
  error?: string;
}

/** The window's answer. `weak`: this window cannot serve it (web build, another session shown); a better answer may follow. */
export interface BrowserAnswer {
  ok: boolean;
  weak?: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  /** The text was longer than the bound and was cut. */
  truncated?: boolean;
  console?: BrowserLogEntry[];
  failed?: BrowserFailedRequest[];
  /** Entries left out beyond the bounds. */
  more?: { console?: number; failed?: number };
  /** screenshot: a data URL. */
  image?: string;
  width?: number;
  height?: number;
  /** click, type, scroll: the element acted on, in the page's words ("button \"Sign in\""). */
  target?: string;
  /** The page went to another document while the tool ran. */
  navigated?: boolean;
  /** snapshot: how many elements the outline lists. wait: milliseconds waited. */
  count?: number;
  /** wait: the time ran out. */
  timedOut?: boolean;
  /** logs. */
  lines?: BrowserConsoleLine[];
  requests?: BrowserNetRequest[];
}

/** State of an optional capability the user may need to act on. */
export interface CapabilityState {
  /** One short line: "Connected to Chrome", "Chrome extension not connected". */
  status: string;
  tone?: 'ok' | 'waiting' | 'error';
  /** A link to open (the remote session). */
  url?: string;
  /** A code to type on the other device. */
  code?: string;
}

// ───────────────────────────────── sessions ─────────────────────────────────

export type SessionStatus = 'idle' | 'starting' | 'running' | 'awaiting' | 'error';

export interface SessionUsage {
  contextTokens?: number;
  contextWindow?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
  turns: number;
}

export interface SessionMeta {
  id: string;
  provider: ProviderId;
  /** The provider's own id (Claude session uuid / Codex thread id) once known. */
  providerSessionId?: string;
  cwd: string;
  title: string;
  titleSource: 'auto' | 'user';
  /** A small model was asked for this chat's title after its first turn (once per chat, whatever came of it; `server/core/titles.ts`). */
  titleAsked?: boolean;
  model: string;
  effort?: Effort;
  mode: string;
  fast?: boolean;
  /** The chosen speed (`ModelInfo.speeds` id); absent or `standard` is standard. `fast` mirrors it being non-standard. */
  speed?: string;
  /** The limit handover moved this session here from this account (its preferred one). */
  movedFrom?: string;
  /** A chat started without a folder: it runs in a fresh folder Sable made for it under the chats folder (`AppSettings.chatsFolder`). */
  chat?: boolean;
  /** Claude Code ultracode is on for this session (see `Capabilities.features.ultracode`). */
  ultracode?: boolean;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  unread?: boolean;
  pinned?: boolean;
  archived?: boolean;
  branch?: string;
  usage: SessionUsage;
  lastError?: string;
  /** One line describing what the agent is doing right now. */
  activity?: string;
  /** The account the session runs under; absent means `default`. */
  accountId?: string;
  /** Capabilities switched on for this session (browser, computer use, remote control). */
  options?: SessionOptions;
  /** Remote control state: the link or pairing code to continue elsewhere. */
  remote?: { url?: string; code?: string; status: string; tone?: CapabilityState['tone'] };
  /** Live state of the browser and computer-use capabilities, when there is something to say. */
  capState?: { browser?: CapabilityState; computerUse?: CapabilityState };
  /** `/until <check>` is armed: after each turn Sable runs the check and sends a failure back. Ends with Sable (not resumed after a restart). Null once it ended (patches travel as JSON). */
  until?: UntilState | null;
  /** The session works in a lane of its own (a git worktree on a branch of its own); `cwd` is inside it. Null once it landed or was discarded (patches travel as JSON). */
  lane?: SessionLane | null;
  /** The chat races another on the same task (`SessionRace`). Null once its rival was deleted (patches travel as JSON). */
  race?: SessionRace | null;
  /** The chat waits to start by itself: on spare quota, or at a limit's reset (`SpareWait`). Null once it started or was cancelled (patches travel as JSON). */
  spare?: SpareWait | null;
  /**
   * The agents this chat has run with (`session.switchAgent`), one entry per agent, the current one
   * included once it switched: each keeps its own conversation, so switching back resumes it.
   */
  agents?: AgentLeg[];
  /** The next message goes out with a handover of the conversation (after a switch of agent); null once sent. */
  agentHandover?: AgentHandover | null;
}

/**
 * One agent's part in a chat that switched agents in place: what it resumes with when the chat
 * switches back to it. The current agent's entry is written when the chat leaves it.
 */
export interface AgentLeg {
  provider: ProviderId;
  /** That agent's own conversation (Claude session / Codex thread), once it had one. */
  providerSessionId?: string;
  /** The folder it worked in (a chat that moved into a lane since starts Claude Code's conversation anew there). */
  cwd?: string;
  model: string;
  effort?: Effort;
  mode: string;
  accountId?: string;
  speed?: string;
  ultracode?: boolean;
  options?: SessionOptions;
  /** Its context use when it was left. */
  context?: { tokens?: number; window?: number };
  /**
   * The last root item that agent's own conversation covers (the switch line where it was left);
   * absent when it has none of this chat yet. What follows it is new to that agent.
   */
  knows?: string;
}

/** A handover sent ahead of the next message: what happened after `since` (absent: the whole chat), under `from`. */
export interface AgentHandover {
  from: ProviderId;
  since?: string;
}

/**
 * A chat switched agents here (`session.switchAgent`); `back`: to an agent it had run with before;
 * `past`: a later switch followed (only the latest line offers to switch back).
 */
export interface AgentSwitchMark {
  from: ProviderId;
  to: ProviderId;
  back?: boolean;
  past?: boolean;
}

/**
 * The model a typed name stands for (`/model opus`, `/model gpt-5.1`): its id, its name, the
 * versioned name its description starts with ("Opus 5.5 · …"), then the start of its id or name,
 * or of a word in its name ("mini"), models the agent's own picker offers first. Case, spaces and
 * dashes do not matter. Undefined when none fits.
 */
export function matchModel(query: string, models: ModelInfo[]): ModelInfo | undefined {
  const flat = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  const q = flat(query);
  if (!q) return undefined;
  const head = (m: ModelInfo) => m.description?.split(/\s+·\s+/)[0];
  const offered = (list: ModelInfo[]) => list.find((m) => m.picker !== false) ?? list[0];
  const exact = models.find((m) => m.id.toLowerCase() === query.trim().toLowerCase()) ?? models.find((m) => flat(m.id) === q || flat(m.name) === q);
  if (exact) return exact;
  // An alias describes itself by the model it stands for: the model of that name goes first.
  const named = models.filter((m) => flat(head(m)) === q);
  if (named.length) return named.find((m) => flat(head(m)).startsWith(flat(m.name))) ?? named[0];
  const starts = models.filter((m) => flat(m.id).startsWith(q) || flat(m.name).startsWith(q));
  if (starts.length) return offered(starts);
  const word = models.filter((m) => m.name.toLowerCase().split(/[\s_-]+/).some((w) => flat(w).startsWith(q)));
  return word.length ? offered(word) : undefined;
}

/**
 * Spare (`server/core/spare.ts`): a chat that starts by itself. `spare`: its held messages start
 * when an account of its agent has weekly quota that would go unused at the current pace, room in
 * its 5-hour window and under its cap (never credits, never a reset grant), at most two such turns
 * at once. `reset`: "Continue at reset" after a turn a plan limit refused, at `at` on `accountId`.
 * Waits survive a restart.
 */
export interface SpareWait {
  reason: 'spare' | 'reset';
  /** When the chat began to wait (first come, first served). */
  since: number;
  /** reset: when the account's window resets. spare: when it is expected to start, when a window that resets then is what holds it. */
  at?: number;
  /** reset: the account it continues on. spare: the account it is expected to start on at `at`. */
  accountId?: string;
  /** Queued messages (`QueuedMessage` ids) held back, in the order sent: each goes out only when the planner starts it (or by hand); after a spare turn met a limit, its refused message is first. */
  held?: string[];
}

/**
 * Lanes: a session that starts in a git folder where another session is working gets a git
 * worktree on a branch of its own (`sable/<short title>`), so the two never edit the same files.
 * The lane is a property of the chat: it stays in its folder in the sidebar and comes back there
 * when the lane lands or is discarded (`server/core/lanes.ts`, `server/services/git-lanes.ts`).
 */
export interface SessionLane {
  /** The folder the session was started in, where it returns when the lane ends. */
  folder: string;
  /** The repository's top level of that folder (its main checkout). */
  root: string;
  /** The worktree's top level, under Sable's lanes folder. */
  path: string;
  branch: string;
  /** The commit the lane started from. */
  base: string;
  /** The folder's branch when the lane began (absent on a detached head). */
  from?: string;
  createdAt: number;
  /** Ignored folders of the main checkout shared into the lane through a link (`node_modules`). */
  links?: string[];
  /** The branch still has its first, made-up name: the first message names it. */
  provisional?: boolean;
}

/** Whether a lane would land on the folder's branch now (a dry merge; nothing is changed). */
export interface LaneForecast {
  /** `clean`: lands without conflicts; `conflicts`: these files conflict with the branch; `blocked`: the folder has uncommitted edits in files the lane changes; `nothing`: no work to land; `unavailable`: see `reason`. */
  state: 'clean' | 'conflicts' | 'blocked' | 'nothing' | 'unavailable';
  /** The folder's current branch, where the lane lands. */
  target?: string;
  /** The lane's commits the branch does not have. */
  ahead: number;
  /** The branch's commits the lane does not have. */
  behind: number;
  /** Files the lane changed but did not commit (Land commits them first). */
  uncommitted: number;
  /** What landing brings: files, lines added and removed. */
  files: number;
  additions: number;
  deletions: number;
  /** Repository-relative paths. */
  conflicts: string[];
  blocked: string[];
  reason?: string;
}

export interface LaneLandResult {
  ok: boolean;
  error?: string;
  conflicts?: string[];
  blocked?: string[];
  /** How it landed: the branch moved forward to the lane, the lane's commits were replayed on the branch first, or a merge commit joined them. */
  how?: 'fast-forward' | 'rebase' | 'merge';
  commits?: number;
  target?: string;
}

/**
 * Race (`server/core/race.ts`): one task given to two agents at once (Claude Code and Codex, or two
 * models of one agent), each chat in a lane of its own made from the same folder. The person keeps
 * one lane (it lands) and the other is discarded. Both chats carry the pairing; it is stored with
 * the sessions, so a race survives a restart.
 */
export interface SessionRace {
  id: string;
  /** The other chat in the race. */
  rival: string;
  /** The chat's column: 0 left, 1 right. */
  side: 0 | 1;
  /** The task both were given. */
  task: string;
  /** The folder both lanes were made from. */
  folder: string;
  startedAt: number;
  /** How the race ended for this chat: its lane landed (`kept`) or was discarded (`dropped`). Absent while it runs. */
  outcome?: 'kept' | 'dropped';
  endedAt?: number;
}

/** What `race.keep` answers: the land's result; once landed, whether the other lane went too (`warning` when it could not). */
export interface RaceKeepResult extends LaneLandResult {
  discarded?: boolean;
  warning?: string;
}

/**
 * Until green: a check command Sable runs in the session's folder after each turn that ends
 * normally, sending the failure back to the agent until it passes, the rounds run out, the
 * account's usage share for the loop is spent, or the user stops it (`server/core/until.ts`).
 */
export interface UntilState {
  check: string;
  /** The round limit. */
  rounds: number;
  /** The round in progress, 1-based: its check runs when the agent's turn ends. */
  round: number;
  /** `working`: the agent's turn runs; `checking`: Sable runs the check; `paused`: the last turn was stopped or failed, the check waits for the next turn. */
  phase: 'working' | 'checking' | 'paused';
  /** When the check in progress (or the last one) started, ms. */
  since?: number;
  /** Failing tests or errors in the last failing check, when its output said. */
  failing?: number;
  /** Points of the account's weekly window the loop may use. */
  usage: number;
  /** Points used so far, when the limits say. */
  used?: number;
  startedAt: number;
}

/** What one check found. */
export interface UntilCheck {
  command: string;
  round: number;
  rounds: number;
  passed: boolean;
  exitCode?: number | null;
  /** Failing tests or errors, when the output says how many. */
  failing?: number;
  /** Passing tests, when the output says. */
  passing?: number;
  timedOut?: boolean;
  durationMs: number;
  /** The useful part of the output (failures, first errors, the summary), trimmed. */
  output?: string;
}

/** How a loop ended. */
export type UntilEnd = 'passed' | 'rounds' | 'usage' | 'cap' | 'stopped' | 'broken' | 'restart';

/**
 * Marks the timeline's part of a loop: the message Sable sent for a failing check (a user item with
 * `check`, shown as the check's row), and the notice that ends the loop (`end`, with the last
 * check when it ended on one).
 */
export interface UntilMark {
  check?: UntilCheck;
  end?: UntilEnd;
}

/** A session that exists on disk at the provider but is not open in Sable. */
export interface HistoryEntry {
  provider: ProviderId;
  providerSessionId: string;
  title: string;
  cwd?: string;
  branch?: string;
  updatedAt: number;
  preview?: string;
}

// ───────────────────────────────── timeline ─────────────────────────────────

export interface Attachment {
  id: string;
  kind: 'image' | 'file' | 'text';
  name: string;
  /** Absolute path for files; data URL for pasted images. */
  path?: string;
  dataUrl?: string;
  mime?: string;
  size?: number;
  text?: string;
}

interface BaseItem {
  id: string;
  /**
   * When the item was created (ms since epoch): when a message was sent (or taken from the
   * queue), when a text or thinking block started streaming, when a tool call began. Items
   * loaded from history carry the provider's stored times.
   */
  ts: number;
  /** Tool item id of the subagent this item belongs to. */
  parentId?: string;
}

export interface UserItem extends BaseItem {
  type: 'user';
  text: string;
  attachments?: Attachment[];
  /**
   * 'queued': handed to the agent while it works, not taken yet (a steered message stays where
   * it was sent; other queued items move down to where the agent takes them). 'sent': taken.
   */
  state?: 'queued' | 'sent';
  /** Sent into a running turn (`session.send` with `steer`, or `queue.sendNow`): the agent takes it at its next step. */
  steered?: boolean;
  /** Sent from elsewhere into this conversation (Remote Control in the Claude app or on claude.ai), not from Sable. */
  remote?: boolean;
  /** Provider message id, used for rewind. */
  providerId?: string;
  /** Sent by Sable for a failing `/until` check: shown as the check's row, not as a message. */
  until?: UntilMark;
}

export interface TextItem extends BaseItem {
  type: 'text';
  text: string;
  streaming: boolean;
}

export interface ThinkingItem extends BaseItem {
  type: 'thinking';
  text: string;
  streaming: boolean;
  endedAt?: number;
}

export type ToolKind =
  | 'bash'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'glob'
  | 'fetch'
  | 'websearch'
  | 'agent'
  | 'todo'
  | 'mcp'
  | 'question'
  | 'plan'
  | 'skill'
  /** Generative UI: the agent's `show_widget` call, shown as the widget itself (input: { title, code }). */
  | 'widget'
  /** Sable's own Browser tab: browser_read, browser_screenshot, browser_open (detail.url is the page). */
  | 'browser'
  /** An Android device or the emulator: the device_* tools (a screenshot comes back as the result's picture). */
  | 'device'
  /** Files the agent hands the person (Claude Code's SendUserFile): shown as file cards in the conversation (`detail.files`). */
  | 'share'
  | 'other';

export type ToolStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'error' | 'denied' | 'cancelled';

export interface Todo {
  id?: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines prefixed with " ", "+" or "-". */
  lines: string[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
}

/** Normalized, display-ready view of a tool's input. All fields optional. */
export interface ToolDetail {
  command?: string;
  description?: string;
  cwd?: string;
  background?: boolean;
  path?: string;
  range?: [number, number];
  pattern?: string;
  glob?: string;
  url?: string;
  query?: string;
  oldText?: string;
  newText?: string;
  content?: string;
  subagent?: string;
  prompt?: string;
  todos?: Todo[];
  questions?: Question[];
  plan?: string;
  server?: string;
  tool?: string;
  skill?: string;
  /** `share`: the files handed over (absolute paths; size when it could be read) and the agent's caption. */
  files?: SharedFile[];
  caption?: string;
}

export interface SharedFile {
  path: string;
  name: string;
  size?: number;
}

export interface ToolResult {
  text?: string;
  stderr?: string;
  exitCode?: number;
  isError?: boolean;
  interrupted?: boolean;
  diff?: FileDiff[];
  file?: { path: string; content?: string; startLine?: number; numLines?: number; totalLines?: number };
  files?: string[];
  count?: number;
  links?: { title: string; url: string }[];
  images?: string[];
  answers?: Record<string, string[]>;
  truncated?: boolean;
  /**
   * A sub-agent's own figures, only as the agent reported them (Claude Code: the Agent tool's result
   * and its task notifications). `background`: it was started in the background, and where it stands.
   */
  agent?: AgentStats;
}

export interface AgentStats {
  tokens?: number;
  steps?: number;
  durationMs?: number;
  background?: 'running' | 'done' | 'failed' | 'stopped';
  /** It stopped at a plan limit (its own model's window, e.g. Fable's weekly one): which window, and its reset when known. */
  limit?: { window: string; resetsAt?: number };
}

/**
 * A Claude Code workflow (the Workflow tool) as it runs in the background: the phases its script
 * declares, and every agent it started, from the CLI's own progress rows. Kept on the tool item.
 */
export interface WorkflowRun {
  /** The script's meta.name. */
  name?: string;
  /** Phases in order: those the script declares, then any the run named that it did not. */
  phases: { title: string; detail?: string }[];
  /** How many phases have started (1-based index of the latest), 0 before the first. */
  phase: number;
  agents: WorkflowAgent[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  /** Totals over its agents, as the CLI counts them. */
  tokens?: number;
  steps?: number;
  /** Set when it finished. */
  durationMs?: number;
  /** Waiting for a plan limit to reset before its agents go on. */
  limitWait?: { resetsAt?: number };
}

export interface WorkflowAgent {
  index: number;
  label: string;
  /** 1-based phase it runs in, when the script put it in one. */
  phase?: number;
  state: 'queued' | 'running' | 'done' | 'error';
  model?: string;
  startedAt?: number;
  tokens?: number;
  steps?: number;
  durationMs?: number;
  /** What it does now, or what it said last. */
  activity?: string;
  error?: string;
}

export interface ToolItem extends BaseItem {
  type: 'tool';
  /** Raw provider tool name, e.g. "Bash", "mcp__github__create_issue". */
  name: string;
  kind: ToolKind;
  /** Short human label: "Read session.ts", "Run tests". */
  title: string;
  status: ToolStatus;
  detail: ToolDetail;
  /** Raw input; while streaming this may be missing and `inputText` grows. */
  input?: unknown;
  inputText?: string;
  /** Live output while running (bash stdout etc). */
  output?: string;
  result?: ToolResult;
  endedAt?: number;
  /**
   * Time between `ts` and `endedAt` the session spent waiting for the user (approvals, questions,
   * this call's own or earlier calls' in the same batch): not part of the step's own running time.
   */
  waitedMs?: number;
  /** A Workflow call: its phases and agents while it runs in the background and once it is done. */
  workflow?: WorkflowRun;
  /** A check of a finished turn by the other agent (`turn.check`): a root step, shown under the turn it checks, never part of a turn. */
  check?: TurnCheck;
  /**
   * Set by the bridge only, on a finished step in a whole timeline sent to a window (a snapshot,
   * `timeline.reset`): its long output or result was cut (the start and end of long texts kept,
   * pictures left out). `session.item` returns it whole. Never on disk.
   */
  more?: boolean;
}

/**
 * "Check with Codex" (or Claude Code): the other agent reviews a finished turn's changes read-only,
 * as a child run whose steps nest under this step. Its findings are the step's `result.text`.
 */
export interface TurnCheck {
  /** The checked turn: the id of the message that started it. */
  turn: string;
  /** The agent that checks. */
  agent: ProviderId;
  /** The changes were too long for the brief and were cut (the checker was told to read the files). */
  cut?: boolean;
}

export interface NoticeItem extends BaseItem {
  type: 'notice';
  variant: 'info' | 'error' | 'interrupted' | 'compact' | 'retry' | 'mode' | 'model' | 'command' | 'rewind';
  text: string;
  detail?: string;
  /** The turn was refused at a plan limit (shown by `features/accounts`' LimitNotice). */
  limit?: LimitHit;
  /** A `/until` loop ended here (shown as its end line, under its last check). */
  until?: UntilMark;
  /** The chat switched agents here (shown as one line with "Switch back" while it is the latest switch). */
  agentSwitch?: AgentSwitchMark;
}

/** Closes a turn: duration, cost, token counts. */
export interface TurnItem extends BaseItem {
  type: 'turn';
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  error?: string;
}

export type TimelineItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem | TurnItem;

// ───────────────────────────── prompts to the user ──────────────────────────

export interface PermissionOption {
  id: string;
  label: string;
  hint?: string;
  tone: 'allow' | 'always' | 'deny';
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  /** Tool item this request gates, if any. */
  itemId?: string;
  toolName: string;
  kind: ToolKind;
  title: string;
  description?: string;
  detail: ToolDetail;
  diff?: FileDiff[];
  reason?: string;
  options: PermissionOption[];
  /** When true the UI offers a free-text field with the deny option. */
  allowFeedback?: boolean;
  createdAt: number;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  itemId?: string;
  questions: Question[];
  createdAt: number;
}

// ─────────────────────────────── workspace data ─────────────────────────────

export interface Project {
  path: string;
  name: string;
  lastOpened: number;
  pinned?: boolean;
  /** Place in the sidebar's manual folder order (lower first). Set with `project.reorder`; a new folder goes on top. */
  order?: number;
  /** Removed from the sidebar with its sessions (nothing deleted); opening the folder again brings both back. */
  hidden?: boolean;
  /**
   * The project (`FolderGroup.id`) this folder belongs to; absent: a loose folder. In a project,
   * `order` is the folder's place among the project's folders; loose, among the sidebar's top entries.
   */
  group?: string;
}

/**
 * A project: several folders under one name in the sidebar (a product with its app, server and
 * site). It shares the manual order with loose folders and the chats group (`order`).
 */
export interface FolderGroup {
  id: string;
  name: string;
  /** Place among the sidebar's top entries (loose folders' `Project.order`, `AppState.chatsOrder`). */
  order: number;
  createdAt: number;
}

/** "Use up to" for an account, in percent of its plan windows; absent or 100 means no cap. */
export interface AccountCap {
  /** The weekly window across all models. */
  weekly?: number;
  /** The 5-hour window. */
  session?: number;
}

/** How the sidebar orders folders (chats inside a folder are always newest first). */
export type FolderOrder = 'manual' | 'recent' | 'name';

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  ignored?: boolean;
}

export interface GitFileStatus {
  path: string;
  /** Short status: M, A, D, R, ?, U */
  status: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface RateLimit {
  id: string;
  label: string;
  /** 0..100 */
  percent: number;
  resetsAt?: number;
  /** Length of the window in minutes, when known (300 for five hours, 10080 for a week). */
  windowMins?: number;
}

/** What else an agent says about an account's limits when it reads them. */
export interface LimitsMeta {
  /** False when plan limits do not apply to this account (API key, cloud provider). */
  planLimits?: boolean;
  /**
   * The read names only some of the account's windows (a turn's rate-limit event, a usage answer
   * without its per-model rows): windows it does not name are kept as last known.
   */
  partial?: boolean;
  /**
   * Paid usage beyond the plan (Claude's usage credits, once called extra usage), when the agent
   * reports it. Amounts in minor units of `currency`; `balance` is what is left to spend, when known.
   */
  extra?: { enabled: boolean; percent?: number; used?: number; limit?: number; currency?: string; inUse?: boolean; resetsAt?: number; balance?: number };
  /** Credits the agent reports (Codex). */
  credits?: { balance?: string; unlimited?: boolean; has?: boolean; inUse?: boolean; resetsAt?: number };
  /**
   * Reset credits the agent reports (Codex: granted resets that restore the plan windows at once;
   * Claude Code: limit resets the plan grants, when its usage answer carries them). `windows` are
   * the ids of the windows one reset restores. Absent when the agent reports none (which says
   * nothing about whether the account has any). `spendable` false: Sable cannot use one (only the
   * agent's own app can); absent means it can.
   */
  resets?: { available: number; windows: string[]; offers?: ResetOffer[]; spendable?: boolean };
}

/** One kind of limit reset an account was granted, as the agent describes it (Claude Code). */
export interface ResetOffer {
  /** What one use restores: every window (`full`), the week, or the 5-hour window (`session`). */
  kind?: 'full' | 'weekly' | 'session';
  /** The agent's own name for it, when it gives one. */
  label?: string;
  /** Uses left, and granted in all when known. */
  left: number;
  total?: number;
  /** When it can no longer be used (ms). */
  expiresAt?: number;
  /** The windows one use restores, as window ids. */
  windows: string[];
  /** Usable only once a limit is reached. */
  atLimitOnly?: boolean;
  paused?: boolean;
}

/** What spending a reset credit did (Codex's `account/rateLimitResetCredit/consume` outcomes). */
export type ResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/** How fast a limit window fills: from the recent samples, or the average since the window began. */
export interface LimitPace {
  /** Percent of the window per hour. */
  perHour: number;
  /** When the window is used up at this rate; absent when it lasts until the reset. */
  fullAt?: number;
  /** Where the window ends up at the reset at this rate (capped at 100), when the reset is known. */
  atReset?: number;
  basis: 'recent' | 'window';
}

/** One account's plan limits as last read, remembered across restarts, with their recent history. */
export interface LimitsReport extends LimitsMeta {
  provider: ProviderId;
  accountId: string;
  limits: RateLimit[];
  /** When the limits were read from the agent (ms); absent when they never were. */
  readAt?: number;
  /** Samples per window id, oldest first, as [time ms, percent]: the current window and a little before. */
  history: Record<string, [number, number][]>;
  /** Per window id, when there is enough to tell. */
  pace: Record<string, LimitPace>;
}

/** Token counts. `input` excludes cache reads and writes. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One local day of one session on one model: the unit every usage chart and list sums. */
export interface UsageRow extends UsageTokens {
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** Key into `UsageReport.sessions`. */
  session: string;
  model: string;
  /** Model replies counted. */
  replies: number;
  /** Money the agent reported for these turns (USD), only where it reported any. */
  costUsd?: number;
}

export interface UsageSession {
  provider: ProviderId;
  accountId: string;
  /** The working folder. */
  project: string;
  title?: string;
  /** The Sable session, when it is one. */
  sableId?: string;
  providerSessionId?: string;
  lastAt: number;
}

/** Local token usage: the agents' own transcripts plus Sable's sessions, read-only. */
export interface UsageReport {
  /** Days covered, ending today. */
  days: number;
  rows: UsageRow[];
  sessions: Record<string, UsageSession>;
  /** When the last scan finished; absent before the first. */
  scannedAt?: number;
  scanning: boolean;
  /** Transcript files known. */
  files: number;
}

export interface ContextBreakdown {
  totalTokens: number;
  maxTokens: number;
  percent: number;
  model?: string;
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }[];
}

export interface MemoryFile {
  path: string;
  scope: 'user' | 'project' | 'local';
  exists: boolean;
  content?: string;
}

export type BackdropSource = 'pattern' | 'image' | 'off';
export type BackdropPattern = 'streaks' | 'tubes' | 'tiles' | 'aurora';
/** halftone: round dots sized by brightness; soft: no texture (a smooth field, or the image itself). */
export type BackdropStyle = 'dither' | 'ascii' | 'halftone' | 'soft';
/** agent: the active agent's palette; image: the image's own colours (image source only). */
export type BackdropColour = 'agent' | 'mono' | 'custom' | 'image';

/**
 * The light behind home, sessions and onboarding. Always pass stored or user values through
 * `normalizeBackdrop` (`shared/backdrop.ts`), which also holds the default and the presets.
 */
export interface BackdropConfig {
  source: BackdropSource;
  pattern: BackdropPattern;
  /** An uploaded image (`AppSettings.backdropImages`), drawn when `source` is 'image'. */
  image: string | null;
  style: BackdropStyle;
  /** Strength on the home screen and onboarding, 0–100 (0 draws nothing). */
  amount: number;
  /** Strength of the band behind a session's composer, 0–100 (0 draws nothing). */
  sessionAmount: number;
  /** Where the light gathers, 0–1 across and down the stage. */
  focus: { x: number; y: number };
  /** How far the light spreads from the focus, 0–100; 100 is the whole background evenly. */
  reach: number;
  /** Cell size, 0 coarse to 100 fine. */
  detail: number;
  /** 0 is completely still. */
  speed: number;
  /** Direction of streaks and of the tubes' wave, degrees 0–180. */
  angle: number;
  colour: BackdropColour;
  /** Custom colour: hue 0–360 and saturation 0–100. */
  hue: number;
  saturation: number;
  /** The light answers the pointer and swells when a message is sent. */
  react: boolean;
  /** Image source: a moving pattern played as light over the still image ('none': the image alone). */
  effect: BackdropPattern | 'none';
  /** Strength of that moving light, 0–100. */
  effectAmount: number;
}

/**
 * Calm ink with a hint of light: a low glow rising from the lower edge, fine cells, slow drift,
 * most of the stage plain ground (the presets are the louder steps). Lives here (not in
 * `shared/backdrop.ts`) so this module imports nothing at run time.
 */
export const DEFAULT_BACKDROP: BackdropConfig = {
  source: 'pattern',
  pattern: 'streaks',
  image: null,
  style: 'dither',
  amount: 8,
  sessionAmount: 16,
  focus: { x: 0.62, y: 1 },
  reach: 72,
  detail: 94,
  speed: 30,
  angle: 35,
  colour: 'agent',
  hue: 28,
  saturation: 70,
  react: true,
  effect: 'none',
  effectAmount: 40,
};

/** An image uploaded for the backdrop. Ids come from the bridge only. */
export interface BackdropImage {
  id: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  addedAt: number;
}

export interface AppSettings {
  accent: 'spectrum' | 'ember' | 'iris' | 'mint';
  ambience: 'full' | 'calm' | 'off';
  fontScale: number;
  defaultProvider: ProviderId;
  defaultModels: Partial<Record<ProviderId, string>>;
  defaultModes: Partial<Record<ProviderId, string>>;
  defaultEfforts: Partial<Record<ProviderId, Effort>>;
  notifyOnDone: boolean;
  sendWithEnter: boolean;
  showThinking: boolean;
  /** The light behind the home screen ('bloom' is no longer offered but still draws for older settings). */
  backdrop: 'streaks' | 'tubes' | 'tiles' | 'aurora' | 'bloom';
  /** How every light field is drawn: dithered tiles or characters. */
  texture: 'dither' | 'ascii';
  /** The backdrop as drawn (`ambience`, `backdrop` and `texture` are kept only for older profiles). */
  backdropConfig: BackdropConfig;
  /** Uploaded backdrop images; changed only through the `backdrop.*` methods. */
  backdropImages: BackdropImage[];
  /** The first-run welcome has been shown (or skipped). Installs from before it existed are marked by the UI. */
  onboarded: boolean;
  /** Which account new sessions use per agent; absent means `default`. */
  defaultAccounts?: Partial<Record<ProviderId, string>>;
  /** The order accounts are listed in, per agent (account ids; any not named follow in their own order). Set with `account.reorder`. */
  accountOrder?: Partial<Record<ProviderId, string[]>>;
  /**
   * Models shown or hidden in the model menu, keyed `${provider}:${modelId}`. Absent means
   * the default: only the current generation (see `src/lib/models.ts`).
   */
  modelVisibility?: Record<string, boolean>;
  /** Capabilities new sessions start with, per agent. */
  sessionOptions?: Partial<Record<ProviderId, SessionOptions>>;
  /** Start the agent process while the home composer is focused, so the first reply comes sooner. Absent means on. */
  prewarm?: boolean;
  /**
   * Ask agents for short final answers (and a localhost link when there is something to view).
   * Appended to the agent's own system prompt; applies when an agent process starts.
   */
  conciseReplies: boolean;
  /**
   * Generative UI: agents get a `show_widget` tool and answers render ```widget and ```mermaid
   * blocks. Absent means on; applies to the tool when an agent process starts.
   */
  generativeUi?: boolean;
  /** Lanes: a session starting in a git folder where another session works gets a worktree of its own. Absent means off. */
  autoLanes?: boolean;
  /** After a chat's first turn a small, cheap model names it (`server/core/titles.ts`); a title the person set is never changed. Absent means on. */
  chatTitles?: boolean;
  /** With the phone on and a phone paired, the computer does not sleep while on mains power, so the phone can reach it (`server/core/awake.ts`). Absent means on. */
  phoneAwake?: boolean;
  /** At a plan limit, a session carries on with the next signed-in account of its agent that has room. Absent means off. */
  continueAtLimit?: boolean;
  /** At a plan limit with no other account to take over, the chat waits for the reset and then carries on by itself. Absent means off. */
  continueAtReset?: boolean;
  /** Per account (`${provider}:${accountId}`): carry on with credits or extra usage at a limit, before the next account. Absent means off. */
  creditsAtLimit?: Record<string, boolean>;
  /** A notification when a window of an account at its limit resets. Absent means off. */
  notifyLimitReset?: boolean;
  /**
   * The user's profile (`<home>/profile.md`): a compact form goes into each agent's prompt and
   * agents may add short facts with `remember_about_user`. Absent means on; applies when an agent process starts.
   */
  userProfile?: boolean;
  /** New sessions go back to the preferred account once its limit resets (after a limit handover). Absent means off. */
  returnToPreferred?: boolean;
  /** The speed new sessions start with, per agent (a `SpeedInfo` id); absent means standard. */
  defaultSpeeds?: Partial<Record<ProviderId, string>>;
  /** How the sidebar orders folders; absent means manual (dragged into place). */
  folderOrder?: FolderOrder;
  /**
   * Where a chat started without a folder gets its own new folder; absent means the default
   * (`AppState.chatsDefault`: "Sable chats" on the D: drive when there is one, else in the home folder).
   */
  chatsFolder?: string;
  /**
   * Where Sable makes the worktrees of its lanes (one per session that shares a folder). Absent
   * means `<Sable home>/lanes`; a `~` at the start is the person's home folder.
   */
  worktreesFolder?: string;
  /**
   * Per account (`${provider}:${accountId}`): how much of its plan limits Sable may use. Past it, a
   * session moves between turns to the next signed-in account of its agent that is under its own cap.
   */
  accountCaps?: Record<string, AccountCap>;
}

/** One permission rule set from an agent's settings file (read-only view). */
export interface ConfigPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: string;
  additionalDirectories: string[];
}

export interface ConfigHook {
  event: string;
  matcher?: string;
  /** The command (or prompt / url for non-command hooks), with secret-looking values masked. */
  command: string;
  type: string;
}

/** An agent settings file as Sable shows it. Secrets (env, API keys, tokens) are never included. */
export interface AgentConfigFile {
  path: string;
  scope: 'user' | 'project' | 'local';
  exists: boolean;
  /** `jsonc`: shown as text, secrets masked (OpenCode's opencode.json). */
  format: 'json' | 'toml' | 'jsonc';
  /** The file exists but could not be read or parsed. */
  error?: string;
  permissions?: ConfigPermissions;
  hooks?: ConfigHook[];
  /** TOML and JSONC files: the text with secret values masked, capped at 64 KB. */
  raw?: string;
  truncated?: boolean;
}

/** A working tree of a repository: the main checkout first, then each linked worktree. */
export interface GitWorktree {
  path: string;
  /** The checked-out branch; undefined when detached. */
  branch?: string;
  /** Short hash of HEAD. */
  head?: string;
  /** The repository's main checkout (the first entry). */
  main: boolean;
}

export interface GitCommitResult {
  ok: boolean;
  /** Short hash of the new commit. */
  hash?: string;
  /** First line of the commit message. */
  summary?: string;
  error?: string;
}

/** What a pull request for the folder's branch would bring, and a draft of its title and description. */
export interface GitPullContext {
  isRepo: boolean;
  /** The checked-out branch; undefined when detached. */
  branch?: string;
  /** The branch the pull request merges into: the repository's default branch. */
  base?: string;
  /** Whether a remote named origin exists. */
  remote: boolean;
  /** Subjects of the commits the base does not have, oldest first. */
  commits: string[];
  title: string;
  body: string;
}

export interface GitPullRequestResult {
  ok: boolean;
  /** The pull request's address on GitHub (also when one already existed for the branch). */
  url?: string;
  number?: number;
  error?: string;
}

export interface AppState {
  version: string;
  platform: string;
  home: string;
  /** Where Sable keeps its data (`~/.sable`, or `SABLE_HOME`); absent in older bridges. */
  dataDir?: string;
  providers: ProviderInfo[];
  projects: Project[];
  sessions: SessionMeta[];
  settings: AppSettings;
  /** Projects grouping folders in the sidebar (absent in older bridges). */
  groups?: FolderGroup[];
  /** The chats group's place among the sidebar's top entries; absent: after everything else. */
  chatsOrder?: number;
  /** Where chats without a folder go when `settings.chatsFolder` is not set. */
  chatsDefault?: string;
  /** Where lanes' worktrees go when `settings.worktreesFolder` is not set. */
  worktreesDefault?: string;
  /** Every session's open permission requests and questions, so a window sees what waits on the user without loading each timeline. */
  prompts?: PendingPrompts;
  /** Updates of the desktop app (absent in older bridges and where Sable cannot update itself). */
  update?: UpdateState;
}

/**
 * Updates of the desktop app: a new release on GitHub is downloaded in the background and installed
 * on "Restart to update" (the installer starts Sable again). `unsupported`: a dev or standalone
 * bridge. `pending`: asked to restart while agents work; it restarts once they are done.
 */
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  /** The running version. */
  current: string;
  /** The newest release, when it is newer than the running one. */
  latest?: string;
  /** Downloaded share, 0 to 1. */
  progress?: number;
  pending?: boolean;
  error?: string;
  /** When the releases were last asked (ms). */
  checkedAt?: number;
}

/** The prompts open across all sessions (the triage deck); later changes arrive as `permission.*` / `question.*` events. */
export interface PendingPrompts {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
}

// ─────────────────────────────────── events ─────────────────────────────────

export type BridgeEvent =
  | { type: 'provider.updated'; provider: ProviderInfo }
  /** `url`: the sign-in link opened in the browser; `codeUrl`: the one whose page shows a code to paste (`auth.code`). */
  | { type: 'auth.progress'; provider: ProviderId; accountId?: string; state: 'started' | 'url' | 'done' | 'error' | 'cancelled' | 'timeout'; url?: string; codeUrl?: string; message?: string }
  | { type: 'projects.updated'; projects: Project[]; groups?: FolderGroup[]; chatsOrder?: number }
  | { type: 'settings.updated'; settings: AppSettings }
  | { type: 'session.added'; session: SessionMeta }
  | { type: 'session.updated'; id: string; patch: Partial<SessionMeta> }
  | { type: 'session.removed'; id: string }
  | { type: 'session.caps'; id: string; caps: Capabilities }
  | { type: 'item.added'; sessionId: string; item: TimelineItem }
  | { type: 'item.delta'; sessionId: string; id: string; field: 'text' | 'inputText' | 'output'; delta: string }
  | { type: 'item.patch'; sessionId: string; id: string; patch: Partial<TimelineItem> }
  | { type: 'item.removed'; sessionId: string; id: string }
  | { type: 'timeline.reset'; sessionId: string; items: TimelineItem[] }
  | { type: 'permission.added'; request: PermissionRequest }
  | { type: 'permission.removed'; sessionId: string; id: string }
  | { type: 'question.added'; request: QuestionRequest }
  | { type: 'question.removed'; sessionId: string; id: string }
  | { type: 'todos.updated'; sessionId: string; todos: Todo[] }
  | { type: 'suggestion'; sessionId: string; text: string }
  | { type: 'queue.updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'limits.updated'; provider: ProviderId; accountId?: string; limits: RateLimit[]; meta?: LimitsMeta }
  /** An account's limits with their history and pace (after every read, and for cached ones at start-up). */
  | { type: 'limits.report'; report: LimitsReport }
  /** A full window of an account reset (with `notifyLimitReset` on). */
  | { type: 'update.state'; state: UpdateState }
  | { type: 'limit.reset'; provider: ProviderId; accountId?: string; window: string; at: number }
  /** Local usage changed (a scan finished). */
  | { type: 'usage.updated'; report: UsageReport }
  /** Fresh capabilities for the home composer (after a cached answer was served first). */
  | { type: 'caps.updated'; provider: ProviderId; accountId?: string; cwd?: string; caps: Capabilities }
  | { type: 'term.data'; termId: string; data: string; stream: 'out' | 'err' }
  | { type: 'term.exit'; termId: string; code: number | null }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string }
  /** The agent's browser tool needs the session's Browser tab: answer with `browser.respond`. */
  | { type: 'browser.request'; request: BrowserRequest }
  /** Devices changed in a way the bridge saw (an emulator started, booted, stopped or failed). */
  | { type: 'device.updated'; status: DeviceStatus }
  /** Settings › Phone changed (on or off, a pairing offer, a phone asking to pair, a phone seen). Never sent to phones. */
  | { type: 'phone.updated'; status: PhoneStatus }
  /** The user's profile changed (an agent added a fact, or it was edited). */
  | { type: 'profile.updated'; profile: UserProfile }
  /** A turn's before / after pictures of a local page were taken or changed state (server/services/capture.ts). */
  | { type: 'capture.updated'; sessionId: string; capture: TurnCapture };

// ───────────────────────────── before / after ─────────────────────────────

/** One picture of a page, kept by the bridge (`capture.image` serves it). */
export interface CaptureShot {
  id: string;
  /** When it was taken (ms since epoch). */
  at: number;
}

/** A changed area, in CSS pixels of its view. */
export interface CaptureRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The page at one viewport: before the turn's first edit and after the turn. */
export interface CaptureView {
  kind: 'desktop' | 'phone';
  /** The viewport in CSS pixels. */
  width: number;
  height: number;
  /** Image pixels per CSS pixel. */
  scale: number;
  before?: CaptureShot;
  after?: CaptureShot;
  /** With both pictures: the areas that changed, largest first (empty when nothing visible changed). */
  regions?: CaptureRegion[];
  /** With both pictures: the share of the view that changed, 0 to 1. */
  changed?: number;
}

/**
 * Before / after for a turn that edited a local web page: the page captured headless just before
 * the turn's first edit (when it was known by then) and again when the turn ended.
 */
export interface TurnCapture {
  /** The turn: the id of the message that started it (the timeline's turn key). */
  turnId: string;
  url: string;
  /** 'capturing' while the after pictures are taken. */
  state: 'capturing' | 'ready' | 'failed';
  views: CaptureView[];
  /** Why there is no before, in plain words. */
  noBefore?: string;
  error?: string;
}

// ───────────────────────────────── profile ─────────────────────────────────

/** A fact an agent added to the profile (a line under its "Learned" heading). */
export interface ProfileEntry {
  /** Stable for the same text: what `profile.forget` takes. */
  id: string;
  text: string;
  /** Local date it was added or last confirmed, YYYY-MM-DD. */
  date: string;
}

/** The user's profile as Settings › Profile shows it. */
export interface UserProfile {
  /** The user's own part of the file (everything but the agents' additions), as edited in Settings › Profile. */
  text: string;
  path: string;
  /** Agents' additions, newest first. */
  entries: ProfileEntry[];
  /** About how many words of it go into each agent's prompt. */
  promptWords: number;
}

// ───────────────────────────────── phone ─────────────────────────────────
// The phone app (`mobile/`) talks to the bridge over the home network through `server/services/phone.ts`:
// its own port on the LAN, opt-in, every socket authenticated with a device token, and only the
// RPC methods in `PHONE_METHODS`. The localhost bridge is unchanged.

/** The phone endpoint's fixed port (the pairing link names it too). */
export const PHONE_PORT = 47820;
/** The phone endpoint's WebSocket path. */
export const PHONE_PATH = '/sable-phone';

/** A phone allowed to connect. Its token is kept only as a hash. */
export interface PhoneDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen?: number;
  /** Connected now. */
  online?: boolean;
}

export interface PhoneStatus {
  /** Settings › Phone is on: the endpoint should listen. */
  enabled: boolean;
  /** It listens on the LAN now. */
  listening: boolean;
  port: number;
  /** This computer's IPv4 addresses on the local network. */
  hosts: string[];
  /** This computer's name, as phones show it. */
  name: string;
  devices: PhoneDevice[];
  /** The open pairing offer (a one-time key, valid for minutes): the link the QR code encodes, and the code as SVG path data on a `size` grid. */
  pairing?: { link: string; expiresAt: number; qr: string; size: number };
  /** A phone that presented the pairing key and waits for "Allow". */
  request?: { id: string; name: string; address: string; at: number };
  error?: string;
}

/** Frames a phone sends before it is authenticated (as JSON text). Afterwards it sends `RpcRequest`s. */
export type PhoneHello = { hello: { token: string; name?: string } } | { pair: { key: string; name: string } };

/** Frames the phone endpoint sends besides `ServerFrame`s. */
export type PhoneFrame =
  /** `hosts`: the desktop's addresses now (a phone adds new ones, e.g. Tailscale's, to its pairing). */
  | { welcome: { deviceId: string; desktop: string; version: string; hosts?: string[] } }
  | { waiting: true }
  | { paired: { token: string; deviceId: string; desktop: string } }
  | { denied: string };

/**
 * What a paired phone may call: conversations, not the machine (no terminal, files, settings or
 * accounts' sign-ins). Besides these, the phone's own read-only methods (`PHONE_OWN_METHODS`), such
 * as a chat's changes and their diffs, only for the chat's own folder.
 */
export const PHONE_METHODS = [
  'app.hello',
  'session.create',
  'session.snapshot',
  'session.send',
  'session.interrupt',
  'session.setModel',
  'session.setEffort',
  'session.setMode',
  'session.setSpeed',
  'session.setOptions',
  'session.rename',
  'session.update',
  'session.switchAccount',
  'session.switchAgent',
  'queue.update',
  'queue.remove',
  'queue.take',
  'queue.reorder',
  'queue.sendNow',
  'permission.respond',
  'question.respond',
  'provider.caps',
  'provider.limits',
  'usage.limits',
  'fs.roots',
  'fs.list',
  'turn.check',
  'turn.checkStop',
] as const satisfies readonly RpcName[];

/**
 * A timeline item as a phone gets it: what the phone shows, big fields cut (no tool input or
 * output, no images or attachment data, long texts shortened). `phone.item` returns more of it.
 */
export type PhoneItem = TimelineItem & {
  /** Its text was shortened for the phone. */
  cut?: boolean;
  /** Items nested under it on the desktop (a sub-agent's steps). */
  kids?: number;
  /** The desktop holds more of it (output, the change's lines, the full input). */
  more?: boolean;
};

/** A page of a conversation for the phone: the newest root items, or those before a cursor. */
export interface PhoneTail extends Omit<SessionSnapshot, 'items'> {
  /** Root items in order (a sub-agent's steps come with `phone.item`). */
  items: PhoneItem[];
  /** Pass as `before` for the page before this one; absent at the conversation's start. */
  cursor?: string;
  /** Root items in the whole conversation. */
  total: number;
}

/** Methods only the phone endpoint answers, besides `PHONE_METHODS`. */
export interface PhoneMethods {
  /** The newest page of a conversation (or the one before `before`), trimmed; from here on its live events reach this phone. */
  'phone.tail': { params: { sessionId: string; before?: string; limit?: number }; result: PhoneTail };
  /** One item with more of it (a step's output and change, a long text in full) and the last steps nested under it. */
  'phone.item': { params: { sessionId: string; itemId: string }; result: { item: PhoneItem; children: PhoneItem[] } };
  /**
   * A download link for a file the agent handed over in this conversation (a `share` step's
   * `detail.files[index]`): a path on the phone endpoint (`/f/<token>/<name>`) that serves that one
   * file for 15 minutes. Nothing else on the computer can be fetched this way.
   */
  'phone.fileLink': { params: { sessionId: string; itemId: string; index: number }; result: { path: string; name: string; size?: number } };
  /**
   * A new, empty folder inside an existing one (a new chat's folder, from the folder browser): one
   * plain name, no path separators, nothing hidden; never overwrites. Returns its path.
   */
  'phone.mkdir': { params: { parent: string; name: string }; result: { path: string } };
  /**
   * What a chat changed, read-only: the working tree of the chat's own folder (its lane's worktree
   * when it has one), as the desktop's Changes tab lists it; the chat's own edits when that folder is
   * not a git repository; or, with `items`, the edits of those steps (a turn's work, sub-agents'
   * steps included). Capped for the phone.
   */
  'phone.changes': { params: { sessionId: string; items?: string[] }; result: PhoneChanges };
  /**
   * One file's diff from the same place, its lines capped. Only a file `phone.changes` lists for that
   * chat now: no other path can be read this way.
   */
  'phone.diff': { params: { sessionId: string; path: string; items?: string[] }; result: PhoneDiff };
}

export const PHONE_OWN_METHODS = ['phone.tail', 'phone.item', 'phone.fileLink', 'phone.mkdir', 'phone.changes', 'phone.diff'] as const satisfies readonly (keyof PhoneMethods)[];

/** A changed file in a chat's Changes view on the phone. */
export interface PhoneChangedFile {
  /** Relative to the chat's folder, forward slashes. */
  path: string;
  /** Git's short status (M, A, D, R, ?, U); for edits outside a repository A, D, R or M. */
  status: string;
  additions: number;
  deletions: number;
  /** Outside a repository or in a turn: how many edits made it (the line numbers are the file's own only for one). */
  edits?: number;
  binary?: boolean;
}

/** What a chat changed, as the phone's Changes view lists it (`phone.changes`). */
export interface PhoneChanges {
  /** `tree`: the working tree of the chat's folder; `edits`: the chat's own edits (its folder is not a git repository); `turn`: the edits of the steps asked for. */
  scope: 'tree' | 'edits' | 'turn';
  /** The folder's branch (`tree`). */
  branch?: string;
  ahead?: number;
  behind?: number;
  /** In the order the desktop lists them, at most a few hundred. */
  files: PhoneChangedFile[];
  /** Files left out past the list's length. */
  more?: number;
  additions: number;
  deletions: number;
}

/** One file's diff for the phone (`phone.diff`). */
export interface PhoneDiff {
  /** Null when there is nothing textual to show (a file that is gone, a change git cannot show). */
  diff: FileDiff | null;
  /** Its line numbers are the file's own (a git diff, or a single edit): a comment names them. */
  numbered: boolean;
  /** Only the first lines are here (the diff is longer than the phone gets). */
  cut?: boolean;
}

/** `timeline.reset` as a phone gets it: the newest page, trimmed, with its cursor. */
export interface PhoneReset {
  type: 'timeline.reset';
  sessionId: string;
  items: PhoneItem[];
  cursor?: string;
  total?: number;
}

// ───────────────────────────── project scripts ─────────────────────────────

/** Which package manager runs a folder's package.json scripts (from its lockfile). */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** One script a folder declares, and how the Terminal tab runs it. */
export interface ProjectScript {
  /** As its file spells it ("dev", "build", "test"). */
  name: string;
  /** What the file says it does ("vite --port 5173", a Makefile recipe's first line). */
  command: string;
  /** What the terminal runs ("pnpm run dev", "make test", "poetry run serve"). */
  run: string;
  source: 'package' | 'make' | 'python';
}

export interface ProjectScripts {
  cwd: string;
  /** The package manager for package.json scripts; null without a package.json. */
  manager: PackageManager | null;
  scripts: ProjectScript[];
  /** Files with scripts that were left out, each with why ("Makefile: make is not installed"). */
  skipped: string[];
  /** Changes when any file it was read from changes. */
  sig: string;
}

// ──────────────────────────────────── RPC ───────────────────────────────────

export interface SessionSnapshot {
  session: SessionMeta;
  items: TimelineItem[];
  caps?: Capabilities;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  suggestion?: string;
  /** Messages sent while a turn was running, waiting for it to end. */
  queue: QueuedMessage[];
}

/**
 * A message the user sent while the agent was busy. The bridge holds it (it is not in the
 * timeline yet) and sends it when the turn ends normally, one per turn end.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: Attachment[];
  createdAt: number;
  /** Kept from a Spare wait that was cancelled or could not start: it goes out only when sent by hand, never at a turn's end. */
  byHand?: boolean;
}

export interface RpcMethods {
  'app.hello': { params: Record<string, never>; result: AppState };
  'app.setSettings': { params: { patch: Partial<AppSettings> }; result: AppSettings };

  'auth.refresh': { params: { provider: ProviderId; accountId?: string }; result: ProviderInfo };
  'auth.login': { params: { provider: ProviderId; accountId?: string }; result: { started: boolean } };
  /** The code the browser showed instead of returning to Sable ("code#state"): finishes the sign-in in progress. */
  'auth.code': { params: { provider: ProviderId; accountId?: string; code: string }; result: { ok: boolean; error?: string } };
  'auth.cancel': { params: { provider: ProviderId; accountId?: string }; result: { ok: boolean } };
  'auth.logout': { params: { provider: ProviderId; accountId?: string }; result: ProviderInfo };

  /** Adds an account with its own empty config folder; the result carries the new `account`. Sign in next with `auth.login`. */
  'account.add': { params: { provider: ProviderId; label?: string }; result: ProviderInfo & { account: AccountInfo } };
  'account.rename': { params: { provider: ProviderId; accountId: string; label: string }; result: ProviderInfo };
  /** The order this agent's accounts are listed in everywhere (`AppSettings.accountOrder`). */
  'account.reorder': { params: { provider: ProviderId; ids: string[] }; result: ProviderInfo };
  /** Never the default. Refuses while one of its sessions is busy; deletes the account's folder. */
  'account.remove': { params: { provider: ProviderId; accountId: string }; result: ProviderInfo };
  /** Registers a config folder the user already has as an account (nothing is copied; removing it only forgets it). */
  'account.addExisting': { params: { provider: ProviderId; dir: string; label?: string }; result: ProviderInfo & { account: AccountInfo } };
  /** Folders under the home folder that look like this agent's config and are not an account yet. */
  'account.folders': { params: { provider: ProviderId }; result: AccountFolder[] };
  /**
   * Moves an idle session to another account of its agent. The same conversation continues when the
   * agent's transcript can be carried over (`carried: 'conversation'`); otherwise a new one starts with a
   * short handover of this one (`'summary'`). `retry` sends the message a limit refused again.
   */
  'session.switchAccount': {
    params: { sessionId: string; accountId: string; retry?: boolean };
    result: { ok: boolean; carried: 'conversation' | 'summary' | 'none'; message?: string };
  };

  /** Models, modes, commands… for a provider before any session exists. */
  /** With `refresh`, the agent is asked again (the model menu opened on a list older than an hour). */
  'provider.caps': { params: { provider: ProviderId; cwd?: string; accountId?: string; refresh?: boolean }; result: Capabilities };
  /** `force`: the user asked; may start a short agent process when none is running (no tokens). */
  'provider.limits': { params: { provider: ProviderId; accountId?: string; force?: boolean }; result: RateLimit[] };
  /**
   * Spends one reset credit of the account (only after the user confirmed it), then reads the
   * limits again. `key` identifies one attempt: the same key on a retry never spends a second one.
   */
  'provider.useReset': { params: { provider: ProviderId; accountId?: string; key: string }; result: { outcome: ResetOutcome } };
  /**
   * Starts the agent process for the session about to be created from the home composer (no
   * prompt is sent). `session.create` with the same choice adopts it. At most one is kept.
   */
  'provider.prewarm': {
    params: { provider: ProviderId; accountId?: string; cwd: string; model?: string; mode?: string; effort?: Effort; ultracode?: boolean };
    result: { ok: boolean };
  };

  'project.add': { params: { path: string }; result: Project };
  'project.remove': { params: { path: string }; result: { ok: boolean } };
  'project.pin': { params: { path: string; pinned: boolean }; result: { ok: boolean } };
  /** The folder's name in Sable (the folder on disk keeps its own); an empty name gives the folder's own name back. */
  'project.rename': { params: { path: string; name: string }; result: { ok: boolean; name: string } };
  /** The manual folder order: `paths` first, in that order (folders known only through their sessions become projects); the rest keep theirs after them. */
  'project.reorder': { params: { paths: string[] }; result: { ok: boolean } };
  /**
   * The sidebar's arrangement after a drag or a menu: `top` lists top entries in their new order (a
   * folder's path, `group:<id>` for a project, `chats` for the chats group; a folder named here is
   * loose from now on), `inside` lists a project's folders in order (they join it). Entries not named
   * keep their order after the named ones.
   */
  'project.arrange': { params: { top?: string[]; inside?: Record<string, string[]> }; result: { ok: boolean } };
  /** A new project, with `paths` as its folders (placed where the first of them was, else on top). */
  'group.create': { params: { name: string; paths?: string[] }; result: FolderGroup };
  'group.rename': { params: { id: string; name: string }; result: { ok: boolean } };
  /** Removes a project; its folders stay, loose, where it was. */
  'group.remove': { params: { id: string }; result: { ok: boolean } };
  /** Makes sure the chats folder exists and returns it (the home composer's "No folder"). */
  'chats.prepare': { params: Record<string, never>; result: { path: string } };

  'session.create': {
    params: {
      provider: ProviderId; cwd: string; model?: string; effort?: Effort; mode?: string; resume?: string; title?: string; accountId?: string; options?: SessionOptions; ultracode?: boolean; speed?: string;
      /** "Continue in the other agent": a Sable session (any agent) whose conversation the new one starts from, as a compact handover sent ahead of the first message. The original is left as it is. */
      handoverFrom?: string;
      /**
       * A chat without a folder: the bridge makes a fresh folder for it under the chats folder, named
       * by the date and the first words of `text` (the first message), and ignores `cwd`.
       */
      chat?: { text?: string };
    };
    result: SessionSnapshot;
  };
  'session.snapshot': { params: { sessionId: string }; result: SessionSnapshot };
  /** One item whole, as the bridge holds it (a step a window got cut, `ToolItem.more`). */
  'session.item': { params: { sessionId: string; itemId: string }; result: { item: TimelineItem } };
  /**
   * Sends a message. While a turn runs it is held in the queue (sent when the turn ends), or with
   * `steer` handed to the running agent now: it shows in the timeline where it was sent
   * (`UserItem.steered`) and the agent takes it at its next step. Without a running turn `steer`
   * changes nothing. An agent that cannot steer (`caps.features.steer` false) queues it instead.
   */
  /**
   * `/model <name>` is never sent: it sets the session's model (`model`, its id), or switches the
   * chat to the agent that has that model (`switched`); `error` when no model has that name.
   */
  'session.send': { params: { sessionId: string; text: string; attachments?: Attachment[]; steer?: boolean }; result: { ok: boolean; queued?: boolean; model?: string; switched?: ProviderId; error?: string } };
  /**
   * Switches the chat to another agent in place (same chat, same conversation shown): the next
   * message goes to `provider`, which starts from a compact handover of the conversation, or, when
   * the chat ran with it before, resumes its own conversation with a handover of what happened
   * since. Switching back right after a switch, with nothing sent, undoes it. Refused while a turn
   * or background work runs. `model`: else the agent's last one here, else its default. `accountId`
   * applies to an agent new to the chat (one it ran with keeps its account).
   */
  'session.switchAgent': { params: { sessionId: string; provider: ProviderId; model?: string; accountId?: string }; result: { ok: boolean; undone?: boolean } };
  'session.interrupt': { params: { sessionId: string }; result: { ok: boolean } };
  'session.setModel': { params: { sessionId: string; model: string }; result: { ok: boolean } };
  'session.setEffort': { params: { sessionId: string; effort: Effort }; result: { ok: boolean } };
  'session.setMode': { params: { sessionId: string; mode: string }; result: { ok: boolean } };
  'session.setFast': { params: { sessionId: string; fast: boolean }; result: { ok: boolean } };
  /** The session's speed (`standard` or a `SpeedInfo` id of its model); an unsupported one falls back to standard. */
  'session.setSpeed': { params: { sessionId: string; speed: string }; result: { ok: boolean; speed: string } };
  /** Claude Code ultracode on or off: applied live to a running agent, and at every later start. */
  'session.setUltracode': { params: { sessionId: string; on: boolean }; result: { ok: boolean } };
  'session.rename': { params: { sessionId: string; title: string }; result: { ok: boolean } };
  'session.update': { params: { sessionId: string; patch: Pick<Partial<SessionMeta>, 'pinned' | 'archived' | 'unread'> }; result: { ok: boolean } };
  'session.close': { params: { sessionId: string; remove?: boolean }; result: { ok: boolean } };
  'session.rewind': { params: { sessionId: string; itemId: string; restoreFiles: boolean }; result: { ok: boolean; message?: string } };
  /** Fork: a new session (same agent, account and settings) that continues from the end of the turn holding `itemId`, with the conversation up to there: the agent's own fork where it has one, otherwise a summary. The original is left as it is. */
  'session.fork': { params: { sessionId: string; itemId: string }; result: SessionSnapshot };
  'session.context': { params: { sessionId: string }; result: ContextBreakdown | null };
  'session.mcp': { params: { sessionId: string }; result: McpServerInfo[] };
  /** Switches capabilities; an idle agent process restarts to apply them, a running turn finishes first. */
  'session.setOptions': { params: { sessionId: string; options: SessionOptions }; result: { ok: boolean } };
  /**
   * Arms until green with what follows `/until` (`pnpm test --rounds 8`, `--usage 15` for the
   * weekly points); `off` stops it. Replaces a loop already armed. Answers the loop, or why not.
   */
  'until.set': { params: { sessionId: string; text: string }; result: { ok: boolean; until?: UntilState; error?: string } };
  /** Stops the session's loop (its end line says so). */
  'until.stop': { params: { sessionId: string }; result: { ok: boolean } };
  /** Runs a paused loop's check now (the session must be idle). */
  'until.check': { params: { sessionId: string }; result: { ok: boolean } };
  /**
   * "Check with Codex" (`TurnCheck`): the other agent reviews the changes of the finished turn that
   * `turnId` (its first message) started, read-only, as a step placed after it. Answers the step's id, or why not.
   */
  'turn.check': { params: { sessionId: string; turnId: string }; result: { ok: boolean; itemId?: string; error?: string } };
  /** Stops a running turn check (`itemId`: its step). */
  'turn.checkStop': { params: { sessionId: string; itemId: string }; result: { ok: boolean } };
  /** Lanes (`SessionLane`). `forecast` dry-merges the lane into the folder's branch; `land` commits what is uncommitted (with `message`), brings the lane's commits onto that branch and ends the lane; `discard` ends it and drops its work; `create` moves the session into a new lane now. */
  'lane.forecast': { params: { sessionId: string }; result: LaneForecast };
  'lane.land': { params: { sessionId: string; message?: string }; result: LaneLandResult };
  'lane.discard': { params: { sessionId: string }; result: { ok: boolean; error?: string } };
  'lane.create': { params: { sessionId: string }; result: { ok: boolean; error?: string; lane?: SessionLane } };
  /** Opens the lane's folder in the system's file manager. */
  'lane.open': { params: { sessionId: string }; result: { ok: boolean; error?: string } };
  /** What the lane would bring to the folder's branch, file by file (its uncommitted work included). Empty without a lane. */
  'lane.diff': { params: { sessionId: string }; result: FileDiff[] };
  /**
   * Race (`SessionRace`): two new chats in `cwd` (a folder in a git repository), each in a new lane,
   * both sent `task`. Claude Code against Codex where both are signed in, else two models of the
   * agent that is (`provider: 'demo'` races two Demo models). `modes`: each agent's permission mode.
   * Answers both chats, or why not (`error`).
   */
  'race.start': { params: { cwd: string; task: string; provider?: ProviderId; modes?: Partial<Record<ProviderId, string>> }; result: { ok: boolean; error?: string; raceId?: string; sessions?: SessionSnapshot[] } };
  /** Keeps this chat's lane: it lands (refused with `conflicts` or `blocked`, nothing changed), then the rival's lane is discarded and its chat archived. */
  'race.keep': { params: { sessionId: string; message?: string }; result: RaceKeepResult };
  /** Discards both lanes of the race this chat is in; both chats are archived. */
  'race.discard': { params: { sessionId: string }; result: { ok: boolean; error?: string } };
  /** Spare (`SpareWait`): queues a message held until there is spare quota (`/spare`). Answers the wait, or why not. */
  'spare.send': { params: { sessionId: string; text: string; attachments?: Attachment[] }; result: { ok: boolean; spare?: SpareWait; error?: string } };
  /** "Continue at reset": the chat's last limit notice continues on its account once its window resets. */
  'spare.atReset': { params: { sessionId: string }; result: { ok: boolean; spare?: SpareWait; error?: string } };
  /** Stops waiting; held messages stay in the queue. */
  'spare.cancel': { params: { sessionId: string }; result: { ok: boolean } };
  /** Sends the first held message now, as a normal send, and stops waiting. */
  'spare.startNow': { params: { sessionId: string }; result: { ok: boolean } };
  /** Development only (the Demo agent): the demo account's full windows reset `ms` from now (they never do by themselves). */
  'demo.limitResetIn': { params: { accountId: string; ms: number }; result: { ok: boolean } };

  /**
   * Replaces a queued message's text, and its attachments when `attachments` is given (an empty
   * array clears them). A message left with no text and no attachments is removed.
   */
  'queue.update': { params: { sessionId: string; id: string; text: string; attachments?: Attachment[] }; result: { ok: boolean } };
  'queue.remove': { params: { sessionId: string; id: string }; result: { ok: boolean } };
  /**
   * Removes a queued message and returns it, atomically (for "edit": put it back in the composer).
   * `message` is absent when it already went out or was removed.
   */
  'queue.take': { params: { sessionId: string; id: string }; result: { message?: QueuedMessage } };
  /** Reorders the queue: `ids` first in that order, any message not named keeps its place after them. */
  'queue.reorder': { params: { sessionId: string; ids: string[] }; result: { ok: boolean } };
  /** Takes a queued message out of the queue and gives it to the agent now (steered into the running turn, if any). */
  'queue.sendNow': { params: { sessionId: string; id: string }; result: { ok: boolean } };

  'permission.respond': { params: { sessionId: string; requestId: string; optionId: string; message?: string }; result: { ok: boolean } };
  'question.respond': {
    params: { sessionId: string; requestId: string; answers: Record<string, string[]> | null };
    result: { ok: boolean };
  };

  /** A window's answer to a `browser.request` event. */
  'browser.respond': { params: { sessionId: string; requestId: string; answer: BrowserAnswer }; result: { ok: boolean } };
  /** What the session's Browser tab shows now (null: nothing, or the tab is closed), for the line the agent gets with the next message. */
  'browser.page': { params: { sessionId: string; page: { url: string; title: string } | null }; result: { ok: boolean } };

  /** Before / after pictures of a local page for the session's turns that edited it, oldest first (`capture.updated` follows changes). */
  'capture.list': { params: { sessionId: string }; result: TurnCapture[] };
  /** One picture as a data URL (null when it was pruned). */
  'capture.image': { params: { sessionId: string; id: string }; result: { data: string } | null };

  /** Android devices and the emulator, through adb (server/services/device.ts). Every call has a timeout; nothing runs until asked. */
  'device.list': { params: Record<string, never>; result: DeviceStatus };
  /** The device the Device tab shows and the agent's tools prefer. */
  'device.use': { params: { serial: string | null }; result: DeviceStatus };
  /** Starts an emulator without a window (the first AVD unless `avd` names one); `device.updated` follows as it boots. */
  'device.start': { params: { avd?: string }; result: { serial: string } };
  'device.stop': { params: { serial: string }; result: { ok: boolean } };
  'device.screenshot': { params: { serial: string }; result: DeviceFrame };
  /** Coordinates in device pixels. `hold` presses that long (a long press). */
  'device.tap': { params: { serial: string; x: number; y: number; hold?: number }; result: { ok: boolean } };
  'device.swipe': { params: { serial: string; x1: number; y1: number; x2: number; y2: number; ms?: number }; result: { ok: boolean } };
  'device.type': { params: { serial: string; text: string }; result: { ok: boolean } };
  'device.key': { params: { serial: string; key: DeviceKey }; result: { ok: boolean } };
  'device.install': { params: { serial: string; apk: string }; result: { ok: boolean; text: string } };
  'device.launch': { params: { serial: string; package: string; activity?: string; restart?: boolean }; result: { ok: boolean; text: string } };
  /** Apps the user installed (not the system's), sorted. */
  'device.packages': { params: { serial: string }; result: { packages: string[] } };
  /** The newest log lines, of one app when `package` is given; at most 1000. */
  'device.logs': { params: { serial: string; package?: string; lines?: number; level?: 'all' | 'warn' | 'error' }; result: { lines: string[]; note?: string } };
  'device.open': { params: { serial: string; url: string }; result: { ok: boolean } };

  'history.list': { params: { provider: ProviderId; cwd?: string; limit?: number; accountId?: string }; result: HistoryEntry[] };

  'fs.list': { params: { path: string }; result: { path: string; parent: string | null; entries: DirEntry[] } };
  'fs.read': { params: { path: string; maxBytes?: number }; result: { path: string; content: string; truncated: boolean; size: number; binary: boolean } };
  'fs.search': { params: { cwd: string; query: string; limit?: number }; result: { path: string; rel: string; dir: boolean }[] };
  /** Which of `names` (file-like words from an answer) are files: as a path from `cwd`, else by a clear name match inside it. Maps each found name to its absolute path. */
  'fs.resolve': { params: { cwd: string; names: string[] }; result: Record<string, string> };
  /** A URL for the Browser tab that shows the file (served apart from the app, its folder or `root` shared under a random token). */
  'fs.share': { params: { path: string; root?: string }; result: { url: string } };
  /** Opens the file with the system's default app, or with `reveal` shows it in the file manager. */
  'fs.open': { params: { path: string; reveal?: boolean }; result: { ok: boolean } };
  'fs.roots': { params: Record<string, never>; result: { roots: DirEntry[]; home: string } };

  'git.status': { params: { cwd: string }; result: GitStatus };
  'git.diff': { params: { cwd: string; path?: string; staged?: boolean }; result: FileDiff[] };
  'git.branches': { params: { cwd: string }; result: { current?: string; branches: string[] } };
  /** The repository's working trees (git worktree list), without locked, prunable or missing ones. */
  'git.worktrees': { params: { cwd: string }; result: GitWorktree[] };
  /** Stages everything (`git add -A`) and commits it with `message`. */
  'git.commit': { params: { cwd: string; message: string }; result: GitCommitResult };
  /** A commit message written by a small model from the folder's changes. Stages and commits nothing. */
  'git.draft': { params: { cwd: string }; result: { ok: boolean; message?: string; error?: string } };
  /** The branch, its base and a draft title and description for a pull request. Pushes nothing. */
  'pulls.context': { params: { cwd: string }; result: GitPullContext };
  /** Pushes the branch to origin, then opens a pull request for it with gh. */
  'pulls.create': { params: { cwd: string; title: string; body: string; base: string; draft: boolean }; result: GitPullRequestResult };

  /** The agent's own settings files (permission rules, hooks), read-only and without secrets. */
  'config.read': { params: { provider: ProviderId; cwd?: string }; result: AgentConfigFile[] };

  /** Settings › Phone (`server/services/phone.ts`). None of these can be called by a phone. */
  'phone.status': { params: Record<string, never>; result: PhoneStatus };
  /** Starts or stops the LAN endpoint (remembered across restarts). Turning it off ends every phone connection. */
  'phone.setEnabled': { params: { on: boolean }; result: PhoneStatus };
  /** A new one-time pairing key (the QR code), replacing any open one; `cancel` closes the offer. */
  'phone.pair': { params: { cancel?: boolean }; result: PhoneStatus };
  /** Answers a phone that asked to pair. */
  'phone.approve': { params: { requestId: string; allow: boolean }; result: PhoneStatus };
  /** Forgets a phone: its token stops working and its connection ends. */
  'phone.revoke': { params: { deviceId: string }; result: PhoneStatus };

  'term.run': { params: { cwd: string; command: string }; result: { termId: string } };
  'term.kill': { params: { termId: string }; result: { ok: boolean } };
  /** The folder's scripts (package.json, a simple Makefile, pyproject.toml), read fresh when their files changed (server/services/scripts.ts). */
  'project.scripts': { params: { cwd: string }; result: ProjectScripts };

  'memory.list': { params: { cwd: string; provider: ProviderId }; result: MemoryFile[] };

  /** The user's profile (written once from what is known when there is none yet). */
  'profile.read': { params: Record<string, never>; result: UserProfile };
  /** Replaces the user's own part of the profile (the agents' additions stay). */
  'profile.write': { params: { text: string }; result: UserProfile };
  /** Removes one of the agents' additions. */
  'profile.forget': { params: { id: string }; result: UserProfile };
  /** Asks GitHub for a newer release now (a found one downloads in the background). */
  'update.check': { params: Record<string, never>; result: UpdateState };
  /** Installs the downloaded release and restarts Sable; while agents work, once they are done (`cancel`: not after all). */
  'update.install': { params: { cancel?: boolean }; result: UpdateState };
  'memory.write': { params: { path: string; content: string }; result: { ok: boolean } };

  /** Stores an image for the backdrop (base64; PNG, JPEG, WebP or GIF, at most 8 MB). The bridge picks the id. */
  'backdrop.add': { params: { data: string; width: number; height: number }; result: BackdropImage };
  'backdrop.get': { params: { id: string }; result: { id: string; type: string; data: string } };
  /** Deletes the image; a backdrop that showed it moves to another image, or to no image. */
  'backdrop.remove': { params: { id: string }; result: { ok: boolean } };

  /** Every account's last known limits with history and pace (from disk at start-up). */
  'usage.limits': { params: Record<string, never>; result: LimitsReport[] };
  /** Local token usage for the last 30 days. Answers at once with what is known; `refresh` scans for changes (pushed as `usage.updated`). */
  'usage.report': { params: { refresh?: boolean }; result: UsageReport };
}

export type RpcName = keyof RpcMethods;

export interface RpcRequest<M extends RpcName = RpcName> {
  id: number;
  method: M;
  params: RpcMethods[M]['params'];
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type ServerFrame = RpcResponse | { event: BridgeEvent };

export const BRIDGE_PATH = '/__sable';

export const DEFAULT_SETTINGS: AppSettings = {
  accent: 'spectrum',
  ambience: 'full',
  fontScale: 1,
  defaultProvider: 'claude',
  defaultModels: {},
  defaultModes: {},
  defaultEfforts: {},
  notifyOnDone: true,
  sendWithEnter: true,
  showThinking: true,
  backdrop: 'streaks',
  texture: 'dither',
  backdropConfig: DEFAULT_BACKDROP,
  backdropImages: [],
  onboarded: false,
  modelVisibility: {},
  conciseReplies: true,
};

/**
 * Appended to the agent's own system prompt (Claude Code) or developer instructions (Codex)
 * while `AppSettings.conciseReplies` is on. Never replaces what the user configured.
 */
export const CONCISE_REPLIES_PROMPT =
  'Finish with a short reply: the outcome in one or two sentences, then only what the user must know or do next. '
  + 'The app shows every change and step, so do not list the files you changed or recap what you did. '
  + 'No headings in short replies and no closing offers. Keep notes between steps to a sentence. '
  + 'If you built something that can be viewed in a browser, start or reuse a local dev server in the background and put its http://localhost URL on its own line.';
