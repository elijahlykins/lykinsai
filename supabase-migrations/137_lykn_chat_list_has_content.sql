-- ============================================
-- Fast chat-history lists
-- Migration: 137_lykn_chat_list_has_content.sql
-- ============================================
--
-- Chat history (Studio dock, mobile sheet, overlay Past chats) used to
-- embed lykn_chat_states.state — the full snapshot jsonb — just to hide
-- empty "New Chat" shells. That download is the list's load time.
--
-- has_content is computed at write time from the snapshot so list queries
-- can select a boolean instead of the blob.

CREATE OR REPLACE FUNCTION public.lykn_chat_snapshot_has_context(state jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (jsonb_typeof(state -> 'chatMessages') = 'array'
      AND jsonb_array_length(state -> 'chatMessages') > 0)
    OR (jsonb_typeof(state -> 'aiThread') = 'array'
      AND jsonb_array_length(state -> 'aiThread') > 0)
    OR (jsonb_typeof(state -> 'notesPages') = 'array'
      AND jsonb_array_length(state -> 'notesPages') > 0)
    OR (jsonb_typeof(state -> 'blockOrder') = 'array'
      AND jsonb_array_length(state -> 'blockOrder') > 0)
    OR (jsonb_typeof(state -> 'blocks') = 'object'
      AND state -> 'blocks' <> '{}'::jsonb),
    false
  );
$$;

COMMENT ON FUNCTION public.lykn_chat_snapshot_has_context(jsonb) IS
  'True when a chat snapshot has messages, notes, or grid content worth listing.';

ALTER TABLE public.lykn_chat_states
  ADD COLUMN IF NOT EXISTS has_content boolean
  GENERATED ALWAYS AS (public.lykn_chat_snapshot_has_context(state)) STORED;

COMMENT ON COLUMN public.lykn_chat_states.has_content IS
  'Write-time flag so chat lists do not download state jsonb.';
