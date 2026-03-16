-- ============================================
-- Drop unused social media integration tables
-- Migration: 012_drop_social_tables.sql
--
-- Pinterest/Instagram integrations were removed.
-- Only Google OAuth (via Supabase Auth) is used.
-- ============================================

DROP TABLE IF EXISTS social_data CASCADE;
DROP TABLE IF EXISTS social_connections CASCADE;
