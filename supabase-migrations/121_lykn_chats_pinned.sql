-- ============================================
-- 121 — Pin chats in the sidebar
-- ============================================
-- `pinned_at` is null for unpinned chats. When set, the sidebar shows the
-- chat in a Pinned group at the top (sorted by pinned_at desc).

ALTER TABLE public.lykn_chats
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_chats_user_pinned
  ON public.lykn_chats (user_id, pinned_at DESC NULLS LAST)
  WHERE pinned_at IS NOT NULL;

COMMENT ON COLUMN public.lykn_chats.pinned_at IS
  'When set, chat is pinned in the sidebar. Null means unpinned.';
