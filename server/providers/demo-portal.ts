import http from 'node:http';

/**
 * A made-up school portal for the Demo's `signin` scenario: one page served from memory on a free
 * port of 127.0.0.1 (no internet, no real site, no real account), so the agent's pointer, the
 * sign-in card and a saved sign-in can be tried and filmed. Any user name with any password signs
 * in, except the password `wrong`, which the form refuses. One server per bridge, closed after a
 * quiet quarter hour (and it never keeps the process alive).
 *
 * The page also answers Sable's dev-build frame (src/features/rail/dev-frame.ts): a parent window
 * that says `{ sable: 'hello' }` may run page scripts in it. Only a test page does that; in the
 * desktop app's <webview> it has no parent and the listener does nothing.
 */

export const PORTAL_TITLE = 'Learning portal';

/**
 * `typing`: the password box is a plain text field drawn as dots, which the agent's ordinary
 * browser_type fills (it refuses real password fields): the made-up portal, signed into with a
 * made-up password, while sign-ins do not ship.
 */
export const portalHtml = (typing = false) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PORTAL_TITLE}</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #17202a; background: #f4f5f2; }
header { display: flex; align-items: center; gap: 22px; padding: 16px 28px; background: #fff; border-bottom: 1px solid #e3e5e0; }
header strong { margin-right: auto; font-size: 17px; }
header span { color: #5f6b76; font-size: 14px; }
main { max-width: 760px; margin: 0 auto; padding: 40px 28px 80px; }
form.signin { max-width: 360px; margin: 36px auto; padding: 28px; background: #fff; border: 1px solid #e3e5e0; border-radius: 12px; }
h1 { margin: 0 0 18px; font-size: 26px; letter-spacing: -0.01em; }
label { display: block; margin: 12px 0 5px; font-size: 13px; color: #5f6b76; }
input { width: 100%; height: 40px; padding: 0 12px; font: inherit; border: 1px solid #cfd4cc; border-radius: 8px; background: #fbfbfa; }
button { height: 40px; padding: 0 18px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: #2f6f4e; color: #fff; cursor: pointer; }
form.signin button { width: 100%; margin-top: 20px; }
.err { margin: 12px 0 0; color: #b3261e; font-size: 13px; }
.courses { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin: 22px 0 34px; }
.course { height: auto; padding: 18px; text-align: left; background: #fff; color: #17202a; border: 1px solid #e3e5e0; border-radius: 12px; font-weight: 500; }
.course b { display: block; font-size: 16px; }
.course span { color: #5f6b76; font-size: 13px; }
.course[aria-pressed="true"] { border-color: #2f6f4e; box-shadow: 0 0 0 1px #2f6f4e; }
.find { display: flex; gap: 8px; }
.news p { padding: 14px 0; margin: 0; border-bottom: 1px solid #e3e5e0; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header><strong>${PORTAL_TITLE}</strong><span>Courses</span><span>Calendar</span><span>Messages</span></header>
<main>
  <form class="signin" id="signin" autocomplete="on">
    <h1>Sign in</h1>
    <label for="user">User name</label>
    <input id="user" name="username" autocomplete="username">
    <label for="pass">Password</label>
    ${typing ? '<input id="pass" name="pin" type="text" autocomplete="off" style="-webkit-text-security: disc">' : '<input id="pass" name="password" type="password" autocomplete="current-password">'}
    <p class="err" id="err" hidden>The user name or password is wrong.</p>
    <button type="submit">Sign in</button>
  </form>
  <section id="home" hidden>
    <h1 id="hello">Welcome</h1>
    <div class="find"><input id="q" placeholder="Find a course" aria-label="Find a course"><button type="button" id="go">Find</button></div>
    <div class="courses">
      <button class="course" type="button" aria-pressed="false"><b>Mathematics 10b</b><span>3 new tasks</span></button>
      <button class="course" type="button" aria-pressed="false"><b>English</b><span>Essay due Friday</span></button>
      <button class="course" type="button" aria-pressed="false"><b>Physics</b><span>Lab notes</span></button>
      <button class="course" type="button" aria-pressed="false"><b>History</b><span>Reading list</span></button>
    </div>
    <div class="news">${Array.from({ length: 14 }, (_, i) => `<p>Notice ${i + 1}: the timetable for week ${i + 2} is online.</p>`).join('')}</div>
    <p><button type="button" id="out">Sign out</button></p>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
$('signin').addEventListener('submit', (e) => {
  e.preventDefault();
  const u = $('user').value.trim(), p = $('pass').value;
  $('err').hidden = true;
  if (!u || !p || p === 'wrong') { $('err').hidden = false; return; }
  $('pass').value = '';
  $('signin').hidden = true;
  $('home').hidden = false;
  $('hello').textContent = 'Welcome, ' + u;
  document.title = 'Courses - ${PORTAL_TITLE}';
});
for (const c of document.querySelectorAll('.course')) c.addEventListener('click', () => { for (const o of document.querySelectorAll('.course')) o.setAttribute('aria-pressed', String(o === c)); });
$('out').addEventListener('click', () => { $('home').hidden = true; $('signin').hidden = false; document.title = '${PORTAL_TITLE}'; });
// Sable's dev-build frame only (see the header of server/providers/demo-portal.ts).
addEventListener('message', async (e) => {
  if (e.source !== parent || parent === window || !e.data || typeof e.data.sable !== 'string') return;
  const reply = (m) => parent.postMessage(Object.assign({ sableDevPage: 1, href: location.href, title: document.title }, m), e.origin);
  if (e.data.sable === 'hello') return reply({ hello: 1 });
  if (e.data.sable !== 'run') return;
  try { reply({ id: e.data.id, ok: 1, value: await (0, eval)(e.data.script) }); }
  catch (err) { reply({ id: e.data.id, error: String((err && err.message) || err) }); }
});
</script>
</body>
</html>
`;

const QUIET_MS = 15 * 60_000;
let running: { url: string; server: http.Server; timer?: NodeJS.Timeout } | undefined;

/** The portal's address, started on first use. */
export async function demoPortal(): Promise<string> {
  if (running) {
    touch();
    return running.url;
  }
  const html = portalHtml();
  const typed = portalHtml(true);
  const server = http.createServer((req, res) => {
    touch();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : u.searchParams.has('typing') ? typed : html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  running = { url: `http://127.0.0.1:${port}/`, server };
  touch();
  return running.url;
}

function touch() {
  if (!running) return;
  clearTimeout(running.timer);
  running.timer = setTimeout(closePortal, QUIET_MS);
  running.timer.unref();
}

export function closePortal() {
  if (!running) return;
  clearTimeout(running.timer);
  running.server.close();
  running.server.closeAllConnections?.();
  running = undefined;
}
