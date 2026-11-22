import { GLASS, INK, SHADOW, frameBounds, inkAt, lerp, type LiquidFrame, type Taper } from './liquid-shape';

/**
 * Draws liquid frames (liquid-shape.ts) onto a canvas: in the worker (liquid.worker.ts) or, where
 * there is none, on the page (liquid.ts).
 *
 * WebGL: the liquid is a signed distance field evaluated per pixel. The drop, the two pieces of
 * its thread and the sheet are an ellipse, two tapers and a rounded box, united with each other
 * and with the send key's disc by smooth minimums, so the collar on the key, the thread that
 * thins and parts, what falls back into the key and the drop running into the sheet are one
 * continuous skin, crisp at any size.
 *
 * On it, the look. As the card: its ink (with a static grain like the page's), its inner hairline
 * and one soft shadow. In the air: glass. The skin is rounded in from its rim (`lens` px deep: a
 * dome on the drop, a bevel on the spreading sheet), and from that roundness come a small sharp
 * highlight up and to the left, light along the rim, a glow through to the far side, and the bend:
 * what is behind the drop (a still of the backdrop's field, handed over at the send) is drawn
 * through it displaced toward its middle, so the field's own colours curl along its edge. There is
 * no colour of its own in it. Only the region a frame covers is shaded (a scissored quad), and
 * nothing is drawn when nothing is in the air.
 *
 * Canvas 2D (no WebGL): the same shapes as paths, without the meniscus and the bend.
 */

/** A still of what is behind the liquid: the field's canvas, where it stands (page px), its cell size (0: not a grid) and its strength. */
export interface Backdrop {
  bitmap: ImageBitmap;
  x: number;
  y: number;
  w: number;
  h: number;
  cell: number;
  a: number;
}

export interface LiquidRenderer {
  /**
   * Clears the canvas and draws the frames (each through its backdrop, if it has one); `origin` is
   * where the canvas's top-left stands (page px). `lite` sheds the detail that costs (the bend and
   * the soft shadow) and keeps the shapes and their light.
   */
  draw(items: { f: LiquidFrame; back?: number }[], origin: { x: number; y: number }, lite?: boolean): void;
  /** Takes a backdrop (the bitmap is closed here); the handle goes with a frame. 0: not supported. */
  backdrop(b: Backdrop): number;
  release(handle: number): void;
  /** Clears the canvas. */
  clear(): void;
  /** False once the GPU context is gone (the caller falls back). */
  ok(): boolean;
  /** Lets go of the GPU context (a canvas no longer used). */
  dispose(): void;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const n3 = (v: [number, number, number]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return `vec3(${(v[0] / l).toFixed(4)}, ${(v[1] / l).toFixed(4)}, ${(v[2] / l).toFixed(4)})`;
};

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uOrigin;
uniform float uScale;
uniform float uH;
uniform vec4 uDrop;
uniform vec3 uDropS;
uniform vec4 uSheet;
uniform vec4 uRadii;
uniform vec4 uEdge;
uniform vec2 uEdgeX;
uniform vec4 uFoot;
uniform vec4 uTail;
uniform vec4 uTaper;
uniform float uJoin;
uniform float uLens;
uniform vec4 uInk;
uniform vec4 uLook;
uniform float uSettle;
uniform sampler2D uBack;
uniform vec4 uBackRect;
uniform vec2 uBackLook;
uniform float uLite;
out vec4 outColor;

const vec3 LIGHT = ${n3(GLASS.light)};
const vec3 IVORY = vec3(0.949, 0.945, 0.933);

float sdBox(vec2 p, vec2 c, vec2 b, vec4 r) {
  vec2 q = p - c;
  float rr = q.x > 0.0 ? (q.y > 0.0 ? r.z : r.y) : (q.y > 0.0 ? r.w : r.x);
  rr = min(rr, min(b.x, b.y));
  vec2 d = abs(q) - b + rr;
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rr;
}

float sdDrop(vec2 p) {
  vec2 q = p - uDrop.xy;
  float cs = cos(uDropS.z);
  float sn = sin(uDropS.z);
  vec2 l = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  vec2 ab = uDrop.z * uDropS.xy;
  float k0 = length(l / ab);
  float k1 = length(l / (ab * ab));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

// A taper: a round cone from a (radius r1) to b (radius r2).
float sdTaper(vec2 p, vec2 a, vec2 b, float r1, float r2) {
  vec2 ba = b - a;
  float h = length(ba);
  if (h < 0.05) return length(p - a) - max(r1, r2);
  vec2 u = ba / h;
  vec2 q = p - a;
  vec2 l = vec2(abs(q.x * u.y - q.y * u.x), dot(q, u));
  float bb = clamp((r1 - r2) / h, -0.999, 0.999);
  float aa = sqrt(1.0 - bb * bb);
  float k = dot(l, vec2(-bb, aa));
  if (k < 0.0) return length(l) - r1;
  if (k > aa * h) return length(l - vec2(0.0, h)) - r2;
  return dot(l, vec2(aa, bb)) - r1;
}

float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// What the drop is tied to: the key's disc (uEdgeX.y: its radius, hanging under its top point), or
// a straight edge (radius 0: everything under the line).
float sdKey(vec2 p) {
  return uEdgeX.y > 0.0 ? length(p - vec2(uEdgeX.x, uEdge.x + uEdgeX.y)) - uEdgeX.y : uEdge.x - p.y;
}

// What stands on it: the key itself, the thread's foot running out of it, a straight edge's one small swell after.
float sdEdge(vec2 p) {
  float e = sdKey(p);
  if (uTaper.x > 0.0) e = smin(e, sdTaper(p, vec2(uEdgeX.x, uEdge.x), uFoot.zw, uTaper.x, uTaper.y), 6.0);
  if (uEdge.w > 0.0) e = smin(e, length(p - vec2(uEdgeX.x, uEdge.x + 18.0 - uEdge.w)) - 18.0, 3.0);
  return e;
}

float sdAir(vec2 p) {
  float d = 1e5;
  if (uDrop.w > 0.5) d = sdDrop(p);
  if (uTaper.z > 0.0) d = smin(d, sdTaper(p, uTail.xy, uTail.zw, uTaper.z, uTaper.w), 7.0);
  if (uSheet.z > uSheet.x) {
    vec2 c = (uSheet.xy + uSheet.zw) * 0.5;
    vec2 b = (uSheet.zw - uSheet.xy) * 0.5;
    d = smin(d, sdBox(p, c, b, uRadii), uJoin);
  }
  return d;
}

float scene(vec2 p) {
  float d = sdAir(p);
  if (uEdge.z > 0.5) d = smin(d, sdEdge(p), uEdge.y);
  return d;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// The field behind, at a page point: its cells as the page shows them (hairline gaps between them).
vec3 field(vec2 q) {
  vec2 l = q - uBackRect.xy;
  vec2 uv = l / uBackRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
  vec3 c = texture(uBack, uv).rgb;
  if (uBackLook.y > 0.0) {
    vec2 m = mod(l, uBackLook.y);
    c *= 1.0 - 0.42 * max(step(m.x, 1.0), step(m.y, 1.0));
  }
  return c;
}

void main() {
  vec2 p = uOrigin + vec2(gl_FragCoord.x, uH - gl_FragCoord.y) / uScale;
  float d = scene(p);
  vec2 g = vec2(dFdx(d), -dFdy(d));
  vec2 n = g / max(length(g), 1e-5);
  // Coverage of the ink and of its 1 px inner hairline, smoothed over one device pixel.
  float cov = clamp(0.5 - d * uScale, 0.0, 1.0);
  float inner = clamp(0.5 - (d + 1.0) * uScale, 0.0, 1.0);
  // Tied to the key: what is drawn is what the union adds to the key (the key itself is the
  // page's, and stays a clean disc), so nothing lines its edge away from the drop. On a straight
  // edge the ink runs on over the edge's own hairline under the meniscus, so the drop rises out
  // of it, not onto it.
  float de = uEdge.z > 0.5 ? sdKey(p) : 1e5;
  float ce = clamp(0.5 - de * uScale, 0.0, 1.0);
  float ie = clamp(0.5 - (de + 1.0) * uScale, 0.0, 1.0);
  float foot = 0.0;
  if (uEdge.z > 0.5 && uEdgeX.y <= 0.0) {
    float band = clamp((uEdge.x + 1.5 - p.y) * uScale + 0.5, 0.0, 1.0) * ce;
    foot = clamp(0.5 - scene(vec2(p.x, uEdge.x - 0.75)) * uScale, 0.0, 1.0) * band;
  }
  float rim = max((cov - inner) - (ce - ie), 0.0);
  // What still clings to the key (the collar, the thread's foot) is plain ink: the liquid turns
  // to glass as it rises clear of it.
  float glass = uLook.x * (uEdge.z > 0.5 ? smoothstep(1.0, 10.0, de) : 1.0);
  // The card's hairline, a little brighter on top while it is still liquid.
  float up = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);
  float rimA = mix(uLook.y, uLook.y + (uLook.z - uLook.y) * up * up, glass);

  // Glass: the skin is rounded in from its rim, uLens px deep (s: 1 on the rim, 0 where it is flat).
  float s = 1.0 - clamp(-d / max(uLens, 0.5), 0.0, 1.0);
  vec3 N = vec3(n * s, sqrt(max(1.0 - s * s, 0.0)));
  float nh = max(dot(N, normalize(LIGHT + vec3(0.0, 0.0, 1.0))), 0.0);
  float toward = dot(n, normalize(LIGHT.xy));
  // A small sharp highlight and a wide faint one, light along the rim (more where it faces the
  // light), and a glow inside the far side, where the light comes back out.
  float spec = pow(nh, ${GLASS.gloss.toFixed(1)}) * ${GLASS.spec.toFixed(2)} + pow(nh, 7.0) * ${GLASS.sheen.toFixed(2)} * smoothstep(0.0, 0.4, s);
  float edge = (1.0 - smoothstep(0.0, 2.4, -d)) * s * (0.22 + 0.78 * max(toward, 0.0)) * ${GLASS.rim.toFixed(2)};
  float glow = pow(max(-toward, 0.0), 2.0) * s * (1.0 - s) * 4.0 * ${GLASS.glow.toFixed(2)} * smoothstep(3.0, 9.0, uLens);
  float lit = glass * (spec + edge + glow);

  float grain = max(0.0, 0.05 * hash(floor(p)) - 0.036);
  vec3 ink = uInk.rgb + vec3(grain);
  float body = max(max(cov - ce, 0.0), foot);
  float mixed = clamp(rimA * rim / max(body, 1e-4) + lit, 0.0, 1.0);
  vec3 col = mix(ink, IVORY, mixed);
  float a = mix(uInk.a, 1.0, mixed);
  // The bend: the field behind, drawn through the glass from further out (so it curls along the rim).
  vec3 through = vec3(0.0);
  // Only through the drop's dome: a sheet that has flattened is the card's ink, not a window.
  float dome = glass * smoothstep(4.0, 9.0, uLens);
  if (uBackLook.x > 0.0 && dome > 0.0) through = field(p + n * s * s * uLens * ${GLASS.bend.toFixed(2)}) * uBackLook.x * dome * ${GLASS.pass.toFixed(2)} * (1.0 - mixed);
  float shapeA = body * a;
  // One soft shadow, below: the ink's own (not the bar's), and none on the bar. It goes as the
  // sheet settles: the card it becomes is a well and casts nothing (through its thin ink a
  // shadow would show as a darker lower half).
  float sh = 0.0;
  if (uLite < 0.5 && uSettle < 1.0) {
    vec2 q = p - vec2(0.0, ${SHADOW.y.toFixed(1)});
    float ds = sdAir(q) + ${(SHADOW.blur * 0.25).toFixed(1)};
    sh = (1.0 - smoothstep(-${(SHADOW.blur * 0.5).toFixed(1)}, ${(SHADOW.blur * 0.5).toFixed(1)}, ds)) * ${SHADOW.a.toFixed(2)} * (1.0 - ce) * (1.0 - uSettle);
  }
  float outA = shapeA + sh * (1.0 - shapeA);
  outColor = vec4(min(col * shapeA + through * body, vec3(1.0)), outA) * uLook.w;
}`;

/** A WebGL renderer, or null where WebGL2 is missing. */
function glRenderer(canvas: AnyCanvas, scale: number): LiquidRenderer | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl!.createShader(type);
    if (!s) return null;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
      if (import.meta.env?.DEV) console.error('liquid shader', gl!.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (name: string) => gl!.getUniformLocation(prog, name);
  const U = {
    origin: u('uOrigin'),
    scale: u('uScale'),
    h: u('uH'),
    drop: u('uDrop'),
    dropS: u('uDropS'),
    sheet: u('uSheet'),
    radii: u('uRadii'),
    edge: u('uEdge'),
    edgeX: u('uEdgeX'),
    foot: u('uFoot'),
    tail: u('uTail'),
    taper: u('uTaper'),
    join: u('uJoin'),
    lens: u('uLens'),
    ink: u('uInk'),
    look: u('uLook'),
    settle: u('uSettle'),
    back: u('uBack'),
    backRect: u('uBackRect'),
    backLook: u('uBackLook'),
    lite: u('uLite'),
  };
  gl.uniform1i(U.back, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  let lost = false;
  const target = canvas as unknown as EventTarget;
  target.addEventListener?.('webglcontextlost', () => (lost = true));
  // No backdrop: one clear texel, so the sampler always has something bound.
  const none = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, none);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const backs = new Map<number, { tex: WebGLTexture; b: Omit<Backdrop, 'bitmap'> }>();
  let nextBack = 0;

  const clear = () => {
    if (lost || !gl) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  clear();
  const taper = (t: Taper | undefined) => (t ? [t.ra, t.rb] : [0, 0]);
  const renderer: LiquidRenderer = {
    ok: () => !lost && !!gl && !gl.isContextLost(),
    dispose() {
      lost = true;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
    },
    clear,
    backdrop(b) {
      const { bitmap, ...rest } = b;
      const tex = !lost && gl ? gl.createTexture() : null;
      if (!gl || !tex) {
        bitmap.close();
        return 0;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      const f = rest.cell > 0 ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bitmap.close();
      const id = ++nextBack;
      backs.set(id, { tex, b: rest });
      return id;
    },
    release(handle) {
      const k = backs.get(handle);
      if (!k) return;
      backs.delete(handle);
      gl?.deleteTexture(k.tex);
    },
    draw(items, origin, lite = false) {
      if (lost || !gl) return;
      clear();
      gl.uniform1f(U.lite, lite ? 1 : 0);
      const W = canvas.width;
      const H = canvas.height;
      gl.enable(gl.SCISSOR_TEST);
      gl.uniform2f(U.origin, origin.x, origin.y);
      gl.uniform1f(U.scale, scale);
      gl.uniform1f(U.h, H);
      for (const { f, back } of items) {
        const b = frameBounds(f);
        if (!b) continue;
        // The frame's region in device px (y up), inside the canvas.
        const x0 = Math.max(0, Math.floor((b.x0 - origin.x) * scale));
        const x1 = Math.min(W, Math.ceil((b.x1 - origin.x) * scale));
        const y0 = Math.max(0, Math.floor((b.y0 - origin.y) * scale));
        const y1 = Math.min(H, Math.ceil((b.y1 - origin.y) * scale));
        if (x1 <= x0 || y1 <= y0) continue;
        gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
        const d = f.drop;
        gl.uniform4f(U.drop, d?.x ?? 0, d?.y ?? 0, d?.r ?? 1, d ? 1 : 0);
        gl.uniform3f(U.dropS, d?.sx ?? 1, d?.sy ?? 1, d?.ang ?? 0);
        const s = f.sheet;
        if (s) {
          gl.uniform4f(U.sheet, s.left, s.top, s.right, s.bottom);
          gl.uniform4f(U.radii, s.radii[0], s.radii[1], s.radii[2], s.radii[3]);
        } else gl.uniform4f(U.sheet, 0, 0, 0, 0);
        gl.uniform4f(U.edge, f.edge?.y ?? 0, f.edge?.k ?? 0, f.edge ? 1 : 0, f.edge?.bob ?? 0);
        gl.uniform2f(U.edgeX, f.edge?.x ?? 0, f.edge?.r ?? 0);
        gl.uniform4f(U.foot, f.foot?.ax ?? 0, f.foot?.ay ?? 0, f.foot?.bx ?? 0, f.foot?.by ?? 0);
        gl.uniform4f(U.tail, f.tail?.ax ?? 0, f.tail?.ay ?? 0, f.tail?.bx ?? 0, f.tail?.by ?? 0);
        const tf = taper(f.edge ? f.foot : undefined);
        const tt = taper(f.tail);
        gl.uniform4f(U.taper, tf[0], tf[1], tt[0], tt[1]);
        gl.uniform1f(U.join, f.join);
        gl.uniform1f(U.lens, f.lens);
        const c = inkAt(f.light, f.settle);
        gl.uniform4f(U.ink, c[0] / 255, c[1] / 255, c[2] / 255, c[3]);
        gl.uniform1f(U.settle, f.settle ?? 0);
        gl.uniform4f(U.look, f.light, INK.rim, INK.lit, f.alpha);
        const k = back && !lite ? backs.get(back) : undefined;
        gl.bindTexture(gl.TEXTURE_2D, k ? k.tex : none);
        if (k) {
          gl.uniform4f(U.backRect, k.b.x, k.b.y, k.b.w, k.b.h);
          gl.uniform2f(U.backLook, k.b.a, k.b.cell);
        } else gl.uniform2f(U.backLook, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
  };
  // Drawn once now, a few pixels of everything it can draw (the drop on its thread over the edge,
  // the sheet, a backdrop): a GPU compiles a program when it first runs, and that first run must
  // not be a message's first frame.
  const one = { left: 0, top: 0, right: 4, bottom: 4, radii: [1, 1, 1, 1] as [number, number, number, number] };
  const t: Taper = { ax: 1, ay: 1, bx: 2, by: 3, ra: 1, rb: 0.5 };
  renderer.draw([{ f: { edge: { x: 2, y: 3, k: 2, bob: 1, r: 2 }, drop: { x: 2, y: 2, r: 2, sx: 1.1, sy: 0.9, ang: 0 }, foot: t, tail: t, sheet: one, join: 1, light: 1, lens: 2, alpha: 1, done: false } }], { x: 0, y: 0 });
  gl.finish();
  clear();
  return renderer;
}

/** The 2D fallback: the same shapes as paths (no meniscus, no bend), the ink, its hairline and a highlight on the drop. */
function canvas2d(canvas: AnyCanvas, scale: number): LiquidRenderer | null {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const clear = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  /** A taper as an outline: its two end circles and the band between them. */
  const taper = (p: Path2D, t: Taper) => {
    const dx = t.bx - t.ax;
    const dy = t.by - t.ay;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l;
    p.moveTo(t.ax + nx * t.ra, t.ay + ny * t.ra);
    p.lineTo(t.bx + nx * t.rb, t.by + ny * t.rb);
    p.lineTo(t.bx - nx * t.rb, t.by - ny * t.rb);
    p.lineTo(t.ax - nx * t.ra, t.ay - ny * t.ra);
    p.closePath();
    p.moveTo(t.ax + t.ra, t.ay);
    p.arc(t.ax, t.ay, t.ra, 0, Math.PI * 2);
  };
  return {
    ok: () => true,
    dispose() {
      canvas.width = 1;
      canvas.height = 1;
    },
    clear,
    backdrop(b) {
      b.bitmap.close();
      return 0;
    },
    release() {},
    draw(items, origin) {
      clear();
      ctx.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
      for (const { f } of items) {
        if (f.done || f.alpha <= 0.001) continue;
        const p = new Path2D();
        const d = f.drop;
        if (d) p.ellipse(d.x, d.y, d.r * d.sx, d.r * d.sy, d.ang, 0, Math.PI * 2);
        if (f.foot) taper(p, f.foot);
        if (f.tail) taper(p, f.tail);
        const s = f.sheet;
        if (s) p.roundRect(s.left, s.top, s.right - s.left, s.bottom - s.top, s.radii);
        ctx.save();
        ctx.globalAlpha = f.alpha;
        if (f.edge) {
          // Only outside the key (or above a straight edge).
          ctx.beginPath();
          if (f.edge.r) {
            ctx.rect(-1e5, -1e5, 2e5, 2e5);
            ctx.arc(f.edge.x, f.edge.y + f.edge.r, f.edge.r, 0, Math.PI * 2);
            ctx.clip('evenodd');
          } else {
            ctx.rect(-1e5, -1e5, 2e5, 1e5 + f.edge.y);
            ctx.clip();
          }
        }
        const c = inkAt(f.light, f.settle);
        ctx.fillStyle = `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${c[3].toFixed(3)})`;
        ctx.fill(p, 'nonzero');
        ctx.clip(p, 'nonzero');
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(242, 241, 238, ${lerp(INK.rim, INK.lit * 0.6, f.light).toFixed(3)})`;
        ctx.stroke(p);
        if (d && f.light > 0.05) {
          ctx.fillStyle = `rgba(242, 241, 238, ${(0.7 * f.light).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.42, Math.max(0.8, d.r * 0.13), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },
  };
}

/** A renderer for `canvas` (sized in device px; `scale` device px per page px): WebGL where it can, else 2D. */
export function makeRenderer(canvas: AnyCanvas, scale: number, prefer: 'gl' | '2d' = 'gl'): LiquidRenderer | null {
  return (prefer === 'gl' ? glRenderer(canvas, scale) : null) ?? canvas2d(canvas, scale);
}
