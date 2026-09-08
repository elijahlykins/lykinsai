// ============================================================================
// codeProjectBundle — multi-file React artifact projects
// ============================================================================
// Bundles a virtual file tree (relative ESM imports) into one source string
// the existing Babel/CDN runner can execute. CDN packages (react, three, …)
// stay as bare imports so buildReactRunnerHtml's rewrite pass still works.

export const MAX_PROJECT_FILES = 48;
export const MAX_FILE_CHARS = 80_000;
export const MAX_PROJECT_CHARS = 240_000;
export const DEFAULT_ENTRY = 'App.jsx';

const EXT_CANDIDATES = ['', '.jsx', '.js', '.tsx', '.ts', '/index.jsx', '/index.js', '/index.tsx', '/index.ts'];

/** Normalize path separators and strip a leading `./`. */
export function normalizeProjectPath(p) {
  let s = String(p || '').replace(/\\/g, '/').trim();
  if (!s) return '';
  s = s.replace(/^\.\/+/, '');
  while (s.includes('/./')) s = s.replace(/\/\.\//g, '/');
  const parts = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function dirnameOf(path) {
  const n = normalizeProjectPath(path);
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}

function joinPath(fromDir, spec) {
  const raw = String(spec || '').replace(/\\/g, '/');
  if (raw.startsWith('/')) return normalizeProjectPath(raw.slice(1));
  const base = fromDir ? `${fromDir}/${raw}` : raw;
  return normalizeProjectPath(base);
}

/** Resolve a relative import against a file map. Returns normalized path or null. */
export function resolveProjectImport(fromPath, spec, files) {
  const s = String(spec || '').trim();
  if (!s || !(s.startsWith('./') || s.startsWith('../'))) return null;
  const fromDir = dirnameOf(fromPath);
  const joined = joinPath(fromDir, s);
  const map = files instanceof Map ? files : new Map(Object.entries(files || {}));
  for (const ext of EXT_CANDIDATES) {
    const candidate = normalizeProjectPath(joined + ext);
    if (map.has(candidate)) return candidate;
  }
  return null;
}

/** True if the import specifier is a relative project file (not a CDN package). */
export function isRelativeImport(spec) {
  const s = String(spec || '').trim();
  return s.startsWith('./') || s.startsWith('../');
}

/**
 * Parse model-supplied files into a normalized Map<path, content>.
 * Accepts [{path, content}] or { path: content }.
 */
export function normalizeProjectFiles(raw) {
  const out = new Map();
  if (!raw) return { ok: true, files: out };

  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      if (!row || typeof row !== 'object') {
        return { ok: false, error: 'bad_file_entry', hint: `files[${i}] must be {path, content}.` };
      }
      const path = normalizeProjectPath(row.path);
      const content = String(row.content ?? '');
      if (!path) {
        return { ok: false, error: 'bad_file_path', hint: `files[${i}].path is empty.` };
      }
      if (!/^[A-Za-z0-9_./\-]+$/.test(path)) {
        return {
          ok: false,
          error: 'bad_file_path',
          hint: `files[${i}].path "${path}" has invalid characters.`,
        };
      }
      if (content.length > MAX_FILE_CHARS) {
        return {
          ok: false,
          error: 'file_too_long',
          hint: `files[${i}] (${path}) exceeds ${MAX_FILE_CHARS} chars.`,
          path,
        };
      }
      out.set(path, content);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const path = normalizeProjectPath(k);
      const content = String(v ?? '');
      if (!path) continue;
      if (content.length > MAX_FILE_CHARS) {
        return { ok: false, error: 'file_too_long', hint: `${path} exceeds ${MAX_FILE_CHARS} chars.`, path };
      }
      out.set(path, content);
    }
  } else {
    return { ok: false, error: 'bad_files', hint: 'files must be an array of {path, content} or a path→content object.' };
  }

  if (out.size > MAX_PROJECT_FILES) {
    return {
      ok: false,
      error: 'too_many_files',
      hint: `Projects support up to ${MAX_PROJECT_FILES} files (got ${out.size}).`,
    };
  }
  let total = 0;
  for (const c of out.values()) total += c.length;
  if (total > MAX_PROJECT_CHARS) {
    return {
      ok: false,
      error: 'project_too_large',
      hint: `Total project source exceeds ${MAX_PROJECT_CHARS} chars.`,
    };
  }
  return { ok: true, files: out };
}

export function filesMapToArray(files) {
  const map = files instanceof Map ? files : new Map(Object.entries(files || {}));
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({ path, content: String(content ?? '') }));
}

export function filesMapToObject(files) {
  const obj = {};
  for (const [path, content] of (files instanceof Map ? files : new Map(Object.entries(files || {})))) {
    obj[path] = String(content ?? '');
  }
  return obj;
}

/** Pick entry: explicit → App.jsx/App.tsx/index.jsx → sole file → first .jsx/.js. */
export function resolveEntry(files, entryHint) {
  const map = files instanceof Map ? files : new Map(Object.entries(files || {}));
  if (!map.size) return null;
  const hint = normalizeProjectPath(entryHint || '');
  if (hint && map.has(hint)) return hint;
  for (const candidate of [DEFAULT_ENTRY, 'App.tsx', 'App.js', 'src/App.jsx', 'src/App.tsx', 'index.jsx', 'index.tsx', 'index.js']) {
    if (map.has(candidate)) return candidate;
  }
  if (map.size === 1) return [...map.keys()][0];
  for (const p of map.keys()) {
    if (/\.(jsx|tsx)$/i.test(p)) return p;
  }
  return [...map.keys()][0];
}

/* ------------------------------------------------------------------ */
/*  Edit targeting                                                      */
/* ------------------------------------------------------------------ */

const LEADING_WS = /^[ \t]*/;

function indentOf(line) {
  return LEADING_WS.exec(String(line))[0];
}

/**
 * Re-indent a replacement block when the model reproduced the `find` snippet
 * at a different base indentation than the file actually uses. Only uniform
 * shifts are applied — if the two indents aren't prefix-compatible (mixed
 * tabs/spaces, say) the replacement is passed through untouched.
 */
function reindentReplacement(text, fromIndent, toIndent) {
  if (fromIndent === toIndent) return text;
  const lines = String(text).split('\n');
  if (fromIndent.startsWith(toIndent)) {
    const strip = fromIndent.slice(toIndent.length);
    return lines
      .map((l) => (l.startsWith(strip) ? l.slice(strip.length) : l))
      .join('\n');
  }
  if (toIndent.startsWith(fromIndent)) {
    const add = toIndent.slice(fromIndent.length);
    return lines.map((l) => (l.trim() ? add + l : l)).join('\n');
  }
  return text;
}

/** Char offset of the start of every line in `src`. */
function lineOffsets(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Find where an edit's `find` snippet lives in `source`.
 *
 * Two passes, in order:
 *   1. Exact substring — the contract the tool advertises, and the only pass
 *      that can match a partial/inline snippet.
 *   2. Whitespace-tolerant line match (multi-line snippets only) — compares
 *      lines with leading/trailing whitespace stripped. This is what saves the
 *      round-trip when a model reproduces a block correctly but re-indents it,
 *      which is the single most common cause of `edit_target_not_found` and
 *      costs a full model turn every time it happens.
 *
 * By default a pass must land on exactly ONE site, so a patch can never
 * silently hit the wrong occurrence. Two opt-ins relax that when the model
 * knows what it is doing:
 *   • `occurrence` (1-based) — patch the Nth match of a repeated snippet.
 *   • `replaceAll`  — patch every match.
 * Without one of those, multiple matches stay an error.
 *
 * @param {string} source
 * @param {string} find
 * @param {{occurrence?:number, replaceAll?:boolean}} [opts]
 * @returns {{ok:true,sites:{start:number,end:number,replacement:(t:string)=>string}[],exact:boolean,matchCount:number}
 *          |{ok:false,error:'edit_target_not_found'|'edit_target_ambiguous'|'edit_occurrence_out_of_range',matchCount?:number}}
 */
export function locateEditTarget(source, find, opts = {}) {
  const src = String(source);
  const needle = String(find);
  const identity = (text) => text;
  const replaceAll = opts.replaceAll === true;
  const occurrence = Number.isInteger(opts.occurrence) && opts.occurrence > 0
    ? opts.occurrence
    : null;

  /** Reduce a list of candidate sites to the ones this edit asked for. */
  const select = (sites) => {
    if (replaceAll) return { ok: true, sites, exact: sites.exact, matchCount: sites.length };
    if (occurrence) {
      if (occurrence > sites.length) {
        return { ok: false, error: 'edit_occurrence_out_of_range', matchCount: sites.length };
      }
      return { ok: true, sites: [sites[occurrence - 1]], matchCount: sites.length };
    }
    if (sites.length > 1) return { ok: false, error: 'edit_target_ambiguous', matchCount: sites.length };
    return { ok: true, sites, matchCount: sites.length };
  };

  // Pass 1 — exact substring.
  const exactSites = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + Math.max(1, needle.length))) {
    exactSites.push({ start: i, end: i + needle.length, replacement: identity });
  }
  if (exactSites.length) {
    const picked = select(exactSites);
    return picked.ok ? { ...picked, exact: true } : picked;
  }

  // Pass 2 — whitespace-tolerant, multi-line snippets only.
  const needleLines = needle.split('\n');
  if (needleLines.length < 2) return { ok: false, error: 'edit_target_not_found', matchCount: 0 };
  const wanted = needleLines.map((l) => l.trim());
  const srcLines = src.split('\n');
  const offsets = lineOffsets(src);
  const fromIndent = indentOf(needleLines[0]);

  const fuzzySites = [];
  for (let j = 0; j + wanted.length <= srcLines.length; j++) {
    let match = true;
    for (let i = 0; i < wanted.length; i++) {
      if (srcLines[j + i].trim() !== wanted[i]) { match = false; break; }
    }
    if (!match) continue;
    const last = j + wanted.length - 1;
    const toIndent = indentOf(srcLines[j]);
    fuzzySites.push({
      start: offsets[j],
      end: offsets[last] + srcLines[last].length,
      replacement: (text) => reindentReplacement(text, fromIndent, toIndent),
    });
  }
  if (!fuzzySites.length) return { ok: false, error: 'edit_target_not_found', matchCount: 0 };
  const picked = select(fuzzySites);
  return picked.ok ? { ...picked, exact: false } : picked;
}

/**
 * Splice every located site with the edit's replacement, back-to-front so
 * earlier offsets stay valid.
 */
export function spliceEditSites(source, sites, replaceText) {
  let out = String(source);
  const ordered = [...sites].sort((a, b) => b.start - a.start);
  for (const site of ordered) {
    out = out.slice(0, site.start) + site.replacement(replaceText) + out.slice(site.end);
  }
  return out;
}

/**
 * Human-readable reason for a failed edit, phrased as an instruction the
 * model can act on without re-deriving the whole batch.
 */
export function editFailureHint(error, { index, path, find, matchCount } = {}) {
  const at = `edits[${index}]${path ? ` in ${path}` : ''}`;
  const snippet = JSON.stringify(String(find || '').slice(0, 120));
  if (error === 'edit_target_ambiguous') {
    return (
      `${at}: \`find\` matches ${matchCount} places. Either include more surrounding ` +
      'lines so the snippet is unique, or set `occurrence` (1-based) to pick one, or ' +
      '`replace_all: true` to patch every match.'
    );
  }
  if (error === 'edit_occurrence_out_of_range') {
    return `${at}: \`occurrence\` is past the end — \`find\` matches ${matchCount} place(s).`;
  }
  return (
    `${at}: \`find\` did not match the current source. Snippet starts with: ${snippet}. ` +
    'Copy it verbatim from [ARTIFACT_OPEN] and retry ONLY this edit. ' +
    'Do NOT fall back to full `code`/`files` or full_rewrite.'
  );
}

/**
 * Apply path-scoped find/replace edits.
 * Each edit: { path?, find, replace, occurrence?, replace_all? }.
 * Missing path → entry (or sole file).
 *
 * Every edit is LOCATED before any is applied, and a failure reports EVERY
 * bad edit in the batch rather than stopping at the first. The batch stays
 * atomic on purpose — a half-patched artifact can compile-fail in ways
 * neither the model nor the user asked for — but the model now learns about
 * all its mistakes in one round-trip instead of discovering them one at a
 * time across N turns, which is where edit latency actually went.
 */
export function applyProjectEdits(files, edits, entry) {
  const map = new Map(files instanceof Map ? files : Object.entries(files || {}));
  const list = Array.isArray(edits) ? edits.filter((e) => e && typeof e === 'object') : [];
  if (!list.length) return { ok: true, files: map, edits_applied: 0 };

  /** @type {{index:number,path:string,error:string,hint:string}[]} */
  const failures = [];
  /** Located sites, grouped per file so one splice pass handles each. */
  const planned = [];

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const find = String(e.find ?? '');
    const replace = String(e.replace ?? '');
    if (!find) {
      failures.push({
        index: i,
        path: '',
        error: 'edit_missing_find',
        hint: `edits[${i}] has an empty \`find\`.`,
      });
      continue;
    }
    let path = normalizeProjectPath(e.path || '');
    if (!path) path = entry || resolveEntry(map, null);
    if (!path || !map.has(path)) {
      failures.push({
        index: i,
        path: String(e.path || '(entry)'),
        error: 'edit_path_not_found',
        hint:
          `edits[${i}]: path "${e.path || '(entry)'}" is not in the project. ` +
          `Known files: ${[...map.keys()].slice(0, 20).join(', ')}.`,
      });
      continue;
    }
    const target = locateEditTarget(String(map.get(path) ?? ''), find, {
      occurrence: e.occurrence,
      replaceAll: e.replace_all === true || e.replaceAll === true,
    });
    if (!target.ok) {
      failures.push({
        index: i,
        path,
        error: target.error,
        hint: editFailureHint(target.error, { index: i, path, find, matchCount: target.matchCount }),
      });
      continue;
    }
    planned.push({ path, sites: target.sites, replace });
  }

  if (failures.length) {
    return {
      ok: false,
      error: failures[0].error,
      failed_edits: failures,
      edits_locatable: planned.length,
      hint:
        `${failures.length} of ${list.length} edit(s) could not be applied — NOTHING was changed. ` +
        `Fix ONLY these and resend the whole batch:\n${failures.map((f) => `• ${f.hint}`).join('\n')}`,
    };
  }

  // Splice per file. Sites within a file were located against the same
  // snapshot, so they are spliced together back-to-front.
  const byPath = new Map();
  for (const p of planned) {
    if (!byPath.has(p.path)) byPath.set(p.path, []);
    for (const site of p.sites) byPath.get(p.path).push({ ...site, replace: p.replace });
  }
  for (const [path, sites] of byPath) {
    let code = String(map.get(path) ?? '');
    const ordered = [...sites].sort((a, b) => b.start - a.start);
    for (const site of ordered) {
      code = code.slice(0, site.start) + site.replacement(site.replace) + code.slice(site.end);
    }
    if (code.length > MAX_FILE_CHARS) {
      return { ok: false, error: 'file_too_long', hint: `After edits, ${path} exceeds ${MAX_FILE_CHARS} chars.` };
    }
    map.set(path, code);
  }
  return { ok: true, files: map, edits_applied: list.length };
}

/**
 * Apply write/delete file ops against a project map.
 * ops: [{ op: 'write'|'delete', path, content? }]
 */
export function applyFileOps(files, ops) {
  const map = new Map(files instanceof Map ? files : Object.entries(files || {}));
  const list = Array.isArray(ops) ? ops.filter((o) => o && typeof o === 'object') : [];
  if (!list.length) return { ok: true, files: map, ops_applied: 0 };

  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const op = String(o.op || o.action || 'write').toLowerCase();
    const path = normalizeProjectPath(o.path);
    if (!path) {
      return { ok: false, error: 'bad_file_path', hint: `file_ops[${i}].path is required.` };
    }
    if (!/^[A-Za-z0-9_./\-]+$/.test(path)) {
      return { ok: false, error: 'bad_file_path', hint: `file_ops[${i}].path "${path}" is invalid.` };
    }
    if (op === 'delete' || op === 'remove') {
      if (!map.has(path)) {
        return { ok: false, error: 'file_not_found', hint: `file_ops[${i}]: cannot delete missing file ${path}.` };
      }
      map.delete(path);
      continue;
    }
    if (op !== 'write' && op !== 'create' && op !== 'upsert') {
      return {
        ok: false,
        error: 'bad_file_op',
        hint: `file_ops[${i}].op must be write or delete (got "${op}").`,
      };
    }
    const content = String(o.content ?? '');
    if (content.length > MAX_FILE_CHARS) {
      return { ok: false, error: 'file_too_long', hint: `file_ops[${i}] (${path}) exceeds ${MAX_FILE_CHARS} chars.` };
    }
    map.set(path, content);
  }

  if (map.size > MAX_PROJECT_FILES) {
    return { ok: false, error: 'too_many_files', hint: `Projects support up to ${MAX_PROJECT_FILES} files.` };
  }
  let total = 0;
  for (const c of map.values()) total += c.length;
  if (total > MAX_PROJECT_CHARS) {
    return { ok: false, error: 'project_too_large', hint: `Total project source exceeds ${MAX_PROJECT_CHARS} chars.` };
  }
  if (!map.size) {
    return { ok: false, error: 'empty_project', hint: 'Project has no files left after file_ops.' };
  }
  return { ok: true, files: map, ops_applied: list.length };
}

/** Normalize coding todos for persistence on the artifact. */
export function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw.slice(0, 40)) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || `t${out.length + 1}`).slice(0, 64);
    const content = String(t.content || t.text || '').trim().slice(0, 400);
    if (!content) continue;
    let status = String(t.status || 'pending').toLowerCase();
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) status = 'pending';
    out.push({ id, content, status });
  }
  return out;
}

function mustResolve(fromPath, spec, files) {
  const resolved = resolveProjectImport(fromPath, spec, files);
  if (!resolved) {
    throw Object.assign(new Error(`Cannot resolve "${spec}" from ${fromPath}`), {
      code: 'unresolved_import',
      from: fromPath,
      spec,
    });
  }
  return resolved;
}

function defaultFromRequire(resolvedJson) {
  return (
    `(function(){ var m = require(${resolvedJson}); ` +
    `return m && (m.__esModule ? m.default : (m.default !== undefined ? m.default : m)); })()`
  );
}

/** Rewrite one file's ESM into a CommonJS-ish factory body. */
function esmToFactoryBody(source, fromPath, files) {
  let src = String(source || '');
  const exportNames = [];
  const namedDefaults = [];

  // import Def, { a } from './x'
  src = src.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
    (full, def, names, spec) => {
      if (!isRelativeImport(spec)) return full;
      const resolved = JSON.stringify(mustResolve(fromPath, spec, files));
      const renamed = String(names).replace(/\s+as\s+/g, ': ');
      return `var ${def} = ${defaultFromRequire(resolved)};\nvar {${renamed}} = require(${resolved});`;
    },
  );

  src = src.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
    (full, name, spec) => {
      if (!isRelativeImport(spec)) return full;
      const resolved = JSON.stringify(mustResolve(fromPath, spec, files));
      return `var ${name} = ${defaultFromRequire(resolved)};`;
    },
  );

  src = src.replace(
    /^[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
    (full, name, spec) => {
      if (!isRelativeImport(spec)) return full;
      const resolved = JSON.stringify(mustResolve(fromPath, spec, files));
      return `var ${name} = require(${resolved});`;
    },
  );

  src = src.replace(
    /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
    (full, names, spec) => {
      if (!isRelativeImport(spec)) return full;
      const resolved = JSON.stringify(mustResolve(fromPath, spec, files));
      const renamed = String(names).replace(/\s+as\s+/g, ': ');
      return `var {${renamed}} = require(${resolved});`;
    },
  );

  src = src.replace(
    /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
    (full, spec) => {
      if (!isRelativeImport(spec)) return full;
      const resolved = JSON.stringify(mustResolve(fromPath, spec, files));
      return `require(${resolved});`;
    },
  );

  // export { a, b as c }
  src = src.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm,
    (_full, names) => {
      const parts = String(names).split(',').map((p) => p.trim()).filter(Boolean);
      return parts.map((p) => {
        const m = p.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!m) return '';
        const local = m[1];
        const exported = m[2] || m[1];
        exportNames.push(exported);
        return `exports.${exported} = ${local};`;
      }).join('\n');
    },
  );

  // export default function Name / class Name
  src = src.replace(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/g, (_m, name) => {
    namedDefaults.push(name);
    return `function ${name}`;
  });
  src = src.replace(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/g, (_m, name) => {
    namedDefaults.push(name);
    return `class ${name}`;
  });
  src = src.replace(/export\s+default\s+/g, 'exports.default = ');

  // export function/class/const
  src = src.replace(
    /^([ \t]*)export\s+(function)\s+([A-Za-z_$][\w$]*)/gm,
    (_full, indent, _kw, name) => {
      exportNames.push(name);
      return `${indent}function ${name}`;
    },
  );
  src = src.replace(
    /^([ \t]*)export\s+(class)\s+([A-Za-z_$][\w$]*)/gm,
    (_full, indent, _kw, name) => {
      exportNames.push(name);
      return `${indent}class ${name}`;
    },
  );
  src = src.replace(
    /^([ \t]*)export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)(\s*=)/gm,
    (_full, indent, kw, name, eq) => {
      exportNames.push(name);
      return `${indent}${kw} ${name}${eq}`;
    },
  );

  const trail = [];
  for (const n of exportNames.filter((x, i, a) => a.indexOf(x) === i)) {
    trail.push(`exports.${n} = ${n};`);
  }
  for (const n of namedDefaults) {
    trail.push(`exports.default = ${n};`);
  }

  return `${src}\nexports.__esModule = true;\n${trail.join('\n')}\n`;
}

/** Collect all files reachable from entry via relative imports. */
export function collectReachableFiles(files, entry) {
  const map = files instanceof Map ? files : new Map(Object.entries(files || {}));
  const entryPath = resolveEntry(map, entry);
  if (!entryPath) return { ok: false, error: 'no_entry', hint: 'Project has no entry file (App.jsx).' };

  const reachable = new Set();
  const queue = [entryPath];
  const importRe =
    /import\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]|export\s+[^'"\n]*?\s+from\s+['"]([^'"]+)['"]/g;

  while (queue.length) {
    const path = queue.pop();
    if (reachable.has(path)) continue;
    if (!map.has(path)) {
      return {
        ok: false,
        error: 'missing_file',
        hint: `Entry/import references missing file: ${path}`,
        path,
      };
    }
    reachable.add(path);
    const src = String(map.get(path) || '');
    let m;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src))) {
      const spec = m[1] || m[2];
      if (!isRelativeImport(spec)) continue;
      const resolved = resolveProjectImport(path, spec, map);
      if (!resolved) {
        return {
          ok: false,
          error: 'unresolved_import',
          hint: `Cannot resolve "${spec}" from ${path}. Add that file or fix the path.`,
          from: path,
          spec,
        };
      }
      if (!reachable.has(resolved)) queue.push(resolved);
    }
  }

  return { ok: true, entry: entryPath, reachable: [...reachable] };
}

/**
 * Bundle a multi-file project into one source string for the React runner.
 * Returns { ok, code, entry, file_count, files_used } or an error object.
 */
export function bundleCodeProject(files, entryHint) {
  const normalized = files instanceof Map
    ? { ok: true, files }
    : normalizeProjectFiles(files);
  if (!normalized.ok) return normalized;

  const map = normalized.files;
  if (!map.size) {
    return { ok: false, error: 'empty_project', hint: 'Pass at least one file in `files`.' };
  }

  const reach = collectReachableFiles(map, entryHint);
  if (!reach.ok) return reach;

  const { entry, reachable } = reach;
  const factories = [];

  try {
    for (const path of reachable) {
      const body = esmToFactoryBody(map.get(path), path, map);
      factories.push(
        `__lyknMod[${JSON.stringify(path)}] = function(exports, require, module) {\n${body}\n};`,
      );
    }
  } catch (err) {
    if (err?.code === 'unresolved_import') {
      return {
        ok: false,
        error: 'unresolved_import',
        hint: `Cannot resolve "${err.spec}" from ${err.from}. Add that file or fix the path.`,
        from: err.from,
        spec: err.spec,
      };
    }
    return { ok: false, error: 'bundle_failed', hint: err?.message || String(err) };
  }

  const code = [
    '// LYKN multi-file artifact bundle — edit source files via the tool, not this bundle.',
    'var __lyknMod = Object.create(null);',
    'var __lyknCache = Object.create(null);',
    'function __lyknRequire(id) {',
    '  if (__lyknCache[id]) return __lyknCache[id].exports;',
    '  var mod = { exports: {} };',
    '  __lyknCache[id] = mod;',
    '  var factory = __lyknMod[id];',
    '  if (typeof factory !== "function") throw new Error("Unknown module: " + id);',
    '  factory(mod.exports, __lyknRequire, mod);',
    '  return mod.exports;',
    '}',
    factories.join('\n'),
    `var __lyknEntry = __lyknRequire(${JSON.stringify(entry)});`,
    'window.__lyknArtifactDefault =',
    '  (__lyknEntry && (__lyknEntry.default || __lyknEntry.App)) ||',
    '  (typeof __lyknEntry === "function" ? __lyknEntry : null);',
  ].join('\n');

  return {
    ok: true,
    code,
    entry,
    file_count: reachable.length,
    files_used: reachable,
  };
}

/** Concatenate all file contents for lib detection (three.js, Tone, …). */
export function projectSourceForLibDetect(files) {
  const map = files instanceof Map ? files : new Map(Object.entries(files || {}));
  let out = '';
  for (const [path, content] of map) {
    out += `\n/* ${path} */\n${content}\n`;
  }
  return out;
}
