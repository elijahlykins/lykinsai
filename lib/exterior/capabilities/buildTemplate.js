import PptxGenJS from 'pptxgenjs';
import {
  loadCapabilityArtifact,
  maybePersistBufferArtifact,
  maybePersistTextArtifact,
  mimeTypeForFilename,
  persistCapabilityArtifact,
} from '../capabilityStorage.js';
import { buildDocumentHtml, buildSlideshowHtml, buildTemplatePdfBuffer } from './templateExports.js';
import { applyArtifactEdits } from './buildReactArtifact.js';

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

// Generated documents / PDFs / decks must stay emoji-free (the model often
// sprinkles 🎉🚀✅ into headings + bullets). This strips emoji and pictographs
// while preserving the glyphs real documents need: arrows (→ ⟶), math (− × ²),
// Greek (Δ Σ μ), superscripts, bullets (•), and the checkbox markers the
// markdown renderer keys off (☐ ☑ □ ✓ ✔) — none of which are emoji-presentation.
const EMOJI_STRIP_RE =
  /(?:(?![\u2610\u2611\u2612\u2713\u2714\u2717\u2718\u25A1])[\p{Extended_Pictographic}\p{Emoji_Presentation}])[\uFE0F\u200D]?|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|[\uFE0F\u200D\u20E3]/gu;

function stripEmoji(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(EMOJI_STRIP_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/^[ \t]+$/gm, '')
    .trim();
}

// Recursively strip emoji from any string inside an object/array (used for
// free-form metadata the model can attach to a template).
function stripEmojiDeep(value) {
  if (typeof value === 'string') return stripEmoji(value);
  if (Array.isArray(value)) return value.map(stripEmojiDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripEmojiDeep(v);
    return out;
  }
  return value;
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
 * Apply targeted section patches to an open template (deck/doc). Supports:
 *   • { find, replace } — unique substring across heading/body/notes
 *   • { index|id, heading?, body?, notes? } — field overlays on one section
 *   • { insert_at, section } — insert a new section
 *   • { remove_index|remove_id } — drop a section
 */
export function applySectionEdits(activeSections, edits) {
  let sections = (Array.isArray(activeSections) ? activeSections : []).map((sec, idx) => ({
    id: sec.id || `section_${idx + 1}`,
    heading: sec.heading || sec.title || null,
    body: sec.body || sec.content || '',
    notes: sec.notes || null,
    field_type: sec.field_type || null,
    required: !!sec.required,
    answer_key: sec.answer_key || null,
  }));

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    if (typeof e.remove_index === 'number') {
      if (e.remove_index < 0 || e.remove_index >= sections.length) {
        return { ok: false, error: 'section_edit_bad_index', hint: `section_edits[${i}].remove_index out of range.` };
      }
      sections.splice(e.remove_index, 1);
      continue;
    }
    if (e.remove_id != null) {
      const rid = String(e.remove_id);
      const at = sections.findIndex((s) => String(s.id) === rid);
      if (at < 0) {
        return { ok: false, error: 'section_edit_id_not_found', hint: `section_edits[${i}].remove_id "${rid}" not found.` };
      }
      sections.splice(at, 1);
      continue;
    }
    if (e.insert_at != null || e.section) {
      const at = typeof e.insert_at === 'number' ? e.insert_at : sections.length;
      const sec = e.section && typeof e.section === 'object' ? e.section : e;
      const next = {
        id: sec.id || `section_${sections.length + 1}`,
        heading: sec.heading || sec.title || null,
        body: sec.body || sec.content || '',
        notes: sec.notes || null,
        field_type: sec.field_type || null,
        required: !!sec.required,
        answer_key: sec.answer_key || null,
      };
      const clamped = Math.max(0, Math.min(sections.length, at));
      sections.splice(clamped, 0, next);
      continue;
    }
    if (e.find != null && String(e.find).length) {
      const find = String(e.find);
      const replace = String(e.replace ?? '');
      let hits = 0;
      let hitField = null;
      let hitIdx = -1;
      for (let si = 0; si < sections.length; si++) {
        for (const field of ['heading', 'body', 'notes']) {
          const val = sections[si][field];
          if (typeof val !== 'string') continue;
          let from = 0;
          while (true) {
            const at = val.indexOf(find, from);
            if (at === -1) break;
            hits += 1;
            hitField = field;
            hitIdx = si;
            from = at + Math.max(find.length, 1);
          }
        }
      }
      if (hits === 0) {
        return {
          ok: false,
          error: 'section_edit_target_not_found',
          hint:
            `section_edits[${i}]: \`find\` did not match any heading/body/notes. ` +
            `Snippet starts with: ${JSON.stringify(find.slice(0, 120))}. Copy EXACTLY from [ARTIFACT_OPEN].`,
        };
      }
      if (hits > 1) {
        return {
          ok: false,
          error: 'section_edit_target_ambiguous',
          hint: `section_edits[${i}]: \`find\` matches ${hits} places. Include more surrounding text so it is unique.`,
        };
      }
      const cur = String(sections[hitIdx][hitField]);
      const at = cur.indexOf(find);
      sections[hitIdx] = {
        ...sections[hitIdx],
        [hitField]: cur.slice(0, at) + replace + cur.slice(at + find.length),
      };
      continue;
    }

    let idx = typeof e.index === 'number' ? e.index : -1;
    if (idx < 0 && e.id != null) {
      idx = sections.findIndex((s) => String(s.id) === String(e.id));
    }
    if (idx < 0 || idx >= sections.length) {
      return {
        ok: false,
        error: 'section_edit_target_missing',
        hint: `section_edits[${i}] needs a valid index, id, find/replace, insert_at, or remove_*.`,
      };
    }
    const cur = { ...sections[idx] };
    if (e.heading !== undefined) cur.heading = e.heading;
    if (e.title !== undefined) cur.heading = e.title;
    if (e.body !== undefined) cur.body = e.body;
    if (e.content !== undefined) cur.body = e.content;
    if (e.notes !== undefined) cur.notes = e.notes;
    if (e.answer_key !== undefined) cur.answer_key = e.answer_key;
    sections[idx] = cur;
  }

  return { ok: true, sections: sections.slice(0, 100) };
}

/**
 * Validate, format, and export templates with persisted downloadable artifacts.
 */
export async function buildTemplate(args = {}, ctx = {}) {
  const templateType = normalizeType(args.template_type || args.type);
  if (!TEMPLATE_TYPES.has(templateType)) {
    return { ok: false, error: 'invalid_template_type', allowed: [...TEMPLATE_TYPES] };
  }

  const activeSections = Array.isArray(ctx.activeArtifactSections)
    ? ctx.activeArtifactSections
    : [];
  const sectionEdits = Array.isArray(args.section_edits)
    ? args.section_edits.filter((e) => e && typeof e === 'object')
    : [];
  const allowFullRewrite = ctx.allowFullRewrite === true;
  const wantsFullRewrite = args.full_rewrite === true && allowFullRewrite;
  let sections = Array.isArray(args.sections) ? args.sections.slice(0, 100) : [];
  let contentArg = args.content != null ? String(args.content) : '';
  let patchedInPlace = false;

  // Content patches against an open document (find/replace on `content`).
  const contentEdits = Array.isArray(args.content_edits)
    ? args.content_edits.filter((e) => e && typeof e === 'object')
    : [];
  const activeContent =
    typeof ctx.activeArtifactContent === 'string' ? ctx.activeArtifactContent : '';
  if (contentEdits.length && activeContent && !(wantsFullRewrite && contentArg.trim())) {
    const patched = applyArtifactEdits(activeContent, contentEdits);
    if (!patched.ok) return patched;
    contentArg = patched.code;
    patchedInPlace = true;
  }

  // Section patches against an open deck/doc — never re-emit every slide.
  if (sectionEdits.length && activeSections.length && !(wantsFullRewrite && sections.length)) {
    const patched = applySectionEdits(activeSections, sectionEdits);
    if (!patched.ok) return patched;
    sections = patched.sections;
    patchedInPlace = true;
  }

  // Style-only refine (font / theme): model OMITs sections; we keep the open
  // deck's slides verbatim so "change the font" can't rewrite the pitch.
  const styleOnlyReuse =
    !sections.length &&
    !contentArg &&
    !sectionEdits.length &&
    !contentEdits.length &&
    activeSections.length > 0;
  if (styleOnlyReuse) {
    sections = activeSections;
  }

  if (args.full_rewrite === true && activeSections.length > 0 && !allowFullRewrite && !patchedInPlace && !styleOnlyReuse) {
    return {
      ok: false,
      error: 'section_edits_required',
      hint:
        'An artifact is already open and the user did not ask to redesign/rebuild. ' +
        'Use `section_edits` (or font/theme only). Do not set full_rewrite.',
    };
  }

  // HARD RULE — open template + no authorized full_rewrite ⇒ style-only,
  // section_edits, or content_edits.
  if (
    activeSections.length > 0 &&
    !wantsFullRewrite &&
    !patchedInPlace &&
    !styleOnlyReuse &&
    (sections.length > 0 || contentArg.trim())
  ) {
    return {
      ok: false,
      error: 'section_edits_required',
      hint:
        'An artifact is already open. For content changes, call again with `section_edits` ONLY ' +
        '(field overlays by index/id, find/replace, insert_at, or remove_*) — do NOT resubmit the ' +
        'full `sections` array. For font/color only, omit sections and pass `font`/`theme`. ' +
        'Do not set full_rewrite unless the user explicitly asked to rebuild.',
    };
  }

  const title =
    stripEmoji(String(args.title || '').trim()) ||
    stripEmoji(String(ctx.activeArtifactTitle || '').trim()) ||
    'Untitled';
  const metadata =
    args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? stripEmojiDeep(args.metadata)
      : {};
  // Accent color theme — a name ("blue", "green"…) or hex. Preserved across
  // edits so a recolor sticks until the user asks to change it again.
  const theme =
    (typeof args.theme === 'string' && args.theme.trim()) ||
    (typeof args.accent === 'string' && args.accent.trim()) ||
    (metadata && typeof metadata.theme === 'string' && metadata.theme.trim()) ||
    (metadata && typeof metadata.accent === 'string' && metadata.accent.trim()) ||
    (typeof ctx.activeArtifactTheme === 'string' && ctx.activeArtifactTheme.trim()) ||
    null;
  const font =
    (typeof args.font === 'string' && args.font.trim()) ||
    (typeof args.font_family === 'string' && args.font_family.trim()) ||
    (metadata && typeof metadata.font === 'string' && metadata.font.trim()) ||
    (typeof ctx.activeArtifactFont === 'string' && ctx.activeArtifactFont.trim()) ||
    null;
  const exportFormats = Array.isArray(args.export_formats)
    ? args.export_formats.map((f) => String(f).toLowerCase())
    : ['markdown', 'json'];

  if (!sections.length && !contentArg) {
    return {
      ok: false,
      error: 'sections_or_content_required',
      hint:
        'Pass `sections` for new builds, or `section_edits` / `font` / `theme` when an artifact is open. ' +
        'For font/color-only edits, omit `sections` and pass `font` and/or `theme` — the server reuses the open slides.',
    };
  }

  const normalizedSections = sections.map((sec, idx) => ({
    id: sec.id || `section_${idx + 1}`,
    heading: stripEmoji(sec.heading || sec.title || null),
    body: stripEmoji(sec.body || sec.content || ''),
    notes: stripEmoji(sec.notes || null),
    field_type: sec.field_type || null,
    required: !!sec.required,
    answer_key: stripEmoji(sec.answer_key || null),
  }));

  const markdown = buildMarkdown(templateType, { title, sections: normalizedSections, metadata });
  const payload = {
    template_type: templateType,
    title,
    sections: normalizedSections,
    metadata,
    theme: theme || null,
    font: font || null,
    style_only: styleOnlyReuse,
    markdown,
    content: contentArg.trim() ? stripEmoji(contentArg) : markdown,
    section_count: normalizedSections.length,
    schema: { template_type: templateType, title, sections: normalizedSections, metadata },
  };

  const artifacts = [];

  // Build the rich HTML preview up front, independent of storage. The client
  // renders this inline via an iframe srcDoc, so the preview works even when
  // persistence is unavailable or the signed URL is served in a way that would
  // otherwise show raw source instead of the rendered page.
  const isSlideLike =
    templateType === 'slideshow' || templateType === 'presentation' || templateType === 'layout';
  const previewHtml =
    templateType === 'email'
      ? buildEmailHtml(title, normalizedSections)
      : isSlideLike
        ? buildSlideshowHtml(title, normalizedSections, { templateType, theme, font })
        : buildDocumentHtml(title, normalizedSections, { templateType, theme, font });

  if (exportFormats.includes('json') && ctx.supabaseAdmin && ctx.userId) {
    const jsonStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
      buffer: Buffer.from(JSON.stringify(payload.schema, null, 2), 'utf8'),
      filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.json`,
      category: 'templates',
    });
    if (jsonStored.ok) artifacts.push({ format: 'json', ...jsonStored });
  }

  // Persist the HTML export too (download / open-in-tab), when storage is available.
  if (ctx.supabaseAdmin && ctx.userId) {
    const htmlStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
      buffer: Buffer.from(previewHtml, 'utf8'),
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

  // PDF — the universal, "just works for everyone" download. Built for every
  // template type so study guides, documents, and worksheets always have a
  // human-friendly file (HTML/JSON are useless to most people).
  if (ctx.supabaseAdmin && ctx.userId) {
    try {
      const pdfBuffer = buildTemplatePdfBuffer(title, normalizedSections, { templateType });
      const pdfStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: pdfBuffer,
        filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.pdf`,
        category: 'templates',
      });
      if (pdfStored.ok) artifacts.push({ format: 'pdf', ...pdfStored });
    } catch (err) {
      payload.pdf_warning = err?.message || 'pdf_export_failed';
    }
  }

  let result = { ok: true, ...payload, artifacts };
  if (previewHtml) result.preview_html = previewHtml;

  result = await maybePersistTextArtifact(result, ctx, {
    content: markdown,
    filename: `${title.replace(/\s+/g, '-').slice(0, 40)}.md`,
    mimeType: mimeTypeForFilename('out.md'),
    category: 'templates',
  });

  // Assemble the download menu. Lead with formats most people can actually use
  // (PDF, PPTX, Word-friendly Markdown) and push developer formats (HTML, JSON)
  // to the end so the "easy" download is the obvious first choice.
  const links = artifacts.map((a) => ({ format: a.format, url: a.file_url, filename: a.filename }));
  if (result.file_url && /\.md$/i.test(result.filename || '') && !links.some((l) => l.format === 'md')) {
    links.push({ format: 'md', url: result.file_url, filename: result.filename });
  }
  const FORMAT_PRIORITY = { pdf: 0, pptx: 1, docx: 2, md: 3, markdown: 3, csv: 4, xlsx: 4, html: 5, json: 9 };
  links.sort((a, b) => (FORMAT_PRIORITY[a.format] ?? 6) - (FORMAT_PRIORITY[b.format] ?? 6));

  if (links.length) {
    result.download_links = links;
    result.primary_download = links[0].url;
  }

  return result;
}

export { TEMPLATE_TYPES, TYPE_ALIASES };
