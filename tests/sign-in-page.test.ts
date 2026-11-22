import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { signInCheckScript, signInFillScript, signInProbeScript, snapshotScript } from '../src/features/rail/browser-scripts';

/**
 * The sign-in's page scripts in a real browser (the installed Edge, headless; skipped where there is
 * none): the threats of the brief, one by one, against made-up local pages. Runs one browser; take
 * scratch/heavy.lock when running it by hand.
 */

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const PASSWORD = 'made-up-pass-7351';

const FORM = `<form id="f"><input id="u" name="username"><input id="p" type="password"><button id="b">Sign in</button></form>`;

function serve(html: (path: string) => string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html(req.url ?? '/')));
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }));
  });
}

/** The refs of an outline, by the line's start ("textbox", "password field", "button"). */
async function refs(page: Page, frame = page.mainFrame()) {
  const r = (await frame.evaluate(snapshotScript(4000))) as { text: string };
  const ref = (what: string) => new RegExp(`^\\[(e\\d+)\\] ${what}`, 'm').exec(r.text)?.[1] ?? '';
  return { userRef: ref('textbox'), passRef: ref('password field'), submitRef: ref('button') };
}

describe.skipIf(!EDGE)('a sign-in in a real page', () => {
  let browser: Browser;
  let a: { url: string; close: () => void };
  let b: { url: string; close: () => void };
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    // Two origins: the site, and another one that frames it or is framed by it.
    b = await serve(() => `<!doctype html><title>other</title>${FORM}`);
    a = await serve((p) =>
      p.startsWith('/framed')
        ? `<!doctype html><title>site</title><iframe id="x" src="${b.url}/"></iframe>`
        : `<!doctype html><title>site</title>${FORM}<script>
  window.seenBeforeSubmit = []; window.submitted = false;
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.submitted = true; });
  setInterval(() => { const v = document.getElementById('p').value; if (v && !window.submitted) window.seenBeforeSubmit.push(v); }, 0);
  new MutationObserver(() => {}).observe(document.body, { subtree: true, attributes: true });
</script>`,
    );
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    a?.close();
    b?.close();
  });

  it('fills and submits in one task: a timer of the page never sees the password before the submit', async () => {
    const page = await browser.newPage();
    await page.goto(`${a.url}/`);
    const r = await refs(page);
    expect(await page.evaluate(signInProbeScript(r))).toMatchObject({ origin: a.url });
    expect(await page.evaluate(signInFillScript(r, a.url, 'student.one', PASSWORD))).toEqual({ ok: true });
    await page.waitForTimeout(50);
    expect(await page.evaluate('window.submitted')).toBe(true);
    expect(await page.evaluate('window.seenBeforeSubmit.length')).toBe(0);
    await page.close();
  });

  it('a page that moved to another origin between the ask and the fill gets nothing', async () => {
    const page = await browser.newPage();
    await page.goto(`${b.url}/`);
    const r = await refs(page);
    // The card was for the first site; the page is the other one now.
    expect(await page.evaluate(signInFillScript(r, a.url, 'student.one', PASSWORD))).toEqual({ error: 'moved' });
    expect(await page.evaluate(`document.getElementById('p').value`)).toBe('');
    await page.close();
  });

  it('never in a frame: neither a cross-origin frame nor fields that are not the page\'s own', async () => {
    const page = await browser.newPage();
    await page.goto(`${a.url}/framed`);
    const frame = page.frames().find((f) => f.url().startsWith(b.url))!;
    await frame.waitForSelector('#p');
    // The top page's outline does not list the frame's fields at all: they have no reference to name.
    const top = await refs(page);
    expect(top.passRef).toBe('');
    // Run inside the frame (as if the agent pointed there), the scripts refuse.
    const r = await refs(page, frame);
    expect(await frame.evaluate(signInProbeScript(r))).toMatchObject({ error: expect.stringMatching(/never inside a frame/) });
    expect(await frame.evaluate(signInFillScript(r, b.url, 'student.one', PASSWORD))).toEqual({ error: 'moved' });
    expect(await frame.evaluate(`document.getElementById('p').value`)).toBe('');
    await page.close();
  });

  it('while the filled field holds the password the outline lists no values, and the hold ends only when it is cleared', async () => {
    const page = await browser.newPage();
    await page.goto(`${a.url}/`);
    const r = await refs(page);
    await page.evaluate(signInFillScript(r, a.url, 'student.one', PASSWORD));
    // A "show password" switch turns it into a text field: still no value in the outline without values.
    await page.evaluate(`document.getElementById('p').type = 'text'`);
    const held = (await page.evaluate(snapshotScript(4000, false))) as { text: string };
    expect(held.text).not.toContain(PASSWORD);
    expect(held.text).not.toContain('student.one');
    expect(await page.evaluate(signInCheckScript)).toMatchObject({ cleared: false });
    // The page deleting Sable's mark does not end the hold (unknown is not cleared).
    await page.evaluate(`delete window.__sableFilled`);
    expect(await page.evaluate(signInCheckScript)).toEqual({ unknown: true });
    await page.close();
    const again = await browser.newPage();
    await again.goto(`${a.url}/`);
    const r2 = await refs(again);
    await again.evaluate(signInFillScript(r2, a.url, 'student.one', PASSWORD));
    await again.evaluate(`document.getElementById('p').value = ''`);
    expect(await again.evaluate(signInCheckScript)).toMatchObject({ cleared: true });
    await again.close();
  });
});
