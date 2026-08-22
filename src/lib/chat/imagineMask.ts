/**
 * Imagine's mask editor — outline a region, then describe the change.
 *
 * Strokes are stored in 0–1 image space so they survive resize. A stroke that
 * ends near where it started is a lasso (filled); otherwise it's a brush
 * stroke (the outline itself is the mask). `width` is a fraction of the
 * image's shorter side, so a size picked on a slider looks the same after
 * resize. A one-point stroke is a stamped dot at that width.
 */

export type MaskPoint = { x: number; y: number };

export type MaskStroke = {
  id: string;
  points: MaskPoint[];
  /** Closed lasso (filled interior) vs open brush stroke. */
  closed: boolean;
  /** Brush size as a fraction of min(image width, height). */
  width: number;
};

/** Thin → thick, as a fraction of the image's shorter side. */
export const BRUSH_SIZE_MIN = 0.01;
export const BRUSH_SIZE_MAX = 0.14;
export const BRUSH_SIZE_DEFAULT = 0.04;

export function clampBrushSize(size: number): number {
  const n = Number(size);
  if (!Number.isFinite(n)) return BRUSH_SIZE_DEFAULT;
  return Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, n));
}

/** Pixel line width for a stored brush size on a w×h canvas. */
export function brushPx(size: number, w: number, h: number): number {
  return Math.max(2, Math.min(w, h) * clampBrushSize(size));
}

/** How close a click must land to the first vertex to close a click-path. */
export function snapThreshold(brushSize: number): number {
  return Math.max(0.028, clampBrushSize(brushSize) * 1.8);
}

export function isNearPoint(a: MaskPoint, b: MaskPoint, threshold: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= threshold;
}

const IMAGINE_PROMPT_BUDGET = 3500;

export function pathLength(points: MaskPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** True when the freehand path should fill as a lasso, not stay a brush stroke. */
export function isClosedLasso(points: MaskPoint[]): boolean {
  if (points.length < 4) return false;
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(first.x - last.x, first.y - last.y);
  const len = pathLength(points);
  if (len < 0.08) return false;
  return gap < 0.14 || (len > 0.25 && gap < 0.22);
}

/**
 * Drop a scribble that's too small to mean anything. Otherwise classify it
 * as a filled lasso or an open brush stroke.
 */
export function classifyStroke(points: MaskPoint[]): { closed: boolean } | null {
  if (points.length < 3) return null;
  if (pathLength(points) < 0.03) return null;
  return { closed: isClosedLasso(points) };
}

export function hasMaskInk(strokes: MaskStroke[]): boolean {
  return strokes.some((s) => s.points.length >= 1);
}

/**
 * A click-path is a polyline of placed dots. One point is a stamp; three or
 * more that finish on the first point close into a filled lasso.
 */
export function finalizeClickPath(
  points: MaskPoint[],
  brushSize: number,
): { closed: boolean } | null {
  if (!points.length) return null;
  if (points.length >= 3 && isNearPoint(points[0], points[points.length - 1], snapThreshold(brushSize))) {
    return { closed: true };
  }
  return { closed: false };
}

/**
 * Paint strokes onto a canvas already sized to the image. `w`/`h` are CSS
 * pixels (or export pixels) — the same space the 0–1 points map into.
 */
export function paintMaskStrokes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  strokes: MaskStroke[],
  style: { fill: string; stroke: string; lineWidth?: number },
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts.length) continue;
    const brush = style.lineWidth ?? brushPx(stroke.width ?? BRUSH_SIZE_DEFAULT, w, h);
    ctx.lineWidth = brush;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * w, pts[0].y * h, brush / 2, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    if (stroke.closed) {
      ctx.closePath();
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    ctx.strokeStyle = style.stroke;
    ctx.stroke();
  }
}

/** Vertex handles for a click-path — first point is larger when it can close. */
export function paintClickVertices(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  points: MaskPoint[],
  opts?: { closable?: boolean },
) {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const first = i === 0;
    const r = first && opts?.closable ? 6.5 : 4;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    ctx.fillStyle = first && opts?.closable ? "rgba(56, 189, 248, 0.95)" : "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
    ctx.stroke();
  }
}

/** White-on-black PNG — white is the region to edit. */
export function exportLumaMask(
  width: number,
  height: number,
  strokes: MaskStroke[],
  createCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas = defaultCanvas,
): string | null {
  if (!hasMaskInk(strokes) || width < 4 || height < 4) return null;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.filter = `blur(${Math.max(2, Math.round(Math.min(width, height) * 0.006))}px)`;
  paintMaskStrokes(ctx, width, height, strokes, {
    fill: "#fff",
    stroke: "#fff",
  });
  ctx.filter = "none";
  if ("toDataURL" in canvas) return canvas.toDataURL("image/png");
  return null;
}

function defaultCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function truncateMiddle(text: string, max: number): string {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  if (max < 40) return s.slice(0, max);
  const head = Math.floor(max * 0.65);
  const tail = max - head - 5;
  return `${s.slice(0, head)} … ${s.slice(-tail)}`;
}

/** Model prompt for a mask-and-prompt refine — user notes lead. */
export function buildEditPrompt(opts: {
  concept: string;
  notes: string;
  hasMask: boolean;
}): string {
  const concept = String(opts.concept || "").trim();
  const notes = String(opts.notes || "").trim();

  const instructionParts: string[] = [
    "EDIT THE REFERENCE IMAGE.",
    "Apply the directed changes below precisely. Keep subject, style, composition, and lighting intact unless a note asks otherwise.",
  ];

  if (opts.hasMask) {
    instructionParts.push(
      "",
      "A mask image is attached after the reference. WHITE pixels mark the region to change. Edit ONLY that region. Pixels outside the mask must stay identical.",
    );
  }

  if (notes) {
    instructionParts.push("", "User direction (highest priority):", notes);
  }

  const instructions = instructionParts.join("\n");
  const reserved = instructions.length + 48;
  const conceptBudget = Math.max(200, IMAGINE_PROMPT_BUDGET - reserved);
  const conceptBlock = concept
    ? `\n\nOriginal concept (context only — do not ignore the edits above):\n${truncateMiddle(concept, conceptBudget)}`
    : "";

  return `${instructions}${conceptBlock}`.slice(0, IMAGINE_PROMPT_BUDGET);
}
