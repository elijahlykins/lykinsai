import { maybePersistBufferArtifact } from '../capabilityStorage.js';

/**
 * Text-to-speech via OpenAI with persisted downloadable audio.
 */
export async function generateSpeech(args = {}, ctx = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'openai_api_key_not_configured' };

  const text = String(args.text || '').trim();
  if (!text) return { ok: false, error: 'text is required' };
  if (text.length > 4096) return { ok: false, error: 'text_too_long', max_chars: 4096 };

  const voice = String(args.voice || 'alloy').trim();
  const model = String(args.model || 'tts-1').trim();
  const format = String(args.format || 'mp3').trim();

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: format,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err?.error?.message || `tts_http_${res.status}` };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  let result = {
    ok: true,
    model,
    voice,
    format,
    bytes: buffer.length,
    filename: `speech-${Date.now()}.${format}`,
  };

  return maybePersistBufferArtifact(result, ctx, {
    buffer,
    filename: result.filename,
    mimeType: format === 'mp3' ? 'audio/mpeg' : `audio/${format}`,
    category: 'audio',
  });
}
