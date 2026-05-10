// ============================================
// LYKN — Belief Window system
// ============================================
// The layer ABOVE atomic facts. Implements Hyrum Smith's belief-window
// model on top of `lykn_user_model_facts`:
//
//   need (live | love | value | variety)
//     └── belief        ("Legacy tools are friction")
//           └── rule    ("If a UI requires >2 clicks, reject it")
//                 └── result_attribution (this AI message leaned on rule X)
//
// Three concerns live here:
//
//   1. PROMOTION  — Cluster active facts and propose 0..3 candidate beliefs
//                   per user (status='proposed'). The user ratifies in the UI.
//                   This is a periodic/triggered batch — it MUST NOT mint
//                   beliefs without user consent.
//
//   2. RULE PROPOSAL — For an active belief, propose 2-3 candidate
//                      if-then rules. Same ratify-in-UI pattern. Belief
//                      promotion creates beliefs in 'proposed' status with
//                      no rules; rules are proposed AFTER ratification so
//                      the user isn't drowned in unranked suggestions.
//
//   3. APPLIED-TAG RECORDING — When the chat model emits an
//      <applied rule_id="..."> tag mid-reply, record an attribution row
//      and bump the rule's invocation counter. Only ratified ('active')
//      rules qualify — the model can't fake-attribute unranked rules.
//
// Companion to userModelLearning.js (which owns facts) and server.js
// (which owns prompt injection + endpoints). This module is pure-Node,
// no Express dependency — server.js threads (client, userId) through.

import fetch from 'node-fetch';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NEEDS = ['live', 'love', 'value', 'variety'];
const NEED_SET = new Set(NEEDS);

const BELIEF_STATUSES = new Set(['proposed', 'active', 'retired', 'superseded']);
const RULE_STATUSES = new Set(['proposed', 'active', 'retired', 'draft']);

// Promotion gating — beliefs are conceptually expensive to mint (a wrong
// proposal that the user accepts pollutes the entire prompt-routing tier),
// so we run conservatively: at least N supporting facts before proposing,
// and we only return up to MAX_PROPOSAL_PER_PASS new candidates per pass.
const MIN_FACTS_TO_PROMOTE = 6;
const MAX_PROPOSAL_PER_PASS = 3;
const MAX_PROMOTED_FACTS_PER_BELIEF = 20;
const MAX_BELIEFS_PER_USER = 30;
const MAX_RULES_PER_BELIEF = 5;
const MAX_ACTIVE_RULES_FOR_PROMPT = 16;
const MAX_ATTRIBUTIONS_RETAINED = 500;

// Confidence tuning — kept small because beliefs/rules are USER-RATIFIED.
// Raw inferred confidence shouldn't snowball; user feedback should.
const BELIEF_REINFORCE_STEP = 0.06;
const BELIEF_PENALTY_STEP = 0.18;     // bad feedback bites harder than good rewards
const RULE_REINFORCE_STEP = 0.05;
const RULE_PENALTY_STEP = 0.22;
const RULE_RETIRE_FLOOR = 0.18;        // rules below this on bad feedback get auto-retired
const BELIEF_RETIRE_FLOOR = 0.15;      // ditto for beliefs

// ---------------------------------------------------------------------------
// Normalization helpers (mirror userModelLearning.normalizeFactKey)
// ---------------------------------------------------------------------------

export function normalizeBeliefKey(text) {
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

export function normalizeRuleKey(triggerText, actionText) {
  return normalizeBeliefKey(`${triggerText}::${actionText}`);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
}

function safeIsoDate(d) {
  if (!d) return new Date().toISOString();
  try { return new Date(d).toISOString(); } catch { return new Date().toISOString(); }
}

// ---------------------------------------------------------------------------
// Belief promotion — propose candidate beliefs from a fact cluster
// ---------------------------------------------------------------------------

const BELIEF_PROMOTION_SYSTEM = `You promote durable PRINCIPLES from a user's atomic facts for an AI workspace called LYKN.

You read a list of things we know about ONE user (identity, focus, themes, preferences, constraints, goals) and propose 0–3 BELIEFS — short, durable principles that explain a pattern across MULTIPLE facts.

A BELIEF is NOT a fact. A fact is "I work as a designer." A belief is the worldview that explains many facts at once: "Visual thinking beats text-first thinking" or "Legacy tools are friction" or "Shipping matters more than polishing." It's a generalization the user IMPLIES but probably wouldn't write themselves.

Output ONLY valid JSON:
{
  "beliefs": [
    {
      "text": "short, third-person, principle-shaped statement (max 110 chars). Example: 'Legacy tools are friction'",
      "serves_need": "live" | "love" | "value" | "variety",
      "rationale": "one sentence (max 30 words) explaining the pattern across the supporting facts",
      "supporting_fact_ids": ["uuid1", "uuid2", ...]   // ids from <fact id="..."> in the input
    }
  ]
}

The four NEEDS (Hyrum Smith): pick the ONE this belief most directly serves —
- live    : survival, safety, security, sustainability, financial / time stability
- love    : connection, belonging, being known, relationships, community
- value   : feeling important, capable, that one's work matters, identity-of-craft
- variety : novelty, change, agency to choose differently, expression, exploration

RULES:
- 0–3 beliefs per pass. Quality over quantity. If no clear pattern emerges, return [].
- Each belief must be supported by AT LEAST 2 of the input facts. Cite their ids in supporting_fact_ids.
- Do NOT propose a belief that is just a re-phrasing of one fact. Beliefs generalize.
- Do NOT re-emit any belief listed in <existing_beliefs> — propose only NEW patterns.
- Avoid pop-psychology platitudes ("self-care matters"). Beliefs must be SPECIFIC enough to imply rules later.
- Third person, present tense. No quoted speech, no "the user believes…" preamble.
- Lean toward beliefs that would change HOW THE AI RESPONDS to this user, not generic life lessons.`;

/**
 * Build the evidence block the promoter LLM reads.
 * Caller is responsible for ensuring `facts` is the list of currently
 * active (non-dismissed) facts for this user.
 */
function buildPromotionEvidence(facts, existingBeliefs) {
  const factLines = facts.slice(0, 60).map((f) => {
    return `<fact id="${f.id}" kind="${f.fact_kind}" status="${f.status}" conf="${(f.confidence ?? 0).toFixed(2)}">${f.fact_text}</fact>`;
  });
  const existingLines = (existingBeliefs || []).slice(0, 30).map((b) => {
    return `- [${b.serves_need} · ${b.status}] ${b.belief_text}`;
  });
  return [
    `<existing_beliefs>\n${existingLines.length ? existingLines.join('\n') : '(none yet)'}\n</existing_beliefs>`,
    `<facts>\n${factLines.join('\n')}\n</facts>`,
  ].join('\n\n');
}

/**
 * Run one promotion pass. Reads active facts + active beliefs, asks the LLM
 * for 0..3 candidates, persists them as status='proposed'. Returns
 * { ok, proposedCount, beliefIds }.
 *
 * Triggers (set by caller):
 *   • Periodic — after a learning pass, when at least MIN_FACTS_TO_PROMOTE
 *     facts exist and no proposal has been made in >24h.
 *   • Manual — user clicks "Look for new beliefs" in the Belief Window UI.
 */
export async function runBeliefPromotionPass(client, userId, opts = {}) {
  if (!client || !userId) return { ok: false, reason: 'no_args' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_openai' };

  const facts = await fetchActiveFactsForPromotion(client, userId);
  if (facts.length < MIN_FACTS_TO_PROMOTE) {
    return { ok: true, reason: 'insufficient_facts', proposedCount: 0 };
  }

  const existingBeliefs = await fetchAllBeliefs(client, userId);
  const evidence = buildPromotionEvidence(facts, existingBeliefs);

  let llmRes;
  try {
    llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        prompt_cache_key: `belief-promotion:${userId}`,
        messages: [
          { role: 'system', content: BELIEF_PROMOTION_SYSTEM },
          { role: 'user', content: evidence },
        ],
      }),
    });
  } catch (e) {
    console.warn('⚠️ runBeliefPromotionPass fetch:', e?.message || e);
    return { ok: false, reason: 'llm_fetch_failed' };
  }
  if (!llmRes.ok) {
    console.warn('⚠️ runBeliefPromotionPass HTTP', llmRes.status);
    return { ok: false, reason: 'llm_http' };
  }
  let llmData;
  let parsed;
  try {
    llmData = await llmRes.json();
    parsed = JSON.parse(llmData?.choices?.[0]?.message?.content || '{}');
  } catch {
    return { ok: false, reason: 'llm_parse_failed' };
  }

  if (typeof opts.usageLogger === 'function') {
    try {
      const u = llmData?.usage || {};
      opts.usageLogger({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        metadata: { kind: 'belief_promotion' },
      });
    } catch { /* ignore */ }
  }

  const candidates = Array.isArray(parsed?.beliefs) ? parsed.beliefs : [];
  if (!candidates.length) {
    return { ok: true, reason: 'no_candidates', proposedCount: 0 };
  }

  const existingByKey = new Map(existingBeliefs.map((b) => [b.belief_key, b]));
  const factIdSet = new Set(facts.map((f) => f.id));
  const inserted = [];

  for (const raw of candidates.slice(0, MAX_PROPOSAL_PER_PASS)) {
    const text = String(raw?.text || '').trim().slice(0, 140);
    if (!text) continue;
    const need = String(raw?.serves_need || '').trim().toLowerCase();
    if (!NEED_SET.has(need)) continue;
    const key = normalizeBeliefKey(text);
    if (!key) continue;
    if (existingByKey.has(key)) continue;
    const supporting = (Array.isArray(raw?.supporting_fact_ids) ? raw.supporting_fact_ids : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && factIdSet.has(id))
      .slice(0, MAX_PROMOTED_FACTS_PER_BELIEF);
    if (supporting.length < 2) continue;

    const rationale = String(raw?.rationale || '').trim().slice(0, 240) || null;

    // Pull existing proposed_by_clients to dedup-merge "lykn-promotion"
    // into it without clobbering anything earlier clients added.
    const { data: priorRow } = await client
      .from('lykn_beliefs')
      .select('proposed_by_clients')
      .eq('user_id', userId)
      .eq('belief_key', key)
      .maybeSingle();
    const priorClients = Array.isArray(priorRow?.proposed_by_clients)
      ? priorRow.proposed_by_clients
      : [];
    const proposedByClients = priorClients.includes('lykn-promotion')
      ? priorClients
      : [...priorClients, 'lykn-promotion'].slice(0, 8);

    const insertRow = {
      user_id: userId,
      belief_text: text,
      belief_key: key,
      serves_need: need,
      status: 'proposed',
      confidence: 0.5,
      promoted_from_facts: supporting,
      rationale,
      first_seen_at: new Date().toISOString(),
      source: 'lykn-promotion',
      proposed_by_clients: proposedByClients,
    };

    const { data, error } = await client
      .from('lykn_beliefs')
      .upsert(insertRow, { onConflict: 'user_id,belief_key' })
      .select('id, belief_text, belief_key, serves_need, status, rationale')
      .maybeSingle();
    if (error) {
      console.warn('⚠️ belief insert:', error.message);
      continue;
    }
    if (data) inserted.push(data);
  }

  return {
    ok: true,
    proposedCount: inserted.length,
    proposed: inserted,
  };
}

// ---------------------------------------------------------------------------
// Rule proposal — for an ACTIVE belief, propose 2-3 candidate rules
// ---------------------------------------------------------------------------

const RULE_PROPOSAL_SYSTEM = `You convert a single belief into 2–3 IF-THEN RULES that an AI assistant can follow when responding to one specific user.

A rule is a precise behavior, not a slogan. Each rule has:
- A trigger (when does this rule apply?) — short pattern the AI checks against the user's current message + context.
- An action (what does the AI do differently because of this belief?) — concrete, observable, falsifiable behavior.

Output ONLY valid JSON:
{
  "rules": [
    {
      "trigger_text": "short trigger pattern, ≤120 chars",
      "action_text": "short concrete action, ≤160 chars"
    }
  ]
}

RULES:
- 2–3 rules per belief. Skip rules that are vague or impossible to fire.
- Triggers should describe the SHAPE of an input ("user asks for a multi-click flow", "user is choosing between options"), not the topic ("design questions").
- Actions should describe an OBSERVABLE behavior change, not an attitude ("propose an agentic alternative" not "be efficiency-minded").
- Avoid duplicating any rule listed in <existing_rules>.
- Do NOT include trailing punctuation in trigger_text or action_text.
- Third person; do NOT address the user.`;

export async function proposeRulesForBelief(client, userId, beliefId, opts = {}) {
  if (!client || !userId || !beliefId) return { ok: false, reason: 'no_args' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_openai' };

  const { data: belief, error: bErr } = await client
    .from('lykn_beliefs')
    .select('id, belief_text, serves_need, rationale, status')
    .eq('id', beliefId)
    .eq('user_id', userId)
    .maybeSingle();
  if (bErr || !belief) return { ok: false, reason: 'belief_not_found' };
  if (belief.status === 'retired' || belief.status === 'superseded') {
    return { ok: false, reason: 'belief_not_active' };
  }

  const { data: existingRules } = await client
    .from('lykn_rules')
    .select('rule_key, trigger_text, action_text, status')
    .eq('belief_id', beliefId)
    .eq('user_id', userId);
  const existingByKey = new Map((existingRules || []).map((r) => [r.rule_key, r]));

  const evidence = [
    `<belief>\n  text: ${belief.belief_text}\n  serves_need: ${belief.serves_need}\n  rationale: ${belief.rationale || '(none)'}\n</belief>`,
    `<existing_rules>\n${(existingRules || []).map((r) => `- IF ${r.trigger_text} THEN ${r.action_text} (${r.status})`).join('\n') || '(none yet)'}\n</existing_rules>`,
  ].join('\n\n');

  let llmRes;
  try {
    llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        prompt_cache_key: `rule-proposal:${userId}`,
        messages: [
          { role: 'system', content: RULE_PROPOSAL_SYSTEM },
          { role: 'user', content: evidence },
        ],
      }),
    });
  } catch (e) {
    console.warn('⚠️ proposeRulesForBelief fetch:', e?.message || e);
    return { ok: false, reason: 'llm_fetch_failed' };
  }
  if (!llmRes.ok) return { ok: false, reason: 'llm_http' };
  let llmData;
  let parsed;
  try {
    llmData = await llmRes.json();
    parsed = JSON.parse(llmData?.choices?.[0]?.message?.content || '{}');
  } catch {
    return { ok: false, reason: 'llm_parse_failed' };
  }

  if (typeof opts.usageLogger === 'function') {
    try {
      const u = llmData?.usage || {};
      opts.usageLogger({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        metadata: { kind: 'rule_proposal', belief_id: beliefId },
      });
    } catch { /* ignore */ }
  }

  const candidates = Array.isArray(parsed?.rules) ? parsed.rules : [];
  const inserted = [];
  for (const raw of candidates.slice(0, MAX_RULES_PER_BELIEF)) {
    const trig = String(raw?.trigger_text || '').trim().replace(/[.!?]+$/, '').slice(0, 200);
    const act  = String(raw?.action_text  || '').trim().replace(/[.!?]+$/, '').slice(0, 240);
    if (!trig || !act) continue;
    const key = normalizeRuleKey(trig, act);
    if (!key || existingByKey.has(key)) continue;

    const insertRow = {
      user_id: userId,
      belief_id: beliefId,
      trigger_text: trig,
      action_text: act,
      rule_key: key,
      status: 'proposed',
      confidence: 0.5,
      priority: 100,
    };
    const { data, error } = await client
      .from('lykn_rules')
      .upsert(insertRow, { onConflict: 'belief_id,rule_key' })
      .select('id, trigger_text, action_text, status')
      .maybeSingle();
    if (error) {
      console.warn('⚠️ rule insert:', error.message);
      continue;
    }
    if (data) inserted.push(data);
  }

  return { ok: true, proposedCount: inserted.length, proposed: inserted };
}

// ---------------------------------------------------------------------------
// Belief / rule lifecycle (ratify, retire, edit)
// ---------------------------------------------------------------------------

/** Ratify a proposed belief into 'active' (and optionally trigger rule proposal). */
export async function ratifyBelief(client, userId, beliefId, opts = {}) {
  if (!client || !userId || !beliefId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const { data: row, error } = await client
    .from('lykn_beliefs')
    .update({ status: 'active', ratified_at: now, updated_at: now, ratified_by: 'user' })
    .eq('id', beliefId)
    .eq('user_id', userId)
    .select('id, belief_text, serves_need, status')
    .maybeSingle();
  if (error || !row) return { ok: false, reason: error?.message || 'not_found' };

  // Cap active beliefs — retire the lowest-confidence active one if we're over.
  await capActiveBeliefs(client, userId);

  let proposed = null;
  if (opts.autoProposeRules !== false) {
    proposed = await proposeRulesForBelief(client, userId, beliefId, { usageLogger: opts.usageLogger });
  }

  return { ok: true, belief: row, proposedRules: proposed?.proposed || [] };
}

/** Retire a belief (and cascade-retire its rules). */
export async function retireBelief(client, userId, beliefId) {
  if (!client || !userId || !beliefId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const { error } = await client
    .from('lykn_beliefs')
    .update({ status: 'retired', retired_at: now, updated_at: now, confidence: 0 })
    .eq('id', beliefId)
    .eq('user_id', userId);
  if (error) return { ok: false, reason: error.message };
  await client
    .from('lykn_rules')
    .update({ status: 'retired', retired_at: now, updated_at: now })
    .eq('belief_id', beliefId)
    .eq('user_id', userId);
  return { ok: true };
}

/**
 * Allow user to edit a belief's text and/or which need it serves in place
 * (preserves identity / supporting facts). Both fields are optional — pass
 * whichever ones the UI changed. Empty string in `text` is a no-op for that
 * field; passing `null`/undefined is also a no-op.
 *
 * Accepts either the legacy positional signature `(client, userId, id, text)`
 * or the patch signature `(client, userId, id, { text, servesNeed })`.
 */
export async function editBeliefText(client, userId, beliefId, patchOrText) {
  if (!client || !userId || !beliefId) return { ok: false, reason: 'no_args' };
  const patch = (typeof patchOrText === 'string' || patchOrText == null)
    ? { text: patchOrText }
    : (patchOrText || {});
  const update = { updated_at: new Date().toISOString() };

  if (typeof patch.text === 'string' && patch.text.trim()) {
    const text = patch.text.trim().slice(0, 140);
    const key = normalizeBeliefKey(text);
    if (!key) return { ok: false, reason: 'unkeyable_text' };
    update.belief_text = text;
    update.belief_key = key;
  }

  if (typeof patch.servesNeed === 'string') {
    const need = patch.servesNeed.trim().toLowerCase();
    if (!NEED_SET.has(need)) return { ok: false, reason: 'bad_need' };
    update.serves_need = need;
  }

  if (Object.keys(update).length === 1) {
    return { ok: false, reason: 'no_changes' };
  }

  const { data, error } = await client
    .from('lykn_beliefs')
    .update(update)
    .eq('id', beliefId)
    .eq('user_id', userId)
    .select('id, belief_text, belief_key, serves_need, status')
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, belief: data };
}

/**
 * User-authored belief — created directly from the Belief Window UI without
 * going through the LLM promotion pipeline. Lands in `active` status with a
 * relatively high baseline confidence (the user wrote it, so we trust it
 * more than an inferred candidate) and no supporting facts. Optionally
 * triggers rule proposal so the new belief comes with starter rules.
 *
 * `text` and `servesNeed` are required. Returns the upserted row.
 *
 * If a belief with the same normalized key already exists for this user it
 * is "revived" — flipped to active and confidence floored, rather than
 * silently failing on the unique constraint.
 */
export async function createManualBelief(client, userId, payload = {}, opts = {}) {
  if (!client || !userId) return { ok: false, reason: 'no_args' };
  const text = String(payload?.text || '').trim().slice(0, 140);
  if (!text) return { ok: false, reason: 'empty_text' };
  const need = String(payload?.servesNeed || '').trim().toLowerCase();
  if (!NEED_SET.has(need)) return { ok: false, reason: 'bad_need' };
  const key = normalizeBeliefKey(text);
  if (!key) return { ok: false, reason: 'unkeyable_text' };
  const rationale = String(payload?.rationale || '').trim().slice(0, 240) || 'User-authored belief.';

  const now = new Date().toISOString();

  // Merge "manual" into proposed_by_clients without clobbering whatever
  // an earlier MCP client may have surfaced for the same belief_key.
  const { data: priorRow } = await client
    .from('lykn_beliefs')
    .select('proposed_by_clients')
    .eq('user_id', userId)
    .eq('belief_key', key)
    .maybeSingle();
  const priorClients = Array.isArray(priorRow?.proposed_by_clients)
    ? priorRow.proposed_by_clients
    : [];
  const proposedByClients = priorClients.includes('manual')
    ? priorClients
    : [...priorClients, 'manual'].slice(0, 8);

  const insertRow = {
    user_id: userId,
    belief_text: text,
    belief_key: key,
    serves_need: need,
    status: 'active',
    confidence: 0.85,
    promoted_from_facts: [],
    rationale,
    first_seen_at: now,
    ratified_at: now,
    updated_at: now,
    source: 'manual',
    proposed_by_clients: proposedByClients,
    ratified_by: 'manual',
  };

  const { data, error } = await client
    .from('lykn_beliefs')
    .upsert(insertRow, { onConflict: 'user_id,belief_key' })
    .select('id, belief_text, belief_key, serves_need, status, confidence, rationale, created_at, ratified_at')
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: 'insert_failed' };

  await capActiveBeliefs(client, userId);

  let proposedRules = [];
  if (opts.autoProposeRules !== false) {
    const r = await proposeRulesForBelief(client, userId, data.id, { usageLogger: opts.usageLogger });
    proposedRules = r?.proposed || [];
  }

  return { ok: true, belief: data, proposedRules };
}

export async function ratifyRule(client, userId, ruleId) {
  if (!client || !userId || !ruleId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('lykn_rules')
    .update({ status: 'active', ratified_at: now, updated_at: now })
    .eq('id', ruleId)
    .eq('user_id', userId)
    .select('id, trigger_text, action_text, status, belief_id')
    .maybeSingle();
  if (error || !data) return { ok: false, reason: error?.message || 'not_found' };
  return { ok: true, rule: data };
}

export async function retireRule(client, userId, ruleId) {
  if (!client || !userId || !ruleId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const { error } = await client
    .from('lykn_rules')
    .update({ status: 'retired', retired_at: now, updated_at: now, confidence: 0 })
    .eq('id', ruleId)
    .eq('user_id', userId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

export async function editRule(client, userId, ruleId, patch) {
  if (!client || !userId || !ruleId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const update = { updated_at: now };
  if (typeof patch?.trigger_text === 'string') {
    update.trigger_text = patch.trigger_text.trim().replace(/[.!?]+$/, '').slice(0, 200);
  }
  if (typeof patch?.action_text === 'string') {
    update.action_text = patch.action_text.trim().replace(/[.!?]+$/, '').slice(0, 240);
  }
  if (Number.isFinite(patch?.priority)) update.priority = clamp(patch.priority, 1, 1000);
  if (update.trigger_text || update.action_text) {
    const { data: cur } = await client
      .from('lykn_rules')
      .select('trigger_text, action_text')
      .eq('id', ruleId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!cur) return { ok: false, reason: 'not_found' };
    const trig = update.trigger_text || cur.trigger_text;
    const act = update.action_text || cur.action_text;
    update.rule_key = normalizeRuleKey(trig, act);
  }
  const { data, error } = await client
    .from('lykn_rules')
    .update(update)
    .eq('id', ruleId)
    .eq('user_id', userId)
    .select('id, trigger_text, action_text, status, priority')
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, rule: data };
}

/** Apply user feedback to an attribution row, walking the repair loop. */
export async function applyAttributionFeedback(client, userId, attributionId, payload) {
  if (!client || !userId || !attributionId) return { ok: false, reason: 'no_args' };
  const validActions = new Set(['good', 'bad']);
  const action = String(payload?.action || '').toLowerCase();
  if (!validActions.has(action)) return { ok: false, reason: 'bad_action' };
  const ruleWasBad = action === 'bad' && Boolean(payload?.ruleWasBad);
  const beliefWasBad = action === 'bad' && Boolean(payload?.beliefWasBad);
  const note = String(payload?.note || '').trim().slice(0, 480) || null;
  const now = new Date().toISOString();

  const { data: row, error: fetchErr } = await client
    .from('lykn_result_attributions')
    .select('id, rule_id, belief_id')
    .eq('id', attributionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr || !row) return { ok: false, reason: fetchErr?.message || 'not_found' };

  const { error: updErr } = await client
    .from('lykn_result_attributions')
    .update({
      user_feedback: action,
      rule_was_bad: ruleWasBad,
      belief_was_bad: beliefWasBad,
      feedback_note: note,
      feedback_at: now,
    })
    .eq('id', attributionId)
    .eq('user_id', userId);
  if (updErr) return { ok: false, reason: updErr.message };

  // Walk the repair chain — counters + confidence + (optional) auto-retirement.
  if (row.rule_id) {
    await adjustRuleAfterFeedback(client, userId, row.rule_id, action, ruleWasBad);
  }
  if (row.belief_id) {
    await adjustBeliefAfterFeedback(client, userId, row.belief_id, action, beliefWasBad);
  }

  return { ok: true };
}

async function adjustRuleAfterFeedback(client, userId, ruleId, action, ruleWasBad) {
  const { data: rule } = await client
    .from('lykn_rules')
    .select('id, confidence, good_feedback_count, bad_feedback_count, status')
    .eq('id', ruleId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!rule) return;
  let nextConf = rule.confidence ?? 0.5;
  let nextStatus = rule.status;
  const upd = {
    updated_at: new Date().toISOString(),
  };
  if (action === 'good') {
    nextConf = clamp(nextConf + RULE_REINFORCE_STEP, 0, 1);
    upd.good_feedback_count = (rule.good_feedback_count || 0) + 1;
  } else if (action === 'bad' && ruleWasBad) {
    // Only penalize the rule when the user explicitly faulted it. A "bad"
    // attribution where neither rule_was_bad nor belief_was_bad is set is
    // a generation miss; neither side of the chain deserves to be poisoned.
    nextConf = clamp(nextConf - RULE_PENALTY_STEP, 0, 1);
    upd.bad_feedback_count = (rule.bad_feedback_count || 0) + 1;
    if (nextConf < RULE_RETIRE_FLOOR && rule.status === 'active') {
      nextStatus = 'retired';
      upd.retired_at = new Date().toISOString();
    }
  }
  upd.confidence = nextConf;
  upd.status = nextStatus;
  await client.from('lykn_rules').update(upd).eq('id', ruleId).eq('user_id', userId);
}

async function adjustBeliefAfterFeedback(client, userId, beliefId, action, beliefWasBad) {
  const { data: belief } = await client
    .from('lykn_beliefs')
    .select('id, confidence, good_feedback_count, bad_feedback_count, status')
    .eq('id', beliefId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!belief) return;
  let nextConf = belief.confidence ?? 0.5;
  let nextStatus = belief.status;
  const upd = { updated_at: new Date().toISOString() };
  if (action === 'good') {
    nextConf = clamp(nextConf + BELIEF_REINFORCE_STEP, 0, 1);
    upd.good_feedback_count = (belief.good_feedback_count || 0) + 1;
  } else if (action === 'bad' && beliefWasBad) {
    // Same honesty principle as adjustRuleAfterFeedback — only penalize
    // when the user explicitly faulted the belief.
    nextConf = clamp(nextConf - BELIEF_PENALTY_STEP, 0, 1);
    upd.bad_feedback_count = (belief.bad_feedback_count || 0) + 1;
    if (nextConf < BELIEF_RETIRE_FLOOR && belief.status === 'active') {
      nextStatus = 'retired';
      upd.retired_at = new Date().toISOString();
    }
  }
  upd.confidence = nextConf;
  upd.status = nextStatus;
  await client.from('lykn_beliefs').update(upd).eq('id', beliefId).eq('user_id', userId);
}

// ---------------------------------------------------------------------------
// Applied-tag recording — only ratified rules can attribute
// ---------------------------------------------------------------------------

/**
 * Record that a chat reply leaned on a specific rule. Validates the rule
 * exists, is active, and belongs to the user — anything else is dropped
 * silently so a misbehaving model can't fake attributions.
 *
 * Bumps:
 *   • rule.invocation_count + last_fired_at
 *   • belief.invocation_count + last_invoked_at
 * Inserts a row in lykn_result_attributions.
 *
 * Returns { ok, attribution } on success or { ok: false, reason } on miss.
 */
export async function recordRuleApplication(client, userId, payload) {
  if (!client || !userId) return { ok: false, reason: 'no_args' };
  const ruleId = String(payload?.ruleId || '').trim();
  const messageId = String(payload?.messageId || '').trim().slice(0, 200);
  const surface = String(payload?.surface || '').trim().slice(0, 80) || null;
  const surfaceId = String(payload?.surfaceId || '').trim().slice(0, 200) || null;
  const reason = String(payload?.reason || '').trim().slice(0, 480) || null;
  if (!ruleId) return { ok: false, reason: 'rule_required' };
  if (!messageId) return { ok: false, reason: 'message_required' };

  const { data: rule, error: rErr } = await client
    .from('lykn_rules')
    .select('id, belief_id, trigger_text, action_text, status')
    .eq('id', ruleId)
    .eq('user_id', userId)
    .maybeSingle();
  if (rErr || !rule) return { ok: false, reason: 'rule_not_found' };
  if (rule.status !== 'active') return { ok: false, reason: 'rule_not_active' };

  const { data: belief } = await client
    .from('lykn_beliefs')
    .select('id, belief_text, serves_need, status')
    .eq('id', rule.belief_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!belief || belief.status !== 'active') return { ok: false, reason: 'belief_not_active' };

  const ruleSnapshot = `IF ${rule.trigger_text} THEN ${rule.action_text}`.slice(0, 480);
  const beliefSnapshot = String(belief.belief_text || '').slice(0, 240);

  const { data: inserted, error: insErr } = await client
    .from('lykn_result_attributions')
    .insert({
      user_id: userId,
      message_id: messageId,
      surface,
      surface_id: surfaceId,
      rule_id: rule.id,
      belief_id: belief.id,
      rule_snapshot: ruleSnapshot,
      belief_snapshot: beliefSnapshot,
      serves_need: belief.serves_need,
      reason,
    })
    .select('id, message_id, rule_id, belief_id, rule_snapshot, belief_snapshot, serves_need, reason, created_at')
    .single();
  if (insErr) {
    console.warn('⚠️ recordRuleApplication insert:', insErr.message);
    return { ok: false, reason: insErr.message };
  }

  // Bump counters; failures here should NOT hide the attribution from the user.
  const now = new Date().toISOString();
  await client
    .from('lykn_rules')
    .update({
      invocation_count: ((rule.invocation_count ?? 0) + 1),
      last_fired_at: now,
      updated_at: now,
    })
    .eq('id', rule.id)
    .eq('user_id', userId);
  await client
    .from('lykn_beliefs')
    .update({
      invocation_count: ((belief.invocation_count ?? 0) + 1),
      last_invoked_at: now,
      updated_at: now,
    })
    .eq('id', belief.id)
    .eq('user_id', userId);

  await trimOldAttributions(client, userId);

  return { ok: true, attribution: inserted };
}

// ---------------------------------------------------------------------------
// Prompt formatting — [BELIEFS_AND_RULES] section
// ---------------------------------------------------------------------------

/**
 * Shared body of the [BELIEFS_AND_RULES] block — list of beliefs + their
 * rules, capped to opts.maxChars and MAX_ACTIVE_RULES_FOR_PROMPT. Header
 * + attribution-mechanic instructions are surface-specific (in-LYKN chat
 * uses a hidden <applied> tag; outside clients use a tool call), so each
 * caller layers its own preamble on top of this shared body.
 *
 * Returns null when there are no active beliefs (caller decides whether
 * to emit an empty section header or nothing at all).
 */
function buildBeliefsAndRulesBody(beliefs, rules, opts = {}) {
  const activeBeliefs = (beliefs || []).filter((b) => b.status === 'active');
  if (!activeBeliefs.length) return null;
  const rulesByBelief = new Map();
  for (const r of (rules || [])) {
    if (r.status !== 'active') continue;
    const arr = rulesByBelief.get(r.belief_id) || [];
    if (arr.length < 4) arr.push(r);
    rulesByBelief.set(r.belief_id, arr);
  }
  const blocks = [];
  let totalLen = 0;
  let active = 0;
  for (const b of activeBeliefs) {
    const ruleArr = rulesByBelief.get(b.id) || [];
    const ruleLines = ruleArr.length
      ? ruleArr.map((r) => `    · rule_id=${r.id} :: IF ${r.trigger_text} THEN ${r.action_text}`)
      : ['    · (no active rules — answer in the spirit of the belief)'];
    const block = [
      `- belief [need=${b.serves_need}]: ${b.belief_text}`,
      ...ruleLines,
    ].join('\n');
    if (totalLen + block.length > (opts.maxChars || 2400)) break;
    blocks.push(block);
    totalLen += block.length;
    active += 1;
    if (active >= MAX_ACTIVE_RULES_FOR_PROMPT) break;
  }
  return blocks.join('\n');
}

/**
 * Render the active beliefs (+ their active rules) into the compact prompt
 * block injected on every IN-LYKN turn. Designed to be ~400 tokens or less
 * in the common case so it can sit at the top of the prompt without
 * crowding out conversation context.
 *
 * Format gives the LLM enough structure to (a) decide when to fire a rule
 * and (b) emit the matching <applied rule_id="..."> tag if it does. The
 * tag is parsed server-side after the stream completes (we control both
 * ends in the in-LYKN path).
 */
export function formatBeliefsAndRulesForPrompt(beliefs, rules, opts = {}) {
  const body = buildBeliefsAndRulesBody(beliefs, rules, opts);
  if (!body) return '';
  const lines = [
    '[BELIEFS_AND_RULES]',
    'The user\'s ratified principles + the if-then rules they\'ve agreed should shape your behavior.',
    'PREFER answering through these. Only consult [USER_MODEL] long-tail facts when this section can\'t cover the question.',
    'When you DO follow a rule, end your reply with a single hidden tag:',
    '  <applied rule_id="<uuid>">one short sentence (≤25 words) explaining HOW the rule shaped this reply</applied>',
    'Use a rule_id from the list below. Do NOT invent rule_ids. No tag = honest "this reply was not rule-driven".',
    '',
    body,
  ];
  return lines.join('\n').trim();
}

/**
 * Same body as `formatBeliefsAndRulesForPrompt`, but the trailing
 * attribution mechanic is rephrased for OUTSIDE-CLIENT models (Claude.ai,
 * Cursor, Claude Code, ChatGPT, etc.) reaching LYKN via MCP / REST.
 *
 * Outside the LYKN process there is no post-stream tag parser — we cannot
 * strip / parse `<applied>` tags from someone else's chat surface. So the
 * outside-client variant tells the model to **call the MCP tool**
 * `lykn_recordRuleApplication` instead. Same `recordRuleApplication`
 * function ends up writing to `lykn_result_attributions`; the only
 * difference is how the model signals "I just used a rule".
 *
 * Used by:
 *   • mcp-tools/getContextBlock.js (the explicit "load context" tool)
 *   • Anywhere LYKN ships a system-prompt block to an external client
 */
export function formatBeliefsAndRulesForPromptOutsideClient(beliefs, rules, opts = {}) {
  const body = buildBeliefsAndRulesBody(beliefs, rules, opts);
  const projectBlock = formatProjectStateForPromptOutsideClient(opts.projectContext);

  // If neither beliefs nor a project exist, the prompt block has nothing
  // to say — return empty so callers can decide whether to emit anything
  // at all (mcp-tools/getContextBlock.js handles the "no beliefs yet"
  // case explicitly with a friendlier message).
  if (!body && !projectBlock) return '';

  const lines = [];

  if (body) {
    lines.push(
      '[BELIEFS_AND_RULES]',
      'These are the LYKN user\'s ratified principles + the if-then rules they\'ve agreed should shape an AI\'s replies.',
      'PREFER answering through these. They are user-ratified, falsifiable, and revocable.',
      '',
      'When a reply is materially shaped by one of the rules below, call the MCP tool:',
      '  lykn_recordRuleApplication({ rule_id: "<uuid>", message_id: "<your reply id>", reason: "<≤25 words on how the rule shaped this reply>" })',
      'Use a rule_id from the list below verbatim. Do NOT invent rule_ids.',
      '',
      'Honesty over attribution: if your reply was generic and didn\'t actually lean on a rule, do NOT call the tool — most turns are not rule-driven and that\'s expected.',
      '',
      body,
    );
  }

  if (projectBlock) {
    if (lines.length) lines.push('', '');
    lines.push(projectBlock);
  }

  return lines.join('\n').trim();
}

/**
 * Format the user's active project + its current state as a prompt
 * block suitable for outside-AI clients. Returns '' when there's no
 * active project or when the project has no state pushes yet.
 *
 *   projectContext = {
 *     project: { id, name, description, last_active_at, ... },
 *     state:   { tech_stack: { value, set_by_client, set_at }, ... }
 *   }
 *
 * The block tells the model TWO things:
 *   1. What's already known about this project (state kv-pairs).
 *   2. How to push back when this conversation produces a new decision
 *      (lykn_pushProjectState contract, named so the model can find
 *      and call it without re-reading tool descriptors mid-turn).
 *
 * Keep this terse. It runs before BELIEFS_AND_RULES, takes ~150–400
 * tokens depending on state count, and is included in EVERY
 * getContextBlock response — so density matters.
 */
export function formatProjectStateForPromptOutsideClient(projectContext) {
  if (!projectContext || !projectContext.project) return '';
  const { project, state } = projectContext;
  const stateEntries = state && typeof state === 'object' ? Object.entries(state) : [];

  // Header. We tell the model the project name + description (if any)
  // + when it was last touched + by which client. The "by which client"
  // bit lets the model say "Cursor was on this yesterday" naturally.
  const lastActive = project.last_active_at
    ? new Date(project.last_active_at).toISOString()
    : null;

  const header = [
    '[CURRENT_PROJECT]',
    `Name: ${project.name || '(unnamed)'}`,
  ];
  if (project.description) header.push(`Description: ${project.description}`);
  if (lastActive) header.push(`Last activity: ${lastActive}`);
  if (project.created_by_client) header.push(`Started in: ${project.created_by_client}`);

  // State kv-pairs. Sort so the most-recently-set keys appear first —
  // the model is more likely to lean on recent decisions, and recency
  // also doubles as "what we last cared about." Cap to keep prompt
  // size sane; lykn_getProjectState is available for the long tail.
  const sorted = stateEntries
    .filter(([, v]) => v && v.value)
    .sort((a, b) => {
      const aSet = a[1]?.set_at ? Date.parse(a[1].set_at) : 0;
      const bSet = b[1]?.set_at ? Date.parse(b[1].set_at) : 0;
      return bSet - aSet;
    })
    .slice(0, 24);

  const stateLines = sorted.length
    ? sorted.map(([key, entry]) => {
        const client = entry.set_by_client ? ` [${entry.set_by_client}]` : '';
        return `- ${key}${client}: ${String(entry.value).replace(/\s+/g, ' ').trim()}`;
      })
    : ['(no state pushes yet — this project was just created)'];

  const footer = [
    '',
    'When this conversation produces a meaningful decision, milestone, or',
    'change to one of the keys above, call:',
    '  lykn_pushProjectState({ state_key: "<slug>", state_value: "<≤2000 chars>" })',
    'Reuse keys (e.g. "current_blocker", "tech_stack") so the value replaces,',
    'not appends. New keys are fine when the topic is genuinely new.',
  ];

  return [...header, '', 'Current state (most recent first):', ...stateLines, ...footer].join('\n').trim();
}

// ---------------------------------------------------------------------------
// USER_MODEL routing — decide whether the long-tail facts are needed
// ---------------------------------------------------------------------------

/**
 * Lightweight heuristic to decide whether to inject the wide [USER_MODEL]
 * fact pool. The premise: when the user has ratified beliefs+rules, those
 * cover most personalization needs and we can save tokens by skipping the
 * fact dump. Long, identity-shaped, or recall questions still pull facts.
 *
 * Inputs are kept simple so this can stay sync — server.js calls it during
 * the same parallel context-fetch phase that pulls user model + identity.
 */
export function shouldSkipUserModelGivenBeliefs({ activeBeliefCount, activeRuleCount, userMessage }) {
  if (!activeBeliefCount || activeBeliefCount < 2) return false;
  if (!activeRuleCount || activeRuleCount < 2) return false;
  const msg = String(userMessage || '').trim();
  if (!msg) return false;
  // Recall/identity questions ALWAYS get the full fact pool — the user is
  // explicitly asking us to remember, and beliefs alone won't cover names,
  // tools, locations, etc.
  if (/\b(what|who).{0,20}(my|me|i)\b/i.test(msg)) return false;
  if (/\b(remember|recall|told you|know about me|about myself)\b/i.test(msg)) return false;
  if (msg.length > 600) return false;        // long messages may carry fresh disclosure
  return true;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchActiveFactsForPromotion(client, userId) {
  const { data, error } = await client
    .from('lykn_user_model_facts')
    .select('id, fact_kind, fact_text, status, confidence, last_seen_at')
    .eq('user_id', userId)
    .neq('status', 'dismissed')
    .gte('confidence', 0.4)
    .order('confidence', { ascending: false })
    .limit(80);
  if (error) {
    console.warn('⚠️ fetchActiveFactsForPromotion:', error.message);
    return [];
  }
  return data || [];
}

async function fetchAllBeliefs(client, userId) {
  const { data, error } = await client
    .from('lykn_beliefs')
    .select('id, belief_text, belief_key, serves_need, status, confidence, rationale, promoted_from_facts, invocation_count, good_feedback_count, bad_feedback_count, ratified_at, retired_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(120);
  if (error) {
    console.warn('⚠️ fetchAllBeliefs:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Public read helper used by server.js for the prompt block + belief panel.
 */
export async function listActiveBeliefsForUser(client, userId) {
  if (!client || !userId) return [];
  const { data, error } = await client
    .from('lykn_beliefs')
    .select('id, belief_text, serves_need, confidence, status, rationale, invocation_count, last_invoked_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('confidence', { ascending: false })
    .limit(MAX_BELIEFS_PER_USER);
  if (error) {
    console.warn('⚠️ listActiveBeliefsForUser:', error.message);
    return [];
  }
  return data || [];
}

export async function listActiveRulesForUser(client, userId) {
  if (!client || !userId) return [];
  const { data, error } = await client
    .from('lykn_rules')
    .select('id, belief_id, trigger_text, action_text, priority, confidence, status, invocation_count, last_fired_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .order('confidence', { ascending: false });
  if (error) {
    console.warn('⚠️ listActiveRulesForUser:', error.message);
    return [];
  }
  return data || [];
}

export async function listBeliefsAndRulesForUI(client, userId) {
  if (!client || !userId) return { beliefs: [], rules: [] };
  const [beliefRes, ruleRes] = await Promise.all([
    client
      .from('lykn_beliefs')
      .select('id, belief_text, serves_need, status, confidence, rationale, promoted_from_facts, invocation_count, good_feedback_count, bad_feedback_count, ratified_at, retired_at, created_at')
      .eq('user_id', userId)
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(120),
    client
      .from('lykn_rules')
      .select('id, belief_id, trigger_text, action_text, status, priority, confidence, invocation_count, good_feedback_count, bad_feedback_count, ratified_at, retired_at, created_at')
      .eq('user_id', userId)
      .order('priority', { ascending: true })
      .limit(200),
  ]);
  return {
    beliefs: beliefRes?.data || [],
    rules: ruleRes?.data || [],
  };
}

export async function listRecentAttributions(client, userId, limit = 30) {
  if (!client || !userId) return [];
  const { data } = await client
    .from('lykn_result_attributions')
    .select('id, message_id, surface, surface_id, rule_id, belief_id, rule_snapshot, belief_snapshot, serves_need, reason, user_feedback, rule_was_bad, belief_was_bad, feedback_note, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return data || [];
}

async function capActiveBeliefs(client, userId) {
  const { data } = await client
    .from('lykn_beliefs')
    .select('id, confidence, ratified_at')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (!data || data.length <= MAX_BELIEFS_PER_USER) return;
  const sorted = data.slice().sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
  const overflow = sorted.slice(0, sorted.length - MAX_BELIEFS_PER_USER);
  if (!overflow.length) return;
  const ids = overflow.map((r) => r.id);
  const now = new Date().toISOString();
  await client
    .from('lykn_beliefs')
    .update({ status: 'retired', retired_at: now, updated_at: now })
    .in('id', ids)
    .eq('user_id', userId);
  await client
    .from('lykn_rules')
    .update({ status: 'retired', retired_at: now, updated_at: now })
    .in('belief_id', ids)
    .eq('user_id', userId);
}

async function trimOldAttributions(client, userId) {
  try {
    const { data } = await client
      .from('lykn_result_attributions')
      .select('id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(MAX_ATTRIBUTIONS_RETAINED, MAX_ATTRIBUTIONS_RETAINED + 200);
    const stale = (data || []).map((r) => r.id).filter(Boolean);
    if (!stale.length) return;
    await client.from('lykn_result_attributions').delete().in('id', stale).eq('user_id', userId);
  } catch { /* non-critical */ }
}
