import { maybePersistBufferArtifact } from '../capabilityStorage.js';
import { safeFetch } from '../ssrfGuard.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function loadAudioBuffer({ audio_url, base64 }) {
  if (base64) {
    const buf = Buffer.from(String(base64).trim(), 'base64');
    if (buf.length > MAX_AUDIO_BYTES) return { ok: false, error: 'audio_too_large' };
    return { ok: true, buffer: buf, filename: 'audio.mp3', mimeType: 'audio/mpeg' };
  }
  if (audio_url) {
    let res;
    try {
      res = await safeFetch(String(audio_url).trim());
    } catch (err) {
      if (err?.code === 'SSRF_BLOCKED') return { ok: false, error: 'url_not_allowed' };
      return { ok: false, error: 'fetch_failed' };
    }
    if (!res.ok) return { ok: false, error: `fetch_failed_${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) return { ok: false, error: 'audio_too_large' };
    const ct = res.headers.get('content-type') || 'audio/mpeg';
    const ext = ct.includes('wav') ? 'wav' : ct.includes('webm') ? 'webm' : 'mp3';
    return { ok: true, buffer: buf, filename: `audio.${ext}`, mimeType: ct };
  }
  return { ok: false, error: 'audio_url_or_base64_required' };
}

/**
 * Transcribe audio via OpenAI Whisper; optionally persist source audio.
 */
export async function transcribeAudio(args = {}, ctx = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'openai_api_key_not_configured' };

  const loaded = await loadAudioBuffer(args);
  if (!loaded.ok) return loaded;

  const language = args.language ? String(args.language).trim() : undefined;
  const form = new FormData();
  form.append(
    'file',
    new Blob([loaded.buffer], { type: loaded.mimeType || 'audio/mpeg' }),
    loaded.filename,
  );
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  if (args.prompt) form.append('prompt', String(args.prompt).slice(0, 500));

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data?.error?.message || `whisper_http_${res.status}` };
  }

  let result = {
    ok: true,
    text: String(data.text || '').trim(),
    model: 'whisper-1',
    duration_hint_sec: args.duration_sec ?? null,
  };

  if (ctx.supabaseAdmin && ctx.userId && args.persist_source !== false) {
    result = await maybePersistBufferArtifact(result, ctx, {
      buffer: loaded.buffer,
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      category: 'audio',
    });
  }

  return result;
}
