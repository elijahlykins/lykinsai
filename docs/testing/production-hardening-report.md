# Production hardening report

Started from `refactor/final-architecture-integration` at `c854b14`.
Work branch: `fix/production-hardening`.
P0 pass landed at `d4f5b12`.
This document now includes the P1 remediation pass after that HEAD.
Architecture stayed frozen.
No subsystem was redesigned.

## Baseline

| Item | Value |
| --- | --- |
| Integration HEAD | `c854b14` refactor(electron): simplify host and overlay structure |
| P0 hardening HEAD | `d4f5b12` docs(testing): record the production hardening pass |
| P1 remediation | this pass; Final HEAD is the last commit on this branch |
| `test:architecture` | green before and after |
| Headed Electron | NOT TESTED (no display in this environment) |
| `typecheck` | baseline-failing (~757 existing TS errors; was ~755; none introduced by these fixes) |
| `lint` | 0 errors, 12 existing warnings |
| `build` | green |

## Coverage

| Area | Automated | Headed / manual | Status |
| --- | --- | --- | --- |
| 1 Chat | `test:chat`, resume ownership, stop/send race | NOT TESTED | `/app` first-send resume steal FIXED. Live thread-switch / attachments not headed. |
| 2 Tool disclosure | `test:architecture` first-party + voice | NOT TESTED | PASSED characterization. |
| 3 Memory | `test:memory` | NOT TESTED | PASSED. User Facts copy removed. |
| 4 Vault | `test:vault` | NOT TESTED | Automated green. Ghost preview / stale selection remain P2. |
| 5 Bots | `test:agent`, BotExecutor + TaskCompiler allowlist | NOT TESTED | Approval/handoff fallback fixed. Request cannot expand Bot/Routine allowlists. |
| 6 Browser | batch abort + generation-scoped `loc=` | NOT TESTED | Stop between batch steps fixed. Stale `loc=` after navigate FIXED. |
| 7 Local | process-group abort test | NOT TESTED | Cancel kills the zsh group. `runOsa` still has no signal (P2). |
| 8 Remote | exact target + SSH `-F /dev/null` | NOT TESTED | Substring host match FIXED. `~/.ssh/config` is not rewritten. Non-config targets ignore user HostName rewrite. |
| 9 GitHub | `mcp-tools/githubTools.test.mjs` | NOT TESTED | No live merge. Write helpers now take `AbortSignal`. |
| 10 MCP | `test:mcp` | NOT TESTED | HTTP standing auth denied. stdio failed-connect child cleaned up. Approval tokens stay memory-only with prune/cap/task bind. |
| 11 Routines | notify-only + monitor capacity | NOT TESTED | Sync persist fixed. Notify-only no longer starts a Task. 21st monitor returns `monitor_capacity_reached`. Double-notify toast remains P2. |
| 12 Teach | password name lock + Send click approval | NOT TESTED | Secret-as-name fixed. Click-on-Send compiles `approvalRequired`. |
| 13 Voice | disclosure + replace-not-merge + persist claim | NOT TESTED | Tool pileup fixed. Duplicate persist FIXED. |
| 14 Overlay / Glass | host-binding regressions | NOT TESTED | Missing constants restored. No headed overlay pass. |
| 15 Startup / shutdown | source/host bindings | NOT TESTED | No cold-start / sleep-wake headed pass. |
| 16 Calendar | load-in now reads `lykn_events` | NOT TESTED | Greeting source fixed. Live Google/Apple sync not headed. |
| 17 Security | MCP tokens, classifier, redact, SSRF, allowlist, web observation | NOT TESTED | Prior P0s remain closed. Remaining P1s in this pass are dispositioned below. |
| 18 Isolation | existing memory/MCP user_id tests | NOT TESTED | No new cross-user store hole found besides OAuth phishing. |
| 19 Performance | qualitative only | NOT TESTED | No pathological new cost found. |
| 20 UI polish | none | NOT TESTED | No headed visual pass. |

## P1 remediation matrix

Every leftover P1 from `d4f5b12` is dispositioned.
There is no vague unresolved P1.

| Issue | Reproduced? | Root cause | Fix | Regression test | Status |
| --- | --- | --- | --- | --- | --- |
| Remote substring host match | Yes | `resolveRemoteTargetFromAsk` used `q.includes(name)` and took the first hit | Exact id, then exact name, then whole-token match; ambiguous returns `{ reason: "ambiguous" }` | `electron/remote/remoteTarget.test.cjs` | FIXED |
| Browser `loc=` not generation-scoped | Yes | Issued refs were bare `loc=css:…`; navigate + same CSS still resolved | Issued locs are `loc=g{generation}:{locator}`; prior generation is `stale_reference` | `electron/browser-agent/refs.test.cjs` | FIXED |
| Forged Bot allowlist / `routineId` standing auth | Yes | Request `connectionIds` could expand the compiled allowlist; HTTP accepted client `standing_authorization` / `botConnectionIds`; missing association fail-opened | Compiler intersects trusted ∩ requested; HTTP never grants standing auth; associated Task with no allowlist is `[]` | `electron/task-runtime/mcpExecutor.test.cjs`, `tests/mcp/oauthTrust.test.mjs` | FIXED |
| In-memory MCP approval tokens | Yes (lifecycle). Multi-instance resume loss not reproduced on desktop. | Tokens were memory-only, unbound to `taskId`, and not capped | Keep memory-only. Bind `taskId`. Prune used/expired. Cap 200. Cross-task replay denied. Do not persist secrets. | `tests/mcp/oauthTrust.test.mjs` | FIXED (lifecycle). Multi-instance API token loss: DEFERRED WITH EVIDENCE |
| Voice duplicate persist | Yes | `response.audio_transcript.done` and `response.output_audio_transcript.done` both persisted | `claimVoiceReplyPersist` claims one durable write per `responseId` | `src/lib/lyknChat/voiceReplyPersist.test.ts` | FIXED |
| `/app` resume steals first send | Yes | Resume replace ran while a send was in flight or the provisional snapshot already had user messages | `shouldReplaceProvisionalChat` refuses replace when sending, loading, or the snapshot already has user messages | `src/lib/lyknChat/resumeOwnership.test.ts` | FIXED |
| Teach click-on-Send does not infer `approvalRequired` | Yes | Click compiler stored the verb only; Send/Submit/Pay were not consequential | `consequentialClick` sets `approvalRequired`; WorkflowExecutor pauses before the adapter for those click-like steps | `tests/teach/compilerStore.test.cjs`, `tests/teach/executor.test.cjs` | FIXED |
| Notify-only Routine appears as running | Yes | Filesystem/process `normalizeTrigger` dropped `notifyOnly`, so `onTrigger` called `startOccurrence` | Preserve `notifyOnly`. Notify + record a completed run. Do not start a Task. Projection `running` only with an active Task. | `electron/bot-routines/routineRuntime.test.cjs` | FIXED |
| 21st monitor silently dropped | Yes | `MAX_MONITORS` (20) overflow returned success-shaped watching | `syncRoutine` returns `{ ok: false, error: "monitor_capacity_reached", max }`; overflow state is `capacity_reached`; re-sync after a free slot starts it | `electron/bot-routines/monitors.test.cjs` | FIXED |
| SSH config rewrite | `~/.ssh/config` mutation: no. User-config HostName rewrite: yes. | LYKN never wrote `~/.ssh/config`. It only writes LYKN known_hosts. Non-`sshConfigHost` targets still honored user `HostName` aliases. | Non-config targets use `-F /dev/null` and explicit `HostName=`. `sshConfigHost` still honors user config by design. | `electron/remote/sshTransport.test.cjs` | NOT REPRODUCIBLE as `~/.ssh/config` rewrite. HostName rewrite: FIXED |
| GitHub writes ignore cancellation | Yes | `githubRequest` / `runGithubTool` did not take `signal`; abort after fetch could still `finish()` as success | Accept/propagate `AbortSignal`. Abort before or after fetch cannot become success. | `mcp-tools/githubTools.test.mjs` | FIXED |
| Web scrape content in the system prompt | Yes | Scraped/search/YouTube text was appended to the privileged `prompt` | `formatUntrustedWebObservation` + attach to the user/observation half only. Neutralize instruction-shaped text. | `server/ai/webEnrichment.test.mjs` | FIXED |
| stdio MCP child leak on failed connect | Yes | Failed initialize/identity mismatch closed the session but left the spawned child | `localProcesses.stop(row.id)` on connect failure and identity mismatch | `tests/mcp/localStdio.test.mjs` | FIXED |

## Bugs found and fixed

Prior P0/P1/P2 fixes from the first pass remain in the table below.
P1 remediation rows are appended.

| Severity | Bug | Owner | Fix | Test |
| --- | --- | --- | --- | --- |
| P1 | Desktop auth / overlay / live watch / screen monitor / extension install referenced bindings dropped in the Electron split | `electron/auth/desktopAuth.cjs`, overlay hosts, `extensionInstall.cjs` | Restore constants, requires, and `appDir` | `tests/electron/hostBindingRegressions.test.cjs` (`28fda10`) |
| P0 | `POST /api/mcp/connections/:id/tools/call` ran raw `callTool` when `task` was omitted | `server/routes/mcp.routes.js` | Always `executeMcpTool` | `tests/mcp/oauthTrust.test.mjs` (`ed4c6b8`) |
| P0 | Client `task.approval.state = "approved"` was treated as live approval | `lib/mcp/executeMcpTool.js` | Server-minted one-time token | oauthTrust + parityProof (`ed4c6b8`) |
| P1 | Chat stamped `standing_authorization` on send | `lib/mcp/chatTurn.js` | `preserve_executor_security_gates` + bound `connectionIds` | oauthTrust chat handler test |
| P1 | Client `trustLevel: local_trusted` allowed server-side loopback HTTP | `server/routes/mcp.routes.js` | Ignore `LOCAL_TRUSTED` on non-stdio connects | url policy + route change |
| P1 | `purge_records` / unlabeled generic tools classified as READ | `lib/mcp/toolClassifier.js` | Destructive aliases + unknown default write | oauthTrust classifier test |
| P1 | MCP results forwarded `access_token` to the model | `lib/mcp/trust.js` | `redactDeep` inside `wrapUntrustedObservation` | oauthTrust observation test |
| P1 | Local cancel killed zsh but not grandchildren | `electron/localSystem.cjs` | Detached process group + `kill(-pid)` | `electron/localSystem.test.cjs` (`6c8d9ea`) |
| P1 | Browser batch kept acting after Stop | `electron/browser-agent/index.cjs` | Abort check between steps | `batching.test.cjs` |
| P1 | Bot fallback completed `[[ask]]` and collapsed approval | `electron/task-runtime/executors/botExecutor.cjs` | Same status mapping as harness path | `botExecutor.test.cjs` |
| P2 | Routine `lastFiredOccurrence` was async, so a crash could double-fire | `electron/bot-routines/routineStore.cjs` | `persistNowSync()` in `setSchedulingState` | `scheduler.test.cjs` |
| P1 | Teach used `el.value` as target name (password leak) | `electron/teach/browserCapture.cjs` | Never use field value for name | `tests/teach/browserCapture.test.cjs` (`2cf32d2`) |
| P1 | Voice session accumulated tools across turns | `src/hooks/useRealtimeVoice.ts` | Replace the map each turn | `mcp-tools/voiceTools.test.mjs` |
| P2 | Stop then send clobbered the successor stream | `src/hooks/useChatEngine.ts` | `finally` no-ops if a newer abort owns the thread | memoryCutover source lock |
| P2 | Episodic prompt still said "User Facts" | `src/lib/conversationMemory.ts` | Markdown Memory copy | memoryCutover |
| P2 | Load-in calendar still queried vault `gcal_event` | `src/lib/synthesis/loadInUpdates.ts` | Read `lykn_events` | memoryCutover |
| P1 | Request `connectionIds` / forged `routineId` could broaden Bot/Routine authority | `electron/task-runtime/taskCompiler.cjs`, `lib/mcp/executeMcpTool.js`, `server/routes/mcp.routes.js` | Intersect trusted allowlists. HTTP never grants `standing_authorization`. Chat does not forward client `botConnectionIds`. | mcpExecutor + oauthTrust |
| P1 | Scraped page text was appended to the privileged system prompt | `server/ai/webEnrichment.js`, `server/ai/chatStream.routes.js` | Untrusted observation on the user half only | `server/ai/webEnrichment.test.mjs` |
| P1 | Remote `prod` selected `prod-backup` | `electron/remote/remoteTarget.cjs` | Exact / whole-token / ambiguous | `electron/remote/remoteTarget.test.cjs` |
| P1 | Stale `loc=` after navigate still clicked the new page | `electron/browser-agent/browser/controller.cjs`, `snapshot.cjs` | Generation-scoped refs | `electron/browser-agent/refs.test.cjs` |
| P1 | GitHub writes ignored Task cancellation | `mcp-tools/githubTools.js` | Propagate `signal`; late abort is not success | `mcp-tools/githubTools.test.mjs` |
| P1 | Failed stdio MCP connect left a child process | `lib/mcp/mcpConnectionManager.js` | `localProcesses.stop` on connect/identity failure | `tests/mcp/localStdio.test.mjs` |
| P1 | OpenSSH could honor `~/.ssh/config` HostName for non-config targets | `electron/remote/sshTransport.cjs` | `-F /dev/null` + explicit `HostName=` | `electron/remote/sshTransport.test.cjs` |
| P1 | Voice persisted two assistant messages for one `responseId` | `src/lib/lyknChat/voiceReplyPersist.ts` | Claim once per response id | `voiceReplyPersist.test.ts` |
| P1 | `/app` resume replaced an in-flight first send | `src/lib/lyknChat/resumeOwnership.ts`, `src/pages/LyknChat.tsx` | Skip replace while sending/loading or when the snapshot already has user messages | `resumeOwnership.test.ts` |
| P1 | Teach click on Send compiled without approval | `electron/teach/events.cjs`, `electron/teach/executor.cjs` | Consequential click + executor pause | teach compiler + executor tests |
| P1 | Notify-only trigger started a running Task | `electron/bot-routines/triggers.cjs`, `routineRuntime.cjs` | Keep `notifyOnly`; notify without `startOccurrence` | `routineRuntime.test.cjs` |
| P1 | 21st monitor disappeared while UI still said watching | `electron/bot-routines/monitors.cjs` | Structured `monitor_capacity_reached` | `monitors.test.cjs` |
| P1 | Approval tokens unbound to Task and uncapped | `lib/mcp/mcpApprovalTokens.js` | Bind `taskId`, prune, cap 200 | oauthTrust |

## Remaining known issues

### P0

None left that we reproduced and left unfixed.

OAuth provider phishing (Victim completes Attacker's authorization URL) is social engineering on a public callback.
It is not a LYKN userId mixup.
Do not require a LYKN session on the provider callback without a headed Electron OAuth proof.

### P1

None remaining from the leftover list at `d4f5b12`.

Approval-token multi-instance API resume (process A mints, process B consumes) is DEFERRED WITH EVIDENCE.
Desktop is a single Node process.
Persisting one-time approval secrets would widen the leak surface.
This is not a headed desktop P1.

### P2

- Duplicate routine approval notifications (host + outcome).
- Targeted browser fingerprint includes URL/title noise.
- Ephemeral `tabId` persisted as `tabIdHint`.
- `syncRoutine` can skip a due occurrence after sleep.
- Vault ghost preview / selection prune.
- `runOsa` has timeout but no abort signal.
- Cheap Reply path still ignores empty approval-shaped results unless status is set.

### P3

- Overlay/Glass headed polish not executed.
- `typecheck` baseline debt (~757 errors).
- Lint: 12 unused-directive warnings.

## Architecture status

`npm run test:architecture` is green.
No new major structural debt.
No architecture redesign.
TaskRuntime remains terminal Task authority.
Approval and capability authority remain server/runtime-owned.
External web content remains untrusted observation.
No new manager/runtime/service was introduced.
Helpers (`resumeOwnership`, `voiceReplyPersist`, `formatUntrustedWebObservation`, `resolveHttpMcpCallAuthority`) sit next to their existing owners.

## Runtime behavior differences

Only intentional bug fixes, including this P1 pass:

- MCP HTTP tools/call always goes through `executeMcpTool`.
- Consequential MCP now requires a server-minted token, not `approval.state`.
- Chat send/consequential MCP pauses for approval.
- Remote HTTP MCP cannot self-label `local_trusted`.
- Unknown/generic MCP tools are no longer silent READ.
- Local abort kills the process group.
- Browser batches stop after Stop.
- Bot fallback preserves approval and teammate handoff.
- Routine fire persists scheduling state synchronously.
- Teach does not store password field values as names.
- Voice tools replace per turn.
- Stop then send no longer clears the new stream.
- Load-in calendar uses `lykn_events`.
- Bot/Routine compiled `connectionIds` are trusted ∩ requested.
- HTTP MCP never grants `standing_authorization` from the client.
- Scraped web text is not appended to the privileged system prompt.
- Remote host selection is exact / whole-token / ambiguous, never substring.
- Browser `loc=` refs are generation-scoped.
- GitHub writes honor `AbortSignal`.
- Failed stdio MCP connect stops the child.
- Non-`sshConfigHost` SSH ignores user config HostName rewrite.
- Voice persists one durable assistant message per response id.
- `/app` resume does not replace an in-flight first send.
- Teach click on Send/Submit/Pay compiles `approvalRequired`.
- Notify-only Routine triggers do not start a Task.
- Monitor overflow returns `monitor_capacity_reached` instead of silent drop.
- Approval tokens are bound to `taskId` and capped in process memory.

## Git

| Commit | Why |
| --- | --- |
| `28fda10` | Restore Electron host bindings dropped in the overlay split |
| `ed4c6b8` | MCP approval tokens and HTTP/Chat gates |
| `6c8d9ea` | Cancel leftovers, approval status, routine persist |
| `2cf32d2` | Teach secrets, Voice pileup, chat race, calendar source |
| `d4f5b12` | Record the P0 hardening pass |
| `87d22f8` | Bot allowlists, HTTP standing auth, approval-token lifecycle |
| `413f90e` | Web observation stays off the system prompt |
| `d824f12` | Exact remote host match and SSH `-F /dev/null` |
| `92a6530` | Generation-scoped browser `loc=` |
| `4d38bba` | GitHub write cancellation |
| `09a6fe7` | stdio MCP failed-connect child cleanup |
| `c05d8bd` | Voice persist once; `/app` first-send resume ownership |
| `a93c00c` | Teach Send click approval |
| `405e7b1` | Notify-only watching and monitor capacity |

P1 remediation commits are listed above.
Final branch: `fix/production-hardening`.
Working tree should be clean after this report is committed.

## Tests (P1 remediation automated counts)

| Suite | Result |
| --- | --- |
| `test:architecture` | pass (5 architecture + 35 disclosure) |
| `test:electron` | pass (22) |
| `test:server` | pass (57, includes web enrichment) |
| `test:security` | pass (11) |
| `test:memory` | pass (86) |
| `test:tools` | pass (78) |
| `test:vault` | pass (79) |
| `test:rag` | pass (8) |
| `test:chat` | pass (96) |
| `test:mcp` | pass |
| `test:teach` | pass (47) |
| `test:drag` | pass (36) |
| `test:agent` | pass (957 + 29) |
| `build` | pass |
| `lint` | 0 errors, 12 existing warnings |
| `typecheck` | baseline-failing (~757) |
| Headed Electron | NOT TESTED |

Do not start a P2 cleanup or another refactor phase.
