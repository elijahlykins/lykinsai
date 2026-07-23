import { fetchWebPage } from '../webFetch.js';
import { geminiMultimodal, inlineDataPart, textPart } from '../geminiClient.js';
import { generateChatImage } from '../generateImage.js';
import { editImageWithGemini } from './editImage.js';
import { extractPdfText } from './pdfExtract.js';
import { safeFetch } from '../ssrfGuard.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

async function loadImageBytes({ image_url, base64, mime_type }) {
  if (base64) {
    const buf = Buffer.from(String(base64).trim(), 'base64');
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'image_too_large' };
    return {
      ok: true,
      buffer: buf,
      base64: buf.toString('base64'),
      mimeType: mime_type || 'image/png',
      bytes: buf.length,
    };
  }
  if (image_url) {
    let res;
    try {
      res = await safeFetch(String(image_url).trim());
    } catch (err) {
      if (err?.code === 'SSRF_BLOCKED') return { ok: false, error: 'url_not_allowed' };
      return { ok: false, error: 'fetch_failed' };
    }
    if (!res.ok) return { ok: false, error: `fetch_failed_${res.status}` };
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'image_too_large' };
    if (mimeType.includes('pdf')) {
      const pdf = await extractPdfText(buf);
      if (pdf.ok) return { ok: true, pdf: true, text: pdf.text, mimeType, bytes: buf.length };
    }
    return {
      ok: true,
      buffer: buf,
      base64: buf.toString('base64'),
      mimeType,
      bytes: buf.length,
    };
  }
  return { ok: false, error: 'image_url_or_base64_required' };
}

const PROMPTS = {
  ocr: 'Extract all readable text from this image or document. Preserve layout where helpful. Return plain text only.',
  analyze:
    'Analyze this image in detail. Describe subjects, text, charts, UI elements, and anything relevant to the user question.',
};

/**
 * OCR, vision analysis, and image editing via Gemini.
 */
export async function processImage(args = {}, ctx = {}) {
  const operation = String(args.operation || 'analyze').trim().toLowerCase();
  const userPrompt = String(args.prompt || args.question || '').trim();
  const imageUrl = String(args.image_url || args.url || '').trim();

  if (operation === 'generate') {
    return generateChatImage({
      prompt: userPrompt || 'Generate an image based on the conversation context.',
      aspectRatio: args.aspect_ratio,
      imageSize: args.image_size,
      userId: ctx.userId,
      supabaseAdmin: ctx.supabaseAdmin,
      logUsage: ctx.logUsage,
    });
  }

  const loaded = await loadImageBytes({
    image_url: imageUrl,
    base64: args.base64,
    mime_type: args.mime_type,
  });

  if (!loaded.ok) {
    if (imageUrl && operation === 'ocr') {
      const page = await fetchWebPage(imageUrl);
      if (page.ok && page.text) {
        return { ok: true, operation, source: 'web_page_text', text: page.text };
      }
    }
    return loaded;
  }

  if (loaded.pdf && operation === 'ocr') {
    return { ok: true, operation, source: 'pdf_text', text: loaded.text, bytes: loaded.bytes };
  }

  if (operation === 'edit') {
    if (!userPrompt) return { ok: false, error: 'prompt_required_for_edit' };
    return editImageWithGemini({
      prompt: userPrompt,
      referenceBase64: loaded.base64,
      mimeType: loaded.mimeType,
      userId: ctx.userId,
      supabaseAdmin: ctx.supabaseAdmin,
      aspectRatio: args.aspect_ratio,
      imageSize: args.image_size,
    });
  }

  const instruction = userPrompt || PROMPTS[operation] || PROMPTS.analyze;
  const result = await geminiMultimodal({
    parts: [textPart(instruction), inlineDataPart(loaded.base64, loaded.mimeType)],
    systemInstruction:
      operation === 'ocr'
        ? 'You are an OCR engine. Return extracted text only, no commentary.'
        : 'You are a vision assistant. Be precise and structured.',
  });

  if (!result.ok) return result;
  return {
    ok: true,
    operation,
    text: result.text,
    model: result.model,
    bytes: loaded.bytes,
  };
}
