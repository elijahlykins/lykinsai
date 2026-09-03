// Vault folders / views controller: connector folder navigation, the AI
// Drive folder, the Collage/Grid/Tags/Type view mode (with its localStorage
// persistence), the search inputs, and the visible/filtered card
// derivations they feed. Extracted from `src/pages/Vault.jsx`; the
// derivation logic itself is pure and lives in `vaultCardModel.js`.
import { useEffect, useMemo, useState } from "react";
import {
  connectorFolderDisplay,
  deriveVisibleCards,
  filterVisibleCards,
} from "@/lib/vault/vaultCardModel";

// Collage/Grid/Tags/Type belong to the Vault page. AI Drive is a folder
// listing with its own icons/list preference (see DriveListing), so it has no
// stake in this one.
const viewStorageKey = "lykn_vault_view";

/**
 * @param {object} params
 * @param {boolean} params.isWakePreview
 * @param {boolean} params.isPickerMode
 * @param {boolean} params.studioSurface
 * @param {object} params.location react-router location (deep-link effect)
 * @param {Array} params.vaultCards
 * @param {Set} params.pendingDeleteCardIds
 * @param {Array} params.selectedFilterTags from useVaultTags
 * @param {boolean} params.isLoadingNotes
 * @param {boolean} params.hasMoreNotes
 * @param {Function} params.loadMoreNotes
 * @param {object} params.cardElementsRef from useVaultSignedUrls (deep-link scroll)
 */
export function useVaultFoldersViews({
  isWakePreview,
  isPickerMode,
  studioSurface,
  location,
  vaultCards,
  pendingDeleteCardIds,
  selectedFilterTags,
  isLoadingNotes,
  hasMoreNotes,
  loadMoreNotes,
  cardElementsRef,
}) {
  // Per-connector "folder" view. When non-null, the vault grid collapses
  // every connector-sourced card (e.g. Notion pages) into a single tile
  // and clicking that tile opens this state to the connector's id. The
  // grid then renders only that connector's items plus a "back to all"
  // affordance. null = normal mixed view.
  const [openSourceFolder, setOpenSourceFolder] = useState(null);
  // Which of AI Drive's folders is open ("docs" / "artifacts" / "images"), or null
  // for the drive's root. See AI_DRIVE_FOLDERS and deriveVisibleCards.
  const [openDriveFolder, setOpenDriveFolder] = useState(null);
  // Display data for the folder-view header (name, domain, favicon),
  // derived from the shared CONNECTORS catalog.
  const openFolderConnector = useMemo(
    () => connectorFolderDisplay(openSourceFolder),
    [openSourceFolder],
  );

  const [vaultSearch, setVaultSearch] = useState("");
  const [embeddedSearch, setEmbeddedSearch] = useState("");
  const [conceptResultIds, setConceptResultIds] = useState(null);
  const [isConceptSearching, setIsConceptSearching] = useState(false);

  const [vaultView, setVaultView] = useState(() => {
    // The wake walkthrough preview always uses the uniform grid view: the
    // collage/masonry layout gives cards Pinterest-style variable heights,
    // which reads as "weirdly spaced, some big some small" inside the small
    // scaled preview window. A grid of equal tiles looks clean and even.
    if (isWakePreview) return "grid";
    try {
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        if (params.get("picker") === "1") return "collage";
      }
      return localStorage.getItem(viewStorageKey) || "collage";
    } catch {
      return "collage";
    }
  });

  useEffect(() => {
    if (isPickerMode) setVaultView("collage");
  }, [isPickerMode]);

  useEffect(() => {
    // Only persist the user's real preference. Wake-preview forces "grid" and
    // picker mode forces "collage" (see the vaultView initializer + isPickerMode
    // effect); if we wrote those forced values back to localStorage they'd
    // clobber the stored preference, so the next normal vault load would wrongly
    // default to the forced view.
    if (isWakePreview || isPickerMode) return;
    try { localStorage.setItem(viewStorageKey, vaultView); } catch {}
  }, [vaultView, isWakePreview, isPickerMode]);

  const visibleCards = useMemo(
    () =>
      deriveVisibleCards({
        vaultCards,
        pendingDeleteCardIds,
        studioSurface,
        openDriveFolder,
        openSourceFolder,
        vaultView,
        embeddedSearch,
        vaultSearch,
        conceptResultIds,
      }),
    [
      vaultCards,
      pendingDeleteCardIds,
      openSourceFolder,
      openDriveFolder,
      studioSurface,
      vaultView,
      embeddedSearch,
      vaultSearch,
      conceptResultIds,
    ],
  );

  const filteredVisibleCards = useMemo(
    () =>
      filterVisibleCards({
        visibleCards,
        selectedFilterTags,
        conceptResultIds,
        embeddedSearch,
      }),
    [embeddedSearch, visibleCards, conceptResultIds, selectedFilterTags],
  );

  // ─── Deep-link: ?note=<noteId> ─────────────────────────────────────
  //
  // Vault deep links navigate
  // to `/vault?note=<id>` so the user lands on this page focused on
  // the specific item the neuron represents. We:
  //   1. Pull `note` from the URL.
  //   2. Wait until vault cards are loaded and the matching card is
  //      mounted in the DOM (cardElementsRef registers each card on
  //      mount via `registerCardRef`).
  //   3. Scroll it into view + add a brief flash class so the user
  //      can see WHICH card the link landed them on (the grid is
  //      dense; without the flash the right card is easy to miss).
  //   4. Clear the URL param via `replaceState` so a refresh / back-
  //      navigate doesn't re-trigger the scroll, and so the URL
  //      shape after navigation is identical to a normal visit.
  //
  // A note can produce multiple cards (one per attachment + one
  // chat-preview + …). We focus the FIRST card with the matching
  // noteId — the order in `vaultCards` mirrors how the user sees
  // them, so the first match is the visually-leading tile.
  useEffect(() => {
    // In the Studio this surface is AI Drive, a listing rather than a collage:
    // there is no tile to scroll to, and the link means "open this". That is
    // handled by the drive deep-link effect in useVaultDriveWindow.
    if (studioSurface) return;
    const params = new URLSearchParams(location.search);
    const targetNoteId = params.get("note");
    if (!targetNoteId) return;
    if (!vaultCards || vaultCards.length === 0) return;

    const match = vaultCards.find(
      (c) => c && c.noteId && String(c.noteId) === targetNoteId,
    );
    if (!match) {
      // The note may simply not be loaded yet: the first query page only
      // covers the newest ~100 items, so a deep link to an older note
      // would previously get its `?note=` param stripped here and never
      // focus. While the initial load is in flight, or more pages remain,
      // keep the param and pull the next page — the `vaultCards` dep
      // re-runs this effect after each page lands. Only a genuinely
      // missing noteId (deleted, foreign) falls through to the strip.
      if (isLoadingNotes) return;
      if (hasMoreNotes) {
        void loadMoreNotes();
        return;
      }
      const next = new URLSearchParams(location.search);
      next.delete("note");
      const search = next.toString();
      window.history.replaceState(
        null,
        "",
        `${location.pathname}${search ? `?${search}` : ""}`,
      );
      return;
    }

    const timer = setTimeout(() => {
      const el = cardElementsRef.current.get(match.id);
      if (el) {
        try {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch {
          /* very old browsers — silently noop */
        }
        el.classList.add("lykn-vault-deeplink-flash");
        setTimeout(() => {
          el.classList.remove("lykn-vault-deeplink-flash");
        }, 2400);
      }
      const next = new URLSearchParams(location.search);
      next.delete("note");
      const search = next.toString();
      window.history.replaceState(
        null,
        "",
        `${location.pathname}${search ? `?${search}` : ""}`,
      );
    }, 80);

    return () => clearTimeout(timer);
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [studioSurface, location.search, location.pathname, vaultCards, isLoadingNotes, hasMoreNotes]);

  return {
    openSourceFolder,
    setOpenSourceFolder,
    openFolderConnector,
    openDriveFolder,
    setOpenDriveFolder,
    vaultView,
    setVaultView,
    vaultSearch,
    setVaultSearch,
    embeddedSearch,
    setEmbeddedSearch,
    conceptResultIds,
    setConceptResultIds,
    isConceptSearching,
    setIsConceptSearching,
    visibleCards,
    filteredVisibleCards,
  };
}
