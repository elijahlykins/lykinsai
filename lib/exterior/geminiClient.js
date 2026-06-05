const DEFAULT_TEXT_MODEL = String(process.env.GEMINI_CAPABILITY_MODEL || 'gemini-2.0-flash').trim();
const DEFAULT_VISION_MODEL = String(process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash').trim();

async function callGemini({ model, body, apiKey }) {
  const key = apiKey || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, error: 'google_api_key_not_configured' };

  for (const apiVersion of ['v1beta', 'v1']) {
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      if (res.status === 404 || /not found|invalid model/i.test(msg)) continue;
      return { ok: false, error: msg || `gemini_http_${res.status}`, detail: json?.error || null };
    }
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text.trim() : ''))
      .filter(Boolean)
      .join('\n');
    return { ok: true, text, raw: json, model, apiVersion };
  }
  return { ok: false, error: 'gemini_model_unavailable', model };
}

/** @param {{ prompt: string, systemInstruction?: string, model?: string }} opts */
export async function geminiGenerateText({ prompt, systemInstruction, model }) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'prompt is required' };
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: String(systemInstruction).trim() }] } }
      : {}),
  };
  return callGemini({ model: model || DEFAULT_TEXT_MODEL, body });
}

/** @param {{ parts: object[], model?: string, systemInstruction?: string }} opts */
export async function geminiMultimodal({ parts, model, systemInstruction }) {
  if (!Array.isArray(parts) || !parts.length) return { ok: false, error: 'parts is required' };
  const body = {
    contents: [{ role: 'user', parts }],
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: String(systemInstruction).trim() }] } }
      : {}),
  };
  return callGemini({ model: model || DEFAULT_VISION_MODEL, body });
}

export function inlineDataPart(base64, mimeType) {
  return { inlineData: { data: base64, mimeType } };
}

export function textPart(text) {
  return { text: String(text || '') };
}
