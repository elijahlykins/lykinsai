// Vault drag / trash controller: the drag-to-trash hold gesture (with its
// undo grace window), the latent card-drag wiring, and the chat-chunk drop
// target that saves dragged chat responses as quick notes. Extracted from
// `src/pages/Vault.jsx`.
//
// Note: card dragging is currently disabled at the renderers
// (`draggable={false}` everywhere; `handleCardDragStart` preventDefaults),
// so the trash-hold path is latent. It is preserved as-is because the
// shared pending-delete undo plumbing is also the bulk-delete path, and the
// trash affordance still renders.
import { useCallback, useRef, useState, useEffect } from "react";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";

/**
 * @param {object} params
 * @param {object|null} params.user
 * @param {boolean} params.isEmbeddedMode
 * @param {string} params.embeddedTargetOrigin
 * @param {object} params.vaultCardsRef live cards ref (drag-end fires from a
 *   DOM event, by which time the closed-over cards array can be stale)
 * @param {Function} params.setPendingDeleteCardIds shared with bulk delete
 * @param {object} params.pendingDeleteTimersRef shared with bulk delete
 * @param {number} params.TRASH_UNDO_GRACE_MS
 * @param {Function} params.removeAttachmentFromNote from useVaultCardMutations
 * @param {Function} params.removeQuickNoteCard from useVaultCardMutations
 * @param {object} params.vaultWrites
 * @param {Function} params.setNotes
 * @param {Function} params.checkVaultLimit
 * @param {Function} params.incrementVaultCount
 */
export function useVaultDragTrash({
  user,
  isEmbeddedMode,
  embeddedTargetOrigin,
  vaultCardsRef,
  setPendingDeleteCardIds,
  pendingDeleteTimersRef,
  TRASH_UNDO_GRACE_MS,
  removeAttachmentFromNote,
  removeQuickNoteCard,
  vaultWrites,
  setNotes,
  checkVaultLimit,
  incrementVaultCount,
}) {
  const [draggedCardId, setDraggedCardId] = useState(null);
  const [dropTargetCardId, setDropTargetCardId] = useState(null);
  const [vaultTrashHover, setVaultTrashHover] = useState(false);
  const [vaultTrashHoldReady, setVaultTrashHoldReady] = useState(false);
  const vaultTrashHoldStartAtRef = useRef(null);
  const vaultTrashHoldTimeoutRef = useRef(null);
  const vaultTrashRef = useRef(null);
  const lastHoverTargetRef = useRef(null);
  const draggedCardMetricsRef = useRef(null);
  const [chatChunkDragOver, setChatChunkDragOver] = useState(false);
  const chatChunkDragDepthRef = useRef(0);

  const clearVaultTrashHold = useCallback(() => {
    vaultTrashHoldStartAtRef.current = null;
    if (vaultTrashHoldTimeoutRef.current) {
      clearTimeout(vaultTrashHoldTimeoutRef.current);
      vaultTrashHoldTimeoutRef.current = null;
    }
    setVaultTrashHoldReady(false);
    setVaultTrashHover(false);
  }, []);

  const startVaultTrashHold = useCallback(() => {
    if (vaultTrashHoldStartAtRef.current === null) {
      vaultTrashHoldStartAtRef.current = performance.now();
      if (vaultTrashHoldTimeoutRef.current) clearTimeout(vaultTrashHoldTimeoutRef.current);
      vaultTrashHoldTimeoutRef.current = window.setTimeout(() => {
        vaultTrashHoldTimeoutRef.current = null;
        setVaultTrashHoldReady(true);
      }, 1000);
    }
    setVaultTrashHover(true);
  }, []);

  // Match canvas trash logic: detect overlap between the dragged card's
  // visual bounding rect (which travels with the cursor as the HTML5 drag
  // ghost) and the trash element's rect, with a 10px pad.
  const handleCardDrag = useCallback((e) => {
    const metrics = draggedCardMetricsRef.current;
    const trashEl = vaultTrashRef.current;
    if (!metrics || !trashEl) return;
    // The browser fires a final `drag` with (0,0) right before `dragend`;
    // ignore it so we don't briefly show "not overlapping" at release.
    if (e.clientX === 0 && e.clientY === 0) return;
    const cardLeft = e.clientX - metrics.offsetX;
    const cardTop = e.clientY - metrics.offsetY;
    const cardRight = cardLeft + metrics.width;
    const cardBottom = cardTop + metrics.height;
    const tr = trashEl.getBoundingClientRect();
    const PAD = 10;
    const overlap =
      cardRight >= tr.left - PAD &&
      cardLeft <= tr.right + PAD &&
      cardBottom >= tr.top - PAD &&
      cardTop <= tr.bottom + PAD;
    if (overlap) {
      if (vaultTrashHoldStartAtRef.current === null) startVaultTrashHold();
    } else if (vaultTrashHoldStartAtRef.current !== null) {
      clearVaultTrashHold();
    }
  }, [startVaultTrashHold, clearVaultTrashHold]);

  // Vault cards cannot be dragged / reordered. Keeping the handler so any
  // leftover `onDragStart` wiring still no-ops safely.
  const handleCardDragStart = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleCardDragEnd = useCallback(() => {
    const ready = vaultTrashHoldReady;
    const cardId = draggedCardId;
    setDraggedCardId(null);
    setDropTargetCardId(null);
    lastHoverTargetRef.current = null;
    draggedCardMetricsRef.current = null;
    clearVaultTrashHold();
    window.dispatchEvent(new CustomEvent("vault_collage_reorder_drag_end"));
    if (isEmbeddedMode) {
      try { window.parent.postMessage({ type: "lykn-chat-vault-drag-end" }, embeddedTargetOrigin); } catch {}
    }
    if (ready && cardId) {
      // We read from `vaultCardsRef.current` instead of a closed-over
      // cards array: the latter is the snapshot from whichever render
      // memoized this callback, which can lag behind the actual current
      // grid by several updates (uploads landing, deletes), causing
      // trash-on-drop to operate on the wrong card or a card that no
      // longer exists.
      const currentCards = vaultCardsRef.current || [];
      const card = currentCards.find((c) => c.id === cardId);
      if (!card) return;
      if (card.kind !== "attachment" && card.kind !== "quick-note") return;

      // Soft-delete: hide the card immediately so the trash gesture
      // feels responsive, but defer the irreversible server-side delete
      // for `TRASH_UNDO_GRACE_MS`. The 3-dot menu still uses
      // `confirmAndDeleteAttachment` (window.confirm), which is fine —
      // that's an explicit click, not an easy-to-fat-finger drag.
      setPendingDeleteCardIds((prev) => {
        const next = new Set(prev);
        next.add(card.id);
        return next;
      });

      const cardSnapshot = card;
      const commitDelete = () => {
        pendingDeleteTimersRef.current.delete(card.id);
        setPendingDeleteCardIds((prev) => {
          if (!prev.has(card.id)) return prev;
          const next = new Set(prev);
          next.delete(card.id);
          return next;
        });
        if (cardSnapshot.kind === "attachment") {
          void removeAttachmentFromNote(cardSnapshot);
        } else if (cardSnapshot.kind === "quick-note") {
          void removeQuickNoteCard(cardSnapshot);
        }
      };

      const timerId = setTimeout(commitDelete, TRASH_UNDO_GRACE_MS);
      pendingDeleteTimersRef.current.set(card.id, timerId);

      const label = String(card?.title || "Item").slice(0, 60);
      const t = toast({
        title: "Moved to trash",
        description: `"${label}" will be deleted.`,
        duration: TRASH_UNDO_GRACE_MS,
        action: (
          <ToastAction
            altText="Undo delete"
            onClick={() => {
              const pending = pendingDeleteTimersRef.current.get(card.id);
              if (pending) {
                clearTimeout(pending);
                pendingDeleteTimersRef.current.delete(card.id);
              }
              setPendingDeleteCardIds((prev) => {
                if (!prev.has(card.id)) return prev;
                const next = new Set(prev);
                next.delete(card.id);
                return next;
              });
              t.dismiss();
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    }
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [isEmbeddedMode, clearVaultTrashHold, vaultTrashHoldReady, draggedCardId, embeddedTargetOrigin]);

  // Note on lifecycle: we deliberately do NOT clear pending-delete
  // timers on unmount. The user dragged to trash WITH intent to delete;
  // if they navigate away during the undo window, the timer fires on
  // the global event loop and the supabase delete still goes through.
  // Any stale `setState` inside the commit closure becomes a no-op on
  // an unmounted component (React 18+ doesn't throw), which is fine —
  // the server state is the source of truth.

  useEffect(() => {
    return () => {
      // Drop the long-press trash-hold timer so it doesn't fire and
      // dispatch state updates after unmount.
      if (vaultTrashHoldTimeoutRef.current) {
        clearTimeout(vaultTrashHoldTimeoutRef.current);
        vaultTrashHoldTimeoutRef.current = null;
      }
    };
  }, []);

  // ─── Chat-chunk drop target (drag a chat response into the vault) ────

  const handleMainDragEnter = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-lykn-chat-chat-response")) {
      e.preventDefault();
      chatChunkDragDepthRef.current += 1;
      setChatChunkDragOver(true);
    }
  }, []);

  const handleMainDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-lykn-chat-chat-response")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleMainDragLeave = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-lykn-chat-chat-response")) {
      e.preventDefault();
      chatChunkDragDepthRef.current = Math.max(0, chatChunkDragDepthRef.current - 1);
      if (chatChunkDragDepthRef.current === 0) setChatChunkDragOver(false);
    }
  }, []);

  const handleMainDrop = useCallback(async (e) => {
    const chatText = e.dataTransfer.getData("application/x-lykn-chat-chat-response");
    if (!chatText || !user?.id) {
      setChatChunkDragOver(false);
      chatChunkDragDepthRef.current = 0;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setChatChunkDragOver(false);
    chatChunkDragDepthRef.current = 0;
    if (!(await checkVaultLimit())) return;
    try {
      const { data: insertedNote, error } = await vaultWrites.insert({
        title: "Quick Note",
        content: chatText,
      });
      if (error || !insertedNote?.id) throw error || new Error("Save failed");
      setNotes((prev) => [insertedNote, ...prev]);
      incrementVaultCount();
    } catch (err) {
      if (!notifyVaultCapIfApplicable(err)) {
        // Action errors (one save failing) used to overwrite the
        // load-error banner, leaving a persistent red strip across the
        // top of the vault even though the rest of the surface was
        // healthy. Surface as a transient toast instead — `notesError`
        // is reserved for "couldn't load your vault at all" failures.
        toast({
          title: "Couldn't save dropped note",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    }
  }, [user?.id, checkVaultLimit, incrementVaultCount, vaultWrites, setNotes]);

  return {
    draggedCardId,
    dropTargetCardId,
    vaultTrashHover,
    vaultTrashHoldReady,
    vaultTrashRef,
    lastHoverTargetRef,
    draggedCardMetricsRef,
    clearVaultTrashHold,
    handleCardDrag,
    handleCardDragStart,
    handleCardDragEnd,
    chatChunkDragOver,
    handleMainDragEnter,
    handleMainDragOver,
    handleMainDragLeave,
    handleMainDrop,
  };
}
