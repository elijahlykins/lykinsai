-- ============================================================================
-- 124 — Memory Architecture Replacement, Phase 1: database-backed Markdown memory
-- ============================================================================
-- The new user-memory core (server/memory/). Memory tells the AI WHAT it knows
-- about this user, the way skills tell it HOW to work. Each memory is a small
-- Markdown document the AI/user addresses by a logical path (profile.md,
-- preferences.md, goals.md, decisions.md, projects/<slug>.md, topics/<slug>.md).
-- These are NOT filesystem files — they are rows here, surfaced as Markdown.
--
-- This is ADDITIVE ONLY. It does not touch any Synthesis / User Model /
-- Beliefs / Concepts tables (022, 023, 024, 039, 043, 046, 047, 049, 054,
-- 056-059, 061, 063, 064). Those remain live until the Phase 2 cutover and
-- Phase 3 demolition.
--
-- Two tables:
--   • lykn_memory_documents         — current state, one row per logical path.
--   • lykn_memory_document_versions — full snapshot per meaningful write
--     (rollback / audit / provenance). Snapshots, not deltas: documents are
--     deliberately small, so full copies are cheap and easy to reason about.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.lykn_memory_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Logical path the AI/user sees ("profile.md", "projects/lykn.md").
  -- The service layer is the real validator (memoryPaths.js); this CHECK is a
  -- backstop: lowercase slug segments, exactly zero or one directory level,
  -- always ends in .md, and no way to express traversal ("." / ".." can't match).
  path TEXT NOT NULL
    CHECK (
      length(path) <= 120
      AND path ~ '^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)?\.md$'
    ),
  -- Human-readable title for the registry / future Memory UI.
  name TEXT NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 120),
  -- One-line "what lives in this memory" for the registry (L1).
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  -- Memory category. Deliberately small V1 ontology.
  type TEXT NOT NULL
    CHECK (type IN ('profile', 'preferences', 'goals', 'decisions', 'project', 'topic', 'relationships')),
  -- The document body. Capped hard at the DB layer so no write path (even a
  -- future bug) can grow a memory without bound; the service enforces a
  -- smaller tunable budget below this ceiling.
  markdown TEXT NOT NULL CHECK (length(markdown) <= 32768),
  -- Compact registry/retrieval summary — must stay much smaller than the body.
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 1200),
  -- active → visible to registry/retrieval; archived → soft-deleted (memory_forget).
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- Optimistic-concurrency stamp. Every persisted mutation increments it; a
  -- writer holding a stale version is rejected instead of silently clobbering.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

-- One document per logical path per user — the identity of a memory.
CREATE UNIQUE INDEX IF NOT EXISTS lykn_memory_documents_user_path_key
  ON public.lykn_memory_documents (user_id, path);

-- Primary access pattern: the registry ("this user's active memories").
CREATE INDEX IF NOT EXISTS lykn_memory_documents_user_active_idx
  ON public.lykn_memory_documents (user_id, updated_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.lykn_memory_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_document_id UUID NOT NULL
    REFERENCES public.lykn_memory_documents(id) ON DELETE CASCADE,
  -- Denormalized so ownership checks and per-user erasure never need a join.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The document version this snapshot produced (matches documents.version
  -- after the write). Unique per document — one snapshot per version.
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Full Markdown AFTER the change was applied (snapshot, not delta).
  markdown TEXT NOT NULL CHECK (length(markdown) <= 32768),
  -- What kind of mutation produced this snapshot.
  change_type TEXT NOT NULL
    CHECK (change_type IN ('create', 'patch', 'replace', 'archive', 'restore', 'compact')),
  -- Provenance: WHO/WHAT authorized the write. This is the trust record —
  -- external content must never appear here (policy rejects it upstream).
  source_type TEXT NOT NULL
    CHECK (source_type IN ('explicit_user', 'system_event', 'user_confirmed', 'inferred', 'migration')),
  -- Small structured provenance detail (e.g. patch op, origin surface).
  -- Kept out of the visible Markdown on purpose; capped by the service.
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lykn_memory_document_versions_doc_version_key
  ON public.lykn_memory_document_versions (memory_document_id, version);

CREATE INDEX IF NOT EXISTS lykn_memory_document_versions_user_idx
  ON public.lykn_memory_document_versions (user_id, created_at DESC);

ALTER TABLE public.lykn_memory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_memory_document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_memory_documents_select_own ON public.lykn_memory_documents;
CREATE POLICY lykn_memory_documents_select_own
  ON public.lykn_memory_documents FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_memory_documents_insert_own ON public.lykn_memory_documents;
CREATE POLICY lykn_memory_documents_insert_own
  ON public.lykn_memory_documents FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_memory_documents_update_own ON public.lykn_memory_documents;
CREATE POLICY lykn_memory_documents_update_own
  ON public.lykn_memory_documents FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_memory_documents_delete_own ON public.lykn_memory_documents;
CREATE POLICY lykn_memory_documents_delete_own
  ON public.lykn_memory_documents FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Version history is IMMUTABLE from clients: select + insert own rows only.
-- No update/delete policies on purpose — history rows can only disappear via
-- the parent-document cascade (hard delete) or the user_id cascade (account
-- erasure). The server-side hard-delete path uses the service role.
DROP POLICY IF EXISTS lykn_memory_document_versions_select_own ON public.lykn_memory_document_versions;
CREATE POLICY lykn_memory_document_versions_select_own
  ON public.lykn_memory_document_versions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_memory_document_versions_insert_own ON public.lykn_memory_document_versions;
CREATE POLICY lykn_memory_document_versions_insert_own
  ON public.lykn_memory_document_versions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.lykn_memory_documents IS
  'Memory Architecture Replacement Phase 1: database-backed Markdown memory documents addressed by logical path (profile.md, preferences.md, projects/<slug>.md, ...). One active row per (user, path). Replaces the Synthesis/User-Model/Beliefs memory stack after the Phase 2 cutover.';

COMMENT ON TABLE public.lykn_memory_document_versions IS
  'Full-snapshot version history for lykn_memory_documents. One immutable row per meaningful write, carrying change_type + provenance source_type. Enables rollback, audit, and debugging; snapshots preferred over deltas because documents are small.';

NOTIFY pgrst, 'reload schema';
