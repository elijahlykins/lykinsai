-- ============================================================================
-- 083 — Retire Agent Builder / in-app chat agents (Model Builder only)
-- ============================================================================
-- Reverses 079–082 product surface:
--   • lykn_chat_agents (079–081) — in-app agent profiles
--   • omnia_boards.agent_build + custom_agent_id (082) — Agent Studio threads
--
-- Keeps lykn_custom_agents (070) — outbound webhook registry on Connections.

-- Remove Agent Studio build threads (states cascade via FK).
DELETE FROM public.omnia_boards
WHERE board_kind = 'agent_build';

-- Drop Agent Studio board linkage columns (082).
ALTER TABLE public.omnia_boards
  DROP CONSTRAINT IF EXISTS omnia_boards_board_kind_check;

DROP INDEX IF EXISTS public.idx_omnia_boards_user_kind_updated;

ALTER TABLE public.omnia_boards
  DROP COLUMN IF EXISTS custom_agent_id;

ALTER TABLE public.omnia_boards
  DROP COLUMN IF EXISTS board_kind;

-- Drop in-app chat agent registry (079–081).
DROP TABLE IF EXISTS public.lykn_chat_agents CASCADE;
