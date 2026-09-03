// AI ASSIST / MEDIA UTILITY ROUTES — extracted verbatim from server.js (Wave 4).
//
// 10 routes: imagine-image, describe-image, transcribe, meeting-chunk,
// summarize-conversation, clean-transcript, live-assist, meeting-notes,
// suggest, name-grid.
//
// Dependency notes:
// - requireAuth / requireAppAccess / the limiters / checkAiUsageLimit /
//   upload (multer) / supabaseAdmin / memCache / sha256 are bootstrap-owned
//   singletons passed via deps.
// - Stateless service imports (usageTracking, webSearch, generateImage)
//   rely on ESM module-cache identity.
import { searchWeb } from '../../lib/exterior/webSearch.js';
import { generateChatImage } from '../../lib/exterior/generateImage.js';
import { authorizeImageUsage } from '../../lib/billing/usageBalance.js';
import {
  getOrCreateSession,
  logAiUsage,
  estimateTokens,
  extractOpenAIUsage,
} from '../../usageTracking.js';

export function registerAssistRoutes(app, deps) {
  const {
    requireAuth,
    requireAppAccess,
    aiLimiter,
    generationLimiter,
    imagineLimiter,
    describeLimiter,
    checkAiUsageLimit,
    upload,
    supabaseAdmin,
    memCache,
    sha256,
  } = deps;

  // LYKN Studio "Imagine" (Midjourney-style batches) — one image per call; the
  // client fires the batch as parallel requests so each variation pops in as it
  // finishes. Reference images (a picked generation being refined) ride along so
  // the provider's pixel-grounded path (images/edits) keeps the subject intact.
  // Quota is enforced per image inside generateChatImage.
  app.post('/api/ai/imagine-image', requireAuth, requireAppAccess, imagineLimiter, async (req, res) => {
    try {
      const { prompt, aspectRatio, imageSize, referenceImages, maskImage, deliverBytes } = req.body || {};
      const refs = Array.isArray(referenceImages)
        ? referenceImages
            .filter((u) => typeof u === 'string' && /^(https?:|data:image\/)/i.test(u.trim()))
            .slice(0, 4)
        : [];
      const mask =
        typeof maskImage === 'string' && /^data:image\//i.test(maskImage.trim())
          ? maskImage.trim()
          : undefined;
      // A desktop client keeping its vault on disk asks for the bytes directly
      // so the image never becomes a bucket object it would only duplicate
      // locally and leave behind.
      const wantsBytes = deliverBytes === true;
      const result = await generateChatImage({
        prompt,
        aspectRatio,
        imageSize,
        referenceImages: refs,
        maskImage: mask,
        userId: req.user?.id,
        supabaseAdmin,
        deliverBytes: wantsBytes,
        logUsage: (info) => logAiUsage({ ...info, metadata: { ...info?.metadata, surface: 'studio_imagine' } }),
        authorizeUsage: ({ actionType }) => authorizeImageUsage(req.user?.id, req.userPlanId, actionType),
      });
      if (!result.ok) {
        const err = String(result.error || 'image_generation_failed');
        if (err === 'insufficient_usage_balance') {
          return res.status(402).json({
            ok: false,
            error: err,
            code: 'insufficient_usage_balance',
            message: result.message || 'Add funds to continue with this action.',
            usage_balance_usd: result.usage_balance_usd,
            required_usd: result.required_usd,
            add_funds: true,
          });
        }
        const status = err === 'unauthenticated' ? 401 : /quota|limit/i.test(err) ? 429 : 502;
        return res.status(status).json({ ok: false, error: err });
      }
      return res.json({
        ok: true,
        imageUrl: result.image_url,
        storagePath: result.storage_path,
        imageBase64: result.image_base64 || null,
        mimeType: result.mime_type || null,
        prompt: result.prompt,
        caption: result.caption || null,
        provider: result.provider,
      });
    } catch (e) {
      console.error('❌ imagine-image:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'image_generation_failed' });
    }
  });

  app.post('/api/ai/describe-image', requireAuth, requireAppAccess, describeLimiter, async (req, res) => {
    try {
      const { imageUrl, textContent, fileType, fileName } = req.body || {};
      const url = String(imageUrl || '').trim();
      const text = String(textContent || '').trim();

      if (!url && !text) return res.status(400).json({ error: 'Missing imageUrl or textContent' });

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

      const userId = req.user?.id;
      // Visual = an image/video we can hand to the vision model. We accept both
      // hosted URLs and inline `data:image/...` URLs (voice paste hands us the
      // data URL before the background upload lands, so excluding it would make
      // pasted images undescribable in a live voice turn). Non-image data URLs
      // (e.g. a base64 PDF) still fall through to the text branch.
      const isVisual = !!url && /image|video/i.test(fileType || '')
        && (!url.startsWith('data:') || url.startsWith('data:image'));
      const cacheInput = isVisual ? url : [text.slice(0, 6000), fileType, fileName].join('|');
      const urlHash = sha256(cacheInput);

      // ── Cache lookup ──
      if (userId && supabaseAdmin) {
        try {
          const { data: cached } = await supabaseAdmin
            .from('ai_description_cache')
            .select('description')
            .eq('user_id', userId)
            .eq('url_hash', urlHash)
            .maybeSingle();
          if (cached?.description) {
            return res.json({ description: cached.description, cached: true });
          }
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
        if (url) contextParts.push(`URL: ${url}`);
        if (text) contextParts.push(`Content:\n${text.slice(0, 6000)}`);
        messages = [{
          role: 'user',
          content: `Summarize this vault item in 2-3 concise sentences. Describe what it is, what it's about, its key topics/themes, and what category it belongs to (e.g. article, document, reference, tutorial, bookmark, spreadsheet, audio recording, etc). Be specific.\n\n${contextParts.join('\n')}`,
        }];
      }

      const describeModel = isVisual ? 'gpt-4o-mini' : 'gpt-4.1-nano';

      // The system prompt asks for a 2-3 sentence description (~80 output
      // tokens). 300 left huge headroom we never used — cut to 180 so the
      // long-tail of overflowing responses still fits but the typical run
      // is unaffected. `prompt_cache_key` is per-user since the prompt
      // template itself never changes, so the discount kicks in after the
      // first description in a session.
      const _describeCacheKey = `describe-image:${userId || 'anon'}:${isVisual ? 'visual' : 'text'}`;
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: describeModel,
          messages,
          max_tokens: 180,
          prompt_cache_key: _describeCacheKey,
        }),
      });

      if (!openaiRes.ok) {
        const err = await openaiRes.json().catch(() => ({}));
        console.error('❌ describe-image OpenAI error:', err?.error?.message || openaiRes.statusText);
        return res.status(502).json({ error: 'AI describe failed' });
      }

      const data = await openaiRes.json();
      const description = data.choices?.[0]?.message?.content?.trim() || '';

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id,
          actionType: isVisual ? 'image_analysis' : 'describe_text',
          model: describeModel, provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(cacheInput),
          outputTokens: usage.output_tokens || estimateTokens(description),
        });
      }).catch(() => {});

      // ── Cache write (fire-and-forget) ──
      if (description && userId && supabaseAdmin) {
        supabaseAdmin.from('ai_description_cache').upsert({
          user_id: userId,
          url_hash: urlHash,
          url: (isVisual ? url : (fileName || fileType || '')).slice(0, 2000),
          description,
          model: describeModel,
        }, { onConflict: 'user_id,url_hash' }).then(() => {}).catch(() => {});
      }

      return res.json({ description });
    } catch (error) {
      console.error('❌ describe-image error:', error.message);
      return res.status(500).json({ error: 'Description failed' });
    }
  });

  app.post('/api/ai/transcribe', requireAuth, requireAppAccess, aiLimiter, generationLimiter, checkAiUsageLimit, upload.single('audio'), async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in your .env file.',
        });
      }

      const audioFile = req.file;
      if (!audioFile?.buffer?.length) {
        return res.status(400).json({ error: 'Missing audio file. Provide multipart/form-data with field "audio".' });
      }

      const model = String(req.body?.model || 'whisper-1').trim() || 'whisper-1';
      const mimeType = String(audioFile.mimetype || 'audio/webm');
      const fileName = String(audioFile.originalname || 'dictation.webm');
      const language = String(req.body?.language || 'en').trim();
      const promptHint = String(req.body?.prompt || '').trim();

      const formData = new FormData();
      formData.append('model', model);
      formData.append('language', language);
      formData.append('response_format', 'verbose_json');
      formData.append('temperature', '0');
      if (promptHint) formData.append('prompt', promptHint);
      formData.append(
        'file',
        new Blob([audioFile.buffer], { type: mimeType }),
        fileName
      );

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      const data = await whisperRes.json().catch(() => ({}));
      if (!whisperRes.ok) {
        const err = String(data?.error?.message || whisperRes.statusText || 'Whisper request failed');
        return res.status(500).json({ error: `Whisper: ${err}` });
      }

      const text = String(data?.text || '').trim();
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const avgNoSpeech = segments.length > 0
        ? segments.reduce((sum, s) => sum + (s?.no_speech_prob || 0), 0) / segments.length
        : 0;

      const audioDurationSec = data?.duration || (segments.length > 0 ? segments[segments.length - 1]?.end || 0 : 0);
      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'transcription',
          model: 'whisper-1', provider: 'openai',
          inputTokens: Math.ceil(audioDurationSec),
          metadata: { duration_sec: audioDurationSec },
        });
      }).catch(() => {});

      return res.json({ text, no_speech_prob: avgNoSpeech });
    } catch (error) {
      return res.status(500).json({
        error: `Transcription failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  // Fast path for live meeting notes — ASR (+ optional cleanup) in one round trip.
  // The desktop overlay does VAD endpointing client-side and passes fast=1, in
  // which case we return the raw ASR text immediately (the overlay polishes it
  // asynchronously via /api/ai/clean-transcript and swaps it in place).
  app.post('/api/ai/meeting-chunk', requireAuth, requireAppAccess, aiLimiter, generationLimiter, checkAiUsageLimit, upload.single('audio'), async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured.' });
      }

      const audioFile = req.file;
      if (!audioFile?.buffer?.length) {
        return res.status(400).json({ error: 'Missing audio file.' });
      }

      const mimeType = String(audioFile.mimetype || 'audio/webm');
      const fileName = String(audioFile.originalname || 'meeting.webm');
      const language = String(req.body?.language || 'en').trim();
      const promptHint = String(req.body?.prompt || '').trim();
      const fast = req.body?.fast === '1' || req.body?.fast === 'true';
      // gpt-4o-mini-transcribe is both faster and markedly more accurate than
      // whisper-1 on short conversational clips; whisper-1 stays the fallback.
      const requested = String(req.body?.model || '').trim();
      const model = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'].includes(requested)
        ? requested
        : 'whisper-1';
      // The 4o transcribe models don't support verbose_json (no segment stats).
      const verbose = model === 'whisper-1';

      const formData = new FormData();
      formData.append('model', model);
      formData.append('language', language);
      formData.append('response_format', verbose ? 'verbose_json' : 'json');
      formData.append('temperature', '0');
      if (promptHint) formData.append('prompt', promptHint);
      formData.append('file', new Blob([audioFile.buffer], { type: mimeType }), fileName);

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      const data = await whisperRes.json().catch(() => ({}));
      if (!whisperRes.ok) {
        const err = String(data?.error?.message || whisperRes.statusText || 'Whisper request failed');
        return res.status(500).json({ error: `Whisper: ${err}` });
      }

      const raw = String(data?.text || '').trim();
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const avgNoSpeech = segments.length > 0
        ? segments.reduce((sum, s) => sum + (s?.no_speech_prob || 0), 0) / segments.length
        : 0;

      const audioDurationSec = data?.duration || (segments.length > 0 ? segments[segments.length - 1]?.end || 0 : 0);
      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'meeting_chunk',
          model, provider: 'openai',
          inputTokens: Math.ceil(audioDurationSec),
          metadata: { duration_sec: audioDurationSec },
        });
      }).catch(() => {});

      if (!raw || avgNoSpeech > 0.72) {
        return res.json({ text: '', raw: '', no_speech_prob: avgNoSpeech });
      }

      // fast=1: the client shows raw text immediately and cleans it up
      // asynchronously — skipping the serial LLM pass here cuts ~200–400ms
      // off every utterance's time-to-screen.
      if (fast || raw.length < 14) {
        return res.json({ text: raw, raw, no_speech_prob: avgNoSpeech });
      }

      const context = String(req.body?.context || '').slice(-600).trim();
      const cleanRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          temperature: 0,
          max_tokens: 280,
          messages: [
            {
              role: 'system',
              content:
                'You clean up live speech-to-text for a meeting transcript. Strip filler words, ' +
                'false starts, and stutters. Fix punctuation. Do NOT summarize or invent. ' +
                'Return ONLY the cleaned fragment.',
            },
            {
              role: 'user',
              content: context
                ? `PREVIOUS TAIL:\n${context}\n\nRAW FRAGMENT:\n${raw}`
                : `RAW FRAGMENT:\n${raw}`,
            },
          ],
        }),
      });

      let text = raw;
      if (cleanRes.ok) {
        const cleanData = await cleanRes.json();
        const cleaned = String(cleanData.choices?.[0]?.message?.content || '').trim();
        if (cleaned) text = cleaned;
      }

      return res.json({ text, raw, no_speech_prob: avgNoSpeech });
    } catch (error) {
      return res.status(500).json({
        error: `Meeting chunk failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  // ──────────────────────────────────────────────────
  // Conversation summarization — compress older turns to save tokens
  // ──────────────────────────────────────────────────
  app.post('/api/ai/summarize-conversation', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length < 4) {
        return res.status(400).json({ error: 'Need at least 4 messages to summarize' });
      }

      const formatted = messages
        .slice(0, 40)
        .map(m => `${String(m.role || 'user').toUpperCase()}: ${String(m.content || '').slice(0, 800)}`)
        .join('\n');

      const summaryCache = memCache('convo-summary');
      const cacheKey = sha256(formatted);
      const cached = summaryCache.get(cacheKey);
      if (cached) return res.json({ summary: cached, cached: true });

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          temperature: 0.3,
          // Structured working memory (~180–220 tokens). Slightly above the
          // old 2–4 sentence summary so we can keep goal / open / next lines.
          max_tokens: 280,
          // Static system prompt — per-user cache key gives a small input
          // discount on subsequent summaries. Cheap to add, never hurts.
          prompt_cache_key: `summarize-convo:${req.user?.id || 'anon'}`,
          messages: [
            {
              role: 'system',
              content: [
                'Build THREAD WORKING MEMORY for an ongoing chat. This is short-lived context for the next replies — not durable User Facts.',
                'Output EXACTLY these labeled lines (omit a line only if truly empty; keep each value ≤18 words):',
                'Goal: <what they are trying to accomplish in this thread>',
                'Open: <open questions or unresolved asks>',
                'Decisions: <choices already made>',
                'Next: <likely next step or what they want from you>',
                'Notes: <1 short factual sentence of other useful thread context>',
                'Be factual. Do not invent. No preamble, no markdown fences.',
              ].join('\n'),
            },
            { role: 'user', content: formatted },
          ],
        }),
      });

      if (!openaiRes.ok) {
        return res.status(502).json({ error: 'summarize_failed' });
      }
      const data = await openaiRes.json();
      const summary = data.choices?.[0]?.message?.content?.trim() || '';

      if (summary) summaryCache.set(cacheKey, summary);

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'summarize_conversation',
          model: 'gpt-4.1-nano', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(formatted),
          outputTokens: usage.output_tokens || estimateTokens(summary),
        });
      }).catch(() => {});

      return res.json({ summary });
    } catch (error) {
      console.error('❌ summarize-conversation error:', error?.message);
      return res.status(500).json({ error: 'Summarization failed' });
    }
  });

  // ──────────────────────────────────────────────────
  // Clean transcript — Wispr-Flow-style cleanup of live speech-to-text.
  // The desktop overlay's "Listen" mode transcribes meeting audio in ~6s chunks
  // with Whisper, which keeps every "um", false start, stutter and repeat. This
  // runs each raw fragment through a fast model that strips the noise and fixes
  // punctuation WITHOUT summarizing or inventing — so the live transcript reads
  // clean. Given the previous cleaned tail as context so it can merge a sentence
  // split across chunks and never repeat text.
  // ──────────────────────────────────────────────────
  app.post('/api/ai/clean-transcript', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const raw = String(req.body?.text || '').slice(0, 4000).trim();
      if (!raw) return res.json({ text: '' });
      const context = String(req.body?.context || '').slice(-600).trim();

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          temperature: 0,
          max_tokens: 500,
          prompt_cache_key: `clean-transcript:${req.user?.id || 'anon'}`,
          messages: [
            {
              role: 'system',
              content:
                'You clean up live speech-to-text for a meeting transcript. You receive a RAW ' +
                'fragment from automatic speech recognition, and optionally the END of the already-' +
                'cleaned transcript for context.\n\n' +
                'Rewrite ONLY the new RAW fragment into clean, readable text:\n' +
                '- Remove filler words (um, uh, er, hmm, like, you know, I mean, sort of/kind of when ' +
                'meaningless), false starts, stutters, and immediately repeated words.\n' +
                '- Fix capitalization, punctuation, and obvious ASR mis-hearings.\n' +
                '- PRESERVE the speaker\'s actual words and meaning. Do NOT summarize, paraphrase ' +
                'heavily, add, translate, or invent anything.\n' +
                '- Use the cleaned context only to avoid repeating words already shown and to continue ' +
                'a sentence naturally. Never restate the context.\n' +
                '- If the fragment has no meaningful content (only filler, noise, or silence), return ' +
                'an empty string.\n\n' +
                'Output ONLY the cleaned text, with no quotes, labels, or commentary.',
            },
            {
              role: 'user',
              content:
                (context ? `CLEANED SO FAR (context, do not repeat):\n${context}\n\n` : '') +
                `RAW FRAGMENT:\n${raw}`,
            },
          ],
        }),
      });

      if (!openaiRes.ok) {
        // Fail open: return the raw text so the transcript still flows.
        return res.json({ text: raw });
      }
      const data = await openaiRes.json();
      const cleaned = String(data.choices?.[0]?.message?.content || '').trim();

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'clean_transcript',
          model: 'gpt-4.1-nano', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(raw),
          outputTokens: usage.output_tokens || estimateTokens(cleaned),
        });
      }).catch(() => {});

      return res.json({ text: cleaned });
    } catch (error) {
      console.error('❌ clean-transcript error:', error?.message);
      // Fail open with whatever raw text we had.
      return res.json({ text: String(req.body?.text || '').trim() });
    }
  });

  // ──────────────────────────────────────────────────
  // Live assist — Cluely-style in-call copilot. The overlay streams the rolling
  // meeting transcript here after each utterance; a fast model decides whether
  // THIS moment deserves a private help card (a question the user was asked, a
  // company/term worth a quick brief, a claim worth verifying, a "what should I
  // say" moment). When live data would materially improve the card, we run a
  // quick Serper search mid-sentence and compose the answer from real results.
  // Returns { insight: null } for most calls — silence is the default.
  // ──────────────────────────────────────────────────
  app.post('/api/ai/live-assist', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const transcript = String(req.body?.transcript || '').slice(-2400).trim();
      if (transcript.length < 30) return res.json({ insight: null });
      const shown = Array.isArray(req.body?.shown)
        ? req.body.shown.map((s) => String(s || '').slice(0, 80)).slice(-10)
        : [];

      const detectRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
          prompt_cache_key: `live-assist:${req.user?.id || 'anon'}`,
          messages: [
            {
              role: 'system',
              content:
                'You are a live in-meeting copilot rendered on a private overlay only the user ' +
                '("You" in the transcript) can see. You watch the rolling transcript and decide ' +
                'whether THIS moment deserves a help card.\n\n' +
                'TRIGGER only when the NEWEST lines contain one of:\n' +
                '1. A question directed at the user that they may need help answering — draft the ' +
                'answer for them (kind "answer").\n' +
                '2. A company, product, person, or technical term worth a 2-sentence brief ' +
                '(kind "brief").\n' +
                '3. A factual claim, number, or date worth verifying (kind "fact").\n' +
                '4. The user is clearly stuck or asked aloud what to say — suggest their next line ' +
                '(kind "suggest").\n\n' +
                'DO NOT trigger for small talk, pleasantries, scheduling chatter, or anything ' +
                'similar to an ALREADY SHOWN card. Most calls should NOT trigger — silence is ' +
                'the default, cards must feel earned.\n\n' +
                'Set "search_query" (a short web query) ONLY when live/external data would ' +
                'materially improve the card: company facts, current prices/news, a specific ' +
                'person, recent releases. Leave it null for general knowledge.\n\n' +
                'Reply with JSON ONLY:\n' +
                '{"trigger": boolean, "kind": "answer"|"brief"|"fact"|"suggest", ' +
                '"title": "<= 8 words", "body": "2-4 direct, usable sentences", ' +
                '"search_query": string|null}',
            },
            {
              role: 'user',
              content:
                `ROLLING TRANSCRIPT (newest last):\n${transcript}\n\n` +
                (shown.length ? `ALREADY SHOWN CARDS (do not repeat):\n- ${shown.join('\n- ')}` : ''),
            },
          ],
        }),
      });
      if (!detectRes.ok) return res.json({ insight: null });
      const detectData = await detectRes.json();
      let parsed = null;
      try {
        parsed = JSON.parse(detectData.choices?.[0]?.message?.content || 'null');
      } catch (_) {
        parsed = null;
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(detectData);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'live_assist',
          model: 'gpt-4.1-mini', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(transcript),
          outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      if (!parsed?.trigger || !parsed?.body) return res.json({ insight: null });

      const kind = ['answer', 'brief', 'fact', 'suggest'].includes(parsed.kind) ? parsed.kind : 'suggest';
      let body = String(parsed.body || '').slice(0, 700).trim();
      const title = String(parsed.title || '').slice(0, 90).trim() || 'Heads up';
      let sources = [];

      // Mid-sentence lookup: quick Serper pass (snippets only — deep browsing
      // would blow the latency budget), then recompose the card from real data.
      const query = String(parsed.search_query || '').trim();
      if (query && process.env.SERPER_API_KEY) {
        try {
          const found = await searchWeb(query, { num: 4, deepBrowse: false });
          if (found.ok && found.results?.length) {
            sources = found.results.slice(0, 3).map((r) => ({ title: r.title, url: r.url }));
            const snippets = found.results
              .map((r) => `- ${r.title}: ${r.snippet}`)
              .join('\n');
            const composeRes = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gpt-4.1-mini',
                temperature: 0.2,
                max_tokens: 220,
                messages: [
                  {
                    role: 'system',
                    content:
                      'Rewrite the meeting help card below using the live search results. ' +
                      'Keep it to 2-4 direct, factual sentences the user can say or act on ' +
                      'mid-conversation. No preamble, no markdown headers. Output only the ' +
                      'rewritten card body.',
                  },
                  {
                    role: 'user',
                    content: `CARD DRAFT:\n${body}\n\nLIVE SEARCH RESULTS for "${query}":\n${snippets}`,
                  },
                ],
              }),
            });
            if (composeRes.ok) {
              const composeData = await composeRes.json();
              const composed = String(composeData.choices?.[0]?.message?.content || '').trim();
              if (composed) body = composed.slice(0, 700);
            }
          }
        } catch (_) {
          /* search is best-effort — the draft card still ships */
        }
      }

      return res.json({ insight: { kind, title, body, sources } });
    } catch (error) {
      console.error('❌ live-assist error:', error?.message);
      return res.json({ insight: null });
    }
  });

  // ──────────────────────────────────────────────────
  // Meeting notes — rolling summary + key points + action items from the desktop
  // overlay's live transcript. The transcript is speaker-labeled ("You" = the
  // user, "Them" = others). Called periodically while listening so the overlay can
  // show notes that build up live. Returns structured JSON.
  // ──────────────────────────────────────────────────
  app.post('/api/ai/meeting-notes', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    const empty = {
      summary: '', keyPoints: [], actionItems: [], questionsToAsk: [], suggestions: [], topics: [],
    };
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const transcript = String(req.body?.transcript || '').slice(-16000).trim();
      if (transcript.length < 40) return res.json(empty);
      const previous = req.body?.previousNotes && typeof req.body.previousNotes === 'object'
        ? req.body.previousNotes
        : null;

      const prevBlock = previous
        ? `\n\nPREVIOUS NOTES (update — keep what's still valid, revise as the conversation evolves):\n${JSON.stringify(previous)}`
        : '';

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You produce live meeting intelligence from a conversation transcript — like Granola or Otter. ' +
                'Speakers: "You" = the user wearing LYKN (mic). "Others" = remote participants / meeting audio.\n\n' +
                'Return ONLY a JSON object:\n' +
                '{"summary": string, "keyPoints": string[], "actionItems": string[], ' +
                '"questionsToAsk": string[], "suggestions": string[], "topics": string[]}\n\n' +
                '- summary: 2-4 sentences on what the meeting is about and where it stands NOW.\n' +
                '- keyPoints: important facts, decisions, numbers (max 8, short phrases).\n' +
                '- actionItems: tasks/follow-ups with owner when clear ("You: …", "Others: …"). Max 8.\n' +
                '- questionsToAsk: 3-5 smart questions YOU would ask next to move the conversation forward ' +
                '(first person, under 12 words each). Be specific to what was just discussed.\n' +
                '- suggestions: 2-4 brief talking points or clarifications the user could offer right now.\n' +
                '- topics: 2-5 topic tags for the meeting so far (short nouns/phrases).\n\n' +
                'Be factual. NEVER invent content not in the transcript. Output only JSON.',
            },
            { role: 'user', content: transcript + prevBlock },
          ],
        }),
      });

      if (!openaiRes.ok) return res.json(empty);
      const data = await openaiRes.json();
      let parsed = empty;
      try {
        parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      } catch (_) {
        parsed = empty;
      }
      const pick = (arr, max) =>
        Array.isArray(arr) ? arr.map((s) => String(s || '').trim()).filter(Boolean).slice(0, max) : [];
      const result = {
        summary: String(parsed.summary || '').trim(),
        keyPoints: pick(parsed.keyPoints, 8),
        actionItems: pick(parsed.actionItems, 8),
        questionsToAsk: pick(parsed.questionsToAsk, 5),
        suggestions: pick(parsed.suggestions, 4),
        topics: pick(parsed.topics, 5),
      };

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'meeting_notes',
          model: 'gpt-4o-mini', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(transcript),
          outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      return res.json(result);
    } catch (error) {
      console.error('❌ meeting-notes error:', error?.message);
      return res.json(empty);
    }
  });

  // ──────────────────────────────────────────────────
  // Suggestions for the desktop overlay (Cluely-style): after an answer, return
  // (1) relevant follow-up questions the user can tap, and (2) real source links
  // looked up live on the web. One cheap model call decides the follow-ups + the
  // best search query; we then run the existing web search for genuine URLs (never
  // model-hallucinated links). Best-effort — returns empty arrays on any failure.
  // ──────────────────────────────────────────────────
  app.post('/api/ai/suggest', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    const empty = { followups: [], links: [] };
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.json(empty);

      const question = String(req.body?.question || '').slice(0, 1500).trim();
      const answer = String(req.body?.answer || '').slice(0, 4000).trim();
      const mode = String(req.body?.mode || '').trim();
      if (!question && !answer) return res.json(empty);

      const liveWatchMode = mode === 'live_watch';
      const agentBrowserMode = mode === 'agent_browser';
      const systemPrompt = liveWatchMode
        ? 'You help a desktop AI assistant suggest follow-up questions while the user has live screen feedback on. ' +
          'Given context about what page or app they are on and what LYKN observed, return ONLY a JSON object:\n' +
          '{"followups": string[], "searchQuery": string}\n\n' +
          '- followups: 3 short, specific questions the USER would ask about their CURRENT activity — ' +
          'the page they are on, what they are reading or doing, or sensible next actions. ' +
          'Use the page title and URL when available. Phrase in first person, under ~10 words each. ' +
          'Examples: "Summarize this article", "Compare these prices", "What does this error mean?"\n' +
          '- searchQuery: a web search query for sources related to their current page or task when ' +
          'external reference info would help. Empty string if the context is purely personal/on-screen.\n\n' +
          'Output only the JSON.'
        : agentBrowserMode
        ? 'You help a desktop browser agent suggest the next useful actions after it finishes a task. ' +
          'Given the user\'s ask and what the agent just did/found, return ONLY a JSON object:\n' +
          '{"followups": string[], "searchQuery": string}\n\n' +
          '- followups: exactly 3 short, specific next actions the USER would ask the browser agent to do next. ' +
          'Make them concrete to THIS finished task (page, product, email, campaign, doc, etc.) — never generic ' +
          '("keep going", "dig deeper", "what\'s next"). Phrase as first-person commands under ~12 words. ' +
          'Assume the agent continues on the SAME open tab and clicks through the UI — tip wording should ' +
          'sound like a continuation, not a cold start. ' +
          'Examples: "Open the top campaign and review spend", "Draft a reply to that email", ' +
          '"Compare the two cheapest options".\n' +
          '- searchQuery: empty string unless a web lookup would clearly help beyond the current tab.\n\n' +
          'Output only the JSON.'
        : 'You help a desktop AI assistant suggest next steps after it answers a user. ' +
          'Given the user\'s question and the assistant\'s answer, return ONLY a JSON object:\n' +
          '{"followups": string[], "searchQuery": string}\n\n' +
          '- followups: 3 short, natural follow-up questions the user would plausibly ask next. ' +
          'Each under ~8 words, phrased as the user (first person). No numbering.\n' +
          '- searchQuery: a single web search query that would surface helpful sources/links ' +
          'for this topic. Provide one ONLY when external, current, or reference info would ' +
          'genuinely help. If the topic is purely about the user\'s own screen/personal data ' +
          'and a web lookup would not help, return an empty string.\n\n' +
          'Output only the JSON.';

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.4,
          max_tokens: 320,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `QUESTION:\n${question}\n\nANSWER:\n${answer}` },
          ],
        }),
      });

      let followups = [];
      let searchQuery = '';
      if (openaiRes.ok) {
        const data = await openaiRes.json();
        try {
          const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
          followups = Array.isArray(parsed.followups)
            ? parsed.followups.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3)
            : [];
          searchQuery = String(parsed.searchQuery || '').trim().slice(0, 200);
        } catch (_) { /* keep defaults */ }

        getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
          const usage = extractOpenAIUsage(data);
          logAiUsage({
            sessionId: session?.id, userId: req.user?.id, actionType: 'overlay_suggest',
            model: 'gpt-4o-mini', provider: 'openai',
            inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
          });
        }).catch(() => {});
      }

      // Real links via the existing web search (snippets only — fast, no deep browse).
      let links = [];
      if (searchQuery) {
        try {
          const out = await searchWeb(searchQuery, { num: 4, deepBrowse: false });
          if (out?.ok && Array.isArray(out.results)) {
            links = out.results
              .filter((r) => r && r.url)
              .map((r) => ({ title: String(r.title || r.url).slice(0, 120), url: String(r.url) }))
              .slice(0, 4);
          }
        } catch (_) { /* no links */ }
      }

      return res.json({ followups, links });
    } catch (error) {
      console.error('❌ suggest error:', error?.message);
      return res.json(empty);
    }
  });

  // ──────────────────────────────────────────────────
  // Auto-name grid — cheapest model, fire-and-forget from client
  // ──────────────────────────────────────────────────
  app.post('/api/ai/name-grid', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const content = String(req.body?.content || '').trim();
      if (!content || content.length < 10) {
        return res.status(400).json({ error: 'Not enough content to name' });
      }

      const snippet = content.slice(0, 1500);

      const nameCache = memCache('grid-name');
      const cacheKey = sha256(snippet);
      const cached = nameCache.get(cacheKey);
      if (cached) return res.json({ title: cached, cached: true });

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          temperature: 0.4,
          max_tokens: 30,
          // Static system prompt — pin this specific naming task to one
          // OpenAI cache slot per user so repeated grid renames hit the
          // discount tier on the system prefix.
          prompt_cache_key: `grid-name:${req.user?.id || 'anon'}`,
          messages: [
            {
              role: 'system',
              content: 'You name documents. Given content from a visual grid/board, reply with ONLY a short title (2-5 words). No quotes, no punctuation, no explanation. Just the title.',
            },
            { role: 'user', content: snippet },
          ],
        }),
      });

      if (!openaiRes.ok) {
        return res.status(502).json({ error: 'naming_failed' });
      }
      const data = await openaiRes.json();
      const raw = data.choices?.[0]?.message?.content?.trim() || '';
      const title = raw.replace(/^["']+|["']+$/g, '').trim().slice(0, 60);
      if (!title) return res.status(502).json({ error: 'empty_title' });

      nameCache.set(cacheKey, title);
      console.log('[LYKN] Auto-named grid:', title);

      getOrCreateSession(req.user?.id).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'name_grid',
          model: 'gpt-4.1-nano', provider: 'openai',
          inputTokens: usage.input_tokens || estimateTokens(snippet),
          outputTokens: usage.output_tokens || estimateTokens(raw),
        });
      }).catch(() => {});

      return res.json({ title });
    } catch (error) {
      console.error('❌ name-grid error:', error?.message);
      return res.status(500).json({ error: 'Naming failed' });
    }
  });
}
