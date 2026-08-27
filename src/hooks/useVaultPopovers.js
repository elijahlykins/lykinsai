// Vault popover controller: the per-card "…" menu, the comment composer,
// the toolbar view dropdown, and the shared dismissal behavior (capture-
// phase click-away, Escape, close-on-scroll/resize, and the non-passive
// wheel traps that keep gestures inside a popover from scrolling the grid
// behind it). Extracted from `src/pages/Vault.jsx`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Keep wheel/trackpad gestures inside a floating vault popover from scrolling
 * the page behind it. Without this, hovering a non-scroll region (or
 * overscrolling past the list end) scrolls the grid and the scroll-dismiss
 * handler closes the menu.
 */
export function trapPopoverWheel(event) {
  const root = event.currentTarget;
  if (!(root instanceof Element)) return;
  event.stopPropagation();

  const delta = event.deltaY;
  if (!delta) {
    event.preventDefault();
    return;
  }

  let el = event.target instanceof Element ? event.target : null;
  while (el && root.contains(el)) {
    if (el instanceof HTMLElement) {
      const { overflowY } = window.getComputedStyle(el);
      const canScrollY =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 1;
      if (canScrollY) {
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        // This container (or an outer one still in the popover) can absorb the
        // gesture — let the browser scroll it. Only block when nothing left.
        if ((delta < 0 && !atTop) || (delta > 0 && !atBottom)) return;
      }
    }
    el = el.parentElement;
  }
  // No in-popover scroller can move further (or none under the cursor).
  event.preventDefault();
}

/**
 * @param {object} params
 * @param {boolean} params.isWakePreview
 * @param {Function} params.requireSignInForAction
 * @param {object} params.tagPickerRef from useVaultTags
 * @param {string|null} params.tagPickerCardId from useVaultTags
 * @param {Function} params.setTagPickerCardId
 * @param {Function} params.setTagPickerPosition
 * @param {Function} params.setNewTagInput
 * @param {Function} params.setShowEmbeddedTagDropdown
 * @param {object} params.embeddedTagDropdownRef from useVaultTags
 * @param {object} params.previewShareMenuRef from useVaultPreview
 * @param {object} params.previewProjectDropdownRef from useVaultPreview
 * @param {Function} params.setPreviewShareMenuRect
 * @param {Function} params.setPreviewProjectDropdownOpen
 * @param {Function} params.setShowSaveLink from useVaultQuickCapture
 * @param {Function} params.setShowNewNoteChooser from useVaultQuickCapture
 */
export function useVaultPopovers({
  isWakePreview,
  requireSignInForAction,
  tagPickerRef,
  tagPickerCardId,
  setTagPickerCardId,
  setTagPickerPosition,
  setNewTagInput,
  setShowEmbeddedTagDropdown,
  embeddedTagDropdownRef,
  previewShareMenuRef,
  previewProjectDropdownRef,
  setPreviewShareMenuRect,
  setPreviewProjectDropdownOpen,
  setShowSaveLink,
  setShowNewNoteChooser,
}) {
  const [openCardMenuId, setOpenCardMenuId] = useState(null);
  const [openCardMenuPlacement, setOpenCardMenuPlacement] = useState("down");
  const [openCardMenuRect, setOpenCardMenuRect] = useState(null);
  const [openAttachmentNotesCardId, setOpenAttachmentNotesCardId] = useState(null);
  // Viewport-space anchor rect for the comment composer popover. We
  // render the composer via React portal (see VaultCardPopovers) so it can
  // escape the card's `overflow-hidden` clip — historically the composer
  // was an `absolute` element inside the card and got cut off in grid
  // mode, making it impossible to type into.
  const [openAttachmentNotesRect, setOpenAttachmentNotesRect] = useState(null);
  const [attachmentNoteDraft, setAttachmentNoteDraft] = useState("");
  const [showVaultViewDropdown, setShowVaultViewDropdown] = useState(false);
  const vaultViewDropdownRef = useRef(null);
  const cardMenuRef = useRef(null);
  const noteComposerRef = useRef(null);

  const closeAllVaultPopovers = useCallback(() => {
    setOpenCardMenuId(null);
    setOpenCardMenuRect(null);
    setOpenAttachmentNotesCardId(null);
    setOpenAttachmentNotesRect(null);
    setAttachmentNoteDraft("");
    setTagPickerCardId(null);
    setTagPickerPosition(null);
    setNewTagInput("");
    setShowEmbeddedTagDropdown(false);
    setShowVaultViewDropdown(false);
    setPreviewShareMenuRect(null);
    setPreviewProjectDropdownOpen(false);
    // Inline preview comments are not a popover — don't clear them here or
    // clicking the textarea / Save wipes the draft before the click lands.
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, []);

  useEffect(() => {
    // Capture-phase pointerdown so click-away still wins when card/menu
    // buttons call stopPropagation (bubble-only window listeners never saw
    // those outside clicks, so tags/comments/⋯ stayed open).
    const onPointerDownCapture = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Clicks inside an open popover keep it alive.
      if (cardMenuRef.current?.contains(target)) return;
      if (noteComposerRef.current?.contains(target)) return;
      if (tagPickerRef.current?.contains(target)) return;
      if (previewShareMenuRef.current?.contains(target)) return;
      if (previewProjectDropdownRef.current?.contains(target)) return;
      if (embeddedTagDropdownRef.current?.contains(target)) return;
      if (vaultViewDropdownRef.current?.contains(target)) return;
      // Inline comment composer / list under Why I saved this.
      if (target instanceof Element && target.closest("[data-vault-preview-comments]")) return;
      // Toggle triggers manage open/close themselves — don't fight them.
      if (target instanceof Element && target.closest("[data-vault-popover-trigger]")) return;
      closeAllVaultPopovers();
    };
    const onBlur = () => {
      setShowEmbeddedTagDropdown(false);
      setShowVaultViewDropdown(false);
    };
    // Escape closes the open dropdown / tag picker — same expectation
    // as every other floating menu on the page. Without this the only
    // way to dismiss the tag picker without selecting was clicking
    // outside, which mobile users especially missed.
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      closeAllVaultPopovers();
      // Escape should also dismiss the Save Link dialog and the new-note
      // chooser — previously they were backdrop-click/X only.
      setShowSaveLink(false);
      setShowNewNoteChooser(false);
    };
    document.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownCapture, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
    };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [closeAllVaultPopovers]);

  useEffect(() => {
    if (!openCardMenuId) return;
    // Close when the vault grid scrolls underneath so the fixed menu doesn't
    // float detached — but ignore scrolls that originate inside the menu, or
    // while the pointer is still hovering it (wheel over non-scroll regions /
    // overscroll at the list end used to scroll the page and dismiss the menu).
    const onScroll = (event) => {
      const menu = cardMenuRef.current;
      if (menu?.matches?.(":hover")) return;
      const target = event?.target;
      if (target instanceof Node && menu?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-vault-popover]")) return;
      setOpenCardMenuId(null);
    };
    const onResize = () => setOpenCardMenuId(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [openCardMenuId]);

  // Non-passive wheel trap: React's onWheel can't preventDefault, so wheel
  // over menu chrome / list end would still scroll the grid and dismiss.
  useLayoutEffect(() => {
    if (!openCardMenuId) return;
    const menu = cardMenuRef.current;
    if (!menu) return;
    menu.addEventListener("wheel", trapPopoverWheel, { passive: false });
    return () => menu.removeEventListener("wheel", trapPopoverWheel);
  }, [openCardMenuId]);

  // The comment composer and tag picker are position:fixed popovers anchored
  // to a rect captured at open time. Close them on scroll/resize so they
  // don't float detached from their card when the grid scrolls behind them.
  useEffect(() => {
    if (!openAttachmentNotesCardId && !tagPickerCardId) return;
    const close = (event) => {
      const target = event?.target;
      if (target instanceof Element) {
        const pop = target.closest("[data-vault-popover]");
        if (pop) return;
      }
      if (
        noteComposerRef.current?.matches?.(":hover") ||
        tagPickerRef.current?.matches?.(":hover")
      ) {
        return;
      }
      setOpenAttachmentNotesCardId(null);
      setTagPickerCardId(null);
      setTagPickerPosition(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [openAttachmentNotesCardId, tagPickerCardId]);

  useLayoutEffect(() => {
    if (!openAttachmentNotesCardId && !tagPickerCardId) return;
    const noteEl = noteComposerRef.current;
    const tagEl = tagPickerRef.current;
    if (noteEl) noteEl.addEventListener("wheel", trapPopoverWheel, { passive: false });
    if (tagEl) tagEl.addEventListener("wheel", trapPopoverWheel, { passive: false });
    return () => {
      if (noteEl) noteEl.removeEventListener("wheel", trapPopoverWheel);
      if (tagEl) tagEl.removeEventListener("wheel", trapPopoverWheel);
    };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [openAttachmentNotesCardId, tagPickerCardId]);

  // Open the comment composer anchored to a specific element (the
  // count badge, the "…" menu's Comment item, etc.). We capture the
  // anchor's viewport rect so the portal-rendered composer can position
  // itself directly above/below the trigger regardless of which card
  // wrapper or scroll container it lives inside.
  const openAttachmentNotesForAnchor = useCallback((cardId, anchorEl) => {
    if (!isWakePreview && requireSignInForAction()) return;
    const rect = anchorEl?.getBoundingClientRect?.();
    setOpenCardMenuId(null);
    setOpenCardMenuRect(null);
    setTagPickerCardId(null);
    setTagPickerPosition(null);
    setNewTagInput("");
    setOpenAttachmentNotesRect(
      rect
        ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
        : null,
    );
    setAttachmentNoteDraft("");
    setOpenAttachmentNotesCardId(cardId);
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [isWakePreview, requireSignInForAction]);

  const closeAttachmentNotes = useCallback(() => {
    setOpenAttachmentNotesCardId(null);
    setOpenAttachmentNotesRect(null);
    setAttachmentNoteDraft("");
  }, []);

  const openCardMenuForAnchor = useCallback((cardId, anchorEl) => {
    // Guests on the standalone vault only see demo cards — gate the menu
    // behind sign-in. The wake walkthrough preview lets guests explore the
    // menu UI; mutating actions still prompt sign-in (except preview quick
    // notes the guest saved this session).
    if (!isWakePreview && requireSignInForAction()) return;

    const menuEstimatedHeight = 320;
    const rect = anchorEl?.getBoundingClientRect?.();
    setOpenAttachmentNotesCardId(null);
    setOpenAttachmentNotesRect(null);
    setAttachmentNoteDraft("");
    setTagPickerCardId(null);
    setTagPickerPosition(null);
    setNewTagInput("");
    if (!rect) {
      setOpenCardMenuPlacement("down");
      setOpenCardMenuRect(null);
      setOpenCardMenuId(cardId);
      return;
    }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldOpenUp =
      spaceBelow < menuEstimatedHeight && spaceAbove > spaceBelow;

    setOpenCardMenuPlacement(shouldOpenUp ? "up" : "down");
    setOpenCardMenuRect({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height });
    setOpenCardMenuId(cardId);
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [isWakePreview, requireSignInForAction]);

  return {
    openCardMenuId,
    setOpenCardMenuId,
    openCardMenuPlacement,
    openCardMenuRect,
    setOpenCardMenuRect,
    openAttachmentNotesCardId,
    setOpenAttachmentNotesCardId,
    openAttachmentNotesRect,
    setOpenAttachmentNotesRect,
    attachmentNoteDraft,
    setAttachmentNoteDraft,
    showVaultViewDropdown,
    setShowVaultViewDropdown,
    vaultViewDropdownRef,
    cardMenuRef,
    noteComposerRef,
    closeAllVaultPopovers,
    openAttachmentNotesForAnchor,
    closeAttachmentNotes,
    openCardMenuForAnchor,
  };
}
