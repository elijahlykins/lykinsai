# Orphaned-storage reconciliation plan (`user-files` bucket)

**Status: PREPARED, NOT EXECUTED.** Nothing here has touched production. All numbers below are
read-only introspection of the live DB (project `yxntfqgbkxjiyesewyoz`, 2026-07-16).

## Background

The 2026-07-16 App Review audit (LYKN-iOS `AppStore/review-audit-2026-07-16/`) found that the iOS
client-side orphan-recovery sweep (`SyncCoordinator.reconcileOrphanedStorage`) would have minted
~449 duplicate/resurrected vault rows, because it assumed the storage path's `<file_id>` segment is
the `vault_items` row id — untrue for web uploads, and it can't tell deleted-note leftovers from
never-attached uploads. The sweep was **deleted** in the audit-fix sweep (checklist #13). That
leaves the underlying stranded bytes unowned. This plan is the server-side replacement.

## Live classification (2026-07-16 — re-run the report before acting; counts drift)

Path scheme: `user-files/<user_id>/<file_id>/original.<ext>` + `thumb.jpg`/`medium.jpg` variants.
1080 objects total; classification per `<user_id>/<file_id>` folder:

| Class | Folders | Objects | Bytes | Users | Meaning | Action |
|---|---|---|---|---|---|---|
| A — referenced by `vault_items.id` or a `storage_path`/variant path | 223 | 503 | 305 MB | 23 | Healthy | none |
| B — referenced only inside same-user `content`/`url`/`attachment_preview` | 92 | 343 | 211 MB | 14 | Live web uploads (folder id ≠ row id; the exact set the deleted client sweep would have duplicated) | **keep** — deleting breaks live notes. Optional later: backfill `storage_path` from content refs (separate work, not in scope) |
| C2 — unreferenced, `original.*` present | 202 | 202 | 77 MB | 10 | Ambiguous: web-deleted notes' surviving bytes **or** iOS orphaned uploads (bytes landed, row never created) | **quarantine**, retention window, then purge |
| C3 — unreferenced, variants only | 12 | 29 | 6.5 MB | 4 | Derivatives without a source | **quarantine**, then purge |
| X — `<file_id>` referenced by a **different** user's row | 3 | 3 | 2 MB | 3 | Account-fragmentation signature (one person across 4 login identities — see LYKN-iOS memory/audit notes) | **manual review only**, never auto-touched |

## Design decision: no auto-resurrection

Option (a) from the task framing — re-attach recoverable orphans by creating `vault_items` rows —
is rejected. A deleted note's surviving `original.*` is byte-for-byte indistinguishable from an
orphaned upload whose row was never created. Auto-creating rows would resurrect content users
deliberately deleted (a privacy violation, and exactly the failure mode that got the client sweep
deleted). Instead: **quarantine (reversible) → retention window → purge.** If a specific user
reports lost content during the window, their folder can be individually restored and manually
re-attached with their consent.

Quarantine = `storage.move()` within the bucket to `_quarantine/<original path>`. The first path
segment stops being their user id, so per-user RLS storage policies no longer match (users can't
see quarantined objects), while service role can restore. Every commit writes a timestamped restore
manifest JSON.

## Artifacts

| File | Purpose |
|---|---|
| `supabase-queries/orphan_reconciliation_report.sql` | Read-only classifier, SQL twin of the script — run in the SQL editor for the rollup or per-folder manifest |
| `scripts/reconcile-orphaned-storage.mjs` | The reconciler. Modes: `--report` (CSV, no writes), `--quarantine` (dry-run default; `--commit` moves C2+C3 and writes a restore manifest), `--restore <manifest> --commit`, `--purge --older-than <days> --commit`. `--user <uuid>` scopes any mode. Needs `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |

## Execution order (when approved — none of this has run)

1. First ship the audit-fix backend batch (migrations 113–116, recursive account-delete purge) —
   independent of this, but do it first so account deletion stops minting *new* orphans.
2. `node scripts/reconcile-orphaned-storage.mjs --report` — regenerate the CSV, sanity-check the
   class counts against this doc, and review the X-class list by hand.
3. `--quarantine` (dry run), review the printed moves, then `--quarantine --commit`.
4. Wait the retention window (suggest **30 days**) for any user reports; restore individual folders
   with `--restore` if needed.
5. `--purge --older-than 30 --commit`.

## Notes and caveats

- The demo/review account (`appreview@lykn.io`) has zero orphan candidates — App Review is
  unaffected either way.
- All 22 affected owners still exist in `auth.users` (no deleted-account orphans yet — consistent
  with the audit's finding that no vault-bearing account has ever been deleted).
- The report script and SQL intentionally exclude anything already under `_quarantine/`.
- The `--purge` retention clock uses the quarantined object's `created_at`, which Supabase resets
  on move — i.e., it measures time-in-quarantine, which is the correct clock.
- One live `vault_items` row has a dangling `storage_path` (broken tile, audit finding) — that's an
  app-data bug, not a storage orphan; out of scope here.
