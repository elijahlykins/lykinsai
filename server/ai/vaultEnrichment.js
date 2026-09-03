// Vault note enrichment + on-save index.
import fetch from 'node-fetch';
import { chunkTextForSynthesis } from '../../synthesis-service.js';
import { replaceSynthesisChunks } from './chatRetrieval.js';
import { sha256 } from './promptUtils.js';
import { getUserRowById, updateUserRowById } from '../../lib/security/userOwnedAccess.js';

let supabaseAdmin = null;

export function bindVaultEnrichment(deps) {
  supabaseAdmin = deps.supabaseAdmin;
}

// ---------------------------------------------------------------------------
// REUSABLE: generate ai_summary + ai_signals for a vault note
// ---------------------------------------------------------------------------
// Lifted out of the HTTP endpoint so it can be called from anywhere the
// server has a (userId, noteId) and we want a summary on the row — namely:
//   • POST /api/vault/enrich-note  (frontend-triggered, debounced after save)
//   • fetchVaultNotesByUrls fallback enqueue (catches anything that slipped
//     past both other paths — older rows from before enrichment was wired)
//
// Returns { ok, skipped?, reason?, summary?, signals? }. Never throws —
// connector sync and chat retrieval both treat enrichment as best-effort.
//
// Idempotent: hashes the stripped body and skips the LLM call when the
// hash matches `ai_content_hash` and a summary already exists. So calling
// this on every sync is cheap (one DB read) when the page hasn't changed.
/**
 * Fire-and-forget: enrich + embed a vault note so hybrid search finds it
 * (especially marker-only artifacts whose only searchable signal is the title).
 */
export async function indexVaultNoteForSearch({ userId, noteId, authHeader = null, title = '', content = '' } = {}) {
  if (!userId || !noteId || !supabaseAdmin) return;
  try {
    const enr = await enrichVaultNoteSummary({ userId, noteId, supabaseAdmin });
    const { data: after } = await getUserRowById(
      supabaseAdmin,
      'vault_items',
      userId,
      noteId,
      'title, content, ai_summary',
    );
    const t = String(after?.title || title || '').trim();
    const c = String(after?.content || content || '');
    const summary = (enr && enr.summary) || after?.ai_summary || '';
    const baseText = backfillVaultText(t, c);
    // Title-first embed text so "Top Prosthetic Companies" is always in the vector.
    const embedRaw = [
      t ? `Title: ${t}` : '',
      summary ? `Summary (AI):\n${summary}` : '',
      baseText,
    ]
      .filter(Boolean)
      .join('\n\n');
    const chunks = chunkTextForSynthesis(embedRaw || t);
    if (chunks.length) {
      await replaceSynthesisChunks(userId, authHeader, 'vault_note', noteId, chunks, {
        title: t,
        vaultIndexedOnSave: true,
      }, embedRaw);
    }
  } catch (e) {
    console.warn('[vault:indexOnSave]', noteId, e?.message || e);
  }
}

export async function enrichVaultNoteSummary({ userId, noteId, supabaseAdmin: clientOverride }) {
  if (!userId || !noteId) return { ok: false, reason: 'missing_args' };
  const client = clientOverride || supabaseAdmin;
  if (!client) return { ok: false, reason: 'no_supabase_admin' };

  try {
    const { data: note, error: nErr } = await getUserRowById(
      client,
      'vault_items',
      userId,
      noteId,
      'id, title, content, user_id, ai_summary, ai_content_hash',
    );
    if (nErr) {
      console.error('❌ enrichVaultNoteSummary: note lookup failed:', nErr?.message || nErr);
      return { ok: false, reason: 'note_lookup_failed' };
    }
    if (!note) return { ok: false, reason: 'not_found' };
    if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'openai_key_missing' };

    // backfillStripAttachments is now marker-aware — for connector-synced
    // notes it preserves the body that lives AFTER the attachments marker
    // instead of nuking it. Critical: without this, every Notion / Gmail /
    // Slack page enrich call would summarise just the title.
    const stripped = backfillStripAttachments(note.content);
    // Fold the attachment's AI vision description / OCR into the corpus so
    // image + file notes summarise (and hash) on their actual content, not a
    // bare filename. Without this, an image note's ai_summary is useless for
    // search and the row never reflects what the picture shows.
    const attachmentText = attachmentTextForBackfill(note.content);
    const corpus = [stripped, attachmentText].filter(Boolean).join('\n\n');
    const contentHash = sha256(corpus.slice(0, 12000));

    if (note.ai_content_hash === contentHash && note.ai_summary) {
      return { ok: true, skipped: true, reason: 'content_unchanged', summary: note.ai_summary };
    }

    const llmInput = `Title: ${String(note.title || '').trim()}\n\n${corpus.slice(0, 12000)}`;
    const sys = `You compress vault items for search and UI. Output ONLY valid JSON:
{"summary":"2-5 sentences: what this item is, topics, and type (document, link, media, bookmark, etc.)","signals":{"themes":["short labels"],"entities":["names or products if any"]}}
Use empty arrays if unknown. Be factual; infer only from the text.`;

    const ores = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-nano',
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: llmInput },
        ],
      }),
    });
    if (!ores.ok) {
      console.warn('⚠️ vault enrich LLM HTTP', ores.status);
      return { ok: false, reason: 'llm_failed', status: ores.status };
    }

    const odata = await ores.json();
    // Usage tracking is fire-and-forget; we don't await it inside this
    // critical path because background callers (connector sync) shouldn't
    // pay extra latency for telemetry.
    try {
      const usage = extractOpenAIUsage(odata);
      const session = await getOrCreateSession(userId, null);
      logAiUsage({
        sessionId: session?.id, userId, actionType: 'vault_enrich',
        model: 'gpt-4.1-nano', provider: 'openai',
        inputTokens: usage.input_tokens || estimateTokens(llmInput),
        outputTokens: usage.output_tokens || estimateTokens(odata?.choices?.[0]?.message?.content || ''),
        metadata: { source: 'enrichVaultNoteSummary', noteId },
      });
    } catch { /* telemetry never blocks enrichment */ }

    let parsed;
    try {
      parsed = JSON.parse(odata?.choices?.[0]?.message?.content || '{}');
    } catch {
      return { ok: false, reason: 'parse_failed' };
    }
    const summary = String(parsed.summary || '').trim().slice(0, 2000);
    const signals =
      parsed.signals && typeof parsed.signals === 'object' && !Array.isArray(parsed.signals)
        ? parsed.signals
        : {};

    const { error: upErr } = await updateUserRowById(client, 'vault_items', userId, noteId, {
      ai_summary: summary || null,
      ai_signals: signals,
      ai_content_hash: contentHash,
      updated_at: new Date().toISOString(),
    }, 'id');
    if (upErr) {
      const msg = upErr.message || '';
      if (msg.includes('ai_summary') || msg.includes('ai_signals') || msg.includes('ai_content_hash') || upErr.code === 'PGRST204') {
        return { ok: false, reason: 'columns_missing', hint: 'Apply migration 025_notes_ai_summary_signals.sql' };
      }
      console.error('❌ enrichVaultNoteSummary: ai column update failed:', msg, upErr?.code);
      return { ok: false, reason: 'update_failed' };
    }

    return { ok: true, summary, signals };
  } catch (e) {
    console.error('❌ enrichVaultNoteSummary threw:', e?.message || e);
    return { ok: false, reason: 'threw', detail: e?.message };
  }
}

// Server-side port of src/lib/vault/attachmentsMarker.ts:findAttachmentsMarker.
// Walks the JSON array with string/escape tracking so brackets inside string
// values (filenames like `report[2025].pdf`, code snippets like `arr[0]`,
// even literal `]]` inside a Notion page body that the connector packed
// into `articleText`) don't desync the parser.
//
// Returns null when the marker isn't present or the JSON can't be parsed.
export function findAttachmentsMarkerSpan(content) {
  if (!content) return null;
  const MARKER = '[ATTACHMENTS_JSON:';
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const jsonStart = start + MARKER.length;
  if (content[jsonStart] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd === -1) return null;
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
    if (!Array.isArray(parsed)) return null;
    let markerEnd = jsonEnd;
    if (content[markerEnd] === ']') markerEnd += 1;
    return { start, jsonEnd, markerEnd, attachments: parsed };
  } catch {
    return null;
  }
}

// Strips ONLY the marker substring, preserving everything before AND after.
// Critical for Notion / Gmail / Slack / etc. notes where the connector
// writes `Title\n\n[ATTACHMENTS_JSON:[…]]\n<flattened body>` — the old
// "strip from marker to EOF" approach silently deleted every byte of
// connected-source body content before it ever reached the LLM, so
// `ai_summary` was generated from the title alone (useless).
export function backfillStripAttachments(content) {
  const raw = String(content || '');
  const span = findAttachmentsMarkerSpan(raw);
  if (!span) return raw.trim();
  return `${raw.slice(0, span.start)}${raw.slice(span.markerEnd)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns the flattened body portion appended AFTER the attachments marker.
// For manually-saved notes (marker at end with no trailing body) this is
// empty. For connector-synced notes this is the bulk of the page content.
export function extractBodyAfterAttachmentsMarker(content) {
  const raw = String(content || '');
  const span = findAttachmentsMarkerSpan(raw);
  if (!span) return raw.trim();
  return raw.slice(span.markerEnd).trim();
}

// Server mirror of src/lib/synthesis/sourceText.ts#attachmentTextForSynthesis.
// Surfaces the AI vision description / OCR / filename embedded in the
// ATTACHMENTS_JSON marker so image + file uploads become searchable by their
// visual content (and the enrich LLM summarises the picture, not the filename).
export function attachmentTextForBackfill(content) {
  const span = findAttachmentsMarkerSpan(content);
  if (!span || !Array.isArray(span.attachments) || !span.attachments.length) return '';
  const lines = [];
  for (const att of span.attachments) {
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || att.title || att.fileName || '').trim();
    const desc = String(att.aiDescription || '').trim();
    const extracted = String(att.extractedText || att.text || att.ocr || '').trim();
    const alt = String(att.alt || att.caption || '').trim();
    const kind = String(att.type || att.kind || '').trim();
    const parts = [
      kind && name ? `[${kind}] ${name}` : name || (kind ? `[${kind}]` : ''),
      desc ? `Description: ${desc}` : '',
      alt && alt !== desc ? `Caption: ${alt}` : '',
      extracted ? `Text: ${extracted.slice(0, 4000)}` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join('\n'));
  }
  return lines.join('\n\n').trim();
}

export function backfillVaultText(title, content) {
  const t = String(title || '').trim();
  const body = backfillStripAttachments(content);
  const attachments = attachmentTextForBackfill(content);
  const parts = [t ? `Title: ${t}` : '', body, attachments].filter(Boolean);
  return parts.join('\n\n').slice(0, 120_000);
}
