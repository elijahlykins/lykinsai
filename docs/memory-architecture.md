# Memory Architecture — Database-Backed Markdown Memory Core

Status: Phase 2 complete (Chat cutover). Production personal memory for Chat is Markdown Memory.
Code: `server/memory/`.
Schema: `supabase-migrations/124_lykn_memory_documents.sql`.
Tests: `tests/memory/` (`npm run test:memory`).
Phase 3 demolition of Synthesis is still deferred.

## Core philosophy

Skills tell the AI HOW to work.
Memory tells the AI WHAT it knows about this user.

Memory is a small set of Markdown documents the AI and the user address by logical path: `profile.md`, `preferences.md`, `goals.md`, `decisions.md`, `relationships.md`, `projects/<slug>.md`, `topics/<slug>.md`.
These are not filesystem files — they are database rows surfaced as Markdown.
This replaces the Synthesis / User Model / Beliefs stack, which had grown complex, token-heavy, and dependent on nightly background processing.

## Storage

Two tables, additive only (migration 124):

- `lykn_memory_documents` — current state, one row per `(user_id, path)`.
  Columns: `id, user_id, path, name, description, type, markdown, summary, status, version, created_at, updated_at, archived_at`.
  `path` is unique per user, `status` is `active|archived`, `version` is the optimistic-concurrency stamp, and `markdown` is hard-capped at the DB layer (32,768 chars) below which the service enforces a smaller budget (24,000).
- `lykn_memory_document_versions` — one immutable full snapshot per meaningful write.
  Columns: `id, memory_document_id, user_id, version, markdown, change_type, source_type, meta, created_at`.
  Snapshots, not deltas: documents are small, so full copies are cheap and trivially auditable.
  This gives rollback, auditability, debugging, and provenance.

Both tables have per-user RLS (`auth.uid()` policies).
Version rows have no update/delete policies — history is immutable from clients.
Because the production server uses the service-role client (which bypasses RLS), `memoryStore.js` also filters every query by `user_id`; the service layer is the working ownership gate and RLS is defense in depth.

The registry is derived from active documents (`SELECT path, name, description, type, summary, updated_at ... WHERE status = 'active'`).
There is deliberately no hand-maintained index file that could drift from the database.

## Module map

```
server/memory/
  memoryConfig.js       tunable budgets, size caps, token estimator
  memoryPaths.js        logical path validation (built-ins + projects/topics slugs)
  memoryPolicy.js       write-policy trust matrix + provenance source types
  memoryMarkdown.js     section parsing, patch ops, deterministic summaries
  memoryStore.js        the only DB-facing module (Supabase impl of the store contract)
  memoryRegistry.js     L1: compact active-memory metadata + prompt formatting
  memoryReader.js       L2: read one document with ownership/status/token limits
  memoryWriter.js       create / patch / forget pipeline (policy → CAS → history)
  memoryResolver.js     the future Chat seam: L0+L1+L2 in one call, thread cache
  memoryMaintenance.js  event/threshold compaction, one document at a time
  memoryTools.js        the five controlled tool operations + tool definitions
  index.js              single import point for Phase 2
```

## Hybrid retrieval

- L0 — tiny automatic context.
  Summaries of `profile` and `preferences` documents only, budgeted at `MEMORY_L0_TOKEN_BUDGET` (300 tokens).
  Never whole documents.
- L1 — registry.
  Path, type, description, summary per active memory, budgeted at `MEMORY_REGISTRY_TOKEN_BUDGET` (700 tokens).
  Over budget it drops summaries first, then the stalest entries.
- L2 — full Markdown.
  Only for explicitly selected paths, capped at `MEMORY_MAX_SELECTED_DOCUMENTS` (3) and `MEMORY_DEEP_READ_TOKEN_BUDGET` (3,000 tokens) per turn.
  The per-turn default is zero deep reads.

Thread-level caching: callers pass `knownVersions` (path → version already injected into the conversation).
Unchanged documents come back as `{ unchanged: true }` with no body, so repeated turns never re-fetch or re-inject identical memory.
All budgets live in `memoryConfig.js` and are one-line tunable.

## Tool surface

`memory_list`, `memory_read`, `memory_patch`, `memory_create`, `memory_forget` — implemented in `memoryTools.js`, with declarative tool definitions for the Phase 2 chat wiring.
The model never touches the database or a filesystem; every call is scoped to the authenticated user and passes path validation and write policy.

`memory_patch` is the preferred write: the model proposes one small operation, the server applies it.
The patch contract is five operations: `append_section`, `update_section`, `replace_text`, `remove_text`, `remove_section`.
`find`-based operations must match exactly once — zero or ambiguous matches fail, so a patch can never land somewhere unintended.
Contradictions are handled by supersession: `replace_text` swaps the outdated statement instead of appending a conflicting one forever.

Every successful mutation: policy check → load → optimistic version check → apply → size/structure validation → compare-and-swap persist → full-snapshot version row.
A stale writer gets `version_conflict` instead of silently overwriting.

`memory_create` allows only built-in paths and `projects/<slug>.md` / `topics/<slug>.md`, and requires meaningful content (≥ 20 chars).
`memory_forget` supports removing one fact (patch), archiving (default deletion), and hard delete — which requires `sourceType: 'explicit_user'` plus `confirmHardDelete: true` and erases the document with its history.

## Write policy

| Source | Verdict |
|---|---|
| `explicit_user` ("remember…", "I prefer…", "we decided…") | write allowed |
| `user_confirmed` (inference the user confirmed) | write allowed |
| `system_event` (LYKN verified a state change) | `project`/`topic`/`decisions` documents only; cannot archive or delete |
| `inferred` (model pattern-noticing) | denied with `deferred: true` — surface for confirmation instead |
| `migration` (Phase 2 legacy import) | write allowed, server-initiated only |
| anything else (webpage, email, file, connector, search result) | denied — `external_content_forbidden` |

The external-content denial is a security invariant, not a tuning knob: external content may inform a task but can never silently become durable user memory (memory poisoning).
Provenance (`source_type` + small `meta`) is stored in version history, never in the visible Markdown.

## Security

- Ownership: every store query filters by `user_id`; RLS mirrors it for user-token clients; tests prove user B cannot read/write/archive/hard-delete user A memory.
- Path validation: single validator (`memoryPaths.js`) rejects traversal, absolute paths, dot segments, foreign separators, control characters, non-ASCII, unknown namespaces, and oversized paths; a DB `CHECK` regex backstops it.
- Memory poisoning: closed provenance list; unknown source types are treated as external and denied before any store access.
- Concurrency: compare-and-swap on `version` plus optional caller `expectedVersion`; two stale writers cannot silently overwrite each other.
- Limits: document body, summary, name, description, provenance meta, and read output are all capped; oversized writes fail closed.
- Logging/instrumentation reports sizes and counts only, never memory contents (`measureMemoryFootprint`).

## Maintenance

No nightly global pass — that is the failure mode of the old system.
Maintenance is event/threshold driven and per-document: `memoryNeedsCompaction` flags a document at 16,000 chars or ≥ 20% duplicate content lines, and `compactMemoryDocument` compacts that one document (deterministic dedupe; an optional async compactor hook exists for future LLM compaction with isolated cost).
Summaries are deterministic (first content line + section map), recomputed on every write for free — no LLM in the write path.

## Migration plan

- Phase 1: core built and tested beside Synthesis. Production Chat unchanged.
- Phase 2 (this): Chat `/api/ai/invoke` and `/api/ai/stream` resolve personal memory through `resolveChatMemoryTurn` → `resolveMemoryContext`.
  Trustworthy legacy facts (`stated` / `confirmed` / `corrected`) plus display name migrate idempotently with `source_type: 'migration'`.
  The five memory tools are on the Chat whitelist.
  A narrow dual-write bridge copies trusted `/api/learned` + confirm + `lykn_proposeFact` writes into Markdown.
  Voice gets L0 memory in grounding and can dispatch the memory tools; beliefs/facts voice tools remain as a temporary bridge.
  Discover still reads synthesis profile themes (no frontend consumer) — Phase 3 deletion candidate.
  Nightly `runSynthesis` / `runConcepts` are still scheduled; they no longer feed Chat. Recommend disable in Phase 3.
- Phase 3 (deferred): demolish the legacy Synthesis/User-Model/Beliefs/Concepts stack — routes, jobs, tables, caches, UI, leftover tools, and this dual-write bridge.

## Future

Phase 3 removes the leftover Synthesis producers/consumers listed in `docs/memory-legacy-audit.md`.
A user-visible Memory surface (view/edit/delete Profile, Preferences, Goals, Decisions, Projects) is still deferred — backend correctness was the Phase 2 priority.
