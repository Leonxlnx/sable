import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, SessionMeta, TextItem, ToolItem, TurnCapture, UserItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { capBoxes, diffRegions, mergeNear, toPixels, type Thumb } from '../server/services/capture-diff';
import { DESKTOP, PHONE, type Capturer, type Picture, type ShootResult } from '../server/services/capture-browser';
import { CaptureService, leadOf, localPages, namedInTurn, samePage } from '../server/services/capture';

// ───────────────────────────── pictures ─────────────────────────────

const W = 60;
const H = 40;

function thumb(fill: [number, number, number] = [240, 240, 240], w = W, h = H): Thumb {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 3);
  return { w, h, data };
}

function paint(t: Thumb, x: number, y: number, w: number, h: number, rgb: [number, number, number]): Thumb {
  const data = t.data.slice();
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set(rgb, (yy * t.w + xx) * 3);
  return { ...t, data };
}

describe('diffRegions', () => {
  it('finds nothing between equal pictures', () => {
    const a = paint(thumb(), 5, 5, 10, 4, [20, 20, 20]);
    expect(diffRegions(a, a)).toEqual({ boxes: [], changed: 0 });
  });

  it('boxes one changed area tightly', () => {
    const a = thumb();
    const b = paint(a, 10, 8, 12, 5, [30, 90, 200]);
    const { boxes, changed } = diffRegions(a, b);
    expect(boxes).toEqual([{ x: 10, y: 8, w: 12, h: 5 }]);
    expect(changed).toBeCloseTo((12 * 5) / (W * H), 5);
  });

  it('keeps two distant areas apart, largest first', () => {
    const a = thumb();
    const b = paint(paint(a, 2, 2, 4, 3, [0, 0, 0]), 40, 25, 15, 10, [0, 0, 0]);
    expect(diffRegions(a, b).boxes).toEqual([
      { x: 40, y: 25, w: 15, h: 10 },
      { x: 2, y: 2, w: 4, h: 3 },
    ]);
  });

  it('joins the letters of a changed line into one area', () => {
    const a = thumb();
    let b = a;
    // Five "glyphs" two cells apart.
    for (let i = 0; i < 5; i++) b = paint(b, 10 + i * 4, 10, 2, 3, [10, 10, 10]);
    expect(diffRegions(a, b).boxes).toEqual([{ x: 10, y: 10, w: 18, h: 3 }]);
  });

  it('sees a colour change of equal brightness', () => {
    // Blue to orange of about the same luminance: one channel moves a lot.
    const a = paint(thumb(), 10, 10, 8, 4, [91, 141, 239]);
    const b = paint(thumb(), 10, 10, 8, 4, [224, 121, 74]);
    expect(diffRegions(a, b).boxes).toHaveLength(1);
  });

  it('ignores noise under the threshold and lone specks', () => {
    const a = thumb();
    let b = paint(a, 0, 0, W, H, [250, 230, 245]); // every cell moved by 10 at most
    b = paint(b, 30, 20, 1, 1, [0, 0, 0]); // one dead pixel
    expect(diffRegions(a, b)).toEqual({ boxes: [], changed: 0 });
  });

  it('caps the number of boxes by merging the closest', () => {
    const a = thumb([255, 255, 255], 100, 20);
    let b = a;
    for (let i = 0; i < 10; i++) b = paint(b, i * 10, 5, 3, 3, [0, 0, 0]);
    const { boxes } = diffRegions(a, b, { max: 4 });
    expect(boxes.length).toBe(4);
    // Every changed cell is still inside some box.
    for (let i = 0; i < 10; i++) expect(boxes.some((bx) => bx.x <= i * 10 && bx.x + bx.w >= i * 10 + 3)).toBe(true);
  });

  it('treats pictures of different sizes as all changed', () => {
    expect(diffRegions(thumb(), thumb(undefined, 30, 20)).boxes).toEqual([{ x: 0, y: 0, w: 30, h: 20 }]);
  });

  it('merges near boxes and scales to pixels', () => {
    expect(mergeNear([{ x: 0, y: 0, w: 2, h: 2 }, { x: 4, y: 0, w: 2, h: 2 }], 2)).toEqual([{ x: 0, y: 0, w: 6, h: 2 }]);
    expect(capBoxes([{ x: 0, y: 0, w: 1, h: 1 }, { x: 50, y: 0, w: 1, h: 1 }, { x: 2, y: 0, w: 1, h: 1 }], 2)).toHaveLength(2);
    expect(toPixels([{ x: 0, y: 2, w: 3, h: 1 }], 4, 4, 100, 100)).toEqual([{ x: 0, y: 4, w: 16, h: 12 }]);
    expect(toPixels([{ x: 20, y: 20, w: 10, h: 10 }], 4, 4, 100, 100)).toEqual([{ x: 76, y: 76, w: 24, h: 24 }]);
  });
});

describe('pages in text', () => {
  it('finds local pages with a port, first mention first', () => {
    expect(localPages('Local: http://localhost:5173/ and http://127.0.0.1:3000/x. Not https://example.com')).toEqual(['http://localhost:5173/', 'http://127.0.0.1:3000/x']);
    expect(localPages('http://localhost/ has no port; http://app.localhost does not need one')).toEqual(['http://app.localhost/']);
    expect(localPages('0.0.0.0 means localhost: http://0.0.0.0:8080')).toEqual(['http://localhost:8080/']);
  });
});

// ───────────────────────────── scheduling ─────────────────────────────

interface Shot {
  url: string;
  phone: boolean | 'auto';
  at: number;
}

/** A pretend browser: each page is a plain picture whose painted block follows `look[url]`. */
class FakeCapturer implements Capturer {
  shots: Shot[] = [];
  look = new Map<string, number>();
  responsive = false;
  /** When set, the next capture waits for it. */
  gate?: Promise<void>;
  /** When a picture says it was taken, relative to now (a moment ago by default). */
  lateBy = -5;
  disposed = false;

  async shoot(url: string, opts: { phone?: boolean | 'auto' } = {}): Promise<ShootResult> {
    const gate = this.gate;
    this.gate = undefined;
    if (gate) await gate;
    const n = this.look.get(url) ?? 0;
    const at = Date.now() + this.lateBy;
    this.shots.push({ url, phone: opts.phone ?? false, at });
    const picture = (view: typeof DESKTOP): Picture => ({ view, jpeg: Buffer.from(`jpeg ${url} ${n} ${view.kind}`), thumb: paint(thumb(), 5, 5, 6 + n * 8, 4, [n * 60, 20, 200 - n * 50]), at });
    const phone = opts.phone === true || (opts.phone === 'auto' && this.responsive);
    return { pictures: phone ? [picture(DESKTOP), picture(PHONE)] : [picture(DESKTOP)], responsive: this.responsive };
  }

  async dispose() {
    this.disposed = true;
  }
}

const PAGE = 'http://localhost:4321/';

function meta(id: string): SessionMeta {
  return { id, provider: 'demo', cwd: '/tmp/x', title: 'x', titleSource: 'auto', model: 'demo', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: {} } as unknown as SessionMeta;
}

describe('CaptureService', () => {
  let dir: string;
  let fake: FakeCapturer;
  let svc: CaptureService;
  let events: BridgeEvent[];
  let rt: SessionRuntime;
  let shown: string | undefined;
  let up: boolean;

  const captures = () => events.filter((e): e is Extract<BridgeEvent, { type: 'capture.updated' }> => e.type === 'capture.updated').map((e) => e.capture);
  const last = (): TurnCapture => captures().at(-1)!;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sable-capture-test-'));
    fake = new FakeCapturer();
    events = [];
    shown = undefined;
    up = true;
    const sessions = new Map<string, SessionRuntime>();
    svc = new CaptureService(
      {
        dir,
        items: (id) => sessions.get(id)?.items ?? [],
        item: (sid, id) => sessions.get(sid)?.get(id),
        page: () => shown,
        sessions: () => [...sessions.keys()],
        emit: (e) => events.push(e),
        log: () => {},
      },
      () => fake,
      { settleMs: 0, probe: async () => up },
    );
    rt = new SessionRuntime(
      meta('s1'),
      (e) => {
        events.push(e);
        svc.feed(e);
      },
      () => {},
    );
    sessions.set('s1', rt);
  });

  afterEach(async () => {
    await svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One turn: a message, optional steps, an edit, the answer. */
  async function turn(opts: { say?: string; command?: string; edit?: boolean; beforeEdit?: () => Promise<void> | void; afterEdit?: () => void } = {}) {
    const user = rt.add<UserItem>({ type: 'user', text: 'change the page', state: 'sent' });
    rt.beginTurn();
    if (opts.command !== undefined) {
      const cmd = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Serve', status: 'running', detail: { command: 'serve' } });
      rt.patch<ToolItem>(cmd.id, { status: 'done', endedAt: Date.now(), result: { text: opts.command } });
    }
    // The agent works a while before its first edit: whatever capture started is done by then.
    await (opts.beforeEdit ? opts.beforeEdit() : svc.idle());
    if (opts.edit !== false) {
      const ed = rt.add<ToolItem>({ type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit index.html', status: 'running', detail: { path: '/tmp/x/index.html' } });
      rt.patch<ToolItem>(ed.id, { status: 'done', endedAt: Date.now() });
      fake.look.set(PAGE, (fake.look.get(PAGE) ?? 0) + 1);
      opts.afterEdit?.();
    }
    const text = rt.add<TextItem>({ type: 'text', text: '', streaming: true });
    rt.patch<TextItem>(text.id, { text: opts.say ?? 'Done.', streaming: false });
    rt.endTurn();
    await svc.idle();
    return user.id;
  }

  it('takes the before when the turn starts on a known page, and the after at its end', async () => {
    shown = PAGE;
    const turnId = await turn();
    expect(fake.shots.map((s) => s.url)).toEqual([PAGE, PAGE]);
    const c = last();
    expect(c).toMatchObject({ turnId, url: PAGE, state: 'ready' });
    expect(c.noBefore).toBeUndefined();
    expect(c.views).toHaveLength(1);
    const v = c.views[0];
    expect(v).toMatchObject({ kind: 'desktop', width: 1440, height: 900 });
    expect(v.before && v.after).toBeTruthy();
    expect(v.regions!.length).toBe(1);
    expect(v.changed).toBeGreaterThan(0);
    // Announced while capturing, then ready; pictures on disk and served.
    expect(captures().map((x) => x.state)).toEqual(['capturing', 'ready']);
    expect(readdirSync(path.join(dir, 's1')).filter((f) => f.endsWith('.jpg'))).toHaveLength(2);
    expect(svc.image('s1', v.after!.id)).toMatch(/^data:image\/jpeg;base64,/);
    expect(svc.list('s1')).toEqual([c]);
  });

  it('takes the before when a page is first named, before any edit', async () => {
    await turn({ command: `  Local: ${PAGE}` });
    expect(fake.shots).toHaveLength(2);
    expect(last().views[0].before).toBeTruthy();
    expect(last().noBefore).toBeUndefined();
  });

  it('offers nothing when the page is named only after the edit: no before, so no picture at all', async () => {
    await turn({ say: `It is at ${PAGE}` });
    expect(fake.shots).toHaveLength(0);
    expect(captures()).toHaveLength(0);
    expect(svc.list('s1')).toEqual([]);
    // The page is known from here on: the next turn has its before and its after.
    await turn();
    expect(last()).toMatchObject({ state: 'ready' });
    expect(last().views[0].before && last().views[0].after).toBeTruthy();
  });

  it('a before taken after the first edit landed is no before: nothing is offered', async () => {
    shown = PAGE;
    fake.lateBy = 60_000;
    await turn({ beforeEdit: () => {} });
    // The late before was shot; no after is taken for it.
    expect(fake.shots).toHaveLength(1);
    expect(captures()).toHaveLength(0);
  });

  it('captures nothing for a turn that changed no files, but remembers its page for the next turn', async () => {
    await turn({ edit: false, say: `Serving at ${PAGE}` });
    expect(fake.shots).toHaveLength(1); // the before, named before any edit
    expect(captures()).toHaveLength(0);
    // The next turn starts with the page known: the before is taken at once.
    let started = 0;
    await turn({
      beforeEdit: async () => {
        await svc.idle();
        started = fake.shots.length;
      },
    });
    expect(started).toBe(2);
    expect(last().views[0].before).toBeTruthy();
  });

  it('never captures pages that are not local, and nothing at all without a page', async () => {
    shown = 'https://example.com/';
    await turn({ say: 'Changed https://example.com/' });
    expect(fake.shots).toHaveLength(0);
    expect(captures()).toHaveLength(0);
  });

  it('does not start a browser for a page nobody serves', async () => {
    up = false;
    await turn({ say: `It is at ${PAGE}` });
    expect(fake.shots).toHaveLength(0);
    expect(captures()).toHaveLength(0);
  });

  it('captures the phone size too when the page is responsive', async () => {
    shown = PAGE;
    fake.responsive = true;
    await turn();
    expect(last().views.map((v) => v.kind)).toEqual(['desktop', 'phone']);
    expect(last().views[1]).toMatchObject({ width: 390, height: 844, scale: 2 });
    expect(last().views.every((v) => v.before && v.after)).toBe(true);
  });

  it('keeps the last turns only, and removes everything with the session', async () => {
    const small = new CaptureService(
      { dir, items: () => rt.items, item: (_s, id) => rt.get(id), page: () => PAGE, sessions: () => ['s1'], emit: () => {}, log: () => {} },
      () => fake,
      { settleMs: 0, maxTurns: 2, probe: async () => true },
    );
    svc = small;
    for (let i = 0; i < 3; i++) await turn();
    expect(small.list('s1')).toHaveLength(2);
    expect(readdirSync(path.join(dir, 's1')).filter((f) => f.endsWith('.jpg'))).toHaveLength(4);
    small.feed({ type: 'session.removed', id: 's1' });
    expect(existsSync(path.join(dir, 's1'))).toBe(false);
  });

  it('uses the before of the same page under another loopback name', async () => {
    shown = PAGE;
    await turn({ say: 'See http://127.0.0.1:4321/' });
    expect(last().url).toBe('http://127.0.0.1:4321/');
    expect(last().views[0].before).toBeTruthy();
    expect(samePage('http://localhost:4321/', 'http://[::1]:4321')).toBe(true);
    expect(samePage('http://localhost:4321/', 'http://localhost:4322/')).toBe(false);
  });

  it('finds the turn and the pages it named', () => {
    const items = [
      { id: 'u1', ts: 1, type: 'user', text: 'a', state: 'sent' },
      { id: 't1', ts: 2, type: 'text', text: 'old http://localhost:1111/', streaming: false },
      { id: 'u2', ts: 3, type: 'user', text: 'b', state: 'sent' },
      { id: 'b2', ts: 4, type: 'tool', name: 'Bash', kind: 'bash', title: 'x', status: 'done', detail: {}, output: 'Local: http://localhost:2222/' },
      { id: 't2', ts: 5, type: 'text', text: 'See http://localhost:3333/', streaming: false },
      { id: 'q', ts: 6, type: 'user', text: 'later', state: 'queued' },
    ] as const;
    expect(leadOf(items as never)).toBe('u2');
    expect(namedInTurn(items as never, 'u2')).toEqual(['http://localhost:3333/', 'http://localhost:2222/']);
  });
});
