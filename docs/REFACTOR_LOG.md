# Refactor log

Breadcrumb trail for structural changes. One entry per batch; each batch has ONE
architectural objective. Rule: **move first, improve later** — structural moves
never change logic, interfaces, or behavior in the same commit.

Template:

```text
### Change
Moved `X` from `A` to `B`.

### Reason
Why X belongs in B.

### Behavioral change
None intended.

### References checked
- imports/exports re-verified (grep for old paths)
- duplicate definitions checked
- typecheck / relevant `npm run test:*` suites run
```

---

## Batch 1 — 2026-08-25 — Extract pure vault card helpers

### Change
Moved 27 pure top-level helper functions from `src/pages/Vault.jsx` (formerly
lines ~206–868) into new module `src/lib/vault/vaultCardHelpers.js`:
`driveFolderIdFor`, `stripAttachmentJsonMarker`, `isVoiceNoteCard`,
`parseStorageTarget`, `buildTextExcerpt`, `buildSpacedExcerpt`,
`resolveTextNoteStyle`, `textNoteLabel`, `isSupabaseStorageUrlText`,
`sanitizeCardTitle`, `parseAttachmentNotes`, `parseQuickNoteComments`,
`withAttachmentJsonMarker`, `decodeHtmlEntities`, `extractChatPreview`,
`formatDate`, `toNumber`, `resolveAttachmentAspectRatio`, `isYouTubeShortUrl`,
`stableBucket`, `getYouTubeOffsetClass`, `vaultPdfEmbedUrl`,
`isUniformVaultTileClass`, `getAttachmentHeightClass`, `estimateCardHeightUnit`,
`resolveStableTileHeight`, `extractYouTubeLinks`.

Function bodies and comments moved verbatim; only `export` keywords added.
`Vault.jsx` imports 24 of them (the other 3 — `decodeHtmlEntities`,
`isYouTubeShortUrl`, `stableBucket` — were only called by other moved helpers).
The now-unused `isVerticalSocialContent` import moved from `Vault.jsx` to the
new module.

### Deliberately NOT moved
`resolveSourceFolder` (module-level memo cache + CONNECTORS), signed-URL cache
trio (`parseSignedUrlExpiry`/`readCachedSignedUrl`/`writeCachedSignedUrl` —
mutates caller cache, time-dependent), `renderConnectorListCard` (JSX),
`trapPopoverWheel` (DOM events), all module constants.

### Reason
Vault card parsing/layout helpers are deterministic functions with no React
or I/O dependencies; extracting them shrinks the 10.2k-line page and creates
the seam for future Vault splits.

### Behavioral change
None intended. Bodies byte-identical apart from `export`.

### References checked
- Each moved name: exactly 1 definition repo-wide after move (grep).
- All in-file call sites resolve via the new import (ESLint `no-undef` +
  `unused-imports` clean for this batch; the 2 remaining errors —
  `ChevronUp`/`ArrowRight` icons — were already unused at HEAD, left for a
  dedicated cleanup batch).
- `stripAttachmentsMarker`/`withAttachmentsMarker` imports kept in Vault.jsx
  (still used at ~3187/3697/9053).
- `npm run build` (vite): success.
- Known drift NOT touched: `src/lib/vault/vaultContentsForAi.ts` keeps its own
  older private copies of 7 of these helpers — future dedup batch must diff
  them first.

### Result
`Vault.jsx`: 10,163 → 9,706 lines (−457). New module: 498 lines.

---

## Batch 2 — 2026-08-25 — Remove unused imports in Vault.jsx

### Change
Removed two unused named imports from the `lucide-react` import block in
`src/pages/Vault.jsx`: `ChevronUp`, `ArrowRight`.

### Reason
Both symbols had zero references in the file. Verified against the
pre-Batch-1 baseline (`git show 85be9a4~1`): each already had exactly one
reference (the import line itself) before the helper extraction, so they were
pre-existing dead imports, not orphans created by Batch 1.

### Behavioral change
None. Named icon imports have no side effects.

### References checked
- ESLint `unused-imports/no-unused-imports`: 0 errors after change
  (was 2; remaining warnings are pre-existing unused eslint-disable
  directives, out of scope).
- `npm run build` (vite): success.

### Result
`Vault.jsx`: 9,706 → 9,704 lines (−2).
