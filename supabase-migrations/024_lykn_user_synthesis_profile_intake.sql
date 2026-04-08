-- When the user completed the cold-start intake flow (distinct from chat-refresh narrative updates).
ALTER TABLE lykn_user_synthesis_profile
  ADD COLUMN IF NOT EXISTS intake_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN lykn_user_synthesis_profile.intake_completed_at IS
  'Set when POST /api/synthesis/intake succeeds; used for gating, re-entry, and future profile decay.';
