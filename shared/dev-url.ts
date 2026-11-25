const ESC = '\u001b';
// CSI sequences, OSC sequences (terminated by BEL or ST) and lone two-byte escapes.
const ANY = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Applies carriage returns the way a terminal would: the text after the last one wins the line. */
function applyCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

function stripAnsi(text: string): string {
  const clean = applyCarriageReturns(text);
  return clean.includes(ESC) ? clean.replace(ANY, '') : clean;
}

/**
 * Dev-server addresses in command output: what a terminal run or an agent's command printed when it
 * started a local server (Vite's "Local:", Next's "- Local:", webpack's "Loopback:", Rails' "Listening
 * on", Django's "Starting development server at", Flask's "Running on", uvicorn, http.server…).
 * A line counts when it reads like a server's own announcement, or when the command itself starts a
 * server; error lines and HTTP clients (curl and friends) never count.
 */

export interface DevUrl {
  /** The address to open, as printed (0.0.0.0 and [::], which only bind, become localhost). */
  url: string;
  /** "localhost:5173": every loopback name reads as localhost. */
  label: string;
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|(?:[a-z0-9-]+\.)+localhost)(?::\d{1,5})?(?![\w:-]|\.[\w-])(?:[/?#][^\s'"`<>()[\]{}|\\]*)?/gi;

/** Words a server's announcement uses, and the arrows and frames dev tools draw before them. */
const BANNER = /\b(?:local|loopback|listen(?:s|ing)?|running|started|starting|ready|available|serving|serve[sd]?|server|launched|open(?:ing)?|visit|browse|preview|address|url)\b|➜|➔|→|▶|┃|│/i;

/** A line about something that went wrong mentions an address it could not reach, not one to open. */
const ERROR_LINE = /\b(?:error|errno|failed|failure|refused|econnrefused|econnreset|eaddrinuse|cannot|can't|could not|unable|denied|timed? ?out|not found)\b/i;

/** A command that stays up by design. Match the invocation, never words in a filename or argument. */
const SERVERS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start|preview|watch)(?:\s|$)/,
  /^vite(?!.*\s(?:build|optimize)(?:\s|$))(?:$|\s+(?:--?[\w-]+|dev\b|serve\b|preview\b))/,
  /^(?:(?:next|astro|nuxt)\s+dev|webpack\s+serve|http-server|nodemon)(?:\s|$)/,
  /^(?:python(?:3(?:\.\d+)?)?\s+-m\s+http\.server|php\s+-S)(?:\s|$)/,
  /^tsc(?:\s+\S+)*?\s+(?:-w|--watch)(?:\s|$)/,
  /^tail(?:\s+\S+)*?\s+(?:-[fF]|--follow)(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s+--)?\s+--watch(?:\s|$)/,
];

export function servingCommand(command: string): boolean {
  const cmd = command.trim()
    .replace(/^cd\s+(?:"[^"$\r\n]+"|'[^'\r\n]+'|[\w.\\/:~-]+)\s*&&\s*/, '')
    .replace(/^(?:npx|pnpm\s+exec|bunx)\s+/, '');
  if (/[;&|\r\n]/.test(cmd) || /(?:^|\s)(?:--help|--version|-h|-v|--watch(?:=|\s+)false)(?:\s|$)/.test(cmd)) return false;
  return SERVERS.some(pattern => pattern.test(cmd));
}

/** Commands that ask a server for something: the addresses in their output are requests. */
const CLIENT_CMD = /^\s*(?:curl|wget|http|https|xh|httpie|invoke-webrequest|iwr|invoke-restmethod|irm|ping|nc|ncat|telnet|ab|wrk|hey|k6|lighthouse)(?:\.exe)?\b/i;

/** Cheap test before the real scan: output without a loopback name has nothing to find. */
export function mayHaveDevUrl(text: string): boolean {
  return /localhost|127\.\d|0\.0\.0\.0|\[::/i.test(text);
}

/** One printed address as something to open, or null when it is not a page on this machine with a port. */
export function devUrl(raw: string): DevUrl | null {
  let text = raw.replace(/[.,;:!?*_'")\]}>]+$/, '');
  // 0.0.0.0 and [::] mean "every interface": a browser reaches them as localhost.
  text = text.replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])/i, '$1localhost');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const named = host.endsWith('.localhost');
  // A bare localhost or IP needs a port (that is what a dev server prints); *.localhost names do not.
  // URL drops explicit default ports (http :80 and https :443) during normalization.
  const port = u.port || /^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)(?:[/?#]|$)/i.exec(text)?.[1];
  if (!port && !named) return null;
  const loopback = host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
  return { url: u.href, label: loopback ? `localhost${port ? `:${port}` : ''}` : u.host };
}

/** Local pages mentioned in prose. Capture also reads the agent's invitation to open a page. */
export function localPages(text: string | undefined): string[] {
  if (!text?.includes('://')) return [];
  const pages = new Set<string>();
  for (const m of stripAnsi(text).matchAll(URL_RE)) {
    const page = devUrl(m[0]);
    if (page) pages.add(page.url);
  }
  return [...pages];
}

/**
 * The dev servers a command's output announces, one per address (its first printed URL, so a later
 * "Inspect: http://localhost:5173/__inspect/" does not replace the root), ordered by when each was
 * last printed: the last one is the server that spoke most recently.
 */
export function devServerUrls(text: string, command?: string): DevUrl[] {
  if (!text || !text.includes('://')) return [];
  if (command && CLIENT_CMD.test(command)) return [];
  const fromServer = !!command && servingCommand(command);
  const out: DevUrl[] = [];
  for (const line of stripAnsi(text).split('\n')) {
    if (!line.includes('://') || ERROR_LINE.test(line)) continue;
    const matches = [...line.matchAll(URL_RE)];
    if (!matches.length) continue;
    // A line that is only the address (Gatsby, CRA print one on its own) counts as announced.
    const alone = matches.length === 1 && line.trim().replace(/[.,;:!?*_'"]+$/, '') === matches[0][0].replace(/[.,;:!?*_'"]+$/, '');
    if (!fromServer && !alone && !BANNER.test(line)) continue;
    for (const m of matches) {
      const u = devUrl(m[0]);
      if (!u) continue;
      const i = out.findIndex((x) => x.label === u.label);
      const keep = i >= 0 ? out[i] : u;
      if (i >= 0) out.splice(i, 1);
      out.push(keep);
    }
  }
  return out;
}

/** How much of a long output is read: its start (where servers announce themselves) and its end (where a restart does). */
const HEAD = 32_000;
const TAIL = 16_000;

/** The server a command's output announced most recently, if any. Long output is read at its start and end, cut at line breaks. */
export function lastDevUrl(text: string | undefined, command?: string): DevUrl | null {
  if (!text || !mayHaveDevUrl(text)) return null;
  let read = text;
  if (text.length > HEAD + TAIL) {
    const headEnd = text.lastIndexOf('\n', HEAD);
    const tailStart = text.indexOf('\n', text.length - TAIL);
    read = `${text.slice(0, Math.max(0, headEnd))}\n${tailStart >= 0 ? text.slice(tailStart + 1) : ''}`;
  }
  const all = devServerUrls(read, command);
  return all[all.length - 1] ?? null;
}

/** "localhost:5173" for any address (the label `devUrl` gives, or the host). */
export function devUrlLabel(url: string): string {
  return devUrl(url)?.label ?? url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}
