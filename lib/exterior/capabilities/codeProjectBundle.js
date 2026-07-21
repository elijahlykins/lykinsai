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

/**
 * Apply path-scoped find/replace edits.
 * Each edit: { path?, find, replace }. Missing path → entry (or sole file).
 */
export function applyProjectEdits(files, edits, entry) {
  const map = new Map(files instanceof Map ? files : Object.entries(files || {}));
  const list = Array.isArray(edits) ? edits.filter((e) => e && typeof e === 'object') : [];
  if (!list.length) return { ok: true, files: map, edits_applied: 0 };

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const find = String(e.find ?? '');
    const replace = String(e.replace ?? '');
    if (!find) {
      return {
        ok: false,
        error: 'edit_missing_find',
        hint: `edits[${i}] has an empty \`find\`.`,
      };
    }
    let path = normalizeProjectPath(e.path || '');
    if (!path) {
      path = entry || resolveEntry(map, null);
    }
    if (!path || !map.has(path)) {
      return {
        ok: false,
        error: 'edit_path_not_found',
        hint:
          `edits[${i}]: path "${e.path || '(entry)'}" is not in the project. ` +
          `Known files: ${[...map.keys()].slice(0, 20).join(', ')}.`,
      };
    }
    let code = String(map.get(path) ?? '');
    const firstIdx = code.indexOf(find);
    if (firstIdx === -1) {
      return {
        ok: false,
        error: 'edit_target_not_found',
        hint:
          `edits[${i}] in ${path}: \`find\` did not match. ` +
          `Snippet starts with: ${JSON.stringify(find.slice(0, 120))}. ` +
          'Copy EXACTLY from [ARTIFACT_OPEN] (include path).',
      };
    }
    if (code.indexOf(find, firstIdx + 1) !== -1) {
      return {
        ok: false,
        error: 'edit_target_ambiguous',
        hint: `edits[${i}] in ${path}: \`find\` matches more than once — include more context.`,
      };
    }
    code = code.slice(0, firstIdx) + replace + code.slice(firstIdx + find.length);
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
