// =====================================================================
// jobs/conceptsJob.js — nightly concept clustering pipeline
// =====================================================================
// Sister to jobs/synthesisJob.js. The belief job clusters FACTS to
// propose normative principles. This job clusters CHUNKS (vault
// notes, board content) to propose descriptive CONCEPTS — the
// "topics" the user is touching, named by an LLM, deduped against
// existing concepts via embedding cosine.
//
// Per-user pipeline:
//
//   1. Pull recent embedded chunks for the user from
//      lykn_synthesis_chunks (last 30 days, source_type in
//      'vault_note' or 'grid_board' — conversation_exchange is
//      excluded for now because per-message noise overwhelms
//      cluster naming).
//
//   2. UMAP → 2D, then DBSCAN-style clustering (reused from the
//      belief job).
//
//   3. For each surviving cluster:
//        a. Sample up to MAX_CLUSTER_SAMPLES chunks for the LLM.
//        b. Ask the namer LLM for a 1–3 word concept label.
//        c. Embed the label.
//        d. Cosine-compare to existing user concepts. > 0.85 → attach
//           (use the existing concept_id, don't mint). Else upsert
//           a new lykn_concepts row (source=ai_clustered,
//           status=proposed).
//        e. For every chunk in the cluster, insert a row into the
//           matching join table (concept_notes for vault_note,
//           concept_chats for grid_board).
//
//   4. Embedding-similarity pass over facts and beliefs:
//        - For each fact with an embedding, find concepts whose
//          embedding cosine > 0.80 and insert concept_facts rows.
//        - For each belief, do the same → concept_beliefs.
//        - Also inherit concept_beliefs from concept_facts via
//          belief.promoted_from_facts.
//
//   5. Write a lykn_synthesis_runs row with the concept counters
//      (additive, runs alongside the belief counters).

import { createClient } from '@supabase/supabase-js';
import { computeProjection, cosine } from '../lib/umap.js';
import { clusterPoints, groupByLabel } from '../lib/hdbscan.js';
import { embedConceptLabel, conceptSlug } from '../conceptEmbedding.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const NAMER_MODEL = 'claude-3-5-haiku-latest';
const NAMER_MAX_TOKENS = 64;

const MIN_CHUNKS_TO_RUN = 8;
const RECENT_DAYS = 30;
const MAX_CLUSTER_SAMPLES = 6;

// Cosine thresholds. Mirrors the belief job's choices.
const DEDUP_COSINE = 0.85;     // cluster name vs existing concept
const FACT_LINK_COSINE = 0.78; // fact embedding vs concept embedding
const BELIEF_LINK_COSINE = 0.78;

function buildAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('conceptsJob: missing SUPABASE_URL / SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Entry: run concept clustering for every eligible user.
 * Returns per-user summaries.
 */
export async function runConceptsForAllUsers({ trigger = 'cron' } = {}) {
  const admin = buildAdminClient();
  const userIds = await loadEligibleUserIds(admin);
  console.log(`🧩 conceptsJob: ${userIds.length} eligible users`);

  const summaries = [];
  for (const uid of userIds) {
    try {
      const s = await runConceptsForUser(admin, uid, { trigger });
      summaries.push({ user_id: uid, ...s });
    } catch (err) {
      console.error(`❌ conceptsJob[${uid}]:`, err?.stack || err?.message || err);
      summaries.push({ user_id: uid, error: err?.message || String(err) });
    }
  }
  return summaries;
}

async function loadEligibleUserIds(admin) {
  // Same shape as synthesisJob.loadEligibleUserIds — group by user
  // in JS because PostgREST doesn't expose GROUP BY.
  const ids = new Map();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await admin
      .from('lykn_synthesis_chunks')
      .select('user_id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      ids.set(row.user_id, (ids.get(row.user_id) || 0) + 1);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return Array.from(ids.entries())
    .filter(([, c]) => c >= MIN_CHUNKS_TO_RUN)
    .map(([uid]) => uid);
}

export async function runConceptsForUser(admin, userId, { trigger = 'cron' } = {}) {
  const startedAt = Date.now();
  const counters = {
    concepts_clusters_found: 0,
    concepts_candidates: 0,
    concepts_proposed: 0,
    concepts_attached: 0,
    concepts_skipped_duplicate: 0,
    concepts_skipped_threshold: 0,
    concepts_links_written: 0,
    concepts_error_count: 0,
  };
  const details = { concepts: { clusters: [], proposals: [], attachments: [], errors: [] } };

  // ---- 1. Pull recent embedded chunks -------------------------------
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: chunks, error: chunksErr } = await admin
    .from('lykn_synthesis_chunks')
    .select('id, source_type, source_id, content, embedding, updated_at')
    .eq('user_id', userId)
    .gte('updated_at', cutoff)
    .in('source_type', ['vault_note', 'grid_board']);
  if (chunksErr) throw chunksErr;

  if (!chunks || chunks.length < MIN_CHUNKS_TO_RUN) {
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }

  const vectors = [];
  const validChunks = [];
  for (const c of chunks) {
    const v = parseEmbedding(c.embedding);
    if (v && v.length > 0) {
      vectors.push(v);
      validChunks.push(c);
    }
  }
  if (validChunks.length < MIN_CHUNKS_TO_RUN) {
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }

  // ---- 2. UMAP + DBSCAN ---------------------------------------------
  const coords = computeProjection(vectors, { seed: 42 });
  if (!coords) {
    counters.concepts_error_count += 1;
    details.concepts.errors.push({ stage: 'umap', message: 'projection failed' });
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }
  const labels = clusterPoints(coords, { minPts: 2, minClusterSize: 3 });
  const indexClusters = groupByLabel(labels);
  counters.concepts_clusters_found = indexClusters.length;

  // ---- 3. Existing concepts (for dedup + similarity passes) --------
  const { data: existingConcepts } = await admin
    .from('lykn_concepts')
    .select('id, label, slug, status, embedding')
    .eq('user_id', userId)
    .is('merged_into_id', null);

  const existingByEmbedding = (existingConcepts || [])
    .map((c) => ({ ...c, _vec: parseEmbedding(c.embedding) }))
    .filter((c) => c._vec && c._vec.length > 0);
  const existingBySlug = new Map(
    (existingConcepts || []).map((c) => [c.slug, c]),
  );

  // ---- 4. Per-cluster name + dedup + write -------------------------
  for (let clusterIdx = 0; clusterIdx < indexClusters.length; clusterIdx++) {
    const idxs = indexClusters[clusterIdx];
    if (idxs.length < 3) {
      counters.concepts_skipped_threshold += 1;
      continue;
    }
    counters.concepts_candidates += 1;

    // Centroid for embedding-based dedup
    const clusterVecs = idxs.map((i) => vectors[i]);
    const centroid = mean(clusterVecs);

    // Sample chunks for the namer LLM
    const sampleChunks = pickSamples(idxs, validChunks, MAX_CLUSTER_SAMPLES);

    let label;
    try {
      label = await callNamerModel(sampleChunks);
    } catch (err) {
      counters.concepts_error_count += 1;
      details.concepts.errors.push({
        stage: 'namer',
        cluster_id: clusterIdx,
        message: err?.message || String(err),
      });
      continue;
    }
    if (!label) {
      counters.concepts_skipped_duplicate += 0; // namer said "skip"
      continue;
    }

    const slug = conceptSlug(label);
    if (!slug) continue;

    // ---- 4a. Dedup vs existing concepts ----------------------------
    let attachConceptId = existingBySlug.get(slug)?.id || null;

    if (!attachConceptId) {
      // Embedding dedup: name the label, then cosine vs every
      // existing concept embedding (and the cluster centroid as a
      // back-stop for unembedded concepts).
      const labelEmb = await embedConceptLabel(label, { userId });
      if (labelEmb) {
        let best = { score: 0, id: null };
        for (const ec of existingByEmbedding) {
          const s = cosine(labelEmb, ec._vec);
          if (s > best.score) best = { score: s, id: ec.id };
        }
        if (best.score >= DEDUP_COSINE && best.id) {
          attachConceptId = best.id;
          counters.concepts_skipped_duplicate += 1;
          details.concepts.attachments.push({
            cluster_id: clusterIdx,
            concept_id: best.id,
            score: best.score,
            label,
          });
        } else {
          // Mint a new concept.
          const { data: inserted, error: insErr } = await admin
            .from('lykn_concepts')
            .insert({
              user_id: userId,
              label: label.slice(0, 128),
              slug,
              kind: 'topic',
              source: 'ai_clustered',
              status: 'proposed',
              confidence: 0.6,
              embedding: labelEmb,
              embedded_at: new Date().toISOString(),
              provenance: {
                source: 'synthesis_job',
                cluster_id: clusterIdx,
                chunk_count: idxs.length,
                model: NAMER_MODEL,
                generated_at: new Date().toISOString(),
              },
            })
            .select('id')
            .single();
          if (insErr) {
            counters.concepts_error_count += 1;
            details.concepts.errors.push({
              stage: 'insert_concept',
              cluster_id: clusterIdx,
              message: insErr.message,
            });
            continue;
          }
          attachConceptId = inserted.id;
          counters.concepts_proposed += 1;
          details.concepts.proposals.push({
            cluster_id: clusterIdx,
            concept_id: attachConceptId,
            label,
            chunk_count: idxs.length,
          });
          // Add to local index so subsequent clusters in this run can
          // dedupe against this just-minted concept too.
          existingByEmbedding.push({
            id: attachConceptId,
            slug,
            label,
            _vec: labelEmb,
          });
          existingBySlug.set(slug, { id: attachConceptId, slug, label });
        }
      } else {
        // No embedding (e.g. OPENAI_API_KEY missing). Mint without
        // dedup — better to have a concept than to drop the cluster.
        const { data: inserted, error: insErr } = await admin
          .from('lykn_concepts')
          .insert({
            user_id: userId,
            label: label.slice(0, 128),
            slug,
            kind: 'topic',
            source: 'ai_clustered',
            status: 'proposed',
            confidence: 0.5,
            provenance: {
              source: 'synthesis_job',
              cluster_id: clusterIdx,
              chunk_count: idxs.length,
              model: NAMER_MODEL,
              generated_at: new Date().toISOString(),
            },
          })
          .select('id')
          .single();
        if (insErr) {
          counters.concepts_error_count += 1;
          continue;
        }
        attachConceptId = inserted.id;
        counters.concepts_proposed += 1;
      }
    } else {
      counters.concepts_attached += 1;
    }

    details.concepts.clusters.push({
      id: clusterIdx,
      chunk_count: idxs.length,
      label,
      concept_id: attachConceptId,
    });

    // ---- 4b. Link cluster chunks to the concept --------------------
    const noteLinks = [];
    const chatLinks = [];
    for (const idx of idxs) {
      const c = validChunks[idx];
      const vec = vectors[idx];
      const similarity = clamp01(cosine(vec, centroid));
      if (c.source_type === 'vault_note') {
        noteLinks.push({
          user_id: userId,
          concept_id: attachConceptId,
          note_id: c.source_id,
          weight: similarity,
          source: 'chunk_cluster',
        });
      } else if (c.source_type === 'grid_board') {
        chatLinks.push({
          user_id: userId,
          concept_id: attachConceptId,
          board_id: c.source_id,
          weight: similarity,
          source: 'chunk_cluster',
        });
      }
    }
    if (noteLinks.length) {
      const { error: nErr } = await admin
        .from('concept_notes')
        .upsert(noteLinks, { onConflict: 'user_id,concept_id,note_id', ignoreDuplicates: true });
      if (nErr) {
        counters.concepts_error_count += 1;
      } else {
        counters.concepts_links_written += noteLinks.length;
      }
    }
    if (chatLinks.length) {
      const { error: cErr } = await admin
        .from('concept_chats')
        .upsert(chatLinks, { onConflict: 'user_id,concept_id,board_id', ignoreDuplicates: true });
      if (cErr) {
        counters.concepts_error_count += 1;
      } else {
        counters.concepts_links_written += chatLinks.length;
      }
    }
  }

  // ---- 5. Embedding-similarity pass: facts -> concepts -------------
  // Pull every fact embedding once and link to concepts whose embedding
  // cosine > FACT_LINK_COSINE. Cheap at our scale (≤1k facts, ≤100
  // concepts) and gives the briefing/graph a far richer fact-concept
  // map than just slug matches.
  if (existingByEmbedding.length > 0) {
    const { data: facts } = await admin
      .from('lykn_user_model_facts')
      .select('id, embedding')
      .eq('user_id', userId)
      .not('embedding', 'is', null)
      .in('status', ['stated', 'inferred', 'confirmed']);
    const factLinks = [];
    for (const f of facts || []) {
      const v = parseEmbedding(f.embedding);
      if (!v) continue;
      let best = { score: 0, id: null };
      for (const ec of existingByEmbedding) {
        const s = cosine(v, ec._vec);
        if (s > best.score) best = { score: s, id: ec.id };
      }
      if (best.score >= FACT_LINK_COSINE && best.id) {
        factLinks.push({
          user_id: userId,
          concept_id: best.id,
          fact_id: f.id,
          weight: clamp01(best.score),
          source: 'embedding_similarity',
        });
      }
    }
    if (factLinks.length) {
      const BATCH = 500;
      for (let i = 0; i < factLinks.length; i += BATCH) {
        const { error } = await admin
          .from('concept_facts')
          .upsert(factLinks.slice(i, i + BATCH), {
            onConflict: 'user_id,concept_id,fact_id',
            ignoreDuplicates: true,
          });
        if (!error) counters.concepts_links_written += Math.min(BATCH, factLinks.length - i);
      }
    }

    // ---- 6. beliefs -> concepts (embedding + inheritance) ----------
    const { data: beliefs } = await admin
      .from('lykn_beliefs')
      .select('id, embedding, promoted_from_facts')
      .eq('user_id', userId)
      .in('status', ['proposed', 'active']);

    const beliefLinks = [];
    // 6a. embedding similarity
    for (const b of beliefs || []) {
      const v = parseEmbedding(b.embedding);
      if (v) {
        let best = { score: 0, id: null };
        for (const ec of existingByEmbedding) {
          const s = cosine(v, ec._vec);
          if (s > best.score) best = { score: s, id: ec.id };
        }
        if (best.score >= BELIEF_LINK_COSINE && best.id) {
          beliefLinks.push({
            user_id: userId,
            concept_id: best.id,
            belief_id: b.id,
            weight: clamp01(best.score),
            source: 'embedding_similarity',
          });
        }
      }
    }

    // 6b. inheritance from concept_facts
    // Rebuild the fact→concept map we just wrote so we can inherit.
    if (beliefs?.length) {
      const { data: cfRows } = await admin
        .from('concept_facts')
        .select('concept_id, fact_id')
        .eq('user_id', userId);
      const factToConcept = new Map();
      for (const r of cfRows || []) {
        if (!factToConcept.has(r.fact_id)) factToConcept.set(r.fact_id, new Set());
        factToConcept.get(r.fact_id).add(r.concept_id);
      }
      for (const b of beliefs) {
        const factIds = Array.isArray(b.promoted_from_facts) ? b.promoted_from_facts : [];
        const conceptIds = new Set();
        for (const fid of factIds) {
          const cset = factToConcept.get(fid);
          if (cset) for (const cid of cset) conceptIds.add(cid);
        }
        for (const cid of conceptIds) {
          beliefLinks.push({
            user_id: userId,
            concept_id: cid,
            belief_id: b.id,
            weight: 0.9,
            source: 'inherited_from_fact',
          });
        }
      }
    }

    if (beliefLinks.length) {
      const BATCH = 500;
      for (let i = 0; i < beliefLinks.length; i += BATCH) {
        const { error } = await admin
          .from('concept_beliefs')
          .upsert(beliefLinks.slice(i, i + BATCH), {
            onConflict: 'user_id,concept_id,belief_id',
            ignoreDuplicates: true,
          });
        if (!error) counters.concepts_links_written += Math.min(BATCH, beliefLinks.length - i);
      }
    }
  }

  return finalize(admin, userId, trigger, counters, details, startedAt);
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function parseEmbedding(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mean(vectors) {
  const valid = vectors.filter((v) => Array.isArray(v) && v.length > 0);
  if (valid.length === 0) return [];
  const dim = valid[0].length;
  const out = new Array(dim).fill(0);
  for (const v of valid) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= valid.length;
  return out;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function pickSamples(idxs, chunks, max) {
  if (idxs.length <= max) return idxs.map((i) => chunks[i]);
  // Spread samples across the cluster (start, middle, end) so the LLM
  // sees representative content.
  const step = Math.floor(idxs.length / max);
  const out = [];
  for (let i = 0; i < max; i++) out.push(chunks[idxs[i * step]]);
  return out;
}

async function callNamerModel(sampleChunks) {
  if (!ANTHROPIC_API_KEY) {
    // Without an API key, fall back to a deterministic name: the most
    // common 2-word phrase across the samples. Crude but keeps the
    // pipeline running in dev.
    return fallbackName(sampleChunks);
  }

  const userMessage = buildNamerMessage(sampleChunks);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: NAMER_MODEL,
      max_tokens: NAMER_MAX_TOKENS,
      system: NAMER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`anthropic namer HTTP ${resp.status}: ${errText.slice(0, 160)}`);
  }
  const body = await resp.json();
  const text = (body?.content?.[0]?.text || '').trim();
  if (!text || /^(skip|none|n\/a|null)$/i.test(text)) return null;

  // Strip quotes, periods, and trailing punctuation. Lower-case so
  // slug/label converge.
  const cleaned = text
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .toLowerCase()
    .trim();
  if (!cleaned || cleaned.length > 64) return null;
  // Reject sentence-shaped outputs.
  if (cleaned.split(/\s+/).length > 4) return null;
  return cleaned;
}

const NAMER_SYSTEM_PROMPT = `You are LYKN's concept namer. You see a small cluster of related text excerpts from a user's notes or chats and respond with ONE short noun phrase (1–3 words) that names the topic they share.

Rules:
- 1–3 words. No sentences, no explanations.
- Lowercase. No quotes, no punctuation.
- Concrete topic, not a verb phrase. "fundraising" not "raising money".
- If the excerpts don't share a clear topic, respond with exactly: skip
- Output the name and nothing else.`;

function buildNamerMessage(samples) {
  const lines = samples.map((s, i) => {
    const content = String(s.content || '').replace(/\s+/g, ' ').slice(0, 240).trim();
    return `${i + 1}. ${content}`;
  });
  return [
    `${samples.length} excerpts from a user's recent notes / chats:`,
    '',
    ...lines,
    '',
    'Name the shared topic in 1–3 lowercase words. If nothing coherent, respond: skip',
  ].join('\n');
}

function fallbackName(samples) {
  // Pull the longest content piece's first noun-ish token. Dev-only
  // hack — production runs with ANTHROPIC_API_KEY set.
  const blob = samples.map((s) => s.content || '').join(' ').toLowerCase();
  const tokens = blob.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 4);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

async function finalize(admin, userId, trigger, counters, details, startedAt) {
  const duration = Date.now() - startedAt;
  await admin.from('lykn_synthesis_runs').insert({
    user_id: userId,
    trigger,
    duration_ms: duration,
    ...counters,
    details,
  });
  console.log(
    `🧩 conceptsJob[${userId}]: clusters=${counters.concepts_clusters_found} candidates=${counters.concepts_candidates} proposed=${counters.concepts_proposed} attached=${counters.concepts_attached} links=${counters.concepts_links_written} skipped(dup=${counters.concepts_skipped_duplicate} thresh=${counters.concepts_skipped_threshold}) errors=${counters.concepts_error_count} ${duration}ms`,
  );
  return { ...counters, duration_ms: duration };
}
