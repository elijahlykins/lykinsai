// =====================================================================
// jobs/synthesisJob.js — nightly belief synthesis pipeline
// =====================================================================
// One run per user, scheduled by Render cron @ 3am UTC. Per the spec
// in project state ('next_milestone' as of 2026-05-09 PT):
//
//   1. Pull all facts with embeddings for the user.
//   2. Run UMAP → 2D.
//   3. Run DBSCAN (HDBSCAN substitute, see lib/hdbscan.js for why).
//      min_cluster_size = 2.
//   4. For each cluster, apply threshold rule:
//        single-client clusters → require ≥4 facts
//        multi-client clusters (cardinality(distinct_clients) ≥ 2) → ≥2
//        cross-project clusters (≥2 distinct project_ids)            → ≥3
//   5. Cosine-similarity-dedup against existing lykn_beliefs (>0.85 skip).
//   6. Send qualifying clusters to Claude (via lib/synthesisPrompt.js).
//   7. Write proposed beliefs to lykn_beliefs (status='proposed').
//   8. Log a row to lykn_synthesis_runs with funnel counters + details.
//
// Idempotency: re-running the same night against the same data is a
// no-op for proposals (the cosine-dedup catches them) but creates a
// new lykn_synthesis_runs row. That's intentional — we want every
// invocation visible in the audit log.

import { createClient } from '@supabase/supabase-js';
import { computeProjection, cosine } from '../lib/umap.js';
import { clusterPoints, groupByLabel } from '../lib/hdbscan.js';
import { SYSTEM_PROMPT, buildClusterMessage, validateProposal } from '../lib/synthesisPrompt.js';
import { embedFactText } from '../factEmbedding.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYNTHESIS_MODEL = 'claude-sonnet-4-20250514';
const SYNTHESIS_MAX_TOKENS = 1000;
const DUPLICATE_COSINE_THRESHOLD = 0.85;
const MIN_FACTS_TO_RUN = 5; // skip users with too few embedded facts

/**
 * Build a service-role admin client. The cron runs OUT of any user's
 * auth context, so we use the service-role key and bypass RLS.
 */
function buildAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('synthesisJob: missing SUPABASE_URL / SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Iterate every user with embedded facts and run synthesis for each.
 * Returns a per-user summary array — caller logs/prints.
 */
export async function runSynthesisForAllUsers({ trigger = 'cron' } = {}) {
  const admin = buildAdminClient();

  // Collect distinct user_ids with at least MIN_FACTS_TO_RUN embedded
  // facts. We page in chunks because Supabase REST has a default 1k
  // row limit and at scale this set is unbounded.
  const userIds = await loadEligibleUserIds(admin);
  console.log(`🌙 synthesisJob: ${userIds.length} eligible users`);

  const summaries = [];
  for (const uid of userIds) {
    try {
      const summary = await runSynthesisForUser(admin, uid, { trigger });
      summaries.push({ user_id: uid, ...summary });
    } catch (err) {
      console.error(`❌ synthesisJob[${uid}]:`, err?.stack || err?.message || err);
      summaries.push({ user_id: uid, error: err?.message || String(err) });
    }
  }
  return summaries;
}

async function loadEligibleUserIds(admin) {
  // Pull all (user_id, count) pairs from lykn_user_model_facts where
  // embedding is not null. We can't do GROUP BY directly through
  // PostgREST, so pull user_id columns and count in JS — fine at
  // current scale (< 100k facts total in dev).
  const ids = new Map();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await admin
      .from('lykn_user_model_facts')
      .select('user_id')
      .not('embedding', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      ids.set(row.user_id, (ids.get(row.user_id) || 0) + 1);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return Array.from(ids.entries())
    .filter(([, count]) => count >= MIN_FACTS_TO_RUN)
    .map(([uid]) => uid);
}

/**
 * Per-user pipeline. Returns funnel counters + details payload.
 */
export async function runSynthesisForUser(admin, userId, { trigger = 'cron' } = {}) {
  const startedAt = Date.now();
  const counters = {
    facts_in: 0,
    facts_with_embeddings: 0,
    clusters_found: 0,
    candidates_evaluated: 0,
    proposals_written: 0,
    skipped_duplicate: 0,
    skipped_threshold: 0,
    skipped_model: 0,
    error_count: 0,
  };
  const details = {
    umap_full_recompute: true, // v1: always recompute, no caching yet
    clusters: [],
    proposals: [],
    errors: [],
  };

  // ---- 1. Pull facts ------------------------------------------------
  const { data: facts, error: factsErr } = await admin
    .from('lykn_user_model_facts')
    .select(
      'id, fact_text, fact_kind, embedding, source, observed_by_clients, project_id, status',
    )
    .eq('user_id', userId)
    .in('status', ['stated', 'confirmed'])
    .not('embedding', 'is', null);
  if (factsErr) throw factsErr;
  counters.facts_in = facts?.length || 0;
  counters.facts_with_embeddings = counters.facts_in;
  if (counters.facts_in < MIN_FACTS_TO_RUN) {
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }

  // Project label lookup so the prompt can disambiguate "project A vs B"
  // without using opaque UUIDs that the model can't reason about.
  const projectIds = Array.from(
    new Set(facts.map((f) => f.project_id).filter(Boolean)),
  );
  const projectLabel = await loadProjectLabels(admin, userId, projectIds);

  // ---- 2. UMAP ------------------------------------------------------
  const vectors = facts.map((f) => parseEmbedding(f.embedding));
  const coords = computeProjection(vectors, { seed: 42 });
  if (!coords) {
    counters.error_count += 1;
    details.errors.push({ stage: 'umap', message: 'computeProjection returned null' });
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }

  // ---- 3. DBSCAN ----------------------------------------------------
  const labels = clusterPoints(coords, { minPts: 2, minClusterSize: 2 });
  const indexClusters = groupByLabel(labels);
  counters.clusters_found = indexClusters.length;

  // Materialise each cluster with the full fact rows + provenance summary.
  const clusters = indexClusters.map((idxs, clusterId) => {
    const items = idxs.map((i) => ({
      ...facts[i],
      project_label: facts[i].project_id ? projectLabel.get(facts[i].project_id) : null,
    }));
    const distinctClients = new Set(
      items.flatMap((f) => f.observed_by_clients || []).filter(Boolean),
    );
    const distinctProjects = new Set(items.map((f) => f.project_id).filter(Boolean));
    return {
      cluster_id: clusterId,
      facts: items,
      distinct_clients: distinctClients.size,
      distinct_projects: distinctProjects.size,
    };
  });

  // ---- 4. Threshold filter -----------------------------------------
  // Spec rules:
  //   • multi-client (≥2 distinct clients): keep at ≥2 facts
  //   • cross-project (≥2 distinct projects): keep at ≥3 facts
  //   • else (single-client): keep at ≥4 facts
  const candidates = [];
  for (const c of clusters) {
    const summary = {
      id: c.cluster_id,
      fact_count: c.facts.length,
      distinct_clients: c.distinct_clients,
      distinct_projects: c.distinct_projects,
    };
    let keep = false;
    if (c.distinct_clients >= 2 && c.facts.length >= 2) keep = true;
    else if (c.distinct_projects >= 2 && c.facts.length >= 3) keep = true;
    else if (c.facts.length >= 4) keep = true;
    summary.kept = keep;
    details.clusters.push(summary);
    if (!keep) counters.skipped_threshold += 1;
    else candidates.push(c);
  }
  counters.candidates_evaluated = candidates.length;
  if (candidates.length === 0) {
    return finalize(admin, userId, trigger, counters, details, startedAt);
  }

  // ---- 5. Existing-belief dedup index -------------------------------
  const { data: existingBeliefs } = await admin
    .from('lykn_beliefs')
    .select('belief_text, embedding')
    .eq('user_id', userId)
    .in('status', ['active', 'proposed', 'ratified']);

  // ---- 6. + 7. Per-cluster propose + write -------------------------
  for (const cluster of candidates) {
    let proposal;
    try {
      proposal = await callSynthesisModel(cluster);
    } catch (err) {
      counters.error_count += 1;
      details.errors.push({
        stage: 'model',
        cluster_id: cluster.cluster_id,
        message: err?.message || String(err),
      });
      continue;
    }
    if (!proposal || proposal.propose === false) {
      counters.skipped_model += 1;
      continue;
    }

    // Dedup against existing beliefs (cosine on the centroid of the
    // cluster's fact embeddings vs each existing belief's embedding).
    const centroid = mean(cluster.facts.map((f) => parseEmbedding(f.embedding)));
    const isDup = (existingBeliefs || []).some((b) => {
      const emb = parseEmbedding(b.embedding);
      return emb && cosine(centroid, emb) > DUPLICATE_COSINE_THRESHOLD;
    });
    if (isDup) {
      counters.skipped_duplicate += 1;
      continue;
    }

    // Embed the proposed belief text so future synthesis runs can
    // dedup against this belief via cosine similarity (>0.85 → skip).
    // Best-effort: an embed failure still lets the belief land; future
    // runs just won't be able to dedup against it until a backfill.
    let beliefEmbedding = null;
    let embeddedAt = null;
    try {
      beliefEmbedding = await embedFactText(proposal.belief_text, { userId });
      if (beliefEmbedding) embeddedAt = new Date().toISOString();
    } catch {
      // swallow — embedding is opportunistic for the dedup index
    }

    const { error: insertErr } = await admin.from('lykn_beliefs').insert({
      user_id: userId,
      belief_text: proposal.belief_text,
      serves_need: proposal.serves_need,
      confidence: proposal.confidence,
      status: 'proposed',
      source: 'lykn-synthesis',
      proposed_by_clients: dedup([
        'lykn-synthesis',
        ...cluster.facts.flatMap((f) => f.observed_by_clients || []),
      ]),
      // Synthesis-job-proposed beliefs are tagged so the UI can
      // distinguish them from human / per-client MCP proposals. Shape
      // mirrors the comments in migration 049.
      provenance: {
        source: 'synthesis_job',
        cluster_id: cluster.cluster_id,
        fact_ids: cluster.facts.map((f) => f.id),
        distinct_clients: cluster.distinct_clients,
        distinct_projects: cluster.distinct_projects,
      },
      embedding: beliefEmbedding,
      embedded_at: embeddedAt,
    });
    if (insertErr) {
      counters.error_count += 1;
      details.errors.push({
        stage: 'insert',
        cluster_id: cluster.cluster_id,
        message: insertErr.message,
      });
      continue;
    }
    counters.proposals_written += 1;
    details.proposals.push({
      cluster_id: cluster.cluster_id,
      belief_text: proposal.belief_text,
      serves_need: proposal.serves_need,
      confidence: proposal.confidence,
    });
  }

  return finalize(admin, userId, trigger, counters, details, startedAt);
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function loadProjectLabels(admin, userId, projectIds) {
  const map = new Map();
  if (projectIds.length === 0) return map;
  const { data } = await admin
    .from('lykn_projects')
    .select('id, name')
    .eq('user_id', userId)
    .in('id', projectIds);
  for (const row of data || []) map.set(row.id, row.name);
  return map;
}

/**
 * Supabase returns the vector(1536) column either as an array (json
 * decoded) or as a Postgres "[1.2,3.4,…]" string depending on the
 * client version. Normalise both shapes.
 */
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
  for (const v of valid) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= valid.length;
  return out;
}

function dedup(arr) {
  return Array.from(new Set(arr.filter(Boolean))).slice(0, 8);
}

async function callSynthesisModel(cluster) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const userMessage = buildClusterMessage(cluster);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: SYNTHESIS_MODEL,
      max_tokens: SYNTHESIS_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`anthropic HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const body = await resp.json();
  const text = body?.content?.[0]?.text || '';

  let parsed;
  try {
    // Models sometimes wrap JSON in ```json fences despite being told not to.
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  return validateProposal(parsed);
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
    `🌙 synthesisJob[${userId}]: clusters=${counters.clusters_found} candidates=${counters.candidates_evaluated} proposals=${counters.proposals_written} skipped(thresh=${counters.skipped_threshold} dup=${counters.skipped_duplicate} model=${counters.skipped_model}) errors=${counters.error_count} ${duration}ms`,
  );
  return { ...counters, duration_ms: duration };
}
