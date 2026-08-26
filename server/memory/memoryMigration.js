// ============================================================================
// server/memory/memoryMigration.js — read-only legacy retirement compatibility
// ============================================================================
// Imports TRUSTWORTHY personal memory from lykn_user_model_facts (+ optional
// display name) into Markdown documents. This is NOT a dump of the Synthesis
// graph. Excluded on purpose: inferred/pending/dismissed facts, beliefs,
// rules, concepts, neurons, related-neighborhood, synthesis narrative/themes,
// and anything originating as external content.
//
// Idempotent: re-running never duplicates a fact line already present.
// Conflict: never overwrites existing Markdown — only appends missing lines.
// Archived documents are left archived (the user already forgot them).
// Provenance: every write uses source_type = 'migration'.

import { createMemoryDocument, patchMemoryDocument } from './memoryWriter.js';

/** Statuses that mean the user authored or ratified the fact. */
export const TRUSTED_FACT_STATUSES = Object.freeze(['stated', 'confirmed', 'corrected']);

/**
 * fact_kind → logical memory path. Kinds not listed here are excluded.
 * @type {Readonly<Record<string, string>>}
 */
export const FACT_KIND_TO_PATH = Object.freeze({
  identity: 'profile.md',
  focus: 'profile.md',
  theme: 'profile.md',
  preference: 'preferences.md',
  style: 'preferences.md',
  constraint: 'preferences.md',
  goal: 'goals.md',
  relationship: 'relationships.md',
});

/** Heading used when grouping migrated facts inside a document. */
export const FACT_KIND_TO_SECTION = Object.freeze({
  identity: 'Identity',
  focus: 'Focus',
  theme: 'Themes',
  preference: 'Preferences',
  style: 'Style',
  constraint: 'Constraints',
  goal: 'Goals',
  relationship: 'Relationships',
});

const TRUSTED_STATUS_SET = new Set(TRUSTED_FACT_STATUSES);

/**
 * @param {object} fact
 * @returns {boolean}
 */
export function isTrustworthyLegacyFact(fact) {
  if (!fact || typeof fact !== 'object') return false;
  if (!TRUSTED_STATUS_SET.has(String(fact.status || ''))) return false;
  if (fact.pending_confirm === true) return false;
  const text = String(fact.fact_text || '').trim();
  return text.length >= 3;
}

/**
 * @param {string} markdown
 * @param {string} factText
 */
export function documentHasFactText(markdown, factText) {
  const needle = String(factText || '').trim();
  if (!needle) return false;
  return String(markdown || '').includes(needle);
}

function factBullet(text) {
  return `- ${String(text).trim()}`;
}

/**
 * Group trustworthy facts onto target paths, dropping everything else.
 * @param {object[]} facts
 * @returns {Map<string, Array<{ fact: object, section: string, line: string }>>}
 */
export function groupTrustworthyFactsByPath(facts) {
  const groups = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!isTrustworthyLegacyFact(fact)) continue;
    const path = FACT_KIND_TO_PATH[fact.fact_kind];
    const section = FACT_KIND_TO_SECTION[fact.fact_kind];
    if (!path || !section) continue;
    const line = factBullet(fact.fact_text);
    const list = groups.get(path) || [];
    list.push({ fact, section, line });
    groups.set(path, list);
  }
  return groups;
}

function buildDocumentMarkdown(items) {
  const bySection = new Map();
  for (const item of items) {
    const arr = bySection.get(item.section) || [];
    if (!arr.some((existing) => existing.line === item.line)) arr.push(item);
    bySection.set(item.section, arr);
  }
  const parts = [];
  for (const [section, rows] of bySection) {
    parts.push(`## ${section}\n\n${rows.map((r) => r.line).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

const migratedUsers = new Set();

/** Test-only: forget the in-process "already migrated" gate. */
export function resetMemoryMigrationCache() {
  migratedUsers.clear();
}

/**
 * The only remaining application read of the retired personal-memory tables.
 * This deliberately bypasses the removed user-model service and selects only
 * fields needed by the conservative importer.
 */
export async function loadTrustedLegacyFacts(client, userId) {
  if (!client || !userId) return [];
  const { data, error } = await client
    .from('lykn_user_model_facts')
    .select('id, fact_kind, fact_text, status, pending_confirm')
    .eq('user_id', userId)
    .in('status', TRUSTED_FACT_STATUSES)
    .eq('pending_confirm', false)
    .limit(500);
  if (error) throw new Error(`legacy_memory_read_failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Apply a conservative migration into the Memory store.
 * Safe to call more than once; never overwrites existing document text.
 *
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {{ facts?: object[], displayName?: string }} [payload]
 */
export async function migrateUserMemory(store, userId, { facts = [], displayName = '' } = {}) {
  if (!store || !userId) return { ok: false, error: 'user_required' };

  const groups = groupTrustworthyFactsByPath(facts);
  const name = String(displayName || '').trim();
  if (name) {
    const identityLine = `- The user goes by ${name}.`;
    const profile = groups.get('profile.md') || [];
    if (!profile.some((item) => item.line === identityLine)) {
      profile.unshift({
        fact: { id: 'identity-display-name', fact_kind: 'identity', fact_text: `The user goes by ${name}.`, status: 'stated' },
        section: 'Identity',
        line: identityLine,
      });
      groups.set('profile.md', profile);
    }
  }

  let created = 0;
  let patched = 0;
  let skippedFacts = 0;
  let skippedDocs = 0;
  const paths = [];

  for (const [path, items] of groups) {
    const existing = await store.getDocument(userId, path, { includeArchived: true });
    if (existing && existing.status === 'archived') {
      skippedDocs += 1;
      skippedFacts += items.length;
      continue;
    }

    const missing = items.filter((item) => !documentHasFactText(existing?.markdown || '', item.fact.fact_text));
    skippedFacts += items.length - missing.length;
    if (!missing.length) {
      skippedDocs += 1;
      continue;
    }

    const migratedFactIds = missing.map((item) => item.fact.id).filter(Boolean);
    const meta = { migratedFactIds, factCount: missing.length };

    if (!existing) {
      const createdDoc = await createMemoryDocument(store, userId, {
        path,
        markdown: buildDocumentMarkdown(missing),
        sourceType: 'migration',
        meta,
      });
      if (!createdDoc.ok) {
        if (createdDoc.error === 'path_already_exists') {
          skippedDocs += 1;
          continue;
        }
        return { ok: false, error: createdDoc.error, created, patched, skippedFacts };
      }
      created += 1;
      paths.push(path);
      continue;
    }

    // Existing document: append missing bullets per section. Never replace.
    const bySection = new Map();
    for (const item of missing) {
      const arr = bySection.get(item.section) || [];
      arr.push(item.line);
      bySection.set(item.section, arr);
    }
    let last = existing;
    for (const [section, lines] of bySection) {
      const out = await patchMemoryDocument(store, userId, {
        path,
        patch: { op: 'append_section', section, text: lines.join('\n') },
        sourceType: 'migration',
        expectedVersion: last.version,
        meta,
      });
      if (!out.ok) return { ok: false, error: out.error, created, patched, skippedFacts };
      last = out.document;
    }
    patched += 1;
    paths.push(path);
  }

  return {
    ok: true,
    created,
    patched,
    skippedFacts,
    skippedDocs,
    paths,
    factCount: [...groups.values()].reduce((n, items) => n + items.length, 0),
  };
}

/**
 * Process-lifetime gate around migrateUserMemory so Chat turns do not
 * re-read the legacy facts table after the first successful pass.
 *
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {{ client?: object, listFacts?: () => Promise<object[]>, displayName?: string }} load
 */
export async function ensureLegacyMemoryMigrated(store, userId, load) {
  if (!store || !userId) return { ok: true, skipped: true, reason: 'no_user' };
  if (migratedUsers.has(userId)) return { ok: true, skipped: true, reason: 'already_migrated' };
  let facts = [];
  try {
    facts = typeof load?.listFacts === 'function'
      ? await load.listFacts()
      : await loadTrustedLegacyFacts(load?.client, userId);
  } catch (e) {
    return { ok: false, error: e?.message || 'list_facts_failed' };
  }
  const result = await migrateUserMemory(store, userId, {
    facts,
    displayName: load.displayName,
  });
  if (result.ok) {
    migratedUsers.add(userId);
    console.log(
      `[memory:migration] user=${String(userId).slice(0, 8)} ` +
        `facts=${result.factCount} created=${result.created} patched=${result.patched} ` +
        `skipped=${result.skippedFacts}`,
    );
  }
  return result;
}
