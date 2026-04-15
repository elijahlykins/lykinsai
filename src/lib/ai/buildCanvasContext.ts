/**
 * Tiered canvas context builder for AI prompts.
 *
 * Replaces the old flat slice(-60) approach with three priority tiers:
 *   Tier 1 — Focused blocks  (max 3, full content up to 3 000 chars)
 *   Tier 2 — Nearby blocks   (max 20, 120-char content previews)
 *   Tier 3 — Compact summary (max 10, 80-char content previews)
 *
 * Also emits:
 *   [BOARD_OVERVIEW]    — total / shown / hidden counts, type breakdown
 *   [NEARBY_CLUSTERS]   — auto-detected spatial proximity groups
 *   [RECENTLY_REMOVED]  — blocks deleted during the current session
 */

export type RecentlyDeletedEntry = {
  id: string;
  type: string;
  preview: string;
  deletedAt: number;
};

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

function effectiveType(b: any): string {
  const t = String(b?.type || "unknown");
  if (t === "create") {
    const m = String(b?.mode || "").toLowerCase();
    if (m === "image" || m === "generated") return "image";
    if (m === "video") return "youtube";
    if (m === "embed") return "file";
    if (m) return m;
  }
  return t;
}

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
    const variant = b?.data?.textVariant && b.data.textVariant !== "body" ? ` variant=${b.data.textVariant}` : "";
    const listType = b?.data?.listType && b.data.listType !== "none" ? ` listType=${b.data.listType}` : "";
    return `${base} format=${format}${variant}${listType}${content ? ` content="${content}"` : ""}`;
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
    const hasValidSrc = src && (src.startsWith("http") || src.startsWith("data:image/"));
    const visionTag = hasValidSrc ? " [IMAGE ATTACHED — you can see this image]" : "";
    const srcHost = src ? ` srcHost=${host(src) || "local"}` : "";
    return `${base} kind=image${srcHost}${visionTag}`;
  }

  if (
    b?.type === "file" ||
    (b?.type === "create" &&
      String(b?.mode || "").toLowerCase() === "embed")
  ) {
    const name = take(b?.name || b?.data?.name, 80);
    const mime = take(b?.mime || b?.data?.mime, 60);
    const extracted = b?.data?.extractedText ? take(b.data.extractedText, cl) : "";
    const isCard = b?.data?.displayMode === "link-card";
    return `${base} kind=file${isCard ? " display=link-card" : ""}${name ? ` name="${name}"` : ""}${mime ? ` mime=${mime}` : ""}${extracted ? `\n--- file content ---\n${extracted}\n---` : ""}`;
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
  wireConnections?: Array<{
    id: string;
    fromId: string;
    toId: string;
    fromSide?: string;
    toSide?: string;
  }>;
  recentlyDeleted?: RecentlyDeletedEntry[];
}): string {
  const { blocks, blockOrder, focusedBrickIds, viewportCenter, wireConnections, recentlyDeleted } = params;
  const allIds = Array.isArray(blockOrder) ? blockOrder : [];
  const focusedSet = new Set((focusedBrickIds || []).slice(0, 3));
  const included = new Set<string>();
  const lines: string[] = [];
  const wires = Array.isArray(wireConnections) ? wireConnections : [];

  // Build adjacency lookup: blockId → set of connected blockIds
  const adjacency = new Map<string, Set<string>>();
  for (const w of wires) {
    if (!blocks[w.fromId] || !blocks[w.toId]) continue;
    if (!adjacency.has(w.fromId)) adjacency.set(w.fromId, new Set());
    if (!adjacency.has(w.toId)) adjacency.set(w.toId, new Set());
    adjacency.get(w.fromId)!.add(w.toId);
    adjacency.get(w.toId)!.add(w.fromId);
  }

  // Collect IDs directly connected to focused bricks (they deserve higher priority)
  const connectedToFocused = new Set<string>();
  for (const fid of focusedSet) {
    const neighbors = adjacency.get(fid);
    if (neighbors) {
      for (const nid of neighbors) {
        if (!focusedSet.has(nid)) connectedToFocused.add(nid);
      }
    }
  }

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

  // ── Tier 1.5: Blocks wired to focused bricks (up to 800 chars, tagged) ──
  const connectedLines: string[] = [];
  for (const id of connectedToFocused) {
    if (included.has(id)) continue;
    const b = blocks[id];
    if (!b) continue;
    connectedLines.push(
      describeBlock(b, id, { contentLen: 800 }) + " [CONNECTED TO FOCUSED]",
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

  // ── Build connection graph description ──────────────────────────────
  const connectionLines: string[] = [];
  const validWires = wires.filter((w) => blocks[w.fromId] && blocks[w.toId]);
  if (validWires.length > 0) {
    const blockLabel = (id: string) => {
      const b = blocks[id];
      if (!b) return id;
      const type = String(b.type || "unknown");
      const content = String(b.content || b.data?.content || b.data?.title || "").replace(/\s+/g, " ").trim();
      const preview = content ? ` "${content.slice(0, 40)}"` : "";
      return `${id}(${type}${preview})`;
    };
    for (const w of validWires) {
      connectionLines.push(`  ${blockLabel(w.fromId)} --[${w.fromSide || "?"}→${w.toSide || "?"}]--> ${blockLabel(w.toId)}`);
    }
  }

  // ── Board overview ────────────────────────────────────────────────
  const totalBlocks = allIds.filter((id) => !!blocks[id]).length;
  const shownBlocks = included.size;
  const hiddenBlocks = totalBlocks - shownBlocks;

  const typeFreq: Record<string, number> = {};
  for (const id of allIds) {
    const b = blocks[id];
    if (!b) continue;
    const et = effectiveType(b);
    typeFreq[et] = (typeFreq[et] || 0) + 1;
  }
  const typeSummary = Object.entries(typeFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");

  // ── Proximity clusters (union-find on auto-neighbor edges) ────────
  const clusterParent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (clusterParent.get(r) !== r) r = clusterParent.get(r) || r;
    let c = x;
    while (c !== r) { const p = clusterParent.get(c) || c; clusterParent.set(c, r); c = p; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) clusterParent.set(rb, ra);
  };

  for (const id of included) {
    clusterParent.set(id, id);
  }
  for (const id of included) {
    const b = blocks[id];
    const conns: any[] = Array.isArray(b?.data?.connections) ? b.data.connections : [];
    for (const c of conns) {
      if (c?.kind !== "neighbor") continue;
      const otherId = String(c?.toId || "");
      if (otherId && included.has(otherId)) union(id, otherId);
    }
  }

  const clusterMap = new Map<string, string[]>();
  for (const id of included) {
    const root = find(id);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(id);
  }
  const clusterLines: string[] = [];
  const clusterLabel = (id: string) => {
    const b = blocks[id];
    if (!b) return id;
    const et = effectiveType(b);
    const content = String(b.content || b.data?.content || b.data?.title || "").replace(/\s+/g, " ").trim();
    const preview = content ? ` "${content.slice(0, 30)}"` : "";
    return `${id}(${et}${preview})`;
  };
  let clusterChars = 0;
  const CLUSTER_CHAR_CAP = 500;
  for (const [, members] of clusterMap) {
    if (members.length < 2) continue;
    const line = `  group: ${members.map(clusterLabel).join(", ")}`;
    if (clusterChars + line.length > CLUSTER_CHAR_CAP) break;
    clusterLines.push(line);
    clusterChars += line.length;
  }

  // ── Recently removed blocks ───────────────────────────────────────
  const DELETED_EXPIRY_MS = 15 * 60 * 1000;
  const now = Date.now();
  const deletedEntries = Array.isArray(recentlyDeleted)
    ? recentlyDeleted.filter((e) => now - e.deletedAt < DELETED_EXPIRY_MS)
    : [];
  const deletedLines: string[] = [];
  for (const e of deletedEntries) {
    const ago = Math.round((now - e.deletedAt) / 60_000);
    const agoStr = ago < 1 ? "just now" : `~${ago} min ago`;
    const preview = e.preview ? ` "${e.preview}"` : "";
    deletedLines.push(`  id=${e.id} was ${e.type}${preview} (deleted ${agoStr})`);
  }

  // ── Assemble ─────────────────────────────────────────────────────────
  const vpLine = viewportCenter
    ? `Viewport center: x=${Math.round(viewportCenter.x)} y=${Math.round(viewportCenter.y)}`
    : "";
  lines.push(
    "[BOARD_OVERVIEW]",
    `Total: ${totalBlocks} blocks | Showing: ${shownBlocks} | Hidden: ${hiddenBlocks}`,
    `Types: ${typeSummary}`,
    `Wires: ${validWires.length} connections | Spatial groups: ${clusterLines.length}`,
    ...(vpLine ? [vpLine] : []),
    "",
  );

  if (focusedLines.length) {
    const focusedBlocks = [...focusedSet].map((id) => blocks[id]).filter(Boolean);
    const hasFocusedImage = focusedBlocks.some(
      (b) =>
        b?.type === "image" ||
        (b?.type === "create" &&
          ["image", "generated"].includes(String(b?.mode || "").toLowerCase()))
    );
    const focusInstruction =
      focusedLines.length === 1
        ? "The user has raised this brick (e.g. by double-pressing it). Their message refers specifically to this brick."
        : `The user has raised ${focusedLines.length} bricks (e.g. by double-pressing them). Their message refers specifically to these brick(s).`;
    const imageInstruction = hasFocusedImage
      ? " One or more of these are images — the actual image pixels are attached to this message so you CAN see them. Analyze, describe, and reason about the visual content. Prioritize the focused brick(s) unless they clearly ask about something else."
      : " Answer only in relation to these focused brick(s) unless they clearly ask about something else.";
    lines.push(
      "[USER_FOCUS]",
      focusInstruction + imageInstruction,
      "Blocks marked [FOCUSED] below are the sole context for the user's question — prioritize and restrict your response to them.",
      "",
      ...focusedLines,
    );
  }

  if (connectedLines.length) {
    lines.push("", ...connectedLines);
  }

  if (nearbyLines.length) {
    lines.push("", ...nearbyLines);
  }

  if (compactLines.length) {
    lines.push("", ...compactLines);
  }

  if (connectionLines.length) {
    lines.push(
      "",
      "[CONNECTIONS]",
      "These bricks are explicitly connected by the user via wires. Treat connected bricks as contextually related — the user linked them intentionally to show a relationship, data flow, or logical grouping.",
      ...connectionLines,
    );
  }

  // ── Board images: text descriptions for all images, even those not in tiers ──
  const BOARD_IMAGES_CAP = 1500;
  const imageLines: string[] = [];
  let imageChars = 0;
  for (const id of allIds) {
    const b = blocks[id];
    if (!b) continue;
    const isImage =
      b.type === "image" ||
      (b.type === "create" &&
        ["image", "generated"].includes(String(b.mode || "").toLowerCase()));
    if (!isImage) continue;
    const src = String(b.src || b?.data?.src || "");
    const srcHost = src ? (host(src) || "local") : "";
    const attached = included.has(id) && src && (src.startsWith("http") || src.startsWith("data:image/"))
      ? " [IMAGE ATTACHED]" : "";
    const desc = String(b?.data?.aiDescription || "").replace(/\s+/g, " ").trim();
    const descText = desc ? `— "${desc.slice(0, 120)}"` : "— (no description yet)";
    const line = `  id=${id} kind=image${srcHost ? ` srcHost=${srcHost}` : ""}${attached} ${descText}`;
    if (imageChars + line.length > BOARD_IMAGES_CAP) break;
    imageLines.push(line);
    imageChars += line.length;
  }
  if (imageLines.length) {
    lines.push(
      "",
      "[BOARD_IMAGES]",
      `All ${imageLines.length} image(s) on this board (text descriptions). You can see actual pixels only for images marked [IMAGE ATTACHED].`,
      ...imageLines,
    );
  }

  if (clusterLines.length) {
    lines.push(
      "",
      "[NEARBY_CLUSTERS]",
      "Blocks near each other on the board (auto-detected proximity, not user-wired). Treat as loosely related context groups.",
      ...clusterLines,
    );
  }

  if (deletedLines.length) {
    lines.push(
      "",
      "[RECENTLY_REMOVED]",
      "These blocks were on the board earlier but have since been deleted by the user. Do not reference them as if they still exist.",
      ...deletedLines,
    );
  }

  return lines.join("\n");
}

/**
 * Compact context for action-only requests (organize, move, resize, edit).
 * Includes EVERY block with metadata so the AI can compute layouts and identify blocks.
 * Focused bricks get full content so the AI knows what "this brick" refers to.
 */
export function buildActionCanvasContext(params: {
  blocks: Record<string, any>;
  blockOrder: string[];
  viewportCenter: { x: number; y: number };
  viewportSize: { w: number; h: number };
  focusedBrickIds?: string[];
  wireConnections?: Array<{ id: string; fromId: string; toId: string; fromSide?: string; toSide?: string }>;
}): string {
  const { blocks, blockOrder, viewportCenter, viewportSize, focusedBrickIds, wireConnections } = params;
  const allIds = Array.isArray(blockOrder) ? blockOrder : [];
  const focusedSet = new Set((focusedBrickIds || []).slice(0, 5));
  const lines: string[] = [];

  const typeFreq: Record<string, number> = {};
  for (const id of allIds) {
    const b = blocks[id];
    if (!b) continue;
    const et = effectiveType(b);
    typeFreq[et] = (typeFreq[et] || 0) + 1;
  }
  const typeSummary = Object.entries(typeFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");

  const totalBlocks = allIds.filter((id) => !!blocks[id]).length;

  lines.push(
    "[BOARD_OVERVIEW]",
    `Total: ${totalBlocks} blocks | Types: ${typeSummary}`,
    `Viewport center: x=${Math.round(viewportCenter.x)} y=${Math.round(viewportCenter.y)} | Viewport size: ${viewportSize.w}x${viewportSize.h}`,
    "",
  );

  if (focusedSet.size > 0) {
    lines.push(
      "[USER_FOCUS]",
      focusedSet.size === 1
        ? "The user has raised/selected this brick. When they say 'this brick', 'this block', 'it', or 'this', they mean the [FOCUSED] block below. Use its blockId for any update/edit actions."
        : `The user has raised/selected ${focusedSet.size} bricks. 'These', 'them', 'this' etc. refer to the [FOCUSED] blocks below.`,
      "",
    );
    for (const id of focusedSet) {
      const b = blocks[id];
      if (!b) continue;
      lines.push(describeBlock(b, id, { contentLen: 2000, focused: true }));
    }
    lines.push("");
  }

  lines.push("[ALL_BLOCKS]");

  for (const id of allIds) {
    const b = blocks[id];
    if (!b) continue;
    if (focusedSet.has(id)) continue;
    const et = effectiveType(b);
    const data = b?.data && typeof b.data === "object" ? b.data : {};
    const variant = data.textVariant && data.textVariant !== "body" ? ` variant=${data.textVariant}` : "";
    const listType = data.listType && data.listType !== "none" ? ` listType=${data.listType}` : "";
    const label = take(b?.content || b?.data?.title || b?.data?.name || b?.data?.src || "", 120);
    lines.push(`- id=${id} type=${et} x=${Math.floor(b.x || 0)} y=${Math.floor(b.y || 0)} w=${Math.floor(b.width || 0)} h=${Math.floor(b.height || 0)}${variant}${listType}${label ? ` content="${label}"` : ""}`);
  }

  const wires = Array.isArray(wireConnections) ? wireConnections.filter((w) => blocks[w.fromId] && blocks[w.toId]) : [];
  if (wires.length > 0) {
    lines.push("", "[CONNECTIONS]");
    for (const w of wires) {
      lines.push(`  ${w.fromId} --[${w.fromSide || "?"}→${w.toSide || "?"}]--> ${w.toId}`);
    }
  }

  return lines.join("\n");
}
