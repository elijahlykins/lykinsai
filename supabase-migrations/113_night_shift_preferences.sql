-- =====================================================================
-- 113 — Night Shift: opt-in overnight project morning briefs
-- =====================================================================
-- Phase 0 of the Project Steward: a Render cron runs jobs/runNightBrief.js
-- for users with night_shift_enabled=true. Each active project gets a
-- `morning_brief` push in lykn_project_state (set_by_client='night-shift').

ALTER TABLE public.lykn_user_preferences
  ADD COLUMN IF NOT EXISTS night_shift_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.lykn_user_preferences.night_shift_enabled IS
  'When true, the Night Shift cron synthesizes a morning_brief project-state push for each active project overnight. Honoured only when memory_paused is false.';
