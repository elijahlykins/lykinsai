/**
 * Tiered canvas context builder for AI prompts.
 *
 * Replaces the old flat slice(-60) approach with three priority tiers:
 *   Tier 1 — Focused blocks  (max 3, full content up to 3 000 chars)
 *   Tier 2 — Nearby blocks   (max 20, 120-char content previews)
 *   Tier 3 — Compact summary (max 10, 80-char content previews)
 */

const take = (v: any, n: number) =>
  String(v || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

const host = (u: string) => {
  try {
    return new URL(String(u || "")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

function describeBlock(
  b: any,
  id: string,
  opts: { contentLen: number; focused?: boolean },
): string {
  const focusTag = opts.focused ? " [FOCUSED]" : "";
  const base = `- id=${id} type=${b.type} x=${Math.floor(b.x || 0)} y=${Math.floor(b.y || 0)} w=${Math.floor(b.width || 0)} h=${Math.floor(b.height || 0)}${focusTag}`;
  const cl = opts.contentLen;

  if (b?.type === "text") {
    const format = String(b?.format || "plain");
    const content = take(b?.content, cl);
    return `${base} format=${format}${content ? ` content="${content}"` : ""}`;
  }

  if (
    b?.type === "youtube" ||
    (b?.type === "create" &&
      String(b?.mode || "").toLowerCase() === "video")
  ) {
    const videoId = String(b?.videoId || b?.data?.videoId || "");
    const url = String(b?.url || b?.data?.url || "");
    return `${base} kind=youtube videoId=${videoId || "unknown"}${url ? ` url="${take(url, 120)}"` : ""}`;
  }

  if (
    b?.type === "image" ||
    (b?.type === "create" &&
      ["image", "generated"].includes(String(b?.mode || "").toLowerCase()))
  ) {
    const src = String(b?.src || b?.data?.src || "");
    return `${base} kind=image${src ? ` srcHost=${host(src) || "local"}` : ""}`;
  }

  if (
    b?.type === "file" ||
    (b?.type === "create" &&
      String(b?.mode || "").toLowerCase() === "embed")
  ) {
    const name = take(b?.name || b?.data?.name, 80);
    const mime = take(b?.mime || b?.data?.mime, 60);
    return `${base} kind=file${name ? ` name="${name}"` : ""}${mime ? ` mime=${mime}` : ""}`;
  }

  if (b?.type === "link") {
    const url = String(b?.url || b?.data?.url || "");
    if (url)
      return `${base} kind=link host=${host(url) || "unknown"}`;
  }

  if (
    b?.type === "create" &&
    String(b?.mode || "").toLowerCase() === "design"
  ) {
    const elCount = Array.isArray(b?.data?.board?.elements)
      ? b.data.board.elements.length
      : 0;
    return `${base} kind=design elements=${elCount}`;
  }

  if (
    b?.type === "create" &&
    String(b?.mode || "").toLowerCase() === "taskboard"
  ) {
    const colCount = Array.isArray(b?.data?.columns)
      ? b.data.columns.length
      : 0;
    const title = take(b?.data?.title || "", 80);
    return `${base} kind=taskboard columns=${colCount}${title ? ` title="${title}"` : ""}`;
  }

  const content = take(b?.content || b?.data?.content || "", cl);
  return `${base}${content ? ` content="${content}"` : ""}`;
}

export function buildTieredCanvasContext(params: {
  blocks: Record<string, any>;
  blockOrder: string[];
  focusedBrickIds: string[];
  viewportCenter?: { x: number; y: number };
}): string {
  const { blocks, blockOrder, focusedBrickIds, viewportCenter } = params;
  const allIds = Array.isArray(blockOrder) ? blockOrder : [];
  const focusedSet = new Set((focusedBrickIds || []).slice(0, 3));
  const included = new Set<string>();
  const lines: string[] = [];

  // ── Tier 1: Focused blocks (max 3, up to 3 000 chars content) ────────
  const focusedLines: string[] = [];
  for (const id of focusedSet) {
    if (included.has(id)) continue;
    const b = blocks[id];
    if (!b) continue;
    focusedLines.push(
      describeBlock(b, id, { contentLen: 3000, focused: true }),
    );
    included.add(id);
  }

  // Anchor for proximity: first focused block centre, or viewport centre
  let anchorX = viewportCenter?.x ?? 0;
  let anchorY = viewportCenter?.y ?? 0;
  if (focusedLines.length) {
    const firstId = [...focusedSet].find((id) => blocks[id]);
    const fb = firstId ? blocks[firstId] : undefined;
    if (fb) {
      anchorX = (fb.x || 0) + (fb.width || 0) / 2;
      anchorY = (fb.y || 0) + (fb.height || 0) / 2;
    }
  }

  // Sort remaining blocks by Euclidean distance from anchor
  const remaining = allIds
    .filter((id) => !included.has(id) && blocks[id])
    .map((id) => {
      const b = blocks[id];
      const cx = (b.x || 0) + (b.width || 0) / 2;
      const cy = (b.y || 0) + (b.height || 0) / 2;
      return { id, dist: Math.hypot(cx - anchorX, cy - anchorY) };
    })
    .sort((a, b) => a.dist - b.dist);

  // ── Tier 2: Nearby blocks (max 20, 120-char content) ─────────────────
  const NEARBY_MAX = 20;
  const nearbyLines: string[] = [];
  for (let i = 0; i < Math.min(remaining.length, NEARBY_MAX); i++) {
    const { id } = remaining[i];
    if (included.has(id)) continue;
    nearbyLines.push(describeBlock(blocks[id], id, { contentLen: 120 }));
    included.add(id);
  }

  // ── Tier 3: Compact summary (max 10, 80-char content) ────────────────
  const COMPACT_MAX = 10;
  const compactLines: string[] = [];
  for (
    let i = NEARBY_MAX;
    i < remaining.length && compactLines.length < COMPACT_MAX;
    i++
  ) {
    const { id } = remaining[i];
    if (included.has(id)) continue;
    compactLines.push(describeBlock(blocks[id], id, { contentLen: 80 }));
    included.add(id);
  }

  // ── Assemble ─────────────────────────────────────────────────────────
  if (focusedLines.length) {
    lines.push(
      "[USER_FOCUS]",
      `The user has focused on ${focusedLines.length} brick(s) by double-clicking them. Blocks marked [FOCUSED] are what the user wants to discuss or work on. Prioritize these blocks in your response.`,
      "",
      ...focusedLines,
    );
  }

  if (nearbyLines.length) {
    lines.push("", ...nearbyLines);
  }

  if (compactLines.length) {
    lines.push("", ...compactLines);
  }

  return lines.join("\n");
}
