/**
 * image_outline: the boundary of the main shape in a picture, as a click path.
 *
 * Measured over four runs that had to reproduce a 12-ray icon from an image.
 * The one that traced the picture's pixels in code got it right in one pass.
 * Of the three that wrote the points from looking at the picture, one was
 * right, one folded over itself, and one put the rays in the wrong places by
 * ten to twenty degrees — an overlap of 48% with the source, judged "matches"
 * from a screenshot by the same eye that drew it. Estimating an outline is a
 * coin flip; measuring it is not. So the measuring is a tool.
 *
 * Everything here is pure and runs on a raw bitmap, so it is tested on
 * synthesized pixels. Decoding the file is the caller's job (Electron's
 * nativeImage in the app), because the decoder is not testable headless.
 */

export type Bitmap = { width: number; height: number; data: Uint8Array | Buffer }; // BGRA, row-major
export type Pt = { x: number; y: number };

export const MAX_OUTLINE_POINTS = 120; // what the pointer verb accepts
export const DEFAULT_OUTLINE_POINTS = 110;
export const MIN_OUTLINE_POINTS = 8;

export const IMAGE_OUTLINE_TOOL = {
  type: "function",
  name: "image_outline",
  description:
    "Trace the main shape in an image file into a closed click path: its boundary, simplified to at most max_points " +
    "points, as FRACTIONS ready to pass as the path of computer_pointer, plus the shape's fill colour and bounding box. " +
    "Use it whenever a drawing has to reproduce a picture, and do not write the points by looking at the picture instead: " +
    "measured over four runs, outlines estimated by eye came out wrong two times in three and the traced one did not. " +
    "Reads the file only; touches nothing on screen. Transparent images are traced by their alpha; opaque ones by " +
    "contrast with the border colour. The outer boundary of the largest shape only — holes and separate marks are not included.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the image file — the attachment's path as it was given to you." },
      max_points: {
        type: "integer",
        description: `Most points to return, ${MIN_OUTLINE_POINTS}-${MAX_OUTLINE_POINTS} (default ${DEFAULT_OUTLINE_POINTS}). More points follow curves more closely.`,
      },
      fit: {
        type: "string",
        enum: ["image", "shape"],
        description:
          "What the fractions are of. \"image\" (default): the whole picture, so an element with the picture's aspect ratio gets the shape " +
          "where the picture has it, padding included. \"shape\": the shape's own bounding box, so it fills the element edge to edge.",
      },
    },
    required: ["path"],
  },
};

/** Which pixels are the shape. Alpha when the picture has any; otherwise
 *  anything that is not the colour the border is mostly made of. */
export function shapeMask(bmp: Bitmap): { mask: Uint8Array; byAlpha: boolean } {
  const { width: w, height: h, data } = bmp;
  const n = w * h;
  const mask = new Uint8Array(n);
  let opaque = 0, clear = 0;
  for (let i = 0; i < n; i += 1) (data[i * 4 + 3] >= 128 ? opaque++ : clear++);
  if (clear > 0 && opaque > 0) {
    for (let i = 0; i < n; i += 1) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    return { mask, byAlpha: true };
  }
  // Opaque: the background is whatever the border is mostly made of.
  const counts = new Map<number, number>();
  const key = (i: number) => ((data[i * 4 + 2] >> 4) << 8) | ((data[i * 4 + 1] >> 4) << 4) | (data[i * 4] >> 4);
  const border: number[] = [];
  for (let x = 0; x < w; x += 1) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y += 1) border.push(y * w, y * w + w - 1);
  for (const i of border) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  let bgKey = 0, best = -1;
  for (const [k, c] of counts) if (c > best) { best = c; bgKey = k; }
  // The exact background colour: the mean of the border pixels in that bucket.
  let r = 0, g = 0, b = 0, m = 0;
  for (const i of border) if (key(i) === bgKey) { r += data[i * 4 + 2]; g += data[i * 4 + 1]; b += data[i * 4]; m += 1; }
  r /= m; g /= m; b /= m;
  for (let i = 0; i < n; i += 1) {
    const dr = data[i * 4 + 2] - r, dg = data[i * 4 + 1] - g, db = data[i * 4] - b;
    mask[i] = dr * dr + dg * dg + db * db > 48 * 48 ? 1 : 0;
  }
  return { mask, byAlpha: false };
}

/** Keep only the largest 8-connected region of the mask. */
export function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(0);
  let next = 0, bestLabel = 0, bestSize = 0;
  const stack: number[] = [];
  for (let s = 0; s < w * h; s += 1) {
    if (!mask[s] || label[s]) continue;
    next += 1;
    let size = 0;
    stack.push(s); label[s] = next;
    while (stack.length) {
      const i = stack.pop()!;
      size += 1;
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !label[j]) { label[j] = next; stack.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  const out = new Uint8Array(w * h);
  if (bestLabel) for (let i = 0; i < w * h; i += 1) out[i] = label[i] === bestLabel ? 1 : 0;
  return out;
}

/** The outer boundary of the mask's shape as an ordered closed loop of pixel
 *  coordinates (Moore-neighbour tracing, stopping when the start is re-entered
 *  the way it was first entered). Empty when the mask is empty. */
export function traceBoundary(mask: Uint8Array, w: number, h: number): Pt[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (mask[y * w + x]) { sx = x; sy = y; break outer; }
  if (sx < 0) return [];
  // Clockwise from north-west, in screen coordinates (y down).
  const dirs = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const dirIndex = (dx: number, dy: number) => dirs.findIndex(([a, b]) => a === dx && b === dy);
  const pts: Pt[] = [{ x: sx, y: sy }];
  let px = sx, py = sy;
  let bx = sx - 1, by = sy; // entered from the west
  const startB = { x: bx, y: by };
  const cap = 4 * w * h + 8;
  while (pts.length < cap) {
    const from = dirIndex(bx - px, by - py);
    let moved = false;
    for (let k = 1; k <= 8; k += 1) {
      const [dx, dy] = dirs[(from + k) % 8];
      const nx = px + dx, ny = py + dy;
      if (inside(nx, ny)) {
        const [pdx, pdy] = dirs[(from + k - 1) % 8];
        bx = px + pdx; by = py + pdy;
        px = nx; py = ny;
        moved = true;
        break;
      }
    }
    if (!moved) break; // a single isolated pixel
    if (px === sx && py === sy && bx === startB.x && by === startB.y) break;
    pts.push({ x: px, y: py });
  }
  return pts;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Simplify a closed loop to at most `maxPoints` distinct points, keeping the
 *  points that matter most (the corners, the tips). Split at the two points
 *  farthest apart so no corner is lost to being an endpoint. */
export function simplifyClosed(loop: Pt[], maxPoints: number): Pt[] {
  if (loop.length <= maxPoints) return loop;
  let far = 0, farD = -1;
  for (let i = 1; i < loop.length; i += 1) {
    const d = (loop[i].x - loop[0].x) ** 2 + (loop[i].y - loop[0].y) ** 2;
    if (d > farD) { farD = d; far = i; }
  }
  const a = loop.slice(0, far + 1), b = loop.slice(far).concat([loop[0]]);
  let eps = 0.5;
  for (let tries = 0; tries < 60; tries += 1) {
    const sa = rdp(a, eps), sb = rdp(b, eps);
    const joined = sa.slice(0, -1).concat(sb.slice(0, -1));
    if (joined.length <= maxPoints) return joined;
    eps *= 1.25;
  }
  return rdp(a, eps).slice(0, -1).concat(rdp(b, eps).slice(0, -1)).slice(0, maxPoints);
}

/** The shape's colour: the commonest colour among its pixels, then averaged
 *  exactly within that bucket so anti-aliased edges do not tint it. */
export function dominantColor(bmp: Bitmap, mask: Uint8Array): string {
  const { data } = bmp;
  const counts = new Map<number, number>();
  const key = (i: number) => ((data[i * 4 + 2] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4] >> 3);
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  let bestKey = 0, best = -1;
  for (const [k, c] of counts) if (c > best) { best = c; bestKey = k; }
  let r = 0, g = 0, b = 0, m = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] && key(i) === bestKey) { r += data[i * 4 + 2]; g += data[i * 4 + 1]; b += data[i * 4]; m += 1; }
  if (!m) return "#000000";
  const hex = (v: number) => Math.round(v / m).toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export type Outline = {
  points: Pt[]; // fractions, closed: the last point repeats the first
  color: string;
  bbox: { x: number; y: number; w: number; h: number }; // fractions of the image
  byAlpha: boolean;
  size: { w: number; h: number };
  fit: "image" | "shape";
};

export function outlineOf(bmp: Bitmap, opts: { maxPoints?: number; fit?: "image" | "shape" } = {}): Outline | { error: string } {
  const { width: w, height: h } = bmp;
  if (w < 2 || h < 2) return { error: "the image has no pixels to trace" };
  const maxPoints = Math.max(MIN_OUTLINE_POINTS, Math.min(MAX_OUTLINE_POINTS, opts.maxPoints ?? DEFAULT_OUTLINE_POINTS));
  const fit = opts.fit ?? "image";
  const { mask: raw, byAlpha } = shapeMask(bmp);
  const mask = largestComponent(raw, w, h);
  const loop = traceBoundary(mask, w, h);
  if (loop.length < 3) return { error: byAlpha ? "no opaque shape to trace" : "no shape stands out from the border colour" };
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const p of loop) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  // Pixel centres, and the far edge of the last pixel, so the shape's extent is
  // its real extent rather than a pixel short.
  const bw = maxX + 1 - minX, bh = maxY + 1 - minY;
  const simple = simplifyClosed(loop, maxPoints - 1);
  const frac = (p: Pt): Pt => fit === "shape"
    ? { x: round3((p.x + 0.5 - minX) / bw), y: round3((p.y + 0.5 - minY) / bh) }
    : { x: round3((p.x + 0.5) / w), y: round3((p.y + 0.5) / h) };
  const points = simple.map(frac);
  points.push(points[0]);
  return {
    points,
    color: dominantColor(bmp, mask),
    bbox: { x: round3(minX / w), y: round3(minY / h), w: round3(bw / w), h: round3(bh / h) },
    byAlpha,
    size: { w, h },
    fit,
  };
}

function round3(v: number): number { return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000; }

/** What the model reads. The path is on its own line as JSON so it can be
 *  passed on verbatim. */
export function renderOutline(name: string, o: Outline): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const head =
    `Outline of ${name} (${o.size.w}×${o.size.h}, traced by ${o.byAlpha ? "transparency" : "contrast with the border colour"}): ` +
    `${o.points.length} points including the closing one, fill ${o.color}, shape spans x ${pct(o.bbox.x)}–${pct(o.bbox.x + o.bbox.w)} and y ${pct(o.bbox.y)}–${pct(o.bbox.y + o.bbox.h)} of the image.`;
  const how = o.fit === "image"
    ? "The points are FRACTIONS of the whole image, so they place the shape where the picture has it, padding included. " +
      "Pass them unchanged as the path of computer_pointer aimed at an element with the picture's aspect ratio; for another aspect ratio, ask again with fit \"shape\" and aim at an element sized like the shape."
    : "The points are FRACTIONS of the shape's own bounding box, so the shape fills the element you aim at edge to edge. Pass them unchanged as the path of computer_pointer.";
  return `${head}\n${how}\npath: ${JSON.stringify(o.points)}`;
}

/** An outline this conversation measured and has not drawn yet.
 *
 *  Measured 2026-09-11: a run traced a 59-point outline, then spent ten turns
 *  and three full-window screenshots hunting for the right frame, pressed the
 *  pen key, and gave up without ever sending the path. By then the points were
 *  ten turns back behind the screenshots. This keeps them in view, cheaply: a
 *  single line, and the reminder that re-reading them is free rather than
 *  something to re-derive by eye.
 */
export type PendingOutline = { name: string; path: string; points: number; color: string; callsSince: number };

/** Say it once the outline has started to drift out of reach, and keep saying
 *  it while it is unused — a drawing that never happens is the failure this is
 *  for. Silent until then, so a task that draws straight away never sees it. */
export const OUTLINE_REMINDER_AFTER = 4;

export function outlineReminder(pending: PendingOutline | null): string | null {
  if (!pending || pending.callsSince < OUTLINE_REMINDER_AFTER) return null;
  return (
    `You measured the outline of ${pending.name} ${pending.callsSince} calls ago and have not drawn it: ` +
    `${pending.points} points, fill ${pending.color}. Pass those points to computer_pointer as the path — ` +
    `if they have scrolled out of view, call image_outline again for ${pending.path} (it costs nothing) ` +
    "rather than writing points by eye."
  );
}
