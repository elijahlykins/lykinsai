/**
 * Converts clipboard HTML to structured text (markdown-style) so that
 * pasted tables, lists, and paragraphs appear as they were in the source.
 * Used for paste in grid bricks and chat input.
 */
export function htmlToStructuredText(html: string, plainFallback: string): string {
  const trimmed = String(html || "").trim();
  if (!trimmed) return String(plainFallback || "").trim();

  try {
    const doc = new DOMParser().parseFromString(trimmed, "text/html");
    const body = doc.body;
    if (!body) return String(plainFallback || "").trim();

    const parts: string[] = [];

    const getText = (el: Element): string => {
      return (el.textContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    };

    const walk = (parent: Element) => {
      const nodes = Array.from(parent.childNodes);
      for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = (node.textContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            if (t.trim()) parts.push(t.trim());
          }
          continue;
        }
        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        if (tag === "table") {
          const rows: string[][] = [];
          const trs = el.querySelectorAll("tr");
          trs.forEach((tr) => {
            const row: string[] = [];
            const cells = tr.querySelectorAll("td, th");
            cells.forEach((cell) => {
              row.push(getText(cell).replace(/\|/g, "\\|").replace(/\n/g, " "));
            });
            if (row.length) rows.push(row);
          });
          if (rows.length > 0) {
            const colCount = Math.max(...rows.map((r) => r.length));
            const normalized = rows.map((r) => {
              const pad = [...r];
              while (pad.length < colCount) pad.push("");
              return pad;
            });
            const sep = "| " + Array(colCount).fill("---").join(" | ") + " |";
            const lines = normalized.map((r) => "| " + r.join(" | ") + " |");
            parts.push(lines[0]);
            parts.push(sep);
            parts.push(...lines.slice(1));
            parts.push("");
          }
          continue;
        }

        if (tag === "ul" || tag === "ol") {
          const items = el.querySelectorAll(":scope > li");
          let i = 0;
          items.forEach((li) => {
            const text = getText(li).replace(/\n/g, " ").trim();
            if (!text) return;
            const bullet = tag === "ol" ? `${++i}. ` : "• ";
            parts.push(bullet + text);
          });
          if (items.length > 0) parts.push("");
          continue;
        }

        if (tag === "li") {
          const text = getText(el).replace(/\n/g, " ").trim();
          if (text) parts.push("• " + text);
          continue;
        }

        if (tag === "br") {
          parts.push("");
          continue;
        }
        if (tag === "p" || tag === "div") {
          walk(el);
          parts.push("");
          continue;
        }
        if (tag.startsWith("h") && tag.length === 2 && /^[1-6]$/.test(tag[1])) {
          const level = parseInt(tag[1], 10) || 1;
          parts.push("#".repeat(level) + " " + getText(el));
          parts.push("");
          continue;
        }
        if (tag === "tr") {
          const row: string[] = [];
          el.querySelectorAll("td, th").forEach((cell) => row.push(getText(cell).replace(/\|/g, "\\|").replace(/\n/g, " ")));
          if (row.length) parts.push("| " + row.join(" | ") + " |");
          continue;
        }
        if (tag === "td" || tag === "th") {
          parts.push(getText(el).replace(/\n/g, " "));
          continue;
        }

        walk(el);
      }
    };

    walk(body);

    const out = parts
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return out || String(plainFallback || "").trim();
  } catch {
    return String(plainFallback || "").trim();
  }
}

/**
 * Get paste-ready text from clipboard event: use HTML if present and convert
 * to structured text, otherwise use plain text.
 */
export function getStructuredPasteFromEvent(e: React.ClipboardEvent | ClipboardEvent): string {
  const html = typeof e.clipboardData?.getData === "function" ? e.clipboardData.getData("text/html") : "";
  const plain = typeof e.clipboardData?.getData === "function" ? e.clipboardData.getData("text/plain") : "";
  return htmlToStructuredText(html, plain);
}
