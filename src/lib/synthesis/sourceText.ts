/**
 * Plain text for synthesis embedding (vectors), separate from tiered AI canvas context.
 */

export function stripAttachmentPayload(content: string): string {
  return String(content || "").replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, "").trim();
}

export function vaultNoteTextForSynthesis(title: string, content: string): string {
  const t = String(title || "").trim();
  const body = stripAttachmentPayload(content);
  const parts = [t ? `Title: ${t}` : "", body].filter(Boolean);
  return parts.join("\n\n").slice(0, 120_000);
}

function take(s: string, max: number): string {
  const x = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  return x.length <= max ? x : `${x.slice(0, max)}…`;
}

/** Flatten grid snapshot blocks into searchable text for embedding. */
export function snapshotToSynthesisText(snapshot: {
  title?: string;
  blocks?: Record<string, unknown>;
  blockOrder?: string[];
}): string {
  const lines: string[] = [];
  const title = String(snapshot?.title || "").trim();
  if (title) lines.push(`Board: ${title}`);

  const blocks = snapshot?.blocks || {};
  const order = Array.isArray(snapshot?.blockOrder)
    ? snapshot.blockOrder
    : Object.keys(blocks);

  for (const id of order.slice(0, 120)) {
    const b = blocks[id] as Record<string, unknown> | undefined;
    if (!b) continue;
    const type = String(b.type || "");
    if (type === "text") {
      const fmt = String(b.format || "plain");
      const c = take(String(b.content || ""), 4000);
      if (c) lines.push(`[text ${fmt}] ${c}`);
    } else if (type === "create") {
      const mode = String(b.mode || "").toLowerCase();
      const data = (b.data || {}) as Record<string, unknown>;
      if (mode === "video") {
        const url = String(data.url || b.url || "");
        const vid = String(data.videoId || b.videoId || "");
        if (url || vid) lines.push(`[video] ${vid || url}`);
      } else if (mode === "embed" || mode === "file") {
        lines.push(
          `[file] ${take(String(data.name || data.title || ""), 200)} ${take(String(data.url || ""), 500)}`,
        );
      } else if (mode === "image" || mode === "generated") {
        lines.push(`[image] ${take(String(data.title || data.name || ""), 200)}`);
      } else {
        const t = take(String(data.title || data.content || mode || ""), 1500);
        if (t) lines.push(`[create ${mode}] ${t}`);
      }
    } else if (type === "youtube" || type === "link") {
      lines.push(
        `[${type}] ${take(String(b.url || (b as { data?: { url?: string } }).data?.url || ""), 800)}`,
      );
    } else if (type === "image") {
      lines.push(`[image] ${take(String(b.src || ""), 300)}`);
    } else {
      const c = take(String(b.content || (b as { data?: { content?: string } }).data?.content || ""), 2000);
      if (c) lines.push(`[${type}] ${c}`);
    }
  }

  const wires = Array.isArray((snapshot as { wireConnections?: unknown[] }).wireConnections)
    ? (snapshot as { wireConnections: { fromId: string; toId: string }[] }).wireConnections
    : [];
  if (wires.length) {
    lines.push(
      `Connections: ${wires
        .slice(0, 40)
        .map((w) => `${w.fromId}->${w.toId}`)
        .join("; ")}`,
    );
  }

  return lines.join("\n").slice(0, 120_000);
}
