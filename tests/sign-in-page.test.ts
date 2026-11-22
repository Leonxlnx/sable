import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { fillScript, stampScript, stillThereScript } from '../electron/sign-in-core';
import { signInProbeScript, snapshotScript } from '../src/features/rail/browser-scripts';

/**
 * The scripts Electron main fills a sign-in with (electron/sign-in-core.ts), in a real browser (the
 * installed Edge, headless; skipped where there is none), against made-up local pages. Main runs
 * them in an isolated world; here they run in the page's world, which is stricter for the test (the
 * page could interfere more). One browser: take scratch/heavy.lock when running it by hand.
 */

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const PASSWORD = 'made-up-pass-7351';

const page = (form: string) => `<!doctype html><title>portal</title>${form}<script>
  window.submitted = null;
  document.addEventListener('submit', (e) => { e.preventDefault(); window.submitted = { user: document.getElementById('u').value, pass: !!document.getElementById('p').value }; }, true);
</script>`;
const FORM = (attrs = 'method="post" action="/session"', button = '<button>Sign in</button>') => `<form id="f" ${attrs}><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password">${button}</form>`;

function serve(html: (path: string) => string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html(req.url ?? '/')));
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }));
  });
}

describe.skipIf(!EDGE)('a sign-in filled into a real page', () => {
  let browser: Browser;
  let a: { url: string; close: () => void };
  let b: { url: string; close: () => void };
  const pages: Record<string, string> = {};
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    b = await serve(() => page(FORM()));
    a = await serve((p) => (p.startsWith('/framed') ? `<!doctype html><iframe id="x" src="${b.url}/"></iframe>` : (pages[p] ?? page(FORM()))));
    Object.assign(pages, {
      '/get': page(FORM('method="get" action="/session"')),
      '/away': page(FORM(`method="post" action="${b.url}/session"`)),
      '/override-action': page(FORM('method="post" action="/session"', `<button formaction="${b.url}/x">Sign in</button>`)),
      '/override-method': page(FORM('method="post" action="/session"', '<button formmethod="get">Sign in</button>')),
      '/target': page(FORM('method="post" action="/session" target="_blank"')),
      '/two': page(FORM() + '<form><input type="password"></form>'),
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    a?.close();
    b?.close();
  });

  const fill = async (path: string, stamp = true) => {
    const p = await browser.newPage();
    await p.goto(`${a.url}${path}`);
    if (stamp) await p.evaluate(stampScript('n0nce'));
    const r = await p.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD));
    const after = await p.evaluate(`({ submitted: window.submitted, pass: document.getElementById('p').value })`);
    await p.close();
    return { r, after: after as { submitted: unknown; pass: string } };
  };

  it('a same-origin POST form is filled and submitted', async () => {
    const { r, after } = await fill('/');
    expect(r).toEqual({ ok: true });
    expect(after.submitted).toEqual({ user: 'student.one', pass: true });
  });

  it('refuses before setting any value: GET, another action, a submitter\'s override, another target, two password fields', async () => {
    for (const [path, error] of [
      ['/get', 'method'],
      ['/away', 'action'],
      ['/override-action', 'action'],
      ['/override-method', 'method'],
      ['/target', 'target'],
      ['/two', 'several'],
    ] as const) {
      const { r, after } = await fill(path);
      expect(r, path).toEqual({ error });
      expect(after.pass, path).toBe('');
      expect(after.submitted, path).toBeNull();
    }
  });

  it('a document that was not stamped (a replaced one) is not filled', async () => {
    const { r, after } = await fill('/', false);
    expect(r).toEqual({ error: 'replaced' });
    expect(after.pass).toBe('');
  });

  it('never inside a frame: the frame\'s fields have no reference in the outline, and the fill refuses there', async () => {
    const p = await browser.newPage();
    await p.goto(`${a.url}/framed`);
    const frame = p.frames().find((f) => f.url().startsWith(b.url))!;
    await frame.waitForSelector('#p');
    const top = (await p.evaluate(snapshotScript(4000))) as { text: string };
    expect(top.text).not.toMatch(/password field/);
    await frame.evaluate(stampScript('n0nce'));
    expect(await frame.evaluate(fillScript('n0nce', b.url, 'student.one', PASSWORD))).toEqual({ error: 'moved' });
    expect(await frame.evaluate(`document.getElementById('p').value`)).toBe('');
    expect(await frame.evaluate(signInProbeScript({ userRef: 'e1', passRef: 'e2' }))).toMatchObject({ error: expect.stringMatching(/never inside a frame|no longer points/) });
    await p.close();
  });

  it('after the submit, a page that keeps the filled field reads as not through', async () => {
    const p = await browser.newPage();
    await p.goto(`${a.url}/`);
    await p.evaluate(stampScript('n0nce'));
    await p.evaluate(fillScript('n0nce', a.url, 'student.one', PASSWORD));
    expect(await p.evaluate(stillThereScript('n0nce'))).toEqual({ gone: false });
    await p.evaluate(`document.getElementById('f').remove()`);
    expect(await p.evaluate(stillThereScript('n0nce'))).toEqual({ gone: true });
    await p.close();
  });
});
