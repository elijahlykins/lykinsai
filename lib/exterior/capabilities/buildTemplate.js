import PptxGenJS from 'pptxgenjs';
import {
  loadCapabilityArtifact,
  maybePersistBufferArtifact,
  maybePersistTextArtifact,
  mimeTypeForFilename,
  persistCapabilityArtifact,
} from '../capabilityStorage.js';
import { buildSlideshowHtml } from './templateExports.js';

const TEMPLATE_TYPES = new Set([
  'slideshow',
  'presentation',
  'education',
  'worksheet',
  'document',
  'email',
  'form',
  'social',
  'layout',
  'generic',
]);

const TYPE_ALIASES = {
  template_slideshow: 'slideshow',
  template_presentation: 'presentation',
  template_education: 'education',
  template_worksheet: 'worksheet',
  template_document: 'document',
  template_email: 'email',
  template_form: 'form',
  template_social: 'social',
  template_layout: 'layout',
  template_generic: 'generic',
};

function normalizeType(raw) {
  const t = String(raw || 'generic').trim().toLowerCase();
  return TYPE_ALIASES[t] || t;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildMarkdown(type, { title, sections, metadata }) {
  const lines = [`# ${title || 'Untitled template'}`, ''];
  if (metadata && Object.keys(metadata).length) {
    lines.push('## Metadata', '');
    for (const [k, v] of Object.entries(metadata)) {
      lines.push(`- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    lines.push('');
  }

  const items = Array.isArray(sections) ? sections : [];
  if (type === 'slideshow' || type === 'presentation') {
    items.forEach((sec, i) => {
      lines.push(`## Slide ${i + 1}${sec.heading ? `: ${sec.heading}` : ''}`, '');
      if (sec.body) lines.push(String(sec.body), '');
      if (sec.notes) lines.push(`> Speaker notes: ${sec.notes}`, '');
    });
    return lines.join('\n');
  }

  if (type === 'worksheet') {
    items.forEach((sec, i) => {
      lines.push(`### Question ${i + 1}${sec.heading ? `: ${sec.heading}` : ''}`, '');
      if (sec.body) lines.push(String(sec.body), '');
      if (sec.answer_key) lines.push(`**Answer key:** ${sec.answer_key}`, '');
    });
    return lines.join('\n');
  }

  if (type === 'form') {
    items.forEach((sec) => {
      const label = sec.heading || sec.label || 'Field';
      const fieldType = sec.field_type || 'text';
      lines.push(`- **${label}** (${fieldType})${sec.required ? ' *required*' : ''}`);
      if (sec.body) lines.push(`  ${sec.body}`);
    });
    return lines.join('\n');
  }

  items.forEach((sec) => {
    if (sec.heading) lines.push(`## ${sec.heading}`, '');
    if (sec.body) lines.push(String(sec.body), '');
  });
  return lines.join('\n');
}

function buildEmailHtml(title, sections) {
  const body = (sections || [])
    .map(
      (sec) =>
        `<section><h2>${escapeHtml(sec.heading || '')}</h2><div>${escapeHtml(sec.body || '').replace(/\n/g, '<br/>')}</div></section>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;line-height:1.5">${body}</body></html>`;
}

async function buildPptxBuffer(title, sections) {
  const pptx = new PptxGenJS();
  pptx.author = 'LYKN';
  pptx.title = title;
  pptx.layout = 'LAYOUT_16x9';

  const items = Array.isArray(sections) ? sections : [];
  if (!items.length) {
    const slide = pptx.addSlide();
    slide.addText(title, { x: 0.5, y: 2.2, w: 9, h: 1, fontSize: 32, bold: true });
  } else {
    for (const sec of items) {
      const slide = pptx.addSlide();
      if (sec.heading) {
        slide.addText(String(sec.heading), { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true });
      }
      if (sec.body) {
        slide.addText(String(sec.body), { x: 0.5, y: 1.4, w: 9, h: 4.5, fontSize: 16, valign: 'top' });
      }
      if (sec.notes) slide.addNotes(String(sec.notes));
    }
  }

  const data = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(data);
}

/**
 * Validate, format, and export templates with persisted downloadable artifacts.
 */
export async function buildTemplate(args = {}, ctx = {}) {
  const templateType = normalizeType(args.template_type || args.type);
  if (!TEMPLATE_TYPES.has(templateType)) {
    return { ok: false, error: 'invalid_template_type', allowed: [...TEMPLATE_TYPES] };
  }

  const title = String(args.title || '').trim() || 'Untitled';
  const sections = Array.isArray(args.sections) ? args.sections.slice(0, 100) : [];
  const metadata =
    args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? args.metadata
      : {};
  const exportFormats = Array.isArray(args.export_formats)
    ? args.export_formats.map((f) => String(f).toLowerCase())
    : ['markdown', 'json'];

  if (!sections.length && !args.content) {
    return { ok: false, error: 'sections_or_content_required' };
  }

  const normalizedSections = sections.map((sec, idx) => ({
    id: sec.id || `section_${idx + 1}`,
    heading: sec.heading || sec.title || null,
    body: sec.body || sec.content || '',
    notes: sec.notes || null,
    field_type: sec.field_type || null,
    required: !!sec.required,
    answer_key: sec.answer_key || null,
  }));

  const markdown = buildMarkdown(templateType, { title, sections: normalizedSections, metadata });
  const payload = {
    template_type: templateType,
    title,
    sections: normalizedSections,
    metadata,
    markdown,
    content: args.content ? String(args.content) : markdown,
    section_count: normalizedSections.length,
    schema: { template_type: templateType, title, sections: normalizedSections, metadata },
  };

  const artifacts = [];

  if (exportFormats.includes('json') && ctx.supabaseAdmin && ctx.userId) {
    const jsonStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
      buffer: Buffer.from(JSON.stringify(payload.schema, null, 2), 'utf8'),
      filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.json`,
      category: 'templates',
    });
    if (jsonStored.ok) artifacts.push({ format: 'json', ...jsonStored });
  }

  if (
    (exportFormats.includes('html') ||
      templateType === 'slideshow' ||
      templateType === 'presentation' ||
      templateType === 'layout') &&
    ctx.supabaseAdmin &&
    ctx.userId
  ) {
    const html =
      templateType === 'email'
        ? buildEmailHtml(title, normalizedSections)
        : buildSlideshowHtml(title, normalizedSections, { templateType });
    const htmlStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
      buffer: Buffer.from(html, 'utf8'),
      filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.html`,
      category: 'templates',
    });
    if (htmlStored.ok) artifacts.push({ format: 'html', ...htmlStored });
  }

  if (
    (exportFormats.includes('pptx') || templateType === 'slideshow' || templateType === 'presentation') &&
    ctx.supabaseAdmin &&
    ctx.userId
  ) {
    try {
      const pptxBuffer = await buildPptxBuffer(title, normalizedSections);
      const pptxStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: pptxBuffer,
        filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.pptx`,
        category: 'templates',
      });
      if (pptxStored.ok) artifacts.push({ format: 'pptx', ...pptxStored });
    } catch (err) {
      payload.pptx_warning = err?.message || 'pptx_export_failed';
    }
  }

  let result = { ok: true, ...payload, artifacts };

  result = await maybePersistTextArtifact(result, ctx, {
    content: markdown,
    filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.md`,
    mimeType: mimeTypeForFilename('out.md'),
    category: 'templates',
  });

  if (artifacts.length) {
    result.primary_download = artifacts[artifacts.length - 1].file_url;
    result.download_links = artifacts.map((a) => ({
      format: a.format,
      url: a.file_url,
      filename: a.filename,
    }));
  }

  return result;
}

export { TEMPLATE_TYPES, TYPE_ALIASES };
