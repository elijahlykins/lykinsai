-- ============================================
-- Raise the per-file size limit on the `user-files` storage bucket so
-- large video uploads (.mov, .mp4, etc.) can complete via TUS resumable
-- uploads. Also relax the allowed MIME types list so that Safari-origin
-- .mov files (which sometimes arrive with an empty Content-Type) aren't
-- rejected at the bucket level.
--
-- NOTE: Supabase's project-wide "Max file size" setting (Dashboard →
-- Storage → Settings) still applies on top of this and must be raised to
-- at least the same value for large uploads to succeed. On Free tier this
-- is capped at 50 MB; on Pro it goes up to 50 GB via TUS.
-- ============================================

-- 5 GiB per file – matches what Supabase Pro supports via TUS resumable.
UPDATE storage.buckets
SET file_size_limit = 5368709120
WHERE id = 'user-files';

-- NULL = allow any MIME type. If you want to keep the allow-list approach,
-- replace NULL with an explicit ARRAY including video/quicktime,
-- video/mp4, video/x-m4v, etc.
UPDATE storage.buckets
SET allowed_mime_types = NULL
WHERE id = 'user-files';
