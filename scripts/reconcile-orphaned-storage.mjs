// Server-side reconciliation for orphaned `user-files` storage objects.
// Replaces the deleted iOS client-side orphan-recovery sweep (2026-07-16 audit
// fix #13), which would have minted duplicate vault rows. See
// ORPHAN_RECONCILIATION_PLAN.md for the design and decision matrix, and
// supabase-queries/orphan_reconciliation_report.sql for the SQL twin of the
// classifier.
//
// Classes (per <user_id>/<file_id> folder):
//   A  referenced by vault_items.id or storage/variant path  -> no action
//   B  referenced only inside same-user content/url/preview  -> no action (live web uploads)
//   C2 unreferenced, has original.*                          -> quarantine
//   C3 unreferenced, variants only                           -> quarantine
//   X  referenced by a DIFFERENT user's row                  -> printed for manual review, never touched
//
// Quarantine = move within the bucket to `_quarantine/<original path>`. The
// first path segment stops being a user id, so per-user RLS storage policies
// no longer grant access; service role can restore. Fully reversible until
// purged. NOTHING here ever creates vault_items rows: deleted-note leftovers
// and never-attached uploads are indistinguishable, and resurrecting deleted
// user content is worse than stranded bytes.
//
// Safety:
//   - Dry-run by default; pass --commit to write.
//   - Every commit writes a timestamped restore manifest JSON next to this
//     script (reconcile-manifest-<ISO>.json).
//   - Idempotent: already-quarantined objects are skipped; re-running resumes.
//
// Usage:
//   node scripts/reconcile-orphaned-storage.mjs --report            # classify + CSV, no writes
//   node scripts/reconcile-orphaned-storage.mjs --quarantine        # dry-run the moves
//   node scripts/reconcile-orphaned-storage.mjs --quarantine --commit
//   node scripts/reconcile-orphaned-storage.mjs --quarantine --user <uuid> --commit
//   node scripts/reconcile-orphaned-storage.mjs --restore <manifest.json> --commit
//   node scripts/reconcile-orphaned-storage.mjs --purge --older-than 30 --commit

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const BUCKET = 'user-files';
const QUARANTINE_PREFIX = '_quarantine/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const MODE = args.includes('--report') ? 'report'
  : args.includes('--quarantine') ? 'quarantine'
  : args.includes('--restore') ? 'restore'
  : args.includes('--purge') ? 'purge'
  : null;
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const userFilter = flagValue('--user');
const olderThanDays = flagValue('--older-than') ? Number(flagValue('--older-than')) : null;

if (!MODE) {
  console.error('Pass one of --report | --quarantine | --restore <manifest> | --purge');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));

// ---------- storage listing (recursive; storage list() is single-level) ----------

async function listFolder(prefix) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`list(${prefix}): ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
    offset += data.length;
  }
}

// Returns flat [{ path, size, createdAt }] for every object under `root`.
async function listRecursive(root) {
  const entries = await listFolder(root);
  const objects = [];
  for (const entry of entries) {
    const path = root ? `${root}/${entry.name}` : entry.name;
    if (entry.id === null) {
      // folder placeholder -> recurse
      objects.push(...await listRecursive(path));
    } else {
      objects.push({
        path,
        size: entry.metadata?.size ?? 0,
        createdAt: entry.created_at ?? null,
      });
    }
  }
  return objects;
}

// ---------- classification ----------

async function classifyFolders() {
  console.log(`Listing ${BUCKET} recursively…`);
  const objects = (await listRecursive(''))
    .filter((o) => !o.path.startsWith(QUARANTINE_PREFIX));

  const folders = new Map(); // "<uid>/<fileId>" -> { uid, fileId, objects, hasOriginal, hasVariants, bytes }
  for (const o of objects) {
    const [uid, fileId, ...rest] = o.path.split('/');
    if (!fileId || rest.length === 0) continue; // top-level stray, out of scheme
    if (userFilter && uid !== userFilter) continue;
    const keyId = `${uid}/${fileId}`;
    const f = folders.get(keyId) ?? {
      uid, fileId, objects: [], hasOriginal: false, hasVariants: false, bytes: 0,
    };
    f.objects.push(o);
    f.bytes += o.size;
    const leaf = rest[rest.length - 1];
    if (leaf.startsWith('original.')) f.hasOriginal = true;
    else f.hasVariants = true;
    folders.set(keyId, f);
  }
  console.log(`${objects.length} objects in ${folders.size} folders`);

  // Prefetch every vault_items row's reference-bearing columns once (~1k rows)
  // and check locally — avoids hundreds of per-folder ILIKE round-trips and
  // sidesteps PostgREST's inability to filter on a jsonb::text cast.
  console.log('Fetching vault_items reference columns…');
  const idSet = new Set();
  const pathPrefixes = new Set();
  const rows = []; // { userId, blob } — blob is the lowercased searchable text
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('vault_items')
      .select('id, user_id, storage_path, variant_medium_path, variant_thumb_path, content, url, attachment_preview')
      .range(from, from + 999);
    if (error) throw new Error(`vault_items page: ${error.message}`);
    for (const row of data) {
      idSet.add(row.id);
      for (const p of [row.storage_path, row.variant_medium_path, row.variant_thumb_path]) {
        const segs = p?.split('/');
        if (segs?.length >= 2) pathPrefixes.add(`${segs[0]}/${segs[1]}`);
      }
      rows.push({
        userId: row.user_id,
        blob: [row.storage_path, row.content, row.url, row.attachment_preview ? JSON.stringify(row.attachment_preview) : '']
          .filter(Boolean).join(' ').toLowerCase(),
      });
    }
    if (data.length < 1000) break;
  }

  const classified = [];
  for (const f of folders.values()) {
    let cls;
    const needle = f.fileId.toLowerCase();
    if (idSet.has(f.fileId) || pathPrefixes.has(`${f.uid}/${f.fileId}`)) {
      cls = 'A';
    } else if (!UUID_RE.test(f.fileId)) {
      cls = 'X'; // out-of-scheme folder name: never touch automatically
    } else if (rows.some((r) => r.userId === f.uid && r.blob.includes(needle))) {
      cls = 'B';
    } else if (rows.some((r) => r.userId !== f.uid && r.blob.includes(needle))) {
      cls = 'X';
    } else {
      cls = f.hasOriginal ? 'C2' : 'C3';
    }
    classified.push({ ...f, class: cls });
  }
  return classified;
}

function summarize(classified) {
  const byClass = {};
  for (const f of classified) {
    const s = byClass[f.class] ?? { folders: 0, objects: 0, bytes: 0, users: new Set() };
    s.folders += 1;
    s.objects += f.objects.length;
    s.bytes += f.bytes;
    s.users.add(f.uid);
    byClass[f.class] = s;
  }
  for (const [cls, s] of Object.entries(byClass).sort()) {
    console.log(`  ${cls}: ${s.folders} folders, ${s.objects} objects, ${(s.bytes / 1e6).toFixed(1)} MB, ${s.users.size} users`);
  }
}

// ---------- modes ----------

if (MODE === 'report') {
  const classified = await classifyFolders();
  summarize(classified);
  const csvPath = join(here, `reconcile-report-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const rows = ['class,user_id,file_id,objects,bytes,has_original,has_variants,paths'];
  for (const f of classified.sort((a, b) => a.class.localeCompare(b.class) || a.uid.localeCompare(b.uid))) {
    rows.push(`${f.class},${f.uid},${f.fileId},${f.objects.length},${f.bytes},${f.hasOriginal},${f.hasVariants},"${f.objects.map((o) => o.path).join(';')}"`);
  }
  writeFileSync(csvPath, rows.join('\n'));
  console.log(`Report written: ${csvPath}`);
  const xs = classified.filter((f) => f.class === 'X');
  if (xs.length) {
    console.log('\nX-class folders (manual review — cross-user or out-of-scheme; NEVER auto-touched):');
    for (const f of xs) console.log(`  ${f.uid}/${f.fileId} (${f.objects.length} objects)`);
  }
}

if (MODE === 'quarantine') {
  const classified = await classifyFolders();
  summarize(classified);
  const targets = classified.filter((f) => f.class === 'C2' || f.class === 'C3');
  const moves = targets.flatMap((f) => f.objects.map((o) => ({
    from: o.path, to: QUARANTINE_PREFIX + o.path, class: f.class,
  })));
  console.log(`\n${COMMIT ? 'Quarantining' : 'DRY RUN — would quarantine'} ${moves.length} objects from ${targets.length} folders (classes C2+C3).`);
  if (!COMMIT) {
    for (const m of moves.slice(0, 20)) console.log(`  ${m.from} -> ${m.to}`);
    if (moves.length > 20) console.log(`  … and ${moves.length - 20} more`);
    console.log('Pass --commit to execute.');
  } else {
    const manifest = { bucket: BUCKET, quarantinedAt: new Date().toISOString(), moves: [] };
    let failed = 0;
    for (const m of moves) {
      const { error } = await supabase.storage.from(BUCKET).move(m.from, m.to);
      if (error) {
        failed += 1;
        console.error(`  MOVE FAILED ${m.from}: ${error.message}`);
      } else {
        manifest.moves.push(m);
      }
    }
    const manifestPath = join(here, `reconcile-manifest-${manifest.quarantinedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Moved ${manifest.moves.length}, failed ${failed}. Restore manifest: ${manifestPath}`);
  }
}

if (MODE === 'restore') {
  const manifestPath = flagValue('--restore');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(`${COMMIT ? 'Restoring' : 'DRY RUN — would restore'} ${manifest.moves.length} objects from ${manifestPath}`);
  if (COMMIT) {
    let failed = 0;
    for (const m of manifest.moves) {
      const { error } = await supabase.storage.from(BUCKET).move(m.to, m.from);
      if (error) { failed += 1; console.error(`  RESTORE FAILED ${m.to}: ${error.message}`); }
    }
    console.log(`Restored ${manifest.moves.length - failed}, failed ${failed}.`);
  }
}

if (MODE === 'purge') {
  if (!olderThanDays || Number.isNaN(olderThanDays)) {
    console.error('--purge requires --older-than <days> (retention window is explicit, no default purge).');
    process.exit(1);
  }
  const objects = await listRecursive(QUARANTINE_PREFIX.slice(0, -1));
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  // created_at of the quarantined object reflects the MOVE time, so it is the
  // quarantine timestamp — exactly the retention clock we want.
  const stale = objects.filter((o) => o.createdAt && Date.parse(o.createdAt) < cutoff);
  console.log(`${COMMIT ? 'Purging' : 'DRY RUN — would purge'} ${stale.length} of ${objects.length} quarantined objects older than ${olderThanDays} days.`);
  if (COMMIT && stale.length) {
    for (let i = 0; i < stale.length; i += 100) {
      const batch = stale.slice(i, i + 100).map((o) => o.path);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) console.error(`  REMOVE batch failed: ${error.message}`);
    }
    console.log('Purge complete.');
  }
}
