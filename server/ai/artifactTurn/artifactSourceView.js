// How an open coded artifact is shown to the model on an edit turn.
//
// Previously chatStream.routes.js inlined up to 60,000 chars of component
// source (70,000 across a multi-file project) into every edit prompt, and
// truncated past that with NO marker — so on a large artifact the model
// could not see the tail, and every `find` snippet aimed at it failed with
// edit_target_not_found, forever. It also meant edit latency and cost scaled
// with artifact size, on a block that changes after every patch and is
// therefore never a prompt-cache hit.
//
// This module decides between two views:
//
//   inline  — the artifact is small enough to show whole. Byte-for-byte the
//             same fenced source as before, so `find` snippets are copied
//             from the real thing. No behavior change for the common case.
//
//   outline — the artifact is too big. The model gets the file tree and a
//             line-numbered map of top-level declarations, and pulls the
//             exact regions it needs with lykn_read_artifact_source before
//             patching. Line numbers appear ONLY in the map and the tool's
//             metadata, never inside copyable source, so they can't leak
//             into a `find`.

/**
 * Above this many chars of total source, switch to the outline view.
 *
 * Deliberately set to the size the OLD code could already show in full. Below
 * it, nothing about an edit turn changes — same inlined source, same prompt,
 * same behavior that has always worked. The outline path exists for the range
 * that used to be silently truncated (and therefore un-patchable), not to
 * shave tokens off builds that were fine. A lower number trades a working
 * path for a cheaper one, which is not a trade to make quietly.
 */
export const SOURCE_INLINE_LIMIT = 60000;

/** Hard cap on a single inlined file, so one huge module can't crowd out the rest. */
export const INLINE_FILE_LIMIT = 60000;

/** How much of the entry file to show alongside the outline. */
export const OUTLINE_HEAD_LINES = 40;

function lineCount(text) {
  return String(text || '').split('\n').length;
}

/**
 * Top-level declarations worth navigating by: imports, consts, functions,
 * classes, exports, and JSX component boundaries. Deliberately shallow — the
 * point is "where do I look", not a parse tree.
 */
const DECLARATION_RE =
  /^(?:import\s|export\s|(?:async\s+)?function\s|class\s|const\s+[A-Za-z_$][\w$]*\s*=|let\s+[A-Za-z_$][\w$]*\s*=|var\s+[A-Za-z_$][\w$]*\s*=)/;

/**
 * Line-numbered map of a source file's top-level structure.
 * @returns {{line:number, text:string}[]}
 */
export function outlineSource(src, { maxEntries = 120 } = {}) {
  const lines = String(src || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top level only: no leading indentation.
    if (/^\s/.test(line)) continue;
    if (!DECLARATION_RE.test(line)) continue;
    out.push({ line: i + 1, text: line.trimEnd().slice(0, 160) });
    if (out.length >= maxEntries) break;
  }
  return out;
}

function renderOutline(entries) {
  if (!entries.length) return '  (no top-level declarations found)';
  const width = String(entries[entries.length - 1].line).length;
  return entries
    .map((e) => `  ${String(e.line).padStart(width, ' ')}: ${e.text}`)
    .join('\n');
}

function renderHead(src, lines = OUTLINE_HEAD_LINES) {
  const head = String(src || '').split('\n').slice(0, lines).join('\n');
  return head;
}

/** Normalize the two artifact shapes into one file list. */
function toFileList({ code, files, entry }) {
  const multi = Array.isArray(files)
    ? files.filter((f) => f && typeof f.path === 'string')
    : [];
  if (multi.length) {
    const entryName = String(entry || 'App.jsx');
    const sorted = [...multi].sort((x, y) => {
      if (x.path === entryName) return -1;
      if (y.path === entryName) return 1;
      return String(x.path).localeCompare(String(y.path));
    });
    return { multi: true, entry: entryName, list: sorted };
  }
  return {
    multi: false,
    entry: String(entry || 'App.jsx'),
    list: [{ path: String(entry || 'App.jsx'), content: String(code || '') }],
  };
}

/**
 * Build the `• …` source section of the [ARTIFACT_OPEN] block.
 *
 * @param {{code?:string, files?:{path:string,content:string}[], entry?:string}} artifact
 * @param {{inlineLimit?:number}} [opts]
 * @returns {{mode:'inline'|'outline', block:string, totalChars:number, fileCount:number}}
 */
export function buildReactSourceView(artifact, opts = {}) {
  const inlineLimit = Number.isFinite(opts.inlineLimit)
    ? opts.inlineLimit
    : SOURCE_INLINE_LIMIT;
  const { multi, entry, list } = toFileList(artifact || {});
  const totalChars = list.reduce((n, f) => n + String(f.content || '').length, 0);

  const listing = list
    .map((f) => {
      const body = String(f.content || '');
      const tag = f.path === entry && multi ? '  [entry]' : '';
      return `  - ${f.path} (${body.length} chars, ${lineCount(body)} lines)${tag}`;
    })
    .join('\n');

  // ---- inline view: the whole thing, exactly as the model must copy it ----
  if (totalChars <= inlineLimit) {
    if (!multi) {
      return {
        mode: 'inline',
        totalChars,
        fileCount: 1,
        block: `• current component source (JSX):\n\`\`\`jsx\n${String(list[0].content || '')}\n\`\`\`\n`,
      };
    }
    const parts = list.map(
      (f) => `—— ${f.path} ——\n\`\`\`jsx\n${String(f.content || '')}\n\`\`\``,
    );
    return {
      mode: 'inline',
      totalChars,
      fileCount: list.length,
      block:
        `• multi-file project (entry: ${entry}):\n${listing}\n` +
        `• sources:\n${parts.join('\n')}\n`,
    };
  }

  // ---- outline view: map + head, exact regions on request ----
  const maps = list
    .map((f) => {
      const entries = outlineSource(f.content);
      return `—— ${f.path} ——\n${renderOutline(entries)}`;
    })
    .join('\n');
  const entryFile = list.find((f) => f.path === entry) || list[0];

  return {
    mode: 'outline',
    totalChars,
    fileCount: list.length,
    block:
      `• LARGE artifact — ${totalChars} chars across ${list.length} file(s). ` +
      `The full source is deliberately NOT inlined.\n` +
      `• files:\n${listing}\n` +
      `• structure map (line numbers are for lykn_read_artifact_source ONLY — ` +
      `they are NOT part of the source and must never appear in a \`find\`):\n${maps}\n` +
      `• first ${OUTLINE_HEAD_LINES} lines of ${entryFile.path}:\n` +
      `\`\`\`jsx\n${renderHead(entryFile.content)}\n\`\`\`\n` +
      `• BEFORE patching: call lykn_read_artifact_source for each region you ` +
      `intend to change (by \`find\` substring, or \`path\` + \`start_line\`/\`end_line\` ` +
      `from the map above). It returns the exact text to copy into \`find\`. ` +
      `Never guess a snippet from the map — the map is truncated per line.\n`,
  };
}
