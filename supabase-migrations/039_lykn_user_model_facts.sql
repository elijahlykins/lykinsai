-- ============================================
-- LYKN user model — atomic facts + revision history
-- Migration: 039_lykn_user_model_facts.sql
-- ============================================
-- Phase 1 of "AI that actually learns the user."
--
-- Today, lykn_user_synthesis_profile holds an opaque blob: a single narrative
-- string, a flat themes array, and a free-form signals JSON. Useful for prompt
-- injection, useless for showing the user what was learned, capturing
-- corrections, or tracking confidence.
--
-- This migration introduces:
--   1. lykn_user_model_facts     — atomic, structured, evidence-tracked facts
--   2. lykn_user_model_revisions — append-only snapshots so we can show diffs
--                                   ("what the AI noticed this week")
--
-- The existing profile table stays as-is (it remains the fast path for prompt
-- injection); facts are the source of truth and the basis for the UI.

-- ---------------------------------------------------------------------------
-- 1. Atomic learned facts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_user_model_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Coarse category. Drives UI grouping ("About you", "Focus", "How you think").
  --   identity      — durable self-description (role, location, professional context)
  --   focus         — what they're actively working on right now
  --   theme         — recurring topics across their work
  --   goal          — stated or strongly implied objectives
  --   preference    — tools, styles, formats they reach for
  --   style         — reasoning / communication patterns
  --   constraint    — limits, blockers, things to avoid
  --   relationship  — people, teams, collaborators they reference
  fact_kind TEXT NOT NULL CHECK (fact_kind IN (
    'identity', 'focus', 'theme', 'goal', 'preference', 'style', 'constraint', 'relationship'
  )),

  -- Short, human-readable. Treat as the "claim" the AI is making.
  -- Example: "Works as a designer", "Building a creative tools app called LYKN",
  --          "Prefers concise, direct AI responses"
  fact_text TEXT NOT NULL,

  -- Normalized form used for dedup / merge (lowercase, stripped). The reconciler
  -- groups facts by (user_id, fact_kind, fact_key) and bumps confidence on repeats.
  fact_key TEXT NOT NULL,

  -- 0.0–1.0. Increases with repeated independent evidence; decays without it.
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),

  -- 'inferred'  — derived by the LLM from content
  -- 'stated'    — user said it directly (intake answer or chat statement)
  -- 'confirmed' — user clicked thumbs up
  -- 'corrected' — user provided a correction (see correction_text)
  -- 'dismissed' — user clicked thumbs down (kept for "do not re-derive" memory)
  status TEXT NOT NULL DEFAULT 'inferred' CHECK (status IN (
    'inferred', 'stated', 'confirmed', 'corrected', 'dismissed'
  )),

  -- If the user corrected this fact, what did they say instead? Surfaces in UI
  -- and is fed back into subsequent reconciliation passes so the model doesn't
  -- re-derive the original wrong claim.
  correction_text TEXT,

  -- Provenance: where did the AI find evidence for this?
  -- Each entry is roughly:
  --   { source_type: 'vault_note' | 'grid_board' | 'conversation' | 'intake',
  --     source_id: string, snippet: string, observed_at: ISO timestamp }
  -- Capped at ~10 entries by the application reconciler to bound row size.
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Convenience aggregate: how many independent evidence points have ever
  -- supported this fact (does not shrink even if `evidence` is trimmed).
  evidence_count INT NOT NULL DEFAULT 1 CHECK (evidence_count >= 0),

  -- Set of source_types that have ever supported this fact.
  -- Used in UI to show "noticed in vault, grids, and chat".
  source_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lykn_user_model_facts_unique_per_kind
    UNIQUE (user_id, fact_kind, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_kind
  ON lykn_user_model_facts (user_id, fact_kind, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_active
  ON lykn_user_model_facts (user_id, status, confidence DESC)
  WHERE status NOT IN ('dismissed');

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_recent
  ON lykn_user_model_facts (user_id, first_seen_at DESC);

ALTER TABLE lykn_user_model_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own model facts"
  ON lykn_user_model_facts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own model facts"
  ON lykn_user_model_facts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own model facts"
  ON lykn_user_model_facts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own model facts"
  ON lykn_user_model_facts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Revision history (snapshots on every refresh; powers the diff UI)
-- ---------------------------------------------------------------------------
-- Each row is one snapshot of (a sample of) the user's facts at a point in
-- time, plus a short LLM-generated "what changed" summary.
-- Append-only; trimmed by application logic to last ~50 revisions per user.
CREATE TABLE IF NOT EXISTS lykn_user_model_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Why this snapshot was taken: 'refresh' | 'intake' | 'feedback' | 'manual'
  trigger TEXT NOT NULL DEFAULT 'refresh' CHECK (trigger IN (
    'refresh', 'intake', 'feedback', 'manual'
  )),

  -- Counters at snapshot time (cheap to display in UI without rejoining facts)
  fact_count INT NOT NULL DEFAULT 0,
  facts_added INT NOT NULL DEFAULT 0,
  facts_updated INT NOT NULL DEFAULT 0,
  facts_dismissed INT NOT NULL DEFAULT 0,

  -- The actual diff payload, suitable for direct rendering.
  -- Roughly:
  --   { added: [ { fact_kind, fact_text, confidence } ],
  --     reinforced: [ { fact_kind, fact_text, confidence_before, confidence_after } ],
  --     ... }
  diff JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Optional one-paragraph LLM summary, e.g. "This week the AI noticed you've
  -- shifted focus toward X and started referencing Y."
  summary TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_revisions_user_recent
  ON lykn_user_model_revisions (user_id, created_at DESC);

ALTER TABLE lykn_user_model_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own revisions"
  ON lykn_user_model_revisions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own revisions"
  ON lykn_user_model_revisions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own revisions"
  ON lykn_user_model_revisions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lykn_user_model_facts IS
  'Atomic, evidence-tracked claims the AI has learned about a user. Source of truth for the "What the AI knows" UI; reconciled by server pipeline.';
COMMENT ON COLUMN lykn_user_model_facts.fact_key IS
  'Normalized fact_text used for (user_id, fact_kind, fact_key) dedup.';
COMMENT ON COLUMN lykn_user_model_facts.evidence IS
  'Array of provenance entries: { source_type, source_id, snippet, observed_at }. Capped at ~10 by reconciler.';

COMMENT ON TABLE lykn_user_model_revisions IS
  'Append-only snapshots of the user model. Powers the "what changed since last week" diff UI.';
