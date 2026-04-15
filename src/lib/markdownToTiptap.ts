/**
 * Converts a markdown string into a TipTap-compatible JSON document.
 * Handles headings, bold, italic, code, strikethrough, bullet/ordered/task lists,
 * blockquotes, code blocks, and horizontal rules.
 */

type TipTapMark = { type: string; attrs?: Record<string, any> };
type TipTapNode = {
  type: string;
  attrs?: Record<string, any>;
  content?: TipTapNode[];
  text?: string;
  marks?: TipTapMark[];
};

function parseInlineMarks(text: string): TipTapNode[] {
  if (!text) return [];

  const nodes: TipTapNode[] = [];
  // Regex order matters: bold+italic before bold before italic
  const inlineRe =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*|___[^_]+___)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(~~[^~]+~~)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = inlineRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (match[1]) {
      // inline code
      nodes.push({ type: "text", text: raw.slice(1, -1), marks: [{ type: "code" }] });
    } else if (match[2]) {
      // bold+italic
      const inner = raw.slice(3, -3);
      const innerNodes = parseInlineMarks(inner);
      for (const n of innerNodes) {
        const existing = n.marks || [];
        nodes.push({ ...n, marks: [{ type: "bold" }, { type: "italic" }, ...existing] });
      }
    } else if (match[3]) {
      // bold
      const inner = raw.slice(2, -2);
      const innerNodes = parseInlineMarks(inner);
      for (const n of innerNodes) {
        const existing = n.marks || [];
        nodes.push({ ...n, marks: [{ type: "bold" }, ...existing] });
      }
    } else if (match[4]) {
      // italic
      const inner = raw.slice(1, -1);
      const innerNodes = parseInlineMarks(inner);
      for (const n of innerNodes) {
        const existing = n.marks || [];
        nodes.push({ ...n, marks: [{ type: "italic" }, ...existing] });
      }
    } else if (match[5]) {
      // strikethrough
      nodes.push({ type: "text", text: raw.slice(2, -2), marks: [{ type: "strike" }] });
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }

  return nodes;
}

function makeParagraph(text: string): TipTapNode {
  const inline = parseInlineMarks(text);
  if (!inline.length) return { type: "paragraph" };
  return { type: "paragraph", content: inline };
}

export function markdownToTiptap(md: string): TipTapNode {
  const lines = md.split("\n");
  const nodes: TipTapNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Code block ---
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      nodes.push({
        type: "codeBlock",
        content: codeLines.length
          ? [{ type: "text", text: codeLines.join("\n") }]
          : undefined,
      });
      continue;
    }

    // --- Horizontal rule ---
    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      nodes.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // --- Heading ---
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const inline = parseInlineMarks(headingMatch[2]);
      nodes.push({
        type: "heading",
        attrs: { level },
        content: inline.length ? inline : undefined,
      });
      i++;
      continue;
    }

    // --- Blockquote (consecutive > lines) ---
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const innerMd = quoteLines.join("\n");
      const innerDoc = markdownToTiptap(innerMd);
      nodes.push({
        type: "blockquote",
        content: innerDoc.content || [{ type: "paragraph" }],
      });
      continue;
    }

    // --- Task list (consecutive - [ ] / - [x] lines) ---
    if (/^\s*[-*]\s+\[[ xX]\]\s/.test(line)) {
      const items: TipTapNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-*]\s+\[([xX ])\]\s+(.*)$/);
        if (m) {
          const checked = m[1].toLowerCase() === "x";
          items.push({
            type: "taskItem",
            attrs: { checked },
            content: [makeParagraph(m[2])],
          });
        }
        i++;
      }
      nodes.push({ type: "taskList", content: items });
      continue;
    }

    // --- Bullet list (consecutive - or * lines) ---
    if (/^\s*[-*•]\s+/.test(line) && !/^\s*[-*]\s+\[[ xX]\]/.test(line)) {
      const items: TipTapNode[] = [];
      while (
        i < lines.length &&
        /^\s*[-*•]\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+\[[ xX]\]/.test(lines[i])
      ) {
        const text = lines[i].replace(/^\s*[-*•]\s+/, "");
        items.push({ type: "listItem", content: [makeParagraph(text)] });
        i++;
      }
      nodes.push({ type: "bulletList", content: items });
      continue;
    }

    // --- Ordered list (consecutive 1. 2. lines) ---
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: TipTapNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*\d+\.\s+/, "");
        items.push({ type: "listItem", content: [makeParagraph(text)] });
        i++;
      }
      nodes.push({ type: "orderedList", content: items });
      continue;
    }

    // --- Empty line → empty paragraph ---
    if (!line.trim()) {
      nodes.push({ type: "paragraph" });
      i++;
      continue;
    }

    // --- Regular paragraph ---
    nodes.push(makeParagraph(line));
    i++;
  }

  if (!nodes.length) nodes.push({ type: "paragraph" });

  return { type: "doc", content: nodes };
}
