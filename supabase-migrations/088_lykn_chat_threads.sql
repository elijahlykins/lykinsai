-- ============================================================================
-- 088 — Chat threads: group multiple chats (omnia_boards) under one thread
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lykn_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'New Thread' CHECK (length(trim(name)) >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_chat_threads_user_updated_idx
  ON public.lykn_chat_threads (user_id, updated_at DESC);

ALTER TABLE public.omnia_boards
  ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES public.lykn_chat_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_omnia_boards_thread_id
  ON public.omnia_boards (thread_id, updated_at DESC)
  WHERE thread_id IS NOT NULL;

ALTER TABLE public.lykn_chat_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_chat_threads_select_own ON public.lykn_chat_threads;
CREATE POLICY lykn_chat_threads_select_own
  ON public.lykn_chat_threads FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_threads_insert_own ON public.lykn_chat_threads;
CREATE POLICY lykn_chat_threads_insert_own
  ON public.lykn_chat_threads FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_threads_update_own ON public.lykn_chat_threads;
CREATE POLICY lykn_chat_threads_update_own
  ON public.lykn_chat_threads FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_threads_delete_own ON public.lykn_chat_threads;
CREATE POLICY lykn_chat_threads_delete_own
  ON public.lykn_chat_threads FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_chat_threads IS
  'User chat thread — groups multiple omnia_boards (chats) under one sidebar dropdown.';

COMMENT ON COLUMN public.omnia_boards.thread_id IS
  'Parent chat thread; multiple boards may share one thread_id.';
