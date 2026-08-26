# Vault.jsx — State & Responsibility Map

Batch 6 deliverable (read-only analysis; no source changes). Line numbers refer
to `src/pages/Vault.jsx` at commit `b26e793` (9,455 lines). They will drift as
batches land — treat groups and relationships as the durable content.

## Inventory

| Mechanism | Count |
|---|---|
| `useState` | 61 |
| `useRef` | 51 |
| `useEffect` / `useLayoutEffect` | 41 + 2 |
| `useMemo` | 27 |
| `useCallback` | ~102 |
| react-query | 1 `useInfiniteQuery` (notes), 1 `useQuery` (projects), 1 `useQueryClient` |
| external store hooks | `useVaultUploadStore` (zustand), `useUsageGate`, `useAuth` |
| module-level mutable | `sessionVaultReady` (L156), `sourceFolderCache` (L235) |

Total ≈ 290 stateful mechanisms in one component.

## Responsibility groups

Classification: COHESIVE / MIXED / HIGHLY COUPLED; ★ = potential hook candidate.

| # | Group | Class | Core members (lines) |
|---|---|---|---|
| 1 | Shell modes (embedded / studio / picker / mobile) | MIXED ★(flags only) | `isEmbeddedMode` 483, `isPickerMode` 487, `activePickTarget` 495, `embeddedSearch` 527, `sidebarOpen` 585, `isMobileChat` 779 |
| 2 | First-paint readiness | HIGHLY COUPLED | `sessionVaultReady` 156, `vaultReady` 532, `eagerResolveRunRef` 2574, `initialCardIdsRef` 2934, `isVaultFirstPaintRef` 2943; eager preload effect 2580 |
| 3 | Data loading & cards pipeline | COHESIVE ★ | `notesQuery` 981, `notes` memo 1008, `setNotes` 1023, `refreshNotes` 1038, `mergeUploadedNotes` 856, `ghostCards` 1256, `vaultCards` 1419 |
| 4 | Progressive reveal & pagination | MIXED ★(after #13) | `revealCount` 3210, `sentinelInView` 3211, `batchPreparing` 3212, `prepareNextBatch` 3251, effects 3280–3375, sentinel IO 1232 |
| 5 | Layout (view mode / collage order / columns) | COHESIVE ★ | `vaultView` 692, `orderByPage` 577, `collageColumns` 3411, `heightEstimateCacheRef` 3431, order persistence 3106–3134, buckets 3441 |
| 6 | Search (text + concept) | COHESIVE ★ | `vaultSearch` 687, `conceptResultIds` 712, `isConceptSearching` 755, abort/id refs 765/4576, `handleConceptSearch` 4578 |
| 7 | Tags (directory / filter / picker) | COHESIVE ★ | `allTagsRaw` 1896, `selectedFilterTags` 756, `tagPicker*` 761–763, `updateNoteTags` 1992, `toggleCardTag` 2008 |
| 8 | Folders & AI Drive | MIXED ★(listing half) | `openSourceFolder` 664, `openDriveFolder` 667, `driveMarkup` 626, `driveEntries` 6492, `moveCardToFolder` 6642, deep-link 6791 |
| 9 | Selection & picker protocol | MIXED ★(core) | `selectedCardIds` 607, picker refs 608–613, `postPickerSelection` 1674, SET_SELECTION listener 1744, prune/keys 6327/6343 |
| 10 | Drag & trash | HIGHLY COUPLED (partly vestigial) | `draggedCardId` 578, `vaultTrash*` 580–584, `handleCardDragStart` **no-op** 3825, trash hold 3773–3793 |
| 11 | Delete/undo & note mutations | MIXED ★(mutations API) | `pendingDeleteCardIds` 600, timers 601, `deleteSelectedCards` 6238, attachment/comment/why/project mutations 5726–6225 |
| 12 | Preview overlay (lightbox/share/comments/menus) | MIXED ★(shell, after #13) | `previewCard` 650, `preview*` 651–658, card menus 631–641, popover effects 1111–1220, Esc/lock 4414/4531 |
| 13 | Signed URLs & media resolution | COHESIVE ★ **(largest safe extract)** | `resolvedAttachmentUrls` 615, `signedUrlCacheRef` 772, queue/observer 2036–2459, dims 2473–2553, `registerCardRef` 2387, tab recovery 2716 |
| 14 | Quick notes | COHESIVE ★ | `showQuickNote` 566, `quickNoteContent` 643, save 4718–4813 |
| 15 | Save-link dialog | COHESIVE ★ | `showSaveLink` 647, `handleSaveLink` 4815 |
| 16 | Wake preview (demo) | COHESIVE ★ | `wakePreview*` 568–574, `walkthroughGateOpen` 649, demo cards 1305–1310 |
| 17 | Usage gates / auth blockers | COHESIVE ★(thin) | `useUsageGate` 526, `showSignInBlocker` 648, `requireSignInForAction` 713 |
| 18 | Shared popover chrome | MIXED (glue) | `closeAllVaultPopovers` 1094, click-away/scroll/wheel effects 1111–1220 |

## Cross-group dependency map

```text
Vault.jsx
├── auth + usage gates
│       └── gate upload / quick note / save link / menus
├── data pipeline (notesQuery → notes → vaultCards)
│       ├── folders/AI Drive collapse  → visibleCards
│       ├── search + tags              → filteredVisibleCards
│       ├── layout order               → orderedVisibleCards → render branches
│       ├── reveal ⇄ signed URLs ⇄ first-paint readiness
│       ├── selection/picker  ⇄ postMessage protocol (parent window)
│       ├── preview overlay   → writes signed-URL state (seeds grid)
│       ├── mutations/delete  → setNotes (flattens query pages!)
│       └── upload store → ghost cards → same URL/observer pipeline
└── wake preview → parallel local cards merged into vaultCards
```

Key directional facts:

- `setNotes` (L1023) is the write hub: every optimistic mutation funnels
  through it, and it **collapses all infinite-query pages into one**
  (`pages: [list]`, L1029–1032). Pagination structure only recovers on full
  invalidate.
- The signed-URL pipeline is visibility-driven: `registerCardRef` →
  IntersectionObserver (1200px margin, L2418) → queue → batch drain (20,
  L2402) → per-card resolution → `resolvedAttachmentUrls`.
- Reveal (#4) gates on media readiness from #13 (`isCardMediaReady` L3238),
  so those two extract in that order: URLs first, reveal second.
- Picker protocol: `VAULT_PICKER_CHANGE` out (L1674), `VAULT_PICKER_SET_SELECTION`
  in (L1744), `deliverVaultPick` on Add (L4134); `pickerUserAdjustedRef`
  suppresses late parent updates.

## Surprising couplings (verified in source)

1. **`setNotes` flattens pages** (L1029–1032) — verified. Any future
   pagination work must account for this before touching the data hook.
2. **Preview seeds grid URL state** (L4492, L4505) — verified. Opening the
   lightbox writes into `resolvedAttachmentUrls`; extracting #13 must expose
   a setter the preview can call.
3. **Drag-to-trash is largely vestigial** — `handleCardDragStart` is a
   deliberate no-op with an explanatory comment (L3823–3827); the soft-delete
   undo machinery (`pendingDeleteCardIds` + timers) is alive and shared with
   bulk/menu delete. Do not delete the undo path when cleaning up drag.
4. **AI describe backfill effect (L2962) mutates the notes cache** from
   inside the media zone — crosses #13 → #3.
5. **Dimension persistence intentionally skips `setNotes`** (L2533–2539) —
   DB is healed but live masonry stays frozen; opposite choice from (4).
6. **Uploads almost never refetch** — they merge via `setNotes`; only the
   no-notes fallback calls `refreshNotes` (L6869–6875).
7. **Filter/search changes reset the reveal window** (L3368) — search UX and
   pagination UX are coupled by design.
8. **Deep-link `?note=` loops `loadMoreNotes` until found** (L1838) —
   navigation depends on pagination.
9. **Tab hidden >2 min clears the signed cache and requeues visible cards**
   (L2716) — a global event owned by the media group.
10. **Embedded click-add payloads depend on `resolvedAttachmentUrls`**
    (L3940) — chat attach quality depends on media resolution timing.

## Ranked extraction candidates

1. **`useVaultSignedUrls` (#13)** — safest first hook: self-contained
   cache/queue/observer/dims subsystem with a clear API surface
   (`registerCardRef`, `resolvedAttachmentUrls`, `resolvedVideoPosterUrls`,
   `failedImageIds`, explicit resolve/queue functions). Callers only consume
   values + register elements. Two documented cross-writes (preview seed,
   describe backfill) must be part of its API, not bypassed.
2. **`useVaultTags` (#7)** — needs only `notes`/`setNotes`/`userId`; owns the
   tag directory RPC, filter set, and per-card picker state.
3. **`useVaultSearch` (#6)** — text + concept search with abort handling;
   input cards, output ids/query; one coupling (reveal reset) stays in page.
4. Next tier: quick notes (#14), save-link (#15), layout (#5), then the
   notes-query wrapper (#3, mind the page-flatten), then reveal (#4, only
   after #13), then preview shell (#12).

## Do not extract yet

- **First-paint readiness (#2)** — welded to URL drain, module flag,
  LoadingScreen, and motion flags.
- **`handleCardPress` (L4302)** — single callback fanning into folders,
  picker, embedded add, multi-select, and preview.
- **`visibleCards` memo (L2770/2845)** — folder collapse + search bypass +
  pending-delete filtering in one expression.
- **`renderCollageCard` / `renderAttachmentCard` (L3461 / L4894)** — giant
  closures over selection, drag, URLs, menus, wake, picker.
- **Drag/trash (#10)** — vestigial drag entangled with live undo; needs a
  product decision before structural work.
