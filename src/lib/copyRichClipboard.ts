/**
 * Copy assistant markdown as rich clipboard data so paste into Docs / Word /
 * Slack / email gets real headings and bold — not raw `##` / `**` markers.
 *
 * Writes both text/html (formatted, black text for light paste targets) and
 * text/plain (rendered text without markdown syntax).
 */

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(
      /(^|[\s(>])(https?:\/\/[^\s<)"']+)/g,
      '$1<a href="$2">$2</a>',
    );
}

/**
 * Lightweight markdown → semantic HTML for clipboard paste targets.
 * Intentionally small (no remark pipeline) so copy stays sync and dependency-free.
 */
export function markdownToClipboardHtml(md: string): string {
  const lines = escapeHtml(String(md || "")).split("\n");
  let html = "";
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      html += `<p>${renderInline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const flushCode = () => {
    if (!inCode) return;
    html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
    codeBuf = [];
    inCode = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const fence = /^```/.test(line.trim());
    if (fence) {
      flushPara();
      closeList();
      if (inCode) flushCode();
      else {
        inCode = true;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length, 6);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushPara();
      closeList();
      html += `<blockquote><p>${renderInline(trimmed.replace(/^>\s?/, ""))}</p></blockquote>`;
      continue;
    }

    const ol = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html += "<ol>";
      }
      html += `<li>${renderInline(ol[2])}</li>`;
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html += "<ul>";
      }
      html += `<li>${renderInline(trimmed.replace(/^[-*•]\s+/, ""))}</li>`;
      continue;
    }

    closeList();
    para.push(trimmed);
  }

  flushPara();
  closeList();
  flushCode();
  return html;
}

/** Wrap fragment HTML so Docs/Word paste as black (not dark-UI white). */
export function wrapClipboardHtml(fragmentHtml: string): string {
  const inner = String(fragmentHtml || "").trim();
  if (!inner) return "";
  return (
    `<meta charset="utf-8">` +
    `<div style="color:#000000;-webkit-text-fill-color:#000000;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;">` +
    inner +
    `</div>`
  );
}

/** Plain text from HTML — no markdown markers. */
export function htmlToPlainText(html: string): string {
  const trimmed = String(html || "").trim();
  if (!trimmed) return "";
  try {
    const doc = new DOMParser().parseFromString(trimmed, "text/html");
    return String(doc.body?.innerText || doc.body?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

export async function writeRichClipboard(plain: string, html: string): Promise<boolean> {
  const text = String(plain || "").trim();
  const rich = String(html || "").trim();
  if (!text && !rich) return false;

  if (rich && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        "text/plain": new Blob([text || htmlToPlainText(rich)], { type: "text/plain" }),
        "text/html": new Blob([rich], { type: "text/html" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      /* fall through */
    }
  }

  // Fallback: at least paste clean plain text (no ## / **), not raw markdown.
  try {
    await navigator.clipboard.writeText(text || htmlToPlainText(rich));
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text || htmlToPlainText(rich);
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy markdown source as formatted clipboard payload. */
export async function copyMarkdownAsRich(markdown: string): Promise<boolean> {
  const md = String(markdown || "");
  if (!md.trim()) return false;
  const fragment = markdownToClipboardHtml(md);
  const html = wrapClipboardHtml(fragment);
  const plain = htmlToPlainText(fragment) || md;
  return writeRichClipboard(plain, html);
}

/** Copy from an already-rendered DOM node (preferred when available). */
export async function copyElementAsRich(el: HTMLElement | null | undefined): Promise<boolean> {
  if (!el) return false;
  const plain = String(el.innerText || el.textContent || "").trim();
  const fragment = el.innerHTML || "";
  if (!plain && !fragment.trim()) return false;
  return writeRichClipboard(plain, wrapClipboardHtml(fragment));
}
