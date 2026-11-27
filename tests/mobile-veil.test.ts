/**
 * Phone 2.22: the dither veil between screens (mobile/src/ui/veil.ts). Each veil stood on four new
 * canvases, filled on the spot: on the emulator the first fill of an accelerated canvas took about
 * 130 ms, three veils a change of screen, 4 s of the main thread over two opens of a chat (phone7's
 * CPU profile). Now a quarter is drawn once into a software canvas and the drawn quarters go from veil
 * to veil: a change of screen after the first draws nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fake = {
  tag: string;
  style: Record<string, string> & { cssText: string };
  children: Fake[];
  parent: Fake | null;
  width: number;
  height: number;
  attrs: Map<string, string>;
};

const count = vi.hoisted(() => ({ canvases: 0, fills: 0, contexts: [] as unknown[] }));

function el(tag: string): Fake & Record<string, unknown> {
  const e: Fake & Record<string, unknown> = {
    tag,
    style: { cssText: '' } as Fake['style'],
    children: [],
    parent: null,
    width: 0,
    height: 0,
    attrs: new Map(),
    className: '',
    clientWidth: 438,
    clientHeight: 973,
    setAttribute(k: string, v: string) {
      e.attrs.set(k, v);
    },
    appendChild(c: Fake) {
      if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
      c.parent = e;
      e.children.push(c);
      return c;
    },
    remove() {
      if (e.parent) e.parent.children = e.parent.children.filter((x) => x !== e);
      e.parent = null;
    },
    animate() {
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      return { finished, cancel: () => {}, finish: () => done() };
    },
    getContext(_kind: string, opts?: unknown) {
      count.contexts.push(opts);
      return {
        fillStyle: '',
        fillRect: () => void count.fills++,
        translate: () => {},
        createPattern: () => ({}),
      };
    },
  };
  if (tag === 'canvas') count.canvases++;
  return e;
}

vi.stubGlobal('document', { createElement: (tag: string) => el(tag) });
vi.stubGlobal('window', { devicePixelRatio: 2.7875, innerWidth: 438, innerHeight: 973 });

const { veil } = await import('../mobile/src/ui/veil');

describe('the veil between screens (2.22)', () => {
  beforeEach(() => {
    count.canvases = 0;
    count.fills = 0;
    count.contexts = [];
  });

  it('draws its quarters once: a change of screen after the first draws nothing', () => {
    const host = el('div') as unknown as HTMLElement;
    // A change of screen: the cover, then the reveal starts while the cover still stands, then the cover goes.
    const change = () => {
      const cover = veil(host, 'cover', { color: '#070708', duration: 80, cell: 4, z: 60 });
      const open = veil(host, 'reveal', { color: '#070708', duration: 130, cell: 4, z: 60 });
      cover.remove();
      open.remove();
    };
    change();
    const first = { canvases: count.canvases, fills: count.fills };
    // Two sets of four quarters (the cover's and the reveal's), each drawn from its 4x4 tile.
    expect(first.canvases).toBe(16);
    expect(first.fills).toBeGreaterThan(0);
    change();
    change();
    expect(count.fills).toBe(first.fills);
    expect(count.canvases).toBe(first.canvases);
  });

  it('draws into software canvases (a few thousand pixels: no GPU surface to set up)', () => {
    const host = el('div') as unknown as HTMLElement;
    veil(host, 'cover', { color: '#101010', duration: 80, cell: 4, z: 60 }).remove();
    expect(count.contexts.length).toBeGreaterThan(0);
    for (const o of count.contexts) expect(o).toMatchObject({ willReadFrequently: true });
  });

  it('a veil in use is never handed to another one at the same time', () => {
    const host = el('div') as unknown as HTMLElement & Fake;
    const a = veil(host, 'cover', { color: '#202020', duration: 80, cell: 4, z: 60 });
    const b = veil(host, 'reveal', { color: '#202020', duration: 130, cell: 4, z: 60 });
    const [va, vb] = (host as unknown as Fake).children;
    const canvasesOf = (v: Fake) => v.children.flatMap((band) => band.children);
    expect(canvasesOf(va)).toHaveLength(4);
    expect(canvasesOf(vb)).toHaveLength(4);
    for (const c of canvasesOf(va)) expect(canvasesOf(vb)).not.toContain(c);
    a.remove();
    b.remove();
  });
});
