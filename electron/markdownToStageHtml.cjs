/**
 * Render markdown to a styled HTML document for the Agent Mode browser tab.
 * Glass stays status-only; the stage shows the real formatted deliverable.
 */

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(raw) {
  let s = escapeHtml(raw);
  // Images first (so link regex doesn't eat them).
  s = s.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+(?:&quot;|")([^"]*)(?:&quot;|"))?\)/g,
    (_m, alt, url) =>
      `<img src="${url}" alt="${alt || ""}" loading="lazy" />`,
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+(?:&quot;|")([^"]*)(?:&quot;|"))?\)/g,
    (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

/** True when a line looks like a GFM table row. */
function isTableRowLine(line) {
  const t = String(line || "").trim();
  if (!t.includes("|")) return false;
  // At least two pipes, not a lone pipe decoration.
  if ((t.match(/\|/g) || []).length < 2) return false;
  return true;
}

/** True when a line is a GFM separator row (|---|---|). */
function isTableSeparatorLine(line) {
  const t = String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "");
  if (!t.includes("|") && !/^[\s:|-]+$/.test(t)) return false;
  const cells = t.split("|").map((c) => c.trim());
  if (!cells.length) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * Models sometimes emit an entire table on one line:
 * | Metric | Result | |---|---:| | Amount spent | $73.50 |
 * Expand row boundaries so the parser sees real lines.
 */
function expandCollapsedTableLines(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if ((t.match(/\|/g) || []).length < 4) return line;
      if (!/\|\s*\|/.test(t)) return line;
      // Only expand when a separator row is present (avoids wrecking prose with pipes).
      if (!/\|[\t ]*:?-+:?[\t ]*\|/.test(t)) return line;
      return t.replace(/\|\s+\|/g, "|\n|");
    })
    .join("\n");
}

function splitTableCells(line) {
  let t = String(line || "").trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** Parse $73.50 / 13,589 / 0.662% into a finite number (or null). */
function parseMetricNumber(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  const pct = /%$/.test(s);
  s = s.replace(/[$€£,\s]/g, "").replace(/%$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Percents stay as their face value for bar scale among percent rows only —
  // mixed units are handled by normalizeChartRows.
  return pct ? n : n;
}

function isPercentCell(raw) {
  return /%$/.test(String(raw || "").trim());
}

/**
 * Build a simple SVG bar chart from a 2-column label/value table.
 * Returns "" when the table isn't a good chart candidate.
 */
function metricTableToChartSvg(headers, rows) {
  if (!Array.isArray(headers) || headers.length < 2) return "";
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 16) return "";
  // Prefer 2-column metric tables (Metric | Result).
  if (headers.length !== 2) return "";

  const parsed = rows
    .map((r) => {
      const label = String(r[0] || "").trim();
      const raw = String(r[1] || "").trim();
      const value = parseMetricNumber(raw);
      return { label, raw, value, percent: isPercentCell(raw) };
    })
    .filter((r) => r.label && r.value != null && r.value >= 0);

  if (parsed.length < 2) return "";

  // Don't mix % with currency/counts on one axis — chart only same-kind rows.
  const allPct = parsed.every((r) => r.percent);
  const nonePct = parsed.every((r) => !r.percent);
  const series = allPct || nonePct ? parsed : parsed.filter((r) => !r.percent);
  if (series.length < 2) return "";

  const max = Math.max(...series.map((r) => r.value), 1e-9);
  const rowH = 28;
  const labelW = 130;
  const barMaxW = 280;
  const padX = 12;
  const padY = 10;
  const width = labelW + barMaxW + padX * 2 + 72;
  const height = padY * 2 + series.length * rowH;
  const bars = series
    .map((r, i) => {
      const y = padY + i * rowH;
      const w = Math.max(4, Math.round((r.value / max) * barMaxW));
      const label = escapeHtml(r.label.slice(0, 28));
      const val = escapeHtml(r.raw);
      return (
        `<text x="${padX}" y="${y + 18}" class="chart-label">${label}</text>` +
        `<rect x="${padX + labelW}" y="${y + 6}" width="${w}" height="14" rx="3" class="chart-bar"/>` +
        `<text x="${padX + labelW + w + 8}" y="${y + 18}" class="chart-val">${val}</text>`
      );
    })
    .join("");

  return (
    `<figure class="chart-wrap">` +
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Bar chart">` +
    bars +
    `</svg></figure>`
  );
}

function renderMarkdownTable(headerCells, bodyRows) {
  const thead =
    `<thead><tr>` +
    headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("") +
    `</tr></thead>`;
  const tbody =
    `<tbody>` +
    bodyRows
      .map(
        (row) =>
          `<tr>` +
          row.map((c) => `<td>${renderInline(c)}</td>`).join("") +
          `</tr>`,
      )
      .join("") +
    `</tbody>`;
  const chart = metricTableToChartSvg(headerCells, bodyRows);
  return `${chart}<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function markdownBodyToHtml(markdown) {
  const src = expandCollapsedTableLines(String(markdown || "").replace(/\r\n/g, "\n"));
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let listType = null; // "ul" | "ol"

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (type) => {
    if (listType === type) return;
    closeList();
    listType = type;
    out.push(`<${type}>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    const fence = trimmed.match(/^```([\w-]*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] || "";
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      out.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(
          codeLines.join("\n"),
        )}</code></pre>`,
      );
      continue;
    }

    if (!trimmed) {
      closeList();
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push("<hr/>");
      i += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${quote.map((q) => `<p>${renderInline(q)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // GFM table: header + separator + body rows
    if (
      isTableRowLine(trimmed) &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      closeList();
      const headerCells = splitTableCells(trimmed);
      i += 2; // skip header + separator
      const bodyRows = [];
      while (i < lines.length && isTableRowLine(lines[i]) && !isTableSeparatorLine(lines[i])) {
        const cells = splitTableCells(lines[i]);
        // Pad / trim to header width
        const row = headerCells.map((_, idx) => cells[idx] || "");
        bodyRows.push(row);
        i += 1;
      }
      out.push(renderMarkdownTable(headerCells, bodyRows));
      continue;
    }

    const ul = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ul) {
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      i += 1;
      continue;
    }

    const ol = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ol) {
      openList("ol");
      out.push(`<li>${renderInline(ol[1])}</li>`);
      i += 1;
      continue;
    }

    // Paragraph — gather until blank / block start
    closeList();
    const para = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next) break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(next)) break;
      if (/^[-*•]\s+/.test(next)) break;
      if (/^\d+[.)]\s+/.test(next)) break;
      if (/^>\s?/.test(next)) break;
      if (/^```/.test(next)) break;
      // Don't swallow a table into a paragraph
      if (
        isTableRowLine(next) &&
        i + 1 < lines.length &&
        isTableSeparatorLine(lines[i + 1])
      ) {
        break;
      }
      para.push(next);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  closeList();
  return out.join("\n");
}

function titleFromMarkdown(markdown, fallback = "Document") {
  const m = String(markdown || "").match(/^#{1,3}\s+(.+)$/m);
  const t = (m?.[1] || fallback).replace(/\s+/g, " ").trim();
  return t.slice(0, 48) || fallback;
}

/**
 * @param {string} markdown
 * @param {string} [title]
 * @param {{ theme?: "light" | "incognito" | "dark" }} [opts]
 * Theme matches agent browser chrome: light #ececeb + dark text,
 * incognito #1e1e1e + white text. No paper card — body sits on the page bg.
 */
function wrapReportAsStageHtml(markdown, title, opts = {}) {
  const bodyMd = String(markdown || "").trim();
  const safeTitle = escapeHtml(title || titleFromMarkdown(bodyMd, "Document"));
  const bodyHtml = markdownBodyToHtml(bodyMd);
  const themeRaw = String(opts?.theme || "light").toLowerCase();
  const incognito = themeRaw === "incognito" || themeRaw === "dark";
  const theme = incognito ? "incognito" : "light";
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<style>
  /* Match agent-stage / welcome page: light #ececeb · incognito #1e1e1e */
  :root,
  html[data-theme="light"] {
    --bg: #ececeb;
    --text: #0a0a0a;
    --muted: #5c5c5c;
    --border: rgba(0, 0, 0, 0.12);
    --link: #1d4ed8;
    --code-bg: rgba(0, 0, 0, 0.06);
    --quote: #3f3f46;
    --table-head: rgba(0, 0, 0, 0.04);
    --chart-bar: #2563eb;
  }
  html[data-theme="incognito"],
  html[data-theme="dark"] {
    --bg: #1e1e1e;
    --text: #fafafa;
    --muted: #a3a3a3;
    --border: rgba(255, 255, 255, 0.12);
    --link: #93c5fd;
    --code-bg: rgba(255, 255, 255, 0.08);
    --quote: #d4d4d8;
    --table-head: rgba(255, 255, 255, 0.06);
    --chart-bar: #60a5fa;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 32px 96px;
  }
  .body > :first-child { margin-top: 0; }
  .body > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4, h5, h6 {
    letter-spacing: -0.02em;
    line-height: 1.25;
    margin: 1.5em 0 0.55em;
    font-weight: 700;
    color: var(--text);
  }
  h1 { font-size: 1.85rem; margin-top: 0; }
  h2 { font-size: 1.35rem; }
  h3 { font-size: 1.15rem; }
  h4, h5, h6 { font-size: 1.05rem; }
  p { margin: 0 0 1em; font-size: 1.05rem; color: var(--text); }
  ul, ol { margin: 0 0 1em; padding-left: 1.35em; color: var(--text); }
  li { margin: 0.28em 0; }
  li::marker { color: var(--muted); }
  a { color: var(--link); text-underline-offset: 2px; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  del { opacity: 0.75; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: var(--code-bg);
    padding: 0.12em 0.38em;
    border-radius: 5px;
  }
  pre {
    margin: 0 0 1.15em;
    padding: 14px 16px;
    overflow: auto;
    background: var(--code-bg);
    border-radius: 10px;
    border: 1px solid var(--border);
  }
  pre code {
    background: none;
    padding: 0;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  blockquote {
    margin: 0 0 1.15em;
    padding: 0.15em 0 0.15em 1em;
    border-left: 3px solid var(--border);
    color: var(--quote);
  }
  blockquote p { margin: 0.35em 0; }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.6em 0;
  }
  img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    display: block;
    margin: 0.75em 0;
  }
  .table-wrap {
    margin: 0 0 1.25em;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.98rem;
  }
  th, td {
    padding: 0.65em 0.85em;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    background: var(--table-head);
    font-weight: 650;
    color: var(--text);
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }
  td:nth-child(n+2) { font-variant-numeric: tabular-nums; }
  .chart-wrap {
    margin: 0 0 0.85em;
    padding: 12px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--table-head);
  }
  .chart-wrap svg { display: block; max-width: 100%; }
  .chart-label { fill: var(--text); font-size: 12px; font-family: inherit; }
  .chart-val { fill: var(--muted); font-size: 12px; font-family: inherit; }
  .chart-bar { fill: var(--chart-bar); }
</style>
</head>
<body>
  <main>
    <div class="body">${bodyHtml || `<p>${escapeHtml(bodyMd)}</p>`}</div>
  </main>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  markdownBodyToHtml,
  titleFromMarkdown,
  wrapReportAsStageHtml,
  expandCollapsedTableLines,
  metricTableToChartSvg,
  isTableRowLine,
  isTableSeparatorLine,
};
