-- Compressed vault understanding for workspace context + synthesis (populated by /api/vault/enrich-note)
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS ai_signals jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.notes.ai_summary IS 'LLM summary of the vault item for WORKSPACE_CONTEXT and embeddings.';
COMMENT ON COLUMN public.notes.ai_signals IS 'Optional structured hints: themes, entities, etc.';
