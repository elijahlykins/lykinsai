-- ============================================================================
-- 084 — Per-chat model key for sidebar filtering
-- ============================================================================
-- Stores which model (frontier id or custom:<uuid>) a chat last used so the
-- sidebar can filter conversations by model without loading board snapshots.

ALTER TABLE public.omnia_boards
  ADD COLUMN IF NOT EXISTS chat_model_key TEXT;

CREATE INDEX IF NOT EXISTS idx_omnia_boards_user_chat_model_updated
  ON public.omnia_boards (user_id, chat_model_key, updated_at DESC)
  WHERE chat_model_key IS NOT NULL;

COMMENT ON COLUMN public.omnia_boards.chat_model_key IS
  'Last model used in this chat: lykn, frontier id, or custom:<lykn_custom_models.id>.';

-- Best-effort backfill from the last assistant turn in saved board state.
UPDATE public.omnia_boards ob
SET chat_model_key = derived.model_key
FROM (
  SELECT DISTINCT ON (obs.board_id)
    obs.board_id,
    COALESCE(NULLIF(trim(last_assistant.elem->>'model'), ''), 'lykn') AS model_key
  FROM public.omnia_board_states obs
  CROSS JOIN LATERAL (
    SELECT elem
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(obs.state->'aiThread') = 'array' THEN obs.state->'aiThread'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS t(elem, ord)
    WHERE elem->>'role' = 'assistant'
      AND NULLIF(trim(elem->>'model'), '') IS NOT NULL
    ORDER BY ord DESC
    LIMIT 1
  ) AS last_assistant
  WHERE obs.state IS NOT NULL
  ORDER BY obs.board_id, obs.updated_at DESC
) AS derived
WHERE ob.id = derived.board_id
  AND (ob.chat_model_key IS NULL OR ob.chat_model_key = '');
