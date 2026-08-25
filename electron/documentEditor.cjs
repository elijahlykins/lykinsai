/**
 * Rich-document editing for Local Mode — the write-side sibling of
 * documentReader.cjs.
 *
 * local_edit_file has always been text-only; this module extends it to the
 * document formats users actually keep on disk. Honesty about what each
 * format allows is the design:
 *
 *   - .xlsx     TRUE in-place editing via exceljs: matching cell values are
 *               replaced, everything else (sheets, formulas, formatting)
 *               survives the round trip.
 *   - .docx / .doc / .rtf / .odt
 *               extract → replace → regenerate through macOS `textutil`.
 *               The words are right; character styling is flattened.
 *   - .pdf     extract (pdfjs) → replace → regenerate (jspdf) as clean
 *               text pages. PDF has no reflowable text model, so this is a
 *               rewrite, not a patch — layout, images and styling go.
 *
 * Because regeneration is lossy for everything but xlsx, the DEFAULT is to
 * write the result to a sibling file — "name (edited).ext" — and leave the
 * original untouched. `overwrite: true` opts into replacing the original.
 * Every result carries a `note` saying exactly what was preserved and where
 * the output landed, so the model can report honestly.
 *
 * Libraries beyond pdfjs are dev-bundle only (see electron-builder.json), so
 * every path degrades to a clear error that tells the model what to do
 * instead — never a crash, never a silent no-op.
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");

const MAX_DOC_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 80;
const MAX_PDF_TEXT_CHARS = 300_000;

const EDITABLE_DOC_RE = /\.(pdf|docx?|rtf|odt|xlsx)$/i;
const TEXTUTIL_FORMATS = { ".docx": "docx", ".doc": "doc", ".rtf": "rtf", ".odt": "odt" };

function isEditableDocumentPath(p) {
  return EDITABLE_DOC_RE.test(String(p || ""));
}

/** "report.pdf" → "report (edited).pdf", counting up if that exists too. */
async function editedSiblingPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let n = 1; n <= 50; n += 1) {
    const candidate = path.join(dir, `${base} (edited${n > 1 ? ` ${n}` : ""})${ext}`);
    try {
      await fsp.stat(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base} (edited ${Date.now()})${ext}`);
}

/** Same exact-match contract the text editor uses. */
function applyReplacement(text, { oldText, newText, replaceAll }) {
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) {
    return {
      error:
        "oldText was not found in the document's extracted text. It must match EXACTLY — " +
        "read the file with local_read_file first and copy the snippet verbatim from what it returns.",
    };
  }
  if (occurrences > 1 && replaceAll !== true) {
    return {
      error:
        `oldText appears ${occurrences} times in the document. Include more surrounding words so it ` +
        "matches exactly once, or pass replaceAll: true to change every occurrence.",
    };
  }
  return {
    next: replaceAll === true ? text.split(oldText).join(newText) : text.replace(oldText, newText),
    replacements: replaceAll === true ? occurrences : 1,
  };
}

// ── xlsx: true in-place cell editing ────────────────────────────────────────

async function editXlsx(filePath, outPath, { oldText, newText, replaceAll }) {
  let ExcelJS;
  try {
    ExcelJS = require("exceljs");
  } catch {
    return {
      ok: false,
      error:
        "Spreadsheet editing isn't available in this build. Read the sheet with local_read_file " +
        "and write the corrected data to a new .csv file instead.",
    };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Pass 1 — count occurrences across every plain-string cell so the
  // uniqueness contract matches the text editor's. Formula cells are never
  // touched: overwriting a computed value with text corrupts the sheet.
  const cellText = (cell) => {
    const v = cell.value;
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && Array.isArray(v.richText)) {
      return v.richText.map((p) => p?.text ?? "").join("");
    }
    return null;
  };
  const matches = [];
  let occurrences = 0;
  wb.worksheets.forEach((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell);
        if (text == null || !text.includes(oldText)) return;
        const count = text.split(oldText).length - 1;
        occurrences += count;
        matches.push({ cell, text });
      });
    });
  });

  if (occurrences === 0) {
    return {
      ok: false,
      error:
        "oldText was not found in any cell. It must match the cell contents EXACTLY — read the " +
        "sheet with local_read_file first. Formula cells cannot be edited this way.",
    };
  }
  if (occurrences > 1 && replaceAll !== true) {
    return {
      ok: false,
      error:
        `oldText appears ${occurrences} times across the workbook. Make it unique (include more of ` +
        "the cell's text), or pass replaceAll: true to change every occurrence.",
    };
  }

  for (const m of matches) {
    // A rich-text match collapses that one cell to plain text; the words are
    // preserved, the per-run styling in that cell is not.
    m.cell.value = m.text.split(oldText).join(newText);
  }
  await wb.xlsx.writeFile(outPath);
  return {
    ok: true,
    replacements: occurrences,
    format: "xlsx",
    note: "Cell values updated; sheets, formulas and formatting preserved.",
  };
}

// ── docx / doc / rtf / odt: textutil round trip ─────────────────────────────

function runTextutil(args) {
  return new Promise((resolve) => {
    execFile(
      "textutil",
      args,
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout ?? "")),
    );
  });
}

async function editViaTextutil(filePath, outPath, ext, { oldText, newText, replaceAll }) {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      error:
        "Word/RTF/ODT editing needs macOS. Read the document with local_read_file and write the " +
        "edited content to a new .md or .txt file instead.",
    };
  }
  const extracted = await runTextutil(["-convert", "txt", "-stdout", filePath]);
  if (extracted == null || !extracted.trim()) {
    return { ok: false, error: "Could not extract the document's text to edit it." };
  }
  const r = applyReplacement(extracted, { oldText, newText, replaceAll });
  if (r.error) return { ok: false, error: r.error };

  const tmp = path.join(
    path.dirname(outPath),
    `.lykn-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  try {
    await fsp.writeFile(tmp, r.next, "utf8");
    const converted = await runTextutil([
      "-convert",
      TEXTUTIL_FORMATS[ext],
      tmp,
      "-output",
      outPath,
    ]);
    if (converted == null) return { ok: false, error: "Converting the edited text back failed." };
    try {
      await fsp.stat(outPath);
    } catch {
      return { ok: false, error: "Converting the edited text back produced no file." };
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
  return {
    ok: true,
    replacements: r.replacements,
    format: ext.slice(1),
    note: "Edited through plain text — the words are updated, character styling was flattened.",
  };
}

// ── pdf: extract → replace → regenerate ─────────────────────────────────────

async function extractPdfText(buf) {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = mod.default || mod;
  let standardFontDataUrl;
  try {
    standardFontDataUrl = path.join(
      path.dirname(require.resolve("pdfjs-dist/package.json")),
      "standard_fonts/",
    );
  } catch {
    /* fine without */
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise;
  const pageCount = doc.numPages || 0;
  const maxPages = Math.min(pageCount, MAX_PDF_PAGES);
  const pages = [];
  let chars = 0;
  for (let i = 1; i <= maxPages && chars < MAX_PDF_TEXT_CHARS; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = (content.items || [])
      .map((it) => (typeof it.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(pageText);
    chars += pageText.length;
  }
  return { pages, pageCount, partial: pageCount > maxPages || chars >= MAX_PDF_TEXT_CHARS };
}

async function editPdf(filePath, outPath, { oldText, newText, replaceAll }) {
  let jsPDF;
  try {
    ({ jsPDF } = require("jspdf"));
  } catch {
    return {
      ok: false,
      error:
        "PDF editing isn't available in this build. Read the PDF with local_read_file and write " +
        "the edited content to a new .md or .txt file instead.",
    };
  }
  const buf = await fsp.readFile(filePath);
  let extracted;
  try {
    extracted = await extractPdfText(buf);
  } catch (e) {
    return { ok: false, error: `Could not read the PDF's text: ${e?.message || e}` };
  }
  if (extracted.partial) {
    return {
      ok: false,
      error:
        "This PDF is too long to edit safely — regenerating it would silently drop the pages " +
        "beyond the extraction cap. Read it and write the edited content to a new file instead.",
    };
  }
  const fullText = extracted.pages.join("\n\n");
  if (!fullText.trim()) {
    return {
      ok: false,
      error:
        "This PDF has no extractable text (likely scanned images), so there is nothing to edit this way.",
    };
  }
  const r = applyReplacement(fullText, { oldText, newText, replaceAll });
  if (r.error) return { ok: false, error: r.error };

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setFontSize(11);
  const margin = 18;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  const lineHeight = 6;
  let y = margin;
  for (const para of r.next.split(/\n+/)) {
    const lines = doc.splitTextToSize(para.trim() || " ", width);
    for (const line of lines) {
      if (y > bottom) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += lineHeight / 2;
  }
  await fsp.writeFile(outPath, Buffer.from(doc.output("arraybuffer")));
  return {
    ok: true,
    replacements: r.replacements,
    format: "pdf",
    note:
      "The PDF was regenerated as clean text pages — the words are updated, but the original " +
      "layout, images and styling are not carried over.",
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Edit one rich document. Same contract as the text editor (exact oldText,
 * unique unless replaceAll), plus `overwrite` — without it, the result is a
 * sibling "(edited)" file and the original is untouched.
 *
 * @returns {Promise<{ok:boolean, path?:string, outputPath?:string, replacements?:number, format?:string, note?:string, error?:string}>}
 */
async function editDocumentFile(filePath, { oldText, newText, replaceAll = false, overwrite = false } = {}) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (!EDITABLE_DOC_RE.test(filePath || "")) {
    return { ok: false, error: `Unsupported document type: ${ext || "(none)"}` };
  }
  if (!String(oldText ?? "")) {
    return { ok: false, error: "oldText is required — to create a new document, use local_write_file" };
  }
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return { ok: false, error: `${filePath} does not exist` };
  }
  if (st.isDirectory()) return { ok: false, error: `${filePath} is a directory` };
  if (st.size > MAX_DOC_BYTES) {
    return { ok: false, error: `Document too large to edit (${Math.round(st.size / 1024 / 1024)} MB)` };
  }

  const outPath = overwrite === true ? filePath : await editedSiblingPath(filePath);
  const args = { oldText: String(oldText), newText: String(newText ?? ""), replaceAll };

  let result;
  try {
    if (ext === ".xlsx") result = await editXlsx(filePath, outPath, args);
    else if (ext === ".pdf") result = await editPdf(filePath, outPath, args);
    else result = await editViaTextutil(filePath, outPath, ext, args);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (!result.ok) return result;

  return {
    ok: true,
    path: filePath,
    outputPath: outPath,
    replacements: result.replacements,
    format: result.format,
    note:
      result.note +
      (overwrite === true
        ? " The original file was overwritten."
        : ` The original is untouched; the edited version is at ${outPath}.`),
  };
}

module.exports = { isEditableDocumentPath, editDocumentFile };
