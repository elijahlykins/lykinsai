-- ============================================
-- AI caching layer — eliminate redundant LLM / Whisper calls
-- Migration: 026_ai_caching_layer.sql
-- ============================================
-- Three caches:
--   1. ai_description_cache  — image / vault-item descriptions (gpt-4o-mini vision)
--   2. ai_transcription_cache — uploaded file transcripts (Whisper)
--   3. notes.ai_content_hash  — skip re-enrichment when content is unchanged

-- ---------------------------------------------------------------------------
-- 1. Description cache (keyed by sha256 of normalised URL or content fingerprint)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_description_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_description_cache_user_hash_unique UNIQUE (user_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_ai_description_cache_lookup
  ON ai_description_cache (user_id, url_hash);

ALTER TABLE ai_description_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own description cache"
  ON ai_description_cache FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own description cache"
  ON ai_description_cache FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own description cache"
  ON ai_description_cache FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Service-role bypass (server writes on behalf of the user)
CREATE POLICY "Service role full access to description cache"
  ON ai_description_cache FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Transcription cache (keyed by sha256 of file buffer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_transcription_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL,
  duration_sec REAL,
  model TEXT NOT NULL DEFAULT 'whisper-1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_transcription_cache_user_hash_unique UNIQUE (user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_ai_transcription_cache_lookup
  ON ai_transcription_cache (user_id, content_hash);

ALTER TABLE ai_transcription_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own transcription cache"
  ON ai_transcription_cache FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own transcription cache"
  ON ai_transcription_cache FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own transcription cache"
  ON ai_transcription_cache FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to transcription cache"
  ON ai_transcription_cache FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. Content hash on notes (skip enrich when content unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS ai_content_hash TEXT;

COMMENT ON COLUMN public.notes.ai_content_hash IS 'SHA-256 of stripped content at last enrich-note call; skip LLM if unchanged.';
