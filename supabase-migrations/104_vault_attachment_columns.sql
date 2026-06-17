-- 104_vault_attachment_columns.sql
--
-- Phase 1 of the Vault Normalization Program.
--
-- Today, a vault item's attachment details are packed into a single
-- `[ATTACHMENTS_JSON:[...]]` marker inside `notes.content` (see
-- src/lib/vault/attachmentsMarker.ts). Every app then re-guesses the type,
-- re-derives the host, and unpacks the blob just to render a card. This
-- promotes the *primary* attachment's stable contract fields to real columns
-- so they're displayable/filterable without unpacking the blob, and so the
-- iOS app stops mis-rendering the type "zoo".
--
-- Model: one primary attachment per vault item. Scalar contract fields become
-- columns; display-only enrichment (title/description/image/favicon/oembed/…)
-- stays together in `attachment_preview` jsonb. The legacy marker remains the
-- transitional source of truth (dual-write) until iOS adopts the columns, so
-- this migration is purely additive and reversible.
--
-- The table is still named `notes` here; the rename to `vault_items` happens
-- in a later phase (Phase 5).
--
-- Idempotent: safe to run more than once.

-- Canonical attachment type. Enum values (validated in app code, not a DB
-- CHECK, so adding a type never needs a migration):
--   note | link | social | youtube | image | video | audio | pdf | file
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS att_type text;

-- Social network for `att_type = 'social'` only:
--   x | instagram | tiktok | facebook | linkedin | reddit | bluesky
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS platform text;

-- Normalized web address for link/social/youtube items. Always starts with
-- http:// or https:// when present (normalized at save time).
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS url text;

-- Where an uploaded file lives. Fresh signed download links are generated on
-- demand from these rather than persisting an expiring URL.
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS storage_bucket text;

-- Basic file facts as real, filterable values.
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS byte_size bigint;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS duration_seconds numeric;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS page_count integer;

-- Derived automatically from the normalized `url` (so it can't disagree with
-- the URL it came from).
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS host_name text;

-- Intrinsic pixel dimensions for image/video (layout reserves the exact
-- aspect-ratio slot — no scroll jank). Previously only stored inside the marker.
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS media_width integer;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS media_height integer;

-- Multi-size derivatives (Phase 3 populates these; column added now so the
-- schema is stable and Phase 3 needs no further migration).
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS variant_medium_path text;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS variant_thumb_path text;

-- Display-only enrichment that nothing needs to search or enforce rules on:
-- title, description, image, thumbnail_url, favicon, siteName, authorName,
-- authorHandle, videoId, extractedText, aiDescription, oembed*, etc.
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS attachment_preview jsonb;

-- Indexes: filter by type, dedupe by URL, group by host. Partial indexes keep
-- them small (most rows are plain notes with NULLs here).
CREATE INDEX IF NOT EXISTS idx_notes_att_type
  ON public.notes (att_type) WHERE att_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_url
  ON public.notes (url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_host_name
  ON public.notes (host_name) WHERE host_name IS NOT NULL;

COMMENT ON COLUMN public.notes.att_type IS
  'Canonical attachment type: note|link|social|youtube|image|video|audio|pdf|file. Decided once at save time. Phase 1 of Vault Normalization.';
COMMENT ON COLUMN public.notes.attachment_preview IS
  'Display-only enrichment for the primary attachment (title, description, image, thumbnail_url, favicon, siteName, authorName, authorHandle, videoId, extractedText, aiDescription, oembed*). Not searched/enforced.';

-- Tell PostgREST to pick up the new columns.
NOTIFY pgrst, 'reload schema';
