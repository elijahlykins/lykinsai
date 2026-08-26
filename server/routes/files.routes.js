// ============================================================================
// server/routes/files.routes.js — file text extraction + vault save/process/search
// ============================================================================
// Extracted verbatim from server.js (Wave 3 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.

import * as mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { buildAttachmentColumns } from '../../lib/vault/attachmentType.js';
import { insertWithSchemaFallback } from '../../lib/vault/insertWithSchemaFallback.js';
import { inferAttachmentKind } from '../../lib/vaultAttachment.js';
import { mimeTypeForFilename } from '../../lib/exterior/capabilityStorage.js';
import { Readable } from 'node:stream';

const _mammoth = mammoth.default || mammoth;

function extractTextFromDocx(buffer) {
  return _mammoth.extractRawText({ buffer }).then((r) => ({
    text: (r.value || "").trim(),
    format: "docx",
  }));
}

// ExcelJS cells can hold rich-text objects, formula+result pairs,
// hyperlink wrappers, or Date instances. Normalise everything to a
// flat string so the downstream CSV/text consumers don't have to.
function xlsxCellToString(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v.richText)) return v.richText.map((p) => p?.text ?? '').join('');
  if (v.text != null) return String(v.text);          // hyperlink-cell
  if (v.result != null) return String(v.result);       // formula-cell
  return String(v);
}

function xlsxCsvEscape(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function extractTextFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      // row.values is 1-indexed; index 0 is always a placeholder.
      const cells = row.values.slice(1).map((v) => xlsxCsvEscape(xlsxCellToString(v)));
      rows.push(cells.join(','));
    });
    return `--- Sheet: ${ws.name} ---\n${rows.join('\n')}`;
  });
  return { text: sheets.join("\n\n").trim(), format: "xlsx", pageCount: wb.worksheets.length };
}

function extractTextFromPptx(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || "0");
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
  return { text: slides.join("\n\n").trim(), format: "pptx", pageCount: entries.length };
}

function extractTextFromOdt(buffer) {
  const zip = new AdmZip(buffer);
  const contentEntry = zip.getEntry("content.xml");
  if (!contentEntry) return { text: "", format: "odt" };
  const xml = contentEntry.getData().toString("utf8");
  const $ = cheerio.load(xml, { xmlMode: true });
  const paragraphs = [];
  $("text\\:p, text\\:h").each((_, el) => {
    const t = $(el).text().trim();
    if (t) paragraphs.push(t);
  });
  return { text: paragraphs.join("\n").trim(), format: "odt" };
}

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons from server.js: auth +
 *   multer upload middleware, supabaseAdmin client, safeErr() error shaping,
 *   the shared indexVaultNoteForSearch pipeline (also used by the discover
 *   ingest path), and the storage-domain SIGNED_URL_TTL_SECONDS constant.
 */
export function registerFilesRoutes(app, {
  requireAuth,
  upload,
  supabaseAdmin,
  safeErr,
  indexVaultNoteForSearch,
  SIGNED_URL_TTL_SECONDS,
}) {
  app.post('/api/files/extract-text', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ error: 'No file uploaded. Send multipart with field "file".' });
      }
      const name = String(file.originalname || "").toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      console.log(`📄 Extracting text: ${file.originalname} (${mime}, ${(file.size / 1024).toFixed(0)}KB)`);

      let result;
      if (mime.includes("wordprocessingml") || mime === "application/msword" || name.endsWith(".docx") || name.endsWith(".doc")) {
        result = await extractTextFromDocx(file.buffer);
      } else if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || name.endsWith(".xlsx") || name.endsWith(".xls")) {
        result = await extractTextFromXlsx(file.buffer);
      } else if (mime.includes("presentationml") || mime.includes("ms-powerpoint") || name.endsWith(".pptx") || name.endsWith(".ppt")) {
        result = extractTextFromPptx(file.buffer);
      } else if (mime.includes("opendocument") || name.endsWith(".odt")) {
        result = extractTextFromOdt(file.buffer);
      } else {
        return res.status(400).json({ error: `Unsupported file type: ${mime} (${name})` });
      }

      console.log(`✅ Extracted ${result.text.length} chars from ${result.format}`);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('❌ File extraction error:', error);
      res.status(500).json({ error: `Failed to extract text: ${error.message}` });
    }
  });

  app.post('/api/files/parse-spreadsheet', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }
      const name = String(file.originalname || "").toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      const isSpreadsheet =
        mime.includes("spreadsheetml") || mime.includes("ms-excel") ||
        name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");
      if (!isSpreadsheet) {
        return res.status(400).json({ error: 'Not a spreadsheet file.' });
      }

      console.log(`📊 Parsing spreadsheet: ${file.originalname} (${(file.size / 1024).toFixed(0)}KB)`);

      const wb = new ExcelJS.Workbook();
      if (name.endsWith(".csv")) {
        // ExcelJS's csv reader takes a stream; wrap the in-memory buffer
        // with node:stream Readable so we avoid spilling to /tmp.
        await wb.csv.read(Readable.from(file.buffer));
      } else {
        await wb.xlsx.load(file.buffer);
      }

      const ws = wb.worksheets[0];
      if (!ws) return res.status(422).json({ error: 'No sheets found.' });

      // ExcelJS rows/cols are 1-indexed. We expose 0-indexed coordinates
      // to the frontend grid renderer (same contract as the prior xlsx
      // implementation).
      const rows = Math.min(ws.rowCount, 200);
      const cols = Math.min(ws.columnCount, 30);
      const cells = {};
      for (let r = 1; r <= rows; r++) {
        const row = ws.getRow(r);
        for (let c = 1; c <= cols; c++) {
          const s = xlsxCellToString(row.getCell(c).value);
          if (s !== '') cells[`${r - 1},${c - 1}`] = s;
        }
      }

      const colWidths = [];
      for (let c = 0; c < cols; c++) {
        let maxLen = 8;
        for (let r = 0; r < Math.min(rows, 50); r++) {
          const v = cells[`${r},${c}`];
          if (v) maxLen = Math.max(maxLen, v.length);
        }
        colWidths.push(Math.min(Math.max(maxLen * 8, 64), 240));
      }

      console.log(`✅ Parsed spreadsheet: ${rows} rows × ${cols} cols, ${Object.keys(cells).length} filled cells`);
      res.json({ rows, cols, cells, colWidths, sheetName: ws.name, sheetCount: wb.worksheets.length });
    } catch (error) {
      console.error('❌ Spreadsheet parse error:', error);
      res.status(500).json({ error: `Failed to parse spreadsheet: ${error.message}` });
    }
  });

  // Save an image (e.g. an AI-snipped screen region from the desktop overlay)
  // straight into the user's Vault. The overlay's Electron main process can't run
  // the browser upload pipeline (supabase-js + File + canvas), so it POSTs the raw
  // PNG bytes here and we do the storage upload + vault_items insert server-side,
  // mirroring what createVaultNote() does on the web client. Accepts either a
  // multipart "image" field or a base64 `dataUrl` in the JSON body.
  app.post('/api/vault/save-image', requireAuth, upload.single('image'), async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'storage_unavailable' });
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      // Bytes can arrive as multipart (preferred) or a base64 data URL in the body.
      let buffer = req.file?.buffer || null;
      let mimeType = String(req.file?.mimetype || '').toLowerCase();
      let originalName = String(req.file?.originalname || '');
      if ((!buffer || !buffer.length) && req.body?.dataUrl) {
        const m = String(req.body.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          mimeType = m[1].toLowerCase();
          buffer = Buffer.from(m[2], 'base64');
        }
      }
      if (!buffer || !buffer.length) {
        return res.status(400).json({ error: 'no_image' });
      }
      if (!mimeType.startsWith('image/')) mimeType = 'image/png';
      // Guard against absurd payloads (multer already caps at 50MB).
      if (buffer.length > 25 * 1024 * 1024) {
        return res.status(413).json({ error: 'image_too_large' });
      }

      const title = (String(req.body?.title || '').trim() || 'Screenshot').slice(0, 200);
      const width = Number(req.body?.width) || null;
      const height = Number(req.body?.height) || null;
      const folder = (String(req.body?.folder || '').trim() || 'Screenshots').slice(0, 80);

      const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
      const bucket = 'user-files';
      const fileId = crypto.randomUUID();
      const storagePath = `${userId}/${fileId}/original.${ext}`;

      const { error: upErr } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, buffer, { contentType: mimeType, cacheControl: '31536000', upsert: false });
      if (upErr) {
        console.error('❌ Vault image upload failed:', upErr.message || upErr);
        return res.status(500).json({ error: upErr.message || 'upload_failed' });
      }

      // Sign a URL so the attachment renders immediately; the Vault renderer
      // re-signs from storagePath/storageBucket once this one expires.
      let fileUrl = null;
      try {
        const { data: signed } = await supabaseAdmin.storage
          .from(bucket)
          .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
        fileUrl = signed?.signedUrl || null;
      } catch { /* re-signing on the client still works via storagePath */ }

      const filename = originalName || `${title}.${ext}`;
      const attachment = {
        type: 'image',
        url: fileUrl,
        name: filename,
        storagePath,
        storageBucket: bucket,
        size: buffer.length,
        mimeType,
        ...(width && height && width > 0 && height > 0 ? { width, height } : {}),
      };
      const content = `[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

      const richInsert = {
        user_id: userId,
        title,
        content,
        folder,
        source: 'overlay_snip',
        tags: ['image', 'screenshot'],
        ...buildAttachmentColumns(attachment),
      };

      // Pre-migration DBs may lack the normalized attachment columns — drop only
      // what they name (same fallback the web upload pipeline uses).
      const { data: note, error: insErr } = await insertWithSchemaFallback(
        (row) => supabaseAdmin.from('vault_items').insert(row).select('id, title').single(),
        richInsert,
        ['user_id', 'title', 'content'],
      );

      if (insErr) {
        // Clean up the orphaned object so we don't leak storage on a failed row.
        await supabaseAdmin.storage.from(bucket).remove([storagePath]).catch(() => {});
        const msg = String(insErr.message || '');
        if (msg.includes('vault_cap_reached')) {
          return res.status(403).json({ error: 'vault_cap_reached' });
        }
        console.error('❌ Vault image insert failed:', msg);
        return res.status(500).json({ error: msg || 'insert_failed' });
      }

      console.log(`✅ Saved overlay image to vault: ${note?.id} (${(buffer.length / 1024).toFixed(0)}KB)`);
      if (note?.id) {
        void indexVaultNoteForSearch({
          userId,
          noteId: note.id,
          authHeader: req.headers.authorization,
          title,
          content,
        });
      }
      return res.json({ ok: true, id: note?.id || null, title, node_id: note?.id ? `vault_${note.id}` : null });
    } catch (error) {
      console.error('❌ Vault save-image error:', error);
      return res.status(500).json({ error: safeErr(error, 'save_failed') });
    }
  });

  // Generic file variant of save-image: persist ANY generated file (a Build-mode
  // React artifact HTML, a generated image, a downloaded doc) from the desktop
  // overlay straight into the Vault as a rich attachment card. The overlay's
  // Download button posts the bytes it already fetched, so the vault copy is
  // durable even after the original signed URL expires.
  app.post('/api/vault/save-file', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'storage_unavailable' });
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const buffer = req.file?.buffer || null;
      if (!buffer || !buffer.length) return res.status(400).json({ error: 'no_file' });
      if (buffer.length > 25 * 1024 * 1024) {
        return res.status(413).json({ error: 'file_too_large' });
      }
      const originalName = String(req.file?.originalname || '').trim();
      let mimeType = String(req.file?.mimetype || '').toLowerCase().split(';')[0].trim();
      if (!mimeType || mimeType === 'application/octet-stream') {
        mimeType = mimeTypeForFilename(originalName || 'file.bin');
      }

      const title = (String(req.body?.title || '').trim() || originalName || 'Generated file').slice(0, 200);
      const folder = (String(req.body?.folder || '').trim() || 'Generated').slice(0, 80);
      const rawSource = String(req.body?.source || '').trim().slice(0, 40);
      const source = ['overlay_download', 'ai_artifact'].includes(rawSource)
        ? rawSource
        : 'overlay_download';

      const bucket = 'user-files';
      const fileId = crypto.randomUUID();
      const safeName = (originalName || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'file';
      const storagePath = `${userId}/${fileId}/${safeName}`;

      const { error: upErr } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, buffer, { contentType: mimeType, cacheControl: '31536000', upsert: false });
      if (upErr) {
        console.error('❌ Vault file upload failed:', upErr.message || upErr);
        return res.status(500).json({ error: upErr.message || 'upload_failed' });
      }

      let fileUrl = null;
      try {
        const { data: signed } = await supabaseAdmin.storage
          .from(bucket)
          .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
        fileUrl = signed?.signedUrl || null;
      } catch { /* re-signing on the client still works via storagePath */ }

      const attachment = {
        type: inferAttachmentKind(mimeType, originalName, ''),
        url: fileUrl,
        name: originalName || safeName,
        storagePath,
        storageBucket: bucket,
        size: buffer.length,
        mimeType,
      };
      const content = `[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

      const richInsert = {
        user_id: userId,
        title,
        content,
        folder,
        source,
        tags: ['generated'],
        ...buildAttachmentColumns(attachment),
      };

      const { data: note, error: insErr } = await insertWithSchemaFallback(
        (row) => supabaseAdmin.from('vault_items').insert(row).select('id, title').single(),
        richInsert,
        ['user_id', 'title', 'content'],
      );

      if (insErr) {
        await supabaseAdmin.storage.from(bucket).remove([storagePath]).catch(() => {});
        const msg = String(insErr.message || '');
        if (msg.includes('vault_cap_reached')) {
          return res.status(403).json({ error: 'vault_cap_reached' });
        }
        console.error('❌ Vault file insert failed:', msg);
        return res.status(500).json({ error: msg || 'insert_failed' });
      }

      console.log(`✅ Saved overlay file to vault: ${note?.id} (${(buffer.length / 1024).toFixed(0)}KB, ${mimeType})`);
      // Index immediately so artifacts are searchable by title (don't wait for client backfill).
      if (note?.id) {
        void indexVaultNoteForSearch({
          userId,
          noteId: note.id,
          authHeader: req.headers.authorization,
          title,
          content,
        });
      }
      return res.json({ ok: true, id: note?.id || null, title, node_id: note?.id ? `vault_${note.id}` : null });
    } catch (error) {
      console.error('❌ Vault save-file error:', error);
      return res.status(500).json({ error: safeErr(error, 'save_failed') });
    }
  });

  // ============================================
  // FILE PROCESSING ENDPOINTS
  // ============================================

  // Process uploaded file (extract text, generate embeddings, auto-tag)
  app.post('/api/files/process', requireAuth, async (req, res) => {
    try {
      const { fileId, fileType, mimeType, filename } = req.body;

      if (!fileId) {
        return res.status(400).json({ error: 'Missing fileId parameter' });
      }

      console.log(`📄 Processing file: ${filename} (${fileType})`);

      // Update status to processing
      // Note: This would typically use Supabase client, but for now we'll return success
      // The actual processing would happen in a background worker

      // For now, return success and log that processing should be done async
      // In production, this would:
      // 1. Download file from Supabase Storage
      // 2. Extract text based on file type
      // 3. Generate embeddings using OpenAI
      // 4. Store embeddings in vector DB
      // 5. Run AI classifier for folder/tag suggestions
      // 6. Update file record with results

      res.json({
        success: true,
        message: 'File processing queued',
        fileId
      });

      // TODO: Implement actual processing pipeline
      // This should be done in a background worker/job queue

    } catch (error) {
      console.error('❌ Error processing file:', error);
      res.status(500).json({ error: `Failed to process file: ${error.message}` });
    }
  });

  // Search files by semantic query (vector search)
  app.post('/api/files/search', requireAuth, async (req, res) => {
    try {
      const { query, workspaceId, limit = 10 } = req.body;

      if (!query) {
        return res.status(400).json({ error: 'Missing query parameter' });
      }

      console.log(`🔍 Semantic file search: "${query}"`);

      // TODO: Implement vector search
      // 1. Generate embedding for query using OpenAI
      // 2. Search Supabase vector DB for similar embeddings
      // 3. Return matching files with similarity scores

      res.json({
        query,
        results: [],
        message: 'Vector search not yet implemented'
      });

    } catch (error) {
      console.error('❌ Error searching files:', error);
      res.status(500).json({ error: `Failed to search files: ${error.message}` });
    }
  });
}
