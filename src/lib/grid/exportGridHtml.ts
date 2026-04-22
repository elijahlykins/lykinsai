/**
 * Grid → self-contained HTML exporter.
 *
 * Takes a canvas snapshot and produces a single .html file that renders the
 * grid in view-only mode, matching the look and feel of the in-app shared
 * grid viewer. The output is fully offline-capable:
 *
 *   - All CSS is inlined.
 *   - All JS is inlined (no external deps).
 *   - Images are fetched and base64-inlined so the file keeps working forever
 *     (no Supabase signed-URL dependency).
 *   - Theme-aware (follows the viewer's OS light/dark preference) but renders
 *     the same spatial layout regardless.
 *   - Pan + zoom with mouse, trackpad, and touch.
 *   - Optional include-flags filter bricks by category (text / images /
 *     videos / files / links) and append notes pages at the bottom.
 */

export type GridExportOptions = {
  includeText?: boolean;
  includeImages?: boolean;
  includeVideos?: boolean;
  includeFiles?: boolean;
  includeLinks?: boolean;
  includeNotes?: boolean;
  /** Pass false to skip fetching+embedding image bytes (keeps file small). */
  inlineMedia?: boolean;
  /** Override the output filename. */
  filename?: string;
};

export type WireSide = "top" | "right" | "bottom" | "left";

export type WireConnection = {
  id: string;
  fromId: string;
  toId: string;
  fromSide?: WireSide;
  toSide?: WireSide;
  controlPoints?: Array<{ x: number; y: number }>;
};

export type ExportSnapshot = {
  blocks?: Record<string, any>;
  blockOrder?: string[];
  wireConnections?: WireConnection[];
  gridSize?: number;
  title?: string;
  notesPages?: Array<{ id: string; title: string; content?: any }>;
  [k: string]: any;
};

export type ExportMeta = {
  title: string;
  exportedAt?: string;
};

type BrickCategory = "text" | "image" | "video" | "file" | "link";

type LoadedBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  category: BrickCategory;
  /** Raw original block (for access to brickColor, textColor, etc). */
  raw: any;
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|heif)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|aac|flac)(\?|$)/i;
const PDF_EXT_RE = /\.pdf(\?|$)/i;
const SOCIAL_VIDEO_HOSTS = /(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|dailymotion\.com)/i;

/* ------------------------------------------------------------------ */
/*  Classification                                                     */
/* ------------------------------------------------------------------ */

function categorize(raw: any): BrickCategory {
  if (!raw || typeof raw !== "object") return "text";
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const type = String(raw.type || "").toLowerCase();
  const mode = String(raw.mode || "").toLowerCase();
  const dataSrc = typeof data.src === "string" ? data.src : "";
  const dataUrl = typeof data.url === "string" ? data.url : typeof data.dataUrl === "string" ? data.dataUrl : "";
  const mediaKind = String(data.mediaKind || data.kind || "").toLowerCase();
  const mime = String(data.mime || "").toLowerCase();
  const displayMode = String(data.displayMode || "").toLowerCase();

  // Image: generated or uploaded image brick.
  if (type === "create" && (mode === "image" || mode === "generated")) return "image";
  if (dataSrc || mediaKind === "image") return "image";

  // create-with-URL bricks: categorize by mime/extension/host.
  if (type === "create" && dataUrl) {
    if (displayMode === "link") return "link";
    if (mime.startsWith("image/") || IMAGE_EXT_RE.test(dataUrl)) return "image";
    if (mime.startsWith("video/") || VIDEO_EXT_RE.test(dataUrl) || SOCIAL_VIDEO_HOSTS.test(dataUrl)) return "video";
    if (mime.startsWith("audio/") || AUDIO_EXT_RE.test(dataUrl)) return "file";
    if (mime === "application/pdf" || PDF_EXT_RE.test(dataUrl)) return "file";
    return "link";
  }

  return "text";
}

function loadBlocks(snapshot: ExportSnapshot): LoadedBlock[] {
  const blocks = snapshot.blocks && typeof snapshot.blocks === "object" ? snapshot.blocks : {};
  const order: string[] = Array.isArray(snapshot.blockOrder)
    ? snapshot.blockOrder.filter((id) => typeof id === "string" && blocks[id])
    : Object.keys(blocks);
  const out: LoadedBlock[] = [];
  for (const id of order) {
    const raw = blocks[id];
    if (!raw) continue;
    out.push({
      id,
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      width: Math.max(24, Number(raw.width) || 240),
      height: Math.max(24, Number(raw.height) || 48),
      category: categorize(raw),
      raw,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Image inlining                                                     */
/* ------------------------------------------------------------------ */

async function fetchAsDataUrl(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function pickImageSrc(raw: any): string {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const dataSrc = typeof data.src === "string" ? data.src : "";
  if (dataSrc) return dataSrc;
  const dataUrl = typeof data.url === "string" ? data.url : typeof data.dataUrl === "string" ? data.dataUrl : "";
  if (dataUrl && IMAGE_EXT_RE.test(dataUrl)) return dataUrl;
  if (dataUrl && typeof data.mime === "string" && data.mime.startsWith("image/")) return dataUrl;
  return "";
}

async function inlineImages(
  blocks: LoadedBlock[],
  opts?: { maxBytes?: number; timeoutMs?: number }
): Promise<Map<string, string>> {
  const maxBytes = opts?.maxBytes ?? 4_000_000;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const map = new Map<string, string>();
  await Promise.all(
    blocks.map(async (b) => {
      if (b.category !== "image") return;
      const src = pickImageSrc(b.raw);
      if (!src) return;
      if (src.startsWith("data:")) {
        map.set(b.id, src);
        return;
      }
      if (!/^https?:\/\//i.test(src)) {
        map.set(b.id, src);
        return;
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const inlined = await fetchAsDataUrl(src, controller.signal);
        if (inlined && inlined.length <= maxBytes * 1.4) {
          map.set(b.id, inlined);
        } else {
          map.set(b.id, src);
        }
      } finally {
        clearTimeout(t);
      }
    })
  );
  return map;
}

/* ------------------------------------------------------------------ */
/*  Escaping + markdown                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const MARKDOWN_SENTINEL_RE = /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__).+(?:\*\*|__)|```|^\s*[-*]\s|(?:^|\n)\|.+\|/m;
const GFM_TABLE_RE = /(^|\n)\s*\|.+\|\s*\n\s*\|[\s:|-]+\|/;

function markdownLiteToHtml(src: string): string {
  const text = String(src || "");
  if (!text) return "";
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\n/g, "<br/>");

  // Block-level split
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Heading
      const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        return `<h${level}>${inline(h[2])}</h${level}>`;
      }
      const lines = trimmed.split("\n");
      const allBullets = lines.every((l) => /^\s*[-*•]\s+/.test(l));
      if (allBullets) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      const allNumbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
      if (allNumbered) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("");
        return `<ol>${items}</ol>`;
      }
      const allQuote = lines.every((l) => /^\s*>\s?/.test(l));
      if (allQuote) {
        return `<blockquote>${inline(lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n"))}</blockquote>`;
      }
      return `<p>${inline(trimmed)}</p>`;
    })
    .join("");
}

function gfmTableToHtml(src: string): string {
  const lines = String(src || "").trim().split("\n").filter(Boolean);
  if (lines.length < 2) return markdownLiteToHtml(src);
  const splitRow = (l: string) =>
    l
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  const thead = `<thead><tr>${header.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function tiptapDocToMarkdown(
  node: any,
  listDepth = 0,
  listType: "bullet" | "ordered" | null = null,
  orderedIndex = 1
): string {
  if (!node || typeof node !== "object") return "";
  const content = Array.isArray(node.content) ? node.content : [];
  if (node.type === "text") return String(node.text || "");
  if (node.type === "paragraph") {
    return content.map((c: any) => tiptapDocToMarkdown(c)).join("") + "\n\n";
  }
  if (node.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(node.attrs?.level) || 1));
    const inner = content.map((c: any) => tiptapDocToMarkdown(c)).join("");
    return "#".repeat(level) + " " + inner + "\n\n";
  }
  if (node.type === "bulletList") {
    return content.map((c: any) => tiptapDocToMarkdown(c, listDepth + 1, "bullet")).join("");
  }
  if (node.type === "orderedList") {
    return content
      .map((c: any, i: number) => tiptapDocToMarkdown(c, listDepth + 1, "ordered", i + 1))
      .join("");
  }
  if (node.type === "listItem") {
    const indent = "  ".repeat(Math.max(0, listDepth - 1));
    const marker = listType === "ordered" ? `${orderedIndex}. ` : "- ";
    const inner = content
      .map((c: any) => tiptapDocToMarkdown(c, listDepth, listType))
      .join("")
      .replace(/\n+$/, "");
    return `${indent}${marker}${inner}\n`;
  }
  if (node.type === "taskList") {
    return content.map((c: any) => tiptapDocToMarkdown(c, listDepth + 1, "bullet")).join("");
  }
  if (node.type === "taskItem") {
    const checked = node.attrs?.checked ? "x" : " ";
    const inner = content.map((c: any) => tiptapDocToMarkdown(c)).join("").replace(/\n+$/, "");
    const indent = "  ".repeat(Math.max(0, listDepth - 1));
    return `${indent}- [${checked}] ${inner}\n`;
  }
  if (node.type === "blockquote") {
    const inner = content.map((c: any) => tiptapDocToMarkdown(c)).join("").replace(/\n+$/, "");
    return inner
      .split("\n")
      .map((l: string) => (l.trim() ? `> ${l}` : ">"))
      .join("\n") + "\n\n";
  }
  if (node.type === "codeBlock") {
    const inner = content.map((c: any) => tiptapDocToMarkdown(c)).join("");
    return "```\n" + inner + "\n```\n\n";
  }
  if (node.type === "hardBreak") return "\n";
  if (node.type === "horizontalRule") return "\n---\n\n";
  return content.map((c: any) => tiptapDocToMarkdown(c, listDepth, listType, orderedIndex)).join("");
}

/* ------------------------------------------------------------------ */
/*  Youtube / embed helpers                                            */
/* ------------------------------------------------------------------ */

function youTubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (host.endsWith("youtube.com")) {
      if (u.pathname.startsWith("/embed/")) return url;
      const id = u.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${id}`;
      const short = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (short) return `https://www.youtube.com/embed/${short[1]}`;
    }
  } catch {}
  return null;
}

/* ------------------------------------------------------------------ */
/*  Per-block HTML                                                     */
/* ------------------------------------------------------------------ */

function renderBlockHtml(b: LoadedBlock, imageSrcMap: Map<string, string>): string {
  const raw = b.raw || {};
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const content = String(data.content ?? raw.content ?? "");
  const textVariant = String(data.textVariant || "body").toLowerCase();
  const brickColor = typeof data.brickColor === "string" ? data.brickColor : "";
  const textColor = typeof data.textColor === "string" ? data.textColor : "";

  const posStyle = `left:${b.x}px;top:${b.y}px;width:${b.width}px;min-height:${b.height}px;`;
  const sizeForFixed = b.category === "image" ? "" : `height:${b.height}px;`;

  const shellStyle = [
    brickColor ? `background:${escapeAttr(brickColor)};` : "",
    textColor ? `color:${escapeAttr(textColor)};` : "",
  ].join("");
  const shellAttr = shellStyle ? ` style="${shellStyle}"` : "";

  // Image block
  if (b.category === "image") {
    const src = imageSrcMap.get(b.id) || pickImageSrc(raw);
    const alt = String(data.title || data.name || content || "image");
    const inner = src
      ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`
      : `<div class="unavailable">(image unavailable)</div>`;
    return `<div class="block block-image" data-id="${escapeAttr(b.id)}" style="${posStyle}${sizeForFixed}"><div class="shell"${shellAttr}>${inner}</div></div>`;
  }

  // Video block
  if (b.category === "video") {
    const url = typeof data.url === "string" ? data.url : "";
    const isInline = VIDEO_EXT_RE.test(url);
    const embed = youTubeEmbedUrl(url);
    let inner: string;
    if (isInline) {
      inner = `<video controls preload="metadata" src="${escapeAttr(url)}"></video>`;
    } else if (embed) {
      inner = `<iframe src="${escapeAttr(embed)}" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    } else {
      const host = hostOf(url) || "video";
      const name = String(data.name || data.title || host);
      inner = `<a class="link-card" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><span class="icon">▶</span><span class="text"><span class="title">${escapeHtml(name)}</span><span class="host">${escapeHtml(host)}</span></span></a>`;
    }
    return `<div class="block block-video" data-id="${escapeAttr(b.id)}" style="${posStyle}${sizeForFixed}"><div class="shell"${shellAttr}>${inner}</div></div>`;
  }

  // File block (PDF, audio, other files)
  if (b.category === "file") {
    const url = typeof data.url === "string" ? data.url : "";
    const mime = String(data.mime || "").toLowerCase();
    const name = String(data.name || data.title || "File");
    const isAudio = mime.startsWith("audio/") || AUDIO_EXT_RE.test(url);
    const isPdf = mime === "application/pdf" || PDF_EXT_RE.test(url);
    let inner: string;
    if (isAudio) {
      inner = `<div class="file-audio"><div class="file-name">${escapeHtml(name)}</div><audio controls preload="metadata" src="${escapeAttr(url)}"></audio></div>`;
    } else {
      const icon = isPdf ? "📄" : "📎";
      const label = isPdf ? "PDF" : "File";
      inner = `<a class="link-card" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><span class="icon">${icon}</span><span class="text"><span class="title">${escapeHtml(name)}</span><span class="host">${escapeHtml(label)}</span></span></a>`;
    }
    return `<div class="block block-file" data-id="${escapeAttr(b.id)}" style="${posStyle}${sizeForFixed}"><div class="shell"${shellAttr}>${inner}</div></div>`;
  }

  // Link block
  if (b.category === "link") {
    const url = typeof data.url === "string" ? data.url : "";
    const name = String(data.name || data.title || content || url);
    const host = hostOf(url);
    const inner = `<a class="link-card" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><span class="icon">🔗</span><span class="text"><span class="title">${escapeHtml(name)}</span><span class="host">${escapeHtml(host || url)}</span></span></a>`;
    return `<div class="block block-link" data-id="${escapeAttr(b.id)}" style="${posStyle}${sizeForFixed}"><div class="shell"${shellAttr}>${inner}</div></div>`;
  }

  // Text block (default) — includes tables, markdown, plain text, headings.
  const isHeading = textVariant === "h1" || textVariant === "h2";
  const sizeRule = isHeading ? "" : sizeForFixed;
  const cls = `text-${textVariant === "h1" ? "h1" : textVariant === "h2" ? "h2" : "body"}`;
  let textHtml: string;
  if (GFM_TABLE_RE.test(content)) {
    textHtml = gfmTableToHtml(content);
  } else if (MARKDOWN_SENTINEL_RE.test(content)) {
    textHtml = markdownLiteToHtml(content);
  } else {
    textHtml = `<div class="plain">${escapeHtml(content)}</div>`;
  }
  return `<div class="block block-text ${cls}" data-id="${escapeAttr(b.id)}" style="${posStyle}${sizeRule}"><div class="shell"${shellAttr}>${textHtml}</div></div>`;
}

/* ------------------------------------------------------------------ */
/*  Wire geometry (mirrors src/canvas/ConnectionWires.tsx)             */
/* ------------------------------------------------------------------ */

const WIRE_NODE_OUTSET = 13;

function wireAnchor(b: LoadedBlock, side: WireSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: b.x + b.width / 2, y: b.y - WIRE_NODE_OUTSET };
    case "right":
      return { x: b.x + b.width + WIRE_NODE_OUTSET, y: b.y + b.height / 2 };
    case "bottom":
      return { x: b.x + b.width / 2, y: b.y + b.height + WIRE_NODE_OUTSET };
    case "left":
      return { x: b.x - WIRE_NODE_OUTSET, y: b.y + b.height / 2 };
  }
}

function wireControlOffset(side: WireSide, distance: number): { dx: number; dy: number } {
  const offset = Math.max(40, Math.min(distance * 0.4, 150));
  switch (side) {
    case "top":
      return { dx: 0, dy: -offset };
    case "right":
      return { dx: offset, dy: 0 };
    case "bottom":
      return { dx: 0, dy: offset };
    case "left":
      return { dx: -offset, dy: 0 };
  }
}

/**
 * If a wire in the snapshot is missing `fromSide`/`toSide` (older data),
 * fall back to picking the edge of each brick that faces the other — this
 * avoids center-to-center wires.
 */
function inferSides(a: LoadedBlock, b: LoadedBlock): { fromSide: WireSide; toSide: WireSide } {
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

function buildWirePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSide: WireSide,
  toSide: WireSide,
  controlPoints?: Array<{ x: number; y: number }>
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c1 = wireControlOffset(fromSide, dist);

  if (!controlPoints || controlPoints.length === 0) {
    const c2 = wireControlOffset(toSide, dist);
    return `M ${from.x} ${from.y} C ${from.x + c1.dx} ${from.y + c1.dy}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;
  }

  const all = [from, ...controlPoints, to];

  if (all.length === 3) {
    const mid = all[1];
    const distEnd = Math.hypot(to.x - mid.x, to.y - mid.y);
    const c2 = wireControlOffset(toSide, distEnd);
    let d = `M ${from.x} ${from.y}`;
    d += ` C ${from.x + c1.dx} ${from.y + c1.dy}, ${mid.x} ${mid.y}, ${mid.x} ${mid.y}`;
    d += ` C ${mid.x} ${mid.y}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;
    return d;
  }

  const first = all[1];
  let d = `M ${from.x} ${from.y}`;
  d += ` C ${from.x + c1.dx} ${from.y + c1.dy}, ${first.x} ${first.y}, ${first.x} ${first.y}`;
  for (let i = 1; i < all.length - 2; i++) {
    const cur = all[i];
    const next = all[i + 1];
    const mx = (cur.x + next.x) / 2;
    const my = (cur.y + next.y) / 2;
    d += ` Q ${cur.x} ${cur.y}, ${mx} ${my}`;
  }
  const last = all[all.length - 2];
  const distEnd = Math.hypot(to.x - last.x, to.y - last.y);
  const c2 = wireControlOffset(toSide, distEnd);
  d += ` C ${last.x} ${last.y}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;
  return d;
}

function renderWiresSvg(
  wires: WireConnection[],
  blocksById: Record<string, LoadedBlock>,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): string {
  if (!wires.length) return "";
  // Extra padding so the outset anchors + arrowheads don't get clipped.
  const padding = 240;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;
  const viewBox = `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`;

  const VALID_SIDES: ReadonlySet<string> = new Set(["top", "right", "bottom", "left"]);
  const paths = wires
    .map((w) => {
      const a = blocksById[w.fromId];
      const b = blocksById[w.toId];
      if (!a || !b) return "";
      let fromSide: WireSide;
      let toSide: WireSide;
      if (w.fromSide && w.toSide && VALID_SIDES.has(w.fromSide) && VALID_SIDES.has(w.toSide)) {
        fromSide = w.fromSide;
        toSide = w.toSide;
      } else {
        const inferred = inferSides(a, b);
        fromSide = inferred.fromSide;
        toSide = inferred.toSide;
      }
      const from = wireAnchor(a, fromSide);
      const to = wireAnchor(b, toSide);
      const d = buildWirePath(from, to, fromSide, toSide, w.controlPoints);
      return `<path d="${d}" stroke="rgba(59,130,246,0.55)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#wire-arrow)"/>`;
    })
    .filter(Boolean)
    .join("");

  if (!paths) return "";

  return `<svg class="wires" style="left:${bounds.minX - padding}px;top:${bounds.minY - padding}px;width:${width}px;height:${height}px;overflow:visible;" viewBox="${viewBox}">
    <defs>
      <marker id="wire-arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(59,130,246,0.7)"/>
      </marker>
    </defs>
    ${paths}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/*  Notes rendering                                                    */
/* ------------------------------------------------------------------ */

function renderNotesHtml(notesPages: ExportSnapshot["notesPages"]): string {
  if (!Array.isArray(notesPages) || notesPages.length === 0) return "";
  const sections = notesPages
    .map((page) => {
      const md = tiptapDocToMarkdown(page?.content).trim();
      if (!md) return "";
      return `<article class="notes-page"><h3>${escapeHtml(page.title || "Notes")}</h3><div class="body">${markdownLiteToHtml(md)}</div></article>`;
    })
    .filter(Boolean)
    .join("");
  if (!sections) return "";
  return `<section class="notes"><h2>Notes</h2>${sections}</section>`;
}

/* ------------------------------------------------------------------ */
/*  Bounds                                                             */
/* ------------------------------------------------------------------ */

function computeBounds(blocks: LoadedBlock[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!blocks.length) return { minX: 0, minY: 0, maxX: 1280, maxY: 800 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------------ */
/*  Full document                                                      */
/* ------------------------------------------------------------------ */

export function renderGridHtml(
  snapshot: ExportSnapshot,
  opts: GridExportOptions,
  meta: ExportMeta,
  imageSrcMap: Map<string, string>
): string {
  const title = meta.title || "Untitled grid";
  const exportedAt = meta.exportedAt || new Date().toISOString();

  const include = {
    text: opts.includeText !== false,
    images: opts.includeImages !== false,
    videos: opts.includeVideos !== false,
    files: opts.includeFiles !== false,
    links: opts.includeLinks !== false,
    notes: opts.includeNotes !== false,
  };

  const allBlocks = loadBlocks(snapshot);
  const visible = allBlocks.filter((b) => {
    if (b.category === "text") return include.text;
    if (b.category === "image") return include.images;
    if (b.category === "video") return include.videos;
    if (b.category === "file") return include.files;
    if (b.category === "link") return include.links;
    return true;
  });
  const visibleById: Record<string, LoadedBlock> = {};
  for (const b of visible) visibleById[b.id] = b;

  const wires = Array.isArray(snapshot.wireConnections)
    ? snapshot.wireConnections.filter(
        (w) => w && typeof w === "object" && visibleById[w.fromId] && visibleById[w.toId]
      )
    : [];

  const bounds = computeBounds(visible);
  const blocksHtml = visible.map((b) => renderBlockHtml(b, imageSrcMap)).join("");
  const wiresHtml = renderWiresSvg(wires, visibleById, bounds);
  const notesHtml = include.notes ? renderNotesHtml(snapshot.notesPages) : "";

  const emptyState = visible.length === 0
    ? `<div class="empty">This grid is empty.</div>`
    : "";

  const initialBounds = JSON.stringify(bounds);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="generator" content="LYKN grid export" />
<meta name="exported-at" content="${escapeAttr(exportedAt)}" />
<style>
  :root {
    --bg: #ffffff;
    --fg: #0a0a0a;
    --muted: rgba(0,0,0,0.55);
    --subtle: rgba(0,0,0,0.40);
    --border: rgba(0,0,0,0.10);
    --border-strong: rgba(0,0,0,0.18);
    --brick-bg: linear-gradient(145deg, rgba(0,0,0,0.04), rgba(0,0,0,0.015));
    --brick-border: rgba(0,0,0,0.12);
    --brick-shadow: 0 2px 8px rgba(0,0,0,0.06);
    --link-bg: rgba(0,0,0,0.03);
    --link-bg-hover: rgba(0,0,0,0.06);
    --code-bg: rgba(0,0,0,0.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1f1f1f;
      --fg: #f4f4f4;
      --muted: rgba(255,255,255,0.55);
      --subtle: rgba(255,255,255,0.40);
      --border: rgba(255,255,255,0.08);
      --border-strong: rgba(255,255,255,0.16);
      --brick-bg: linear-gradient(145deg, rgba(255,255,255,0.16), rgba(255,255,255,0.06));
      --brick-border: rgba(255,255,255,0.22);
      --brick-shadow: 0 2px 8px rgba(0,0,0,0.25);
      --link-bg: rgba(255,255,255,0.06);
      --link-bg-hover: rgba(255,255,255,0.10);
      --code-bg: rgba(255,255,255,0.08);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  body { display: flex; flex-direction: column; }
  header.top {
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    backdrop-filter: blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  header.top .title { font-size: 14px; font-weight: 500; letter-spacing: -0.01em; }
  header.top .meta { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  header.top .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 999px;
    background: var(--link-bg); border: 1px solid var(--border);
    font-size: 10px; color: var(--muted);
  }
  .viewport {
    position: relative;
    flex: 1 1 auto;
    min-height: 70vh;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .viewport.dragging { cursor: grabbing; }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }

  .block { position: absolute; pointer-events: auto; user-select: text; }
  .block .shell {
    width: 100%; height: 100%;
    border-radius: 4px;
    border: 1px solid var(--brick-border);
    background: var(--brick-bg);
    box-shadow: var(--brick-shadow);
    padding: 4px 8px;
    overflow: hidden;
  }
  .block.block-text .shell { letter-spacing: -0.01em; }
  .block.text-h1 .shell { font-size: 42px; font-weight: 500; line-height: 1.15; }
  .block.text-h2 .shell { font-size: 28px; font-weight: 500; line-height: 1.3; }
  .block.text-body .shell { font-size: 14px; font-weight: 400; line-height: 1.45; }
  .block.block-text .shell .plain { white-space: pre-wrap; overflow-wrap: anywhere; }
  .block.block-text .shell h1 { font-size: 1.4em; font-weight: 600; margin: 0.2em 0 0.1em; }
  .block.block-text .shell h2 { font-size: 1.2em; font-weight: 600; margin: 0.2em 0 0.1em; }
  .block.block-text .shell h3 { font-size: 1.1em; font-weight: 600; margin: 0.2em 0 0.1em; }
  .block.block-text .shell p { margin: 0 0 0.5em; white-space: pre-wrap; }
  .block.block-text .shell ul { margin: 0.25em 0 0.5em; padding-left: 1.2em; }
  .block.block-text .shell ol { margin: 0.25em 0 0.5em; padding-left: 1.2em; }
  .block.block-text .shell li { margin-bottom: 0.15em; }
  .block.block-text .shell blockquote { border-left: 2px solid var(--border-strong); padding-left: 0.75em; margin: 0 0 0.5em; color: var(--muted); }
  .block.block-text .shell code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: 0.05em 0.3em; border-radius: 3px; font-size: 0.9em; }
  .block.block-text .shell table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 0.25em 0; }
  .block.block-text .shell th, .block.block-text .shell td { border: 1px solid var(--border-strong); padding: 4px 6px; text-align: left; }
  .block.block-text .shell thead { background: var(--link-bg); }

  .block.block-image .shell { padding: 0; }
  .block.block-image img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .block.block-image .unavailable { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 11px; color: var(--subtle); }

  .block.block-video .shell { padding: 0; }
  .block.block-video video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
  .block.block-video iframe { width: 100%; height: 100%; border: 0; display: block; }

  .block.block-file .shell { padding: 8px; }
  .block.block-file .file-audio { display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .block.block-file .file-audio .file-name { font-size: 12px; color: var(--muted); font-weight: 500; }
  .block.block-file .file-audio audio { width: 100%; }

  .block .link-card {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; height: 100%;
    border-radius: 3px;
    background: var(--link-bg);
    color: inherit; text-decoration: none;
    font-size: 12px;
    transition: background 120ms;
  }
  .block .link-card:hover { background: var(--link-bg-hover); }
  .block .link-card .icon { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; background: color-mix(in srgb, var(--bg) 70%, transparent); border: 1px solid var(--border); }
  .block .link-card .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
  .block .link-card .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .block .link-card .host { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .wires { position: absolute; pointer-events: none; }

  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--subtle); font-size: 14px; }

  .zoom-controls {
    position: fixed; bottom: 16px; right: 16px;
    display: flex; align-items: center; gap: 2px;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px;
    z-index: 20;
  }
  .zoom-controls button {
    width: 28px; height: 28px; border-radius: 999px;
    border: 0; background: transparent;
    color: var(--fg); cursor: pointer; font-size: 14px; font-family: inherit;
    display: flex; align-items: center; justify-content: center;
  }
  .zoom-controls button:hover { background: var(--link-bg); }
  .zoom-controls .pct { font-size: 11px; color: var(--muted); padding: 0 8px; min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }

  .hint {
    position: fixed; bottom: 16px; left: 16px; z-index: 20;
    font-size: 11px; color: var(--subtle);
    pointer-events: none;
  }

  section.notes {
    padding: 40px 48px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
  }
  section.notes h2 { font-size: 20px; margin: 0 0 20px; font-weight: 600; letter-spacing: -0.01em; }
  section.notes h3 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 32px 0 10px; font-weight: 500; }
  section.notes .notes-page:first-child h3 { margin-top: 0; }
  section.notes .body { font-size: 14px; line-height: 1.65; color: var(--fg); }
  section.notes .body p { margin: 0 0 1em; }
  section.notes .body h1 { font-size: 22px; margin: 1em 0 0.4em; }
  section.notes .body h2 { font-size: 18px; margin: 1em 0 0.4em; }
  section.notes .body h3 { font-size: 16px; margin: 1em 0 0.4em; color: var(--fg); text-transform: none; letter-spacing: normal; }
  section.notes .body ul, section.notes .body ol { margin: 0 0 1em; padding-left: 1.5em; }
  section.notes .body li { margin-bottom: 0.3em; }
  section.notes .body blockquote { border-left: 3px solid var(--border-strong); padding-left: 1em; margin: 0 0 1em; color: var(--muted); }
  section.notes .body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }

  @media print {
    .zoom-controls, .hint { display: none !important; }
    .viewport { overflow: visible !important; height: auto !important; }
    header.top { position: static !important; }
  }
</style>
</head>
<body>
  <header class="top">
    <div class="title">${escapeHtml(title)}</div>
    <div class="meta">
      <span class="badge">View-only</span>
      <span>Exported ${escapeHtml(new Date(exportedAt).toLocaleString())}</span>
    </div>
  </header>
  <div class="viewport" id="viewport">
    <div class="world" id="world">
      ${wiresHtml}
      ${blocksHtml}
      ${emptyState}
    </div>
    <div class="zoom-controls">
      <button type="button" data-act="out" aria-label="Zoom out">−</button>
      <span class="pct" id="pct">100%</span>
      <button type="button" data-act="in" aria-label="Zoom in">+</button>
      <button type="button" data-act="fit" aria-label="Fit to screen">⊡</button>
    </div>
    <div class="hint">Scroll to zoom · Drag to pan</div>
  </div>
  ${notesHtml}

<script>
(function () {
  var bounds = ${initialBounds};
  var vp = document.getElementById('viewport');
  var world = document.getElementById('world');
  var pctEl = document.getElementById('pct');

  var cam = { x: 0, y: 0, zoom: 1 };
  var minZoom = 0.15;
  var maxZoom = 3;

  function apply() {
    world.style.transform = 'scale(' + cam.zoom + ') translate(' + (-cam.x) + 'px, ' + (-cam.y) + 'px)';
    pctEl.textContent = Math.round(cam.zoom * 100) + '%';
  }

  function fit() {
    var rect = vp.getBoundingClientRect();
    var contentW = Math.max(1, bounds.maxX - bounds.minX);
    var contentH = Math.max(1, bounds.maxY - bounds.minY);
    var pad = 80;
    var fitZoom = Math.min(
      (rect.width - pad * 2) / contentW,
      (rect.height - pad * 2) / contentH,
      1
    );
    var zoom = Math.max(minZoom, Math.min(1, fitZoom));
    var cx = (bounds.minX + bounds.maxX) / 2;
    var cy = (bounds.minY + bounds.maxY) / 2;
    cam.zoom = zoom;
    cam.x = cx - rect.width / (2 * zoom);
    cam.y = cy - rect.height / (2 * zoom);
    apply();
  }

  function setZoomAt(nextZoom, pivotX, pivotY) {
    nextZoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
    if (nextZoom === cam.zoom) return;
    var wx = cam.x + pivotX / cam.zoom;
    var wy = cam.y + pivotY / cam.zoom;
    cam.zoom = nextZoom;
    cam.x = wx - pivotX / nextZoom;
    cam.y = wy - pivotY / nextZoom;
    apply();
  }

  function zoomCenter(delta) {
    var rect = vp.getBoundingClientRect();
    setZoomAt(cam.zoom * delta, rect.width / 2, rect.height / 2);
  }

  vp.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = vp.getBoundingClientRect();
    var factor = Math.pow(1.0015, -e.deltaY);
    setZoomAt(cam.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // Pan
  var pan = null;
  vp.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    var isInteractive = e.target && (
      e.target.closest && (
        e.target.closest('a') ||
        e.target.closest('video') ||
        e.target.closest('audio') ||
        e.target.closest('iframe') ||
        e.target.closest('button')
      )
    );
    if (isInteractive) return;
    pan = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    vp.classList.add('dragging');
    vp.setPointerCapture && vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', function (e) {
    if (!pan) return;
    var dx = e.clientX - pan.startX;
    var dy = e.clientY - pan.startY;
    cam.x = pan.camX - dx / cam.zoom;
    cam.y = pan.camY - dy / cam.zoom;
    apply();
  });
  function endPan() {
    pan = null;
    vp.classList.remove('dragging');
  }
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);
  vp.addEventListener('pointerleave', endPan);

  // Buttons
  document.querySelectorAll('.zoom-controls button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var act = btn.getAttribute('data-act');
      if (act === 'in') zoomCenter(1.2);
      else if (act === 'out') zoomCenter(1 / 1.2);
      else if (act === 'fit') fit();
    });
  });

  // Keyboard
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCenter(1.2); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomCenter(1 / 1.2); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
  });

  // Initial
  if (document.readyState === 'complete') fit();
  else window.addEventListener('load', fit);
  window.addEventListener('resize', function () { /* keep current zoom, just re-apply */ apply(); });
})();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Download helper + public entrypoint                                */
/* ------------------------------------------------------------------ */

function safeFilename(name: string, ext: string): string {
  const base = String(name || "grid")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "grid";
  return `${base}.${ext}`;
}

export function downloadHtmlBlob(html: string, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Full pipeline: snapshot → classify → inline images → render → download.
 */
export async function exportGridAsHtml(
  snapshot: ExportSnapshot,
  opts: GridExportOptions = {}
): Promise<{ html: string; filename: string; blockCount: number }> {
  const blocks = loadBlocks(snapshot);
  const include = {
    text: opts.includeText !== false,
    images: opts.includeImages !== false,
    videos: opts.includeVideos !== false,
    files: opts.includeFiles !== false,
    links: opts.includeLinks !== false,
  };
  const visible = blocks.filter((b) => include[b.category === "text" ? "text" : b.category]);

  const imageSrcMap = opts.inlineMedia === false
    ? new Map<string, string>()
    : await inlineImages(visible);

  const title = String(snapshot.title || "Untitled grid").trim() || "Untitled grid";
  const exportedAt = new Date().toISOString();
  const html = renderGridHtml(snapshot, opts, { title, exportedAt }, imageSrcMap);
  const filename = opts.filename || safeFilename(`${title}-grid`, "html");
  downloadHtmlBlob(html, filename);
  return { html, filename, blockCount: visible.length };
}
