// =====================================================================
// scripts/backfill-concepts.mjs — one-shot promotion of existing
// themes / tags into first-class lykn_concepts rows.
// =====================================================================
//
// Stage 2 substrate: before the nightly conceptsJob has had a chance
// to run, give every user a baseline of concepts from data that
// already exists. Three sources:
//
//   1. lykn_user_synthesis_profile.themes — TEXT[] of short labels
//      the profile-refresh LLM already chose. These are the highest-
//      signal concepts the user has; promote every entry as a
//      `promoted_from_theme` concept with status='active'.
//
//   2. notes.tags — TEXT[] per note, with the existing
//      vault_tag_counts RPC aggregating per-user counts. Promote
//      any tag with count >= MIN_TAG_COUNT as a `promoted_from_tag`
//      concept with status='active'. Below the threshold, tags
//      stay as bare strings; the nightly job's clustering pass
//      can still promote them if they cluster with other content.
//
//   3. notes.ai_signals.themes — per-note JSONB themes the enrich
//      pass already extracts. We DON'T mint concepts from these
//      here (too noisy) but we DO link the existing per-note theme
//      strings to concepts whose slug matches. That keeps the
//      backfill conservative: concepts come from themes/tags, links
//      come from everywhere.
//
// After minting concepts, we populate concept_notes for every
// matching (note.tags ∈ concept slugs) and (note.ai_signals.themes
// ∈ concept slugs) pair, then populate concept_facts for facts
// whose fact_kind='theme' and fact_text matches a concept slug.
//
// Idempotent: re-running the script is safe. Concept upserts go
// through the (user_id, slug) unique index where merged_into_id IS
// NULL; join-row inserts use ON CONFLICT DO NOTHING.
//
// Usage:
//   node scripts/backfill-concepts.mjs                    # all users
//   node scripts/backfill-concepts.mjs --user <user_id>   # single user
//   node scripts/backfill-concepts.mjs --dry-run          # plan only
//   node scripts/backfill-concepts.mjs --min-tag-count 5  # raise threshold

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embedConceptLabel, conceptSlug } from '../conceptEmbedding.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const has = (name) => args.includes(name);

const SINGLE_USER = flag('--user');
const DRY_RUN = has('--dry-run');
const MIN_TAG_COUNT = parseInt(flag('--min-tag-count') || '3', 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ backfill-concepts: missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----------------------------------------------------------------------
// 1. Discover users to backfill
// ----------------------------------------------------------------------
async function loadUserIds() {
  if (SINGLE_USER) return [SINGLE_USER];

  // Any user with either a synthesis profile (themes) or notes with
  // tags is eligible. Pull both sets and union.
  const ids = new Set();

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await admin
      .from('lykn_user_synthesis_profile')
      .select('user_id, themes')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      if (row.user_id && Array.isArray(row.themes) && row.themes.length) {
        ids.add(row.user_id);
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  from = 0;
  while (true) {
    const { data, error } = await admin
      .from('vault_items')
      .select('user_id')
      .not('tags', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      if (row.user_id) ids.add(row.user_id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return Array.from(ids);
}

// ----------------------------------------------------------------------
// 2. Mint concepts for a single user
// ----------------------------------------------------------------------
async function backfillUser(userId) {
  const summary = {
    user_id: userId,
    themes_seen: 0,
    tags_seen: 0,
    concepts_upserted: 0,
    concepts_embedded: 0,
    note_links: 0,
    fact_links: 0,
    errors: 0,
  };

  // ---- profile.themes -----------------------------------------------
  const { data: profileRow } = await admin
    .from('lykn_user_synthesis_profile')
    .select('themes')
    .eq('user_id', userId)
    .maybeSingle();

  const themeLabels = Array.isArray(profileRow?.themes) ? profileRow.themes : [];
  summary.themes_seen = themeLabels.length;

  // ---- notes.tags via vault_tag_counts ------------------------------
  // The RPC is auth.uid()-scoped (security definer + auth.uid() filter),
  // which won't work with the service-role client. So we replicate the
  // aggregation here in JS — pull every note's tags and count.
  const tagCounts = new Map();
  {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await admin
        .from('vault_items')
        .select('id, tags')
        .eq('user_id', userId)
        .not('tags', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const n of data) {
        for (const t of n.tags || []) {
          const key = conceptSlug(t);
          if (!key) continue;
          tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  summary.tags_seen = tagCounts.size;

  // ---- Build concept candidates -------------------------------------
  // Map of slug -> { label, source, kind }. Themes win over tags on
  // conflict (more curated) but both go through the same upsert.
  const candidates = new Map();
  for (const t of themeLabels) {
    const slug = conceptSlug(t);
    if (!slug) continue;
    candidates.set(slug, {
      label: String(t).trim().slice(0, 128),
      source: 'promoted_from_theme',
      kind: 'theme',
    });
  }
  for (const [slug, count] of tagCounts.entries()) {
    if (count < MIN_TAG_COUNT) continue;
    if (candidates.has(slug)) continue; // theme wins
    candidates.set(slug, {
      label: slug.slice(0, 128),
      source: 'promoted_from_tag',
      kind: 'topic',
    });
  }

  if (DRY_RUN) {
    console.log(`[dry-run] ${userId}: ${candidates.size} concepts to mint (themes=${themeLabels.length}, tags>=${MIN_TAG_COUNT}=${[...tagCounts.values()].filter((c) => c >= MIN_TAG_COUNT).length})`);
    return summary;
  }

  // ---- Upsert concepts ---------------------------------------------
  // We rely on the partial unique index (user_id, slug) WHERE
  // merged_into_id IS NULL — re-runs find existing rows and bump
  // last_touched_at via an UPDATE, fresh rows insert.
  const slugToId = new Map();
  for (const [slug, c] of candidates.entries()) {
    const { data: existing } = await admin
      .from('lykn_concepts')
      .select('id, embedding')
      .eq('user_id', userId)
      .eq('slug', slug)
      .is('merged_into_id', null)
      .maybeSingle();

    let conceptId;
    let needsEmbedding;
    if (existing?.id) {
      conceptId = existing.id;
      needsEmbedding = !existing.embedding;
      await admin
        .from('lykn_concepts')
        .update({ last_touched_at: new Date().toISOString() })
        .eq('id', conceptId);
    } else {
      const { data: inserted, error: insErr } = await admin
        .from('lykn_concepts')
        .insert({
          user_id: userId,
          label: c.label,
          slug,
          kind: c.kind,
          source: c.source,
          status: 'active', // backfilled rows skip 'proposed' — user authored these
          confidence: 1.0,
        })
        .select('id')
        .single();
      if (insErr) {
        console.warn(`⚠️ insert concept failed for ${userId}/${slug}:`, insErr.message);
        summary.errors += 1;
        continue;
      }
      conceptId = inserted.id;
      needsEmbedding = true;
      summary.concepts_upserted += 1;
    }
    slugToId.set(slug, conceptId);

    if (needsEmbedding) {
      const emb = await embedConceptLabel(c.label, { userId });
      if (emb) {
        await admin
          .from('lykn_concepts')
          .update({
            embedding: emb,
            embedded_at: new Date().toISOString(),
          })
          .eq('id', conceptId);
        summary.concepts_embedded += 1;
      }
    }
  }

  // ---- Populate concept_notes from tags + ai_signals.themes --------
  // Pull notes once and walk their tags + ai_signals.themes against
  // our concept slug map.
  {
    let from = 0;
    const PAGE = 500;
    const upserts = [];
    while (true) {
      const { data, error } = await admin
        .from('vault_items')
        .select('id, tags, ai_signals')
        .eq('user_id', userId)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;

      for (const n of data) {
        for (const t of n.tags || []) {
          const slug = conceptSlug(t);
          const cid = slugToId.get(slug);
          if (cid) {
            upserts.push({
              user_id: userId,
              concept_id: cid,
              note_id: n.id,
              weight: 1.0,
              source: 'tag',
            });
          }
        }
        const sig = n.ai_signals && typeof n.ai_signals === 'object' ? n.ai_signals : null;
        const themes = Array.isArray(sig?.themes) ? sig.themes : [];
        for (const t of themes) {
          const slug = conceptSlug(t);
          const cid = slugToId.get(slug);
          if (cid) {
            upserts.push({
              user_id: userId,
              concept_id: cid,
              note_id: n.id,
              weight: 0.8,
              source: 'ai_signal_theme',
            });
          }
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (upserts.length) {
      // Batch up to avoid huge payloads; ON CONFLICT DO NOTHING via
      // the unique constraint (user_id, concept_id, note_id).
      const BATCH = 500;
      for (let i = 0; i < upserts.length; i += BATCH) {
        const chunk = upserts.slice(i, i + BATCH);
        const { error: upErr } = await admin
          .from('concept_notes')
          .upsert(chunk, { onConflict: 'user_id,concept_id,note_id', ignoreDuplicates: true });
        if (upErr) {
          console.warn(`⚠️ concept_notes upsert (${userId}):`, upErr.message);
          summary.errors += 1;
        } else {
          summary.note_links += chunk.length;
        }
      }
    }
  }

  // ---- Populate concept_facts from fact_kind='theme' ---------------
  {
    const { data: themeFacts, error: fErr } = await admin
      .from('lykn_user_model_facts')
      .select('id, fact_text')
      .eq('user_id', userId)
      .eq('fact_kind', 'theme')
      .in('status', ['stated', 'inferred', 'confirmed']);
    if (fErr) {
      console.warn(`⚠️ theme facts pull (${userId}):`, fErr.message);
      summary.errors += 1;
    } else if (themeFacts?.length) {
      const upserts = [];
      for (const f of themeFacts) {
        const slug = conceptSlug(f.fact_text);
        const cid = slugToId.get(slug);
        if (cid) {
          upserts.push({
            user_id: userId,
            concept_id: cid,
            fact_id: f.id,
            weight: 1.0,
            source: 'embedding_similarity',
          });
        }
      }
      if (upserts.length) {
        const { error: upErr } = await admin
          .from('concept_facts')
          .upsert(upserts, { onConflict: 'user_id,concept_id,fact_id', ignoreDuplicates: true });
        if (upErr) {
          console.warn(`⚠️ concept_facts upsert (${userId}):`, upErr.message);
          summary.errors += 1;
        } else {
          summary.fact_links += upserts.length;
        }
      }
    }
  }

  console.log(
    `✅ ${userId}: themes=${summary.themes_seen} tags=${summary.tags_seen} → concepts +${summary.concepts_upserted} (embed +${summary.concepts_embedded}) note_links=${summary.note_links} fact_links=${summary.fact_links} errors=${summary.errors}`,
  );
  return summary;
}

// ----------------------------------------------------------------------
// 3. Main
// ----------------------------------------------------------------------
(async () => {
  const startedAt = Date.now();
  console.log(`🌱 backfill-concepts: starting (dry-run=${DRY_RUN}, min-tag-count=${MIN_TAG_COUNT})`);

  const userIds = await loadUserIds();
  console.log(`🌱 backfill-concepts: ${userIds.length} users eligible`);

  const totals = { concepts: 0, note_links: 0, fact_links: 0, errors: 0 };
  for (const uid of userIds) {
    try {
      const s = await backfillUser(uid);
      totals.concepts += s.concepts_upserted;
      totals.note_links += s.note_links;
      totals.fact_links += s.fact_links;
      totals.errors += s.errors;
    } catch (e) {
      console.error(`❌ ${uid}:`, e?.stack || e?.message || e);
      totals.errors += 1;
    }
  }

  const duration = Date.now() - startedAt;
  console.log(
    `🌱 backfill-concepts: done. users=${userIds.length} concepts=+${totals.concepts} note_links=+${totals.note_links} fact_links=+${totals.fact_links} errors=${totals.errors} ${duration}ms`,
  );
  process.exit(totals.errors > 0 ? 1 : 0);
})();
