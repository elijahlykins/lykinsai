// ============================================
// LYKN — User Model Learning
// ============================================
// Source-of-truth pipeline for "the AI is actually learning the user."
//
// Reads multi-source evidence (vault notes, grid boards, conversation history),
// extracts atomic facts via LLM, and reconciles them against existing
// lykn_user_model_facts rows: dedup by normalized key, raise confidence on
// independent evidence, decay unused, respect user feedback (confirmed /
// dismissed / corrected).
//
// Writes a snapshot to lykn_user_model_revisions on every successful pass so
// the UI can show "what the AI noticed this week."
//
// Companion to the legacy runUserProfileLlmAndUpsert in server.js — that one
// still maintains the opaque `lykn_user_synthesis_profile` row that powers
// [USER_MODEL] prompt injection. This module produces the structured facts
// that the profile row will be derived from once Phase 2 (UI) ships.

import fetch from 'node-fetch';
import { embedAndPersistFact } from './factEmbedding.js';

// ---------------------------------------------------------------------------
// Provenance helpers (see migration 047)
// ---------------------------------------------------------------------------
// Every fact-write path threads the same provenance payload through to
// persistFacts: which client wrote it, which project (if any) it ties
// to, and host-provided conversation/message ids. None are required —
// older callers that don't pass them leave the columns NULL, which is
// fine for the synthesis job (it just treats those facts as
// project-agnostic / single-client).
const MAX_OBSERVED_CLIENTS = 8;

function normalizeClientSlug(s) {
  if (!s) return null;
  return String(s).toLowerCase().slice(0, 64) || null;
}

function dedupMergeClient(prior, next) {
  const priorArr = Array.isArray(prior) ? prior : [];
  if (!next || priorArr.includes(next)) return priorArr;
  return [...priorArr, next].slice(0, MAX_OBSERVED_CLIENTS);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FACT_KINDS = [
  'identity', 'focus', 'theme', 'goal', 'preference', 'style', 'constraint', 'relationship',
];

const FACT_KIND_SET = new Set(FACT_KINDS);

const FACT_STATUSES = new Set(['inferred', 'stated', 'confirmed', 'corrected', 'dismissed']);

// Reconciliation tuning — keep conservative; user-visible confidence numbers
// should move slowly so they feel earned.
const CONFIDENCE_INITIAL = 0.5;
const CONFIDENCE_REINFORCE_STEP = 0.12;   // per fresh independent evidence
const CONFIDENCE_DECAY_PER_DAY = 0.01;    // applied to facts not seen this pass
const CONFIDENCE_FLOOR_INFERRED = 0.15;   // below this, treat as forgotten
const CONFIDENCE_CEILING_INFERRED = 0.92; // never max out — reserve 1.0 for stated/confirmed
const MAX_EVIDENCE_PER_FACT = 10;
const MAX_FACTS_PER_USER = 240;
const MAX_REVISIONS_PER_USER = 50;

// Multi-source ingestion limits — bound LLM token usage per refresh.
const VAULT_NOTES_LIMIT = 30;
const VAULT_NOTE_CHARS = 1500;
const GRID_BOARDS_LIMIT = 20;
const GRID_BOARD_CHARS = 1200;
const CONV_EXCHANGES_LIMIT = 30;
const CONV_EXCHANGE_CHARS = 1200;
const INTAKE_BLOCK_CHARS = 1800;
const SOURCE_BLOCK_CHARS = 28_000;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a fact text into a stable key for dedup.
 * Lowercase, strip punctuation, collapse whitespace, drop common stopwords.
 * "Works as a Designer." and "works as a designer" → same key.
 */
export function normalizeFactKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(a|an|the|is|are|was|were|be|been|being|of|in|on|at|to|for|with|and|or|that|this)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
}

function uniqueArray(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function safeIsoDate(d) {
  if (!d) return new Date().toISOString();
  try { return new Date(d).toISOString(); } catch { return new Date().toISOString(); }
}

// ---------------------------------------------------------------------------
// Multi-source evidence collection
// ---------------------------------------------------------------------------

/**
 * Pull a recency-weighted sample of vault notes, grid boards, and conversations.
 * Returns a structured object that downstream LLM and reconciler both consume.
 */
export async function collectLearningEvidence(client, userId) {
  const [vaultNotes, gridBoards, conversations, intake] = await Promise.all([
    fetchRecentVaultNotes(client, userId),
    fetchRecentGridBoards(client, userId),
    fetchRecentConversations(client, userId),
    fetchIntakeAnswers(client, userId),
  ]);

  return {
    vaultNotes,
    gridBoards,
    conversations,
    intake,
    counts: {
      vault: vaultNotes.length,
      grids: gridBoards.length,
      conversations: conversations.length,
      hasIntake: Boolean(intake),
    },
  };
}

async function fetchRecentVaultNotes(client, userId) {
  try {
    const { data, error } = await client
      .from('notes')
      .select('id, title, content, ai_summary, ai_signals, tags, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(VAULT_NOTES_LIMIT);
    if (error) {
      console.warn('⚠️ collectLearningEvidence vault:', error.message);
      return [];
    }
    return (data || []).map((n) => ({
      id: n.id,
      title: String(n.title || '').trim().slice(0, 200),
      summary: String(n.ai_summary || '').trim().slice(0, 600),
      content: stripAttachmentMarker(n.content).slice(0, VAULT_NOTE_CHARS),
      tags: Array.isArray(n.tags) ? n.tags.filter(Boolean).slice(0, 12) : [],
      themes: extractThemesFromSignals(n.ai_signals).slice(0, 8),
      updated_at: n.updated_at,
    }));
  } catch (e) {
    console.warn('⚠️ collectLearningEvidence vault threw:', e?.message || e);
    return [];
  }
}

async function fetchRecentGridBoards(client, userId) {
  try {
    const { data, error } = await client
      .from('omnia_boards')
      .select('id, title, project_id, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(GRID_BOARDS_LIMIT);
    if (error) {
      console.warn('⚠️ collectLearningEvidence grids:', error.message);
      return [];
    }
    if (!data?.length) return [];
    // Fetch the most recent board_states content for each so the LLM has
    // something concrete to read, not just titles. board_states is one row
    // per board (post migration 016) so this is bounded.
    const boardIds = data.map((b) => b.id);
    const { data: states } = await client
      .from('board_states')
      .select('board_id, content, updated_at')
      .in('board_id', boardIds);
    const stateMap = new Map();
    for (const s of states || []) {
      if (!s?.board_id) continue;
      stateMap.set(String(s.board_id), s);
    }
    return data.map((b) => {
      const state = stateMap.get(String(b.id));
      const text = state ? snapshotToText(state.content) : '';
      return {
        id: b.id,
        title: String(b.title || '').trim().slice(0, 200),
        project_id: b.project_id || null,
        snippet: text.slice(0, GRID_BOARD_CHARS),
        updated_at: b.updated_at,
      };
    });
  } catch (e) {
    console.warn('⚠️ collectLearningEvidence grids threw:', e?.message || e);
    return [];
  }
}

async function fetchRecentConversations(client, userId) {
  try {
    const { data, error } = await client
      .from('ai_conversation_memory')
      .select('id, user_message, assistant_message, surface, surface_title, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(CONV_EXCHANGES_LIMIT);
    if (error) {
      console.warn('⚠️ collectLearningEvidence convs:', error.message);
      return [];
    }
    return (data || []).slice().reverse().map((row) => ({
      id: row.id,
      surface: row.surface || 'chat',
      surface_title: row.surface_title || null,
      user_message: String(row.user_message || '').slice(0, CONV_EXCHANGE_CHARS),
      assistant_message: String(row.assistant_message || '').slice(0, CONV_EXCHANGE_CHARS),
      created_at: row.created_at,
    }));
  } catch (e) {
    console.warn('⚠️ collectLearningEvidence convs threw:', e?.message || e);
    return [];
  }
}

async function fetchIntakeAnswers(client, userId) {
  try {
    const { data, error } = await client
      .from('lykn_user_synthesis_profile')
      .select('narrative, themes, signals, intake_completed_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    if (!data.intake_completed_at) return null;
    return {
      narrative: String(data.narrative || '').trim().slice(0, INTAKE_BLOCK_CHARS),
      themes: Array.isArray(data.themes) ? data.themes.slice(0, 12) : [],
      signals: data.signals && typeof data.signals === 'object' ? data.signals : {},
    };
  } catch {
    return null;
  }
}

function extractThemesFromSignals(sig) {
  if (!sig) return [];
  const obj = typeof sig === 'string' ? safeJson(sig) : sig;
  const out = [];
  if (Array.isArray(obj?.themes)) out.push(...obj.themes);
  if (Array.isArray(obj?.recurring_topics)) out.push(...obj.recurring_topics);
  if (Array.isArray(obj?.entities)) out.push(...obj.entities);
  return uniqueArray(out.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function stripAttachmentMarker(raw) {
  return String(raw || '').replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, '').trim();
}

/** Flatten a board_states.content snapshot into linear text for LLM consumption. */
function snapshotToText(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const blocks = snapshot.blocks || {};
  const order = Array.isArray(snapshot.blockOrder) ? snapshot.blockOrder : Object.keys(blocks);
  const lines = [];
  for (const id of order.slice(0, 60)) {
    const b = blocks[id];
    if (!b) continue;
    const type = String(b.type || '');
    if (type === 'text') {
      const c = String(b.content || '').replace(/\s+/g, ' ').trim();
      if (c) lines.push(`[text] ${c.slice(0, 600)}`);
    } else if (type === 'create' || type === 'youtube' || type === 'link' || type === 'image') {
      const data = b.data || {};
      const t = String(data.title || data.name || data.content || data.url || b.url || '').trim();
      if (t) lines.push(`[${type}] ${t.slice(0, 200)}`);
    } else {
      const c = String(b.content || (b.data && b.data.content) || '').replace(/\s+/g, ' ').trim();
      if (c) lines.push(`[${type}] ${c.slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM extraction of structured facts
// ---------------------------------------------------------------------------

/**
 * Render the multi-source evidence into a single labeled block the LLM reads.
 * Layout is deliberately pseudo-XML so the model can quote source ids back to
 * us when emitting evidence snippets.
 */
function buildEvidenceBlock(evidence, existingFacts, dismissedFacts) {
  const sections = [];

  if (evidence.intake) {
    sections.push(`<intake>\n${evidence.intake.narrative || '(no narrative)'}\nThemes: ${evidence.intake.themes.join(', ') || '(none)'}\nSignals: ${JSON.stringify(evidence.intake.signals).slice(0, 1200)}\n</intake>`);
  }

  if (evidence.vaultNotes.length) {
    const block = evidence.vaultNotes.map((n) => {
      const meta = [n.title && `title="${n.title}"`, n.tags.length && `tags=${n.tags.join(',')}`].filter(Boolean).join(' ');
      const body = n.summary ? `Summary: ${n.summary}\n${n.content}` : n.content;
      return `<vault_note id="${n.id}" ${meta}>\n${body}\n</vault_note>`;
    }).join('\n\n');
    sections.push(block);
  }

  if (evidence.gridBoards.length) {
    const block = evidence.gridBoards.map((b) => {
      return `<grid_board id="${b.id}" title="${b.title}">\n${b.snippet || '(empty)'}\n</grid_board>`;
    }).join('\n\n');
    sections.push(block);
  }

  if (evidence.conversations.length) {
    const block = evidence.conversations.map((c) => {
      const label = c.surface_title ? `${c.surface} "${c.surface_title}"` : c.surface;
      return `<conversation id="${c.id}" surface="${label}">\nUser: ${c.user_message}\nAssistant: ${c.assistant_message}\n</conversation>`;
    }).join('\n\n');
    sections.push(block);
  }

  let block = sections.join('\n\n');
  if (block.length > SOURCE_BLOCK_CHARS) block = `${block.slice(0, SOURCE_BLOCK_CHARS)}…`;

  // Tell the model what it already knows so it can refine rather than re-derive.
  const knownBlock = existingFacts.length
    ? existingFacts.slice(0, 60).map((f) => `- [${f.fact_kind} · conf ${f.confidence.toFixed(2)} · ${f.status}] ${f.fact_text}`).join('\n')
    : '(none)';

  // Tell the model what NOT to re-emit (user-dismissed / corrected facts).
  const dismissedBlock = dismissedFacts.length
    ? dismissedFacts.slice(0, 30).map((f) => `- [${f.fact_kind}] ${f.fact_text}${f.correction_text ? ` → corrected to: "${f.correction_text}"` : ''}`).join('\n')
    : '(none)';

  return [
    `<known_facts>\n${knownBlock}\n</known_facts>`,
    `<do_not_re_emit>\n${dismissedBlock}\n</do_not_re_emit>`,
    block,
  ].join('\n\n');
}

const FACT_EXTRACTION_SYSTEM = `You are the user-model learner for a creative workspace AI named LYKN.

You read evidence from a single user (vault notes, grid boards, conversations, optional intake) and emit a structured set of atomic FACTS about that person — things that would help the AI personalize future responses.

Output ONLY valid JSON of the form:
{
  "facts": [
    {
      "kind": "identity" | "focus" | "theme" | "goal" | "preference" | "style" | "constraint" | "relationship",
      "text": "short third-person claim, ≤140 chars, e.g. 'Works on a creative-tools app called LYKN'",
      "confidence": 0.0–1.0,
      "evidence": [
        { "source_type": "vault_note" | "grid_board" | "conversation" | "intake",
          "source_id": "the id from the <tag id=...> attribute, or 'intake'",
          "snippet": "≤200-char quote that supports this fact" }
      ]
    }
  ]
}

Rules:
- 4–25 facts total. Quality over quantity.
- ONE atomic claim per fact. "Designer who likes minimalism" → split into two facts.
- "kind" guidance:
  · identity: durable role / professional context / location / persistent self-description
  · focus: what they're working on RIGHT NOW (project, problem, deliverable)
  · theme: topics that keep recurring across their work
  · goal: stated or strongly-implied objectives
  · preference: tools, formats, aesthetics, response styles they reach for
  · style: how they reason or communicate (concise, exploratory, visual-first, etc.)
  · constraint: time/budget/access limits, things to avoid
  · relationship: people, teams, collaborators, audiences they reference
- "confidence":
  · 0.85–0.95 if directly stated by the user (intake or chat)
  · 0.60–0.80 if strongly implied by multiple sources
  · 0.40–0.55 if reasonably inferred from one source
  · do not invent confidence — if it's a guess, say 0.40
- Always include ≥1 evidence entry per fact. The "snippet" must be quoted from the actual source text — do not paraphrase.
- DO NOT re-emit anything in <do_not_re_emit>. The user has explicitly rejected those.
- Refine, do not duplicate, anything in <known_facts>. If existing knowledge is still supported, restate the same "text" so the reconciler can match by key.
- No biographical guessing not grounded in evidence. No content moralizing.`;

/**
 * Call the LLM and return parsed structured facts. Returns null on any failure.
 * `usageLogger` is an optional callback the caller passes in so this module
 * doesn't have to import server-side helpers — server.js threads logAiUsage
 * + the active userId through runUserModelLearningPass().
 */
async function extractFactsFromLlm(evidence, existingFacts, dismissedFacts, usageLogger) {
  if (!process.env.OPENAI_API_KEY) return null;

  const evidenceBlock = buildEvidenceBlock(evidence, existingFacts, dismissedFacts);
  if (!evidenceBlock.trim()) return null;

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FACT_EXTRACTION_SYSTEM },
          { role: 'user', content: evidenceBlock },
        ],
      }),
    });
  } catch (e) {
    console.warn('⚠️ User-model LLM fetch:', e?.message || e);
    return null;
  }

  if (!res.ok) {
    console.warn('⚠️ User-model LLM HTTP', res.status);
    return null;
  }

  let data;
  let parsed;
  try {
    data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('⚠️ User-model LLM parse failed:', e?.message || e);
    return null;
  }

  if (typeof usageLogger === 'function') {
    try {
      const u = data?.usage || {};
      usageLogger({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: u.prompt_tokens || u.input_tokens || 0,
        outputTokens: u.completion_tokens || u.output_tokens || 0,
        metadata: { evidence_chars: evidenceBlock.length },
      });
    } catch { /* never let logging crash extraction */ }
  }

  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts
    .map((raw) => sanitizeIncomingFact(raw))
    .filter(Boolean);
}

/** Validate + normalize a single LLM fact into the shape the reconciler wants. */
function sanitizeIncomingFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (!FACT_KIND_SET.has(kind)) return null;
  const text = String(raw.text || '').trim().slice(0, 240);
  if (!text) return null;
  const key = normalizeFactKey(text);
  if (!key) return null;
  const confidence = clamp(Number(raw.confidence), 0.05, 1);
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
      .map((e) => {
        if (!e || typeof e !== 'object') return null;
        const source_type = String(e.source_type || '').toLowerCase();
        if (!['vault_note', 'grid_board', 'conversation', 'intake'].includes(source_type)) return null;
        const source_id = String(e.source_id || '').slice(0, 200) || 'unknown';
        const snippet = String(e.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        return { source_type, source_id, snippet, observed_at: new Date().toISOString() };
      })
      .filter(Boolean)
      .slice(0, MAX_EVIDENCE_PER_FACT)
    : [];
  return { fact_kind: kind, fact_text: text, fact_key: key, confidence, evidence };
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

/**
 * Merge new LLM facts into existing ones.
 * Returns { upserts, decays, diff } — the caller writes to DB.
 */
export function reconcileFacts({ existing, incoming, now = new Date() }) {
  const existingByKey = new Map();
  for (const f of existing || []) {
    const k = `${f.fact_kind}::${f.fact_key}`;
    existingByKey.set(k, f);
  }

  const upserts = [];
  const seenKeys = new Set();
  const diff = {
    added: [],
    reinforced: [],
    decayed: [],
    unchanged: [],
  };

  for (const inc of incoming || []) {
    const k = `${inc.fact_kind}::${inc.fact_key}`;
    seenKeys.add(k);
    const prev = existingByKey.get(k);

    if (!prev) {
      const conf = clamp(inc.confidence, 0.05, CONFIDENCE_CEILING_INFERRED);
      const sourceTypes = uniqueArray(inc.evidence.map((e) => e.source_type));
      upserts.push({
        fact_kind: inc.fact_kind,
        fact_text: inc.fact_text,
        fact_key: inc.fact_key,
        confidence: conf,
        status: 'inferred',
        correction_text: null,
        evidence: inc.evidence,
        evidence_count: inc.evidence.length || 1,
        source_types: sourceTypes,
        first_seen_at: safeIsoDate(now),
        last_seen_at: safeIsoDate(now),
      });
      diff.added.push({ fact_kind: inc.fact_kind, fact_text: inc.fact_text, confidence: conf });
      continue;
    }

    // Don't undismiss user-dismissed facts; only refresh last_seen for accounting.
    if (prev.status === 'dismissed') {
      upserts.push({
        ...prev,
        last_seen_at: safeIsoDate(now),
      });
      continue;
    }

    // Reinforce: confidence rises (slowly), evidence merges (cap), source_types union.
    const reinforceFromStated = prev.status === 'stated' || prev.status === 'confirmed';
    const ceiling = reinforceFromStated ? 1.0 : CONFIDENCE_CEILING_INFERRED;
    const newConf = clamp(prev.confidence + CONFIDENCE_REINFORCE_STEP, prev.confidence, ceiling);
    const newEvidence = mergeEvidence(prev.evidence || [], inc.evidence);
    const newSourceTypes = uniqueArray([...(prev.source_types || []), ...inc.evidence.map((e) => e.source_type)]);

    upserts.push({
      ...prev,
      // Trust LLM's latest phrasing if existing was inferred (not user-stated/confirmed)
      fact_text: prev.status === 'confirmed' || prev.status === 'corrected' ? prev.fact_text : inc.fact_text,
      confidence: newConf,
      evidence: newEvidence,
      evidence_count: (prev.evidence_count || 0) + inc.evidence.length,
      source_types: newSourceTypes,
      last_seen_at: safeIsoDate(now),
    });

    if (newConf - prev.confidence >= 0.005) {
      diff.reinforced.push({
        fact_kind: prev.fact_kind,
        fact_text: prev.fact_text,
        confidence_before: prev.confidence,
        confidence_after: newConf,
      });
    } else {
      diff.unchanged.push({ fact_kind: prev.fact_kind, fact_text: prev.fact_text });
    }
  }

  // Decay anything not seen this pass (except user-confirmed / stated).
  for (const prev of existing || []) {
    const k = `${prev.fact_kind}::${prev.fact_key}`;
    if (seenKeys.has(k)) continue;
    if (prev.status === 'confirmed' || prev.status === 'stated' || prev.status === 'corrected' || prev.status === 'dismissed') {
      continue;
    }
    const days = daysBetween(prev.last_seen_at, now);
    const decayed = clamp(prev.confidence - CONFIDENCE_DECAY_PER_DAY * days, 0, 1);
    if (decayed < CONFIDENCE_FLOOR_INFERRED) {
      // Forgotten — don't upsert (caller will leave the row alone or delete via cleanup).
      diff.decayed.push({ fact_kind: prev.fact_kind, fact_text: prev.fact_text, confidence_after: decayed, dropped: true });
    } else if (decayed < prev.confidence - 0.005) {
      upserts.push({ ...prev, confidence: decayed });
      diff.decayed.push({ fact_kind: prev.fact_kind, fact_text: prev.fact_text, confidence_after: decayed, dropped: false });
    }
  }

  return { upserts, diff };
}

function mergeEvidence(prev, incoming) {
  // Dedup by (source_type, source_id, snippet) — keep newest first.
  const seen = new Set();
  const out = [];
  const all = [...(incoming || []), ...(prev || [])];
  for (const e of all) {
    if (!e) continue;
    const k = `${e.source_type}|${e.source_id}|${e.snippet}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= MAX_EVIDENCE_PER_FACT) break;
  }
  return out;
}

function daysBetween(a, b) {
  try {
    const diff = new Date(b).getTime() - new Date(a).getTime();
    return Math.max(0, diff / 86_400_000);
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Public entry point — run a learning pass
// ---------------------------------------------------------------------------

/**
 * Run one full learning pass for a user.
 *   1. Collect multi-source evidence.
 *   2. Read existing facts (active + dismissed) for context.
 *   3. Ask the LLM to emit structured facts grounded in the evidence.
 *   4. Reconcile against existing.
 *   5. Persist upserts; write a revision snapshot.
 *
 * Caller: server.js — fired (debounced) on chat send and meaningful saves.
 *
 * Returns { ok, reason?, factsTotal, factsAdded, factsReinforced, revisionId? }.
 */
export async function runUserModelLearningPass(client, userId, opts = {}) {
  if (!userId) return { ok: false, reason: 'no_user' };
  if (!client) return { ok: false, reason: 'no_db' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_openai' };

  const trigger = opts.trigger || 'refresh';

  const evidence = await collectLearningEvidence(client, userId);
  const totalEvidence = evidence.counts.vault + evidence.counts.grids + evidence.counts.conversations;
  if (totalEvidence < 2 && !evidence.counts.hasIntake) {
    return { ok: true, reason: 'insufficient_evidence', factsTotal: 0, factsAdded: 0, factsReinforced: 0 };
  }

  const existingFacts = await fetchAllFacts(client, userId);
  const dismissedFacts = existingFacts.filter((f) => f.status === 'dismissed' || f.status === 'corrected');
  const activeForLlm = existingFacts.filter((f) => f.status !== 'dismissed');

  const incoming = await extractFactsFromLlm(evidence, activeForLlm, dismissedFacts, opts.usageLogger);
  if (!incoming) return { ok: false, reason: 'llm_failed' };

  const now = new Date();
  const { upserts, diff } = reconcileFacts({ existing: activeForLlm, incoming, now });

  if (!upserts.length && !diff.added.length && !diff.reinforced.length) {
    return { ok: true, reason: 'no_changes', factsTotal: existingFacts.length, factsAdded: 0, factsReinforced: 0 };
  }

  // Bound table size — drop lowest-confidence inferred facts beyond the cap.
  const cappedUpserts = await capFactsForUser(client, userId, upserts);

  const upsertedResult = await persistFacts(client, userId, cappedUpserts);
  const upserted = upsertedResult.count;
  const revisionId = await writeRevision(client, userId, {
    trigger,
    factCount: upserted,
    factsAdded: diff.added.length,
    factsUpdated: diff.reinforced.length,
    factsDismissed: diff.decayed.filter((d) => d.dropped).length,
    diff,
  });
  await trimOldRevisions(client, userId);

  console.log(
    `🧠 user-model pass uid=${String(userId).slice(0, 8)} trigger=${trigger} ` +
    `+${diff.added.length} new · ↑${diff.reinforced.length} reinforced · ↓${diff.decayed.length} decayed · ` +
    `total=${upserted}`
  );

  return {
    ok: true,
    factsTotal: upserted,
    factsAdded: diff.added.length,
    factsReinforced: diff.reinforced.length,
    factsDecayed: diff.decayed.length,
    revisionId,
  };
}

// ---------------------------------------------------------------------------
// Single-fact recorder (used by /api/learned for live in-chat tagging)
// ---------------------------------------------------------------------------

/**
 * Persist a single fact the AI just inferred from a live chat message.
 *
 * Unlike runUserModelLearningPass — which is a periodic, multi-source LLM
 * extraction pass — this is the realtime path: the model emitted a hidden
 * <learned kind="...">phrase</learned><reason>why</reason> tag at the end of
 * its visible reply, the client stripped + parsed it, and POSTed it here.
 *
 * Two modes, mutually exclusive:
 *   • CREATE / REINFORCE (default) — payload has {text, kind, reason}.
 *     Brand-new fact_text is upserted as a fresh neuron; an existing matching
 *     fact_key gets its confidence reinforced via the same reconciler the
 *     batch pass uses.
 *   • UPDATE-IN-PLACE — payload has {text, kind, reason, replacesText}.
 *     The model emitted an <updated old="..."> tag because the new info
 *     refines / corrects / supersedes a fact already in [USER_MODEL]. We
 *     find the existing row by normalized old-text key and rewrite its
 *     fact_text + fact_key + (optionally) fact_kind in place — preserving
 *     the row's UUID, evidence history, first_seen_at, and source_types so
 *     the synthesis layer treats this as the SAME neuron with refreshed
 *     content rather than spawning a new node next to the stale one.
 *
 * Behaviour:
 *   • Validates kind against FACT_KINDS (defaults to 'identity').
 *   • Treats the user's own utterance as direct evidence (status='stated',
 *     high confidence) — the AI is reporting something the user just said,
 *     not inferring it from indirect signal.
 *   • Reuses reconcileFacts for the create path so duplicates merge cleanly
 *     into the existing row instead of double-creating a neuron.
 *   • For updates: handles the rare key-collision case (the new text would
 *     collide with another existing fact's unique key) by deleting the
 *     stale "old" row and reinforcing the collision target.
 *   • Records a 'feedback'-trigger revision so the diff log shows that this
 *     learning happened mid-conversation, not in a batch pass.
 *
 * Returns:
 *   {
 *     ok: true,
 *     fact: { id, fact_kind, fact_text, status, confidence, reason,
 *             isNew, isUpdate, previousText? },
 *   }
 *   ...or { ok: false, reason } on validation / DB failure.
 */
export async function recordLearnedFactFromChat(client, userId, payload) {
  // Never throw out of this function — the /api/learned route has a generic
  // catch that returns 500 with `error: 'learn_failed'` and swallows the
  // actual reason. Anything that goes wrong below should come back as a
  // structured `{ ok: false, reason: <human-readable-string> }` so the
  // route can surface it in the response body for diagnosis.
  try {
    if (!client) return { ok: false, reason: 'no_db' };
    if (!userId) return { ok: false, reason: 'no_user' };
    const text = String(payload?.text || '').trim().slice(0, 240);
    if (!text) return { ok: false, reason: 'empty_text' };
    const rawKind = String(payload?.kind || 'identity').trim().toLowerCase();
    const fact_kind = FACT_KIND_SET.has(rawKind) ? rawKind : 'identity';
    const reason = String(payload?.reason || '').trim().slice(0, 240) || null;
    const sourceId = String(payload?.sourceId || 'live_chat').slice(0, 200);
    const replacesText = String(payload?.replacesText || '').trim().slice(0, 240);

    // Provenance plumbing (migration 047). All optional — when callers
    // don't pass these the columns stay NULL.
    const provenance = {
      source: normalizeClientSlug(payload?.client),
      projectId: payload?.projectId || null,
      conversationId: payload?.conversationId
        ? String(payload.conversationId).slice(0, 128)
        : null,
      messageId: payload?.messageId
        ? String(payload.messageId).slice(0, 128)
        : null,
    };

    const fact_key = normalizeFactKey(text);
    if (!fact_key) return { ok: false, reason: 'unkeyable_text' };

    const existing = await fetchAllFacts(client, userId);

    // === UPDATE-IN-PLACE PATH ===========================================
    // The model emitted <updated old="...">. Find the row whose normalized
    // text matches the old phrase the AI quoted, then mutate it in place so
    // the synthesis-layer node keeps its identity (same UUID, same edges,
    // same first_seen_at) but its content evolves.
    if (replacesText) {
      const oldKey = normalizeFactKey(replacesText);
      if (!oldKey) {
        return await createOrReinforceFact(client, userId, {
          text, fact_kind, fact_key, reason, sourceId, existing, now: new Date(), provenance,
        });
      }

      let oldRow = existing.find((f) => f.fact_key === oldKey && f.fact_kind === fact_kind);
      if (!oldRow) oldRow = existing.find((f) => f.fact_key === oldKey);
      if (!oldRow) {
        return await createOrReinforceFact(client, userId, {
          text, fact_kind, fact_key, reason, sourceId, existing, now: new Date(), provenance,
        });
      }

      if (oldRow.fact_kind === fact_kind && oldRow.fact_key === fact_key) {
        return await createOrReinforceFact(client, userId, {
          text, fact_kind, fact_key, reason, sourceId, existing, now: new Date(), provenance,
        });
      }

      return await applyInPlaceUpdate(client, userId, {
        oldRow, newText: text, newKind: fact_kind, newKey: fact_key,
        reason, sourceId, existing, provenance,
      });
    }

    // === CREATE / REINFORCE PATH (default) ==============================
    return await createOrReinforceFact(client, userId, {
      text, fact_kind, fact_key, reason, sourceId, existing, now: new Date(), provenance,
    });
  } catch (e) {
    // Anything that escaped the inner handlers (TypeError, malformed Supabase
    // response, network blip mid-operation, etc.) lands here so the route
    // can return a real reason instead of a generic `learn_failed`.
    const msg = e?.message || String(e);
    console.warn('⚠️ recordLearnedFactFromChat threw:', msg);
    return { ok: false, reason: `internal: ${msg}`.slice(0, 240) };
  }
}

/**
 * Default create-or-reinforce path. Used both by plain <learned> tags and
 * as the safe fallback when an <updated> tag's old="..." attribute can't
 * be resolved to an existing fact.
 */
async function createOrReinforceFact(client, userId, ctx) {
  const { text, fact_kind, fact_key, reason, sourceId, existing, now, provenance } = ctx;
  const dupKey = `${fact_kind}::${fact_key}`;
  const wasNew = !existing.some((f) => `${f.fact_kind}::${f.fact_key}` === dupKey);

  const incoming = [{
    fact_kind,
    fact_text: text,
    fact_key,
    confidence: 0.95,
    evidence: [{
      source_type: 'conversation',
      source_id: sourceId,
      snippet: (reason || text).slice(0, 240),
      observed_at: now.toISOString(),
    }],
  }];

  const activeForLlm = existing.filter((f) => f.status !== 'dismissed');
  const { upserts, diff } = reconcileFacts({ existing: activeForLlm, incoming, now });

  const targetUpsert = upserts.find((u) => u.fact_kind === fact_kind && u.fact_key === fact_key);
  if (targetUpsert) {
    if (wasNew) {
      targetUpsert.status = 'stated';
      targetUpsert.confidence = 0.95;
    } else if (targetUpsert.status === 'inferred') {
      targetUpsert.status = 'stated';
      targetUpsert.confidence = Math.max(targetUpsert.confidence || 0, 0.95);
    }
  }

  const persistResult = await persistFacts(client, userId, upserts, { provenance });
  if (persistResult.count === 0 && upserts.length > 0) {
    return {
      ok: false,
      reason: persistResult.error
        ? `persist_failed: ${persistResult.error}`
        : 'persist_failed',
    };
  }

  const { data: row } = await client
    .from('lykn_user_model_facts')
    .select('id, fact_kind, fact_text, status, confidence')
    .eq('user_id', userId)
    .eq('fact_kind', fact_kind)
    .eq('fact_key', fact_key)
    .maybeSingle();

  // (embed-on-write happens inside persistFacts; nothing needed here)

  await writeRevision(client, userId, {
    trigger: 'feedback',
    factCount: existing.length + (wasNew ? 1 : 0),
    factsAdded: wasNew ? 1 : 0,
    factsUpdated: wasNew ? 0 : 1,
    factsDismissed: 0,
    diff: {
      live_learned: {
        kind: fact_kind,
        text,
        reason: reason || null,
        is_new: wasNew,
        before: diff,
      },
    },
  });

  return {
    ok: true,
    fact: {
      id: row?.id || null,
      fact_kind: row?.fact_kind || fact_kind,
      fact_text: row?.fact_text || text,
      status: row?.status || (wasNew ? 'stated' : 'inferred'),
      confidence: typeof row?.confidence === 'number' ? row.confidence : 0.95,
      reason,
      isNew: wasNew,
      isUpdate: false,
    },
  };
}

/**
 * Mutate an existing fact row in place — preserving its UUID and history —
 * so the synthesis-layer node keeps its identity but takes on the refined
 * content the user just shared.
 *
 * Handles the rare collision case where the new (kind, key) already maps
 * to a different existing row (e.g. user said "Writer" → "Horror writer"
 * but they already had "Horror writer" as a separate inferred fact). In
 * that case the in-place update would violate the unique constraint, so we
 * delete the stale source row and bump confidence on the collision target
 * instead. The UI still gets back a single "this is your refined neuron"
 * answer either way.
 */
async function applyInPlaceUpdate(client, userId, ctx) {
  const { oldRow, newText, newKind, newKey, reason, sourceId, existing, provenance } = ctx;
  const now = new Date();
  const nowIso = now.toISOString();

  // Build the provenance patch once — applied to both branches (collision
  // merge + plain rewrite) below. NULLs are intentional: an update with no
  // new provenance shouldn't blow away whatever the row already carries
  // (e.g. an old observed_by_clients set), so we conditionally include
  // only the fields the caller actually provided.
  const provPatch = {};
  if (provenance?.source) provPatch.source = provenance.source;
  if (provenance?.projectId) provPatch.project_id = provenance.projectId;
  if (provenance?.conversationId) provPatch.proposed_in_conversation_id = provenance.conversationId;
  if (provenance?.messageId) provPatch.proposed_in_message_id = provenance.messageId;

  const collision = existing.find((f) =>
    f.id !== oldRow.id && f.fact_kind === newKind && f.fact_key === newKey
  );

  if (collision) {
    // Merge: keep the collision target, fold the old row into it.
    const mergedEvidence = mergeEvidence(collision.evidence || [], [
      ...(oldRow.evidence || []),
      {
        source_type: 'conversation',
        source_id: sourceId,
        snippet: (reason || newText).slice(0, 240),
        observed_at: nowIso,
      },
    ]);
    const mergedSourceTypes = uniqueArray([
      ...(collision.source_types || []),
      ...(oldRow.source_types || []),
      'conversation',
    ]);

    const collisionStatus = collision.status === 'confirmed' || collision.status === 'corrected'
      ? collision.status
      : 'stated';
    const collisionConf = Math.max(collision.confidence || 0, 0.95);

    // Dedup-merge the incoming client into the collision row's
    // observed_by_clients[] set without clobbering whatever it had.
    const mergedObservedByClients = dedupMergeClient(
      collision.observed_by_clients,
      provenance?.source || null,
    );

    const { error: updErr } = await client
      .from('lykn_user_model_facts')
      .update({
        fact_text: newText,
        status: collisionStatus,
        confidence: collisionConf,
        evidence: mergedEvidence,
        evidence_count: (collision.evidence_count || 0) + (oldRow.evidence_count || 0) + 1,
        source_types: mergedSourceTypes,
        observed_by_clients: mergedObservedByClients,
        last_seen_at: nowIso,
        updated_at: nowIso,
        ...provPatch,
      })
      .eq('id', collision.id)
      .eq('user_id', userId);
    if (updErr) return { ok: false, reason: updErr.message };

    // Re-embed because the fact_text changed.
    embedAndPersistFact(client, {
      factId: collision.id,
      userId,
      factText: newText,
    }).catch(() => {});

    // Drop the stale source row — its content has been folded into the
    // collision target and keeping it around would leave a duplicate node
    // in the synthesis layer. We do NOT fail the whole update if the
    // delete is rejected (RLS, constraint, etc.) since the merge has
    // already succeeded; the worst case is a duplicate inferred row that
    // the next reconciler pass will collapse. Log so we can spot it.
    const { error: delErr } = await client
      .from('lykn_user_model_facts')
      .delete()
      .eq('id', oldRow.id)
      .eq('user_id', userId);
    if (delErr) {
      console.warn('⚠️ applyInPlaceUpdate stale-row delete failed:', delErr.message);
    }

    await writeRevision(client, userId, {
      trigger: 'feedback',
      factCount: Math.max(0, existing.length - 1),
      factsAdded: 0,
      factsUpdated: 1,
      factsDismissed: 0,
      diff: {
        live_updated_merged: {
          merged_into_id: collision.id,
          dropped_id: oldRow.id,
          previous_text: oldRow.fact_text,
          new_text: newText,
          new_kind: newKind,
          reason: reason || null,
        },
      },
    });

    return {
      ok: true,
      fact: {
        id: collision.id,
        fact_kind: newKind,
        fact_text: newText,
        status: collisionStatus,
        confidence: collisionConf,
        reason,
        isNew: false,
        isUpdate: true,
        previousText: oldRow.fact_text,
      },
    };
  }

  // Plain in-place rewrite — same UUID, new content.
  const newEvidence = mergeEvidence(oldRow.evidence || [], [{
    source_type: 'conversation',
    source_id: sourceId,
    snippet: (reason || newText).slice(0, 240),
    observed_at: nowIso,
  }]);
  const newSourceTypes = uniqueArray([
    ...(oldRow.source_types || []),
    'conversation',
  ]);
  const newObservedByClients = dedupMergeClient(
    oldRow.observed_by_clients,
    provenance?.source || null,
  );

  // Preserve user-pinned status (confirmed/corrected); otherwise promote
  // to 'stated' since the user just said the refined version out loud.
  const nextStatus = oldRow.status === 'confirmed' || oldRow.status === 'corrected'
    ? oldRow.status
    : 'stated';
  const nextConfidence = Math.max(oldRow.confidence || 0, 0.95);

  const { error: updErr } = await client
    .from('lykn_user_model_facts')
    .update({
      fact_kind: newKind,
      fact_text: newText,
      fact_key: newKey,
      status: nextStatus,
      confidence: nextConfidence,
      evidence: newEvidence,
      evidence_count: (oldRow.evidence_count || 0) + 1,
      source_types: newSourceTypes,
      observed_by_clients: newObservedByClients,
      last_seen_at: nowIso,
      updated_at: nowIso,
      ...provPatch,
    })
    .eq('id', oldRow.id)
    .eq('user_id', userId);
  if (updErr) return { ok: false, reason: updErr.message };

  embedAndPersistFact(client, {
    factId: oldRow.id,
    userId,
    factText: newText,
  }).catch(() => {});

  await writeRevision(client, userId, {
    trigger: 'feedback',
    factCount: existing.length,
    factsAdded: 0,
    factsUpdated: 1,
    factsDismissed: 0,
    diff: {
      live_updated: {
        fact_id: oldRow.id,
        previous_kind: oldRow.fact_kind,
        previous_text: oldRow.fact_text,
        new_kind: newKind,
        new_text: newText,
        reason: reason || null,
      },
    },
  });

  return {
    ok: true,
    fact: {
      id: oldRow.id,
      fact_kind: newKind,
      fact_text: newText,
      status: nextStatus,
      confidence: nextConfidence,
      reason,
      isNew: false,
      isUpdate: true,
      previousText: oldRow.fact_text,
    },
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchAllFacts(client, userId) {
  const { data, error } = await client
    .from('lykn_user_model_facts')
    .select('*')
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .limit(MAX_FACTS_PER_USER + 50);
  if (error) {
    console.warn('⚠️ fetchAllFacts:', error.message);
    return [];
  }
  return (data || []).map(normalizeFactRow);
}

function normalizeFactRow(row) {
  return {
    id: row.id,
    fact_kind: row.fact_kind,
    fact_text: row.fact_text,
    fact_key: row.fact_key,
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || CONFIDENCE_INITIAL,
    status: FACT_STATUSES.has(row.status) ? row.status : 'inferred',
    correction_text: row.correction_text || null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    evidence_count: Number(row.evidence_count) || 1,
    source_types: Array.isArray(row.source_types) ? row.source_types : [],
    observed_by_clients: Array.isArray(row.observed_by_clients) ? row.observed_by_clients : [],
    source: row.source || null,
    project_id: row.project_id || null,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

async function capFactsForUser(client, userId, upserts) {
  // If the upsert set itself fits, no eviction needed.
  if (upserts.length <= MAX_FACTS_PER_USER) return upserts;
  const sorted = upserts
    .slice()
    .sort((a, b) => {
      // Keep stated > confirmed > corrected > inferred (dismissed already filtered)
      const statusRank = { stated: 4, confirmed: 3, corrected: 2, inferred: 1, dismissed: 0 };
      const sd = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
      if (sd !== 0) return sd;
      return (b.confidence || 0) - (a.confidence || 0);
    })
    .slice(0, MAX_FACTS_PER_USER);
  return sorted;
}

async function persistFacts(client, userId, upserts, opts = {}) {
  if (!upserts.length) return { count: 0, error: null };
  const provenance = opts.provenance || null;
  const incomingClient = provenance?.source || null;

  // For dedup-merging observed_by_clients on upsert we need the prior
  // arrays. One range query keyed off the (kind, key) pairs in this
  // batch — cheaper and more correct than per-row reads. If a row is
  // brand new the lookup returns nothing and we start from [].
  let priorByCompositeKey = new Map();
  if (incomingClient || provenance) {
    const factKinds = Array.from(new Set(upserts.map((u) => u.fact_kind)));
    const factKeys = Array.from(new Set(upserts.map((u) => u.fact_key)));
    if (factKinds.length && factKeys.length) {
      const { data: priorRows } = await client
        .from('lykn_user_model_facts')
        .select('fact_kind, fact_key, observed_by_clients')
        .eq('user_id', userId)
        .in('fact_kind', factKinds)
        .in('fact_key', factKeys);
      for (const r of priorRows || []) {
        priorByCompositeKey.set(
          `${r.fact_kind}::${r.fact_key}`,
          Array.isArray(r.observed_by_clients) ? r.observed_by_clients : [],
        );
      }
    }
  }

  const rows = upserts.map((u) => {
    // Only include `id` when reconcileFacts gave us a real one (i.e. we're
    // updating an existing row). Brand-new facts come through with id
    // undefined; supabase-js serializes `id: undefined` as `"id": null`
    // which slams straight into the NOT NULL primary-key constraint and
    // rejects the entire upsert batch — that's the silent path that
    // surfaced as `persist_failed` even though every other column was
    // valid. Letting the column default (`gen_random_uuid()`) fire is
    // the correct behavior on the create path.
    const compositeKey = `${u.fact_kind}::${u.fact_key}`;
    const priorClients = priorByCompositeKey.get(compositeKey) || [];
    const observedByClients = dedupMergeClient(priorClients, incomingClient);

    const row = {
      user_id: userId,
      fact_kind: u.fact_kind,
      fact_text: u.fact_text,
      fact_key: u.fact_key,
      confidence: u.confidence,
      status: u.status || 'inferred',
      correction_text: u.correction_text || null,
      evidence: u.evidence || [],
      evidence_count: u.evidence_count || 1,
      source_types: u.source_types || [],
      first_seen_at: u.first_seen_at || new Date().toISOString(),
      last_seen_at: u.last_seen_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      observed_by_clients: observedByClients,
    };
    if (incomingClient) row.source = incomingClient;
    if (provenance?.projectId) row.project_id = provenance.projectId;
    if (provenance?.conversationId) row.proposed_in_conversation_id = provenance.conversationId;
    if (provenance?.messageId) row.proposed_in_message_id = provenance.messageId;
    if (u.id) row.id = u.id;
    return row;
  });
  // Upsert by (user_id, fact_kind, fact_key) — table has the matching unique constraint.
  const { data: upsertedRows, error } = await client
    .from('lykn_user_model_facts')
    .upsert(rows, { onConflict: 'user_id,fact_kind,fact_key' })
    .select('id, fact_kind, fact_key, fact_text');
  if (error) {
    console.warn('⚠️ persistFacts upsert:', error.message);
    return { count: 0, error: error.message || String(error) };
  }

  // Embed-on-write fan-out for the create-or-reinforce *batch* path
  // (the LLM reconciliation pass that lands many facts at once). The
  // single-fact MCP path is already handled by createOrReinforceFact;
  // this catches the bulk path so refresh runs don't ship facts
  // without embeddings either.
  if (opts.embedOnWrite !== false) {
    for (const r of upsertedRows || []) {
      embedAndPersistFact(client, {
        factId: r.id,
        userId,
        factText: r.fact_text,
      }).catch(() => {});
    }
  }

  return { count: rows.length, error: null };
}

async function writeRevision(client, userId, payload) {
  try {
    const { data, error } = await client
      .from('lykn_user_model_revisions')
      .insert({
        user_id: userId,
        trigger: payload.trigger,
        fact_count: payload.factCount || 0,
        facts_added: payload.factsAdded || 0,
        facts_updated: payload.factsUpdated || 0,
        facts_dismissed: payload.factsDismissed || 0,
        diff: payload.diff || {},
        summary: payload.summary || null,
      })
      .select('id')
      .single();
    if (error) {
      console.warn('⚠️ writeRevision:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.warn('⚠️ writeRevision threw:', e?.message || e);
    return null;
  }
}

async function trimOldRevisions(client, userId) {
  try {
    const { data } = await client
      .from('lykn_user_model_revisions')
      .select('id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(MAX_REVISIONS_PER_USER, MAX_REVISIONS_PER_USER + 100);
    const stale = (data || []).map((r) => r.id).filter(Boolean);
    if (!stale.length) return;
    await client.from('lykn_user_model_revisions').delete().in('id', stale).eq('user_id', userId);
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Feedback application (called by POST /api/synthesis/profile/facts/:id/feedback)
// ---------------------------------------------------------------------------

/**
 * Apply user feedback to a fact.
 *   action: 'confirm' | 'dismiss' | 'correct'
 *   correctionText: required when action === 'correct'
 *
 * Confirm  → status='confirmed', confidence=1.0
 * Dismiss  → status='dismissed', confidence=0
 *            (kept in row so reconciler suppresses re-emission)
 * Correct  → status='corrected', confidence=1.0, correction_text recorded.
 *            A NEW fact is created with the correction text + status='stated'.
 */
export async function applyFactFeedback(client, userId, factId, action, correctionText) {
  if (!client || !userId || !factId) return { ok: false, reason: 'bad_args' };
  const validActions = new Set(['confirm', 'dismiss', 'correct']);
  if (!validActions.has(action)) return { ok: false, reason: 'bad_action' };

  const { data: row, error: fetchErr } = await client
    .from('lykn_user_model_facts')
    .select('*')
    .eq('id', factId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr) return { ok: false, reason: fetchErr.message };
  if (!row) return { ok: false, reason: 'not_found' };

  const now = new Date().toISOString();

  if (action === 'confirm') {
    const { error } = await client
      .from('lykn_user_model_facts')
      .update({ status: 'confirmed', confidence: 1.0, last_seen_at: now, updated_at: now })
      .eq('id', factId)
      .eq('user_id', userId);
    if (error) return { ok: false, reason: error.message };
  } else if (action === 'dismiss') {
    const { error } = await client
      .from('lykn_user_model_facts')
      .update({ status: 'dismissed', confidence: 0, last_seen_at: now, updated_at: now })
      .eq('id', factId)
      .eq('user_id', userId);
    if (error) return { ok: false, reason: error.message };
  } else if (action === 'correct') {
    const text = String(correctionText || '').trim().slice(0, 240);
    if (!text) return { ok: false, reason: 'no_correction_text' };
    // Mark the original as corrected (so reconciler won't re-emit it as-is).
    const { error: e1 } = await client
      .from('lykn_user_model_facts')
      .update({ status: 'corrected', correction_text: text, confidence: 1.0, last_seen_at: now, updated_at: now })
      .eq('id', factId)
      .eq('user_id', userId);
    if (e1) return { ok: false, reason: e1.message };

    // Create a NEW stated fact carrying the corrected claim.
    const newKey = normalizeFactKey(text);
    const insertRow = {
      user_id: userId,
      fact_kind: row.fact_kind,
      fact_text: text,
      fact_key: newKey || `corrected_${factId}`.slice(0, 200),
      confidence: 1.0,
      status: 'stated',
      correction_text: null,
      evidence: [{ source_type: 'intake', source_id: 'user_correction', snippet: text, observed_at: now }],
      evidence_count: 1,
      source_types: ['intake'],
      first_seen_at: now,
      last_seen_at: now,
    };
    const { error: e2 } = await client
      .from('lykn_user_model_facts')
      .upsert(insertRow, { onConflict: 'user_id,fact_kind,fact_key' });
    if (e2) return { ok: false, reason: e2.message };
  }

  // Snapshot the feedback as its own revision so the diff log shows user action.
  await writeRevision(client, userId, {
    trigger: 'feedback',
    factCount: 0,
    factsAdded: action === 'correct' ? 1 : 0,
    factsUpdated: action === 'confirm' ? 1 : 0,
    factsDismissed: action === 'dismiss' ? 1 : 0,
    diff: {
      feedback: { action, fact_id: factId, correction_text: correctionText || null },
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Read helper for the UI (and for prompt injection)
// ---------------------------------------------------------------------------

/**
 * Returns active (non-dismissed) facts ranked for UI display.
 * Caller may filter by minConfidence or by kind.
 */
export async function listActiveFactsForUser(client, userId, opts = {}) {
  if (!client || !userId) return [];
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0;
  const limit = Math.min(Math.max(opts.limit || 200, 1), 500);
  const { data, error } = await client
    .from('lykn_user_model_facts')
    .select('id, fact_kind, fact_text, confidence, status, correction_text, evidence, evidence_count, source_types, first_seen_at, last_seen_at')
    .eq('user_id', userId)
    .neq('status', 'dismissed')
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false })
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('⚠️ listActiveFactsForUser:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Render a compact line-per-fact block suitable for the [USER_MODEL] prompt
 * section. Caps at maxChars. Prioritizes confirmed/stated > high-confidence
 * inferred. Skips facts below a soft confidence floor.
 */
export function formatFactsForPrompt(facts, maxChars = 1800) {
  if (!Array.isArray(facts) || !facts.length) return '';
  const ranked = facts
    .slice()
    .filter((f) => f.status !== 'dismissed' && (f.confidence ?? 0) >= 0.4)
    .sort((a, b) => {
      const sr = { stated: 4, confirmed: 3, corrected: 2, inferred: 1 };
      const ds = (sr[b.status] || 0) - (sr[a.status] || 0);
      if (ds !== 0) return ds;
      return (b.confidence || 0) - (a.confidence || 0);
    });

  const grouped = new Map();
  for (const f of ranked) {
    const arr = grouped.get(f.fact_kind) || [];
    if (arr.length < 6) arr.push(f);
    grouped.set(f.fact_kind, arr);
  }

  const order = ['identity', 'focus', 'goal', 'theme', 'preference', 'style', 'constraint', 'relationship'];
  const lines = [];
  for (const kind of order) {
    const arr = grouped.get(kind);
    if (!arr || !arr.length) continue;
    lines.push(`${capitalize(kind)}:`);
    for (const f of arr) {
      const tag = f.status === 'confirmed' ? '✓' : f.status === 'stated' ? '·' : '?';
      lines.push(`  ${tag} ${f.fact_text}`);
    }
  }
  let out = lines.join('\n').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

function capitalize(s) { return String(s || '').replace(/^./, (c) => c.toUpperCase()); }
