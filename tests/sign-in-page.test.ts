import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { describeScript, fillScript, formEncode, requestVerdict, stampScript, stillThereScript, type FormPin } from '../electron/sign-in-core';
import { signInProbeScript, snapshotScript } from '../src/features/rail/browser-scripts';

/**
 * The scripts Electron main signs in with (electron/sign-in-core.ts), in a real browser (the
 * installed Edge, headless; skipped where there is none), against made-up local pages and a made-up
 * password. Main runs them in an isolated world; here they run in the page's own world, which only
 * gives a hostile page more reach. One browser: take scratch/heavy.lock when running it by hand.
 */

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const PASSWORD = 'made-up pass! 7351';

/** The page records a submit instead of sending it (so the test can read what would have gone). */
const RECORD = `<script>
  window.submitted = null;
  document.addEventListener('submit', (e) => { e.preventDefault(); window.submitted = { user: document.getElementById('u').value, pass: !!document.getElementById('p').value }; }, true);
</script>`;
const FORM = (attrs = 'method="post" action="/session"', button = '<button>Sign in</button>') => `<form id="f" ${attrs}><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password">${button}</form>`;
const page = (body: string, record = true) => `<!doctype html><title>portal</title>${body}${record ? RECORD : ''}`;

function serve(html: (path: string) => string, seen?: (req: http.IncomingMessage, body: string) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen?.(req, body);
        res.writeHead(200, { 'content-type': 'text/html' }).end(html(req.url ?? '/'));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }));
  });
}

describe.skipIf(!EDGE)('a sign-in filled into a real page', () => {
  let browser: Browser;
  let a: { url: string; close: () => void };
  let b: { url: string; close: () => void };
  const pages: Record<string, string> = {};
  const wire: { method: string; url: string; body: string }[] = [];
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    b = await serve(() => page(FORM()));
    a = await serve(
      (p) => (p.startsWith('/framed') ? `<!doctype html><iframe id="x" src="${b.url}/"></iframe>` : (pages[p.split('?')[0]] ?? page(FORM()))),
      (req, body) => wire.push({ method: req.method ?? '', url: req.url ?? '', body }),
    );
    Object.assign(pages, {
      '/get': page(FORM('method="get" action="/session"')),
      '/away': page(FORM(`method="post" action="${b.url}/session"`)),
      '/override-action': page(FORM('method="post" action="/session"', `<button formaction="${b.url}/x">Sign in</button>`)),
      '/override-method': page(FORM('method="post" action="/session"', '<button formmethod="get">Sign in</button>')),
      '/target': page(FORM('method="post" action="/session" target="_blank"')),
      '/base-target': page(`<base target="elsewhere">${FORM()}`),
      '/two': page(FORM() + '<form><input type="password"></form>'),
      '/native-post': page(FORM(), false),
      '/native-get': page(FORM('method="get" action="/session"'), false),
      '/mover': page(`${FORM()}<iframe id="fr" srcdoc="<p>frame</p>"></iframe><script>
        document.getElementById('u').addEventListener('input', () => { const f = document.getElementById('fr').contentDocument; f.body.appendChild(f.adoptNode(document.getElementById('p'))); });
      </script>`),
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    a?.close();
    b?.close();
  });

  /** begin's description, then the fresh document's stamp, as main does them (here in one document). */
  const prepare = async (p: Page, path: string) => {
    await p.goto(`${a.url}${path}`);
    const pin = (await p.evaluate(describeScript(a.url))) as FormPin & { error?: string };
    if (pin.error) return { error: pin.error };
    const stamp = (await p.evaluate(stampScript('n0nce', a.url, pin))) as { ok?: boolean; error?: string };
    return stamp.ok ? { pin } : { error: stamp.error };
  };
  const state = (p: Page) => p.evaluate(`({ submitted: window.submitted, pass: (document.getElementById('p') || {}).value || '' })`) as Promise<{ submitted: unknown; pass: string }>;

  it('a same-origin POST form is filled and submitted', async () => {
    const p = await browser.newPage();
    expect(await prepare(p, '/')).toHaveProperty('pin');
    expect(await p.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD))).toEqual({ ok: true });
    expect((await state(p)).submitted).toEqual({ user: 'student.one', pass: true });
    expect(await p.evaluate(stillThereScript('n0nce'))).toEqual({ gone: false });
    await p.close();
  });

  it('is refused before any value is set: GET, another action, a submitter\'s override, a target, <base target>, two password fields', async () => {
    for (const [path, error] of [
      ['/get', 'method'],
      ['/away', 'action'],
      ['/override-action', 'action'],
      ['/override-method', 'method'],
      ['/target', 'target'],
      ['/base-target', 'target'],
      ['/two', 'several'],
    ] as const) {
      const p = await browser.newPage();
      expect(await prepare(p, path), path).toEqual({ error });
      expect((await state(p)).pass, path).toBe('');
      await p.close();
    }
  });

  it('an action changed after the stamp is caught by the fill before any value is set', async () => {
    const p = await browser.newPage();
    await prepare(p, '/');
    await p.evaluate(`document.getElementById('f').action = ${JSON.stringify(`${b.url}/steal`)}`);
    expect(await p.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD))).toEqual({ error: 'action' });
    expect((await state(p)).pass).toBe('');
    await p.close();
  });

  it('a stamped document opened anew, or its form replaced, is not filled', async () => {
    const reopened = await browser.newPage();
    await prepare(reopened, '/');
    // document.open() keeps the window (and the stamp's world) but replaces the document's content.
    await reopened.evaluate(`document.open(); document.write(${JSON.stringify(page(FORM()))}); document.close();`);
    expect(await reopened.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD))).toEqual({ error: 'replaced' });
    expect((await state(reopened)).pass).toBe('');
    await reopened.close();
    const swapped = await browser.newPage();
    await prepare(swapped, '/');
    await swapped.evaluate(`document.getElementById('f').outerHTML = document.getElementById('f').outerHTML`);
    expect(await swapped.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD))).toEqual({ error: 'replaced' });
    expect((await state(swapped)).pass).toBe('');
    await swapped.close();
  });

  it('a field moved into a frame by the page during the fill\'s events stops the submit', async () => {
    const p = await browser.newPage();
    await prepare(p, '/mover');
    expect(await p.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD))).toEqual({ error: 'changed' });
    expect((await state(p)).submitted).toBeNull();
    await p.close();
  });

  it('the wire rule matches the browser\'s own form serialization of a password with "!" and a space', async () => {
    for (const path of ['/native-post', '/native-get']) {
      wire.length = 0;
      const p = await browser.newPage();
      await p.goto(`${a.url}${path}`);
      await Promise.all([
        p.waitForLoadState('load'),
        p.evaluate(`document.getElementById('u').value = 'student.one'; document.getElementById('p').value = ${JSON.stringify(PASSWORD)}; document.getElementById('f').requestSubmit();`),
      ]);
      await p.waitForTimeout(300);
      const sent = wire.find((w) => w.url.startsWith('/session'))!;
      expect(sent, path).toBeTruthy();
      expect(sent.body + sent.url, path).toContain(formEncode(PASSWORD));
      // The same request sent anywhere else: cancelled (the body, or the address that holds the password).
      const elsewhere = { url: `https://evil.example.test${sent.url}`, method: sent.method, ...(sent.method === 'POST' ? { body: [new TextEncoder().encode(sent.body)] } : {}) };
      expect(requestVerdict(elsewhere, { origin: a.url, password: PASSWORD }), path).toBe('cancel');
      // A GET to the right origin that holds it in its address: cancelled too.
      if (sent.method === 'GET') expect(requestVerdict({ url: `${a.url}${sent.url}`, method: 'GET' }, { origin: a.url, password: PASSWORD })).toBe('cancel');
      await p.close();
    }
  });

  it('never inside a frame: the frame\'s fields have no reference in the outline, and nothing is stamped there', async () => {
    const p = await browser.newPage();
    await p.goto(`${a.url}/framed`);
    const frame = p.frames().find((f) => f.url().startsWith(b.url))!;
    await frame.waitForSelector('#p');
    const top = (await p.evaluate(snapshotScript(4000))) as { text: string };
    expect(top.text).not.toMatch(/password field/);
    expect(await frame.evaluate(describeScript(b.url))).toEqual({ error: 'moved' });
    expect(await frame.evaluate(stampScript('n0nce', b.url, { action: `${b.url}/session`, user: 'username', pass: 'password' }))).toEqual({ error: 'moved' });
    expect(await frame.evaluate(fillScript('n0nce', b.url, 'student.one', PASSWORD))).toEqual({ error: 'replaced' });
    expect(await frame.evaluate(`document.getElementById('p').value`)).toBe('');
    expect(await frame.evaluate(signInProbeScript({ userRef: 'e1', passRef: 'e2' }))).toMatchObject({ error: expect.stringMatching(/never inside a frame|no longer points/) });
    await p.close();
  });
});
