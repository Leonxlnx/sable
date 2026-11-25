/**
 * Scripted sessions for the demo provider. Every scenario works on the fictional
 * relay-api project (demo-codebase.ts) so paths, code, diffs and test output agree.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Question, TextItem, ThinkingItem, Todo, ToolItem, TurnItem, UserItem } from '../../shared/protocol';
import { makeFileDiff } from '../../shared/diff';
import * as C from './demo-codebase';
import { COMMANDS, SKILLS, contextBreakdown } from './demo-catalog';
import { BASE_CONTEXT, Denied, type OutLine, type Script, between } from './demo-script';
import * as W from './demo-widgets';
import { browserLineUrl, stripBrowserLine } from './browser-tool';
import { demoPortal } from './demo-portal';
import { signInShips } from '../services/sign-ins';
import { demoSite, LOOKS, siteCss, siteHtml } from './demo-site';
import { AUTH_FIXED, AUTH_JS, SESSION_FIXED, SESSION_JS, seedUntilFixture, untilFixture } from './demo-until';
import { briefFiles, CHECK_LEAD, NO_PROBLEMS } from '../core/check';
import path from 'node:path';

// ───────────────────────────────── content file ─────────────────────────────────

let sections: Map<string, string> | undefined;

/** A named section of demo-content.md with {{placeholders}} filled in. */
export function content(name: string, vars: Record<string, string | number> = {}): string {
  if (!sections) {
    const raw = readFileSync(fileURLToPath(new URL('./demo-content.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    sections = new Map();
    const parts = raw.split(/^@@ ([a-z0-9-]+)[ \t]*$/m);
    for (let i = 1; i < parts.length; i += 2) sections.set(parts[i], parts[i + 1].trim());
  }
  const text = sections.get(name);
  if (text === undefined) throw new Error(`demo content section missing: ${name}`);
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

// ─────────────────────────────────── types ──────────────────────────────────────

export interface ScenarioContext {
  s: Script;
  prompt: string;
  item: UserItem;
  model: string;
}

export type ScenarioResult = void | { error: string };
export type Scenario = (ctx: ScenarioContext) => Promise<ScenarioResult>;

// ─────────────────────────────────── helpers ────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('en-US');
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clock = () => new Date().toTimeString().slice(0, 8);

function todoList(items: [content: string, activeForm: string][], statuses: Todo['status'][]): Todo[] {
  return items.map(([content, activeForm], i) => ({ id: String(i + 1), content, activeForm, status: statuses[i] ?? 'pending' }));
}

interface TestFile {
  file: string;
  tests: number;
  ms: number;
}

const BASE_TEST_FILES: TestFile[] = [
  { file: 'tests/tokens.test.ts', tests: 6, ms: 12 },
  { file: 'tests/session.test.ts', tests: 9, ms: 19 },
  { file: 'tests/auth.test.ts', tests: 4, ms: 41 },
  { file: 'tests/routes.test.ts', tests: 6, ms: 104 },
];

function vitestHeader(cwd: string, filter?: string): OutLine[] {
  return [
    ['', 60],
    ['> relay-api@0.9.2 test', 40],
    [`> vitest run${filter ? ' ' + filter : ''}`, 40],
    ['', 500],
    [` RUN  v2.1.4 ${cwd}`, 700],
    ['', 300],
  ];
}

function vitestPass(cwd: string, files: TestFile[]): OutLine[] {
  const total = files.reduce((n, f) => n + f.tests, 0);
  return [
    ...vitestHeader(cwd),
    ...files.map((f): OutLine => [` ✓ ${f.file} (${f.tests} tests) ${f.ms}ms`, between(250, 700)]),
    ['', 200],
    [` Test Files  ${files.length} passed (${files.length})`, 30],
    [`      Tests  ${total} passed (${total})`, 30],
    [`   Start at  ${clock()}`, 30],
    ['   Duration  1.38s (transform 208ms, setup 0ms, collect 471ms, tests 176ms, environment 1ms, prepare 377ms)', 30],
  ];
}

/** The regression from the first middleware edit: unknown tokens get `session_missing`. */
function vitestFail(cwd: string): OutLine[] {
  const failing = 'rejects unknown session tokens with invalid_session';
  const src = C.AUTH_TEST_TS.split('\n');
  const line = C.lineOf(C.AUTH_TEST_TS, "toEqual({ error: 'invalid_session' })");
  const col = src[line - 1].indexOf('toEqual') + 1;
  const frame = (n: number) => `    ${String(n).padStart(2)}| ${src[n - 1]}`;
  const total = BASE_TEST_FILES.reduce((n, f) => n + f.tests, 0);
  const msg = "expected { error: 'session_missing' } to deeply equal { error: 'invalid_session' }";
  return [
    ...vitestHeader(cwd),
    [' ✓ tests/tokens.test.ts (6 tests) 14ms', 400],
    [' ✓ tests/session.test.ts (9 tests) 21ms', 450],
    [' ❯ tests/auth.test.ts (4 tests | 1 failed) 48ms', 600],
    [`   × requireAuth > ${failing} 9ms`, 30],
    [`     → ${msg}`, 30],
    [' ✓ tests/routes.test.ts (6 tests) 112ms', 650],
    ['', 200],
    ['⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯', 30],
    ['', 20],
    [` FAIL  tests/auth.test.ts > requireAuth > ${failing}`, 30],
    [`AssertionError: ${msg}`, 30],
    ['', 20],
    ['- Expected', 20],
    ['+ Received', 20],
    ['', 20],
    ['  {', 20],
    ['-   "error": "invalid_session",', 20],
    ['+   "error": "session_missing",', 20],
    ['  }', 20],
    ['', 20],
    [` ❯ tests/auth.test.ts:${line}:${col}`, 30],
    [frame(line - 2), 15],
    [frame(line - 1), 15],
    [frame(line), 15],
    [`      |${' '.repeat(col)}^`, 15],
    [frame(line + 1), 15],
    ['', 20],
    ['⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯', 30],
    ['', 20],
    [' Test Files  1 failed | 3 passed (4)', 30],
    [`      Tests  1 failed | ${total - 1} passed (${total})`, 30],
    [`   Start at  ${clock()}`, 30],
    ['   Duration  1.42s (transform 212ms, setup 0ms, collect 486ms, tests 195ms, environment 1ms, prepare 391ms)', 30],
  ];
}

export function deniedReply(d: Denied): string {
  if (d.feedback) {
    return `Understood, I won't go ahead with ${d.subject}. You said: “${d.feedback}”\n\nI've stopped here so nothing else changes. Tell me how you'd like to approach it and I'll continue from the current state.`;
  }
  return `Okay, I've skipped ${d.subject} and stopped here so nothing else changes. Let me know if you'd like a different approach, or ask me to continue and I'll pick up where I left off.`;
}

// ─────────────────────────────── 1. flagship refactor ───────────────────────────

async function flagshipExplore(s: Script) {
  await s.think(
    "The goal is to pull expiry handling out of `requireAuth`. Before changing anything I want to know every place that reads or writes `expiresAt`. If the middleware and the store both make expiry decisions, there may be a third copy somewhere, in the routes or the admin router. I'll grep for `expiresAt` and `Date.now()` across `src/`, then read the store and the middleware side by side.",
  );
  await s.say("I'll start by finding everywhere session expiry is decided today.");
  await s.glob('src/**/*.ts', C.globFiles('src/', '.ts'));
  await s.grep('expiresAt|Date\\.now\\(\\)', C.grep(/expiresAt|Date\.now\(\)/, 'src/'), { path: 'src' });
  await s.readMany([
    { rel: 'src/server/session.ts', content: C.SESSION_TS },
    { rel: 'src/auth/middleware.ts', content: C.MIDDLEWARE_TS },
  ]);
  await s.think(
    "So expiry is only enforced in the middleware: `session.expiresAt < Date.now()`, followed by a hard-coded `30 * 60 * 1000` renewal. That duplicates `DEFAULT_TTL_MS` and silently ignores a custom `ttlMs`: `tests/auth.test.ts` builds the store with a 60 s TTL, but the first request bumps every session to 30 minutes. `routes.ts` only echoes `expiresAt` in the login response, so it can stay. `src/lib/clock.ts` already exports a `Clock` interface that nothing uses yet, and the store should take it.\n\nPlan: `validate(id)` returns a union with a failure reason, evicts expired entries on lookup and renews from `this.ttlMs`. The middleware then becomes a thin mapping from reason to response.",
  );
}

const FLAGSHIP_TODOS: [string, string][] = [
  ['Add SessionStore.validate() with an injectable clock', 'Adding SessionStore.validate()'],
  ['Make requireAuth delegate to sessions.validate()', 'Updating requireAuth'],
  ['Run the test suite', 'Running the test suite'],
];

async function flagshipImplement(s: Script, careful: boolean) {
  await s.todos(todoList(FLAGSHIP_TODOS, ['in_progress']));
  await s.edit('src/server/session.ts', C.SESSION_TS, C.SESSION_TS_AFTER, {
    description: 'Add validate() returning a SessionCheck union; inject Clock; renew from ttlMs',
  });
  await s.todos(todoList(FLAGSHIP_TODOS, ['completed', 'in_progress']));

  if (careful) {
    await s.edit('src/auth/middleware.ts', C.MIDDLEWARE_TS, C.MIDDLEWARE_TS_FIXED, {
      description: 'Delegate to sessions.validate() and keep the public error codes',
    });
    await s.todos(todoList(FLAGSHIP_TODOS, ['completed', 'completed', 'in_progress']));
    await s.bash('npm test', { description: 'Run the test suite', lines: vitestPass(s.cwd, BASE_TEST_FILES), activity: 'Running the test suite' });
    await s.todos(todoList(FLAGSHIP_TODOS, ['completed', 'completed', 'completed']));
    await s.say(content('flagship-summary-careful'));
    return;
  }

  await s.edit('src/auth/middleware.ts', C.MIDDLEWARE_TS, C.MIDDLEWARE_TS_AFTER, {
    description: 'Replace inline expiry checks and renewal with sessions.validate()',
  });
  await s.todos(todoList(FLAGSHIP_TODOS, ['completed', 'completed', 'in_progress']));
  await s.bash('npm test', { description: 'Run the test suite', lines: vitestFail(s.cwd), exitCode: 1, activity: 'Running the test suite' });

  await s.think(
    "The failure is the error code. Before, an unknown token produced `invalid_session`. My template string turns the reason `missing` into `session_missing`. The test is right: these strings are what clients branch on, so they're part of the API. I shouldn't derive public codes from internal reason names at all. An explicit `Record<SessionFailure, string>` keeps them stable, and it also makes the compiler flag a new reason that has no code.",
  );
  await s.say(
    "One failure, and it's a real regression: unknown tokens now get `session_missing` instead of `invalid_session`. Clients depend on those codes, so I'll map reasons to codes explicitly instead of deriving them from internal names.",
  );
  const withFix: [string, string][] = [...FLAGSHIP_TODOS.slice(0, 2), ['Keep public error codes stable', 'Pinning public error codes'], FLAGSHIP_TODOS[2]];
  await s.todos(todoList(withFix, ['completed', 'completed', 'in_progress', 'pending']));
  await s.edit('src/auth/middleware.ts', C.MIDDLEWARE_TS_AFTER, C.MIDDLEWARE_TS_FIXED, {
    description: 'Pin public error codes in a FAILURE_CODES table',
  });
  await s.todos(todoList(withFix, ['completed', 'completed', 'completed', 'in_progress']));
  await s.bash('npm test', { description: 'Run the test suite again', lines: vitestPass(s.cwd, BASE_TEST_FILES), activity: 'Re-running the test suite' });
  await s.todos(todoList(withFix, ['completed', 'completed', 'completed', 'completed']));
  await s.say(content('flagship-summary'));
}

const flagship: Scenario = async ({ s }) => {
  await flagshipExplore(s);
  await s.say(
    "Expiry is only enforced in the middleware. It compares `expiresAt` to `Date.now()` and renews with a hard-coded 30 minutes, which silently ignores any `ttlMs` passed to the store. I'll move both decisions into `SessionStore` and turn the middleware into a thin adapter.",
  );
  await flagshipImplement(s, false);
  s.finish({ suggestion: 'Add unit tests for SessionStore.validate() covering the expired and revoked paths' });
};

// ───────────────────────────────────── 2. plan ──────────────────────────────────

async function rateLimitExplore(s: Script) {
  await s.think(
    "Login is `POST /auth/login` in `src/server/routes.ts`. First I'll check whether any rate limiting exists already (`rateLimit`, `429`, `Retry-After`) and whether `express-rate-limit` is a dependency, then read the route and the clock helper.",
  );
  await s.grep('rateLimit|express-rate-limit|429|Retry-After', C.grep(/rateLimit|express-rate-limit|429|Retry-After/));
  await s.readMany([
    { rel: 'src/server/routes.ts', content: C.ROUTES_TS },
    { rel: 'src/lib/clock.ts', content: C.CLOCK_TS },
  ]);
  await s.think(
    "There's no existing limiter and no dependency for one. We run a single instance, so a small in-memory fixed window keyed on IP plus normalized email is enough, and it can reuse `Clock` so the tests stay deterministic. It needs a reset on successful login and a periodic sweep to bound memory. Lockout is out of scope, since it would let attackers lock users out.",
  );
}

const RATE_TODOS: [string, string][] = [
  ['Create src/auth/rate-limit.ts', 'Creating the login limiter'],
  ['Apply the limiter to POST /auth/login', 'Wiring the limiter into routes'],
  ['Add tests/rate-limit.test.ts', 'Writing limiter tests'],
  ['Run the test suite', 'Running the test suite'],
];

async function rateLimitImplement(s: Script) {
  await s.todos(todoList(RATE_TODOS, ['in_progress']));
  await s.write('src/auth/rate-limit.ts', C.RATE_LIMIT_TS, { description: 'Fixed-window login limiter keyed by IP + email' });
  await s.todos(todoList(RATE_TODOS, ['completed', 'in_progress']));
  await s.edit('src/server/routes.ts', C.ROUTES_TS, C.ROUTES_TS_AFTER, { description: 'Mount the limiter on login, reset it on success, sweep periodically' });
  await s.todos(todoList(RATE_TODOS, ['completed', 'completed', 'in_progress']));
  await s.write('tests/rate-limit.test.ts', C.RATE_LIMIT_TEST_TS, { description: 'Limit, rollover, email normalization, reset on success' });
  await s.todos(todoList(RATE_TODOS, ['completed', 'completed', 'completed', 'in_progress']));
  const files = [...BASE_TEST_FILES, { file: 'tests/rate-limit.test.ts', tests: 4, ms: 63 }];
  await s.bash('npm test', { description: 'Run the test suite', lines: vitestPass(s.cwd, files), activity: 'Running the test suite' });
  await s.todos(todoList(RATE_TODOS, ['completed', 'completed', 'completed', 'completed']));
  await s.say(content('ratelimit-summary'));
}

const plan: Scenario = async ({ s, prompt }) => {
  const topic = /refactor|fix|session|expir/i.test(prompt) ? 'flagship' : 'ratelimit';
  if (topic === 'flagship') await flagshipExplore(s);
  else await rateLimitExplore(s);

  const planText = content(topic === 'flagship' ? 'plan-flagship' : 'plan-ratelimit');
  s.activity('Writing the plan');
  const id = await s.tool({ name: 'ExitPlanMode', kind: 'plan', title: 'Present plan', input: { plan: planText }, streamInput: true });
  s.patchTool(id, { detail: { plan: planText } });
  const { option, message } = await s.requestPermission(id, {
    toolName: 'ExitPlanMode',
    kind: 'plan',
    title: 'Ready to code?',
    detail: { plan: planText },
    options: [
      { id: 'approve-accept-edits', label: 'Approve and auto-accept edits', tone: 'always' },
      { id: 'approve', label: 'Approve, ask before each edit', tone: 'allow' },
      { id: 'keep-planning', label: 'Keep planning', tone: 'deny' },
    ],
  });

  if (option.tone === 'deny') {
    s.patchTool(id, { status: 'denied', endedAt: Date.now(), result: { text: message ? `Keep planning: ${message}` : 'Keep planning' } });
    await s.say(
      message
        ? `Got it, I'll keep planning and won't touch any files yet. I'll rework the plan around your note: *${message}*. Is there anything else you want changed before I present it again?`
        : "Okay, I'll keep planning and won't touch any files yet. Which part should change: the approach, the scope, or the files involved?",
    );
    s.finish({ suggestion: message ? 'Show me the revised plan' : 'Keep the scope smaller: skip the tests for now' });
    return;
  }

  s.complete(id, { text: 'Plan approved' });
  const mode = option.tone === 'always' ? 'acceptEdits' : 'default';
  s.setMode(mode);
  s.notice('mode', mode === 'acceptEdits' ? 'Plan approved · auto-accepting edits' : 'Plan approved · asking before each edit');

  if (topic === 'flagship') {
    await s.say("Plan approved. Starting with the store, then the middleware, then I'll run the suite.");
    await flagshipImplement(s, true);
    s.finish({ suggestion: 'Add unit tests for SessionStore.validate() covering the expired and revoked paths' });
  } else {
    await s.say('Plan approved. Implementing it now.');
    await rateLimitImplement(s);
    s.finish({ suggestion: "Set app.set('trust proxy', 1) in createApp so req.ip is the real client address" });
  }
};

// ─────────────────────────────────── 3. questions ───────────────────────────────

const LOGGER_QUESTIONS: Question[] = [
  {
    header: 'Logger',
    question: 'Which logging library should I use?',
    multiSelect: false,
    options: [
      { label: 'pino', description: 'Fastest JSON logger, with built-in redaction. Adds one dependency (recommended)' },
      { label: 'winston', description: 'Flexible transports and formats, but heavier and slower' },
      { label: 'console + JSON', description: 'No dependency: a thin wrapper that writes one JSON object per line' },
    ],
  },
  {
    header: 'Fields',
    question: 'Which fields should every request log line include?',
    multiSelect: true,
    options: [
      { label: 'Request ID', description: 'Taken from x-request-id or generated, and echoed back on the response' },
      { label: 'User ID', description: 'From the authenticated session, when there is one' },
      { label: 'Latency', description: 'Response time in milliseconds' },
      { label: 'Route template', description: 'e.g. /admin/users/:id instead of the raw URL, so dashboards can group by endpoint' },
    ],
  },
];

type Lib = 'pino' | 'winston' | 'console';

function loggerSource(lib: Lib): string {
  if (lib === 'pino') {
    return [
      "import pino from 'pino';",
      '',
      'export const logger = pino({',
      "  level: process.env.LOG_LEVEL ?? 'info',",
      "  base: { service: 'relay-api' },",
      '  timestamp: pino.stdTimeFunctions.isoTime,',
      "  redact: ['req.headers.authorization', 'req.headers.cookie'],",
      '});',
      '',
      'export type Logger = typeof logger;',
      '',
    ].join('\n');
  }
  if (lib === 'winston') {
    return [
      "import winston from 'winston';",
      '',
      'export const logger = winston.createLogger({',
      "  level: process.env.LOG_LEVEL ?? 'info',",
      "  defaultMeta: { service: 'relay-api' },",
      '  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),',
      '  transports: [new winston.transports.Console()],',
      '});',
      '',
      'export type Logger = typeof logger;',
      '',
    ].join('\n');
  }
  return [
    "type Level = 'debug' | 'info' | 'warn' | 'error';",
    '',
    'const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };',
    'const threshold = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info;',
    '',
    'export type Fields = Record<string, unknown>;',
    '',
    'export interface Logger {',
    '  debug(fields: Fields, msg: string): void;',
    '  info(fields: Fields, msg: string): void;',
    '  warn(fields: Fields, msg: string): void;',
    '  error(fields: Fields, msg: string): void;',
    '  child(bindings: Fields): Logger;',
    '}',
    '',
    '/** Writes one JSON object per line; errors go to stderr. */',
    'export function createLogger(bindings: Fields = {}): Logger {',
    '  const write = (level: Level) => (fields: Fields, msg: string) => {',
    '    if (LEVELS[level] < threshold) return;',
    '    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...bindings, ...fields });',
    "    (level === 'error' ? process.stderr : process.stdout).write(line + '\\n');",
    '  };',
    '  return {',
    "    debug: write('debug'),",
    "    info: write('info'),",
    "    warn: write('warn'),",
    "    error: write('error'),",
    '    child: (more) => createLogger({ ...bindings, ...more }),',
    '  };',
    '}',
    '',
    "export const logger = createLogger({ service: 'relay-api' });",
    '',
  ].join('\n');
}

function requestLogSource(lib: Lib, fields: Set<string>): string {
  const rid = fields.has('Request ID');
  const uid = fields.has('User ID');
  const lat = fields.has('Latency');
  const route = fields.has('Route template');
  const l: string[] = [];
  if (rid) l.push("import { randomUUID } from 'node:crypto';");
  l.push("import type { NextFunction, Request, Response } from 'express';", "import { logger } from '../lib/logger';", '');
  l.push('/** Logs one structured line per request once the response has been sent. */');
  l.push('export function requestLog(req: Request, res: Response, next: NextFunction) {');
  if (lat) l.push('  const start = process.hrtime.bigint();');
  if (rid) l.push("  const requestId = req.header('x-request-id') ?? randomUUID();", "  res.setHeader('x-request-id', requestId);");
  if (lat || rid) l.push('');
  l.push("  res.on('finish', () => {", '    const fields: Record<string, unknown> = {', '      method: req.method,');
  l.push(route ? "      route: req.route ? req.baseUrl + req.route.path : 'unmatched'," : '      url: req.originalUrl,');
  l.push('      status: res.statusCode,');
  if (rid) l.push('      requestId,');
  if (lat) l.push('      durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100,');
  l.push('    };');
  if (uid) l.push('    if (req.session) fields.userId = req.session.userId;');
  l.push(lib === 'winston' ? "    logger.info('request completed', fields);" : "    logger.info(fields, 'request completed');");
  l.push('  });', '', '  next();', '}', '');
  return l.join('\n');
}

function sampleLine(lib: Lib, fields: Set<string>): string {
  const req: Record<string, unknown> = { method: 'GET', [fields.has('Route template') ? 'route' : 'url']: '/me', status: 200 };
  if (fields.has('Request ID')) req.requestId = '3f9c1e52-8b7a-4d16-a0e4-6c2d9b51f7a3';
  if (fields.has('Latency')) req.durationMs = 3.41;
  if (fields.has('User ID')) req.userId = 'u_1';
  const time = new Date().toISOString();
  if (lib === 'pino') return JSON.stringify({ level: 30, time, service: 'relay-api', ...req, msg: 'request completed' });
  if (lib === 'winston') return JSON.stringify({ level: 'info', message: 'request completed', ...req, service: 'relay-api', timestamp: time });
  return JSON.stringify({ time, level: 'info', msg: 'request completed', service: 'relay-api', ...req });
}

const questions: Scenario = async ({ s }) => {
  await s.think(
    "Structured logging touches every request, and two decisions change the shape of the code: which library to use (a dependency or not), and which fields go on each line. The user-ID field also depends on where the middleware is mounted relative to `requireAuth`. Guessing wrong means rewriting both files, so I'll ask first.",
  );
  await s.say("I'll add structured request logging. Two choices shape the code, so I'll ask before writing anything.");
  const id = await s.tool({ name: 'AskUserQuestion', kind: 'question', title: 'Ask 2 questions', detail: { questions: LOGGER_QUESTIONS }, input: { questions: LOGGER_QUESTIONS } });
  const answers = await s.ask(LOGGER_QUESTIONS, id);
  if (!answers) {
    s.patchTool(id, { status: 'cancelled', endedAt: Date.now(), result: { text: 'Questions dismissed' } });
    await s.say(
      "No problem, I'll wait. When you're ready, tell me which logger you prefer and which fields matter, and I'll pick it up from there. Nothing has been changed yet.",
    );
    s.finish({ suggestion: 'Use pino and log request ID, latency and route template' });
    return;
  }

  const pick = (q: Question) => answers[q.question] ?? (q.header ? answers[q.header] : undefined) ?? [];
  const libAnswer = (pick(LOGGER_QUESTIONS[0])[0] ?? 'pino').toLowerCase();
  const lib: Lib = libAnswer.includes('winston') ? 'winston' : libAnswer.includes('console') ? 'console' : 'pino';
  const fields = new Set(pick(LOGGER_QUESTIONS[1]));
  s.complete(id, { answers, text: `Logger: ${lib}; fields: ${[...fields].join(', ') || 'none beyond method, URL and status'}` });

  const libName = lib === 'console' ? 'a dependency-free JSON logger' : lib;
  await s.think(
    `${lib === 'console' ? 'No dependency then. A small wrapper with the same `(fields, msg)` call shape as pino keeps a later switch cheap.' : `${lib} it is.`} The middleware should log on \`finish\` rather than up front, so the status code and latency are known.${fields.has('User ID') ? ' `req.session` is only set once `requireAuth` has run, but by `finish` it has, so mounting early is fine.' : ''}`,
  );
  if (lib !== 'console') {
    await s.bash(`npm install ${lib}`, {
      description: `Install ${lib}`,
      key: 'npm install',
      startDelay: 600,
      lines: [
        ['', 1800],
        [`added ${lib === 'pino' ? 11 : 28} packages, and audited ${lib === 'pino' ? 214 : 231} packages in 3s`, 40],
        ['', 30],
        ['38 packages are looking for funding', 30],
        ['  run `npm fund` for details', 30],
        ['', 30],
        ['found 0 vulnerabilities', 30],
      ],
    });
  }
  await s.write('src/lib/logger.ts', loggerSource(lib), { description: `Shared ${libName} instance` });
  await s.write('src/server/request-log.ts', requestLogSource(lib, fields), { description: 'One structured line per finished request' });
  await s.edit('src/app.ts', C.APP_TS, C.APP_TS_WITH_LOGGING, { description: 'Mount requestLog after cookieParser()' });
  await s.bash('npx tsc --noEmit', { description: 'Typecheck the project', key: 'npx tsc', lines: [['', 2200]] });

  const fieldNames = ['method', fields.has('Route template') ? 'route template' : 'URL', 'status'];
  if (fields.has('Request ID')) fieldNames.push('request ID');
  if (fields.has('User ID')) fieldNames.push('user ID (when authenticated)');
  if (fields.has('Latency')) fieldNames.push('latency in ms');
  await s.say(
    content('logging-summary', {
      library: lib === 'console' ? 'a small dependency-free JSON logger' : lib,
      fields: fieldNames.map((f) => `\`${f}\``).join(', '),
      sample: sampleLine(lib, fields),
    }),
  );
  s.finish({ suggestion: 'Include the request ID in errorHandler logs as well' });
};

// ─────────────────────────────────── 4. sub-agents ──────────────────────────────

const agents: Scenario = async ({ s }) => {
  await s.think(
    'This spans the route handlers and the tests, and the two halves are independent: (1) where do 401/403 responses come from and are they consistent, and (2) what do the tests actually cover. Two parallel Explore agents will be faster than doing it serially, and I can cross-check their findings afterwards.',
  );
  await s.say("I'll split this into two parallel investigations. One maps every place an auth failure becomes an HTTP response, the other checks what the tests cover.");

  const specA = {
    subagent: 'Explore',
    description: 'Map auth error responses',
    prompt:
      'Find every place in src/ where an authentication or authorization failure becomes an HTTP response: 401/403 responses, thrown auth errors and error-handler mappings. For each one, report file:line, status code and response body shape. Call out inconsistencies.',
  };
  const specB = {
    subagent: 'Explore',
    description: 'Audit auth test coverage',
    prompt:
      'Review tests/ for coverage of authentication failures: which error codes and status codes are asserted, and which auth code paths in src/auth and src/server have no test. Report the gaps concretely.',
  };
  s.activity('Running 2 agents');
  const a = await s.tool({ name: 'Task', kind: 'agent', title: specA.description, detail: specA, input: { subagent_type: specA.subagent, description: specA.description, prompt: specA.prompt } });
  const b = await s.tool({ name: 'Task', kind: 'agent', title: specB.description, detail: specB, input: { subagent_type: specB.subagent, description: specB.description, prompt: specB.prompt } });
  s.start(a);
  s.start(b);

  const lines = {
    mwLine: C.lineOf(C.MIDDLEWARE_TS, 'res.status(401)'),
    routesLine: C.lineOf(C.ROUTES_TS, 'invalid_credentials'),
    adminLine: C.lineOf(C.ADMIN_TS, 'status(403)'),
    webhookLine: C.lineOf(C.WEBHOOKS_TS, 'verifyToken('),
  };

  const runA = async () => {
    const o = { parentId: a };
    await s.think('Start with explicit status codes, then look for thrown errors that reach the error handler without a mapping.', a);
    await s.grep('status\\((401|403)\\)', C.grep(/status\((401|403)\)/, 'src/'), { ...o, path: 'src' });
    await s.read('src/server/admin.ts', C.ADMIN_TS, o);
    await s.grep('TokenError|verifyToken', C.grep(/TokenError|verifyToken/, 'src/'), { ...o, path: 'src' });
    await s.readMany(
      [
        { rel: 'src/server/webhooks.ts', content: C.WEBHOOKS_TS },
        { rel: 'src/server/errors.ts', content: C.ERRORS_TS },
      ],
      o,
    );
    const report = content('agents-report-a', lines);
    await s.say(report, a);
    s.complete(a, { text: report, agent: { tokens: 18_400, steps: 5 } });
  };

  const runB = async () => {
    const o = { parentId: b };
    await s.pause(250, 500);
    await s.glob('tests/**/*.test.ts', C.globFiles('tests/'), o);
    await s.grep("toBe\\((401|403)\\)|error: '", C.grep(/toBe\((401|403)\)|error: '/, 'tests/'), { ...o, path: 'tests' });
    await s.read('tests/auth.test.ts', C.AUTH_TEST_TS, o);
    await s.read('tests/routes.test.ts', C.ROUTES_TEST_TS, o);
    const report = content('agents-report-b');
    await s.say(report, b);
    s.complete(b, { text: report, agent: { tokens: 12_900, steps: 4 } });
  };

  await Promise.all([runA(), runB()]);
  s.activity('Synthesizing findings');
  await s.think(
    "Both reports agree on the shape. Two items are real bugs rather than style issues: the webhook 500 (it pages on-call, and the provider's retries amplify it) and the inconsistent admin body. Coverage gaps line up with those same paths. I'll rank them by impact and say which fixes are safe right now.",
  );
  await s.say(content('agents-synthesis', lines));
  s.finish({ suggestion: 'Map TokenError to a 401 in errorHandler and add the missing auth tests' });
};

// ─────────────────────── 4b. a crew: every state a sub-agent can be in ───────────────────────

/**
 * Four sub-agents started together: one of the agent's own kinds that finishes with figures, one
 * handed to the other agent (Codex, whose command asks for approval outside bypass), one that
 * fails, and one sent to the background that is still working when the others are done.
 */
const crew: Scenario = async ({ s }) => {
  await s.say('Four things can run side by side here: a map of the auth errors, a second opinion from Codex on the token refresh, a reproduction of the webhook failure, and a migration plan in the background.');
  const spec = (subagent: string, description: string, prompt: string, extra: Record<string, unknown> = {}) => ({ subagent, description, prompt, ...extra });
  const specs = [
    spec('Explore', 'Map auth error responses', 'Find every place in src/ where an authentication or authorization failure becomes an HTTP response. For each one, report file:line, status code and response body shape. Call out inconsistencies.'),
    spec('Codex', 'Review the token refresh', 'Review src/auth/session.ts for races in the token refresh: two requests that refresh at once, a refresh that fails halfway, and what the tests cover. Run the auth tests. Report concrete findings with file:line.'),
    spec('general-purpose', 'Reproduce the webhook failure', 'Reproduce the 500 from the webhook endpoint when the signature is wrong. Report the exact request and the stack trace.'),
    spec('Plan', 'Draft the session store migration', 'Draft a step by step plan to move sessions from memory to the database without logging anyone out.', { background: true }),
  ];
  s.activity('Running 4 agents');
  const ids: string[] = [];
  for (const [i, sp] of specs.entries()) {
    const delegate = i === 1;
    ids.push(
      await s.tool({
        name: delegate ? 'mcp__sable__delegate_to_codex' : 'Agent',
        kind: 'agent',
        title: sp.description,
        detail: sp,
        input: delegate ? { description: sp.description, prompt: sp.prompt } : { subagent_type: sp.subagent, description: sp.description, prompt: sp.prompt, ...(i === 3 ? { run_in_background: true } : {}) },
      }),
    );
  }
  const [a, b, c, d] = ids;
  for (const id of ids) s.start(id);
  // Sent to the background: its call returns at once, and it works on.
  s.complete(d, { agent: { background: 'running' } });

  const runA = async () => {
    const o = { parentId: a };
    await s.think('Start with explicit status codes, then look for thrown errors that reach the error handler without a mapping.', a);
    await s.grep('status\\((401|403)\\)', C.grep(/status\((401|403)\)/, 'src/'), { ...o, path: 'src' });
    await s.read('src/server/admin.ts', C.ADMIN_TS, o);
    await s.grep('TokenError|verifyToken', C.grep(/TokenError|verifyToken/, 'src/'), { ...o, path: 'src' });
    await s.read('src/server/webhooks.ts', C.WEBHOOKS_TS, o);
    await s.read('src/server/errors.ts', C.ERRORS_TS, o);
    await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS, o);
    const report = content('agents-report-a', { mwLine: C.lineOf(C.MIDDLEWARE_TS, 'res.status(401)'), routesLine: C.lineOf(C.ROUTES_TS, 'invalid_credentials'), adminLine: C.lineOf(C.ADMIN_TS, 'status(403)'), webhookLine: C.lineOf(C.WEBHOOKS_TS, 'verifyToken(') });
    await s.say(report, a);
    s.complete(a, { text: report, agent: { tokens: 41_200, steps: 6 } });
  };

  const runB = async () => {
    const o = { parentId: b };
    await s.pause(200, 400);
    await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS, o);
    await s.grep('refresh', C.grep(/refresh|verifyToken/, 'src/'), { ...o, path: 'src' });
    await s.bash('npm test -- auth', { ...o, description: 'Run the auth tests', lines: ['> vitest run auth', '', ' ✓ tests/auth.test.ts (7)', '', ' Test Files  1 passed (1)', '      Tests  7 passed (7)'], key: 'npm test' });
    const report = 'The refresh has one real race: two requests that arrive with an expired token both call `refresh()`, and the second one invalidates the token the first just received.\n\n- `src/auth/middleware.ts`: no lock around the refresh\n- The 7 auth tests pass, none of them sends two requests at once\n\nA single in-flight promise per session fixes it.';
    await s.say(report, b);
    s.complete(b, { text: report });
  };

  const runC = async () => {
    const o = { parentId: c };
    await s.pause(300, 600);
    await s.read('src/server/webhooks.ts', C.WEBHOOKS_TS, o);
    await s.bash('curl -s -X POST localhost:3000/webhooks -H "x-signature: bad"', { ...o, description: 'Send a webhook with a bad signature', readonly: true, exitCode: 7, stderr: 'curl: (7) Failed to connect to localhost port 3000: Connection refused' });
    s.complete(c, { text: 'The server is not running on port 3000, so the request could not be sent.\nStart it with npm run dev and run this again.', isError: true }, 'error');
  };

  const runD = async () => {
    const o = { parentId: d };
    await s.pause(500, 900);
    await s.glob('src/auth/**/*.ts', C.globFiles('src/'), o);
    await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS, o);
    s.patchTool(d, { result: { agent: { background: 'running', tokens: 9_300, steps: 2 } } });
  };

  await Promise.all([runA(), runB(), runC(), runD()]);
  s.activity('Synthesizing findings');
  await s.say('Three of the four are back. The auth map found the inconsistent admin body, Codex found a race in the token refresh, and the webhook reproduction could not reach the server. The migration plan is still being drafted in the background.');
  s.finish({ suggestion: 'Start the dev server and reproduce the webhook failure again' });
};

// ─────────────── 4c. a workflow: phases, and agents started in each ───────────────

/**
 * A Claude Code workflow (the Workflow tool): the call returns at once and the run goes on in the
 * background, phase by phase, its agents reporting progress rows as the CLI does. Three phases:
 * three agents survey in parallel, two fix, one verifies (and one survey agent fails).
 */
const workflow: Scenario = async ({ s }) => {
  await s.say('This is three steps with clear hand-offs, so I will run it as a workflow: survey the auth code in parallel, fix what the survey finds, then verify.');
  const phases = [
    { title: 'Survey', detail: 'one agent per area maps the auth failures' },
    { title: 'Fix', detail: 'one agent per finding makes the change' },
    { title: 'Verify', detail: 'run the tests and review the diff' },
  ];
  const script = `export const meta = {\n  name: 'auth-hardening',\n  description: 'Survey, fix and verify the auth error handling',\n  phases: ${JSON.stringify(phases)},\n}\n\nphase('Survey')\nconst found = await parallel(AREAS.map((a) => () => agent(SURVEY(a), { label: 'survey:' + a })))\nphase('Fix')\n...`;
  const id = await s.tool({ name: 'Workflow', kind: 'agent', title: 'Survey, fix and verify the auth error handling', detail: { subagent: 'Workflow', description: 'Survey, fix and verify the auth error handling', background: true }, input: { script } });
  s.patchTool(id, { workflow: { name: 'auth-hardening', phases, phase: 0, agents: [], status: 'running' } });
  s.start(id);
  await s.pause(300, 500);
  s.complete(id, { text: 'Workflow launched in the background.', agent: { background: 'running' } });
  s.activity('Waiting for the workflow');

  type Row = { index: number; label: string; phase: number; state: 'queued' | 'running' | 'done' | 'error'; startedAt?: number; tokens?: number; steps?: number; durationMs?: number; activity?: string; error?: string; model?: string };
  const rows: Row[] = [];
  let phase = 0;
  const t0 = Date.now();
  const push = (status: 'running' | 'done' = 'running') => {
    const tokens = rows.reduce((n, r) => n + (r.tokens ?? 0), 0);
    const steps = rows.reduce((n, r) => n + (r.steps ?? 0), 0);
    s.patchTool(id, {
      workflow: { name: 'auth-hardening', phases, phase, agents: rows.map((r) => ({ ...r })), status, tokens, steps, ...(status === 'done' ? { durationMs: Date.now() - t0 } : {}) },
      // Its launch result follows the run's end, as Claude Code's task notification sets both.
      ...(status === 'done' ? { result: { text: 'Workflow launched in the background.', agent: { background: 'done' as const } } } : {}),
    });
  };
  const work = async (r: Row, acts: string[], end: { tokens: number; error?: string }) => {
    r.state = 'running';
    r.startedAt = Date.now();
    push();
    for (const [i, a] of acts.entries()) {
      await s.pause(900, 1600);
      r.activity = a;
      r.steps = (r.steps ?? 0) + 1 + (i % 2);
      r.tokens = Math.round((end.tokens * (i + 1)) / (acts.length + 1));
      push();
    }
    await s.pause(700, 1200);
    r.tokens = end.tokens;
    r.durationMs = Date.now() - (r.startedAt ?? Date.now());
    r.state = end.error ? 'error' : 'done';
    if (end.error) r.error = end.error;
    push();
  };
  const add = (label: string, p: number): Row => {
    const r: Row = { index: rows.length + 1, label, phase: p, state: 'queued', model: 'demo-large' };
    rows.push(r);
    return r;
  };

  phase = 1;
  const survey = [add('survey:middleware', 1), add('survey:routes', 1), add('survey:webhooks', 1)];
  push();
  await Promise.all([
    work(survey[0], ['Read src/auth/middleware.ts', 'Search for status(401)', 'Read src/server/errors.ts'], { tokens: 21_400 }),
    work(survey[1], ['Read src/server/routes.ts', 'Search for invalid_credentials'], { tokens: 14_800 }),
    work(survey[2], ['Read src/server/webhooks.ts', 'Run curl against /webhooks'], { tokens: 9_600, error: 'The server is not running on port 3000.' }),
  ]);

  phase = 2;
  const fix = [add('fix:token-error', 2), add('fix:admin-body', 2)];
  push();
  await Promise.all([
    work(fix[0], ['Edit src/server/errors.ts', 'Edit src/auth/middleware.ts', 'Run npm test -- auth'], { tokens: 26_300 }),
    work(fix[1], ['Read src/server/admin.ts', 'Edit src/server/admin.ts'], { tokens: 12_100 }),
  ]);

  phase = 3;
  const verify = add('verify:tests', 3);
  push();
  await work(verify, ['Run npm test', 'Review the diff'], { tokens: 17_900 });
  push('done');

  s.activity('Reading the results');
  await s.say('The workflow is done. TokenError now maps to a 401 and the admin routes return the same error body as the others; the auth tests pass. The webhook survey could not reach the server, so that path is still unchecked.');
  s.finish({ suggestion: 'Start the dev server and survey the webhooks again' });
};

// ─────────────── 4d. a sub-agent stopped by its own model's weekly limit ───────────────

/**
 * Two sub-agents: one on the session's model finishes, one on another model stops at that model's
 * weekly limit. The account stays the same and the chat itself can go on with its own model.
 */
const limited: Scenario = async ({ s, model }) => {
  await s.say('Two agents: one maps the auth errors, one on Demo Deep reviews the token refresh.');
  const specA = { subagent: 'Explore', description: 'Map auth error responses', prompt: 'Find every place in src/ where an auth failure becomes an HTTP response.' };
  const specB = { subagent: 'general-purpose', description: 'Review the token refresh', prompt: 'Review src/auth/session.ts for races in the token refresh. Use the deep model.' };
  const a = await s.tool({ name: 'Agent', kind: 'agent', title: specA.description, detail: specA, input: { subagent_type: specA.subagent, description: specA.description, prompt: specA.prompt } });
  const b = await s.tool({ name: 'Agent', kind: 'agent', title: specB.description, detail: specB, input: { subagent_type: specB.subagent, description: specB.description, prompt: specB.prompt, model: 'demo-deep' } });
  s.start(a);
  s.start(b);
  const runA = async () => {
    const o = { parentId: a };
    await s.grep('status\\((401|403)\\)', C.grep(/status\((401|403)\)/, 'src/'), { ...o, path: 'src' });
    await s.read('src/server/admin.ts', C.ADMIN_TS, o);
    await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS, o);
    const report = 'Three places turn an auth failure into a response: the middleware (401), the login route (401) and the admin routes (403, with a different body).';
    await s.say(report, a);
    s.complete(a, { text: report, agent: { tokens: 16_200, steps: 3 } });
  };
  const runB = async () => {
    const o = { parentId: b };
    await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS, o);
    await s.pause(600, 900);
    // The week of Demo Deep is used up: its window says so, the agent's run ends with the CLI's words.
    const week = new Date();
    week.setDate(week.getDate() + ((8 - week.getDay()) % 7 || 7));
    week.setHours(0, 0, 0, 0);
    s.limitReached({ id: 'model_Demo Deep', label: 'Weekly · Demo Deep', percent: 100, resetsAt: week.getTime(), windowMins: 10_080 });
    const said = `You've hit your Demo Deep limit · resets ${week.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, 12am`;
    s.complete(b, { text: said, agent: { steps: 1, tokens: 3_100, limit: { window: 'Weekly · Demo Deep', resetsAt: week.getTime() } } });
  };
  await Promise.all([runA(), runB()]);
  await s.say(`The refresh review stopped at the Demo Deep weekly limit. The map is back: three places answer auth failures, and the admin routes use a different body. I can do the refresh review myself on ${model === 'demo-deep' ? 'this model' : 'this chat’s model'}.`);
  s.finish({ suggestion: 'Review the token refresh here instead' });
};

// ─────────────── 4e. a fleet: dozens of sub-agents with hundreds of steps each ───────────────

const FLEET_TASKS = [
  'Map auth error responses',
  'Audit auth test coverage',
  'Review the token refresh',
  'Trace session expiry',
  'Check the rate limiter',
  'Review webhook signatures',
  'Audit the admin routes',
  'Find unused exports',
  'Check error handler mappings',
  'Review request id logging',
  'Audit cookie flags',
  'Check the CORS settings',
  'Review password hashing',
  'Trace the login flow',
  'Check input validation',
  'Review the database migrations',
  'Audit environment variables',
  'Check graceful shutdown',
  'Review the retry logic',
  'Measure the test run time',
  'Find slow queries',
  'Review the cache layer',
  'Check dependency versions',
  'Audit file uploads',
  'Review pagination',
  'Check timezone handling',
  'Review the health check',
  'Audit the TLS settings',
  'Find flaky tests',
  'Review the API docs',
  'Check type coverage',
  'Review the build config',
  'Audit CSRF protection',
  'Check secrets in logs',
];

/**
 * A load test for the Agents tab: 34 sub-agents that finish at once with 80 to 260 steps each
 * (two fail, one is stopped, one stops at a plan limit), then a workflow (about a minute and a half)
 * and two background agents that start with 150 steps and keep working for about three minutes, a
 * step every second or so (the first keeps a task list), before they write their reports. Steps are added directly (no streamed inputs), like
 * marathon.
 */
const fleet: Scenario = async ({ s }) => {
  await s.say('Splitting the audit across many agents, one per area, with two long ones in the background and a workflow for the fixes.');
  const files = C.FILES.filter((f) => f.endsWith('.ts'));
  const kinds = ['Explore', 'general-purpose', 'Plan'];
  const step = (parentId: string, i: number, done = true) => {
    const rel = files[i % files.length];
    const name = rel.split('/').pop()!;
    const k = i % 6;
    const kind: ToolItem['kind'] = k === 0 || k === 3 ? 'read' : k === 1 ? 'search' : k === 2 || k === 4 ? 'edit' : 'bash';
    const title = kind === 'read' ? `Read ${name}` : kind === 'search' ? `Search for “step${i}”` : kind === 'edit' ? `Edit ${name}` : i % 4 === 1 ? 'Rerun the lane tests' : 'Run the type checker';
    const detail = kind === 'bash' ? { command: i % 4 === 1 ? 'timeout 170 pnpm exec vitest run tests/auth.test.ts tests/session.test.ts' : 'pnpm exec tsc --noEmit', description: title } : kind === 'search' ? { pattern: `step${i}`, path: s.abs('src') } : { path: s.abs(rel) };
    const result = kind === 'read' ? { file: { path: s.abs(rel), numLines: 40 + (i % 90) } } : kind === 'search' ? { count: i % 4 } : kind === 'edit' ? { diff: [makeFileDiff(rel, 'a\n', `a\n// step ${i}\n`)] } : { text: '', exitCode: 0 };
    const now = Date.now();
    return s.rt.add<ToolItem>({ type: 'tool', name: kind, kind, title, status: done ? 'done' : 'running', detail, input: {}, parentId, ...(done ? { result, endedAt: now } : {}) }).id;
  };
  const spawn = async (description: string, i: number, extra: Record<string, unknown> = {}) => {
    const codex = i % 7 === 3;
    const subagent = codex ? 'Codex' : kinds[i % kinds.length];
    const prompt = `${description} across src/ and tests/. Report concrete findings with file:line and say which ones are safe to fix now.`;
    return s.tool({
      name: codex ? 'mcp__sable__delegate_to_codex' : 'Agent',
      kind: 'agent',
      title: description,
      detail: { subagent, description, prompt, ...extra },
      input: { subagent_type: subagent, description, prompt, ...extra },
    });
  };

  // 34 that finish at once, each with its own count of steps.
  s.activity(`Running ${FLEET_TASKS.length} agents`);
  for (const [i, task] of FLEET_TASKS.entries()) {
    const id = await spawn(task, i);
    s.start(id);
    const steps = 80 + ((i * 37) % 180);
    for (let j = 0; j < steps; j++) {
      step(id, i * 7 + j);
      if (j % 40 === 39) await s.sleep(4);
    }
    const report = `${task}: ${3 + (i % 5)} findings, ${1 + (i % 3)} safe to fix now.\n\n- \`src/auth/middleware.ts\`: the 401 body differs from the others\n- \`src/server/errors.ts\`: TokenError has no mapping\n\nNothing else stands out.`;
    s.rt.add<TextItem>({ type: 'text', text: report, streaming: false, parentId: id });
    const durationMs = (40 + ((i * 523) % 2700)) * 1000;
    const tokens = 20_000 + ((i * 10_733) % 360_000);
    if (i === 6 || i === 21) s.complete(id, { text: 'The server is not running on port 3000, so the request could not be sent.', isError: true, agent: { steps, durationMs } }, 'error');
    else if (i === 12) s.complete(id, { text: report, agent: { steps, tokens, durationMs, background: 'stopped' } });
    else if (i === 17) s.complete(id, { text: "You've hit your Demo Deep limit", agent: { steps, tokens, limit: { window: 'Weekly · Demo Deep' } } });
    else s.complete(id, { text: report, agent: { tokens, steps, durationMs } });
  }

  // Two that keep working in the background, and a workflow.
  const long = [await spawn('Rerun the lane tests until green', 1, { background: true }), await spawn('Draft the session store migration', 2, { background: true })];
  for (const id of long) {
    s.start(id);
    s.complete(id, { agent: { background: 'running' } });
    for (let j = 0; j < 150; j++) {
      step(id, j);
      if (j % 40 === 39) await s.sleep(4);
    }
  }
  const phases = [{ title: 'Survey' }, { title: 'Fix' }, { title: 'Verify' }];
  const wf = await s.tool({ name: 'Workflow', kind: 'agent', title: 'Fix what the audit found', detail: { subagent: 'Workflow', description: 'Fix what the audit found', background: true }, input: {} });
  s.start(wf);
  s.complete(wf, { text: 'Workflow launched in the background.', agent: { background: 'running' } });
  type Row = { index: number; label: string; phase: number; state: 'queued' | 'running' | 'done' | 'error'; startedAt?: number; tokens?: number; steps?: number; durationMs?: number; activity?: string; error?: string };
  const rows: Row[] = [];
  let phase = 0;
  const t0 = Date.now();
  const push = (status: 'running' | 'done' = 'running') =>
    s.patchTool(wf, {
      workflow: { name: 'audit-fixes', phases, phase, agents: rows.map((r) => ({ ...r })), status, tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0), steps: rows.reduce((n, r) => n + (r.steps ?? 0), 0), ...(status === 'done' ? { durationMs: Date.now() - t0 } : {}) },
      ...(status === 'done' ? { result: { text: 'Workflow launched in the background.', agent: { background: 'done' as const } } } : {}),
    });
  const work = async (r: Row, acts: string[], tokens: number) => {
    r.state = 'running';
    r.startedAt = Date.now();
    push();
    for (const [i, a] of acts.entries()) {
      await s.pause(5000, 9000);
      r.activity = a;
      r.steps = (r.steps ?? 0) + 2 + (i % 3);
      r.tokens = Math.round((tokens * (i + 1)) / (acts.length + 1));
      push();
    }
    await s.pause(900, 1500);
    r.tokens = tokens;
    r.durationMs = Date.now() - (r.startedAt ?? Date.now());
    r.state = 'done';
    push();
  };
  const runWorkflow = async () => {
    phase = 1;
    const survey = ['survey:auth', 'survey:session', 'survey:webhooks'].map((label, i) => ({ index: i + 1, label, phase: 1, state: 'queued' as const }));
    rows.push(...survey);
    push();
    await Promise.all(survey.map((r, i) => work(r, ['Read src/auth/middleware.ts', 'Search for TokenError', 'Read src/server/errors.ts', 'Read src/server/routes.ts'].slice(0, 3 + (i % 2)), 18_000 + i * 4_000)));
    phase = 2;
    const fix = ['fix:token-error', 'fix:admin-body'].map((label, i) => ({ index: rows.length + i + 1, label, phase: 2, state: 'queued' as const }));
    rows.push(...fix);
    push();
    await Promise.all(fix.map((r) => work(r, ['Read src/server/errors.ts', 'Edit src/server/errors.ts', 'Edit src/auth/middleware.ts', 'Run the auth tests'], 26_000)));
    phase = 3;
    const verify: Row = { index: rows.length + 1, label: 'verify:tests', phase: 3, state: 'queued' };
    rows.push(verify);
    push();
    await work(verify, ['Run npm test', 'Read the failures', 'Review the diff'], 17_900);
    push('done');
  };
  // The first long agent keeps a task list (as Claude Code's agents do with TodoWrite): its progress.
  const plan = ['Run the lane tests', 'Find the flaky tests', 'Inject the clock in the session tests', 'Pick a free port in the route tests', 'Run the lane tests three times'];
  const runLong = async (id: string, n: number, base: number, todos = false) => {
    let steps = 150;
    for (let j = 0; j < n; j++) {
      if (todos && j % 30 === 0) {
        const done = j / 30;
        const list = plan.map((content, k) => ({ content, status: k < done ? 'completed' : k === done ? 'in_progress' : 'pending' }) as Todo);
        s.rt.add<ToolItem>({ type: 'tool', name: 'TodoWrite', kind: 'todo', title: 'Update the task list', status: 'done', detail: { todos: list }, input: { todos: list }, parentId: id, result: { text: '' }, endedAt: Date.now() });
        steps++;
      }
      if (j % 9 === 4) {
        s.rt.add<ThinkingItem>({ type: 'thinking', text: 'Checking what the last run changed before the next step.', streaming: false, parentId: id });
        await s.pause(900, 1600);
      }
      const sid = step(id, base + j, false);
      await s.pause(500, 1100);
      s.complete(sid, j % 6 === 1 ? { file: { path: s.abs(files[j % files.length]), numLines: 60 } } : { text: '', exitCode: 0 });
      steps++;
      await s.pause(200, 600);
    }
    const report = 'All lane tests pass on the third run. Two were flaky: `tests/session.test.ts` waits on a real clock, and `tests/routes.test.ts` shares a port with the dev server.\n\nBoth are fixed by injecting the clock and picking a free port.';
    const text = s.rt.add<TextItem>({ type: 'text', text: '', streaming: true, parentId: id });
    for (const chunk of report.match(/.{1,24}/gs) ?? []) {
      s.rt.delta(text.id, 'text', chunk);
      await s.sleep(60);
    }
    s.rt.patch<TextItem>(text.id, { streaming: false });
    s.patchTool(id, { result: { text: report, agent: { background: 'done', steps, tokens: 240_000 + base * 1000, durationMs: Date.now() - (s.rt.get<ToolItem>(id)?.ts ?? Date.now()) } } });
  };
  s.activity('Waiting for 3 agents');
  await Promise.all([runWorkflow(), runLong(long[0], 150, 300, true), runLong(long[1], 120, 600)]);
  await s.say('All agents are back. 31 finished, two could not reach the server, one was stopped and one stopped at the Demo Deep limit. The lane tests pass and the workflow fixed the token error mapping.');
  s.finish({ suggestion: 'Start the dev server and rerun the two failed agents' });
};

// ──────────────────────────────────── 5. web search ─────────────────────────────

const search: Scenario = async ({ s }) => {
  await s.think(
    "Node's shutdown semantics changed between versions: `closeIdleConnections()` arrived in 18.2, and `server.close()` started dropping idle keep-alive sockets in 19. I'd rather check the current docs than rely on memory, then map the answer onto `src/main.ts`, which as far as I remember never closes the server.",
  );
  await s.websearch(
    'node.js http server graceful shutdown SIGTERM closeIdleConnections',
    [
      { title: 'HTTP: server.close([callback]) | Node.js v22 Documentation', url: 'https://nodejs.org/api/http.html#serverclosecallback' },
      { title: 'HTTP: server.closeAllConnections() | Node.js v22 Documentation', url: 'https://nodejs.org/api/http.html#servercloseallconnections' },
      { title: 'Health Checks and Graceful Shutdown | Express', url: 'https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html' },
      { title: 'Process: Signal events | Node.js v22 Documentation', url: 'https://nodejs.org/api/process.html#signal-events' },
      { title: 'godaddy/terminus: graceful shutdown and health checks for Node.js', url: 'https://github.com/godaddy/terminus' },
      { title: 'Pod Lifecycle: Termination of Pods | Kubernetes', url: 'https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination' },
    ],
    content('search-websummary'),
  );
  await s.fetch('https://nodejs.org/api/http.html#serverclosecallback', 'What do server.close, closeIdleConnections and closeAllConnections do, and since which versions?', content('search-fetch-node'));
  await s.fetch('https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html', 'What does Express recommend for graceful shutdown?', content('search-fetch-express'));
  await s.read('src/main.ts', C.MAIN_TS);
  await s.say(content('search-answer'));
  s.finish({ suggestion: 'Apply the shutdown handler to src/main.ts and add a readiness endpoint' });
};

// ─────────────────────────────── 6. markdown showcase ───────────────────────────

const markdown: Scenario = async ({ s }) => {
  await s.think(
    'An overview of the auth layer should cover the components, the request flow, the public error codes and the trade-offs, with real snippets from `session.ts` and the middleware. A Locust script is a useful extra for load-testing the hot path.',
  );
  await s.say(content('markdown-showcase'));
  s.finish({ suggestion: 'Save this as docs/auth.md in the repo' });
};

// ──────────────────────────────────── 7. errors ─────────────────────────────────

const MIGRATE_FAIL_STDERR = [
  'Error: connect ECONNREFUSED 127.0.0.1:5432',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16) {',
  '  errno: -111,',
  "  code: 'ECONNREFUSED',",
  "  syscall: 'connect',",
  "  address: '127.0.0.1',",
  '  port: 5432',
  '}',
].join('\n');

const MIGRATE_HEAD: OutLine[] = [
  ['', 40],
  ['> relay-api@0.9.2 migrate', 30],
  ['> node-pg-migrate up', 30],
  ['', 900],
];

const errors: Scenario = async ({ s, prompt }) => {
  const failHard = /fail\s*hard/i.test(prompt);
  s.activity('Waiting for the API');
  s.notice('retry', 'API overloaded · retrying in 2s (attempt 1 of 10)', '529 overloaded_error');
  await s.pause(2000);
  await s.think('I need to apply the pending migrations. `package.json` has a `migrate` script wrapping `node-pg-migrate up`, so I\'ll run that.');
  await s.say("I'll run the pending database migrations.");
  await s.bash('npm run migrate', { description: 'Apply database migrations', key: 'npm run', lines: MIGRATE_HEAD, exitCode: 1, stderr: MIGRATE_FAIL_STDERR });

  if (failHard) {
    await s.think('Postgres refused the connection. Before going further I should check whether the container is running.');
    s.activity('Waiting for the API');
    s.notice('retry', 'API overloaded · retrying in 4s (attempt 2 of 10)', '529 overloaded_error');
    await s.pause(4000);
    s.notice('retry', 'API overloaded · retrying in 8s (attempt 3 of 10)', '529 overloaded_error');
    await s.pause(8000);
    const error = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    s.notice('error', 'Request failed after 3 attempts', error);
    s.finish({ error });
    return { error };
  }

  await s.think(
    "`ECONNREFUSED 127.0.0.1:5432` means nothing is listening on the Postgres port. It's not a credentials or schema problem. The repo has a `docker-compose.yml`, so the database is probably just not running. I'll check the container state before changing anything.",
  );
  await s.bash('docker compose ps', { description: 'Check running containers', readonly: true, lines: [['NAME      IMAGE     COMMAND   SERVICE   CREATED   STATUS    PORTS', 400]] });
  await s.say('The Postgres container isn’t running. Starting it, then retrying the migrations.');
  await s.bash('docker compose up -d postgres', {
    description: 'Start the Postgres container',
    key: 'docker compose',
    lines: [
      ['[+] Running 2/2', 900],
      [' ✔ Network relay-api_default       Created                              0.1s', 300],
      [' ✔ Container relay-api-postgres-1  Started                              0.6s', 700],
    ],
  });
  await s.bash('npm run migrate', {
    description: 'Apply database migrations',
    key: 'npm run',
    lines: [
      ...MIGRATE_HEAD,
      ['> Migrating files:', 60],
      ['> - 1731412800000_add-sessions-table', 40],
      ['> - 1731499200000_add-user-roles', 40],
      ['### MIGRATION 1731412800000_add-sessions-table (UP) ###', 300],
      ['CREATE TABLE "sessions" (', 20],
      ['  "id" text PRIMARY KEY,', 20],
      ['  "user_id" text NOT NULL REFERENCES "users" ON DELETE CASCADE,', 20],
      ['  "created_at" timestamptz NOT NULL DEFAULT now(),', 20],
      ['  "expires_at" timestamptz NOT NULL,', 20],
      ['  "revoked" boolean NOT NULL DEFAULT false', 20],
      [');', 20],
      ['CREATE INDEX "sessions_expires_at_index" ON "sessions" ("expires_at");', 20],
      ['INSERT INTO "public"."pgmigrations" (name, run_on) VALUES (\'1731412800000_add-sessions-table\', NOW());', 200],
      ['', 20],
      ['### MIGRATION 1731499200000_add-user-roles (UP) ###', 300],
      ['ALTER TABLE "users"', 20],
      ['  ADD "roles" text[] DEFAULT \'{}\' NOT NULL;', 20],
      ['CREATE INDEX "users_roles_index" ON "users" USING gin ("roles");', 20],
      ['INSERT INTO "public"."pgmigrations" (name, run_on) VALUES (\'1731499200000_add-user-roles\', NOW());', 200],
      ['', 20],
      ['', 20],
      ['Migrations complete!', 40],
    ],
  });
  await s.say(content('error-summary'));
  s.finish({ suggestion: 'Add a db:up script so npm run dev starts Postgres automatically' });
};

// ─────────────────────────────────── 8. MCP + skill ─────────────────────────────

const mcp: Scenario = async ({ s }) => {
  await s.think(
    "The GitHub MCP server is connected, so I can search issues directly instead of asking for links. Then the project's `changelog` skill defines the entry format, and I should load it rather than guess the conventions.",
  );
  await s.mcp(
    'github',
    'search_issues',
    { query: 'repo:relay-labs/relay-api is:issue is:open session', per_page: 5 },
    {
      total_count: 3,
      items: [
        { number: 214, title: 'Session map grows until restart', state: 'open', labels: ['bug', 'auth'], comments: 4, updated_at: '2026-11-10T09:12:44Z' },
        { number: 209, title: 'Admin 403 returns { message } instead of { error }', state: 'open', labels: ['api'], comments: 1, updated_at: '2026-11-03T16:40:02Z' },
        { number: 188, title: 'Expose active session count per user', state: 'open', labels: ['enhancement'], comments: 0, updated_at: '2026-10-21T11:05:37Z' },
      ],
    },
    { title: 'Search GitHub issues' },
  );
  await s.mcp(
    'github',
    'get_issue',
    { owner: 'relay-labs', repo: 'relay-api', issue_number: 214 },
    {
      number: 214,
      title: 'Session map grows until restart',
      user: 'mkovacs',
      body: 'Heap snapshots on prod show the sessions Map holding ~180k entries after a week. Most are long expired. /admin/sessions reports the same inflated number. We only reject expired sessions in requireAuth; nothing ever deletes them.',
      labels: ['bug', 'auth'],
      assignees: [],
      comments: [
        { user: 'jtan', body: 'Confirmed locally. Memory grows ~40 MB/day at current traffic.' },
        { user: 'mkovacs', body: 'Evicting on lookup would handle most of it; a periodic sweep would catch the rest.' },
      ],
    },
    { title: 'Read issue #214' },
  );
  await s.skill(
    'changelog',
    'Draft an Unreleased entry for the session expiry refactor',
    'Loaded skill “changelog” from .claude/skills/changelog/SKILL.md\n\n- Keep a Changelog 1.1 format; newest first\n- Group under Added / Changed / Deprecated / Removed / Fixed / Security\n- One line per change, user-facing wording, reference issues as (#123)\n- Only include changes that are merged or in the working tree',
  );
  await s.say(content('mcp-answer'));
  s.finish({ suggestion: 'Add the entry to CHANGELOG.md and comment on #214 that it is fixed' });
};

// ─────────────────────────────────── 10. long / stress ──────────────────────────

const long: Scenario = async ({ s }) => {
  await s.think(
    'A full handbook: architecture first, then each module in request order, then testing, local setup, deployment and the operational knowledge that is not written down anywhere. Code snippets have to match the current sources.',
  );
  await s.say(content('long-stress'));
  s.finish({ suggestion: 'Split the handbook into docs/ pages and link them from the README' });
};

// ─────────────────────────────── stress: many steps, a huge answer ───────────────────────────────

/**
 * 300 steps in quick succession (reads, searches, edits, commands, a note every 25), for checking
 * that a long trail scrolls smoothly and memory stays flat. Fast on purpose: no streamed inputs.
 */
const marathon: Scenario = async ({ s }) => {
  await s.say('Going through every module once, file by file.');
  const files = C.FILES.filter((f) => f.endsWith('.ts'));
  for (let i = 0; i < 300; i++) {
    const rel = files[i % files.length];
    const k = i % 6;
    const kind: ToolItem['kind'] = k === 0 || k === 3 ? 'read' : k === 1 ? 'search' : k === 2 || k === 4 ? 'edit' : 'bash';
    const src = C.SOURCES[rel] ?? `// ${rel}\n`;
    const title = kind === 'read' ? `Read ${rel.split('/').pop()}` : kind === 'search' ? `Search for step${i}` : kind === 'edit' ? `Edit ${rel.split('/').pop()}` : 'Run the type checker';
    const detail = kind === 'bash' ? { command: 'npx tsc --noEmit' } : kind === 'search' ? { pattern: `step${i}`, path: s.abs('src') } : { path: s.abs(rel) };
    const id = s.rt.add<ToolItem>({ type: 'tool', name: kind, kind, title, status: 'running', detail, input: {} }).id;
    await s.sleep(6);
    if (kind === 'read') s.complete(id, { file: { path: s.abs(rel), content: src, numLines: src.split('\n').length } });
    else if (kind === 'search') s.complete(id, { count: i % 4, files: files.slice(0, i % 4).map((f) => s.abs(f)) });
    else if (kind === 'edit') s.complete(id, { diff: [makeFileDiff(rel, src, `${src}\n// step ${i}\n`)] });
    else s.complete(id, { text: '', exitCode: 0 });
    if (i % 25 === 24) s.rt.add<TextItem>({ type: 'text', text: `Done with ${i + 1} steps so far; nothing unexpected.`, streaming: false });
    await s.sleep(10);
  }
  await s.say('All 300 steps are done and the type checker is clean.');
  s.finish({});
};

/** A 4000-line answer streamed in quickly: long-transcript rendering, scrolling and memory. */
const tome: Scenario = async ({ s }) => {
  const parts: string[] = [];
  for (let i = 1; parts.length < 4000; i++) {
    parts.push(`## Section ${i}`, '');
    for (let j = 0; j < 6; j++) parts.push(`Line ${parts.length + 1}: the session store keeps entries in a map keyed by token and evicts expired ones on lookup, so memory stays bounded.`);
    parts.push('', '- one point about the module', '- another point, with `inline code`', '');
    if (i % 5 === 0) parts.push('```ts', 'const store = new SessionStore({ ttlMs: 1_000 });', "store.create('u_1');", '```', '');
  }
  const text = parts.join('\n');
  const item = s.rt.add<TextItem>({ type: 'text', text: '', streaming: true });
  for (let i = 0; i < text.length; i += 900) {
    s.rt.delta(item.id, 'text', text.slice(i, i + 900));
    await s.sleep(16);
  }
  s.rt.patch<TextItem>(item.id, { streaming: false });
  s.finish({});
};

// ─────────────────────────────────── 11. greeting ───────────────────────────────

const greeting: Scenario = async ({ s }) => {
  await s.say(
    "Hi, I'm set up in `relay-api` and can see the Express app, the session store and the auth middleware. What would you like to work on?",
  );
  s.finish({ suggestion: 'Refactor the session expiry logic out of the auth middleware' });
};

// ─────────────────────────────────── 9. commands ────────────────────────────────

function contextReport(s: Script, model: string): string {
  const b = contextBreakdown(s.contextTokens, s.rt.meta.usage.turns, model);
  const rows = b.categories.map((c) => `| ${c.name} | ${k(c.tokens)} | ${((c.tokens / b.maxTokens) * 100).toFixed(1)}% |`);
  return [`**${model}** · ${k(b.totalTokens)} / ${k(b.maxTokens)} tokens (${b.percent}%)`, '', '| Category | Tokens | Share |', '|---|---:|---:|', ...rows].join('\n');
}

function costReport(s: Script): string {
  const u = s.rt.meta.usage;
  return [
    '| | |',
    '|---|---|',
    `| Total cost | $${(u.costUsd ?? 0).toFixed(4)} |`,
    `| Input tokens | ${fmt(u.inputTokens)} fresh · ${fmt(u.cacheReadTokens ?? 0)} cached |`,
    `| Output tokens | ${fmt(u.outputTokens)} |`,
    `| Turns | ${u.turns} |`,
    `| Context | ${k(u.contextTokens ?? BASE_CONTEXT)} / ${k(u.contextWindow ?? 200_000)} |`,
  ].join('\n');
}

const FLAGSHIP_DIFFS = () => [
  makeFileDiff('src/auth/middleware.ts', C.MIDDLEWARE_TS, C.MIDDLEWARE_TS_FIXED),
  makeFileDiff('src/server/session.ts', C.SESSION_TS, C.SESSION_TS_AFTER),
];

function diffStat(): OutLine[] {
  const diffs = FLAGSHIP_DIFFS();
  const width = Math.max(...diffs.map((d) => d.path.length));
  const max = Math.max(...diffs.map((d) => d.additions + d.deletions));
  const rows = diffs.map((d): OutLine => {
    const n = d.additions + d.deletions;
    const scale = Math.min(1, 40 / max);
    const plus = '+'.repeat(Math.round(d.additions * scale));
    const minus = '-'.repeat(Math.round(d.deletions * scale));
    return [` ${d.path.padEnd(width)} | ${String(n).padStart(2)} ${plus}${minus}`, 20];
  });
  const add = diffs.reduce((n, d) => n + d.additions, 0);
  const del = diffs.reduce((n, d) => n + d.deletions, 0);
  return [...rows, [` ${diffs.length} files changed, ${add} insertions(+), ${del} deletions(-)`, 20]];
}

const review: Scenario = async ({ s }) => {
  await s.bash('git status --short', { description: 'List changed files', readonly: true, lines: [' M src/auth/middleware.ts', ' M src/server/session.ts'] });
  await s.bash('git diff --stat', { description: 'Summarize the diff', readonly: true, lines: diffStat() });
  await s.readMany([
    { rel: 'src/server/session.ts', content: C.SESSION_TS_AFTER },
    { rel: 'src/auth/middleware.ts', content: C.MIDDLEWARE_TS_FIXED },
  ]);
  const afterRefactor = { ...C.SOURCES, 'src/server/session.ts': C.SESSION_TS_AFTER, 'src/auth/middleware.ts': C.MIDDLEWARE_TS_FIXED };
  await s.grep('sessions\\.get\\(', C.grep(/sessions\.get\(/, '', afterRefactor));
  await s.think(
    '`validate()` is correct, and the error-code table keeps the contract. The remaining risks are API-shape issues: `validate` has a side effect its name hides, `get()` still bypasses expiry, and the revoked path is untested.',
  );
  await s.say(content('review'));
  s.finish({ suggestion: 'Add the session_revoked test from the review' });
};

const init: Scenario = async ({ s }) => {
  await s.glob('**/*', C.FILES);
  await s.readMany([
    { rel: 'package.json', content: C.PACKAGE_JSON },
    { rel: 'src/app.ts', content: C.APP_TS },
  ]);
  await s.write('CLAUDE.md', content('init-claude-md') + '\n', { description: 'Project notes for future sessions' });
  await s.say(content('init-summary'));
  s.finish({ suggestion: 'Add a section on the release process to CLAUDE.md' });
};

const prComments: Scenario = async ({ s }) => {
  await s.bash('gh pr view --json number,title,headRefName', {
    description: 'Find the current pull request',
    readonly: true,
    lines: ['{"headRefName":"refactor/session-expiry","number":231,"title":"Move session expiry into SessionStore"}'],
  });
  await s.mcp(
    'github',
    'list_pull_request_comments',
    { owner: 'relay-labs', repo: 'relay-api', pull_number: 231 },
    [
      { user: 'jtan', path: 'src/server/session.ts', line: 52, body: 'validate() renews the session. Can we make that obvious from the name or a doc comment?' },
      { user: 'jtan', path: 'src/auth/middleware.ts', line: 7, body: 'Nice, pinning the codes here is exactly right.' },
      { user: 'mkovacs', path: 'tests/auth.test.ts', line: null, body: 'Missing a session_revoked case.' },
    ],
    { title: 'Read PR #231 comments' },
  );
  await s.say(
    [
      '**PR #231 · Move session expiry into SessionStore** has 3 review comments, and two need action:',
      '',
      '1. **@jtan on `src/server/session.ts:52`**: `validate()` renewing the session is a hidden side effect. A doc comment covers it, or a rename to `validateAndRenew()` if you prefer an explicit name.',
      '2. **@mkovacs on `tests/auth.test.ts`**: add a `session_revoked` test.',
      '3. @jtan approved the `FAILURE_CODES` table. No action needed.',
      '',
      'Both actionable items are small. Want me to address them and push to `refactor/session-expiry`?',
    ].join('\n'),
  );
  s.finish({ suggestion: 'Address both comments and push' });
};

const deployCheck: Scenario = async ({ s }) => {
  await s.todos(
    todoList(
      [
        ['Typecheck', 'Typechecking'],
        ['Run tests', 'Running tests'],
        ['Check pending migrations', 'Checking migrations'],
        ['Verify required env vars are documented', 'Checking env vars'],
      ],
      ['in_progress'],
    ),
  );
  await s.bash('npm run build', { description: 'Typecheck and compile', key: 'npm run', lines: [['', 40], ['> relay-api@0.9.2 build', 30], ['> tsc -p tsconfig.json', 30], ['', 2600]] });
  await s.bash('npm test', { description: 'Run the test suite', lines: vitestPass(s.cwd, BASE_TEST_FILES) });
  await s.bash('npx node-pg-migrate up --dry-run', {
    description: 'List pending migrations',
    key: 'npx node-pg-migrate',
    lines: [['> Migrating files:', 900], ['No migrations to run!', 60]],
  });
  await s.grep('process\\.env', ['src/lib/config.ts:14:const env = ConfigSchema.parse(process.env);'], { path: 'src' });
  await s.todos(
    todoList(
      [
        ['Typecheck', 'Typechecking'],
        ['Run tests', 'Running tests'],
        ['Check pending migrations', 'Checking migrations'],
        ['Verify required env vars are documented', 'Checking env vars'],
      ],
      ['completed', 'completed', 'completed', 'completed'],
    ),
  );
  await s.say(
    [
      '**Ready to deploy.**',
      '',
      '| Check | Result |',
      '|---|---|',
      '| Typecheck | ✅ clean |',
      '| Tests | ✅ 25/25 |',
      '| Migrations | ✅ none pending |',
      '| Env vars | ✅ all read through `src/lib/config.ts`, no direct `process.env` access |',
    ].join('\n'),
  );
  s.finish();
};

function helpReport(): string {
  return [
    '**Commands**',
    '',
    ...COMMANDS.map((c) => `- \`/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}\`: ${c.description}${c.source ? ` *(${c.source})*` : ''}`),
    '',
    '**Skills**',
    '',
    ...SKILLS.filter((x) => x.enabled !== false).map((x) => `- \`/${x.name}\`: ${x.description}`),
  ].join('\n');
}

async function skillCommand(s: Script, name: string, args: string) {
  const skill = SKILLS.find((x) => x.name === name)!;
  await s.skill(name, args || undefined, `Loaded skill “${name}”${skill.path ? ` from ${skill.path}` : ''}\n\n${skill.description}.`);
  await s.say(skill.followup);
  s.finish();
}

/** Slash commands: built-ins, project/user commands and skills; anything else is an error notice. */
export const command: Scenario = async (ctx) => {
  const { s, prompt, model } = ctx;
  const [head, ...rest] = prompt.trim().slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const args = rest.join(' ');
  switch (name) {
    case 'compact': {
      s.activity('Compacting conversation');
      await s.pause(1200, 1800);
      const before = s.contextTokens;
      const after = Math.round(BASE_CONTEXT + Math.min(9_000, Math.max(1_200, (before - BASE_CONTEXT) * 0.18)));
      s.setContext(Math.min(before, after));
      s.notice(
        'compact',
        'Conversation compacted',
        `Summarized ${fmt(before)} → ${fmt(Math.min(before, after))} tokens. Earlier turns are replaced by a summary; open files and todos are kept.${args ? `\n\nFocus: ${args}` : ''}`,
      );
      return;
    }
    case 'context':
      s.notice('command', 'Context usage', contextReport(s, model));
      return;
    case 'cost':
      s.notice('command', 'Session cost', costReport(s));
      return;
    case 'help':
      s.notice('command', 'Available commands', helpReport());
      return;
    case 'review':
      return review(ctx);
    case 'init':
      return init(ctx);
    case 'pr-comments':
      return prComments(ctx);
    case 'deploy-check':
      return deployCheck(ctx);
  }
  if (SKILLS.some((x) => x.name === name)) return skillCommand(s, name, args);
  s.notice('error', `Unknown command: /${head}`, 'Type / to see the available commands and skills.');
};

/** Code blocks that can be previewed: an HTML snippet and an SVG icon. */
const previews: Scenario = async ({ s }) => {
  await s.say(
    [
      'A small status badge for the admin page:',
      '',
      '```html',
      '<div style="display:flex;gap:10px;align-items:center;font:13px system-ui">',
      '  <span style="width:8px;height:8px;border-radius:50%;background:#4ade80"></span>',
      '  <strong>relay-api</strong>',
      '  <span style="color:#999">all checks passing · 25 tests</span>',
      '</div>',
      '```',
      '',
      'And the icon for the sessions tab:',
      '',
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#e8e6e1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
      '  <rect x="3" y="4" width="18" height="14" rx="2"/>',
      '  <path d="M7 9h10M7 13h6"/>',
      '</svg>',
      '```',
    ].join('\n'),
  );
  s.finish({});
};

/** A widget as real agents deliver it: some seconds of thinking, then the whole call at once. */
const arrive: Scenario = async ({ s }) => {
  await s.think('Latency per route for the last day against the 300 ms budget. A bar per route reads faster than a table.');
  await s.pause(1800, 2400);
  await s.widget('Latency by route', W.LATENCY_WIDGET, { whole: true });
  await s.say('Two routes are over budget at p95; the Stripe webhook is the one to fix first.');
  s.finish({});
};

/**
 * Works the page the Browser tab shows through the real tools: outline, type into the first field,
 * click the first button, wait, read what changed, then the console and a small script.
 */
async function browserWork(s: Parameters<Scenario>[0]['s']) {
  const snap = await s.browser('snapshot', {});
  if (!snap.ok) {
    await s.say(`I could not get the page's outline: ${snap.text}`);
    return s.finish({});
  }
  const field = /^\[(e\d+)\] (?:textbox|searchbox)(?: "([^"]*)")?/m.exec(snap.text);
  const button = /^\[(e\d+)\] button(?: "([^"]*)")?/m.exec(snap.text);
  const did: string[] = [];
  if (field) {
    const typed = await s.browser('type', { ref: field[1], text: /mail/i.test(field[2] ?? '') ? 'sable@example.com' : 'Sable' });
    did.push(typed.ok ? `typed into ${field[2] ? `**${field[2]}**` : 'the first field'}` : `could not type (${typed.text})`);
  }
  if (button) {
    const clicked = await s.browser('click', { ref: button[1] });
    did.push(clicked.ok ? `clicked ${button[2] ? `**${button[2]}**` : 'the first button'}` : `could not click (${clicked.text})`);
  }
  await s.browser('wait', { timeout: 3000 });
  const read = await s.browser('read', {});
  const logs = await s.browser('logs', { kind: 'console' });
  await s.browser('logs', { kind: 'network' });
  const count = await s.browser('eval', { script: 'return document.querySelectorAll("*").length' });
  const lines = logs.ok ? logs.text.split('\n').filter((l) => l.startsWith('- ')).length : 0;
  const elements = count.ok ? /<untrusted_page_data>\n(\d+)/.exec(count.text)?.[1] : undefined;
  await s.say(
    [
      did.length ? `I ${did.join(' and ')}.` : 'The page has no field or button to try.',
      read.ok ? 'The page text after that is in the read step.' : `Reading it afterwards failed: ${read.text}`,
      logs.ok ? (lines ? `The console has ${lines} line${lines === 1 ? '' : 's'}.` : 'The console is empty.') : '',
      elements ? `The document has ${elements} elements.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  s.finish({});
}

/** The tools the short run leaves out: a refused password field, a key press, scrolling, a link by its text, back and reload. */
async function browserTour(s: Parameters<Scenario>[0]['s']) {
  const snap = await s.browser('snapshot', {});
  if (!snap.ok) {
    await s.say(`I could not get the page's outline: ${snap.text}`);
    return s.finish({});
  }
  const notes: string[] = [];
  const secret = /^\[(e\d+)\] password field/m.exec(snap.text);
  if (secret) {
    const r = await s.browser('type', { ref: secret[1], text: 'not-a-real-password' });
    notes.push(r.ok ? 'The password field was typed into, which must not happen.' : 'The password field was refused, as it should be.');
  }
  const field = /^\[(e\d+)\] (?:textbox|searchbox)(?: "([^"]*)")?/m.exec(snap.text);
  if (field) {
    await s.browser('type', { ref: field[1], text: /mail/i.test(field[2] ?? '') ? 'keys@example.com' : 'Keys' });
    const pressed = await s.browser('press', { key: 'Enter' });
    notes.push(pressed.ok ? 'Pressed Enter in the field.' : `The key press failed: ${pressed.text}`);
    await s.browser('wait', { timeout: 2000 });
    await s.browser('read', {});
  }
  await s.browser('scroll', { to: 'bottom' });
  const link = /^\[e\d+\] link "([^"]*)"/m.exec(snap.text);
  if (link) {
    const went = await s.browser('click', { text: link[1] });
    notes.push(went.ok ? `Followed **${link[1]}**.` : `The link did not work: ${went.text}`);
    const back = await s.browser('navigate', { action: 'back' });
    notes.push(back.ok ? 'Went back.' : `Going back failed: ${back.text}`);
  }
  const reload = await s.browser('navigate', { action: 'reload' });
  notes.push(reload.ok ? 'Reloaded the page.' : `The reload failed: ${reload.text}`);
  await s.say(notes.join(' '));
  s.finish({});
}

/**
 * "log into the portal": the agent works a made-up school portal served on this machine
 * (demo-portal.ts). It opens it, outlines it, signs in with browser_sign_in (the card the first
 * time, a saved sign-in after), then clicks a course, types into the search, presses Find and
 * scrolls, so the pointer and the sign-in can be watched and filmed.
 */
const signin: Scenario = async ({ s }) => {
  // While sign-ins do not ship, the made-up portal is signed into with plain typing (a made-up password
  // in a text field drawn as dots: a demo page, no secret), so the pointer can still be seen.
  const ships = signInShips();
  const url = (await demoPortal()) + (ships ? '' : '?typing');
  await s.think('Open the portal in the Browser tab, sign in there, then find the maths course.');
  const opened = await s.browser('open', { url });
  if (!opened.ok) {
    await s.say(`The portal did not open: ${opened.text}`);
    return s.finish({});
  }
  const snap = await s.browser('snapshot', {});
  const user = /^\[(e\d+)\] textbox "User name"/m.exec(snap.text)?.[1];
  const pass = (ships ? /^\[(e\d+)\] password field/m : /^\[(e\d+)\] textbox "Password"/m).exec(snap.text)?.[1];
  const submit = /^\[(e\d+)\] button "Sign in"/m.exec(snap.text)?.[1];
  if (!user || !pass) {
    await s.say('The portal shows no sign-in form.');
    return s.finish({});
  }
  let signed: { ok: boolean; text: string };
  if (ships) signed = await s.browser('sign_in', { username_ref: user, password_ref: pass, ...(submit ? { submit_ref: submit } : {}) });
  else {
    await s.browser('type', { ref: user, text: 'student.one' });
    await s.browser('type', { ref: pass, text: 'made-up-pass' });
    const clicked = submit ? await s.browser('click', { ref: submit }) : await s.browser('press', { key: 'Enter' });
    await s.browser('wait', { selector: '#home', timeout: 3000 });
    signed = clicked.ok ? { ok: true, text: 'Signed in on the portal as student.one. Sable filled' } : { ok: false, text: clicked.text };
  }
  if (!signed.ok) {
    await s.say(`I did not sign in: ${signed.text.replace(/^Not signed in: /, '')}`);
    return s.finish({});
  }
  const home = await s.browser('snapshot', {});
  const course = /^\[(e\d+)\] button "Mathematics 10b[^"]*"/m.exec(home.text)?.[1];
  const find = /^\[(e\d+)\] textbox "Find a course"/m.exec(home.text)?.[1];
  const go = /^\[(e\d+)\] button "Find"/m.exec(home.text)?.[1];
  if (find) await s.browser('type', { ref: find, text: 'Mathematics' });
  if (go) await s.browser('click', { ref: go });
  if (course) await s.browser('click', { ref: course });
  await s.browser('scroll', { by: 420 });
  await s.browser('scroll', { to: 'top' });
  const who = /as (.+?)\. Sable filled/.exec(signed.text)?.[1];
  await s.say(`Signed in${who ? ` as **${who}**` : ''} and opened **Mathematics 10b**: it has 3 new tasks.`);
  s.finish({});
};

/**
 * The Browser tab tools: open a local page (an address in the prompt, else the one the Browser tab
 * already shows, else localhost:3000), read it and take a screenshot, through the real tools' path.
 */
const browser: Scenario = async ({ s, item }) => {
  const own = stripBrowserLine(item.text);
  const asked = /\bhttps?:\/\/[^\s"'<>]+/i.exec(own)?.[0];
  const shown = browserLineUrl(item.text);
  const url = asked ?? (shown ? undefined : 'http://localhost:3000/');
  await s.think(url ? `Open ${url} in the Browser tab, then read it and look at it.` : `The Browser tab already shows ${shown}. Read it, then look at it.`);
  if (url) {
    const opened = await s.browser('open', { url });
    if (!opened.ok) {
      await s.say(`The page did not open: ${opened.text}`);
      return s.finish({});
    }
  }
  // "click", "type", "try", "use", "form": work the page instead of only looking at it.
  const words = own.replace(/https?:\/\/\S+/g, '');
  // "tour": the rest of the tools (keys, scrolling, history, a field Sable will not type into).
  if (/\btour\b/i.test(words)) return browserTour(s);
  if (/\b(click|type|fill|try|use|form|press|work)\b/i.test(words)) return browserWork(s);
  const read = await s.browser('read', {});
  if (!read.ok) {
    await s.say(`I could not read the page: ${read.text}`);
    return s.finish({});
  }
  const shot = await s.browser('screenshot', {});
  const errors = /\((\d+) errors?,/.exec(read.text)?.[1] ?? '0';
  const failed = (read.text.split('Failed requests:')[1] ?? '').split('\n').filter((l) => l.startsWith('- ') && !l.includes('earlier entries')).length;
  const title = /^Title: (.*)$/m.exec(read.text)?.[1]?.trim();
  await s.say(
    [
      `The page${title ? ` **${title}**` : ''} loaded.`,
      errors !== '0' ? `The console shows ${errors} error${errors === '1' ? '' : 's'}.` : 'The console is clean.',
      failed ? `${failed} request${failed === 1 ? '' : 's'} failed.` : 'No requests failed.',
      shot.ok ? 'The screenshot is in the step above.' : `The screenshot did not work: ${shot.text}`,
    ].join(' '),
  );
  s.finish({});
};

/**
 * Before / after: a real page on a free local port (demo-site.ts), edited during the turn (its
 * heading and its accent colour), named in the answer. The first run starts the page, so Sable
 * captures the before as soon as the command prints the address; later runs in the same chat
 * start with the page known, so the before is taken as the turn starts.
 */
const beforeafter: Scenario = async ({ s }) => {
  const { site, fresh } = await demoSite(s.rt.id);
  const from = LOOKS[site.runs % LOOKS.length];
  const to = LOOKS[(site.runs + 1) % LOOKS.length];
  await s.think(`The status page: change the heading to "${to.heading}" and the accent to ${to.name}. Both live in two small files.`);
  if (fresh) {
    await s.bash(`npx serve site -l ${new URL(site.url).port}`, {
      description: 'Serve the status page',
      readonly: true,
      lines: [
        ['', 300],
        ['   Serving!', 200],
        ['', 40],
        [`   - Local:    ${site.url}`, 40],
        [`   - Network:  ${site.url.replace('localhost', '127.0.0.1')}`, 40],
        ['', 40],
      ],
    });
  }
  const html = site.read('index.html');
  const css = site.read('styles.css');
  await s.readMany([
    { rel: 'site/index.html', content: html },
    { rel: 'site/styles.css', content: css },
  ]);
  await s.think(`The heading is the h1 in index.html; the accent is one custom property in styles.css, used by the button and the figures.`);
  // An agent's pace: some seconds pass between finding the files and changing them.
  await s.pause(2600, 3200);
  const html2 = siteHtml(to);
  await s.edit('site/index.html', html, html2, { description: 'New heading' });
  site.write('index.html', html2);
  const css2 = siteCss(to);
  await s.edit('site/styles.css', css, css2, { description: `Accent ${from.name} to ${to.name}` });
  site.write('styles.css', css2);
  site.runs++;
  await s.say(`The heading now reads **${to.heading}** and the accent is ${to.name} (\`${to.accent}\`), on the button and the figures. The page is at ${site.url}`);
  s.finish({});
};

// ─────────────────────────────────── until green ──────────────────────────────────

/** The until-green project of this session (demo-until.ts), and its files as the agent names them. */
function untilProject(s: Script) {
  const f = untilFixture(s.rt.meta.cwd, s.rt.id, !!s.rt.meta.chat);
  const rel = (p: string) => path.relative(s.rt.meta.cwd, path.join(f.dir, p)).split(path.sep).join('/');
  return { f, rel };
}

/**
 * "until green": a small project whose tests fail (two source files, three bugs, a real check
 * script), written for real, so `/until node check.mjs` has something to loop on.
 */
const untilSetup: Scenario = async ({ s }) => {
  const { f, rel } = untilProject(s);
  const check = content('until-check');
  await s.think('A small project with a failing test run, so the loop has something to fix: two source files and a check that tests them.');
  seedUntilFixture(f, check);
  await s.write(rel('src/session.js'), SESSION_JS, { description: 'Session lifetime' });
  await s.write(rel('src/auth.js'), AUTH_JS, { description: 'Why a request is turned away' });
  await s.write(rel('check.mjs'), check, { description: 'The check' });
  await s.say(`Three tests fail in it right now. Arm the loop with \`/until ${f.command}\` and Sable runs the check after each of my turns until it passes.`);
  s.finish({ suggestion: `/until ${f.command}` });
};

/**
 * Sable's message for a failing check: the Demo fixes one file per turn (both session bugs, then
 * the auth one), for real, so the next check finds fewer failures and the third passes.
 */
const untilFix: Scenario = async ({ s }) => {
  const { f, rel } = untilProject(s);
  const session = f.read('src/session.js');
  const auth = f.read('src/auth.js');
  if (session && session !== SESSION_FIXED) {
    await s.think('Two expiry tests fail: the idle window is an hour instead of 30 minutes, and `refresh` writes `expires` where the tests read `expiresAt`.');
    await s.read(rel('src/session.js'), session);
    await s.pause(500, 900);
    await s.edit(rel('src/session.js'), session, SESSION_FIXED, { description: '30 minutes, and expiresAt' });
    f.write('src/session.js', SESSION_FIXED);
    await s.say('Fixed both expiry tests in `src/session.js`: the idle window is 30 minutes again, and `refresh` sets `expiresAt`, the field the tests and the middleware read.');
  } else if (auth && auth !== AUTH_FIXED) {
    await s.think('One left: a token no session has should be turned away as `invalid_session`, and `rejection` still says `session_missing`.');
    await s.read(rel('src/auth.js'), auth);
    await s.pause(400, 700);
    await s.edit(rel('src/auth.js'), auth, AUTH_FIXED, { description: 'invalid_session for unknown tokens' });
    f.write('src/auth.js', AUTH_FIXED);
    await s.say('`rejection` now answers `invalid_session` for a token no session has, as the auth test expects.');
  } else {
    await s.think('The check failed, but both files here already have their fixes.');
    await s.say('I cannot see what still fails: both fixes are in. The output above is all I have to go on.');
  }
  s.finish({});
};

// ──────────────────────── turn check ("Check with Codex") ────────────────────────

/** What the demo's files look like after its turns, for a check that reads them back. */
const CHECKED: Record<string, string> = {
  'src/server/session.ts': C.SESSION_TS_AFTER,
  'src/auth/middleware.ts': C.MIDDLEWARE_TS_FIXED,
  'src/auth/rate-limit.ts': C.RATE_LIMIT_TS,
  'src/server/routes.ts': C.ROUTES_TS_AFTER,
  'tests/rate-limit.test.ts': C.RATE_LIMIT_TEST_TS,
};

/**
 * A read-only review of another agent's turn (server/core/check.ts builds the brief): it reads the
 * changed files back, searches for their callers and answers with findings in the brief's form,
 * or "No problems found." The session refactor gets two findings; anything else passes.
 */
const turnCheck: Scenario = async ({ s, prompt }) => {
  const files = briefFiles(prompt);
  await s.think(
    `The brief lists ${files.length === 1 ? 'one changed file' : `${files.length} changed files`}. I'll read each as it is now, check the callers of anything whose behaviour changed, and only report what breaks: wrong results, lost behaviour, or a part of the request that is missing.`,
  );
  const known = files.filter((f) => CHECKED[f]).slice(0, 3);
  if (known.length) await s.readMany(known.map((rel) => ({ rel, content: CHECKED[rel] })));
  if (!files.includes('src/server/session.ts')) {
    const name = files.length ? path.basename(files[0], path.extname(files[0])) : '';
    if (name) await s.grep(name, C.grep(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'src/'), { path: 'src' });
    await s.think('Every change does what the request asked, and nothing that calls it depends on the old behaviour.');
    await s.say(NO_PROBLEMS);
    s.finish({});
    return;
  }
  await s.grep('validate\\(|expiresAt|session_expired', C.grep(/validate\(|expiresAt|session_expired/, 'src/'), { path: 'src' });
  await s.read('tests/auth.test.ts', C.AUTH_TEST_TS);
  await s.think(
    "`validate()` now deletes an expired session the first time it sees it. Before, the middleware only denied it, so every later request with that token still answered `session_expired`. Now the second request finds no session and answers `invalid_session`, which clients treat as a forged token, not as a reason to log in again. The other gap: the request asked for an injectable clock so expiry can be tested, but no test drives `validate()` with a fake clock.",
  );
  const evict = C.lineOf(C.SESSION_TS_AFTER, 'this.sessions.delete(id)');
  const validate = C.lineOf(C.SESSION_TS_AFTER, 'validate(id: string)');
  await s.say(
    [
      `- \`src/server/session.ts:${evict}\` Medium: An expired session is deleted on its first failed check, so the next request with the same token answers \`invalid_session\` instead of \`session_expired\` and clients stop prompting a fresh login.`,
      `- \`src/server/session.ts:${validate}\` Low: The clock was made injectable for tests, but no test drives \`validate()\` with a fake clock, so the expired and revoked paths are not covered.`,
    ].join('\n'),
  );
  s.finish({});
};

// ─────────────── progress: short reports between steps, a steer answered on the way ───────────────

const ADMIN_TS_AFTER = C.ADMIN_TS.replace("import type { SessionStore } from './session';", "import type { SessionStore } from './session';\nimport { HttpError } from './errors';").replace(
  "      return res.status(403).json({ message: 'Forbidden' });",
  "      throw new HttpError(403, 'forbidden');",
);

/**
 * A working turn written the way Claude writes one: a one-line lead-in before most steps ("Let me
 * read the handler."), a real report now and then (what it found, what passed), then the answer.
 * Long enough to steer into: a message sent while it works is answered at the next step, and the
 * work goes on.
 */
const progress: Scenario = async ({ s }) => {
  await s.think('Every error should leave through `errorHandler` as `{ error: code }`. First I will find each place that writes an error body by hand, then read the handler and those routes.');
  await s.say("I'll start by finding every place that writes an error body by hand.");
  await s.grep('res\\.status\\(\\d+\\)\\.json', C.grep(/res\.status\(\d+\)\.json/));
  await s.say('Let me read the error handler and the admin routes.');
  await s.readMany([
    { rel: 'src/server/errors.ts', content: C.ERRORS_TS },
    { rel: 'src/server/admin.ts', content: C.ADMIN_TS },
  ]);
  await s.pause(1800, 2400);
  await s.say("Found it: the admin guard answers `{ message: 'Forbidden' }`, a body no client can branch on. Let me check how the middleware and the routes build theirs.");
  await s.read('src/auth/middleware.ts', C.MIDDLEWARE_TS);
  await s.read('src/server/routes.ts', C.ROUTES_TS);
  await s.pause(1500, 2000);
  await s.think('The middleware already throws `HttpError` for missing and expired sessions, so the admin guard is the odd one out. A throw from an async handler reaches `errorHandler` through Express 5, which this project runs.');
  await s.say("Now I'll make the admin guard throw `HttpError` like the middleware does.");
  await s.edit('src/server/admin.ts', C.ADMIN_TS, ADMIN_TS_AFTER, { description: 'Throw HttpError(403) instead of writing the body by hand' });
  await s.pause(1200, 1600);
  await s.say('Now let me run the tests.');
  await s.bash('npm test', { description: 'Run the test suite', lines: vitestPass(s.cwd, BASE_TEST_FILES), activity: 'Running the test suite' });
  await s.say('The admin guard now answers like the rest, and the suite passes. The webhook path builds its own errors too, so let me check it.');
  await s.read('src/server/webhooks.ts', C.WEBHOOKS_TS);
  await s.pause(900, 1300);
  await s.say('Let me make sure nothing else builds an error by hand.');
  await s.grep('HttpError', C.grep(/HttpError/));
  await s.pause(1200, 1600);
  await s.say('Perfect. Let me run the type check.');
  await s.bash('npx tsc --noEmit', { description: 'Type-check the project', lines: [['', 3000]], activity: 'Type-checking' });
  await s.pause(800, 1200);
  await s.say(
    "Done. The admin guard was the only route writing its own error body: it now throws `HttpError(403, 'forbidden')`, so clients get `{ error: 'forbidden' }` like everywhere else. Webhooks already go through `errorHandler`. Tests and the type check pass.",
  );
  s.finish({});
};

// ─────────────────────────────── files handed over ───────────────────────────────

/** A one-page PDF in the base font: a title and a few lines. Small, valid, opens in any viewer. */
function tinyPdf(title: string, lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, '\\$&');
  const text = ['BT', '/F1 20 Tf', '56 740 Td', `(${esc(title)}) Tj`, '/F1 11 Tf', '0 -34 Td', ...lines.flatMap((l) => [`(${esc(l)}) Tj`, '0 -17 Td']), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objects.forEach((o, i) => {
    at.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const AUDIT_LINES = [
  'relay-api, auth path. 25 tests pass.',
  '',
  '1. Expiry is enforced in one place (SessionStore.validate). Fixed today.',
  '2. Login has no rate limit per account, only per address. Worth fixing this week.',
  '3. Cookies are httpOnly, secure and sameSite=lax. Fine.',
  '',
  'Latency of the auth path (p95): 4 ms for /me, 61 ms for /auth/login (password hashing).',
];

const LATENCY_CSV = [
  'route,requests,p50_ms,p95_ms,p99_ms',
  'GET /me,48210,1.2,4.1,7.9',
  'POST /auth/login,3120,44.0,61.3,88.2',
  'POST /auth/logout,2954,1.0,3.2,6.0',
  'GET /admin/sessions,212,2.8,9.4,15.1',
  'POST /webhooks/relay,9821,3.1,11.7,24.6',
  '',
].join('\n');

/**
 * The agent hands the person files (Claude Code's SendUserFile): an audit as a PDF and the raw
 * figures as CSV, written to a folder of their own (the chat's folder, or one under the system's
 * temporary folder, never the person's project), so Open and Show in folder work on real files.
 */
const share: Scenario = async ({ s }) => {
  const own = !!s.rt.meta.chat;
  const dir = own ? path.join(s.cwd, 'reports') : path.join(tmpdir(), 'sable-demo', s.rt.id.slice(0, 8), 'reports');
  await s.think('An audit of the auth path the person can keep: the findings as a one-page PDF, and the raw latencies behind them as CSV.');
  await s.readMany([
    { rel: 'src/server/session.ts', content: C.SESSION_TS },
    { rel: 'src/auth/middleware.ts', content: C.MIDDLEWARE_TS },
  ]);
  await s.bash('node scripts/audit.mjs --out reports', {
    description: 'Write the audit report',
    readonly: true,
    lines: [
      ['Measuring 5 routes over 64,317 requests', 400],
      ['Wrote reports/auth-audit.pdf', 220],
      ['Wrote reports/latency-by-route.csv', 120],
    ],
  });
  mkdirSync(dir, { recursive: true });
  const files = [
    { name: 'auth-audit.pdf', body: tinyPdf('Auth audit', AUDIT_LINES) },
    { name: 'latency-by-route.csv', body: Buffer.from(LATENCY_CSV) },
  ].map((f) => {
    const file = path.join(dir, f.name);
    writeFileSync(file, f.body);
    return { path: file, name: f.name, size: statSync(file).size };
  });
  const caption = 'The audit as a one-page PDF, and the latencies behind it.';
  const id = await s.tool({
    name: 'SendUserFile',
    kind: 'share',
    title: `${files.length} files`,
    detail: { files, caption },
    input: { files: files.map((f) => f.path), caption },
  });
  s.start(id);
  await s.pause(120, 200);
  s.complete(id, { text: `Sent ${files.length} files` });
  await s.say('Three findings, one worth fixing this week: login is rate limited per address but not per account. Expiry now lives in one place, and the cookie flags are right.');
  s.finish({ suggestion: 'Add a per-account login limit' });
};

// ─────────────────── what Claude Code writes in the person's place ───────────────────

/** A task notification in Claude Code's own words (read back by shared/synthetic.ts). */
function taskNote(o: { id: string; toolUseId: string; status: string; summary: string; outputFile?: string; result?: string; usage?: [tokens: number, tools: number, ms: number] }): string {
  return [
    '<task-notification>',
    `<task-id>${o.id}</task-id>`,
    `<tool-use-id>${o.toolUseId}</tool-use-id>`,
    ...(o.outputFile ? [`<output-file>${o.outputFile}</output-file>`] : []),
    `<status>${o.status}</status>`,
    `<summary>${o.summary}</summary>`,
    ...(o.result ? [`<result>${o.result}</result>`] : []),
    ...(o.usage ? [`<usage>total_tokens: ${o.usage[0]}\ntool_uses: ${o.usage[1]}\nduration_ms: ${o.usage[2]}</usage>`] : []),
    '</task-notification>',
  ].join('\n');
}

const REVIEW_RESULT = `Two findings worth fixing, one that is fine as it is.

1. **Login is rate limited per address, not per account.** \`src/auth/login.ts\` keys the limiter on \`req.ip\`; someone rotating addresses gets unlimited guesses at one account. Key it on the account as well.
2. **Expired sessions still count.** \`SessionStore.size\` includes sessions past their expiry until the sweep runs, so the admin page overstates active users.
3. Session expiry now lives in one place (\`src/auth/session.ts\`) and the cookie flags are right: \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\`.

Nothing else in the flow needs a change.`;

/**
 * Background work that finishes while the chat rests, and the commands the person runs in the
 * agent's own terminal, as Claude Code puts them in the conversation: user messages in its tags
 * (`<task-notification>`, `<command-name>`, `<local-command-stdout>`, a caveat, a reminder). The
 * window shows them as quiet lines (timeline/Synthetic.tsx); a notification opens the agent's next turn.
 */
const notifications: Scenario = async ({ s }) => {
  const tasks = path.join(tmpdir(), 'claude', 'relay-api', 'tasks');
  const out = (id: string) => path.join(tasks, `${id}.output`);
  await s.say("I'll build the installer and run the test suite in the background, and have an agent review the auth flow meanwhile.");
  const background = async (id: string, command: string, description: string) => {
    const t = await s.tool({ name: 'Bash', kind: 'bash', title: description, detail: { command, description, cwd: s.cwd }, input: { command, description, run_in_background: true } });
    s.start(t);
    await s.pause(120, 220);
    s.complete(t, { text: `Command running in background with ID: ${id}. Output is being written to: ${out(id)}` });
    return t;
  };
  const build = await background('b296xlpn0', 'npm run dist', 'Build the installer');
  const tests = await background('bq81k2m4c', 'npm test', 'Run the test suite');
  const spec = { subagent: 'general-purpose', description: 'Review the auth flow', prompt: 'Review the login and session code in src/auth for security and correctness problems. Report each finding with its file and a fix.', background: true };
  const review = await s.tool({ name: 'Task', kind: 'agent', title: spec.description, detail: spec, input: { subagent_type: spec.subagent, description: spec.description, prompt: spec.prompt, run_in_background: true } });
  s.start(review);
  s.complete(review, { agent: { background: 'running' } });
  await s.say('All three are running. I will pick each one up as it finishes.');
  s.finish();

  // Later, written in the person's place: each notification opens the agent's next turn.
  const arrive = (text: string) => s.rt.add<UserItem>({ type: 'user', text, state: 'sent' });
  await s.pause(1400, 1800);
  arrive(taskNote({ id: 'b296xlpn0', toolUseId: build, status: 'completed', summary: 'Background command "Build the installer" completed (exit code 0)', outputFile: out('b296xlpn0') }));
  await s.pause(400, 600);
  await s.say('The installer built cleanly: `release/Relay-Setup-2.4.0.exe`, 92 MB.');
  s.finish();

  // Two at once: the agent takes them up together.
  await s.pause(1600, 2000);
  arrive(taskNote({ id: 'a71c2e9f', toolUseId: review, status: 'completed', summary: 'Agent "Review the auth flow" completed', result: REVIEW_RESULT, usage: [48_210, 17, 124_500] }));
  s.patchTool(review, { result: { text: REVIEW_RESULT, agent: { background: 'done', tokens: 48_210, steps: 17, durationMs: 124_500 } } });
  await s.pause(150, 250);
  arrive(taskNote({ id: 'bq81k2m4c', toolUseId: tests, status: 'failed', summary: 'Background command "Run the test suite" failed with exit code 1', outputFile: out('bq81k2m4c') }));
  await s.pause(400, 600);
  await s.say('The review found two things worth fixing, and the test run failed on the second one: two tests in `tests/session.test.ts` count expired sessions. I will fix the expiry check first, then key the login limiter on the account.');
  s.finish({ suggestion: 'Fix the expiry check in SessionStore.size' });

  // The person switches the model and looks at the tree in the agent's own terminal.
  await s.pause(1200, 1500);
  arrive('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>');
  arrive('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>');
  arrive('<local-command-stdout>Set model to \u001b[1mOpus 5.5\u001b[22m</local-command-stdout>');
  await s.pause(700, 900);
  arrive('<bash-input>git status --short</bash-input>');
  arrive('<bash-stdout> M src/auth/login.ts\n M src/auth/session.ts\n M tests/session.test.ts\n?? release/\n?? docs/expiry.md</bash-stdout><bash-stderr></bash-stderr>');
  arrive('<system-reminder>\nThe user ran local commands in the terminal. Nothing to answer.\n</system-reminder>');
};

/**
 * Work that outlives its turn (day 7: "BITTE EIN INDIKATOR wenn du noch arbeitest auch subagents"):
 * a dev server and a test watcher in the background, a monitor on the build and a workflow. The turn
 * ends with all four at work; they end one by one while the chat rests, as the bridge marks them
 * (`ToolItem.task`, the workflow's own status): the test watcher's notification opens a short wake
 * turn, the workflow finishes, the monitor ends, and the dev server is stopped last, about a minute
 * after the turn. The conversation's tail must say what still works the whole time.
 */
const outlive: Scenario = async ({ s }) => {
  const tasks = path.join(tmpdir(), 'claude', 'relay-api', 'tasks');
  await s.say('I will start the dev server and the test watcher in the background, watch the build, and run the fixes as a workflow.');
  const command = async (taskId: string, cmd: string, description: string) => {
    const t = await s.tool({ name: 'Bash', kind: 'bash', title: description, detail: { command: cmd, description, cwd: s.cwd }, input: { command: cmd, description, run_in_background: true } });
    s.start(t);
    await s.pause(120, 220);
    s.complete(t, { text: `Command running in background with ID: ${taskId}. Output is being written to: ${path.join(tasks, `${taskId}.output`)}` });
    s.patchTool(t, { task: { id: taskId, kind: 'command', state: 'running', since: Date.now() } });
    return t;
  };
  const server = await command('b7dev01', 'pnpm dev', 'Start the dev server');
  s.patchTool(server, { output: 'Local: http://localhost:3311/\n' });
  const watcher = await command('b7tst02', 'pnpm test --watch', 'Watch the tests');
  const monitor = await s.tool({ name: 'Monitor', kind: 'other', title: 'Watch the build', detail: { description: 'Watch the build' }, input: { description: 'Watch the build' } });
  s.start(monitor);
  await s.pause(100, 160);
  s.complete(monitor, { text: 'Monitoring the build output.' });
  s.patchTool(monitor, { task: { id: 'm7bld03', kind: 'monitor', state: 'running', since: Date.now() } });
  const phases = [
    { title: 'Fix', detail: 'one agent per finding makes the change' },
    { title: 'Verify', detail: 'run the tests and review the diff' },
  ];
  const wf = await s.tool({ name: 'Workflow', kind: 'agent', title: 'Fix and verify the auth findings', detail: { subagent: 'Workflow', description: 'Fix and verify the auth findings', background: true }, input: {} });
  type Row = { index: number; label: string; phase: number; state: 'queued' | 'running' | 'done' | 'error'; startedAt?: number; tokens?: number; steps?: number; durationMs?: number; activity?: string };
  const rows: Row[] = [
    { index: 1, label: 'fix:limiter', phase: 1, state: 'running', startedAt: Date.now(), activity: 'Keying the limiter on the account' },
    { index: 2, label: 'fix:expiry', phase: 1, state: 'running', startedAt: Date.now(), activity: 'Fixing SessionStore.size' },
  ];
  const t0 = Date.now();
  const rt = s.rt;
  const push = (phase: number, status: 'running' | 'done' = 'running') =>
    rt.patch<ToolItem>(wf, {
      workflow: { name: 'auth-fixes', phases, phase, agents: rows.map((r) => ({ ...r })), status, tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0), steps: rows.reduce((n, r) => n + (r.steps ?? 0), 0), ...(status === 'done' ? { durationMs: Date.now() - t0 } : {}) },
      ...(status === 'done' ? { result: { text: 'Workflow launched in the background.', agent: { background: 'done' as const } } } : {}),
    });
  push(1);
  s.start(wf);
  await s.pause(200, 300);
  s.complete(wf, { text: 'Workflow launched in the background.', agent: { background: 'running' } });
  await s.say('All four are running: the dev server, the test watcher, the build monitor and the workflow. I will pick each one up as it finishes.');
  s.finish();

  // After the turn, on the bridge's own clock: the script is gone once this returns, so the runtime is written directly.
  const k = Math.max(0.05, Number(process.env.SABLE_DEMO_SPEED) || 1);
  const at = (ms: number, fn: () => void) =>
    setTimeout(() => {
      try {
        fn();
      } catch {
        /* the chat was closed or removed meanwhile */
      }
    }, ms / k).unref?.();
  const end = (id: string, state: 'done' | 'failed' | 'stopped') => {
    const it = rt.get<ToolItem>(id);
    if (it?.task?.state === 'running') rt.patch<ToolItem>(id, { task: { ...it.task, state, endedAt: Date.now() } });
  };
  at(9_000, () => {
    rows[0] = { ...rows[0], state: 'done', steps: 6, tokens: 21_400, durationMs: Date.now() - t0 };
    rows[1] = { ...rows[1], steps: 4, tokens: 14_000, activity: 'Running the session tests' };
    rows.push({ index: 3, label: 'verify', phase: 2, state: 'running', startedAt: Date.now(), activity: 'Reviewing the diff' });
    push(2);
  });
  at(16_000, () => {
    end(watcher, 'done');
    // Its notification wakes the agent: a short turn of its own, then the chat rests again.
    const wake = !rt.turnActive;
    if (wake) rt.beginTurn('Reading the test results', { keepHold: true });
    rt.add<UserItem>({ type: 'user', state: 'sent', text: taskNote({ id: 'b7tst02', toolUseId: watcher, status: 'completed', summary: 'Background command "Watch the tests" completed (exit code 0)', outputFile: path.join(tasks, 'b7tst02.output') }) });
    at(1_400, () => {
      rt.add<TextItem>({ type: 'text', text: 'The test watcher is done: 214 passed. The workflow and build monitor are still working. The dev server is serving localhost:3311.', streaming: false });
      if (wake) {
        rt.add<TurnItem>({ type: 'turn', durationMs: 1_400, stopReason: 'end_turn' });
        rt.endTurn();
      }
    });
  });
  at(28_000, () => {
    rows[1] = { ...rows[1], state: 'done', steps: 9, tokens: 26_000, durationMs: Date.now() - t0 };
    rows[2] = { ...rows[2], state: 'done', steps: 5, tokens: 18_200, durationMs: Date.now() - t0 };
    push(2, 'done');
  });
  at(40_000, () => end(monitor, 'done'));
  at(60_000, () => end(server, 'stopped'));
};

// ─────────────────────────────────── selection ──────────────────────────────────

export const SCENARIOS = {
  flagship,
  outlive,
  plan,
  questions,
  agents,
  crew,
  workflow,
  limited,
  fleet,
  search,
  markdown,
  errors,
  mcp,
  long,
  marathon,
  tome,
  progress,
  greeting,
  command,
  chart: W.chart,
  form: W.form,
  dashboard: W.dashboard,
  sandbox: W.sandbox,
  escape: W.escape,
  fence: W.fence,
  diagram: W.diagram,
  table: W.table,
  gallery: W.gallery,
  arrive,
  previews,
  share,
  browser,
  signin,
  beforeafter,
  untilSetup,
  untilFix,
  turnCheck,
  notifications,
} satisfies Record<string, Scenario>;
export type ScenarioId = keyof typeof SCENARIOS;

/** Rotation for prompts that match no keyword, so repeated prompts show different things. */
export const ROTATION: ScenarioId[] = ['flagship', 'agents', 'search', 'questions', 'mcp', 'markdown'];

const KEYWORDS: [RegExp, ScenarioId][] = [
  // Until green: Sable's message for a failing check, and the project to loop on (demo-until.ts).
  [/^The check `[^`]+` failed/, 'untilFix'],
  [/\buntil[\s-]+green\b/i, 'untilSetup'],
  // Background tasks finishing and local commands, as Claude Code writes them in the person's place.
  [/\bnotifications?\b/i, 'notifications'],
  // Work that goes on after its turn: background commands, a monitor, a workflow (day 7).
  [/\b(outlive|lingering)\b/i, 'outlive'],
  // Before / after captures of a local page (demo-site.ts).
  [/\bbefore\s*\/?\s*after\b|\bbeforeafter\b/i, 'beforeafter'],
  // Signing in on a page in the Browser tab, watched (demo-portal.ts): before the plain browser tools.
  [/\b(log\s?in|sign\s?in|mebis|portal)\b/i, 'signin'],
  // The Browser tab tools.
  [/\bbrowser\b/i, 'browser'],
  // Files handed to the person (SendUserFile): file cards.
  [/\b(share|shared|sharing)\b|\bsend me\b/i, 'share'],
  // Generative UI (demo-widgets.ts).
  [/\b(sandbox|hostile)\b/i, 'sandbox'],
  [/\b(whole|arrives?)\b/i, 'arrive'],
  [/\b(previews?|snippets?)\b/i, 'previews'],
  [/\bescape\b/i, 'escape'],
  [/\b(gallery|visuals)\b/i, 'gallery'],
  [/\b(charts?|graphs?|latency)\b/i, 'chart'],
  [/\b(forms?|options)\b/i, 'form'],
  [/\b(dashboard|tall)\b/i, 'dashboard'],
  [/\b(mermaid|diagrams?)\b/i, 'diagram'],
  [/\btables?\b/i, 'table'],
  [/\b(widgets?|explainer|simulation)\b/i, 'fence'],
  [/\bmarathon\b/i, 'marathon'],
  // Short reports between steps, and a turn long enough to steer into.
  [/\b(progress|reports?)\b/i, 'progress'],
  [/\btome\b/i, 'tome'],
  [/\b(long|stress)\b/i, 'long'],
  [/\b(markdown|showcase)\b/i, 'markdown'],
  [/\bmcp\b/i, 'mcp'],
  [/\b(crew|delegate)\b/i, 'crew'],
  [/\b(fleet|swarm)\b/i, 'fleet'],
  [/\bworkflows?\b/i, 'workflow'],
  [/\b(fable|limited)\b/i, 'limited'],
  [/\b(agents?|sub-?agents?|parallel|research)\b/i, 'agents'],
  [/\b(search|web|docs?|documentation)\b/i, 'search'],
  [/\b(questions?|ask|choose)\b/i, 'questions'],
  [/\bplan(ning)?\b/i, 'plan'],
  [/\berrors?\b|\bfail\s*hard\b/i, 'errors'],
  [/\b(refactor\w*|fix\w*)\b/i, 'flagship'],
];

const GREETING = /^\s*(hi|hello|hey|hiya|yo|good (morning|afternoon|evening))\b[\s!.,?\p{Emoji_Presentation}a-z]*$/iu;

export function pickScenario(prompt: string, mode: string, rotation: number): { id: ScenarioId; rotated: boolean } {
  const text = prompt.trim();
  if (text.startsWith('/')) return { id: 'command', rotated: false };
  // A turn check's brief (server/core/check.ts): a read-only review, in plan mode too.
  if (text.startsWith(CHECK_LEAD)) return { id: 'turnCheck', rotated: false };
  if (mode === 'plan') return { id: 'plan', rotated: false };
  for (const [re, id] of KEYWORDS) if (re.test(text)) return { id, rotated: false };
  if (GREETING.test(text) && text.split(/\s+/).length <= 4) return { id: 'greeting', rotated: false };
  return { id: ROTATION[rotation % ROTATION.length], rotated: true };
}
