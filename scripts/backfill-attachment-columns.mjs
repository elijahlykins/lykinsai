// Backfill the normalized attachment columns added in migration 104 from the
// legacy `[ATTACHMENTS_JSON:...]` marker (Phase 1 of the Vault Normalization
// Program). The marker is wrapped, so SQL alone can't parse it — we reuse the
// same canonical scanner + classifier the app uses.
//
// For each `notes` row:
//   - parse the primary attachment (marker, or a future `attachments` column)
//   - classify -> att_type / platform / url / host_name
//   - lift scalar facts -> mime_type / byte_size / duration_seconds /
//     page_count / media_width / media_height
//   - collect display-only enrichment -> attachment_preview (jsonb)
//   - rows with no attachment become att_type = 'note'
//
// Safety:
//   - Dry-run by default; pass --commit to write.
//   - Idempotent + resumable: only processes rows where att_type IS NULL
//     (re-running picks up where it left off). Pass --force to recompute all.
//   - The legacy marker is left untouched (dual-write transition).
//
// Usage:
//   node scripts/backfill-attachment-columns.mjs               # dry run
//   node scripts/backfill-attachment-columns.mjs --commit      # apply
//   node scripts/backfill-attachment-columns.mjs --user <uuid> --commit
//   node scripts/backfill-attachment-columns.mjs --force --commit

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { parseAttachmentsFromNote } from '../lib/vault/attachmentsMarker.js';
import { buildAttachmentColumns } from '../lib/vault/attachmentType.js';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const userArg = (() => {
  const i = args.indexOf('--user');
  return i >= 0 ? args[i + 1] : null;
})();

const PAGE = 500;

function computeColumns(note) {
  const attachments = parseAttachmentsFromNote(note);
  return buildAttachmentColumns(attachments[0]);
}

async function main() {
  console.log(`[backfill-attachment-columns] mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}${FORCE ? ' force' : ''}${userArg ? ` user=${userArg}` : ''}`);

  let processed = 0;
  let updated = 0;
  let failed = 0;
  const typeCounts = {};

  // Resumable loop: when not forcing, we only select rows still missing
  // att_type, and each committed batch shrinks that set. In dry-run / force we
  // paginate by offset since the set doesn't shrink.
  let offset = 0;
  for (;;) {
    let q = supabase
      .from('vault_items')
      .select('id, user_id, content, attachments, updated_at')
      .order('updated_at', { ascending: false })
      .limit(PAGE);
    if (userArg) q = q.eq('user_id', userArg);
    if (!FORCE) q = q.is('att_type', null);
    if (FORCE || !COMMIT) q = q.range(offset, offset + PAGE - 1);

    const { data, error } = await q;
    if (error) {
      console.error('query failed:', error.message);
      process.exit(1);
    }
    if (!data?.length) break;

    for (const note of data) {
      processed += 1;
      let cols;
      try {
        cols = computeColumns(note);
      } catch (err) {
        console.warn(`  ${note.id} — classify failed: ${err.message}`);
        failed += 1;
        continue;
      }
      typeCounts[cols.att_type] = (typeCounts[cols.att_type] || 0) + 1;

      if (!COMMIT) {
        updated += 1;
        continue;
      }

      const { error: upErr } = await supabase
        .from('vault_items')
        .update(cols)
        .eq('id', note.id)
        .eq('user_id', note.user_id)
        .eq('updated_at', note.updated_at);
      if (upErr) {
        console.error(`    ${note.id} update failed: ${upErr.message}`);
        failed += 1;
        continue;
      }
      updated += 1;
    }

    // Advance. In resumable commit mode the filtered set shrank, so we stay at
    // offset 0; otherwise step the window forward.
    if (FORCE || !COMMIT) offset += PAGE;
    if (data.length < PAGE && (FORCE || !COMMIT)) break;
    if (!COMMIT && data.length < PAGE) break;
    process.stdout.write(`  …processed=${processed} ${COMMIT ? 'updated' : 'would-update'}=${updated}\r`);
  }

  console.log(`\n[backfill-attachment-columns] done — processed=${processed} ${COMMIT ? 'updated' : 'would-update'}=${updated} failed=${failed}`);
  console.log('  by type:', JSON.stringify(typeCounts));
  if (!COMMIT) console.log('Re-run with --commit to apply.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
