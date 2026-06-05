import ExcelJS from 'exceljs';
import {
  maybePersistBufferArtifact,
  maybePersistTextArtifact,
  mimeTypeForFilename,
} from '../capabilityStorage.js';

const MAX_ROWS = 500;
const MAX_COLS = 50;

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToMarkdown(headers, rows) {
  const hdr = headers.map((h) => String(h ?? ''));
  const sep = hdr.map(() => '---');
  const body = rows.map((row) =>
    (Array.isArray(row) ? row : hdr.map((h) => row?.[h])).map((c) => String(c ?? '')),
  );
  const lines = [
    `| ${hdr.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Build spreadsheet tables with persisted downloadable artifacts.
 */
export async function buildSpreadsheet(args = {}, ctx = {}) {
  const outputFormat = String(args.output_format || 'markdown').trim().toLowerCase();
  const title = String(args.title || 'Sheet1').trim();
  const safeName = title.replace(/\s+/g, '-').slice(0, 40) || 'spreadsheet';
  const headers = Array.isArray(args.headers)
    ? args.headers.map((h) => String(h ?? '')).slice(0, MAX_COLS)
    : [];
  const rowsRaw = Array.isArray(args.rows) ? args.rows.slice(0, MAX_ROWS) : [];

  const rows = rowsRaw.map((row) => {
    if (Array.isArray(row)) return row.map((c) => (c == null ? '' : c));
    if (row && typeof row === 'object') {
      return headers.map((h) => (row[h] == null ? '' : row[h]));
    }
    return [];
  });

  if (!headers.length && rows.length) {
    const width = Math.max(...rows.map((r) => r.length));
    for (let i = 0; i < width; i++) headers.push(`Column ${i + 1}`);
  }

  if (!headers.length) return { ok: false, error: 'headers_or_rows_required' };

  if (outputFormat === 'csv') {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
      lines.push(headers.map((_, i) => csvEscape(row[i])).join(','));
    }
    const content = lines.join('\n');
    let result = { ok: true, format: 'csv', title, content, row_count: rows.length, filename: `${safeName}.csv` };
    return maybePersistTextArtifact(result, ctx, {
      content,
      filename: result.filename,
      mimeType: mimeTypeForFilename(result.filename),
      category: 'spreadsheets',
    });
  }

  if (outputFormat === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title.slice(0, 31) || 'Sheet1');
    ws.addRow(headers);
    for (const row of rows) ws.addRow(row);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    let result = {
      ok: true,
      format: 'xlsx',
      title,
      filename: `${safeName}.xlsx`,
      row_count: rows.length,
    };
    return maybePersistBufferArtifact(result, ctx, {
      buffer,
      filename: result.filename,
      mimeType: mimeTypeForFilename(result.filename),
      category: 'spreadsheets',
    });
  }

  const markdown = rowsToMarkdown(headers, rows);
  let result = {
    ok: true,
    format: 'markdown',
    title,
    markdown,
    markdown_table: markdown,
    row_count: rows.length,
    filename: `${safeName}.md`,
  };
  return maybePersistTextArtifact(result, ctx, {
    content: markdown,
    filename: result.filename,
    mimeType: mimeTypeForFilename(result.filename),
    category: 'spreadsheets',
  });
}
