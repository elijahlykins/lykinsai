# Production hardening report

Started from `refactor/final-architecture-integration` at `c854b14`.
Work branch: `fix/production-hardening`.
Architecture stayed frozen.
No subsystem was redesigned.

## Baseline

| Item | Value |
| --- | --- |
| Integration HEAD | `c854b14` refactor(electron): simplify host and overlay structure |
| Hardening HEAD | `2cf32d2` plus this report |
| `test:architecture` | green before and after |
| Headed Electron | NOT TESTED (no display in this environment) |
| `typecheck` | baseline-failing (~755 existing TS errors; none introduced by these fixes) |
| `lint` | 0 errors, 12 existing warnings |
| `build` | green |

## Coverage

| Area | Automated | Headed / manual | Status |
| --- | --- | --- | --- |
| 1 Chat | `test:chat`, stop/send race source lock | NOT TESTED | Automated green. Live thread-switch / attachments not headed. |
| 2 Tool disclosure | `test:architecture` first-party + voice | NOT TESTED | PASSED characterization. |
| 3 Memory | `test:memory` | NOT TESTED | PASSED. User Facts copy removed. |
| 4 Vault | `test:vault` | NOT TESTED | Automated green. Ghost preview / stale selection remain. |
| 5 Bots | `test:agent`, BotExecutor fallback tests | NOT TESTED | Approval/handoff fallback fixed. Relay race remains. |
| 6 Browser | batch abort + existing browser-agent tests | NOT TESTED | Stop between batch steps fixed. `loc=` stale click remains. |
| 7 Local | process-group abort test | NOT TESTED | Cancel kills the zsh group. `runOsa` still has no signal. |
| 8 Remote | existing remote tests | NOT TESTED | Substring host match and SSH config rewrite remain. |
| 9 GitHub | `mcp-tools/githubTools.test.mjs` | NOT TESTED | No live merge. Cancel/signal still missing on writes. |
| 10 MCP | `test:mcp` | NOT TESTED | HTTP gates, approval tokens, Chat send pause, SSRF trust, redaction fixed. |
| 11 Routines | scheduler persist-before-fire | NOT TESTED | Sync persist fixed. Notify-only / overflow / double-notify remain. |
| 12 Teach | password name lock | NOT TESTED | Secret-as-name fixed. Click-Send approval inference remains. |
| 13 Voice | disclosure + replace-not-merge | NOT TESTED | Tool pileup fixed. Duplicate persist remains. |
| 14 Overlay / Glass | host-binding regressions | NOT TESTED | Missing constants restored. No headed overlay pass. |
| 15 Startup / shutdown | source/host bindings | NOT TESTED | No cold-start / sleep-wake headed pass. |
| 16 Calendar | load-in now reads `lykn_events` | NOT TESTED | Greeting source fixed. Live Google/Apple sync not headed. |
| 17 Security | MCP tokens, classifier, redact, SSRF | NOT TESTED | P0 HTTP/approval/SSRF fixed. Remaining items listed below. |
| 18 Isolation | existing memory/MCP user_id tests | NOT TESTED | No new cross-user store hole found besides OAuth phishing. |
| 19 Performance | qualitative only | NOT TESTED | No pathological new cost found. |
| 20 UI polish | none | NOT TESTED | No headed visual pass. |

## Bugs found and fixed

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

## Remaining known issues

### P0

None left that we reproduced and left unfixed.

OAuth provider phishing (Victim completes Attacker's authorization URL) is social engineering on a public callback.
It is not a LYKN userId mixup.
Do not require a LYKN session on the provider callback without a headed Electron OAuth proof.

### P1

- Remote target resolution uses first substring match (`resolveRemoteTargetFromAsk`).
- `loc=` clicks are not generation-scoped after navigation.
- Bot/Routine HTTP allowlist can still be influenced by request `connectionIds` / missing association (fail-open).
- Authenticated HTTP caller can still send `association.routineId` + `standing_authorization`.
- Approval tokens are process-local; multi-instance API would break resume.
- Voice can persist two assistant replies for one turn.
- `/app` resume can navigate away from an in-flight first send.
- Teach `click` on Send/Pay does not set `approvalRequired`.
- Notify-only monitor triggers take the active-run slot.
- 21st monitor is dropped while UI still says watching.
- SSH trust keyscans DNS host; OpenSSH may honor `~/.ssh/config` rewrite.
- GitHub mutation helpers do not take `AbortSignal`.
- Web/search page text is still injected as system, not wrapped untrusted.
- Failed stdio MCP connect can leave a child process.

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
- `typecheck` baseline debt (~755 errors).
- Lint: 12 unused-directive warnings.

## Architecture status

`npm run test:architecture` is green.
No new major structural debt.
No architecture redesign.
TaskRuntime remains terminal Task authority.
New code is a small approval-token helper next to MCP execution, not a new runtime.

## Runtime behavior differences

Only intentional bug fixes:

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

## Git

| Commit | Why |
| --- | --- |
| `28fda10` | Restore Electron host bindings dropped in the overlay split |
| `ed4c6b8` | MCP approval tokens and HTTP/Chat gates |
| `6c8d9ea` | Cancel leftovers, approval status, routine persist |
| `2cf32d2` | Teach secrets, Voice pileup, chat race, calendar source |

Final branch: `fix/production-hardening`
Final HEAD: see `git rev-parse HEAD` after this report lands.
Working tree: clean except this report until committed.

## Tests (final automated counts)

| Suite | Result |
| --- | --- |
| `test:architecture` | pass (5 architecture + 35 disclosure) |
| `test:electron` | pass (22) |
| `test:server` | pass |
| `test:security` | pass |
| `test:memory` | pass |
| `test:tools` | pass |
| `test:vault` | pass |
| `test:rag` | pass |
| `test:chat` | pass |
| `test:mcp` | pass (92) |
| `test:teach` | pass |
| `test:drag` | pass |
| `test:agent` | pass (976 across the two agent invocations) |
| Combined core blocks above | 642 pass / 0 fail |
| `build` | pass |
| `lint` | 0 errors |
| `typecheck` | baseline-failing (~755) |

Do not start another refactor phase.
