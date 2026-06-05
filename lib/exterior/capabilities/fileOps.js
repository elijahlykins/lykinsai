import {
  loadCapabilityArtifact,
  maybePersistTextArtifact,
  mimeTypeForFilename,
} from '../capabilityStorage.js';

const MAX_CONTENT_LEN = 500_000;

const FORMAT_ALIASES = {
  md: 'markdown',
  txt: 'text',
  htm: 'html',
};

function normalizeFormat(fmt) {
  const f = String(fmt || 'text').trim().toLowerCase();
  return FORMAT_ALIASES[f] || f;
}

function markdownToHtml(md, title = 'Document') {
  const escaped = String(md || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const body = escaped
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;line-height:1.6"><p>${body}</p></body></html>`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonToCsv(value) {
  const rows = Array.isArray(value) ? value : value?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, error: 'json_to_csv_requires_rows_array' };
  }
  if (Array.isArray(rows[0])) {
    return { ok: true, content: rows.map((r) => r.map(csvEscape).join(',')).join('\n') };
  }
  if (typeof rows[0] === 'object' && rows[0]) {
    const headers = Object.keys(rows[0]);
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    return { ok: true, content: lines.join('\n') };
  }
  return { ok: false, error: 'unsupported_json_shape' };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvToJson(csv) {
  const lines = String(csv || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!lines.length) return { ok: true, content: JSON.stringify({ rows: [] }, null, 2) };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] ?? '';
    });
    return obj;
  });
  return { ok: true, content: JSON.stringify({ headers, rows }, null, 2) };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function convertContent(content, fromFormat, toFormat, title) {
  const from = normalizeFormat(fromFormat);
  const to = normalizeFormat(toFormat);
  if (from === to) return { ok: true, content: String(content || ''), format: to };

  if (from === 'markdown' && to === 'html') {
    return { ok: true, content: markdownToHtml(content, title), format: 'html' };
  }
  if (from === 'html' && to === 'text') {
    return { ok: true, content: htmlToText(content), format: 'text' };
  }
  if (from === 'markdown' && to === 'text') {
    return {
      ok: true,
      content: String(content || '')
        .replace(/^#+\s+/gm, '')
        .replace(/[*_`]/g, ''),
      format: 'text',
    };
  }
  if (from === 'json' && to === 'csv') {
    let parsed;
    try {
      parsed = JSON.parse(String(content || '{}'));
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
    const csv = jsonToCsv(parsed);
    if (!csv.ok) return csv;
    return { ok: true, content: csv.content, format: 'csv' };
  }
  if (from === 'csv' && to === 'json') {
    const json = csvToJson(content);
    if (!json.ok) return json;
    return { ok: true, content: json.content, format: 'json' };
  }
  return { ok: false, error: 'unsupported_conversion', from, to };
}

function guessFormat(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase();
  if (ext === 'md') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'json') return 'json';
  if (ext === 'csv') return 'csv';
  return 'text';
}

function swapExtension(filename, format) {
  const base = filename.replace(/\.[^.]+$/, '') || 'untitled';
  const extMap = { markdown: 'md', html: 'html', json: 'json', csv: 'csv', text: 'txt' };
  return `${base}.${extMap[format] || 'txt'}`;
}

/**
 * Create, edit, convert, or load user files. Persists to storage when authenticated.
 */
export async function manageFile(args = {}, ctx = {}) {
  const action = String(args.action || 'create').trim().toLowerCase();
  const filename = String(args.filename || 'untitled.txt').trim();
  const sourceFormat = normalizeFormat(args.source_format || guessFormat(filename));
  const targetFormat = normalizeFormat(args.target_format || sourceFormat);

  if (action === 'load') {
    const storagePath = String(args.storage_path || '').trim();
    if (!ctx.supabaseAdmin || !ctx.userId) {
      return { ok: false, error: 'unauthenticated' };
    }
    const loaded = await loadCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, storagePath);
    if (!loaded.ok) return loaded;
    const content = loaded.buffer.toString('utf8');
    return {
      ok: true,
      action,
      storage_path: loaded.storage_path,
      filename: filename || loaded.storage_path.split('/').pop(),
      format: guessFormat(filename || loaded.storage_path),
      content,
      char_count: content.length,
    };
  }

  let content = String(args.content ?? '');
  if (content.length > MAX_CONTENT_LEN) {
    return { ok: false, error: 'content_too_long', max_chars: MAX_CONTENT_LEN };
  }

  if (action === 'convert') {
    const converted = convertContent(content, sourceFormat, targetFormat, filename);
    if (!converted.ok) return converted;
    let result = {
      ok: true,
      action,
      filename: swapExtension(filename, converted.format),
      format: converted.format,
      content: converted.content,
      char_count: converted.content.length,
    };
    result = await maybePersistTextArtifact(result, ctx, {
      content: converted.content,
      filename: result.filename,
      mimeType: mimeTypeForFilename(result.filename),
      category: 'files',
      persist: args.persist !== false,
    });
    return result;
  }

  if (action === 'create' || action === 'edit') {
    let result = {
      ok: true,
      action,
      filename,
      format: sourceFormat,
      content,
      char_count: content.length,
    };
    result = await maybePersistTextArtifact(result, ctx, {
      content,
      filename,
      mimeType: mimeTypeForFilename(filename),
      category: 'files',
      persist: args.persist !== false,
    });
    return result;
  }

  return { ok: false, error: 'invalid_action', allowed: ['create', 'edit', 'convert', 'load'] };
}
