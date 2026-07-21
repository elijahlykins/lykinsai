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

function normalizeRows(headers, rowsRaw) {
  return rowsRaw.map((row) => {
    if (Array.isArray(row)) return row.map((c) => (c == null ? '' : c));
    if (row && typeof row === 'object') {
      return headers.map((h) => (row[h] == null ? '' : row[h]));
    }
    return [];
  });
}

/**
 * Apply cell / row patches to an open spreadsheet.
 *   • { row, col|column, value }
 *   • { row, values: [...] } — replace whole row
 *   • { insert_row, values? }
 *   • { remove_row }
 */
export function applySpreadsheetEdits(headersIn, rowsIn, edits) {
  let headers = (Array.isArray(headersIn) ? headersIn : []).map((h) => String(h ?? ''));
  let rows = normalizeRows(headers, Array.isArray(rowsIn) ? rowsIn : []).map((r) => [...r]);

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    if (typeof e.remove_row === 'number') {
      if (e.remove_row < 0 || e.remove_row >= rows.length) {
        return { ok: false, error: 'sheet_edit_bad_row', hint: `cell_edits[${i}].remove_row out of range.` };
      }
      rows.splice(e.remove_row, 1);
      continue;
    }
    if (typeof e.insert_row === 'number') {
      const at = Math.max(0, Math.min(rows.length, e.insert_row));
      const vals = Array.isArray(e.values)
        ? e.values.map((c) => (c == null ? '' : c))
        : headers.map(() => '');
      rows.splice(at, 0, vals.slice(0, MAX_COLS));
      continue;
    }
    if (typeof e.row !== 'number') {
      return {
        ok: false,
        error: 'sheet_edit_missing_row',
        hint: `cell_edits[${i}] needs row, insert_row, or remove_row.`,
      };
    }
    if (e.row < 0 || e.row >= rows.length) {
      return { ok: false, error: 'sheet_edit_bad_row', hint: `cell_edits[${i}].row out of range.` };
    }
    if (Array.isArray(e.values)) {
      rows[e.row] = e.values.map((c) => (c == null ? '' : c)).slice(0, MAX_COLS);
      continue;
    }
    let col = typeof e.col === 'number' ? e.col : -1;
    if (col < 0 && e.column != null) {
      col = headers.findIndex((h) => h === String(e.column));
    }
    if (col < 0 || col >= Math.max(headers.length, MAX_COLS)) {
      return {
        ok: false,
        error: 'sheet_edit_bad_col',
        hint: `cell_edits[${i}] needs a valid col index or column header name.`,
      };
    }
    while (rows[e.row].length <= col) rows[e.row].push('');
    rows[e.row][col] = e.value == null ? '' : e.value;
  }

  return { ok: true, headers: headers.slice(0, MAX_COLS), rows: rows.slice(0, MAX_ROWS) };
}

/**
 * Build spreadsheet tables with persisted downloadable artifacts.
 */
export async function buildSpreadsheet(args = {}, ctx = {}) {
  const outputFormat = String(args.output_format || 'markdown').trim().toLowerCase();
  const title = String(args.title || ctx.activeArtifactTitle || 'Sheet1').trim();
  const safeName = title.replace(/\s+/g, '-').slice(0, 40) || 'spreadsheet';
  const wantsFullRewrite = args.full_rewrite === true;
  const cellEdits = Array.isArray(args.cell_edits)
    ? args.cell_edits.filter((e) => e && typeof e === 'object')
    : [];

  const activeHeaders = Array.isArray(ctx.activeArtifactHeaders) ? ctx.activeArtifactHeaders : [];
  const activeRows = Array.isArray(ctx.activeArtifactRows) ? ctx.activeArtifactRows : [];
  const hasActive = activeHeaders.length > 0 || activeRows.length > 0;

  let headers = Array.isArray(args.headers)
    ? args.headers.map((h) => String(h ?? '')).slice(0, MAX_COLS)
    : [];
  let rowsRaw = Array.isArray(args.rows) ? args.rows.slice(0, MAX_ROWS) : [];
  let patchedInPlace = false;

  if (cellEdits.length && hasActive && !(wantsFullRewrite && (headers.length || rowsRaw.length))) {
    const baseHeaders = headers.length ? headers : activeHeaders;
    const baseRows = rowsRaw.length ? rowsRaw : activeRows;
    const patched = applySpreadsheetEdits(baseHeaders, baseRows, cellEdits);
    if (!patched.ok) return patched;
    headers = patched.headers;
    rowsRaw = patched.rows;
    patchedInPlace = true;
  }

  if (
    hasActive &&
    !wantsFullRewrite &&
    !patchedInPlace &&
    (headers.length > 0 || rowsRaw.length > 0)
  ) {
    return {
      ok: false,
      error: 'cell_edits_required',
      hint:
        'A spreadsheet is already open. Call again with `cell_edits` ONLY ' +
        '({row, col|column, value}, {row, values}, insert_row, remove_row) — do NOT resubmit ' +
        'the full headers/rows. ONLY if the user asked to rebuild the whole sheet, retry with ' +
        'complete data plus `full_rewrite: true`.',
    };
  }

  if (!headers.length && !rowsRaw.length && hasActive && !patchedInPlace) {
    // Nothing to do — shouldn't happen on a real turn.
    headers = activeHeaders.map((h) => String(h ?? '')).slice(0, MAX_COLS);
    rowsRaw = activeRows.slice(0, MAX_ROWS);
  }

  const rows = normalizeRows(headers, rowsRaw);

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
    let result = {
      ok: true,
      format: 'csv',
      title,
      content,
      row_count: rows.length,
      filename: `${safeName}.csv`,
      headers,
      rows,
      edits_applied: patchedInPlace ? cellEdits.length : undefined,
    };
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
      headers,
      rows,
      edits_applied: patchedInPlace ? cellEdits.length : undefined,
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
    headers,
    rows,
    edits_applied: patchedInPlace ? cellEdits.length : undefined,
  };
  return maybePersistTextArtifact(result, ctx, {
    content: markdown,
    filename: result.filename,
    mimeType: mimeTypeForFilename(result.filename),
    category: 'spreadsheets',
  });
}
