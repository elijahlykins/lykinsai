// STORAGE / VAULT UTILITY ROUTES — extracted verbatim from server.js (Wave 4).
//
// 4 routes: POST /api/ai/vault-search (concept search over vault cards),
// POST /api/storage/signed-url, POST /api/storage/file-proxy-url, and
// POST /api/vault/backfill-descriptions (batch description backfill).
//
// Dependency notes:
// - requireAuth / requireAppAccess / aiLimiter / describeLimiter /
//   supabaseAdmin / sha256 are bootstrap-owned singletons passed via deps.
// - SIGNED_URL_TTL_SECONDS stays in server.js (shared with the files
//   router) and is passed via deps; SIGNED_URL_ALLOWED_BUCKETS moved here
//   because this module is its only consumer.
// - enrichVaultNoteSummary / backfillVaultText / findAttachmentsMarkerSpan /
//   extractBodyAfterAttachmentsMarker / OUTPUT_CAPS are shared server.js
//   helpers passed via deps.
// - replaceSynthesisChunks / createSynthesisUserClient (passed) and
//   chunkTextForSynthesis (direct import) are LEGACY CANDIDATES — pending
//   Memory Architecture Replacement. Passed/imported unchanged, not
//   modularized further on purpose.
// - Stateless service imports rely on ESM module-cache identity.
import { buildFileProxyUrl } from '../../lib/exterior/fileProxy.js';
import { chunkTextForSynthesis } from '../../synthesis-service.js';
import {
  getOrCreateSession,
  logAiUsage,
  estimateTokens,
  extractOpenAIUsage,
} from '../../usageTracking.js';

export function registerStorageRoutes(app, deps) {
  const {
    requireAuth,
    requireAppAccess,
    aiLimiter,
    describeLimiter,
    supabaseAdmin,
    sha256,
    SIGNED_URL_TTL_SECONDS,
    OUTPUT_CAPS,
    enrichVaultNoteSummary,
    backfillVaultText,
    findAttachmentsMarkerSpan,
    extractBodyAfterAttachmentsMarker,
    replaceSynthesisChunks,
    createSynthesisUserClient,
  } = deps;

  // Hard cap on the request body for /api/ai/vault-search. The client
  // (`VaultNew.jsx::handleConceptSearch`) already truncates to 300 cards
  // (~few hundred KB worst case), but `aiLimiter` only limits requests per
  // minute — not bytes per request. A misbehaving / compromised client
  // could ship megabytes per call and burn OpenAI tokens against our
  // account. 256 KB is comfortably above the legitimate 300-item ceiling
  // and well under any reasonable token budget.
  const VAULT_SEARCH_MAX_PROMPT_BYTES = 256 * 1024;

  app.post('/api/ai/vault-search', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const { prompt } = req.body || {};
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Invalid prompt' });
      }

      // Byte-length, not char-length: emoji + non-ASCII chars cost 2-4 bytes
      // each and the OpenAI token budget tracks bytes more closely than
      // string length. Using `Buffer.byteLength` matches what we actually
      // send over the wire.
      const promptBytes = Buffer.byteLength(prompt, 'utf8');
      if (promptBytes > VAULT_SEARCH_MAX_PROMPT_BYTES) {
        return res.status(413).json({
          error: 'Prompt too large',
          maxBytes: VAULT_SEARCH_MAX_PROMPT_BYTES,
          receivedBytes: promptBytes,
        });
      }

      if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: OUTPUT_CAPS.vault_search,
          temperature: 0.1,
          prompt_cache_key: `lykn-${(req.user?.id || 'anon').slice(0, 32)}`,
        }),
      });

      if (!openaiRes.ok) {
        const err = await openaiRes.json().catch(() => ({}));
        console.error('❌ vault-search OpenAI error:', err?.error?.message || openaiRes.statusText);
        return res.status(502).json({ error: 'Search failed' });
      }

      const data = await openaiRes.json();
      const response = data.choices?.[0]?.message?.content?.trim() || '[]';

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'vault_search',
          model: 'gpt-4.1-nano', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(prompt),
          outputTokens: usage.output_tokens || estimateTokens(response),
        });
      }).catch(() => {});

      return res.json({ response });
    } catch (error) {
      console.error('❌ vault-search error:', error.message);
      return res.status(500).json({ error: 'Search failed' });
    }
  });

  // Buckets that this endpoint is allowed to mint signed URLs for. Service
  // role can technically read anything; restricting here means a caller who
  // guesses an internal bucket name (e.g. backups, audit-logs) can't coerce
  // the API into vending a URL for it.
  const SIGNED_URL_ALLOWED_BUCKETS = new Set(['user-files']);

  app.post('/api/storage/signed-url', requireAuth, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'Storage service unavailable' });

      // Fail closed: every code path below assumes a resolved user id. If
      // `requireAuth` ever falls back (e.g. dev when Supabase env vars are
      // unset, or a future middleware regression), we'd otherwise mint URLs
      // for caller-supplied paths with no ownership check at all.
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const { storagePath, bucket } = req.body || {};
      const path = String(storagePath || '').trim();
      const bkt = String(bucket || 'user-files').trim();
      if (!path) return res.status(400).json({ error: 'Missing storagePath' });

      if (!SIGNED_URL_ALLOWED_BUCKETS.has(bkt)) {
        return res.status(400).json({ error: 'Invalid bucket' });
      }

      // Tenant prefix check — uploads are written under `${userId}/...`
      // (see `uploadFileToStorage`), so any path that doesn't begin with
      // the caller's id is either someone else's file or a probe.
      if (!path.startsWith(`${userId}/`)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { data, error } = await supabaseAdmin.storage
        .from(bkt)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        // Don't leak Supabase's error string — it can disclose whether the
        // object exists vs. RLS blocked vs. bucket misconfigured.
        return res.status(404).json({ error: 'Could not create signed URL' });
      }
      res.json({ signedUrl: data.signedUrl });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Mint a branded /f/<token> URL for storage-backed HTML (and other) artifacts.
  // Vault + chat iframes need this instead of raw Supabase signed URLs: storage
  // often serves generated .html as text/plain (or with framing headers that
  // blank the preview), while the file proxy forces the right Content-Type and
  // relaxes frame-ancestors for lykn.io / Electron.
  app.post('/api/storage/file-proxy-url', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const { storagePath, bucket, filename, ttlSec } = req.body || {};
      const path = String(storagePath || '').trim();
      const bkt = String(bucket || 'user-files').trim();
      if (!path) return res.status(400).json({ error: 'Missing storagePath' });
      if (!SIGNED_URL_ALLOWED_BUCKETS.has(bkt)) {
        return res.status(400).json({ error: 'Invalid bucket' });
      }
      if (!path.startsWith(`${userId}/`)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const ttl = Number(ttlSec);
      const url = buildFileProxyUrl({
        path,
        bucket: bkt,
        filename: typeof filename === 'string' && filename.trim() ? filename.trim() : undefined,
        ttlSec: Number.isFinite(ttl) && ttl > 0 ? Math.min(Math.floor(ttl), 60 * 60 * 24 * 7) : SIGNED_URL_TTL_SECONDS,
      });
      res.json({ url });
    } catch (err) {
      console.error('file-proxy-url mint failed:', err?.message || err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // REUSABLE: generate a 2-3 sentence description for a vault item (image/text)
  // ---------------------------------------------------------------------------
  // Mirrors the /api/ai/describe-image LLM path so the background backfill sweep
  // can reuse the exact same vision/text prompts + the shared description cache.
  // Returns the description string, or null on any failure (never throws — the
  // sweep treats null as "couldn't describe" and moves on / falls back).
  async function generateVaultItemDescription({ userId, imageUrl, textContent, fileType, fileName, chatId } = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    const url = String(imageUrl || '').trim();
    const text = String(textContent || '').trim();
    if (!url && !text) return null;

    const isVisual = url && !url.startsWith('data:') && /image|video/i.test(fileType || '');
    const cacheInput = isVisual ? url : [text.slice(0, 6000), fileType, fileName].join('|');
    const urlHash = sha256(cacheInput);

    if (userId && supabaseAdmin) {
      try {
        const { data: cached } = await supabaseAdmin
          .from('ai_description_cache')
          .select('description')
          .eq('user_id', userId)
          .eq('url_hash', urlHash)
          .maybeSingle();
        if (cached?.description) return cached.description;
      } catch { /* cache miss — proceed to LLM */ }
    }

    let messages;
    if (isVisual) {
      messages = [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this image concisely in 2-3 sentences. Cover: main subject, dominant colors and tones, style or aesthetic, any visible text or logos, mood, and what category this image likely belongs to (e.g. marketing material, personal photo, reference image, screenshot, moodboard, product photo, texture, illustration, etc). Be specific about colors.',
          },
          { type: 'image_url', image_url: { url, detail: 'low' } },
        ],
      }];
    } else {
      const contextParts = [];
      if (fileName) contextParts.push(`File: ${fileName}`);
      if (fileType) contextParts.push(`Type: ${fileType}`);
      if (text) contextParts.push(`Content:\n${text.slice(0, 6000)}`);
      if (!contextParts.length) return null;
      messages = [{
        role: 'user',
        content: `Summarize this vault item in 2-3 concise sentences. Describe what it is, what it's about, its key topics/themes, and what category it belongs to (e.g. article, document, reference, tutorial, bookmark, spreadsheet, audio recording, etc). Be specific.\n\n${contextParts.join('\n')}`,
      }];
    }

    const describeModel = isVisual ? 'gpt-4o-mini' : 'gpt-4.1-nano';
    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: describeModel,
          messages,
          max_tokens: 180,
          prompt_cache_key: `describe-image:${userId || 'anon'}:${isVisual ? 'visual' : 'text'}`,
        }),
      });
      if (!openaiRes.ok) {
        console.warn('⚠️ generateVaultItemDescription OpenAI', openaiRes.status);
        return null;
      }
      const data = await openaiRes.json();
      const description = data.choices?.[0]?.message?.content?.trim() || '';
      if (!description) return null;

      try {
        const usage = extractOpenAIUsage(data);
        const session = await getOrCreateSession(userId, chatId);
        logAiUsage({
          sessionId: session?.id, userId,
          actionType: isVisual ? 'image_analysis' : 'describe_text',
          model: describeModel, provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(cacheInput),
          outputTokens: usage.output_tokens || estimateTokens(description),
          metadata: { source: 'vault_backfill' },
        });
      } catch { /* telemetry never blocks */ }

      if (userId && supabaseAdmin) {
        supabaseAdmin.from('ai_description_cache').upsert({
          user_id: userId,
          url_hash: urlHash,
          url: (isVisual ? url : (fileName || fileType || '')).slice(0, 2000),
          description,
          model: describeModel,
        }, { onConflict: 'user_id,url_hash' }).then(() => {}).catch(() => {});
      }
      return description;
    } catch (e) {
      console.warn('⚠️ generateVaultItemDescription error:', e?.message || e);
      return null;
    }
  }

  // Resolves a fetchable URL for an attachment so vision can read it. Prefers a
  // freshly-signed URL off the stored storagePath (the inline `url` can be a
  // stale/expired signed link); falls back to a plain https url if present.
  async function resolveSignedAttachmentUrl(att, userId) {
    if (!att || typeof att !== 'object') return null;
    const path = String(att.storagePath || '').trim();
    const bucket = String(att.storageBucket || 'user-files').trim();
    if (path && path.startsWith(`${userId}/`) && supabaseAdmin) {
      try {
        const { data } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        if (data?.signedUrl) return data.signedUrl;
      } catch { /* fall through to inline url */ }
    }
    const url = String(att.url || '').trim();
    if (/^https?:/i.test(url)) return url;
    return null;
  }

  function attachmentIsVisual(att) {
    const mime = String(att?.mimeType || '').toLowerCase();
    const type = String(att?.type || '').toLowerCase();
    const name = String(att?.name || '').toLowerCase();
    if (/^(image|video)\//.test(mime)) return true;
    if (/\b(image|video|photo|picture|screenshot)\b/.test(type)) return true;
    return /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg|mp4|mov|webm|m4v)$/.test(name);
  }

  // SQL filter that selects vault notes still missing a description: either no
  // AI summary yet, OR they carry an attachments marker that has no
  // aiDescription on it. Shared by the worker + the remaining-count query so the
  // sweep is guaranteed to terminate (every processed note ends up with a
  // summary AND a description on every attachment, clearing both clauses).
  const VAULT_BACKFILL_OR_FILTER =
    'ai_summary.is.null,and(content.ilike.*ATTACHMENTS_JSON*,content.not.ilike.*aiDescription*)';

  // ---------------------------------------------------------------------------
  // VAULT DESCRIPTION BACKFILL — process one batch of items missing descriptions
  // ---------------------------------------------------------------------------
  // The client calls this in a loop (small batches) until `done`. Each note:
  //   1. gets a vision/text description written onto every attachment that lacks
  //      one (so images become searchable by what they depict),
  //   2. gets an ai_summary via enrichVaultNoteSummary,
  //   3. is re-embedded so semantic + keyword vault search both find it.
  // Idempotent + resumable: already-described items are skipped by the filter.
  app.post('/api/vault/backfill-descriptions', requireAuth, requireAppAccess, describeLimiter, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'LLM not configured' });
      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      const authHeader = req.headers.authorization;
      const batchSize = Math.max(1, Math.min(12, Number(req.body?.batchSize) || 6));

      const { data: notes, error } = await client
        .from('vault_items')
        .select('id, title, content, updated_at, ai_summary')
        .eq('user_id', userId)
        .or(VAULT_BACKFILL_OR_FILTER)
        .order('updated_at', { ascending: true })
        .limit(batchSize);
      if (error) {
        console.warn('[vault:backfill] candidate query:', error.message);
        return res.status(500).json({ error: 'backfill_query_failed' });
      }

      let processed = 0;
      let descriptionsAdded = 0;
      for (const note of notes || []) {
        try {
          let content = String(note.content || '');
          const span = findAttachmentsMarkerSpan(content);
          if (span && Array.isArray(span.attachments) && span.attachments.length) {
            const atts = span.attachments.map((a) => (a && typeof a === 'object' ? { ...a } : a));
            let changed = false;
            for (const att of atts) {
              if (!att || typeof att !== 'object') continue;
              if (String(att.aiDescription || '').trim()) continue;
              let desc = null;
              if (attachmentIsVisual(att)) {
                const url = await resolveSignedAttachmentUrl(att, userId);
                if (url) {
                  desc = await generateVaultItemDescription({
                    userId, imageUrl: url,
                    fileType: String(att.mimeType || att.type || 'image'),
                    fileName: att.name,
                  });
                }
              } else {
                const body = extractBodyAfterAttachmentsMarker(content);
                desc = await generateVaultItemDescription({
                  userId,
                  textContent: body || att.name || note.title,
                  fileType: String(att.mimeType || att.type || ''),
                  fileName: att.name,
                });
              }
              // Fallback guarantees the marker gains an aiDescription so the
              // note clears the filter and the sweep terminates even when the
              // LLM couldn't help (unreachable file, unsupported type, etc).
              if (!desc) desc = String(att.name || note.title || att.type || 'file').slice(0, 500);
              att.aiDescription = desc;
              changed = true;
              descriptionsAdded += 1;
            }
            if (changed) {
              const rebuilt = `${content.slice(0, span.start)}[ATTACHMENTS_JSON:${JSON.stringify(atts)}]${content.slice(span.markerEnd)}`
                .replace(/\n{3,}/g, '\n\n');
              const { error: upErr } = await client
                .from('vault_items')
                .update({ content: rebuilt })
                .eq('id', note.id)
                .eq('user_id', userId)
                .eq('updated_at', note.updated_at);
              if (!upErr) content = rebuilt;
            }
          }

          // Summary (reads the just-patched content, so image notes summarise
          // on their vision description rather than a bare filename).
          const enr = await enrichVaultNoteSummary({ userId, noteId: note.id, supabaseAdmin: client });

          // Re-embed for retrieval with the summary prepended as a dense key.
          const { data: after } = await client
            .from('vault_items')
            .select('title, content')
            .eq('id', note.id)
            .eq('user_id', userId)
            .maybeSingle();
          if (after) {
            const baseText = backfillVaultText(after.title, after.content);
            const summary = (enr && enr.summary) || note.ai_summary || '';
            const embedRaw = summary ? `Summary (AI):\n${summary}\n\n${baseText}` : baseText;
            const chunks = chunkTextForSynthesis(embedRaw);
            if (chunks.length) {
              await replaceSynthesisChunks(userId, authHeader, 'vault_note', note.id, chunks, {
                title: after.title,
                vaultBackfilled: true,
              });
            }
          }
          processed += 1;
        } catch (e) {
          console.warn('[vault:backfill] note failed', note.id, e?.message || e);
        }
      }

      let remaining = 0;
      try {
        const { count } = await client
          .from('vault_items')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .or(VAULT_BACKFILL_OR_FILTER);
        remaining = Math.max(0, count || 0);
      } catch { /* best-effort; client loop also stops when processed === 0 */ }

      return res.json({ ok: true, processed, descriptionsAdded, remaining, done: remaining === 0 });
    } catch (e) {
      console.error('❌ vault backfill-descriptions:', e?.message || e);
      return res.status(500).json({ error: 'backfill_failed' });
    }
  });
}
