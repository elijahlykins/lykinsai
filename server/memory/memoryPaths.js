// ============================================================================
// server/memory/memoryPaths.js — logical memory path validation
// ============================================================================
// Memory documents are DATABASE-BACKED, addressed by logical Markdown paths.
// This module is the single validator between anything path-shaped the model
// (or a client) produces and the store. Nothing here ever touches a
// filesystem — "path" is purely a logical identifier — but we still treat
// traversal and namespace escape as attacks, because the path IS the lookup
// key and a crafted key must never resolve outside the memory namespace.

import { MEMORY_PATH_MAX_CHARS } from './memoryConfig.js';

/**
 * Built-in logical memories. These are the only root-level paths that can
 * exist; everything else must live under a dynamic namespace below.
 * @type {Readonly<Record<string, { type: string, name: string, description: string }>>}
 */
export const MEMORY_BUILT_IN_PATHS = Object.freeze({
  'profile.md': {
    type: 'profile',
    name: 'Profile',
    description: 'Who the user is: identity, role, background, durable facts.',
  },
  'preferences.md': {
    type: 'preferences',
    name: 'Preferences',
    description: 'How the user likes things done: style, tools, formats, tone.',
  },
  'goals.md': {
    type: 'goals',
    name: 'Goals',
    description: 'What the user is working toward, short and long term.',
  },
  'decisions.md': {
    type: 'decisions',
    name: 'Decisions',
    description: 'Durable decisions the user has made and their rationale.',
  },
  'relationships.md': {
    type: 'relationships',
    name: 'Relationships',
    description: 'People and organizations that matter to the user.',
  },
});

/**
 * Dynamic namespaces: `projects/<slug>.md`, `topics/<slug>.md`.
 * @type {Readonly<Record<string, string>>} namespace directory → memory type
 */
export const MEMORY_DYNAMIC_NAMESPACES = Object.freeze({
  projects: 'project',
  topics: 'topic',
});

// A slug segment: lowercase alphanumerics and single hyphens, 1–64 chars,
// no leading/trailing hyphen. Deliberately ASCII-only — logical keys, not prose.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Normalize a raw path-ish string into canonical form, or return null when
 * it cannot be made safe. Normalization is conservative: lowercase, trim,
 * strip a single leading "./" — anything smelling of traversal or foreign
 * separators is rejected rather than repaired.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeMemoryPath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().toLowerCase();
  if (p.startsWith('./')) p = p.slice(2);
  if (!p || p.length > MEMORY_PATH_MAX_CHARS) return null;
  // Reject rather than sanitize: backslashes, whitespace, control chars,
  // absolute paths, empty segments, dot segments, non-ASCII.
  if (/[\\\s]/.test(p)) return null;
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  if (/[^a-z0-9\-/.]/.test(p)) return null;
  if (p.startsWith('/') || p.includes('//')) return null;
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return p;
}

/**
 * Validate a logical memory path and classify it.
 * @param {unknown} raw
 * @returns {{ ok: true, path: string, kind: 'builtin'|'dynamic', type: string,
 *             namespace: string|null, slug: string|null,
 *             builtin: { name: string, description: string }|null }
 *          | { ok: false, error: string }}
 */
export function parseMemoryPath(raw) {
  const path = normalizeMemoryPath(raw);
  if (!path) return { ok: false, error: 'invalid_path' };
  if (!path.endsWith('.md')) return { ok: false, error: 'invalid_path' };

  const builtin = MEMORY_BUILT_IN_PATHS[path];
  if (builtin) {
    return {
      ok: true,
      path,
      kind: 'builtin',
      type: builtin.type,
      namespace: null,
      slug: null,
      builtin: { name: builtin.name, description: builtin.description },
    };
  }

  const segments = path.split('/');
  if (segments.length !== 2) return { ok: false, error: 'unknown_memory_path' };
  const [namespace, file] = segments;
  const type = MEMORY_DYNAMIC_NAMESPACES[namespace];
  if (!type) return { ok: false, error: 'unknown_memory_path' };
  const slug = file.slice(0, -3); // strip ".md"
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'invalid_slug' };
  return { ok: true, path, kind: 'dynamic', type, namespace, slug, builtin: null };
}

/**
 * True when the string is a valid slug for a dynamic memory.
 * @param {unknown} slug
 */
export function isValidMemorySlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}
