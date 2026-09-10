import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shapeMask, largestComponent, traceBoundary, simplifyClosed, dominantColor, outlineOf, renderOutline,
  IMAGE_OUTLINE_TOOL, MAX_OUTLINE_POINTS, DEFAULT_OUTLINE_POINTS, type Bitmap, type Pt,
} from "./image-outline";

// Measured over four runs reproducing a 12-ray icon from a picture: the run
// that traced the pixels was right; of the three that wrote the points by eye,
// one was right, one folded, one put the rays 10-20 degrees off (48% overlap)
// and called it a match. The outline is measured here, on synthesized pixels.

function blank(w: number, h: number, bg: [number, number, number, number]): Bitmap {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { data[i * 4] = bg[2]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[0]; data[i * 4 + 3] = bg[3]; }
  return { width: w, height: h, data };
}
function put(b: Bitmap, x: number, y: number, rgb: [number, number, number]) {
  const i = (y * b.width + x) * 4;
  b.data[i] = rgb[2]; b.data[i + 1] = rgb[1]; b.data[i + 2] = rgb[0]; b.data[i + 3] = 255;
}
/** Scanline fill of a polygon given in pixel coordinates. */
function fillPolygon(b: Bitmap, poly: Pt[], rgb: [number, number, number]) {
  for (let y = 0; y < b.height; y += 1) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      if ((p.y <= y + 0.5 && q.y > y + 0.5) || (q.y <= y + 0.5 && p.y > y + 0.5)) xs.push(p.x + ((y + 0.5 - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((a, c) => a - c);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x < xs[k + 1] - 0.5; x += 1) if (x >= 0 && x < b.width) put(b, x, y, rgb);
  }
}
function star(cx: number, cy: number, rays: number, outer: number, inner: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < rays * 2; i += 1) {
    const a = (i * Math.PI) / rays - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}
function distToPolygon(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

test("a transparent picture is masked by alpha; an opaque one by contrast with its border", () => {
  const t = blank(10, 10, [0, 0, 0, 0]);
  put(t, 5, 5, [255, 0, 0]);
  const m1 = shapeMask(t);
  assert.equal(m1.byAlpha, true);
  assert.equal(m1.mask[5 * 10 + 5], 1);
  assert.equal(m1.mask[0], 0);
  const o = blank(10, 10, [255, 255, 255, 255]);
  put(o, 5, 5, [200, 60, 30]);
  const m2 = shapeMask(o);
  assert.equal(m2.byAlpha, false);
  assert.equal(m2.mask[5 * 10 + 5], 1);
  assert.equal(m2.mask[0], 0, "the border colour is background");
});

test("only the largest region is kept, so a stray mark elsewhere does not join the outline", () => {
  const b = blank(40, 40, [0, 0, 0, 0]);
  for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) put(b, x, y, [1, 2, 3]);
  put(b, 2, 2, [1, 2, 3]);
  const kept = largestComponent(shapeMask(b).mask, 40, 40);
  assert.equal(kept[2 * 40 + 2], 0);
  assert.equal(kept[15 * 40 + 15], 1);
});

test("a filled square traces to a closed loop around its edge and simplifies to its four corners", () => {
  const b = blank(100, 100, [0, 0, 0, 0]);
  for (let y = 20; y < 60; y += 1) for (let x = 20; x < 60; x += 1) put(b, x, y, [9, 9, 9]);
  const loop = traceBoundary(shapeMask(b).mask, 100, 100);
  assert.ok(loop.length >= 150 && loop.length <= 160, `perimeter of a 40x40 square is 156 boundary pixels, got ${loop.length}`);
  const corners = simplifyClosed(loop, 8);
  assert.equal(corners.length, 4);
  const want = [[20, 20], [59, 20], [59, 59], [20, 59]];
  for (const [x, y] of want) assert.ok(corners.some((c) => c.x === x && c.y === y), `corner ${x},${y} kept: ${JSON.stringify(corners)}`);
});

test("a 12-ray star comes back within a pixel of its true edge, with its tips kept and its colour read", () => {
  const b = blank(400, 400, [255, 255, 255, 255]);
  const poly = star(200, 200, 12, 180, 60);
  fillPolygon(b, poly, [217, 119, 87]);
  const o = outlineOf(b, { maxPoints: 60 });
  assert.ok(!("error" in o), JSON.stringify(o));
  if ("error" in o) return;
  assert.ok(o.points.length <= 60 && o.points.length >= 25, `points: ${o.points.length}`);
  assert.deepEqual(o.points[0], o.points[o.points.length - 1], "closed: last point is the first");
  for (const p of o.points) {
    const px = { x: p.x * 400, y: p.y * 400 };
    assert.ok(distToPolygon(px, poly) <= 1.5, `point ${JSON.stringify(p)} is ${distToPolygon(px, poly).toFixed(1)}px off the true edge`);
  }
  // Every tip survives simplification. A 7-degree spike has no pixel centre in
  // its last few pixels, so the traced apex sits a handful of pixels short of
  // the mathematical vertex; 6px is that, not slack in the tracer.
  for (let i = 0; i < poly.length; i += 2) {
    const tip = poly[i];
    const near = o.points.some((p) => Math.hypot(p.x * 400 - tip.x, p.y * 400 - tip.y) <= 6);
    assert.ok(near, `tip ${i / 2} lost`);
  }
  assert.equal(o.color, "#D97757");
  assert.equal(o.byAlpha, false);
  // The same few apex pixels are missing from the extent at each side.
  assert.ok(Math.abs(o.bbox.x - 20 / 400) < 0.02 && Math.abs(o.bbox.w - 360 / 400) < 0.04, JSON.stringify(o.bbox));
});

test("fit \"shape\" spans the bounding box edge to edge; fit \"image\" keeps the padding", () => {
  const b = blank(200, 100, [0, 0, 0, 0]);
  for (let y = 25; y < 75; y += 1) for (let x = 50; x < 150; x += 1) put(b, x, y, [0, 0, 255]);
  const img = outlineOf(b, { maxPoints: 8, fit: "image" });
  const shp = outlineOf(b, { maxPoints: 8, fit: "shape" });
  assert.ok(!("error" in img) && !("error" in shp));
  if ("error" in img || "error" in shp) return;
  const xs = (o: { points: Pt[] }) => o.points.map((p) => p.x);
  assert.ok(Math.min(...xs(img)) > 0.24 && Math.max(...xs(img)) < 0.76, JSON.stringify(xs(img)));
  assert.ok(Math.min(...xs(shp)) <= 0.01 && Math.max(...xs(shp)) >= 0.99, JSON.stringify(xs(shp)));
});

test("an empty picture is an error, not a path", () => {
  const b = blank(20, 20, [0, 0, 0, 0]);
  const o = outlineOf(b);
  assert.ok("error" in o);
});

test("the point budget is clamped to what the pointer accepts, closing point included", () => {
  const b = blank(300, 300, [0, 0, 0, 0]);
  fillPolygon(b, star(150, 150, 12, 140, 40), [1, 1, 1]);
  const o = outlineOf(b, { maxPoints: 10_000 });
  assert.ok(!("error" in o));
  if ("error" in o) return;
  assert.ok(o.points.length <= MAX_OUTLINE_POINTS, `${o.points.length}`);
  const d = outlineOf(b);
  assert.ok(!("error" in d) && d.points.length <= DEFAULT_OUTLINE_POINTS);
});

test("the rendering hands the path over on its own line and says what the fractions are of", () => {
  const b = blank(100, 100, [0, 0, 0, 0]);
  for (let y = 10; y < 90; y += 1) for (let x = 10; x < 90; x += 1) put(b, x, y, [217, 119, 87]);
  const o = outlineOf(b, { maxPoints: 8 });
  if ("error" in o) throw new Error(o.error);
  const text = renderOutline("icon.png", o);
  assert.match(text, /fill #D97757/);
  assert.match(text, /FRACTIONS of the whole image/);
  const line = text.split("\n").find((l) => l.startsWith("path: "))!;
  const parsed = JSON.parse(line.slice("path: ".length)) as Pt[];
  assert.equal(parsed.length, o.points.length);
});

test("the tool describes itself without naming any application", () => {
  const text = JSON.stringify(IMAGE_OUTLINE_TOOL).toLowerCase();
  for (const word of ["figma", "sketch", "photoshop", "illustrator", "pen tool"]) assert.ok(!text.includes(word), word);
  assert.equal(IMAGE_OUTLINE_TOOL.name, "image_outline");
  assert.match(IMAGE_OUTLINE_TOOL.description, /computer_pointer/);
});
