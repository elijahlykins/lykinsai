# Legacy Memory System Audit — Phase 1 of the Memory Architecture Replacement

Status: historical pre-demolition audit.
Do not use the classifications below as current runtime documentation.
Phase 3 outcomes are documented in `docs/memory-architecture.md`.

Audited at current HEAD (Aug 2026), before building `server/memory/`.
Scope: the Synthesis / User Model / Beliefs / Concepts / Neurons stack that the new Markdown memory core will replace.

## Capability matrix

| Capability | Classification | Notes |
|---|---|---|
| USER FACTS (`lykn_user_model_facts`, `userModelLearning.js`) | REPLACE | The live chat personalization today; becomes `profile.md` / `preferences.md` content, migrated with `source_type: 'migration'`. |
| IDENTITY (`fetchUserIdentitySection`, `lykn_chat_projects` names) | REPLACE | Becomes the L0 block from `profile.md` summary. |
| PREFERENCES (facts tagged preference, `lykn_user_preferences` AI-prefs subset) | REPLACE | Becomes `preferences.md`. The non-memory prefs on `lykn_user_preferences` (night shift, digests) are KEEP. |
| BELIEFS (`lykn_beliefs`, `beliefSystem.js`) | DELETE LATER | Already retired from the chat hot path (`skipBeliefs = true`); migration 122 already moved active beliefs → confirmed facts. Voice grounding and UI still read them (bridge until Phase 2). |
| RULES (`lykn_rules`, `lykn_result_attributions`) | DELETE LATER | Only consumed via the belief section (skipped in chat) and the Belief Window UI. |
| PROJECT CONTEXT (`fetchProjectSection`, `lykn_projects`, `lykn_project_state`) | KEEP + REPLACE (split) | Projects as a product feature are KEEP; the memory-shaped "what I'm working on" narrative becomes `projects/<slug>.md`. |
| SYNTHESIS PROFILE (`lykn_user_synthesis_profile` narrative/themes) | REPLACE | The `[WHO_I_AM]` formatter is already dead code; only Discover still reads themes (bridge). |
| CONCEPTS (`lykn_concepts`, `concept_*` joins, `conceptEmbedding.js`) | DELETE LATER | Feeds the Synthesis graph UI only; nightly + incremental clustering cost with no chat consumer. |
| NEURONS (`lykn_project_neurons`) | UNKNOWN | Doubles as project membership (product feature) and graph substrate (legacy). Phase 2 must decide the split before deletion. |
| RETRIEVAL (`lykn_synthesis_chunks`, `fetchSynthesisRetrievalSection`) | KEEP (not memory) | Chat limb permanently skipped, but the chunk store still powers vault semantic search, voice `search_vault`, MCP search, and the Electron local mirror. It is document retrieval, not user memory — out of scope for replacement. |
| RELATED CONTEXT (`buildRelatedNeighborhoodSection`) | DELETE LATER | Permanently skipped in chat (`skipRelated = true`); no other consumer of the prompt block. |
| NIGHT JOBS (`runSynthesis` 03:00, `runConcepts` 03:30 Render crons) | DELETE LATER | Exactly the nightly global re-synthesis the new architecture forbids. `runVaultReconciler` (04:00) and `runNightBrief` (04:30) are KEEP — upload hygiene and morning briefs, not memory. |
| BACKGROUND ENRICHMENT (profile LLM throttle, incremental concepts after learning) | DELETE LATER | Replaced by event/threshold per-document compaction in `memoryMaintenance.js`. |
| CHAT PROMPT INJECTION (`fetchUserModelSection` / `fetchUserIdentitySection` + skipped limbs) | REPLACE | The seam (below). |
| VOICE CONTEXT (`buildRealtimeSynthesisGrounding`, `gatherVoiceBriefingData`, voice tools `get_beliefs`/`get_facts`) | TEMPORARY BRIDGE | Still reads beliefs + project + facts; rewire to `resolveMemoryContext` in Phase 2. |
| DISCOVER (`/api/discover/feed`, `/api/discover/ingest` reading profile themes) | TEMPORARY BRIDGE | Only remaining narrative-profile consumer; needs a themes source (registry summaries) before profile deletion. No frontend consumer exists in `src/`. |
| UI (SynthesisLayer graph, Belief Window, NeuronPanel, load-in briefing, FactConfirmChip) | DELETE LATER / REPLACE | Graph + belief UI dies in Phase 3; a simple Memory UI (view/edit documents) replaces it in Phase 2. `categoryExplainers.ts` already labels Core Beliefs "legacy". |
| MCP / voice tool surface (~20 synthesis tools in `mcp-tools/`) | TEMPORARY BRIDGE | Replaced by the five memory tools; keep until agent surfaces are rewired. |
| DATABASE TABLES (below) | DELETE LATER | None touched in Phase 1. |

## Producers and consumers

Major producers:
`userModelLearning.js` (fact extraction passes, chat propose/confirm), `runUserProfileLlmAndUpsert` + intake (narrative profile), `jobs/synthesisJob.js` (nightly belief proposals via UMAP/DBSCAN + Claude), `jobs/conceptsJob.js` (nightly + incremental concept clustering), `replaceSynthesisChunks`/`embedAndStoreChunks` (chunk embeddings from vault/chat/connectors), belief/rule ratify-retire routes, MCP write tools (`proposeFact`, `recordRuleApplication`, project neuron CRUD).

Major consumers:
chat enrichment (`fetchUserModelSection`, `fetchUserIdentitySection`, opt-in `fetchProjectSection`), voice grounding + briefing + tools, load-in greeting (`src/lib/synthesis/loadInUpdates.ts` → `/api/v1/synthesis/activity` + concept/belief RPCs), Discover feed/ingest (profile themes), SynthesisLayer graph UI + panels, Model Builder neuron picker, Electron overlay (night briefs, deep links, local chunk mirror).

DB tables:
`ai_conversation_memory` (022), `lykn_synthesis_chunks` + `lykn_user_synthesis_profile` (023/024), `lykn_user_model_facts` + `lykn_user_model_revisions` (039), `lykn_beliefs` + `lykn_rules` + `lykn_result_attributions` (043/046/049), `lykn_synthesis_runs` (047), `lykn_load_in_user_sections` (054), `lykn_concepts` + `concept_notes/facts/beliefs/chats` (056/057), `lykn_project_neurons` (063), plus RPCs (`match_lykn_synthesis_chunks[_for_user]`, `concepts_*`, `get_belief_provenance`).

Jobs (Render cron, `render.yaml`):
`runSynthesis.js` 03:00 (beliefs), `runConcepts.js` 03:30 (concepts), `runVaultReconciler.js` 04:00 (keep), `runNightBrief.js` 04:30 (keep).

Chat injection, Voice, Discover, UI: see matrix rows above.

Caches (in-process, 90s-class):
`userModelSectionCache`, `userIdentitySectionCache`, `beliefSectionCache`, `projectSectionCache`, `_embedQueryCache` (15 min), profile-LLM throttle maps, `incrementalConceptsLastRunAt`.

Feature flags / env:
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BACKFILL_SECRET`, `DISCOVER_INGEST_SECRET`, `RAG_CONTEXTUAL_RETRIEVAL`, `RAG_PARENT_WINDOW`, `RAG_QUERY_EXPANSION`, `VOICE_BRIEFING_*`, `NIGHT_SHIFT_MODEL`, `VAULT_RECONCILER_DELETE_ENABLED`.
The chat skips (synthesis/beliefs/related) are hardcoded, not flags.

## The Chat memory seam (verified at HEAD)

Both chat cores run an enrichment `Promise.all` before building the prompt:

- `POST /api/ai/invoke` — registered at `server.js:11076`; enrichment `Promise.all` at `server.js:11865`, user-facts fetch at `server.js:11902`.
- `POST /api/ai/stream` — registered at `server.js:12892`; enrichment `Promise.all` at `server.js:14391` (user facts run inside it, with a warm-cache fallback for fast-lean turns at `server.js:14430`).

Verified limb status at HEAD:

| Limb | invoke | stream | Status |
|---|---|---|---|
| `fetchSynthesisRetrievalSection` | `skipSynthesis = true` (11807) | `streamSkipSynthesis = true` | permanently skipped |
| `fetchBeliefSection` | `skipBeliefs = true` (11809) | `streamSkipBeliefs = true` | permanently skipped |
| `buildRelatedNeighborhoodSection` | `skipRelated = true` (11813) | `streamSkipRelated = true` | permanently skipped |
| `fetchUserIdentitySection` | chat intents | chat intents | ACTIVE |
| `fetchUserModelSection` | chat intents (11902) | in Promise.all (14421) | ACTIVE — primary personalization |
| `fetchProjectSection` | opt-in (scoped/bound/asked) | opt-in | ACTIVE, conditional |

Phase 2 replaces the memory-shaped limbs (`fetchUserModelSection`, `fetchUserIdentitySection`, and the three dead limbs' plumbing) with one call to `resolveMemoryContext(store, userId, { selectPaths, knownVersions })` from `server/memory/memoryResolver.js`, keeping web search / scraping / YouTube / project limbs unchanged.
Nothing was switched in Phase 1.

## Likely Phase 3 deletion candidates (audit-based, NOT deleted)

- `jobs/synthesisJob.js`, `jobs/runSynthesis.js`, `jobs/conceptsJob.js`, `jobs/runConcepts.js` and their Render cron entries.
- `beliefSystem.js`, the beliefs/rules/applied route band in `server.js` (~8479-9010), `lykn_beliefs`, `lykn_rules`, `lykn_result_attributions`.
- `conceptEmbedding.js`, concepts routes in `connections.routes.js`, `lykn_concepts` + `concept_*` tables.
- `lykn_user_synthesis_profile` narrative path (`runUserProfileLlmAndUpsert`, intake synthesis) once Discover has a new themes source.
- `userModelLearning.js` + `factEmbedding.js` + `lykn_user_model_facts`/`_revisions` after facts are migrated into memory documents.
- `fetchUserModelSection` / `fetchBeliefSection` / `fetchSynthesisRetrievalSection` / `buildRelatedNeighborhoodSection` and their caches.
- SynthesisLayer page + `src/components/synthesis/` panels + load-in belief/concept lanes + `src/lib/synthesis/{beliefsClient,fetchSynthesisNeuronsForPicker,profileRefresh,intakeApi}`.
- The ~20 synthesis MCP/voice tools in `mcp-tools/`.

Explicit non-candidates: `lykn_synthesis_chunks` + vault retrieval (document search, not memory), `runVaultReconciler`, `runNightBrief`, projects as a product feature, `ai_conversation_memory` (conversation continuity).
