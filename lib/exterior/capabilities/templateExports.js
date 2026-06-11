import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

// ── Unicode PDF font ─────────────────────────────────────────────────────────
// jsPDF's built-in Helvetica is WinAnsi/Latin-1 only, so science/math content
// (arrows → ↑ ↓, minus −, ×, Greek Δ θ μ ω Σ λ, superscripts ⁶ ⁻ ⁴, etc.)
// renders as garbage ("!’", "\"1"). DejaVu Sans covers all of it. We embed it
// from the dejavu-fonts-ttf package at runtime (read once, cached as base64) so
// no large binary lives in the repo. If the font can't be loaded we fall back
// to Helvetica (degraded glyphs, but the PDF still builds).
const PDF_FONT = 'DejaVuSans';
let _pdfFontBase64 = undefined; // undefined = not tried; null = unavailable
function loadPdfFontBase64() {
  if (_pdfFontBase64 !== undefined) return _pdfFontBase64;
  try {
    const require = createRequire(import.meta.url);
    const ttfDir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
    _pdfFontBase64 = {
      regular: fs.readFileSync(path.join(ttfDir, 'DejaVuSans.ttf')).toString('base64'),
      bold: fs.readFileSync(path.join(ttfDir, 'DejaVuSans-Bold.ttf')).toString('base64'),
    };
  } catch {
    _pdfFontBase64 = null;
  }
  return _pdfFontBase64;
}
/** Register the Unicode font on a jsPDF doc. Returns the family to setFont with. */
function registerPdfFont(doc) {
  const f = loadPdfFontBase64();
  if (!f) return 'helvetica';
  try {
    doc.addFileToVFS('DejaVuSans.ttf', f.regular);
    doc.addFont('DejaVuSans.ttf', PDF_FONT, 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', f.bold);
    doc.addFont('DejaVuSans-Bold.ttf', PDF_FONT, 'bold');
    return PDF_FONT;
  } catch {
    return 'helvetica';
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Accent-color themes. The model can pass `theme` (a name or hex) to recolor an
// artifact; everything else inherits the shared design system.
const DEFAULT_ACCENT = '#c2603f';
const THEME_COLORS = {
  clay: '#c2603f', orange: '#c2603f', terracotta: '#c2603f', rust: '#c2603f',
  blue: '#2563eb', azure: '#2563eb', sky: '#0ea5e9', cobalt: '#1d4ed8',
  indigo: '#4f46e5', purple: '#7c3aed', violet: '#7c3aed',
  green: '#16a34a', emerald: '#059669', teal: '#0d9488', mint: '#10b981',
  red: '#dc2626', rose: '#e11d48', pink: '#db2777', crimson: '#dc2626',
  amber: '#d97706', gold: '#ca8a04', yellow: '#ca8a04',
  slate: '#475569', gray: '#4b5563', grey: '#4b5563', graphite: '#334155',
};

export function resolveAccent(theme) {
  const t = String(theme || '').trim().toLowerCase();
  if (!t) return DEFAULT_ACCENT;
  if (/^#[0-9a-f]{6}$/.test(t) || /^#[0-9a-f]{3}$/.test(t)) return t;
  return THEME_COLORS[t] || DEFAULT_ACCENT;
}

function hexToRgba(hex, alpha) {
  let h = String(hex || DEFAULT_ACCENT).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// CSS that overrides the accent CSS variables (light + dark) when a non-default
// theme is requested. Returns '' for the default so the base palette is used.
function accentOverrideCss(accent) {
  if (!accent || accent.toLowerCase() === DEFAULT_ACCENT.toLowerCase()) return '';
  return (
    `\n    :root { --accent: ${accent}; --accent-soft: ${hexToRgba(accent, 0.1)}; }` +
    `\n    @media (prefers-color-scheme: dark) { :root { --accent: ${accent}; --accent-soft: ${hexToRgba(accent, 0.16)}; } }`
  );
}

// Inline formatting on ALREADY-escaped text: safe links (http/https only),
// bold, italic, inline code. No raw model HTML can survive escapeHtml, so the
// only tags in the output are the ones generated here.
function renderInline(text) {
  return String(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function isTableSeparator(line) {
  const t = String(line || '').trim();
  if (!t.includes('-')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
}

function splitTableRow(line) {
  let t = String(line || '').trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * Lightweight, safe Markdown → HTML for section bodies. Supports headings,
 * bold/italic/inline code, links, blockquotes, bullet/numbered/checkbox lists,
 * fenced code blocks, horizontal rules, and GitHub-style tables — enough to make
 * study guides, docs, and worksheets render cleanly.
 */
function renderMarkdownish(raw) {
  const escaped = escapeHtml(raw);
  const lines = escaped.split('\n');
  const html = [];
  let listType = null; // 'ul' | 'ol' | null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const trimmed = line.trim();

    // Fenced code block ```lang ... ```
    const fence = trimmed.match(/^`{3,}\s*([\w-]*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^`{3,}\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      html.push(
        `<pre class="code-block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${buf.join('\n')}</code></pre>`,
      );
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    // Horizontal rule (--- / *** / ___) — but not table separators (have pipes)
    if (!trimmed.includes('|') && /^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      closeList();
      html.push('<hr/>');
      continue;
    }

    // Table: this line has pipes and the next is a separator row
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList();
      const header = splitTableRow(trimmed);
      i++; // consume separator
      const rows = [];
      while (
        i + 1 < lines.length &&
        lines[i + 1].includes('|') &&
        lines[i + 1].trim() &&
        !isTableSeparator(lines[i + 1])
      ) {
        rows.push(splitTableRow(lines[i + 1]));
        i++;
      }
      const thead = `<thead><tr>${header
        .map((c) => `<th>${renderInline(c)}</th>`)
        .join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      html.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // Heading (# → h2, shifted down a level below the doc title)
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // Checkbox list (☐ / □ / - [ ] / - [x])
    const checkbox = trimmed.match(/^(?:[-*]\s+)?\[([ xX])\]\s+(.*)$/) || trimmed.match(/^[☐☑□✓✔]\s*(.*)$/);
    if (checkbox) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul class="checklist">');
        listType = 'ul';
      }
      const checked = checkbox.length === 3 && /[xX✓✔☑]/.test(checkbox[1] || '');
      const body = checkbox.length === 3 ? checkbox[2] : checkbox[1];
      html.push(
        `<li class="task${checked ? ' done' : ''}"><span class="box" aria-hidden="true"></span><span>${renderInline(body)}</span></li>`,
      );
      continue;
    }

    // Bullet list
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    // Numbered list
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }

    // Blockquote ("&gt;" because ">" was escaped)
    const quote = trimmed.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(trimmed)}</p>`);
  }

  closeList();
  return html.join('\n');
}

// Shared design system — a clean, editorial look (Claude-artifact style):
// warm paper background, high-contrast ink, generous spacing, refined tables,
// code blocks, and full dark-mode support.
const BASE_STYLES = `
    :root {
      --bg: #f5f4f1;
      --surface: #ffffff;
      --ink: #1f1d1a;
      --ink-soft: #4a4742;
      --muted: #8a857d;
      --line: rgba(20, 18, 14, 0.10);
      --line-soft: rgba(20, 18, 14, 0.06);
      --accent: #c2603f;
      --accent-soft: rgba(194, 96, 63, 0.10);
      --code-bg: #f3f1ec;
      --shadow: 0 1px 2px rgba(20,18,14,0.04), 0 12px 32px rgba(20,18,14,0.06);
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0; background: var(--bg); color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 16px; line-height: 1.7; letter-spacing: -0.003em;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    }
    ::selection { background: var(--accent-soft); }
    a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
    a:hover { border-bottom-color: var(--accent); }
    h1,h2,h3,h4,h5,h6 { line-height: 1.25; letter-spacing: -0.02em; color: var(--ink); }
    h2 { font-size: 1.45rem; font-weight: 680; margin: 2.4rem 0 0.85rem; }
    h3 { font-size: 1.16rem; font-weight: 650; margin: 1.7rem 0 0.55rem; }
    h4,h5,h6 { font-size: 1rem; font-weight: 650; margin: 1.3rem 0 0.4rem; color: var(--ink-soft); }
    p { margin: 0 0 1rem; }
    strong { font-weight: 660; color: var(--ink); }
    em { font-style: italic; }
    ul, ol { margin: 0 0 1.1rem; padding-left: 1.35rem; }
    li { margin: 0.32rem 0; padding-left: 0.15rem; }
    li::marker { color: var(--muted); }
    ul.checklist { list-style: none; padding-left: 0.1rem; }
    ul.checklist li.task { display: flex; align-items: flex-start; gap: 0.6rem; margin: 0.4rem 0; }
    ul.checklist .box {
      flex: 0 0 auto; width: 1.05rem; height: 1.05rem; margin-top: 0.28rem;
      border: 1.5px solid var(--line); border-radius: 0.35rem; background: var(--surface);
    }
    ul.checklist li.done .box { background: var(--accent); border-color: var(--accent);
      box-shadow: inset 0 0 0 2px var(--surface); }
    ul.checklist li.done > span:last-child { color: var(--muted); }
    code {
      background: var(--code-bg); padding: 0.12rem 0.38rem; border-radius: 0.4rem;
      font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.875em; border: 1px solid var(--line-soft);
    }
    pre.code-block {
      margin: 1.1rem 0; padding: 1rem 1.15rem; background: var(--code-bg);
      border: 1px solid var(--line-soft); border-radius: 0.7rem; overflow-x: auto;
      line-height: 1.55;
    }
    pre.code-block code { background: none; border: 0; padding: 0; font-size: 0.85rem; }
    blockquote {
      margin: 1.2rem 0; padding: 0.65rem 1.1rem; color: var(--ink-soft);
      border-left: 3px solid var(--accent); background: var(--accent-soft);
      border-radius: 0 0.5rem 0.5rem 0;
    }
    blockquote p:last-child { margin-bottom: 0; }
    hr { border: 0; height: 1px; background: var(--line); margin: 2rem 0; }
    .table-wrap { margin: 1.2rem 0; overflow-x: auto; border: 1px solid var(--line);
      border-radius: 0.7rem; box-shadow: var(--shadow); }
    table { width: 100%; border-collapse: collapse; font-size: 0.93rem; background: var(--surface); }
    thead th {
      text-align: left; font-weight: 640; color: var(--ink-soft);
      background: var(--code-bg); padding: 0.7rem 0.95rem; white-space: nowrap;
      border-bottom: 1px solid var(--line);
    }
    tbody td { padding: 0.65rem 0.95rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:nth-child(even) { background: rgba(20,18,14,0.018); }
    .meta { font-size: 0.8rem; color: var(--muted); margin: 0 0 0.5rem;
      text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
    .answer { margin: 0.85rem 0 0; padding: 0.65rem 1rem; background: var(--code-bg);
      border: 1px solid var(--line-soft); border-radius: 0.65rem; }
    .answer summary { cursor: pointer; font-weight: 640; font-size: 0.9rem; color: var(--accent);
      list-style: none; }
    .answer summary::-webkit-details-marker { display: none; }
    .answer summary::before { content: "▸ "; color: var(--accent); }
    .answer[open] summary::before { content: "▾ "; }
    .answer[open] summary { margin-bottom: 0.55rem; }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1816; --surface: #221f1c; --ink: #ece9e3; --ink-soft: #c2bdb4;
        --muted: #8f8a81; --line: rgba(255,255,255,0.12); --line-soft: rgba(255,255,255,0.07);
        --accent: #e08e6f; --accent-soft: rgba(224,142,111,0.14); --code-bg: #2a2724;
        --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.35);
      }
      tbody tr:nth-child(even) { background: rgba(255,255,255,0.025); }
    }`;

function documentSectionHtml(sec) {
  const heading = sec.heading ? `<h2>${escapeHtml(sec.heading)}</h2>` : '';
  const body = sec.body ? renderMarkdownish(sec.body) : '';
  const fieldMeta = sec.field_type
    ? `<p class="meta">Field: ${escapeHtml(sec.field_type)}${sec.required ? ' · required' : ''}</p>`
    : '';
  const answer = sec.answer_key
    ? `<details class="answer"><summary>Answer key</summary>${renderMarkdownish(sec.answer_key)}</details>`
    : '';
  return `<section class="doc-section">${heading}${fieldMeta}${body}${answer}</section>`;
}

/**
 * Self-contained, document-style HTML for non-slide templates (study guides,
 * documents, worksheets, forms, generic). Clean editorial typography in a
 * centered reading column — opens straight into a finished document.
 */
export function buildDocumentHtml(title, sections, { templateType = 'document', theme = null } = {}) {
  const items = Array.isArray(sections) ? sections : [];
  const body = items.length
    ? items.map((sec) => documentSectionHtml(sec)).join('\n')
    : `<section class="doc-section"><p>${escapeHtml(title)}</p></section>`;

  const kindLabel = escapeHtml(
    String(templateType || 'document').replace(/[-_]/g, ' '),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${BASE_STYLES}${accentOverrideCss(resolveAccent(theme))}
    .doc { max-width: 760px; margin: 0 auto; padding: 4rem 1.5rem 6rem; }
    .doc-header { margin: 0 0 2.5rem; padding: 0 0 1.6rem; border-bottom: 1px solid var(--line); }
    .doc-kind { font-size: 0.74rem; letter-spacing: 0.14em; text-transform: uppercase;
      font-weight: 700; color: var(--accent); margin: 0 0 0.7rem; }
    .doc-title { font-size: clamp(2rem, 4.5vw, 2.85rem); font-weight: 720; line-height: 1.1;
      margin: 0; letter-spacing: -0.03em; }
    .doc-section { margin: 0 0 1.6rem; }
    .doc-section > h2:first-child { margin-top: 0; }
  </style>
</head>
<body data-template-type="${escapeHtml(templateType)}">
  <main class="doc">
    <header class="doc-header">
      <p class="doc-kind">${kindLabel}</p>
      <h1 class="doc-title">${escapeHtml(title)}</h1>
    </header>
    ${body}
  </main>
</body>
</html>`;
}

function slideHtml(sec, index, total) {
  const heading = sec.heading ? `<h2>${escapeHtml(sec.heading)}</h2>` : '';
  const body = sec.body ? `<div class="body">${renderMarkdownish(sec.body)}</div>` : '';
  const notes = sec.notes ? `<aside class="notes">${escapeHtml(sec.notes)}</aside>` : '';
  return `<section class="slide" data-index="${index}">
    <div class="slide-inner">
      <div class="slide-content">${heading}${body}</div>
      ${notes}
      <footer><span class="page">${index + 1} / ${total}</span></footer>
    </div>
  </section>`;
}

/** Self-contained HTML slideshow — clean deck with keyboard + click nav. */
export function buildSlideshowHtml(title, sections, { templateType = 'slideshow', theme = null } = {}) {
  const items = Array.isArray(sections) ? sections : [];
  const slides = items.length
    ? items.map((sec, i) => slideHtml(sec, i, items.length)).join('\n')
    : slideHtml({ heading: title, body: '' }, 0, 1);

  const accent = resolveAccent(theme);
  const accentSoft = hexToRgba(accent, 0.14);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${BASE_STYLES}${accentOverrideCss(accent)}
    body { background: #15130f; color: #f4f1ea; overflow: hidden; }
    .deck { position: relative; width: 100vw; height: 100vh; }
    .slide { position: absolute; inset: 0; display: none; padding: clamp(2rem, 6vw, 5.5rem);
      opacity: 0; transition: opacity 0.35s ease; }
    .slide.active { display: flex; opacity: 1; }
    /* No-JS fallback: if the navigation script can't run (e.g. a strict CSP
       blocks inline scripts when this renders inside an iframe srcdoc), show
       the first slide instead of a blank viewport. The script removes the
       no-js marker on load so its .active toggling takes over. */
    body.no-js .slide:first-of-type { display: flex; opacity: 1; }
    body.no-js .toolbar, body.no-js .progress { display: none; }
    .slide-inner { display: flex; flex-direction: column; width: min(1000px, 100%);
      margin: auto; height: 100%; }
    .slide-content { flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .slide h2 { font-size: clamp(2rem, 5.5vw, 3.4rem); font-weight: 720; margin: 0 0 1.5rem;
      letter-spacing: -0.03em; color: #fff; }
    .slide .body { font-size: clamp(1.05rem, 2.3vw, 1.5rem); line-height: 1.6; color: #d9d4ca;
      max-width: 60ch; }
    .slide .body strong { color: #fff; }
    .slide .body ul, .slide .body ol { padding-left: 1.3rem; }
    .slide .body li { margin: 0.5rem 0; }
    .slide .body a { color: ${accent}; border-bottom-color: ${accentSoft}; }
    .slide .body code { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.12); color: #f4f1ea; }
    .slide .body .table-wrap { box-shadow: none; border-color: rgba(255,255,255,0.14); }
    .slide .body table { background: rgba(255,255,255,0.03); color: #e8e3d9; }
    .slide .body thead th { background: rgba(255,255,255,0.06); color: #fff; border-color: rgba(255,255,255,0.14); }
    .slide .body tbody td { border-color: rgba(255,255,255,0.07); }
    .notes { margin-top: 1.5rem; padding: 0.9rem 1.1rem; border-left: 3px solid ${accent};
      background: ${accentSoft}; color: #cfcabf; font-size: 0.92rem; border-radius: 0 0.5rem 0.5rem 0; }
    footer { margin-top: 1.5rem; display: flex; justify-content: flex-end; }
    .page { font-variant-numeric: tabular-nums; font-size: 0.82rem; color: #8a857c; letter-spacing: 0.04em; }
    .progress { position: fixed; left: 0; top: 0; height: 3px; background: ${accent};
      width: 0; transition: width 0.35s ease; z-index: 20; }
    .toolbar { position: fixed; bottom: 1.4rem; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem;
      background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px; backdrop-filter: blur(12px); z-index: 20; }
    .toolbar button { background: transparent; color: #f4f1ea; border: 0; cursor: pointer;
      width: 2.2rem; height: 2.2rem; border-radius: 999px; font-size: 1.1rem; line-height: 1;
      display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
    .toolbar button:hover { background: rgba(255,255,255,0.12); }
    .toolbar .count { font-size: 0.8rem; color: #b8b3a9; padding: 0 0.5rem;
      font-variant-numeric: tabular-nums; min-width: 3.5rem; text-align: center; }
  </style>
</head>
<body class="no-js" data-template-type="${escapeHtml(templateType)}">
  <div class="progress" id="progress"></div>
  <div class="deck" id="deck">${slides}</div>
  <div class="toolbar">
    <button type="button" id="prev" aria-label="Previous slide">‹</button>
    <span class="count" id="count"></span>
    <button type="button" id="next" aria-label="Next slide">›</button>
  </div>
  <script>
    document.body.classList.remove('no-js');
    const slides = [...document.querySelectorAll('.slide')];
    const progress = document.getElementById('progress');
    const count = document.getElementById('count');
    let idx = 0;
    function show(i) {
      idx = Math.max(0, Math.min(slides.length - 1, i));
      slides.forEach((s, n) => s.classList.toggle('active', n === idx));
      progress.style.width = ((idx + 1) / slides.length * 100) + '%';
      count.textContent = (idx + 1) + ' / ' + slides.length;
    }
    document.getElementById('prev').onclick = () => show(idx - 1);
    document.getElementById('next').onclick = () => show(idx + 1);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); show(idx + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(idx - 1); }
      if (e.key === 'Home') show(0);
      if (e.key === 'End') show(slides.length - 1);
    });
    show(0);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// PDF export — the "just works for everyone" download. jsPDF runs in Node with
// its built-in Helvetica (no font files needed), so we render the same content
// the HTML export shows into a clean, paginated A4 document.
// ---------------------------------------------------------------------------

// Flatten inline markdown to plain text for the PDF (links → "text (url)").
function stripInline(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1');
}

// Convert a markdown-ish body into ordered render blocks for the PDF layout.
function markdownToPdfBlocks(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const trimmed = line.trim();

    const fence = trimmed.match(/^`{3,}/);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      blocks.push({ kind: 'code', text: line });
      continue;
    }

    if (!trimmed) {
      blocks.push({ kind: 'space' });
      continue;
    }

    if (!trimmed.includes('|') && /^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      continue;
    }

    // Table → a structured block (header + rows) so we can draw a real grid
    // with jspdf-autotable instead of flattening columns into one line.
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(trimmed).map((c) => stripInline(c));
      i++; // consume separator
      const rows = [];
      while (
        i + 1 < lines.length &&
        lines[i + 1].includes('|') &&
        lines[i + 1].trim() &&
        !isTableSeparator(lines[i + 1])
      ) {
        rows.push(splitTableRow(lines[i + 1]).map((c) => stripInline(c)));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: heading[1].length <= 2 ? 'h2' : 'h3', text: stripInline(heading[2]) });
      continue;
    }

    const checkbox = trimmed.match(/^(?:[-*]\s+)?\[([ xX])\]\s+(.*)$/) || trimmed.match(/^[☐☑□✓✔]\s*(.*)$/);
    if (checkbox) {
      const checked = checkbox.length === 3 && /[xX✓✔☑]/.test(checkbox[1] || '');
      const body = checkbox.length === 3 ? checkbox[2] : checkbox[1];
      blocks.push({ kind: 'bullet', text: stripInline(body), marker: checked ? '☑' : '☐' });
      continue;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      blocks.push({ kind: 'bullet', text: stripInline(bullet[1]), marker: '•' });
      continue;
    }

    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({ kind: 'bullet', text: stripInline(numbered[2]), marker: `${numbered[1]}.` });
      continue;
    }

    const quote = trimmed.match(/^&gt;\s?(.*)$/) || trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ kind: 'quote', text: stripInline(quote[1]) });
      continue;
    }

    blocks.push({ kind: 'p', text: stripInline(trimmed) });
  }

  return blocks;
}

/**
 * Build a clean, paginated PDF from the template sections. Used as the primary
 * human-friendly download for study guides, documents, worksheets, etc.
 */
export function buildTemplatePdfBuffer(title, sections, { templateType = 'document' } = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const FONT = registerPdfFont(doc);
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensure = (needed) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const write = (text, opts = {}) => {
    const {
      size = 11,
      style = 'normal',
      color = [31, 29, 26],
      gapBefore = 0,
      gapAfter = 6,
      indent = 0,
      marker = null,
      lineFactor = 1.42,
    } = opts;
    y += gapBefore;
    // The embedded Unicode font ships normal + bold only — map italic styles
    // down so setFont never throws on an unregistered variant.
    let fontStyle = style;
    if (FONT !== 'helvetica' && (fontStyle === 'italic' || fontStyle === 'bolditalic')) {
      fontStyle = fontStyle === 'bolditalic' ? 'bold' : 'normal';
    }
    doc.setFont(FONT, fontStyle);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    const markerW = marker ? 18 : 0;
    const wrapW = Math.max(40, maxW - indent - markerW);
    const wrapped = doc.splitTextToSize(String(text || ''), wrapW);
    const lineH = size * lineFactor;
    wrapped.forEach((ln, idx) => {
      ensure(lineH);
      const x = margin + indent;
      if (marker && idx === 0) {
        doc.text(marker, x, y + size);
      }
      doc.text(ln, x + markerW, y + size);
      y += lineH;
    });
    y += gapAfter;
  };

  const rule = () => {
    ensure(14);
    doc.setDrawColor(210, 206, 198);
    doc.setLineWidth(0.6);
    doc.line(margin, y + 6, pageW - margin, y + 6);
    y += 16;
  };

  // Real bordered table (mirrors the HTML table) via jspdf-autotable, which
  // wraps long cells and paginates on its own.
  const renderTable = (header, rows) => {
    const hasHeader = Array.isArray(header) && header.length > 0;
    const hasRows = Array.isArray(rows) && rows.length > 0;
    if (!hasHeader && !hasRows) return;
    autoTable(doc, {
      startY: y + 4,
      head: hasHeader ? [header] : undefined,
      body: hasRows ? rows : [],
      margin: { left: margin, right: margin },
      tableWidth: maxW,
      styles: {
        font: FONT, fontStyle: 'normal', fontSize: 9.5, cellPadding: 5,
        textColor: [31, 29, 26], lineColor: [210, 206, 198], lineWidth: 0.5,
        overflow: 'linebreak', valign: 'top',
      },
      headStyles: {
        font: FONT, fontStyle: 'bold', fillColor: [243, 241, 236],
        textColor: [74, 71, 66], lineColor: [210, 206, 198], lineWidth: 0.5,
      },
      bodyStyles: { fillColor: [255, 255, 255] },
      alternateRowStyles: { fillColor: [250, 249, 247] },
    });
    y = (doc.lastAutoTable?.finalY ?? y) + 10;
  };

  const kindLabel = String(templateType || 'document').replace(/[-_]/g, ' ').toUpperCase();
  write(kindLabel, { size: 8.5, style: 'bold', color: [194, 96, 63], gapAfter: 4 });
  write(title || 'Untitled', { size: 24, style: 'bold', gapAfter: 8, lineFactor: 1.2 });
  rule();

  const items = Array.isArray(sections) ? sections : [];
  if (!items.length) {
    write(title || 'Untitled', { size: 11 });
  }

  items.forEach((sec) => {
    if (sec.heading) write(String(sec.heading), { size: 15, style: 'bold', gapBefore: 8, gapAfter: 6 });
    if (sec.field_type) {
      write(`Field: ${sec.field_type}${sec.required ? ' · required' : ''}`, {
        size: 8.5,
        style: 'italic',
        color: [138, 133, 125],
        gapAfter: 4,
      });
    }
    if (sec.body) {
      for (const block of markdownToPdfBlocks(sec.body)) {
        switch (block.kind) {
          case 'space':
            y += 4;
            break;
          case 'rule':
            rule();
            break;
          case 'h2':
            write(block.text, { size: 14, style: 'bold', gapBefore: 6, gapAfter: 5 });
            break;
          case 'h3':
            write(block.text, { size: 12, style: 'bold', gapBefore: 4, gapAfter: 4 });
            break;
          case 'bullet':
            write(block.text, { size: 11, indent: 14, marker: block.marker || '•', gapAfter: 3 });
            break;
          case 'quote':
            write(block.text, { size: 11, style: 'italic', color: [74, 71, 66], indent: 14, gapAfter: 5 });
            break;
          case 'code':
            write(block.text, { size: 9.5, color: [74, 71, 66], gapAfter: 1, lineFactor: 1.3 });
            break;
          case 'table':
            renderTable(block.header, block.rows);
            break;
          default:
            write(block.text, { size: 11, gapAfter: 6 });
        }
      }
    }
    if (sec.answer_key) {
      write('Answer key', { size: 10, style: 'bold', color: [194, 96, 63], gapBefore: 4, gapAfter: 3 });
      for (const block of markdownToPdfBlocks(sec.answer_key)) {
        if (block.kind === 'table') {
          renderTable(block.header, block.rows);
        } else if (block.kind === 'bullet') {
          write(block.text, { size: 10.5, indent: 14, marker: block.marker || '•', gapAfter: 3 });
        } else if (block.text) {
          write(block.text, { size: 10.5, gapAfter: 4 });
        }
      }
    }
  });

  return Buffer.from(doc.output('arraybuffer'));
}
