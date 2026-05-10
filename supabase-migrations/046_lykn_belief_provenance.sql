-- ============================================
-- LYKN — belief provenance columns
-- Migration: 046_lykn_belief_provenance.sql
-- ============================================
-- Beliefs already carry rich state (need, status, confidence, supporting
-- facts, ratification timestamp). What's been missing is *who proposed
-- them, in what client, in what conversation*.
--
-- Up to now the only provenance signal was a freeform `rationale` string
-- stamped by `proposeBelief.js` ("...via mcp:claude-desktop"). The activity
-- feed regex-parses that string. That hack worked for the demo; it does
-- not scale. Specifically:
--   • The string is normalised across paths (LLM promotion, manual UI
--     create, MCP propose) — every writer rolls its own format.
--   • Rationale is also user-visible copy. Dual-purposing it as a
--     machine-readable provenance log corrupts both.
--   • We can't ask interesting questions like "show me beliefs that two
--     different clients independently proposed" without join+regex.
--
-- This migration moves provenance off the rationale string and onto the
-- row, with one hatch left for cross-client convergence.
--
-- Columns:
--   • source                       — single client kind that wrote THIS row
--   • proposed_by_model            — model string when known (mostly NULL,
--                                    MCP doesn't expose it). Useful when
--                                    debugging "why did the AI propose this?"
--   • proposed_in_conversation_id  — host-provided thread id, opaque to us
--   • proposed_in_message_id       — host-provided message id at moment of
--                                    proposal. Lets the digest UI surface
--                                    "click to jump to source."
--   • ratified_by                  — 'user' (clicked accept), 'in-chat'
--                                    (user_confirmed=true via chat),
--                                    'manual' (user authored in UI),
--                                    'auto' (future: cross-client
--                                    convergence). NULL while proposed.
--   • proposed_by_clients          — append-only deduplicated set of every
--                                    client that has proposed this belief
--                                    (across upserts at the same belief_key).
--                                    Cardinality >= 2 means the same belief
--                                    was independently surfaced by multiple
--                                    AIs — strong "promote me" signal that
--                                    the digest UI can lean on.
--
-- Why `source` is free-form TEXT instead of an enum:
--   We will add new clients (chatgpt, gemini, perplexity, future LYKN
--   internal jobs) faster than we want to ship migrations. The trade-off
--   is the application is responsible for normalising values to a known
--   set of slugs before insert. That responsibility lives in
--   proposeBelief.js + beliefSystem.js.
--
-- Why `proposed_by_clients` is an array, not a join table:
--   Reads dominate writes for this column; we always want the full set
--   for a belief, never a partial scan. A `TEXT[]` with a GIN index is
--   the fastest read path. The only cost is array merge logic in the
--   application — already centralised in proposeBelief.js.
--
-- Backfill: leave NULL for existing rows. The activity endpoint falls
-- back to the legacy rationale-regex parser when source is NULL, so the
-- UI still shows provenance for older rows during the rollover window.

-- ---------------------------------------------------------------------------
-- 1. Add the columns
-- ---------------------------------------------------------------------------
ALTER TABLE lykn_beliefs
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS proposed_by_model TEXT,
  ADD COLUMN IF NOT EXISTS proposed_in_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS proposed_in_message_id TEXT,
  ADD COLUMN IF NOT EXISTS ratified_by TEXT,
  ADD COLUMN IF NOT EXISTS proposed_by_clients TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Light guard on ratified_by — the four legitimate values today plus NULL
-- (still proposed). Free to extend later.
ALTER TABLE lykn_beliefs
  DROP CONSTRAINT IF EXISTS lykn_beliefs_ratified_by_check;
ALTER TABLE lykn_beliefs
  ADD CONSTRAINT lykn_beliefs_ratified_by_check
  CHECK (ratified_by IS NULL OR ratified_by IN ('user', 'in-chat', 'manual', 'auto'));

-- Defensive width caps. Source slugs and message ids should stay tiny;
-- catching a runaway model that tries to stuff a paragraph in here is
-- cheaper at the DB than at the API layer.
ALTER TABLE lykn_beliefs
  DROP CONSTRAINT IF EXISTS lykn_beliefs_source_len_check;
ALTER TABLE lykn_beliefs
  ADD CONSTRAINT lykn_beliefs_source_len_check
  CHECK (source IS NULL OR length(source) <= 64);

ALTER TABLE lykn_beliefs
  DROP CONSTRAINT IF EXISTS lykn_beliefs_model_len_check;
ALTER TABLE lykn_beliefs
  ADD CONSTRAINT lykn_beliefs_model_len_check
  CHECK (proposed_by_model IS NULL OR length(proposed_by_model) <= 96);

ALTER TABLE lykn_beliefs
  DROP CONSTRAINT IF EXISTS lykn_beliefs_conv_len_check;
ALTER TABLE lykn_beliefs
  ADD CONSTRAINT lykn_beliefs_conv_len_check
  CHECK (proposed_in_conversation_id IS NULL OR length(proposed_in_conversation_id) <= 128);

ALTER TABLE lykn_beliefs
  DROP CONSTRAINT IF EXISTS lykn_beliefs_msg_len_check;
ALTER TABLE lykn_beliefs
  ADD CONSTRAINT lykn_beliefs_msg_len_check
  CHECK (proposed_in_message_id IS NULL OR length(proposed_in_message_id) <= 128);

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- "Show me everything Cursor proposed this week" / digest queries.
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_user_source
  ON lykn_beliefs (user_id, source, created_at DESC)
  WHERE source IS NOT NULL;

-- Cross-client convergence query: any belief the same user has had
-- proposed by multiple clients is a strong promotion candidate.
-- GIN over the array is the right shape — equality / containment lookups
-- ("any belief whose proposed_by_clients contains 'cursor'") are O(log n).
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_proposed_by_clients
  ON lykn_beliefs USING GIN (proposed_by_clients);

-- ---------------------------------------------------------------------------
-- 3. Comments — these show up in psql \d+ and help future maintainers
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN lykn_beliefs.source IS
  'Lowercase slug of the client that wrote THIS row: claude-desktop, cursor, claude-code, chatgpt, lykn-chat, lykn-promotion (LLM promotion pass), manual (user-authored in UI). NULL for pre-046 rows.';
COMMENT ON COLUMN lykn_beliefs.proposed_by_model IS
  'Model identifier when the writing client exposes it; usually NULL for MCP clients which do not advertise it.';
COMMENT ON COLUMN lykn_beliefs.proposed_in_conversation_id IS
  'Host-provided opaque conversation/thread id. Used so the digest UI can group "all beliefs proposed in conversation X."';
COMMENT ON COLUMN lykn_beliefs.proposed_in_message_id IS
  'Host-provided message id at the moment of proposal. Used so the UI can deep-link "see source message."';
COMMENT ON COLUMN lykn_beliefs.ratified_by IS
  'How the belief reached active status: user (clicked accept), in-chat (user_confirmed=true), manual (user-authored in UI), auto (future cross-client convergence). NULL while still proposed.';
COMMENT ON COLUMN lykn_beliefs.proposed_by_clients IS
  'Append-only deduplicated set of every client that has proposed this belief (across upserts at the same belief_key). Cardinality >= 2 indicates independent cross-client signal — a strong promote candidate.';
