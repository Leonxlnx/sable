/**
 * The scripts Sable runs inside a page of the Browser tab, for the agent's tools (browser-agent.ts)
 * and for the person's (pick an element). Each is one expression that returns plain data. They read
 * the document and act on its elements; none of them touches cookies, storage or credentials, and
 * none reports the value of a password field.
 */

const j = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Shared by every script: references that stay with their element for the document's lifetime
 * (the same element gets the same reference in every outline), a role and a name per element in
 * the words a person would use, and one way to find what a tool was pointed at.
 */
const PRELUDE = `
const REFS = (() => {
  let r = window.__sableRefs;
  if (!r) {
    r = { n: 0, byId: new Map(), ids: new WeakMap() };
    Object.defineProperty(window, '__sableRefs', { value: r, enumerable: false, configurable: true });
  }
  return r;
})();
const refOf = (el) => {
  let id = REFS.ids.get(el);
  if (!id) { id = 'e' + (++REFS.n); REFS.ids.set(el, id); REFS.byId.set(id, new WeakRef(el)); }
  return id;
};
const byRef = (id) => { const w = REFS.byId.get(id); const el = w && w.deref(); return el && el.isConnected ? el : null; };
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const shown = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
};
const secret = (el) => {
  if (!el || el.tagName !== 'INPUT') return false;
  const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
  return el.type === 'password' || /password|one-time-code|cc-(number|csc|exp)/.test(ac);
};
const roleOf = (el) => {
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit;
  const t = el.tagName;
  if (t === 'A') return el.hasAttribute('href') ? 'link' : 'anchor';
  if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
  if (t === 'SELECT') return 'combobox';
  if (t === 'TEXTAREA') return 'textbox';
  if (t === 'IMG') return 'image';
  if (/^H[1-6]$/.test(t)) return 'heading';
  if (t === 'INPUT') {
    const k = (el.type || 'text').toLowerCase();
    if (k === 'checkbox' || k === 'radio') return k;
    if (k === 'button' || k === 'submit' || k === 'reset' || k === 'image') return 'button';
    if (k === 'range') return 'slider';
    if (k === 'search') return 'searchbox';
    if (k === 'password') return 'password field';
    return 'textbox';
  }
  if (el.isContentEditable) return 'textbox';
  return t.toLowerCase();
};
const nameOf = (el) => {
  const al = el.getAttribute('aria-label');
  if (al) return clip(al, 80);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const t = lb.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    if (t.trim()) return clip(t, 80);
  }
  const t = el.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
    if (t === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && el.value) return clip(el.value, 80);
    const l = el.labels && el.labels[0];
    if (l && l.textContent.trim()) return clip(l.textContent, 80);
    return clip(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '', 80);
  }
  if (t === 'IMG') return clip(el.getAttribute('alt') || '', 80);
  return clip(el.innerText || el.textContent || el.getAttribute('title') || '', 80);
};
const describe = (el) => { const n = nameOf(el); return roleOf(el) + (n ? ' "' + n + '"' : ''); };
const inView = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; };
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
const USABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="combobox"],[role="textbox"],[contenteditable=""],[contenteditable="true"],[onclick]';
const find = (q) => {
  if (q.ref) {
    const el = byRef(q.ref);
    return el ? { el } : { error: 'No element has the reference ' + q.ref + ' any more. Take a new browser_snapshot.' };
  }
  if (q.selector) {
    let el;
    try { el = document.querySelector(q.selector); } catch (e) { return { error: '"' + q.selector + '" is not a valid CSS selector.' }; }
    return el ? { el } : { error: 'Nothing on the page matches "' + q.selector + '".' };
  }
  if (q.text) {
    const want = q.text.replace(/\\s+/g, ' ').trim().toLowerCase();
    let exact = null, part = null, n = 0;
    for (const el of document.querySelectorAll(USABLE)) {
      if (++n > 4000) break;
      if (!shown(el)) continue;
      const name = nameOf(el).toLowerCase();
      if (!name) continue;
      if (name === want) { exact = el; break; }
      if (!part && name.includes(want)) part = el;
    }
    const el = exact || part;
    return el ? { el } : { error: 'Nothing to click on the page is called "' + q.text + '". browser_snapshot lists what is there.' };
  }
  return { none: true };
};
`;

/**
 * The outline: what can be used, and the headings, in page order, one line each with its reference.
 * `values` false (while a field holds a password Sable filled): no field's value is listed at all, so a
 * page that shows the password as text (a "show password" switch) cannot pass it on.
 */
export function snapshotScript(max: number, values = true): string {
  return `(() => {${PRELUDE}
  const lines = [];
  let size = 0, count = 0, total = 0, cut = false;
  const here = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin ? x.pathname : x.origin + x.pathname; } catch (e) { return ''; } };
  for (const el of document.querySelectorAll(USABLE + ',h1,h2,h3,h4')) {
    if (++total > 6000) { cut = true; break; }
    if (!shown(el)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    if (!name && (role === 'link' || role === 'heading' || role === 'anchor')) continue;
    let line = '[' + refOf(el) + '] ' + role + (role === 'heading' ? ' ' + el.tagName.slice(1) : '') + (name ? ' "' + name + '"' : '');
    if (role === 'link') { const h = here(el.getAttribute('href')); if (h) line += ' -> ' + clip(h, 80); }
    if (${values ? 'true' : 'false'} && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' (checked)' : '';
      else if (secret(el)) line += el.value ? ' (filled)' : '';
      else if (el.tagName === 'SELECT') line += ' = "' + clip(el.selectedOptions[0] ? el.selectedOptions[0].textContent : '', 40) + '"';
      else if (el.value) line += ' = "' + clip(el.value, 60) + '"';
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    if (size + line.length + 1 > ${max}) { cut = true; break; }
    lines.push(line);
    size += line.length + 1;
    count++;
  }
  return { title: String(document.title || ''), text: lines.join('\\n'), count, truncated: cut };
})()`;
}

/** One click, as a pointer would make it: the element scrolled into view, pressed, released, activated. */
export function clickScript(q: { ref?: string; selector?: string; text?: string }): string {
  return `(() => {${PRELUDE}
  const f = find(${j(q)});
  if (f.error) return { error: f.error };
  if (f.none) return { error: 'Say what to click.' };
  const el = f.el;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: describe(el) + ' is disabled.' };
  // Already brought into view by locateScript while the pointer travelled: the page does not jump again.
  if (!inView(el)) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const target = describe(el);
  el.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', p));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.click();
  return { target };
})()`;
}

/** Fills a field the way typing does (the events frameworks listen for), replacing what it holds. */
export function typeScript(q: { ref?: string; selector?: string }, text: string, submit: boolean): string {
  return `(() => {${PRELUDE}
  const f = find(${j(q)});
  if (f.error) return { error: f.error };
  const el = f.none ? document.activeElement : f.el;
  const text = ${j(text)};
  if (!el || el === document.body) return { error: 'No field has focus. Pass a ref from browser_snapshot or a selector.' };
  if (secret(el)) return { error: 'Sable does not type into password or payment fields. Ask the user to fill this one in the Browser tab.' };
  if (el.disabled || el.readOnly) return { error: describe(el) + ' cannot be edited.' };
  const target = describe(el);
  const fire = (type, init) => el.dispatchEvent(new (init ? InputEvent : Event)(type, { bubbles: true, cancelable: type === 'beforeinput', ...(init || {}) }));
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (/^(checkbox|radio|file|button|submit|reset|range|color|image)$/.test(el.type)) return { error: target + ' is not a text field. Use browser_click.' };
    el.focus({ preventScroll: true });
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    fire('input', { inputType: 'insertText', data: text });
    fire('change');
  } else if (el.tagName === 'SELECT') {
    const want = text.trim().toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === want || o.textContent.trim().toLowerCase() === want);
    if (!opt) return { error: target + ' has no option "' + clip(text, 60) + '".' };
    el.value = opt.value;
    fire('input');
    fire('change');
  } else if (el.isContentEditable) {
    el.focus({ preventScroll: true });
    const sel = getSelection();
    sel.selectAllChildren(el);
    document.execCommand('insertText', false, text);
  } else return { error: target + ' is not a field.' };
  let submitted = false;
  if (${submit ? 'true' : 'false'}) {
    const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', k));
    if (go && el.form && el.tagName !== 'TEXTAREA') {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      submitted = true;
    }
    el.dispatchEvent(new KeyboardEvent('keyup', k));
  }
  return { target, submitted };
})()`;
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

/** "Control+K" → the key and its modifiers. */
export function parseKey(combo: string): { key: string; mods: ('control' | 'shift' | 'alt' | 'meta')[] } {
  const parts = combo.split('+');
  // A lone "+" is the key itself.
  let key = combo === '+' || combo.endsWith('++') ? '+' : parts[parts.length - 1];
  const mods = (combo === '+' ? [] : parts.slice(0, -1))
    .filter(Boolean)
    .map((m) => m.toLowerCase())
    .map((m) => (m === 'ctrl' || m === 'control' ? 'control' : m === 'cmd' || m === 'meta' ? 'meta' : m === 'alt' ? 'alt' : 'shift') as 'control' | 'shift' | 'alt' | 'meta');
  if (key === 'Esc') key = 'Escape';
  if (key === 'Return') key = 'Enter';
  return { key, mods };
}

/** Notes whether a real key press reached the page (the shell's input event), so a press is never reported that did not happen. */
export const keyProbeScript = `(() => { window.__sableKey = 0; if (window.__sableUser) window.__sableUser.ownUntil = performance.now() + 400; window.addEventListener('keydown', () => { window.__sableKey = 1; }, { capture: true, once: true }); return true; })()`;
export const keyProbeRead = `(() => { const v = window.__sableKey === 1; try { delete window.__sableKey; } catch (e) {} return v; })()`;

/** The press as events on whatever has focus, with Enter submitting a field's form: the fallback when the shell's input did not arrive. */
export function pressScript(combo: string): string {
  const { key, mods } = parseKey(combo);
  const named = key === 'Space' ? ' ' : key;
  const init = { key: named, code: key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '') : key, keyCode: KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), ctrlKey: mods.includes('control'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta') };
  return `(() => {${PRELUDE}
  const el = document.activeElement || document.body;
  const k = { ...${j(init)}, which: ${init.keyCode}, bubbles: true, cancelable: true, composed: true };
  const go = el.dispatchEvent(new KeyboardEvent('keydown', k));
  if (go && k.key === 'Enter' && !k.ctrlKey && !k.altKey && !k.metaKey) {
    if (el.tagName === 'INPUT' && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
    else if (el !== document.body && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button')) el.click();
  }
  el.dispatchEvent(new KeyboardEvent('keyup', k));
  return { target: el === document.body ? '' : describe(el) };
})()`;
}

/** What has focus, in the page's words. */
export const focusedScript = `(() => {${PRELUDE}
  const el = document.activeElement;
  return { target: !el || el === document.body ? '' : describe(el), secret: secret(el) };
})()`;

/**
 * Scrolls the page. `smooth` (the person is watching the agent work): the page glides there and the
 * script answers once it stopped (or after `SCROLL_SETTLE_MS`), so the answer reads the final place.
 */
export function scrollScript(q: { ref?: string; selector?: string }, to: string | undefined, by: number | undefined, smooth = false): string {
  return `new Promise((resolve) => {${PRELUDE}
  const f = find(${j(q)});
  if (f.error) return resolve({ error: f.error });
  let target = '';
  const behavior = ${smooth ? "'smooth'" : "'instant'"};
  const root = document.scrollingElement || document.documentElement;
  const before = root.scrollTop;
  if (!f.none) { f.el.scrollIntoView({ block: 'center', behavior }); target = describe(f.el); }
  else if (${j(to)} === 'top') root.scrollTo({ top: 0, behavior });
  else if (${j(to)} === 'bottom') root.scrollTo({ top: root.scrollHeight, behavior });
  else root.scrollBy({ top: ${Number(by) || 0}, behavior });
  const answer = () => {
    const max = Math.max(0, root.scrollHeight - innerHeight);
    resolve({ target, text: Math.round(root.scrollTop) + ' of ' + Math.round(max) + ' px' + (max <= 0 ? ' (the page does not scroll)' : root.scrollTop >= max - 1 ? ' (at the bottom)' : root.scrollTop <= 0 ? ' (at the top)' : '') });
  };
  if (behavior === 'instant') return answer();
  ${settleJs('answer')}
})`;
}

/** How long a smooth scroll is given before the script reads where the page is. */
export const SCROLL_SETTLE_MS = 700;

/** Waits for a smooth scroll to end (scrollend, or the position holding still), then calls `done`. */
const settleJs = (done: string) => `{
    let last = -1, still = 0, over = false;
    const end = () => { if (over) return; over = true; removeEventListener('scrollend', end, true); ${done}(); };
    addEventListener('scrollend', end, true);
    setTimeout(end, ${SCROLL_SETTLE_MS});
    const poll = () => { if (over) return; const y = (document.scrollingElement || document.documentElement).scrollTop; still = y === last ? still + 1 : 0; last = y; if (still >= 3) return end(); requestAnimationFrame(poll); };
    requestAnimationFrame(poll);
  }`;

/**
 * Finds the element a click or a typing is about to land on and brings it into view (smoothly when
 * it is out of view), then answers where it stands: its box in the page's own CSS pixels and the
 * page's viewport, from which the tab places its pointer over the view (zoom and a device size
 * included: the view's box divided by the viewport).
 */
export function locateScript(q: { ref?: string; selector?: string; text?: string }): string {
  return `new Promise((resolve) => {${PRELUDE}
  const f = find(${j(q)});
  if (f.error) return resolve({ error: f.error });
  if (f.none) return resolve({ none: true });
  const el = f.el;
  const answer = () => resolve({ rect: rectOf(el), vw: innerWidth, vh: innerHeight, target: describe(el) });
  if (inView(el)) return answer();
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  ${settleJs('answer')}
})`;
}

/**
 * The person's own hand: the time since their last real input in the page (a trusted pointer
 * move, press, wheel or key), so the agent's next action waits while they are using it. The
 * listeners go in once per document; a key Sable itself sends through the shell is not counted
 * (`keyProbeScript` marks it). -1 before the first input.
 */
export const userIdleScript = `(() => {
  let s = window.__sableUser;
  if (!s) {
    s = { at: -1, ownUntil: 0 };
    Object.defineProperty(window, '__sableUser', { value: s, enumerable: false, configurable: true });
    const mark = (e) => { if (e.isTrusted && performance.now() > s.ownUntil) s.at = performance.now(); };
    for (const t of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart']) addEventListener(t, mark, { capture: true, passive: true });
  }
  return s.at < 0 ? -1 : Math.round(performance.now() - s.at);
})()`;

/**
 * The agent's own script, as the body of an async function, stopped after `ms`. A one-line
 * expression gets its `return`. On a page that is not local the usual names for cookies and
 * storage are shadowed: a guard against reading them by accident, not a wall.
 */
export function evalScript(source: string, max: number, ms: number, guard: boolean): string {
  const src = source.trim().replace(/;+\s*$/, '');
  const body = !/\breturn\b/.test(src) && !/[;\n]/.test(src) ? `return (${src}\n);` : `${source}\n`;
  const names = guard ? 'localStorage, sessionStorage, indexedDB, cookieStore, caches' : '';
  return `(async () => {
  const run = async (${names}) => {
${body}
  };
  try {
    const v = await Promise.race([run(), new Promise((_, no) => setTimeout(() => no(new Error('The script did not finish in ${Math.round(ms / 1000)} seconds.')), ${ms}))]);
    let text;
    const seen = new WeakSet();
    try {
      text = JSON.stringify(v, (k, x) => {
        if (typeof x === 'bigint') return String(x);
        if (typeof x === 'function') return '[function]';
        if (x instanceof Node) return '[' + (x.nodeName || 'node').toLowerCase() + ']';
        if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
        return x;
      }, 1);
    } catch (e) { text = String(v); }
    if (text === undefined) text = 'undefined';
    return { text: text.slice(0, ${max + 1}), length: text.length };
  } catch (e) {
    return { error: 'The script threw: ' + String((e && e.message) || e).slice(0, 400) };
  }
})()`;
}

/** Waits for a selector to show, or for the page's requests to stop for half a second. */
export function waitScript(selector: string | undefined, ms: number): string {
  return `new Promise((resolve) => {
  const sel = ${j(selector ?? '')};
  const t0 = performance.now();
  if (sel) { try { document.querySelector(sel); } catch (e) { return resolve({ error: '"' + sel + '" is not a valid CSS selector.' }); } }
  let seen = performance.getEntriesByType('resource').length, quietSince = performance.now();
  const there = () => {
    if (sel) { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    const n = performance.getEntriesByType('resource').length;
    if (n !== seen) { seen = n; quietSince = performance.now(); }
    return document.readyState === 'complete' && performance.now() - quietSince >= 500;
  };
  const tick = () => {
    const waited = Math.round(performance.now() - t0);
    if (there()) return resolve({ count: waited, title: String(document.title || '') });
    if (waited >= ${ms}) return resolve({ count: waited, timedOut: true, title: String(document.title || '') });
    setTimeout(tick, 100);
  };
  tick();
})`;
}

/** The page's requests since it loaded, from its own timing entries: address without query, kind, status, time. */
export function requestsScript(max: number): string {
  return `(() => {
  const bare = (u) => { u = String(u); return u.startsWith('data:') ? 'data:' : u.split(/[?#]/)[0].slice(0, 300); };
  const all = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  return { total: all.length, requests: all.slice(-${max}).map((e) => ({ url: bare(e.name), kind: e.entryType === 'navigation' ? 'document' : String(e.initiatorType || ''), status: Number(e.responseStatus) || 0, ms: Math.round(e.duration) })) };
})()`;
}

/* ── for the person: pick an element ── */

export interface Picked {
  selector: string;
  /** 'button "Sign in"'. */
  what: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  vw: number;
  vh: number;
}

/**
 * Pick mode: the element under the pointer is outlined with its tag and size; a click resolves
 * with a reference to it (and never reaches the page), Escape or `window.__sablePick()` ends it
 * with null. The outline is one fixed box that ignores the pointer, removed before this resolves.
 */
export const pickScript = `new Promise((resolve) => {${PRELUDE}
  if (window.__sablePick) window.__sablePick();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  const one = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const path = (el) => {
    if (el.id && one('#' + esc(el.id))) return '#' + esc(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid && one('[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]')) return '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && one('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      const name = node.getAttribute('name');
      const cls = [...node.classList].filter((c) => /^[a-zA-Z_-][\\w-]*$/.test(c) && c.length < 32).slice(0, 2);
      if (name && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(node.tagName)) part += '[name="' + name.replace(/"/g, '\\\\"') + '"]';
      else if (cls.length) part += '.' + cls.map(esc).join('.');
      const sibs = node.parentElement ? [...node.parentElement.children].filter((s) => s.tagName === node.tagName) : [];
      if (sibs.length > 1 && !(node.parentElement && node.parentElement.querySelectorAll(':scope > ' + part).length === 1)) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      parts.unshift(part);
      if (one(parts.join(' > '))) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const box = document.createElement('div');
  const tag = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:1.5px solid #f4f1ea;outline:1px solid rgba(0,0,0,.55);background:rgba(244,241,234,.1);border-radius:3px;left:0;top:0;width:0;height:0;display:none';
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:500 11.5px/1 Inter,system-ui,sans-serif;letter-spacing:0;color:#f4f1ea;background:#141414;border:1px solid rgba(244,241,234,.18);border-radius:6px;padding:5px 7px;white-space:nowrap;display:none;max-width:320px;overflow:hidden;text-overflow:ellipsis';
  document.documentElement.append(box, tag);
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  let cur = null;
  const place = () => {
    if (!cur || !cur.isConnected) { box.style.display = tag.style.display = 'none'; return; }
    const r = cur.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const cls = [...cur.classList].slice(0, 2).map((c) => '.' + c).join('');
    tag.textContent = cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : cls) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    tag.style.display = 'block';
    const th = 24;
    tag.style.left = Math.max(4, Math.min(innerWidth - tag.offsetWidth - 4, r.left)) + 'px';
    tag.style.top = (r.top - th - 4 >= 4 ? r.top - th - 4 : Math.min(innerHeight - th - 4, r.bottom + 4)) + 'px';
  };
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tag || el === cur) return;
    cur = el;
    place();
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick'];
  const done = (v) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', place, true);
    for (const t of BLOCKED) window.removeEventListener(t, block, true);
    box.remove(); tag.remove();
    document.documentElement.style.cursor = prevCursor;
    try { delete window.__sablePick; } catch (e) {}
    // Two frames, so the outline is gone from the picture taken next.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(v)));
  };
  const click = (e) => {
    block(e);
    const el = cur || e.target;
    if (!el || el.nodeType !== 1) return done(null);
    const r = el.getBoundingClientRect();
    done({
      selector: path(el),
      what: describe(el),
      tag: el.tagName.toLowerCase(),
      text: secret(el) ? '' : clip(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || '', 240),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      vw: innerWidth, vh: innerHeight,
    });
  };
  const key = (e) => { if (e.key === 'Escape') { block(e); done(null); } };
  Object.defineProperty(window, '__sablePick', { value: () => done(null), configurable: true, enumerable: false });
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('scroll', place, true);
  for (const t of BLOCKED) window.addEventListener(t, block, true);
})`;

export const pickCancelScript = `(() => { if (window.__sablePick) window.__sablePick(); return true; })()`;

/* ── sign-ins: Sable fills a form the agent named, the agent never sees a value ── */

/**
 * Not the tab's own page: a frame inside it. In the desktop app the page is the top document of its
 * view; in the dev build's frame (dev-frame.ts) it sits one level under the app, so its parent is the top.
 */
const topJs = (inDevFrame: boolean) => (inDevFrame ? 'window.parent !== window.top || window === window.top' : 'window.top !== window');

/** The fields of a sign-in, by their snapshot references. */
export interface SignInRefs {
  userRef: string;
  passRef: string;
  submitRef?: string;
}

/**
 * Checks the fields the agent named before anything is shown or filled: the page is the top page
 * (never a frame), each reference is an element of this document (a frame's element, of whatever
 * origin, never is), the user name is a text field, the password a password field, both in the same
 * form when they are in one, the submit control (if named) in that form or a button. Answers where
 * they stand for the pointer, never a value.
 */
export function signInProbeScript(r: SignInRefs, inDevFrame = false): string {
  return `(() => {${PRELUDE}
  if (${topJs(inDevFrame)}) return { error: 'Sable signs in only on the page itself, never inside a frame.' };
  const q = ${j(r)};
  const user = byRef(q.userRef), pass = byRef(q.passRef), sub = q.submitRef ? byRef(q.submitRef) : null;
  if (!user || !pass || (q.submitRef && !sub)) return { error: 'A reference no longer points at an element. Take a new browser_snapshot.' };
  for (const el of [user, pass, sub]) if (el && el.ownerDocument !== document) return { error: 'Sable signs in only on the page itself, never inside a frame.' };
  if (pass.tagName !== 'INPUT' || pass.type !== 'password') return { error: q.passRef + ' is not a password field.' };
  if (user.tagName !== 'INPUT' || !/^(text|email|tel|search|)$/.test(user.type || '') ) return { error: q.userRef + ' is not a user name field.' };
  if (user === pass) return { error: 'The user name and the password must be two fields.' };
  if (user.disabled || user.readOnly || pass.disabled || pass.readOnly) return { error: 'The sign-in form cannot be filled right now.' };
  if (!shown(user) || !shown(pass)) return { error: 'The sign-in form is not visible on the page.' };
  if (user.form && pass.form && user.form !== pass.form) return { error: 'The two fields belong to different forms.' };
  if (sub && !(sub.form && sub.form === pass.form) && roleOf(sub) !== 'button') return { error: q.submitRef + ' is not a button of the sign-in form.' };
  return { origin: location.origin, user: rectOf(user), pass: rectOf(pass), submit: sub ? rectOf(sub) : null, vw: innerWidth, vh: innerHeight };
})()`;
}

/**
 * Fills and submits in one task, so no script of the page runs between the fill and the submit
 * other than what the page itself attached to these fields (it is the site the password is for).
 * The origin is checked again here, at the moment of filling: a page that moved to another site
 * since the card was shown gets nothing. The filled field is remembered (out of sight of a plain
 * enumeration) so the tab can tell when it is cleared.
 */
export function signInFillScript(r: SignInRefs, expectOrigin: string, username: string, password: string, inDevFrame = false): string {
  return `(() => {${PRELUDE}
  const q = ${j(r)};
  if (${topJs(inDevFrame)} || location.origin !== ${j(expectOrigin)}) return { error: 'moved' };
  const user = byRef(q.userRef), pass = byRef(q.passRef), sub = q.submitRef ? byRef(q.submitRef) : null;
  if (!user || !pass || user.ownerDocument !== document || pass.ownerDocument !== document || pass.type !== 'password') return { error: 'gone' };
  const set = (el, v) => {
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set(user, ${j(username)});
  set(pass, ${j(password)});
  Object.defineProperty(window, '__sableFilled', { value: new WeakRef(pass), enumerable: false, configurable: true });
  if (sub && !sub.disabled) sub.click();
  else if (pass.form) { if (pass.form.requestSubmit) pass.form.requestSubmit(); else pass.form.submit(); }
  else {
    const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    pass.dispatchEvent(new KeyboardEvent('keydown', k));
    pass.dispatchEvent(new KeyboardEvent('keyup', k));
  }
  return { ok: true };
})()`;
}

/**
 * Where the filled password field is now: gone (removed, hidden, or the page moved on) means the
 * sign-in went through; still there, holding the value, means the page has not accepted it (yet).
 * `cleared`: the field Sable filled is empty or gone, so the page no longer holds the password.
 * An unknown answer (the mark is missing) is never read as cleared.
 */
export const signInCheckScript = `(() => {
  const w = window.__sableFilled;
  if (!w) return { unknown: true };
  const el = w.deref();
  if (!el || !el.isConnected) return { gone: true, cleared: true };
  const r = el.getBoundingClientRect();
  const hidden = r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden';
  return { gone: hidden, cleared: !el.value };
})()`;
