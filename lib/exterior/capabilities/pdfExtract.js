const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 80;
const MAX_TEXT_CHARS = 120_000;

let pdfjsModulePromise = null;

async function getPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
      const pdfjs = mod.default || mod;
      if (pdfjs?.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.disableWorker = true;
      }
      return pdfjs;
    });
  }
  return pdfjsModulePromise;
}

/**
 * Extract text from a PDF buffer using pdfjs-dist (server-side).
 */
export async function extractPdfText(buffer, opts = {}) {
  if (!buffer?.length) return { ok: false, error: 'empty_pdf_buffer' };
  if (buffer.length > MAX_PDF_BYTES) {
    return { ok: false, error: 'pdf_too_large', max_bytes: MAX_PDF_BYTES };
  }

  try {
    const pdfjs = await getPdfJs();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages || 0;
    const maxPages = Math.min(pageCount, opts.maxPages || MAX_PDF_PAGES);
    const parts = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = (content.items || [])
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) parts.push(`--- Page ${i} ---\n${pageText}`);
    }

    const text = parts.join('\n\n').slice(0, MAX_TEXT_CHARS);
    return {
      ok: true,
      format: 'pdf',
      text,
      page_count: pageCount,
      pages_extracted: maxPages,
      char_count: text.length,
      truncated: parts.join('\n\n').length > MAX_TEXT_CHARS,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'pdf_extract_failed',
      detail: err?.message || String(err),
    };
  }
}
