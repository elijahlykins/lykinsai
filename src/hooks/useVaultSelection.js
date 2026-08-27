// Vault selection + picker controller: multi-select state and gestures
// (shift range / cmd toggle), the picker-mode note-level selection, and the
// postMessage sync with the parent window when the vault is embedded as a
// picker. Extracted from `src/pages/Vault.jsx`.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  VAULT_PICKER_CHANGE,
  VAULT_PICKER_SET_SELECTION,
} from "@/lib/vault/vaultPickerProtocol";

/**
 * @param {object} params
 * @param {boolean} params.isPickerMode
 * @param {boolean} params.isEmbeddedMode
 * @param {string} params.embeddedTargetOrigin
 * @param {Array} params.vaultCards
 * @param {object} params.vaultCardsRef live ref of the cards for handlers
 *   that fire outside React's render cycle
 * @param {Array} params.notes drives the stale-selection prune
 */
export function useVaultSelection({
  isPickerMode,
  isEmbeddedMode,
  embeddedTargetOrigin,
  vaultCards,
  vaultCardsRef,
  notes,
}) {
  // Multi-select state. Shift+click selects a range; Cmd/Ctrl+click toggles
  // a single card. `lastSelectedCardIdRef` is the anchor for range-select —
  // we re-resolve it against the live `vaultCardsRef` at click time so
  // selection ranges still make sense after the grid has reordered.
  const [selectedCardIds, setSelectedCardIds] = useState(() => new Set());
  const pickerInitNoteIdsRef = useRef(null);
  const pickerParentInitReceivedRef = useRef(false);
  const pickerParentNoteIdsRef = useRef([]);
  const pickerSyncedWithParentRef = useRef(false);
  const pickerUserAdjustedRef = useRef(false);
  const lastSelectedCardIdRef = useRef(null);

  // Only real content cards (attachment + quick-note) are selectable —
  // source-folder tiles, chat-previews, and ghost upload cards are
  // navigation/transient affordances and aren't deletable as a group.
  const isSelectableCard = useCallback((card) => {
    if (!card) return false;
    if (card.isDemo) return false;
    // Ghost upload cards carry `ghost: true` (see buildGhostCards);
    // they have no noteId yet so delete would silently no-op.
    if (card.ghost) return false;
    return card.kind === "attachment" || card.kind === "quick-note";
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedCardIds((prev) => (prev.size === 0 ? prev : new Set()));
    lastSelectedCardIdRef.current = null;
  }, []);

  const toggleCardSelection = useCallback((card) => {
    if (!isSelectableCard(card)) return;
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(card.id)) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
    lastSelectedCardIdRef.current = card.id;
  }, [isSelectableCard]);

  // Picker clicks select whole notes: every card the note produced toggles
  // together so the parent receives note ids, not per-attachment card ids.
  const toggleNoteSelectionInPicker = useCallback((card) => {
    if (!isSelectableCard(card)) return;
    if (pickerSyncedWithParentRef.current) {
      pickerUserAdjustedRef.current = true;
    }
    const noteId = card.noteId || card.id;
    setSelectedCardIds((prev) => {
      const allCards = vaultCardsRef.current || [];
      const cardsForNote = allCards.filter(
        (c) => (c.noteId || c.id) === noteId && isSelectableCard(c),
      );
      const noteSelected = cardsForNote.some((c) => prev.has(c.id));
      const next = new Set(prev);
      if (noteSelected) {
        for (const c of cardsForNote) next.delete(c.id);
      } else {
        for (const c of cardsForNote) next.add(c.id);
      }
      return next;
    });
    lastSelectedCardIdRef.current = card.id;
  }, [isSelectableCard, vaultCardsRef]);

  // Shift+click range select: pick everything between the last-clicked
  // anchor and the just-clicked card, in current visual grid order. If
  // there's no anchor (first shift-click), behave like a plain toggle so
  // the user always gets a useful result.
  const selectRangeTo = useCallback((card) => {
    if (!isSelectableCard(card)) return;
    const anchorId = lastSelectedCardIdRef.current;
    const allCards = vaultCardsRef.current || [];
    if (!anchorId || anchorId === card.id) {
      setSelectedCardIds((prev) => {
        const next = new Set(prev);
        next.add(card.id);
        return next;
      });
      lastSelectedCardIdRef.current = card.id;
      return;
    }
    const idxA = allCards.findIndex((c) => c.id === anchorId);
    const idxB = allCards.findIndex((c) => c.id === card.id);
    if (idxA === -1 || idxB === -1) {
      toggleCardSelection(card);
      return;
    }
    const lo = Math.min(idxA, idxB);
    const hi = Math.max(idxA, idxB);
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i += 1) {
        const c = allCards[i];
        if (isSelectableCard(c)) next.add(c.id);
      }
      return next;
    });
    // Don't update the anchor on shift-click — Finder/Files-style: shift
    // extends from the same anchor each time, so the user can adjust the
    // range without re-clicking the start.
  }, [isSelectableCard, toggleCardSelection, vaultCardsRef]);

  // ─── Picker ↔ parent window sync ────────────────────────────────────

  const postPickerSelection = useCallback(() => {
    if (!isPickerMode || !isEmbeddedMode) return;
    if (selectedCardIds.size === 0) {
      if (!pickerParentInitReceivedRef.current || pickerInitNoteIdsRef.current?.length) {
        return;
      }
      pickerParentNoteIdsRef.current = [];
      try {
        window.parent.postMessage(
          { type: VAULT_PICKER_CHANGE, noteIds: [], items: [] },
          embeddedTargetOrigin,
        );
      } catch {
        /* ignore */
      }
      return;
    }
    const allCards = vaultCardsRef.current || [];
    let noteIdSet = new Set();
    const itemsById = new Map();
    for (const cardId of selectedCardIds) {
      const card = allCards.find((c) => c.id === cardId);
      if (!card) continue;
      const noteId = String(card.noteId || card.id || "").trim();
      if (!noteId || noteIdSet.has(noteId)) continue;
      noteIdSet.add(noteId);
      itemsById.set(noteId, {
        noteId,
        title: card.title || card.parentTitle || "Untitled",
        type: card.type || card.kind,
        tags: card.tags || [],
      });
    }

    const parentIds = (pickerParentNoteIdsRef.current || []).map(String).filter(Boolean);
    if (pickerUserAdjustedRef.current) {
      pickerParentNoteIdsRef.current = [...noteIdSet];
    } else if (parentIds.length) {
      noteIdSet = new Set([...parentIds, ...noteIdSet]);
      if (parentIds.every((id) => noteIdSet.has(id))) {
        pickerSyncedWithParentRef.current = true;
      }
      pickerParentNoteIdsRef.current = [...noteIdSet];
    } else {
      pickerParentNoteIdsRef.current = [...noteIdSet];
    }

    const items = [];
    for (const noteId of noteIdSet) {
      const item = itemsById.get(noteId);
      if (item) items.push(item);
    }
    try {
      window.parent.postMessage(
        {
          type: VAULT_PICKER_CHANGE,
          noteIds: [...noteIdSet],
          items,
        },
        embeddedTargetOrigin,
      );
    } catch {
      /* ignore */
    }
  }, [isPickerMode, isEmbeddedMode, selectedCardIds, embeddedTargetOrigin, vaultCardsRef]);

  useEffect(() => {
    postPickerSelection();
  }, [postPickerSelection]);

  useEffect(() => {
    if (!isPickerMode) {
      pickerParentInitReceivedRef.current = false;
      pickerInitNoteIdsRef.current = null;
      pickerParentNoteIdsRef.current = [];
      pickerSyncedWithParentRef.current = false;
      pickerUserAdjustedRef.current = false;
      return;
    }
    const handler = (event) => {
      if (event.origin !== embeddedTargetOrigin) return;
      if (event.data?.type !== VAULT_PICKER_SET_SELECTION) return;
      // Parent sometimes re-pushes the open-time baseline after the user has
      // already clicked. Honor their picks and ignore the late overwrite.
      if (pickerUserAdjustedRef.current) return;
      pickerParentInitReceivedRef.current = true;
      pickerSyncedWithParentRef.current = false;
      const noteIds = Array.isArray(event.data.noteIds)
        ? event.data.noteIds.map(String).filter(Boolean)
        : [];
      pickerParentNoteIdsRef.current = noteIds;
      if (!noteIds.length) {
        setSelectedCardIds(new Set());
        pickerInitNoteIdsRef.current = null;
        return;
      }
      const allCards = vaultCardsRef.current || [];
      if (!allCards.length) {
        pickerInitNoteIdsRef.current = noteIds;
        return;
      }
      const idSet = new Set(noteIds);
      const cardIds = allCards
        .filter((c) => idSet.has(c.noteId || c.id) && isSelectableCard(c))
        .map((c) => c.id);
      setSelectedCardIds(new Set(cardIds));
      pickerInitNoteIdsRef.current = null;
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [isPickerMode, embeddedTargetOrigin, isSelectableCard, vaultCardsRef]);

  // The parent's baseline can arrive before the first cards load; apply it
  // as soon as the grid materializes.
  useEffect(() => {
    if (!isPickerMode || !pickerInitNoteIdsRef.current?.length) return;
    const noteIds = pickerInitNoteIdsRef.current;
    const idSet = new Set(noteIds);
    const cardIds = vaultCards
      .filter((c) => idSet.has(c.noteId || c.id) && isSelectableCard(c))
      .map((c) => c.id);
    setSelectedCardIds(new Set(cardIds));
    pickerInitNoteIdsRef.current = null;
  }, [isPickerMode, vaultCards, isSelectableCard]);

  // Drop any selected ids whose underlying card is no longer in the grid —
  // covers the case where a card the user had selected gets deleted via the
  // 3-dot menu, drag-to-trash, or vanishes after a sync. Without this the
  // floating action bar would show stale counts.
  useEffect(() => {
    if (selectedCardIds.size === 0) return;
    const liveIds = new Set((vaultCardsRef.current || []).map((c) => c.id));
    let changed = false;
    const next = new Set();
    for (const id of selectedCardIds) {
      if (liveIds.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedCardIds(next);
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [notes, selectedCardIds]);

  return {
    selectedCardIds,
    setSelectedCardIds,
    lastSelectedCardIdRef,
    isSelectableCard,
    clearSelection,
    toggleCardSelection,
    toggleNoteSelectionInPicker,
    selectRangeTo,
  };
}
