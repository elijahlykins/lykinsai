# Migration 116 — Anon SECURITY DEFINER lockdown: full disposition record

App Review audit 2026-07-16, checklist #9. Companion to
`116_lock_down_anon_secdef_functions.sql` (referenced from its header) and
`../supabase-queries/rollback_116_lock_down_anon_secdef_functions.sql`.

**Scope.** Every `SECURITY DEFINER` function in schema `public` of live prod
(project `yxntfqgbkxjiyesewyoz`) that was executable by the `anon` role on
2026-07-16, enumerated read-only via `pg_proc.prosecdef` +
`has_function_privilege('anon', oid, 'EXECUTE')`. The enumeration returned
**exactly 26 functions**, matching the count in the audit
(`AppStore/review-audit-2026-07-16/findings.json`, finding "Anon-executable
SECURITY DEFINER RPCs accept arbitrary user_id"). Another 23 SECURITY DEFINER
functions in `public` (admin_*, maintain_*, vault_find_missing_objects, etc.)
were already `postgres`/`service_role`-only and are out of scope.

**Method per function.** Live `pg_get_functiondef` body review (auth.uid()
guard? token gate?), live `pg_proc.proacl`, live `pg_policies` (does any RLS
policy depend on it, and for which roles?), plus a call-site grep of both
repos: `LYKN-Ideation` (web `src/`, `server.js`, `mcp-tools/`, `lib/`,
`scripts/`) and `LYKN-Mobile/LYKN-iOS` (all Swift sources).

**Grant-notation key.** Pre-116 `proacl` entries: `PUBLIC` = `=X/postgres`
(inherited by every role, including anon; `REVOKE FROM anon` alone does NOT
remove it), `anon`/`authenticated`/`service_role` = direct grants.

## Disposition table (all 26)

| # | Function (identity args) | Pre-116 grants | Action in 116 | Justification |
|---|---|---|---|---|
| 1 | `search_notes_bm25(uuid, text, integer)` | anon, service_role | **REVOKE** PUBLIC, anon, authenticated (§1) | SECURITY DEFINER, no auth.uid(); returns any user's note text for an attacker-supplied UUID. Only legit callers are service-role (`mcp-tools/searchVault.js`, `server.js`); iOS mentions it in comments only. |
| 2 | `match_lykn_synthesis_chunks_for_user(vector, uuid, integer, double precision)` | anon, authenticated, service_role | **REVOKE** PUBLIC, anon, authenticated (§1) | No auth.uid(); returns any user's synthesis-chunk content, caller controls `match_threshold` (corpus dump). Service-role callers only (`server.js` synthesis retrieval, `mcp-tools/searchVault.js`). |
| 3 | `count_user_explicit_neurons(uuid)` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§1) | No auth.uid(); leaks per-user neuron counts by UUID. Only invoked from inside the `enforce_synthesis_neuron_cap_*` trigger functions, which execute with their owner's rights — no client grant needed. |
| 4 | `lykn_model_builder_wallet_apply_delta(uuid, bigint, text, text, jsonb)` | anon, authenticated, service_role | **REVOKE** PUBLIC, anon, authenticated (§1) | No auth.uid(); mutates any user's wallet balance + ledger. Sole caller is server-side `lib/modelBuilder/modelBuilderWallet.js` (service role, feature-flagged Stripe path). |
| 5 | `lykn_merge_projects(uuid, uuid, boolean, uuid)` | anon, authenticated, service_role | **REVOKE** PUBLIC, anon; keep authenticated (§2) | Destructive merge. In-body `p_user_id <> auth.uid()` guard only fires when BOTH are non-null, so anon (auth.uid() NULL) + arbitrary `p_user_id` bypassed it. Web `src/lib/userProjects.ts` calls it under an authenticated JWT (kept); MCP `mcp-tools/mergeProjects.js` is service-role. |
| 6 | `lykn_project_has_collaborators(uuid)` | PUBLIC + anon, authenticated, service_role | **REVOKE** PUBLIC, anon; keep authenticated (§3 — **added by this disposition pass**) | Body has **no auth.uid() guard and no token gate**: answers, for any project UUID, whether non-owner member rows exist. Not referenced by any RLS policy (pg_policies checked; all project-table policies are `roles={authenticated}`), so anon EXECUTE was pure exposure. Real caller: web `src/lib/userProjects.ts:1064` merge-guard, authenticated JWT. Residual (accepted, low): authenticated users can probe foreign UUIDs for a 1-bit answer; UUIDv4 unguessable. Follow-up: add in-body membership guard (116 is REVOKE-only by design). |
| 7 | `enforce_blocks_per_chat_cap()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Trigger function; not RPC-invokable (PostgREST call errors), grants inert. Stripped as defense-in-depth; trigger firing uses owner rights, so inserts/updates unaffected. |
| 8 | `enforce_synthesis_neuron_cap_beliefs()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 9 | `enforce_synthesis_neuron_cap_chats()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 10 | `enforce_synthesis_neuron_cap_facts()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 11 | `enforce_upload_rate()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 12 | `enforce_vault_cap()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 13 | `handle_new_user_preferences()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Trigger on `auth.users` insert; fires with owner rights (signup unaffected). |
| 14 | `lykn_custom_agents_touch_updated_at()` | PUBLIC + anon, authenticated | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 15 | `lykn_project_seed_owner_member()` | PUBLIC + anon, authenticated | **REVOKE** PUBLIC, anon, authenticated (§4) | Same as #7. |
| 16 | `rls_auto_enable()` | PUBLIC | **REVOKE** PUBLIC, anon, authenticated (§4) | Event-trigger function; not invokable via RPC at all. |
| 17 | `lykn_chat_share_record_view(text)` | anon, authenticated, service_role | **None — safe (intentional anon surface)** | Token-gated: the only mutation is `view_count + 1 / last_viewed_at` on a row matching a valid, unrevoked, unexpired share token; wrong token = no-op, returns void, leaks nothing. Purpose-built for public share landing pages (anon by design; probe script `scripts/anon-permission-probe.mjs` uses it as its anon-allowed control). |
| 18 | `read_shared_chat(text)` | anon, authenticated, service_role | **None — safe (intentional anon surface)** | Token-gated SELECT: returns the chat + state only for a valid, unrevoked, unexpired token; no token enumeration surface (equality match on an unguessable token). `search_path` pinned. Caveat, recorded honestly: no client call site exists in either repo today, but prod holds 1 active share row (2026-07-16), so an outstanding shared link may depend on it. Candidate for a follow-up revoke if the chat-share feature is confirmed retired. |
| 19 | `resolve_chat_share(text)` | anon, authenticated, service_role | **None — safe (intentional anon surface)** | Same token gate as #18; returns only `chat_id`/`owner_id` for a valid token. Same no-repo-caller caveat as #18. |
| 20 | `vault_manual_notes_for_graph(integer, timestamptz, uuid)` | anon, authenticated, service_role | **None — safe (auth.uid()-guarded)** | Body filters `n.user_id = auth.uid()`; anon (auth.uid() NULL) gets zero rows. Live caller: web `src/lib/vault/fetchMindmapNotes.ts:93` (authenticated). Cited in the audit itself as the correct-pattern example. |
| 21 | `vault_connector_source_counts()` | anon, authenticated, service_role | **None — safe (auth.uid()-guarded)** | Filters `n.user_id = auth.uid()`; anon gets an empty set. Caller: `src/lib/vault/fetchMindmapNotes.ts:173` / `SynthesisLayer.tsx` (authenticated). |
| 22 | `lykn_is_project_member(uuid)` | PUBLIC + anon, authenticated, service_role | **None — safe (auth.uid()-guarded RLS helper)** | Returns true only for a membership row with `user_id = auth.uid()`; anon always false. Backs the `lykn_project_members`/project-table RLS policies (110) and gates #24 — must stay executable by querying roles. |
| 23 | `lykn_is_project_owner(uuid)` | PUBLIC + anon, authenticated, service_role | **None — safe (auth.uid()-guarded RLS helper)** | Same pattern as #22 (owner-role check plus canonical `lykn_projects.user_id = auth.uid()` fallback); anon always false. |
| 24 | `lykn_list_project_members(uuid)` | PUBLIC + anon, authenticated, service_role | **None — safe (membership-gated)** | WHERE clause requires `lykn_is_project_member(p_project)` (i.e. auth.uid() is an accepted member); anon and non-members get zero rows, so the auth.users email join is unreachable for them. Caller: web `src/lib/projectMembers.ts:57` (authenticated). |
| 25 | `lykn_project_can_edit(uuid)` | PUBLIC + anon, authenticated, service_role | **None — safe (auth.uid()-guarded RLS helper)** | Owner/editor check against `user_id = auth.uid()`; anon always false. Backs project RLS write policies. |
| 26 | `lykn_accept_project_invites()` | PUBLIC + anon, authenticated, service_role | **None — safe (auth.uid()-guarded)** | First statement: `IF auth.uid() IS NULL THEN RETURN 0` — hard no-op for anon. Only touches invite rows matching the caller's own verified email. Caller: web `src/lib/projectMembers.ts:166` post-sign-in (authenticated). |

## Summary

- **16 locked down** by 116: 4 full revokes (#1–4), 2 anon revokes keeping
  authenticated (#5, #6 — #6 added by this pass), 10 trigger/event-trigger
  PUBLIC-grant strips (#7–16).
- **10 left anon-executable, each with a concrete gate**: 3 token-gated
  chat-share functions (#17–19), 7 auth.uid()/membership-guarded functions
  (#20–26). Post-apply verification V4 in the migration asserts this exact
  10-function set and nothing else.
- **Residual risks accepted** (documented above): authenticated-role 1-bit
  probe on #6; dormant-but-token-gated share RPCs #17–19 pending a product
  decision on the chat-share feature.

*Prepared 2026-07-16 against live prod, read-only. Migration 116 is
prepare-only and had NOT been applied as of this record.*
