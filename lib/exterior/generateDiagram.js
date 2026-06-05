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

  const krokiUrl = `https://kroki.io/mermaid/svg/${encodeURIComponent(source)}`;

  return {
    ok: true,
    diagram_type: diagramType,
    title,
    mermaid: source,
    markdown,
    preview_url: krokiUrl,
    usage_hint: 'Paste the markdown block in your reply so the diagram renders; preview_url is a static SVG fallback.',
  };
}
