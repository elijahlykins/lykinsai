# Supabase Storage Setup Guide

## 1. Create Storage Bucket

1. Go to your Supabase Dashboard
2. Navigate to **Storage** → **Buckets**
3. Click **New Bucket**
4. Configure:
   - **Name**: `user-files`
   - **Public**: `false` (private bucket)
   - **File size limit**: Set based on your needs (e.g., 100MB)
   - **Allowed MIME types**: Leave empty for all types, or specify:
     - `application/pdf`
     - `image/*`
     - `video/*`
     - `application/msword`
     - `application/vnd.openxmlformats-officedocument.*`
     - etc.

## 2. Storage Policies (RLS)

Run this SQL in your Supabase SQL Editor:

```sql
-- Allow users to upload files to their own folder
CREATE POLICY "Users can upload own files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'user-files' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to view their own files
CREATE POLICY "Users can view own files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'user-files' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to update their own files
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'user-files' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'user-files' AND
  (storage.foldername(name))[1] = auth.uid()::text
);
```

## 3. Storage Path Structure

Files will be stored with this structure:
```
user-files/
  {user_id}/
    {file_id}/
      original.{ext}
      thumbnail.jpg (if applicable)
```

## 4. Environment Variables

Add to your `.env`:
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key
```

## 5. Testing

After setup, test file upload:
1. Sign in to your app
2. Try uploading a file
3. Check Supabase Storage → `user-files` bucket
4. Verify file appears in `{user_id}/` folder

## 6. Run Memory Cleanup Migration (One-Time)

If Memory loading was previously slow due to oversized note content, run:

```sql
-- Cleanup oversized inline blobs in notes.content
-- File: supabase-migrations/008_memory_cleanup_oversized_note_content.sql
```

This migration:
- Replaces huge inline `data:` blobs in `notes.content` with `[BLOB_REMOVED]`
- Logs changed rows into `memory_notes_cleanup_audit`

## 7. Add Notes Feed Performance Index

Run:

```sql
-- Notes performance index
-- File: supabase-migrations/009_notes_user_updated_at_index.sql
```

This creates an index for memory feed queries ordered by `updated_at` per user.

## 8. Rollback / Safety Notes

Before running cleanup in production, make a backup:

```sql
create table if not exists notes_backup_before_memory_cleanup as
select * from notes;
```

If you need to rollback immediately:

```sql
-- Restore from backup
truncate table notes;
insert into notes select * from notes_backup_before_memory_cleanup;
```

