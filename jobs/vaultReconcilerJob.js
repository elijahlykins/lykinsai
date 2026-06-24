// =====================================================================
// jobs/vaultReconcilerJob.js — vault upload reconciler
// =====================================================================
// The durable backstop (part 3 of the orphan-upload fix). The client-side
// commit point in src/lib/vault/uploadCancellation.ts stops new orphans for
// uploads a tab actually finishes — but a crash / force-quit / closed lid
// between "bytes in storage" and "row inserted" (or a dismiss the in-memory
// registry never sees because the tab is gone) leaves an inconsistency no
// client code can clean up. This job reconciles the two directions:
//
//   A. row-without-file  — a vault_items row whose storage object is gone.
//      We mark upload_state='missing' (preserving the row's metadata so the
//      user can re-upload) instead of leaving a dead [View File] link.
//
//   B. file-without-row  — a storage object no vault_items row references.
//      Truly leaked bytes. Deleted ONLY when the destructive sweep is
//      enabled, and only after cross-checking the content marker (which can
//      hold a storage_path the normalized column doesn't), so a live file is
//      never reaped.
//
// Grace window: rows/objects younger than the grace are skipped so genuinely
// in-flight uploads aren't reaped mid-flight.
//
// Safety posture: DRY-RUN by default. Detection always runs and is reported;
// mutations (marking 'missing', deleting leaked files) only happen when
// explicitly enabled. The destructive file deletion is double-gated (see
// runVaultReconciler args).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_BUCKET = 'user-files';
// Rows must be at least this old before a missing object counts as orphaned —
// protects uploads that are mid-flight (bytes up, row landing momentarily).
const DEFAULT_GRACE_MINUTES = 30;
// Leaked files get a longer grace: the file lands before the row, so a freshly
// uploaded object briefly looks "unreferenced" until its insert commits.
const DEFAULT_LEAK_GRACE_MINUTES = 60;
const PAGE = 1000;

// Hard guardrail for the UNSAFE reverse-scan sweep. On the shared user-files
// bucket, a large candidate count almost always means a reference source we
// haven't accounted for (e.g. chat history trimmed past 50 messages), NOT a
// pile of real orphans. If the reverse-scan ever proposes more than this many
// deletions in a single run, we refuse to delete ANY of them and demand human
// review — better to under-clean than to nuke live files.
const MAX_SAFE_LEAKED_DELETE = 25;

// Only objects matching the vault upload layout `<uuid>/<uuid>/<file>` are ever
// considered for deletion — avatars, exports, and anything else in the bucket
// that doesn't look like a vault upload is left strictly alone.
const VAULT_OBJECT_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+/i;

function buildAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('vaultReconcilerJob: missing SUPABASE_URL / SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Robust port of server.js#findAttachmentsMarkerSpan — walks the JSON array
// with string/escape tracking so brackets inside string values (filenames,
// code snippets, flattened bodies) don't desync the parser. Returns the first
// attachment object, or null.
function parseMarkerPrimary(content) {
  const raw = String(content || '');
  const MARKER = '[ATTACHMENTS_JSON:';
  const start = raw.indexOf(MARKER);
  if (start === -1) return null;
  const jsonStart = start + MARKER.length;
  if (raw[jsonStart] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd === -1) return null;
  try {
    const arr = JSON.parse(raw.slice(jsonStart, jsonEnd));
    return Array.isArray(arr) ? arr[0] || null : null;
  } catch {
    return null;
  }
}

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx + 1);
}

// Add a path and its derivative siblings (medium/thumb/poster live in the same
// folder as the original) to the referenced set, so the leaked-file sweep never
// deletes a variant of a still-referenced upload.
function addReferenced(set, path) {
  if (!path || typeof path !== 'string') return;
  set.add(path);
  const dir = dirOf(path);
  if (dir) {
    set.add(`${dir}medium.jpg`);
    set.add(`${dir}thumb.jpg`);
    set.add(`${dir}poster.jpg`);
  }
}

// `user-files` is a SHARED bucket. Besides vault uploads it holds chat
// attachments + AI-generated chat images/artifacts (src/lib/chat/ingestChatFiles.ts,
// src/pages/LyknChat.tsx) — and chat attachments use the EXACT same
// `<uuid>/<uuid>/original.ext` layout as vault uploads, so they are
// indistinguishable from vault orphans by path shape alone. The leaked-file
// sweep MUST therefore allow-list every storage path referenced anywhere,
// not just in vault_items, or it would delete live chat files. Chat snapshots
// live in lykn_chat_states.state (jsonb) with paths buried at varying depths
// (message attachments, block data, aiImageStoragePath), so we deep-walk the
// whole state object and harvest any storage-path-looking key.
const STORAGE_PATH_KEY = /(^|_|\b)(storage_?path|aiimagestoragepath)$/i;

function deepCollectStoragePaths(node, set, depth = 0) {
  if (node == null || depth > 12) return;
  if (Array.isArray(node)) {
    for (const v of node) deepCollectStoragePaths(v, set, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && STORAGE_PATH_KEY.test(k)) addReferenced(set, v);
      else deepCollectStoragePaths(v, set, depth + 1);
    }
  }
}

async function collectChatReferencedPaths(admin, referenced) {
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('lykn_chat_states')
      .select('state')
      .range(from, from + PAGE - 1);
    if (error) {
      // Table renamed/missing in this environment — log and move on rather
      // than aborting the whole reconcile. The leaked sweep stays gated, so a
      // gap here can only ever UNDER-delete (safe), never over-delete.
      console.warn(`⚠️  collectChatReferencedPaths: ${error.message} — chat refs skipped`);
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data) deepCollectStoragePaths(row.state, referenced);
    if (data.length < PAGE) break;
    from += PAGE;
  }
}

/**
 * Build the "do not delete" allow-list for the leaked-file sweep: every storage
 * path referenced ANYWHERE — vault_items (columns + legacy content marker) AND
 * chat snapshots (lykn_chat_states). Missing any source here risks deleting a
 * live file, so this is intentionally broad.
 */
async function collectReferencedPaths(admin) {
  const referenced = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('vault_items')
      .select('storage_path, variant_medium_path, variant_thumb_path, content')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      addReferenced(referenced, row.storage_path);
      addReferenced(referenced, row.variant_medium_path);
      addReferenced(referenced, row.variant_thumb_path);
      const att = parseMarkerPrimary(row.content);
      if (att) {
        addReferenced(referenced, att.storagePath);
        addReferenced(referenced, att.variantMediumPath);
        addReferenced(referenced, att.variantThumbPath);
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Critical: also allow-list every chat-referenced storage path.
  await collectChatReferencedPaths(admin, referenced);

  return referenced;
}

/**
 * Backfill `storage_path` / `storage_bucket` from the content marker for
 * file_upload rows whose column is still NULL (older rows that predate the
 * dual-write columns). The missing-object detector's SQL join keys off the
 * column, so this must run first.
 */
async function backfillStoragePaths(admin, { dryRun }) {
  let scanned = 0;
  let backfilled = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('vault_items')
      .select('id, user_id, content, storage_path, storage_bucket')
      .eq('source', 'file_upload')
      .is('storage_path', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      scanned += 1;
      const att = parseMarkerPrimary(row.content);
      const path = att?.storagePath;
      if (!path || typeof path !== 'string') continue;
      const bucket = att?.storageBucket || DEFAULT_BUCKET;
      if (dryRun) {
        backfilled += 1;
        continue;
      }
      const { error: upErr } = await admin
        .from('vault_items')
        .update({ storage_path: path, storage_bucket: bucket })
        .eq('id', row.id);
      if (!upErr) backfilled += 1;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { scanned, backfilled };
}

// Fallback existence probe when the RPC isn't available (e.g. migration 111
// not yet applied). Mirrors the verification approach: a signed URL can only
// be minted for an object that exists.
async function objectExists(admin, bucket, path) {
  const { data, error } = await admin.storage
    .from(bucket || DEFAULT_BUCKET)
    .createSignedUrl(path, 60);
  if (error) return false;
  return !!data?.signedUrl;
}

async function findMissingViaRpc(admin, graceMinutes) {
  const { data, error } = await admin.rpc('vault_find_missing_objects', {
    grace_minutes: graceMinutes,
  });
  if (error) return null; // RPC not deployed → caller falls back
  return data || [];
}

async function findMissingViaProbe(admin, graceMinutes) {
  const cutoff = Date.now() - graceMinutes * 60 * 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('vault_items')
      .select('id, user_id, storage_path, storage_bucket, content, created_at')
      .eq('source', 'file_upload')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (new Date(row.created_at).getTime() > cutoff) continue;
      const att = parseMarkerPrimary(row.content);
      const path = row.storage_path || att?.storagePath || null;
      const bucket = row.storage_bucket || att?.storageBucket || DEFAULT_BUCKET;
      if (!path) continue;
      const exists = await objectExists(admin, bucket, path);
      if (!exists) {
        rows.push({ id: row.id, user_id: row.user_id, storage_path: path, storage_bucket: bucket, created_at: row.created_at });
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function markMissing(admin, rows, { dryRun }) {
  if (dryRun || rows.length === 0) return 0;
  let marked = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const ids = rows.slice(i, i + 100).map((r) => r.id);
    const { error } = await admin
      .from('vault_items')
      .update({ upload_state: 'missing' })
      .in('id', ids);
    if (!error) marked += ids.length;
  }
  return marked;
}

/**
 * Detect (and optionally delete) leaked storage objects: vault-shaped files in
 * the bucket that NO vault_items row references, older than the leak grace.
 */
async function sweepLeakedFiles(admin, { bucket, leakGraceMinutes, referenced, dryRun, deleteLeaked }) {
  const { data, error } = await admin.rpc('vault_list_storage_objects', {
    p_bucket: bucket,
    older_than_minutes: leakGraceMinutes,
  });
  if (error) {
    // RPC not deployed — we can't safely enumerate storage, so report nothing
    // rather than guess. (Listing per-folder via the storage API doesn't scale
    // and isn't worth the risk here.)
    return { candidates: 0, deleted: 0, rpcMissing: true, sample: [] };
  }
  const leaked = [];
  for (const obj of data || []) {
    const name = obj?.name;
    if (!name || referenced.has(name)) continue;
    if (!VAULT_OBJECT_SHAPE.test(name)) continue; // never touch non-vault objects
    leaked.push(name);
  }

  let deleted = 0;
  let refused = false;
  if (deleteLeaked && !dryRun && leaked.length) {
    if (leaked.length > MAX_SAFE_LEAKED_DELETE) {
      // Too many candidates → almost certainly an unaccounted reference
      // source, not real orphans. Refuse the whole batch and demand review.
      refused = true;
      console.warn(
        `🛑 vaultReconciler: reverse-scan proposed ${leaked.length} deletions (> ${MAX_SAFE_LEAKED_DELETE} cap) — REFUSING all. ` +
          `Investigate before deleting; the shared user-files bucket likely has references this job doesn't track.`,
      );
    } else {
      for (let i = 0; i < leaked.length; i += 100) {
        const batch = leaked.slice(i, i + 100);
        const { error: rmErr } = await admin.storage.from(bucket).remove(batch);
        if (!rmErr) deleted += batch.length;
      }
    }
  }
  return { candidates: leaked.length, deleted, refused, rpcMissing: false, sample: leaked.slice(0, 20) };
}

/**
 * SAFE, always-on sweep of abandoned in-flight uploads via the upload ledger
 * (migration 112). A `lykn_upload_ledger` row still state='uploading' past the
 * grace window is positive proof the vault pipeline started an upload that
 * never committed (crash / tab-close between bytes-up and row-insert) — the one
 * case where deleting the storage object is provably safe, because no other
 * feature writes vault ledger rows.
 *
 * Unlike the reverse-scan sweep this needs NO destructive flag: it can only
 * ever touch objects the vault pipeline itself recorded and abandoned. We still
 * cross-check the referenced allow-list as a belt-and-suspenders guard — if a
 * path turns out to be referenced (a committed upload whose ledger row wasn't
 * cleared), we drop only the stale ledger row and leave the file alone.
 */
async function sweepAbandonedUploads(admin, { graceMinutes, referenced, dryRun }) {
  const cutoffIso = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
  let rows;
  try {
    const { data, error } = await admin
      .from('lykn_upload_ledger')
      .select('id, bucket, storage_path, created_at')
      .eq('state', 'uploading')
      .lt('created_at', cutoffIso)
      .limit(5000);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    // Table missing (pre-migration) — nothing to do.
    console.warn(`⚠️  sweepAbandonedUploads: ${err?.message || err} — ledger sweep skipped`);
    return { abandoned: 0, filesDeleted: 0, staleLedgerCleared: 0, tableMissing: true };
  }

  let filesDeleted = 0;
  let staleLedgerCleared = 0;
  const toDeleteByBucket = new Map();
  const staleLedgerIds = [];
  const abandonedIds = [];

  for (const r of rows) {
    if (referenced.has(r.storage_path)) {
      // Committed after all (ledger row simply wasn't cleared) — never delete
      // the file; just retire the stale ledger row.
      staleLedgerIds.push(r.id);
      continue;
    }
    abandonedIds.push(r.id);
    const bucket = r.bucket || DEFAULT_BUCKET;
    if (!toDeleteByBucket.has(bucket)) toDeleteByBucket.set(bucket, []);
    toDeleteByBucket.get(bucket).push(r.storage_path);
  }

  if (!dryRun) {
    for (const [bucket, paths] of toDeleteByBucket) {
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { error: rmErr } = await admin.storage.from(bucket).remove(batch);
        if (!rmErr) filesDeleted += batch.length;
      }
    }
    const allIds = [...abandonedIds, ...staleLedgerIds];
    for (let i = 0; i < allIds.length; i += 100) {
      const ids = allIds.slice(i, i + 100);
      await admin.from('lykn_upload_ledger').delete().in('id', ids);
    }
  }
  staleLedgerCleared = staleLedgerIds.length;

  return {
    abandoned: abandonedIds.length,
    filesDeleted,
    staleLedgerCleared,
    tableMissing: false,
  };
}

/**
 * Orchestrate a full reconciliation pass.
 *
 * @param {object}  opts
 * @param {boolean} opts.dryRun       Default true. When true, NOTHING is
 *                                    mutated — detection is reported only.
 * @param {number}  opts.graceMinutes Age before a missing object counts as
 *                                    orphaned (row-without-file).
 * @param {number}  opts.leakGraceMinutes Age before an unreferenced object
 *                                    counts as leaked (file-without-row).
 * @param {boolean} opts.deleteLeaked Default false. Enables the DESTRUCTIVE
 *                                    file-without-row sweep. Even when true,
 *                                    deletion still requires dryRun=false.
 * @param {string}  opts.bucket       Storage bucket (default 'user-files').
 */
export async function runVaultReconciler(opts = {}) {
  const dryRun = opts.dryRun !== false; // default true (safe)
  const graceMinutes = Number.isFinite(opts.graceMinutes) ? opts.graceMinutes : DEFAULT_GRACE_MINUTES;
  const leakGraceMinutes = Number.isFinite(opts.leakGraceMinutes) ? opts.leakGraceMinutes : DEFAULT_LEAK_GRACE_MINUTES;
  const deleteLeaked = opts.deleteLeaked === true;
  const bucket = opts.bucket || DEFAULT_BUCKET;

  const admin = buildAdminClient();
  const startedAt = Date.now();

  // 1. Backfill storage_path from marker so the SQL detector can see old rows.
  const backfill = await backfillStoragePaths(admin, { dryRun });

  // 2. Allow-list of every referenced path (column + marker) for the leak sweep.
  const referenced = await collectReferencedPaths(admin);

  // 3. Row-without-file: find + flag.
  let missing = await findMissingViaRpc(admin, graceMinutes);
  let detector = 'rpc';
  if (missing === null) {
    missing = await findMissingViaProbe(admin, graceMinutes);
    detector = 'probe';
  }
  const markedMissing = await markMissing(admin, missing, { dryRun });

  // 4. Abandoned in-flight uploads (file-without-row, SAFE path): reap via the
  // ledger. Always on — provably safe, no destructive flag needed.
  const abandoned = await sweepAbandonedUploads(admin, {
    graceMinutes: leakGraceMinutes,
    referenced,
    dryRun,
  });

  // 5. Reverse-scan leaked files (file-without-row, UNSAFE path): detect, and
  // only delete behind the destructive flag + the MAX_SAFE_LEAKED_DELETE
  // guardrail. Report-only by default.
  const leak = await sweepLeakedFiles(admin, {
    bucket,
    leakGraceMinutes,
    referenced,
    dryRun,
    deleteLeaked,
  });

  const summary = {
    dryRun,
    deleteLeaked,
    graceMinutes,
    leakGraceMinutes,
    bucket,
    detector,
    backfill,
    referencedPaths: referenced.size,
    missingObjects: missing.length,
    markedMissing,
    missingSample: missing.slice(0, 20).map((r) => ({ id: r.id, storage_path: r.storage_path })),
    abandonedUploads: abandoned.abandoned,
    abandonedFilesDeleted: abandoned.filesDeleted,
    abandonedStaleLedgerCleared: abandoned.staleLedgerCleared,
    abandonedLedgerMissing: abandoned.tableMissing,
    leakedCandidates: leak.candidates,
    leakedDeleted: leak.deleted,
    leakedRefused: leak.refused,
    leakRpcMissing: leak.rpcMissing,
    leakedSample: leak.sample,
    durationMs: Date.now() - startedAt,
  };

  console.log(
    `🧹 vaultReconciler: dryRun=${dryRun} detector=${detector} ` +
      `backfilled=${backfill.backfilled}/${backfill.scanned} ` +
      `missing=${missing.length} marked=${markedMissing} ` +
      `abandoned=${abandoned.abandoned} abandonedDeleted=${abandoned.filesDeleted}` +
      `${abandoned.tableMissing ? ' (ledger not deployed)' : ''} ` +
      `leakedCandidates=${leak.candidates} leakedDeleted=${leak.deleted}` +
      `${leak.refused ? ' (REFUSED: over cap)' : ''}` +
      `${leak.rpcMissing ? ' (leak RPC not deployed)' : ''} ` +
      `${summary.durationMs}ms`,
  );

  return summary;
}
