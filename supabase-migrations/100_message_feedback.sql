-- ============================================================================
-- 100 — Message feedback: persist chat thumbs up / down
-- ============================================================================
-- The chat composer has long shown 👍 / 👎 buttons on each assistant reply,
-- but the rating lived only in React state and was discarded on unmount. This
-- table captures it so we get a real quality signal (which prompts/models/
-- responses users liked or disliked).
--
-- One row per (user, message). Toggling the same thumb clears the rating
-- (the server deletes the row); switching thumbs upserts in place. We snapshot
-- the prompt/response text + model so the signal stays useful even after the
-- originating chat/board is edited or deleted.

CREATE TABLE IF NOT EXISTS public.message_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Client-side chat message id (board message id) — a stable string, not
  -- necessarily a UUID, so stored as TEXT.
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 200),
  -- Originating board / conversation, when known (nullable for voice/other).
  board_id TEXT CHECK (board_id IS NULL OR length(board_id) <= 200),
  -- The rating itself.
  rating TEXT NOT NULL CHECK (rating IN ('like', 'dislike')),
  -- Which model produced the rated reply (brand alias or provider model id).
  model TEXT CHECK (model IS NULL OR length(model) <= 120),
  -- Snapshot of the exchange for offline analysis (bounded).
  prompt TEXT CHECK (prompt IS NULL OR length(prompt) <= 8000),
  response TEXT CHECK (response IS NULL OR length(response) <= 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One feedback row per message per user; toggling updates it in place.
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS message_feedback_user_idx
  ON public.message_feedback (user_id, created_at DESC);

-- Cheap "show me all the thumbs-down" analytics scan.
CREATE INDEX IF NOT EXISTS message_feedback_rating_idx
  ON public.message_feedback (rating, created_at DESC);

ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_feedback_select_own ON public.message_feedback;
CREATE POLICY message_feedback_select_own
  ON public.message_feedback FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS message_feedback_insert_own ON public.message_feedback;
CREATE POLICY message_feedback_insert_own
  ON public.message_feedback FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS message_feedback_update_own ON public.message_feedback;
CREATE POLICY message_feedback_update_own
  ON public.message_feedback FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS message_feedback_delete_own ON public.message_feedback;
CREATE POLICY message_feedback_delete_own
  ON public.message_feedback FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.message_feedback IS
  'Persisted chat thumbs up/down on assistant replies. One row per (user, message); cleared by deleting the row. Snapshots prompt/response/model for quality analysis.';
