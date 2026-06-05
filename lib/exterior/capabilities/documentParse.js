import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { Readable } from 'node:stream';
import { extractPdfText } from './pdfExtract.js';
import { fetchWebPage } from '../webFetch.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;

function xlsxCellToString(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v.richText)) return v.richText.map((p) => p?.text ?? '').join('');
  if (v.text != null) return String(v.text);
  if (v.result != null) return String(v.result);
  return String(v);
}

function xlsxCsvEscape(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function extractDocx(buffer) {
  const r = await mammoth.extractRawText({ buffer });
  return { text: (r.value || '').trim(), format: 'docx' };
}

async function extractXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = row.values.slice(1).map((v) => xlsxCsvEscape(xlsxCellToString(v)));
      rows.push(cells.join(','));
    });
    return `--- Sheet: ${ws.name} ---\n${rows.join('\n')}`;
  });
  return { text: sheets.join('\n\n').trim(), format: 'xlsx', pageCount: wb.worksheets.length };
}

async function extractCsv(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.csv.read(Readable.from(buffer));
  const ws = wb.worksheets[0];
  if (!ws) return { text: '', format: 'csv' };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push(row.values.slice(1).map((v) => xlsxCellToString(v)).join(','));
  });
  return { text: rows.join('\n').trim(), format: 'csv' };
}

function extractPptx(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || '0', 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || '0', 10);
      return numA - numB;
    });
  const slides = entries.map((entry, idx) => {
    const xml = entry.getData().toString('utf8');
    const $ = cheerio.load(xml, { xmlMode: true });
    const texts = [];
    $('a\\:t, a\\:fld').each((_, el) => {
      const t = $(el).text().trim();
      if (t) texts.push(t);
    });
    return `--- Slide ${idx + 1} ---\n${texts.join('\n')}`;
  });
  return { text: slides.join('\n\n').trim(), format: 'pptx', pageCount: entries.length };
}

function extractOdt(buffer) {
  const zip = new AdmZip(buffer);
  const contentEntry = zip.getEntry('content.xml');
  if (!contentEntry) return { text: '', format: 'odt' };
  const xml = contentEntry.getData().toString('utf8');
  const $ = cheerio.load(xml, { xmlMode: true });
  const paragraphs = [];
  $('text\\:p, text\\:h').each((_, el) => {
    const t = $(el).text().trim();
    if (t) paragraphs.push(t);
  });
  return { text: paragraphs.join('\n').trim(), format: 'odt' };
}

function detectFormat({ filename, mimeType }) {
  const name = String(filename || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (mime.includes('spreadsheetml') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'xlsx';
  if (name.endsWith('.csv') || mime.includes('csv')) return 'csv';
  if (mime.includes('presentationml') || name.endsWith('.pptx')) return 'pptx';
  if (mime.includes('opendocument.text') || name.endsWith('.odt')) return 'odt';
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (mime.includes('html') || name.endsWith('.html')) return 'html';
  if (mime.includes('json') || name.endsWith('.json')) return 'json';
  if (mime.includes('text') || name.endsWith('.txt') || name.endsWith('.md')) return 'text';
  return 'unknown';
}

async function extractFromBuffer(buffer, format) {
  if (format === 'docx') return { ok: true, ...(await extractDocx(buffer)) };
  if (format === 'xlsx') return { ok: true, ...(await extractXlsx(buffer)) };
  if (format === 'csv') return { ok: true, ...(await extractCsv(buffer)) };
  if (format === 'pptx') return { ok: true, ...extractPptx(buffer) };
  if (format === 'odt') return { ok: true, ...extractOdt(buffer) };
  if (format === 'text' || format === 'html' || format === 'json') {
    return { ok: true, text: buffer.toString('utf8').trim(), format };
  }
  if (format === 'pdf') {
    return extractPdfText(buffer);
  }
  return { ok: false, error: 'unsupported_format', format };
}

/**
 * Parse documents from URL, base64 payload, or raw text.
 */
export async function parseDocument(args = {}) {
  const url = String(args.url || '').trim();
  const filename = String(args.filename || '').trim();
  const mimeType = String(args.mime_type || args.mimeType || '').trim();
  const base64 = String(args.base64 || args.content_base64 || '').trim();
  const rawText = args.text != null ? String(args.text) : '';

  if (rawText) {
    const text = rawText.slice(0, MAX_TEXT_CHARS);
    return { ok: true, format: 'text', text, char_count: text.length, truncated: rawText.length > MAX_TEXT_CHARS };
  }

  let buffer;
  let resolvedName = filename;
  let resolvedMime = mimeType;

  if (base64) {
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return { ok: false, error: 'invalid_base64' };
    }
  } else if (url) {
    const fetched = await fetchWebPage(url);
    if (!fetched.ok) return fetched;
    const text = String(fetched.text || fetched.content || '').trim();
    if (text.length >= 200) {
      return {
        ok: true,
        format: 'web_page',
        url,
        title: fetched.title || null,
        text: text.slice(0, MAX_TEXT_CHARS),
        char_count: Math.min(text.length, MAX_TEXT_CHARS),
      };
    }
    return { ok: false, error: 'url_did_not_return_parseable_document', url };
  } else {
    return { ok: false, error: 'provide_url_base64_or_text' };
  }

  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: 'file_too_large', max_bytes: MAX_BYTES };
  }

  const format = detectFormat({ filename: resolvedName, mimeType: resolvedMime });
  const extracted = await extractFromBuffer(buffer, format);
  if (!extracted.ok) return extracted;

  const text = String(extracted.text || '').slice(0, MAX_TEXT_CHARS);
  return {
    ok: true,
    format: extracted.format,
    filename: resolvedName || null,
    page_count: extracted.pageCount ?? null,
    text,
    char_count: text.length,
    truncated: (extracted.text || '').length > MAX_TEXT_CHARS,
  };
}
