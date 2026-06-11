import zlib from 'node:zlib';

const MAX_MERMAID_LEN = 8000;
const ALLOWED_DIAGRAM_TYPES = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
];

const BLOCKED_MERMAID = /\b(click|callback|script|style\s+<|<script|javascript:)/i;

function normalizeMermaid(source) {
  return String(source || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_MERMAID_LEN);
}

// Kroki's GET API does NOT accept a URL-encoded raw diagram source — it
// expects the source to be zlib-deflated and then base64url-encoded
// (per https://docs.kroki.io/kroki/setup/encode-diagram/). Passing the
// plain (or percent-encoded) text makes Kroki reply with
// `400 ... unable to decode the source, the source is not valid in base64`.
function krokiEncode(source) {
  const compressed = zlib.deflateSync(Buffer.from(source, 'utf8'), { level: 9 });
  return compressed
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function detectDiagramType(source) {
  const firstLine = source.split('\n').find((l) => l.trim())?.trim() || '';
  for (const kind of ALLOWED_DIAGRAM_TYPES) {
    if (firstLine.startsWith(kind)) return kind;
  }
  return null;
}

/**
 * Validate Mermaid source and return renderable markdown + Kroki preview URL.
 */
export function generateDiagram(input = {}) {
  let source = normalizeMermaid(input.mermaid);
  if (!source) return { ok: false, error: 'mermaid source is required' };

  if (BLOCKED_MERMAID.test(source)) {
    return { ok: false, error: 'mermaid_contains_blocked_directives' };
  }

  let diagramType = detectDiagramType(source);
  if (!diagramType) {
    source = `flowchart TD\n${source}`;
    diagramType = 'flowchart';
  }

  const title = String(input.title || '').trim().slice(0, 120) || null;
  const markdown = [
    title ? `### ${title}` : null,
    '```mermaid',
    source,
    '```',
  ].filter(Boolean).join('\n');

  // Kroki renders the same source to either format via the path segment. SVG is
  // the crisp inline preview; PNG is a universally-openable raster file so the
  // user always has at least one download usable outside LYKN.
  const encodedSource = krokiEncode(source);
  const krokiUrl = `https://kroki.io/mermaid/svg/${encodedSource}`;
  const krokiPng = `https://kroki.io/mermaid/png/${encodedSource}`;
  const slug = (title || `${diagramType}-diagram`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'diagram';

  return {
    ok: true,
    diagram_type: diagramType,
    title,
    mermaid: source,
    markdown,
    preview_url: krokiUrl,
    download_links: [
      { format: 'svg', url: krokiUrl, filename: `${slug}.svg` },
      { format: 'png', url: krokiPng, filename: `${slug}.png` },
    ],
    usage_hint: 'Paste the markdown block in your reply so the diagram renders; the diagram card offers SVG/PNG downloads — do not paste the URLs.',
  };
}
