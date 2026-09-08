// readArtifactSource — pull exact regions out of the OPEN coded artifact.
//
// Companion to the outline view (server/ai/artifactTurn/artifactSourceView.js).
// When an artifact is too large to inline, the model gets a structure map and
// calls this to fetch the precise text it needs before writing `edits`.
//
// The returned source is verbatim and unnumbered so it can be copied straight
// into a `find`. Line numbers ride alongside as metadata only.

const MAX_RETURN_CHARS = 20000;
const DEFAULT_CONTEXT_LINES = 12;

/** Normalize the ctx's artifact shape into Map<path, content> + entry. */
function projectFromCtx(ctx = {}) {
  const files = Array.isArray(ctx.activeArtifactFiles)
    ? ctx.activeArtifactFiles.filter((f) => f && typeof f.path === 'string')
    : [];
  if (files.length) {
    return {
      map: new Map(files.map((f) => [f.path, String(f.content ?? '')])),
      entry: String(ctx.activeArtifactEntry || files[0].path),
    };
  }
  const code = String(ctx.activeArtifactCode ?? '');
  if (!code) return { map: new Map(), entry: '' };
  const entry = String(ctx.activeArtifactEntry || 'App.jsx');
  return { map: new Map([[entry, code]]), entry };
}

function sliceLines(content, startLine, endLine) {
  const lines = content.split('\n');
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return {
    text: lines.slice(start - 1, end).join('\n'),
    start_line: start,
    end_line: end,
    total_lines: lines.length,
  };
}

export async function readArtifactSource(args = {}, ctx = {}) {
  const { map, entry } = projectFromCtx(ctx);
  if (!map.size) {
    return {
      ok: false,
      error: 'no_artifact_open',
      hint: 'lykn_read_artifact_source only works while a coded artifact is open for editing.',
    };
  }

  const requested = String(args.path || '').trim();
  const path = requested || entry || [...map.keys()][0];
  if (!map.has(path)) {
    return {
      ok: false,
      error: 'path_not_found',
      hint: `"${path}" is not in this artifact. Files: ${[...map.keys()].join(', ')}.`,
    };
  }
  const content = map.get(path);
  const find = String(args.find || '');

  // `find` mode: locate a substring and return it with surrounding context,
  // which is exactly the shape the model needs to build a unique snippet.
  if (find) {
    const idx = content.indexOf(find);
    if (idx === -1) {
      return {
        ok: false,
        error: 'find_not_found',
        path,
        hint:
          `"${find.slice(0, 80)}" does not appear in ${path}. ` +
          'Check the structure map, or read a line range instead.',
      };
    }
    const before = content.slice(0, idx).split('\n').length;
    const spanned = find.split('\n').length;
    const context = Number.isInteger(args.context_lines)
      ? Math.max(0, Math.min(args.context_lines, 200))
      : DEFAULT_CONTEXT_LINES;
    const region = sliceLines(content, before - context, before + spanned - 1 + context);
    const occurrences = content.split(find).length - 1;
    return {
      ok: true,
      path,
      ...region,
      occurrences,
      source: region.text.slice(0, MAX_RETURN_CHARS),
      usage_hint:
        occurrences > 1
          ? `"${find.slice(0, 40)}" appears ${occurrences} times in ${path} — copy a longer unique snippet, or set \`occurrence\`/\`replace_all\` on the edit.`
          : 'Copy the snippet you need from `source` VERBATIM into `edits[].find`. The line numbers are metadata, not part of the source.',
    };
  }

  // Range mode.
  const totalLines = content.split('\n').length;
  const startLine = Number.isInteger(args.start_line) ? args.start_line : 1;
  const endLine = Number.isInteger(args.end_line) ? args.end_line : totalLines;
  const region = sliceLines(content, startLine, endLine);
  const truncated = region.text.length > MAX_RETURN_CHARS;
  return {
    ok: true,
    path,
    ...region,
    truncated,
    source: region.text.slice(0, MAX_RETURN_CHARS),
    usage_hint: truncated
      ? `Returned the first ${MAX_RETURN_CHARS} chars of that range — narrow start_line/end_line for the rest.`
      : 'Copy the snippet you need from `source` VERBATIM into `edits[].find`. The line numbers are metadata, not part of the source.',
  };
}
