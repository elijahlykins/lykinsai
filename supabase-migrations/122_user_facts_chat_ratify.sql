-- ============================================
-- Synthesis v2 — chat-ratified User Facts
-- Migration: 122_user_facts_chat_ratify.sql
-- ============================================
-- Extends lykn_user_model_facts for in-chat ratification, then migrates
-- active Core Beliefs into confirmed User Facts so personalization no
-- longer depends on the Belief Window.

-- ---------------------------------------------------------------------------
-- 1. Columns for chat confirm flow
-- ---------------------------------------------------------------------------
ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS pending_confirm BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS evidence_quote TEXT;

ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS source_message_id TEXT;

ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS supersedes_fact_id UUID
    REFERENCES lykn_user_model_facts(id) ON DELETE SET NULL;

-- Allow status='pending' (awaiting in-chat Yes / Edit / No).
ALTER TABLE lykn_user_model_facts
  DROP CONSTRAINT IF EXISTS lykn_user_model_facts_status_check;

ALTER TABLE lykn_user_model_facts
  ADD CONSTRAINT lykn_user_model_facts_status_check
  CHECK (status IN (
    'pending', 'inferred', 'stated', 'confirmed', 'corrected', 'dismissed'
  ));

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_pending
  ON lykn_user_model_facts (user_id, created_at DESC)
  WHERE pending_confirm = true OR status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_confirmed_recent
  ON lykn_user_model_facts (user_id, confirmed_at DESC NULLS LAST, last_seen_at DESC)
  WHERE status = 'confirmed';

COMMENT ON COLUMN lykn_user_model_facts.pending_confirm IS
  'True while waiting for in-chat Yes/Edit/No ratification.';
COMMENT ON COLUMN lykn_user_model_facts.evidence_quote IS
  'Short quote / reason shown on the confirm chip.';
COMMENT ON COLUMN lykn_user_model_facts.confirmed_at IS
  'When the user ratified this fact in chat (or via migration from a belief).';

-- ---------------------------------------------------------------------------
-- 2. Migrate active beliefs → confirmed User Facts (idempotent)
-- ---------------------------------------------------------------------------
-- Uses fact_kind='identity' and a stable fact_key so re-runs do not duplicate.
INSERT INTO lykn_user_model_facts (
  user_id,
  fact_kind,
  fact_text,
  fact_key,
  confidence,
  status,
  evidence,
  evidence_count,
  source_types,
  evidence_quote,
  confirmed_at,
  first_seen_at,
  last_seen_at,
  pending_confirm,
  metadata
)
SELECT
  b.user_id,
  'identity',
  LEFT(b.belief_text, 240),
  LEFT('belief_' || replace(b.id::text, '-', ''), 64),
  GREATEST(0.85, LEAST(1.0, COALESCE(b.confidence, 0.85))),
  'confirmed',
  jsonb_build_array(
    jsonb_build_object(
      'source_type', 'belief_migration',
      'source_id', b.id::text,
      'snippet', LEFT(COALESCE(b.rationale, b.belief_text), 240),
      'observed_at', COALESCE(b.ratified_at, b.created_at, now())
    )
  ),
  1,
  ARRAY['belief_migration']::text[],
  LEFT(COALESCE(b.rationale, ''), 240),
  COALESCE(b.ratified_at, b.updated_at, now()),
  COALESCE(b.created_at, now()),
  now(),
  false,
  jsonb_build_object(
    'migrated_from_belief_id', b.id,
    'serves_need', b.serves_need
  )
FROM lykn_beliefs b
WHERE b.status = 'active'
  AND COALESCE(NULLIF(trim(b.belief_text), ''), '') <> ''
ON CONFLICT (user_id, fact_kind, fact_key) DO UPDATE SET
  fact_text = EXCLUDED.fact_text,
  status = 'confirmed',
  pending_confirm = false,
  confirmed_at = COALESCE(lykn_user_model_facts.confirmed_at, EXCLUDED.confirmed_at),
  confidence = GREATEST(lykn_user_model_facts.confidence, EXCLUDED.confidence),
  updated_at = now(),
  metadata = COALESCE(lykn_user_model_facts.metadata, '{}'::jsonb)
    || EXCLUDED.metadata;

-- Mark migrated beliefs in provenance so nightly jobs / UI can ignore them.
UPDATE lykn_beliefs b
SET
  provenance = COALESCE(b.provenance, '{}'::jsonb)
    || jsonb_build_object('migrated_to_user_fact', true, 'migrated_at', now()::text),
  updated_at = now()
WHERE b.status = 'active'
  AND COALESCE((b.provenance->>'migrated_to_user_fact')::boolean, false) IS NOT TRUE;
