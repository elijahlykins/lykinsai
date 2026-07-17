// Full-document reading for the overlay. When the user is looking at a PDF /
// Word / Excel / PowerPoint file, the screenshot only shows the visible page —
// this module finds the file behind the frontmost window (via the macOS
// accessibility attribute AXDocument) and extracts ALL of its text so the AI
// can answer about the whole document.
//
// Extraction strategy (best-effort, in order):
//   1. Local parse with the same libraries the server uses (pdfjs-dist,
//      mammoth, exceljs, adm-zip, cheerio) — instant, private, works offline.
//      All of these exist in dev; the packaged app bundles only pdfjs-dist
//      (zero-dependency, whitelisted in electron-builder.json).
//   2. macOS `textutil` for Word/RTF/ODT — built into the OS, so it covers
//      those formats even in the packaged app.
//   3. The LYKN server's /api/files/extract-text route (authenticated upload).

const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");

const MAX_DOC_BYTES = 12 * 1024 * 1024;
const MAX_DOC_CHARS = 60_000;
const MAX_PDF_PAGES = 80;

// Document formats worth a full-text read. Deliberately excludes code files:
// IDEs expose AXDocument too, but the screenshot + page-scrape flow suits code
// better than dumping the whole file into the prompt.
const SUPPORTED_DOC_RE = /\.(pdf|docx|doc|rtf|xlsx|pptx|odt|txt|md|markdown)$/i;
const PLAIN_TEXT_RE = /\.(txt|md|markdown)$/i;
const TEXTUTIL_RE = /\.(docx?|rtf|odt)$/i;

function isSupportedDocumentPath(p) {
  return SUPPORTED_DOC_RE.test(String(p || ""));
}

function urlLooksLikePdf(url) {
  try {
    return /\.pdf$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

// ── Frontmost document detection ─────────────────────────────────────────────
// System Events exposes the file a window is showing via AXDocument (a file://
// URL). Requires the Accessibility + Automation permissions LYKN already asks
// for during onboarding. The overlay is a non-activating panel, so the user's
// app stays frontmost while they type into LYKN.
const FRONT_DOC_SCRIPT = `
tell application "System Events"
  set p to first process whose frontmost is true
  set appName to name of p
  set docPath to ""
  try
    set docPath to value of attribute "AXDocument" of front window of p
  end try
end tell
return appName & "|||" & docPath
`;

async function getFrontmostDocument(runOsascript) {
  if (process.platform !== "darwin") return null;
  const r = await runOsascript(FRONT_DOC_SCRIPT, 4000);
  if (r.error || !r.out) return null;
  const sep = r.out.indexOf("|||");
  if (sep < 0) return null;
  const appName = r.out.slice(0, sep).trim();
  const doc = r.out.slice(sep + 3).trim();
  // Never read our own windows (dev shell reports as "Electron").
  if (/^(Electron|LYKN)$/i.test(appName)) return null;
  if (!doc || doc === "missing value") return null;
  let filePath = doc;
  if (/^file:\/\//i.test(doc)) {
    try {
      filePath = decodeURIComponent(new URL(doc).pathname);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(filePath)) return null;
  return { appName, filePath };
}

// ── Local extractors ─────────────────────────────────────────────────────────

async function extractPdfLocal(buf) {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = mod.default || mod;
  if (pdfjs?.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.disableWorker = true;
  // Point pdfjs at its bundled standard fonts (silences per-font warnings for
  // PDFs that reference base-14 fonts). Best-effort: text extraction works
  // without them.
  let standardFontDataUrl;
  try {
    standardFontDataUrl = path.join(
      path.dirname(require.resolve("pdfjs-dist/package.json")),
      "standard_fonts/",
    );
  } catch {
    /* not packaged — fine */
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise;
  const pageCount = doc.numPages || 0;
  const maxPages = Math.min(pageCount, MAX_PDF_PAGES);
  const parts = [];
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = (content.items || [])
      .map((it) => (typeof it.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) parts.push(`--- Page ${i} ---\n${pageText}`);
  }
  const note =
    pageCount > maxPages ? `\n\n[PDF has ${pageCount} pages; extracted the first ${maxPages}.]` : "";
  return { text: parts.join("\n\n") + note, format: "pdf", pageCount };
}

async function extractDocxLocal(buf) {
  const mammoth = require("mammoth");
  const r = await mammoth.extractRawText({ buffer: buf });
  return { text: r.value || "", format: "docx" };
}

async function extractXlsxLocal(buf) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = row.values.slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v !== "object") return String(v);
        if (v instanceof Date) return v.toISOString();
        if (Array.isArray(v.richText)) return v.richText.map((p) => p?.text ?? "").join("");
        if (v.text != null) return String(v.text);
        if (v.result != null) return String(v.result);
        return String(v);
      });
      rows.push(cells.join(","));
    });
    return `--- Sheet: ${ws.name} ---\n${rows.join("\n")}`;
  });
  return { text: sheets.join("\n\n"), format: "xlsx", pageCount: wb.worksheets.length };
}

async function extractPptxLocal(buf) {
  const AdmZip = require("adm-zip");
  const cheerio = await import("cheerio");
  const zip = new AdmZip(buf);
  const entries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || "0", 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || "0", 10);
      return numA - numB;
    });
  const slides = entries.map((entry, idx) => {
    const xml = entry.getData().toString("utf8");
    const $ = cheerio.load(xml, { xmlMode: true });
    const texts = [];
    $("a\\:t, a\\:fld").each((_, el) => {
      const t = $(el).text().trim();
      if (t) texts.push(t);
    });
    return `--- Slide ${idx + 1} ---\n${texts.join("\n")}`;
  });
  return { text: slides.join("\n\n"), format: "pptx", pageCount: entries.length };
}

async function extractOdtLocal(buf) {
  const AdmZip = require("adm-zip");
  const cheerio = await import("cheerio");
  const zip = new AdmZip(buf);
  const contentEntry = zip.getEntry("content.xml");
  if (!contentEntry) return { text: "", format: "odt" };
  const xml = contentEntry.getData().toString("utf8");
  const $ = cheerio.load(xml, { xmlMode: true });
  const paragraphs = [];
  $("text\\:p, text\\:h").each((_, el) => {
    const t = $(el).text().trim();
    if (t) paragraphs.push(t);
  });
  return { text: paragraphs.join("\n"), format: "odt" };
}

async function extractLocal(buf, ext) {
  if (ext === ".pdf") return extractPdfLocal(buf);
  if (ext === ".docx") return extractDocxLocal(buf);
  if (ext === ".xlsx") return extractXlsxLocal(buf);
  if (ext === ".pptx") return extractPptxLocal(buf);
  if (ext === ".odt") return extractOdtLocal(buf);
  return null; // .doc / .rtf → textutil or server
}

// macOS-native converter; covers doc/docx/rtf/odt with no npm dependencies.
function textutilExtract(filePath) {
  return new Promise((resolve) => {
    execFile(
      "textutil",
      ["-convert", "txt", "-stdout", filePath],
      { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || "")),
    );
  });
}

async function extractViaServer(buf, name, { apiBase, token } = {}) {
  if (!apiBase || !token) return null;
  try {
    const fd = new FormData();
    fd.append("file", new Blob([buf]), name);
    const res = await fetch(`${apiBase}/api/files/extract-text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.text) {
      return finish({ text: data.text, format: data.format, pageCount: data.pageCount });
    }
    return null;
  } catch {
    return null;
  }
}

function finish({ text, format, pageCount }) {
  const full = String(text || "").trim();
  const truncated = full.length > MAX_DOC_CHARS;
  const capped = truncated
    ? full.slice(0, MAX_DOC_CHARS) +
      `\n\n[Document truncated — showing the first ${MAX_DOC_CHARS.toLocaleString()} characters.]`
    : full;
  return {
    ok: true,
    text: capped,
    format: format || null,
    pageCount: pageCount ?? null,
    charCount: full.length,
    truncated,
  };
}

// Re-parsing an 80-page PDF on every follow-up question would add seconds of
// latency, so cache by path + mtime + size.
const docCache = new Map();
const DOC_CACHE_MAX = 8;

async function extractDocumentFile(filePath, opts = {}) {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (st.size > MAX_DOC_BYTES) return { ok: false, error: "file_too_large" };

  const cached = docCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result;

  const result = await extractUncached(filePath, opts);
  if (result.ok) {
    docCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, result });
    if (docCache.size > DOC_CACHE_MAX) docCache.delete(docCache.keys().next().value);
  }
  return result;
}

async function extractUncached(filePath, opts) {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (PLAIN_TEXT_RE.test(name)) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      return finish({ text, format: ext.slice(1) });
    } catch (e) {
      return { ok: false, error: "read_failed", detail: e?.message };
    }
  }

  let buf;
  try {
    buf = await fs.readFile(filePath);
  } catch (e) {
    return { ok: false, error: "read_failed", detail: e?.message };
  }

  try {
    const local = await extractLocal(buf, ext);
    if (local && local.text && local.text.trim()) return finish(local);
  } catch (e) {
    console.log(`[doc-read] local parse failed for ${name}:`, e?.message || e);
  }

  if (process.platform === "darwin" && TEXTUTIL_RE.test(name)) {
    const text = await textutilExtract(filePath);
    if (text && text.trim()) return finish({ text, format: ext.slice(1) });
  }

  const viaServer = await extractViaServer(buf, name, opts);
  if (viaServer) return viaServer;

  return { ok: false, error: "unsupported_or_unparseable", format: ext.slice(1) };
}

// A PDF open in a browser tab: the DOM scrape only sees the rendered page(s),
// so fetch the file itself and extract every page.
async function extractPdfFromUrl(url, opts = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const ctype = String(res.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("pdf") && !urlLooksLikePdf(url)) return { ok: false, error: "not_pdf" };
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_DOC_BYTES) return { ok: false, error: "file_too_large" };
    const buf = Buffer.from(ab);
    try {
      return finish(await extractPdfLocal(buf));
    } catch {
      const viaServer = await extractViaServer(buf, "document.pdf", opts);
      return viaServer || { ok: false, error: "pdf_extract_failed" };
    }
  } catch (e) {
    return { ok: false, error: "fetch_failed", detail: e?.message };
  }
}

module.exports = {
  isSupportedDocumentPath,
  urlLooksLikePdf,
  getFrontmostDocument,
  extractDocumentFile,
  extractPdfFromUrl,
};
