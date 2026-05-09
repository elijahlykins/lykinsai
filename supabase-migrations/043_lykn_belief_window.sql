-- ============================================
-- LYKN Belief Window — Need → Belief → Rule → Result
-- Migration: 043_lykn_belief_window.sql
-- ============================================
-- Phase 2 of "AI that actually learns the user" — the layer ABOVE atomic
-- facts. Implements Hyrum Smith's belief-window model as a falsifiable,
-- promotable, user-ratifiable structure on top of `lykn_user_model_facts`.
--
-- Causal chain:
--   need (live | love | value | variety)
--     └── belief        ("Legacy tools are friction")
--           └── rule    ("If a UI requires >2 clicks, reject it")
--                 └── result_attribution (this AI message leaned on rule X)
--
-- Failure-mode debugging: when a result is wrong, the user marks the
-- attribution bad. We can then ask whether the BELIEF was wrong or the
-- RULE was mis-tuned, and walk the chain backward to the right repair.
--
-- Key design choices:
--   • Beliefs are PROMOTED from clusters of facts (status='proposed') and
--     only become 'active' once the user ratifies. The AI never invents a
--     belief without user consent — that would break the "internal physics"
--     contract.
--   • Rules are PROPOSED by the AI per-belief and ratified the same way.
--     A belief can have 0..N rules.
--   • Attributions are ONLY recorded when a rule actually fires (the chat
--     model emits an <applied rule_id="..."> tag). Tag-less replies create
--     no attribution — honest by default.

-- ---------------------------------------------------------------------------
-- 1. Beliefs — durable principles that explain a pattern across many facts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_beliefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Short, third-person principle. ≤140 chars enforced by application.
  -- Example: "Legacy tools are friction"
  belief_text TEXT NOT NULL,

  -- Normalized form for dedup against (user_id, belief_key).
  belief_key TEXT NOT NULL,

  -- Which of the four basic needs this belief ultimately serves. Smith's
  -- canonical four — used here as the root of the causal chain so every
  -- belief has a falsifiable target. The AI proposer must pick one.
  --   live    — survival, safety, security, sustainability
  --   love    — connection, belonging, being known and loved
  --   value   — feeling important, capable, that one's work matters
  --   variety — novelty, change, agency to choose differently
  serves_need TEXT NOT NULL CHECK (serves_need IN ('live', 'love', 'value', 'variety')),

  -- Lifecycle:
  --   proposed  — AI promoted this from a fact cluster; user has not seen / not ratified
  --   active    — user accepted; flows into the prompt and may spawn rules
  --   retired   — user dismissed, OR contradicting facts/feedback retired it
  --   superseded — replaced by a refined belief; kept for audit
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'active', 'retired', 'superseded'
  )),

  -- 0.0–1.0; rises as more attributions land "good" feedback, falls on "bad".
  -- Independent from the underlying facts' confidences — a high-confidence
  -- belief can still produce bad outputs if the rules are wrong.
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),

  -- IDs of the lykn_user_model_facts rows that seeded this belief (audit
  -- trail; lets the UI show "this belief came from these 6 facts"). Trimmed
  -- to ~20 by the application.
  promoted_from_facts UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],

  -- Optional one-line LLM-generated rationale shown alongside the belief
  -- on the ratification screen ("why does the AI think this?").
  rationale TEXT,

  -- Counters for UI / governance — bumped by application code.
  invocation_count INT NOT NULL DEFAULT 0,
  good_feedback_count INT NOT NULL DEFAULT 0,
  bad_feedback_count INT NOT NULL DEFAULT 0,

  -- If this belief was a refinement of another (status='superseded' on the
  -- old row), pointer for the audit chain.
  supersedes_id UUID REFERENCES lykn_beliefs(id) ON DELETE SET NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_invoked_at TIMESTAMPTZ,
  ratified_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lykn_beliefs_unique_per_user UNIQUE (user_id, belief_key)
);

CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_user_status
  ON lykn_beliefs (user_id, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_user_need
  ON lykn_beliefs (user_id, serves_need)
  WHERE status = 'active';

ALTER TABLE lykn_beliefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own beliefs"
  ON lykn_beliefs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own beliefs"
  ON lykn_beliefs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own beliefs"
  ON lykn_beliefs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own beliefs"
  ON lykn_beliefs FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Rules — if-then operationalizations of a belief
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  belief_id UUID NOT NULL REFERENCES lykn_beliefs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The IF half — short trigger description. The AI uses this to decide
  -- whether the rule applies to a given turn.
  -- Example: "user is asking about UI patterns or interaction design"
  trigger_text TEXT NOT NULL,

  -- The THEN half — short action description.
  -- Example: "reject any pattern requiring >2 clicks; propose an agentic alternative"
  action_text TEXT NOT NULL,

  -- Normalized (trigger||action) used for dedup-per-belief.
  rule_key TEXT NOT NULL,

  -- Lifecycle:
  --   proposed — AI suggested this rule; user has not ratified
  --   active   — user accepted; injected into the prompt
  --   retired  — user dismissed or rule consistently produced bad results
  --   draft    — user is editing; not yet active
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'active', 'retired', 'draft'
  )),

  -- 0.0–1.0; same semantics as belief confidence — rises with good
  -- attributions, falls with bad. Independent from belief confidence.
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),

  -- Counters for UI / governance.
  invocation_count INT NOT NULL DEFAULT 0,
  good_feedback_count INT NOT NULL DEFAULT 0,
  bad_feedback_count INT NOT NULL DEFAULT 0,

  -- 1 = highest-priority rule; rules with the same priority are ordered by
  -- confidence DESC. Used so the prompt doesn't get bloated with every rule
  -- the user ever ratified.
  priority INT NOT NULL DEFAULT 100,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_at TIMESTAMPTZ,
  ratified_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lykn_rules_unique_per_belief UNIQUE (belief_id, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_lykn_rules_user_active
  ON lykn_rules (user_id, status, priority, confidence DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lykn_rules_belief
  ON lykn_rules (belief_id, status);

ALTER TABLE lykn_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own rules"
  ON lykn_rules FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own rules"
  ON lykn_rules FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own rules"
  ON lykn_rules FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own rules"
  ON lykn_rules FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Result attributions — only recorded when a rule actually fired
-- ---------------------------------------------------------------------------
-- This is the "audit trail" half of the belief window. Every AI response
-- that leaned on a ratified rule writes one row here so the UI can show
-- a "Why" badge and walk the user backward to the rule (and the belief,
-- and the need) it served.
--
-- Honest-by-default: tag-less replies create NO attribution. We never
-- guess "this came from belief X" — only the model's own <applied> tag
-- (verified server-side against the user's active rules) qualifies.
CREATE TABLE IF NOT EXISTS lykn_result_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The chat message the attribution is for. Free-form id (the chat surface
  -- supplies its own message id; we don't constrain to a single table since
  -- attributions can come from focused-chat, side-rail, vault-chat, etc.).
  message_id TEXT NOT NULL,

  -- The surface that produced this attribution: 'grid' | 'vault' | 'focused' | 'sidebar' | 'project' | etc.
  surface TEXT,
  surface_id TEXT,

  rule_id UUID REFERENCES lykn_rules(id) ON DELETE SET NULL,
  belief_id UUID REFERENCES lykn_beliefs(id) ON DELETE SET NULL,

  -- Snapshot of the rule + belief at the time of firing — the rules they
  -- pointed to may have been edited or retired since, and we need a stable
  -- view for the historical "Why" panel. Both capped at ~240 chars by the
  -- recorder.
  rule_snapshot TEXT,
  belief_snapshot TEXT,
  serves_need TEXT,

  -- Optional one-sentence reason the AI emitted alongside the <applied> tag,
  -- explaining HOW the rule shaped this specific reply. Trim the AI's
  -- justification — not the rule itself.
  reason TEXT,

  -- User feedback on whether the attribution was good. The "Why" panel on
  -- a chat message lets the user mark it good / bad. On 'bad', the UI asks
  -- one follow-up: was the rule wrong (rule_was_bad=true) or the belief
  -- wrong (belief_was_bad=true)? That answer is what walks the repair loop
  -- — it's what tells us whether to retire the rule, retire the belief,
  -- or chalk it up to a generation miss (both flags false).
  user_feedback TEXT CHECK (user_feedback IN ('good', 'bad')),
  rule_was_bad BOOLEAN NOT NULL DEFAULT false,
  belief_was_bad BOOLEAN NOT NULL DEFAULT false,
  feedback_note TEXT,
  feedback_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_result_attributions_user_recent
  ON lykn_result_attributions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lykn_result_attributions_message
  ON lykn_result_attributions (message_id);
CREATE INDEX IF NOT EXISTS idx_lykn_result_attributions_rule
  ON lykn_result_attributions (rule_id);

ALTER TABLE lykn_result_attributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own attributions"
  ON lykn_result_attributions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own attributions"
  ON lykn_result_attributions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own attributions"
  ON lykn_result_attributions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own attributions"
  ON lykn_result_attributions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lykn_beliefs IS
  'Durable principles promoted from fact clusters. The "internal physics" layer of the user model.';
COMMENT ON TABLE lykn_rules IS
  'If-then operationalizations of a belief. Each rule fires when its trigger matches the current turn.';
COMMENT ON TABLE lykn_result_attributions IS
  'Audit trail — one row per AI message that leaned on a ratified rule. Only created when the model emitted <applied>.';
COMMENT ON COLUMN lykn_beliefs.serves_need IS
  'Hyrum Smith four needs: live | love | value | variety. The root of the causal chain.';
COMMENT ON COLUMN lykn_result_attributions.rule_was_bad IS
  'User-set flag: when feedback=bad, was the RULE wrong? Drives rule retirement.';
COMMENT ON COLUMN lykn_result_attributions.belief_was_bad IS
  'User-set flag: when feedback=bad, was the BELIEF wrong? Drives belief retirement.';
