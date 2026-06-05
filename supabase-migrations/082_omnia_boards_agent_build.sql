-- ============================================================================
-- 082 — Link agent builds to sidebar chats (Agents category)
-- ============================================================================

ALTER TABLE public.omnia_boards
  ADD COLUMN IF NOT EXISTS board_kind TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE public.omnia_boards
  ADD COLUMN IF NOT EXISTS custom_agent_id UUID REFERENCES public.lykn_custom_agents(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'omnia_boards_board_kind_check'
  ) THEN
    ALTER TABLE public.omnia_boards
      ADD CONSTRAINT omnia_boards_board_kind_check
      CHECK (board_kind IN ('chat', 'agent_build'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_omnia_boards_user_kind_updated
  ON public.omnia_boards (user_id, board_kind, updated_at DESC);

COMMENT ON COLUMN public.omnia_boards.board_kind IS
  'chat = main LYKN chat; agent_build = Agent Studio build thread in sidebar Agents section';

COMMENT ON COLUMN public.omnia_boards.custom_agent_id IS
  'When board_kind = agent_build, the lykn_custom_agents row being composed in Agent Studio';
