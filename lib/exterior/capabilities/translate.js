import { geminiGenerateText } from '../geminiClient.js';

/**
 * Translate text. Prefers Gemini; falls back to returning an error if unavailable.
 */
export async function translateText(args = {}) {
  const text = String(args.text || '').trim();
  const target = String(args.target_language || args.to || '').trim();
  const source = String(args.source_language || args.from || 'auto').trim();

  if (!text) return { ok: false, error: 'text is required' };
  if (!target) return { ok: false, error: 'target_language is required' };
  if (text.length > 20_000) return { ok: false, error: 'text_too_long' };

  if (process.env.GOOGLE_API_KEY) {
    const prompt = [
      `Translate the following text to ${target}.`,
      source !== 'auto' ? `Source language: ${source}.` : 'Detect the source language automatically.',
      'Return ONLY the translation — no commentary.',
      '',
      text,
    ].join('\n');
    const result = await geminiGenerateText({ prompt });
    if (!result.ok) return result;
    return {
      ok: true,
      translation: result.text,
      target_language: target,
      source_language: source === 'auto' ? null : source,
      provider: 'gemini',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Translate to ${target}. Return only the translation.`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `openai_http_${res.status}` };
    }
    return {
      ok: true,
      translation: data.choices?.[0]?.message?.content?.trim() || '',
      target_language: target,
      provider: 'openai',
    };
  }

  return { ok: false, error: 'translation_not_configured', hint: 'Set GOOGLE_API_KEY or OPENAI_API_KEY' };
}
