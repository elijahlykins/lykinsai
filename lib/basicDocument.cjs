"use strict";

/**
 * Assemble a simple keepable document: markdown in, a standalone HTML file out.
 *
 * Basic write-ups (letters, notes, memos, one-pagers) are HTML files the user
 * can open in a browser, attach, or upload. Interactive apps stay artifacts.
 * Deep sourced investigations stay research reports.
 */

const TITLE_MAX = 80;
const CONTENT_MAX = 200000;
const FILENAME_MAX = 80;

const WRITE_VERB_RE =
  /\b(write|draft|compose|type\s+up|write\s+(?:this|that|it)\s+out|write\s+(?:this|that|it)\s+up|put\s+(?:this|that|it)\s+in(?:to)?\s+a\s+(?:doc|document|file))\b/i;

const DOC_NOUN_RE =
  /\b(letter|memo|notes?|write[- ]?up|one[- ]?pager|bio|statement|announcement|recap|handout|essay|documents?|\bdocs?\b)\b/i;

const NOT_BASIC_DOC_RE =
  /\b(landing\s?page|web\s?app|web\s?site|dashboard|game|presentation|deck|slides?|slideshow|spreadsheet|interactive)\b/i;

const RESEARCH_DOC_RE =
  /\b(research\s+report|deep\s+research)\b|\b(report|brief|analysis|comparison|overview|landscape)\b.{0,24}\b(on|about|of|comparing|for)\b/i;

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeTitle(raw, fallback = "Document") {
  const t = String(raw || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
  return t || fallback;
}

function filenameFromTitle(title, ext = "html") {
  const stem =
    String(title || "Document")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, FILENAME_MAX) || "Document";
  const suffix = String(ext || "html").replace(/^\./, "").toLowerCase() || "html";
  return `${stem}.${suffix}`;
}

function isHtmlDocument(content) {
  const head = String(content || "").trim().slice(0, 800);
  if (!head) return false;
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head);
}

function isHtmlFragment(content) {
  const t = String(content || "").trim();
  if (!t || isHtmlDocument(t)) return false;
  return /<\/?[a-z][\s\S]*>/i.test(t.slice(0, 4000));
}

function renderInline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`,
  );
  return s;
}

function markdownToHtml(markdown) {
  const src = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!src) return "";
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    out.push(`<${tag}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      out.push("<hr/>");
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`);
      continue;
    }

    if (/^```/.test(trimmed)) {
      flush();
      i += 1;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const ul = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
      i += 1;
      continue;
    }

    const ol = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[2]);
      i += 1;
      continue;
    }

    if (trimmed.includes("|") && (trimmed.match(/\|/g) || []).length >= 2) {
      const tableLines = [];
      while (
        i < lines.length &&
        lines[i].trim().includes("|") &&
        (lines[i].trim().match(/\|/g) || []).length >= 2
      ) {
        tableLines.push(lines[i].trim());
        i += 1;
      }
      if (tableLines.length >= 2) {
        flush();
        const split = (row) => {
          let t = row.replace(/^\|/, "").replace(/\|$/, "");
          return t.split("|").map((c) => c.trim());
        };
        const header = split(tableLines[0]);
        const bodyRows = tableLines.slice(1).filter((row) => !/^\|?[\s:|-]+\|?$/.test(row));
        out.push(
          "<table><thead><tr>" +
            header.map((c) => `<th>${renderInline(c)}</th>`).join("") +
            "</tr></thead><tbody>" +
            bodyRows
              .map((row) => `<tr>${split(row).map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
              .join("") +
            "</tbody></table>",
        );
        continue;
      }
    }

    para.push(trimmed);
    i += 1;
  }
  flush();
  return out.join("\n");
}

function wrapHtmlDocument(bodyHtml, title) {
  const safeTitle = escapeHtml(sanitizeTitle(title));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    background: #fff;
    color: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  article {
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 32px 96px;
  }
  article > :first-child { margin-top: 0; }
  article > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4 { letter-spacing: -0.02em; line-height: 1.25; margin: 1.6em 0 0.5em; }
  h1 { font-size: 1.85rem; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  p, li { font-size: 1.02rem; }
  p { margin: 0 0 1em; }
  ul, ol { margin: 0 0 1em; padding-left: 1.3em; }
  a { color: #1558c0; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
    background: #f3f3f3;
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #f3f3f3;
    padding: 14px 16px;
    border-radius: 8px;
    overflow: auto;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 0 0 1em;
    padding: 0 0 0 1em;
    border-left: 3px solid #d4d4d4;
    color: #444;
  }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1.2em; }
  th, td { border: 1px solid #e5e5e5; padding: 8px 10px; text-align: left; }
  th { background: #fafafa; }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 2em 0; }
</style>
</head>
<body>
<article>
${bodyHtml}
</article>
</body>
</html>
`;
}

function titleFromContent(content, fallback = "Document") {
  const text = String(content || "");
  const htmlTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (htmlTitle?.[1]) return sanitizeTitle(htmlTitle[1].replace(/<[^>]+>/g, ""), fallback);
  const heading = /^#{1,3}\s+(.+)$/m.exec(text);
  if (heading?.[1]) return sanitizeTitle(heading[1], fallback);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
  if (h1?.[1]) return sanitizeTitle(h1[1].replace(/<[^>]+>/g, ""), fallback);
  return fallback;
}

function parseDocumentInstruction(instruction) {
  const text = String(instruction || "").trim();
  const titled = text.match(/^title:\s*(.+)$/im);
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  const title = sanitizeTitle(titled?.[1] || heading?.[1] || "", "Document");
  let content = text;
  if (titled) content = text.replace(/^title:\s*.+$/im, "").trim();
  if (!content) content = text;
  if (title === "Document" && content) {
    return { title: titleFromContent(content, "Document"), content };
  }
  return { title, content };
}

/**
 * @param {{ title?: string, content?: string, format?: string }} input
 */
function assembleDocument(input = {}) {
  const raw = String(input.content || "").trim().slice(0, CONTENT_MAX);
  if (!raw) {
    return { ok: false, error: "empty_document" };
  }
  const format = String(input.format || "").toLowerCase() === "html" || isHtmlDocument(raw) ? "html" : "markdown";
  const title = sanitizeTitle(input.title || titleFromContent(raw), "Document");
  let html;
  let markdown = format === "html" ? "" : raw;
  if (isHtmlDocument(raw)) {
    html = raw;
    if (!/<title[^>]*>/i.test(html) && title) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n<title>${escapeHtml(title)}</title>`);
    }
  } else if (format === "html" || isHtmlFragment(raw)) {
    html = wrapHtmlDocument(raw, title);
  } else {
    html = wrapHtmlDocument(markdownToHtml(raw), title);
  }
  return {
    ok: true,
    title,
    html,
    markdown,
    filename: filenameFromTitle(title, "html"),
    mimeType: "text/html; charset=utf-8",
  };
}

function looksLikeWrittenDocumentAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (NOT_BASIC_DOC_RE.test(t)) return false;
  if (RESEARCH_DOC_RE.test(t)) return false;
  if (/\bwrite\s+(?:this|that|it)\s+out\b/i.test(t)) return true;
  if (/\bwrite\s+(?:this|that|it)\s+up\b/i.test(t)) return true;
  if (/\bput\s+(?:this|that|it)\s+in(?:to)?\s+a\s+(?:doc|document|file)\b/i.test(t)) return true;
  if (/\bsomething\s+i\s+can\s+(?:send|share|upload|attach)\b/i.test(t) && WRITE_VERB_RE.test(t)) {
    return true;
  }
  return WRITE_VERB_RE.test(t) && DOC_NOUN_RE.test(t);
}

function uniquePathInDir(dir, filename, existsFn) {
  const path = require("node:path");
  const safe = filenameFromTitle(String(filename || "Document").replace(/\.[a-z0-9]{1,8}$/i, ""), "html");
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || "Document";
  let target = path.join(dir, safe);
  for (let i = 2; existsFn(target); i += 1) {
    target = path.join(dir, `${stem} (${i})${ext}`);
  }
  return target;
}

module.exports = {
  TITLE_MAX,
  CONTENT_MAX,
  escapeHtml,
  sanitizeTitle,
  filenameFromTitle,
  isHtmlDocument,
  markdownToHtml,
  wrapHtmlDocument,
  titleFromContent,
  parseDocumentInstruction,
  assembleDocument,
  looksLikeWrittenDocumentAsk,
  uniquePathInDir,
};
