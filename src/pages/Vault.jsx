// Vault page — composition root. The page owns route/surface detection,
// cross-cutting shared state (the open preview card, the pending-delete undo
// set), hook/controller assembly, top-level event wiring (handleCardPress,
// pick delivery), and the major visual sections. Behavior lives in:
//
//   vaultCardModel.js          notes → cards → visible → filtered (pure)
//   useVaultNotesData          query / pagination / refresh / uploads / projects
//   useVaultReadyGate          LoadingScreen gate + eager image preload
//   useVaultSelection          multi-select + picker parent sync
//   useVaultFoldersViews       connector folders / AI Drive folder / view mode / search
//   useVaultPreview            preview open-state, lightbox, share, external open
//   useVaultPopovers           card menu / comment composer / dismissal
//   useVaultDragTrash          drag-to-trash hold + chat-chunk drop target
//   useVaultAiDescribeBackfill background attachment descriptions
//   (plus the pre-existing signed-urls / tags / mutations / ordering /
//    reveal / masonry / quick-capture / concept-search / drive-window hooks)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Plus,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  VAULT_PICK_ITEMS_EVENT,
  VAULT_PICK_PROJECT_EVENT,
  closeVaultPicker,
  deliverVaultPick,
  pickTargetFromParams,
} from "@/lib/vault/vaultPicker";
import { useVaultSignedUrls } from "@/hooks/useVaultSignedUrls";
import { useVaultTags } from "@/hooks/useVaultTags";
import { useVaultConceptSearch } from "@/hooks/useVaultConceptSearch";
import { useVaultQuickCapture } from "@/hooks/useVaultQuickCapture";
import { useVaultCardOrdering } from "@/hooks/useVaultCardOrdering";
import { useVaultReveal } from "@/hooks/useVaultReveal";
import { useVaultMasonry } from "@/hooks/useVaultMasonry";
import { useVaultCardMutations } from "@/hooks/useVaultCardMutations.jsx";
import { useVaultDriveWindow } from "@/hooks/useVaultDriveWindow";
import { useVaultNotesData } from "@/hooks/useVaultNotesData";
import { useVaultReadyGate } from "@/hooks/useVaultReadyGate";
import { useVaultSelection } from "@/hooks/useVaultSelection";
import { useVaultFoldersViews } from "@/hooks/useVaultFoldersViews";
import { useVaultPreview } from "@/hooks/useVaultPreview";
import { useVaultPopovers, trapPopoverWheel } from "@/hooks/useVaultPopovers";
import { useVaultDragTrash } from "@/hooks/useVaultDragTrash.jsx";
import { useVaultAiDescribeBackfill } from "@/hooks/useVaultAiDescribeBackfill";
import {
  buildEmbeddedVaultPayload,
  buildVaultCards,
  resolveAttachmentType,
} from "@/lib/vault/vaultCardModel";
import {
  createRenderAttachmentCard,
  createRenderCollageCard,
} from "@/components/vault/vaultCardRenderers";
import VaultPreviewOverlay, {
  VaultPreviewShareMenu,
} from "@/components/vault/VaultPreviewOverlay";
import VaultCardPopovers from "@/components/vault/VaultCardPopovers";
import VaultToolbar from "@/components/vault/VaultToolbar";
import VaultGrid from "@/components/vault/VaultGrid";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import VaultNewNoteChooser from "@/components/vault/VaultNewNoteChooser";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { useUsageGate } from "@/lib/useUsageGate";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import UpgradeModal from "@/components/UpgradeModal";
import SignInActionBlocker from "@/components/SignInActionBlocker";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import LoadingScreen from "@/components/LoadingScreen";
import AddLinkDialog from "@/components/AddLinkDialog";
import DriveListing from "@/components/macfiles/DriveListing";
import { buildWakeVaultDemoCards } from "@/lib/wake/wakeVaultDemoCards";
import { WAKE_WALKTHROUGH_GATE_TEXT } from "@/components/wake/wakeWalkthrough";
import {
  buildWakePreviewUserQuickNoteCards,
  readWakeVaultPreviewQuickNotes,
} from "@/lib/wake/wakeVaultPreviewQuickNotes";
import {
  readWakeVaultPreviewComments,
  readWakeVaultPreviewDeletedComments,
} from "@/lib/wake/wakeVaultPreviewComments";

// `studioSurface` — mounted in-document inside the LYKN Studio panel, which
// draws its own chrome; floating affordances like the drag-to-delete trash
// can stay hidden there.
export default function Vault({
  wakePreview = false,
  onWakePreviewTabChange,
  studioSurface = false,
  pickTarget = null,
} = {}) {
  const location = useLocation();
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const isWakePreview = Boolean(wakePreview);
  const addMediaTriggerRef = useRef(null);
  const isEmbeddedMode = useMemo(
    () => !isWakePreview && new URLSearchParams(location.search).get("embedded") === "1",
    [location.search, isWakePreview]
  );
  const isPickerMode = useMemo(
    () => !isWakePreview && new URLSearchParams(location.search).get("picker") === "1",
    [location.search, isWakePreview]
  );
  // Who opened this window as a picker — a chat bar, an open chat, or a
  // project — or null when it was opened to browse. A click then selects
  // rather than opening a preview, and the status bar becomes Cancel / Add,
  // matching what Finder's own picker does.
  const activePickTarget = useMemo(() => {
    if (isWakePreview) return null;
    if (pickTarget) return pickTarget;
    const fromUrl = pickTargetFromParams(new URLSearchParams(location.search));
    if (fromUrl) return fromUrl;
    try {
      return sessionStorage.getItem("lykn_vault_pick_for_chat") === "1" ? "home" : null;
    } catch {
      return null;
    }
  }, [location.search, isWakePreview, pickTarget]);
  const isChatPickMode = activePickTarget !== null;
  // Origin to pass to `window.parent.postMessage`. Targeting "*" (the
  // previous behaviour) leaks vault drag payloads to whoever happens to
  // be embedding us, including a malicious parent. The Omnia overlay
  // hosts the iframe same-origin, so anchoring to our own origin is
  // safe and tightens the channel.
  const embeddedTargetOrigin = useMemo(() => {
    try {
      return typeof window !== "undefined" ? window.location.origin : "*";
    } catch {
      return "*";
    }
  }, []);
  useEffect(() => {
    if (isEmbeddedMode) {
      document.documentElement.classList.add("embedded-transparent");
      return () => document.documentElement.classList.remove("embedded-transparent");
    }
  }, [isEmbeddedMode]);

  const { checkVaultLimit, incrementVaultCount, refreshVaultCount, upgradeModal, dismissUpgradeModal } = useUsageGate();
  // Tracks cards the user has click-added to the chat from the embedded vault
  // popup, so we can show an "added" checkmark and let them add several in a row.
  const [addedCardIds, setAddedCardIds] = useState(() => new Set());

  // Set to false when the component unmounts. Image-retry / copy-toast /
  // trash-hold timers check this before calling setState so they don't
  // resurrect state on a torn-down tree.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [wakePreviewQuickNotes, setWakePreviewQuickNotes] = useState(() =>
    wakePreview ? readWakeVaultPreviewQuickNotes() : [],
  );
  const [wakePreviewCardComments, setWakePreviewCardComments] = useState(() =>
    wakePreview ? readWakeVaultPreviewComments() : {},
  );
  const [wakePreviewDeletedComments, setWakePreviewDeletedComments] = useState(() =>
    wakePreview ? readWakeVaultPreviewDeletedComments() : {},
  );

  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof document !== "undefined" && document.body.classList.contains("sidebar-push")
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setSidebarOpen(document.body.classList.contains("sidebar-push"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const [showSignInBlocker, setShowSignInBlocker] = useState(false);
  const [walkthroughGateOpen, setWalkthroughGateOpen] = useState(false);
  const requireSignInForAction = useCallback(() => {
    if (user?.id) return false;
    if (isWakePreview) {
      setWalkthroughGateOpen(true);
      return true;
    }
    setShowSignInBlocker(true);
    return true;
  }, [user?.id, isWakePreview]);
  const vaultPreviewRootRef = useRef(null);
  const loadMoreRef = useRef(null);

  // Reactive mobile-viewport detection (used for FAB / action-bar
  // positioning). The previous module-level capture of window.innerWidth
  // never updated when the user resized the window (or rotated their
  // tablet), leaving the layout stuck in whichever mode the page first
  // rendered in.
  const [isMobileChat, setIsMobileChat] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)").matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = (e) => setIsMobileChat(e.matches);
    setIsMobileChat(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // Cards the user just drag-dropped on the trash (or bulk-deleted) whose
  // actual server delete is still pending behind an undo grace window.
  // Hidden from the grid optimistically; restored if the user clicks Undo;
  // committed (real delete) when the timer fires. Shared between the
  // drag/trash controller and the bulk-delete path in the mutations hook,
  // so the page owns it.
  const [pendingDeleteCardIds, setPendingDeleteCardIds] = useState(() => new Set());
  const pendingDeleteTimersRef = useRef(new Map());
  // Window before a trashed card is actually deleted on the server.
  // Long enough to let the user notice "wait, I didn't mean to" and click
  // Undo; short enough that the card actually disappears soon if they
  // meant it. The card is hidden from the grid for the whole window.
  const TRASH_UNDO_GRACE_MS = 6000;

  // Cross-hook bridges (see the hooks' docblocks): the data hook is mounted
  // before the signed-urls machinery and the ready gate, but two of its
  // callbacks reach forward into them at event time.
  const resetLoadGateRef = useRef(null);
  const mediaBridgeRef = useRef(null);

  // ─── Data plane ──────────────────────────────────────────────────────
  const {
    vaultWrites,
    vaultQueryClient,
    notes,
    notesError,
    isLoadingNotes,
    hasMoreNotes,
    isLoadingMoreNotes,
    setNotes,
    refreshNotes,
    loadMoreNotes,
    mergeUploadedNotes,
    handleVariantsReady,
    projects,
    projectsRef,
    invalidateVaultProjects,
    ghostCards,
  } = useVaultNotesData({ user, loading, resetLoadGateRef, mediaBridgeRef });

  // Quick-note composer, new-note chooser and save-link dialog (open state,
  // drafts, save/close/discard). Gating callbacks are passed in from above.
  const {
    showQuickNote,
    showNewNoteChooser,
    setShowNewNoteChooser,
    quickNoteContent,
    setQuickNoteContent,
    isQuickNoteSaving,
    showSaveLink,
    setShowSaveLink,
    isSaveLinkSaving,
    handleRequestSaveLink,
    handleToggleQuickNote,
    handleChooseWrittenNote,
    handleSaveQuickNote,
    handleCloseQuickNote,
    handleDiscardQuickNote,
    handleSaveLink,
  } = useVaultQuickCapture({
    user,
    isWakePreview,
    vaultWrites,
    setNotes,
    checkVaultLimit,
    incrementVaultCount,
    requireSignInForAction,
    setShowSignInBlocker,
    setWakePreviewQuickNotes,
  });

  // The Vault never renders synthetic/template content. Signed-out users
  // and brand-new signed-in users both see an empty grid until they save
  // something themselves — no demo cards, no prototype-preview cards, no
  // seeded notes. The wake walkthrough preview is the one exception.
  const wakeDemoCards = useMemo(
    () => (isWakePreview ? buildWakeVaultDemoCards() : []),
    [isWakePreview],
  );

  const wakePreviewUserQuickNoteCards = useMemo(
    () => (isWakePreview ? buildWakePreviewUserQuickNoteCards(wakePreviewQuickNotes) : []),
    [isWakePreview, wakePreviewQuickNotes],
  );

  // ─── Cards ───────────────────────────────────────────────────────────
  // Ref-mirrored vaultCards for handlers that fire outside React's
  // render cycle (drag-end fires from a DOM event, by which time the
  // closed-over `vaultCards` array can be stale — e.g. an upload just
  // landed, the user just deleted a card, etc.).
  const vaultCardsRef = useRef([]);

  const vaultCards = useMemo(
    () =>
      buildVaultCards({
        notes,
        ghostCards,
        wakeDemoCards,
        wakePreviewUserQuickNoteCards,
        isWakePreview,
        wakePreviewCardComments,
        wakePreviewDeletedComments,
      }),
    [notes, ghostCards, wakeDemoCards, wakePreviewUserQuickNoteCards, isWakePreview, wakePreviewCardComments, wakePreviewDeletedComments],
  );

  // Keep the ref in sync so handlers that fire from raw DOM events
  // (drag-end, etc.) can read the current grid without going through
  // a stale closure.
  useEffect(() => {
    vaultCardsRef.current = vaultCards;
  }, [vaultCards]);

  // The open preview card is page-owned: the signed-urls machinery (drive
  // markup), the drive window, the popovers, and the preview controller all
  // read it. Everything else preview-related lives in useVaultPreview.
  const [previewCard, setPreviewCard] = useState(null);

  // Signed-URL / media resolution subsystem (cache, visibility queue, poster
  // signing, artifact markup, dims backfill, tab-refocus recovery).
  const {
    resolvedAttachmentUrls,
    setResolvedAttachmentUrls,
    resolvedVideoPosterUrls,
    setResolvedVideoPosterUrls,
    driveMarkup,
    failedImageIds,
    setFailedImageIds,
    signedUrlCacheRef,
    imageRetryCountsRef,
    visibleCardIdsRef,
    urlResolveQueueRef,
    learnedImageDimsRef,
    preDecodedUrlsRef,
    cardElementsRef,
    registerCardRef,
    drainUrlResolveQueue,
    queuePersistAttachmentDims,
  } = useVaultSignedUrls({ user, vaultCards, studioSurface, previewCard, vaultWrites });

  // Feed the data hook's variant-ready callback (fires from upload events,
  // long after both hooks are mounted).
  mediaBridgeRef.current = { signedUrlCacheRef, setResolvedVideoPosterUrls };

  // Tag subsystem: directory (DB counts + fallback), filter selection, the
  // per-card tag picker popover state, tag mutations, and the AI Drive tag
  // strip.
  const {
    allTags,
    selectedFilterTags,
    setSelectedFilterTags,
    showEmbeddedTagDropdown,
    setShowEmbeddedTagDropdown,
    embeddedTagDropdownRef,
    tagPickerCardId,
    setTagPickerCardId,
    tagPickerPosition,
    setTagPickerPosition,
    newTagInput,
    setNewTagInput,
    tagPickerRef,
    toggleCardTag,
    createAndAssignTag,
    driveTags,
    handleDriveToggleTag,
  } = useVaultTags({ user, notes, setNotes, vaultCards, vaultWrites, studioSurface });

  // ─── Selection / picker ──────────────────────────────────────────────
  const {
    selectedCardIds,
    setSelectedCardIds,
    lastSelectedCardIdRef,
    isSelectableCard,
    clearSelection,
    toggleCardSelection,
    toggleNoteSelectionInPicker,
    selectRangeTo,
  } = useVaultSelection({
    isPickerMode,
    isEmbeddedMode,
    embeddedTargetOrigin,
    vaultCards,
    vaultCardsRef,
    notes,
  });

  // ─── Loading gate ────────────────────────────────────────────────────
  const { vaultReady, initialCardIdsRef, isVaultFirstPaintRef } = useVaultReadyGate({
    user,
    isLoadingNotes,
    isWakePreview,
    vaultCards,
    vaultCardsRef,
    visibleCardIdsRef,
    urlResolveQueueRef,
    drainUrlResolveQueue,
    signedUrlCacheRef,
    learnedImageDimsRef,
    preDecodedUrlsRef,
    resetLoadGateRef,
  });

  // ─── Folders / views / search ────────────────────────────────────────
  const {
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
  } = useVaultFoldersViews({
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
  });

  // Background AI descriptions for undescribed attachments.
  useVaultAiDescribeBackfill({
    user,
    isLoadingNotes,
    vaultCards,
    resolvedAttachmentUrls,
    failedImageIds,
    visibleCardIdsRef,
    vaultWrites,
    setNotes,
  });

  // Ordering/grouping of the visible cards (manual collage order, connector
  // pinning, tags/type groupings).
  const {
    orderedVisibleCards,
    wakeConnectorStripCards,
    wakeCollageCards,
    tagGroupedCards,
    typeGroupedCards,
  } = useVaultCardOrdering({ user, isWakePreview, vaultView, filteredVisibleCards });

  const collageGridCardsAll = isWakePreview ? wakeCollageCards : orderedVisibleCards;

  // Progressive reveal window for the feed views + non-feed infinite scroll.
  const { isFeedView, collageGridCards, pendingRevealCount } = useVaultReveal({
    user,
    loading,
    isWakePreview,
    vaultView,
    collageGridCardsAll,
    hasMoreNotes,
    isLoadingMoreNotes,
    loadMoreNotes,
    loadMoreRef,
    embeddedSearch,
    selectedFilterTags,
    conceptResultIds,
    resolvedAttachmentUrls,
    failedImageIds,
    visibleCardIdsRef,
    urlResolveQueueRef,
    drainUrlResolveQueue,
  });

  // Fixed-column JS masonry for the collage view.
  const { useMasonryLayout, collageColumnBuckets } = useVaultMasonry({
    isEmbeddedMode,
    isWakePreview,
    vaultView,
    collageGridCards,
  });

  const virtualizedCardStyle = undefined;

  // ─── Preview ─────────────────────────────────────────────────────────
  const {
    previewDetailsOpen,
    setPreviewDetailsOpen,
    previewShareMenuRect,
    setPreviewShareMenuRect,
    previewProjectDropdownOpen,
    setPreviewProjectDropdownOpen,
    previewCommentComposerOpen,
    setPreviewCommentComposerOpen,
    previewCommentDraft,
    setPreviewCommentDraft,
    previewEditingCommentId,
    setPreviewEditingCommentId,
    previewFullUrl,
    setPreviewFullUrl,
    previewShareMenuRef,
    previewProjectDropdownRef,
    resolveHtmlArtifactOpenUrl,
    openCardFullyInBrowser,
    chatAboutPreviewCard,
    resolvePreviewShareUrl,
    resolvePreviewShareText,
    sharePreviewNative,
    sharePreviewCopyLink,
    sharePreviewCopyText,
    sharePreviewOpenLink,
    sharePreviewDownload,
  } = useVaultPreview({
    previewCard,
    setPreviewCard,
    isEmbeddedMode,
    embeddedTargetOrigin,
    studioSurface,
    nav,
    notes,
    resolvedAttachmentUrls,
    setResolvedAttachmentUrls,
    signedUrlCacheRef,
    urlResolveQueueRef,
    drainUrlResolveQueue,
    setFailedImageIds,
  });

  // Lock body scroll while any full-screen vault overlay is up so wheel/touch
  // over the backdrop doesn't scroll the grid behind it (users otherwise close
  // the modal to find themselves at a different scroll position).
  const anyVaultOverlayOpen = !!previewCard || showSaveLink || showNewNoteChooser;
  useEffect(() => {
    if (!anyVaultOverlayOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [anyVaultOverlayOpen]);

  // Concept search behavior (local keyword pass + AI pass).
  const { handleConceptSearch } = useVaultConceptSearch({
    visibleCards,
    setConceptResultIds,
    setIsConceptSearching,
  });

  // ─── Popovers ────────────────────────────────────────────────────────
  const {
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
  } = useVaultPopovers({
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
  });

  const blockWakePreviewVaultMutation = useCallback((card) => {
    if (!isWakePreview) return false;
    if (card?.isWakePreviewNote) return false;
    setWalkthroughGateOpen(true);
    setOpenCardMenuId(null);
    return true;
  }, [isWakePreview, setOpenCardMenuId]);

  const handleRequestAddMedia = useCallback(() => {
    if (requireSignInForAction()) return;
    addMediaTriggerRef.current?.();
  }, [requireSignInForAction]);

  // ─── Mutations ───────────────────────────────────────────────────────
  // Per-card write paths (delete/undo, projects, comments, why, wake-preview
  // comment equivalents).
  const {
    isCardActionBusy,
    removeAttachmentFromNote,
    removeQuickNoteCard,
    addCardToProject,
    addAttachmentNote,
    addQuickNoteComment,
    saveCardWhy,
    addWakePreviewCardComment,
    removeAttachmentNote,
    removeQuickNoteComment,
    updateAttachmentNote,
    updateQuickNoteComment,
    updateWakePreviewCardComment,
    removeWakePreviewCardComment,
    confirmAndDeleteAttachment,
    deleteSelectedCards,
    moveCardToFolder,
  } = useVaultCardMutations({
    user,
    notes,
    setNotes,
    vaultWrites,
    vaultQueryClient,
    projects,
    invalidateVaultProjects,
    selectedCardIds,
    vaultCardsRef,
    isSelectableCard,
    clearSelection,
    pendingDeleteCardIds,
    setPendingDeleteCardIds,
    pendingDeleteTimersRef,
    TRASH_UNDO_GRACE_MS,
    setOpenCardMenuId,
    setPreviewProjectDropdownOpen,
    setWakePreviewCardComments,
    setWakePreviewDeletedComments,
  });

  // Keyboard support: Esc clears selection, Delete/Backspace deletes it.
  // Skip when the user is typing in an input/textarea/contentEditable so we
  // don't intercept normal text editing.
  useEffect(() => {
    if (selectedCardIds.size === 0) return;
    const onKey = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      const editable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (t && t.isContentEditable);
      if (e.key === "Escape") {
        if (editable) return;
        clearSelection();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (editable) return;
        e.preventDefault();
        deleteSelectedCards();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardIds, clearSelection, deleteSelectedCards]);

  // ─── Drag / trash ────────────────────────────────────────────────────
  const {
    draggedCardId,
    dropTargetCardId,
    vaultTrashHover,
    vaultTrashHoldReady,
    vaultTrashRef,
    handleCardDragStart,
    chatChunkDragOver,
    handleMainDragEnter,
    handleMainDragOver,
    handleMainDragLeave,
    handleMainDrop,
  } = useVaultDragTrash({
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
  });

  // ─── Pick delivery / embedded add ────────────────────────────────────
  const buildEmbeddedPayloadForCard = useCallback(
    (card) => buildEmbeddedVaultPayload(card, resolvedAttachmentUrls),
    [resolvedAttachmentUrls],
  );

  /**
   * Confirm a pick, and send it wherever it was asked for. A project wants the
   * rows themselves, so it gets ids; the chat surfaces want something they can
   * attach, so they get the payload a drag onto the bar would have carried.
   * The desktop bar is the one that has to be brought forward first — the other
   * two are already looking at the thing that asked.
   */
  const addSelectedVaultToChat = useCallback(() => {
    const byId = new Map((vaultCardsRef.current || []).map((card) => [card.id, card]));
    const cards = [...selectedCardIds].map((id) => byId.get(id)).filter(Boolean);
    if (!cards.length) {
      toast({ title: "Select something", description: "Click an item, then Add." });
      return;
    }

    if (activePickTarget === "project") {
      const noteIds = [...new Set(cards.map((card) => String(card.noteId || "")).filter(Boolean))];
      if (!noteIds.length) {
        toast({ title: "Couldn't add", description: "This item can't be added to a project." });
        return;
      }
      deliverVaultPick(VAULT_PICK_PROJECT_EVENT, { noteIds });
    } else {
      const payloads = cards.map(buildEmbeddedPayloadForCard).filter(Boolean);
      if (!payloads.length) {
        toast({ title: "Couldn't add", description: "This item can't be added to chat." });
        return;
      }
      for (const payload of payloads) {
        if (activePickTarget === "thread") {
          deliverVaultPick(VAULT_PICK_ITEMS_EVENT, payload);
        } else {
          window.dispatchEvent(
            new CustomEvent("lykn-studio-open-chat", {
              detail: {
                src: `/app?vault=${Date.now()}`,
                dismissApp: "vault",
                forceHome: true,
                vaultPayload: payload,
              },
            }),
          );
        }
      }
    }

    setPreviewCard(null);
    clearSelection();
    // The home bar's route dismisses the window itself as it brings the
    // desktop forward; the others have to be sent away here.
    if (activePickTarget === "home") {
      try {
        sessionStorage.removeItem("lykn_vault_pick_for_chat");
      } catch {
        /* the pick param goes with the window */
      }
    } else {
      closeVaultPicker();
    }
  }, [selectedCardIds, buildEmbeddedPayloadForCard, clearSelection, activePickTarget]);

  const cancelVaultChatPick = useCallback(() => {
    setPreviewCard(null);
    clearSelection();
    closeVaultPicker();
  }, [clearSelection]);

  // ─── Card press: selection gestures → embedded add → preview ────────
  // Open a full-size preview/view window when a card is clicked. Interactive
  // elements (buttons, links, form fields, media controls, menus) opt-out
  // either via stopPropagation or by being covered in this selector.
  const handleCardPress = useCallback((e, card) => {
    if (!card) return;
    if (draggedCardId) return;
    // Connector folder tiles aren't previewable — they're a navigation
    // affordance into a per-connector subview of the grid.
    if (card.kind === "source-folder") {
      closeAllVaultPopovers();
      setPreviewCard(null);
      setOpenSourceFolder(card.source);
      return;
    }
    // Ghost cards (still-uploading previews) behave exactly like a normal
    // card in the grid: the user can click to open the preview / view
    // mode and watch the video. DB-bound actions (tag / delete / notes)
    // simply no-op until the real note lands, at which point this card is
    // swapped for the DB-backed one transparently.
    const target = e?.target;
    if (isPickerMode) {
      if (!isSelectableCard(card)) return;
      e?.preventDefault?.();
      e?.stopPropagation?.();
      closeAllVaultPopovers();
      setPreviewCard(null);
      const shift = !!e?.shiftKey;
      const toggle = !!(e?.metaKey || e?.ctrlKey);
      if (shift) selectRangeTo(card);
      else if (toggle) toggleCardSelection(card);
      else toggleNoteSelectionInPicker(card);
      return;
    }

    if (target && typeof target.closest === "function") {
      const blocked = target.closest(
        'button, a, input, textarea, select, iframe, video, audio, [data-no-drag="true"], [data-no-preview="true"]'
      );
      if (blocked) {
        // PDF / HTML grid tiles embed a preview iframe (pointer-events often
        // none) — allow click-to-expand. Keep YouTube iframes interactive.
        const isPreviewTileIframe =
          card.kind === "attachment" &&
          (card.type === "pdf" || card.type === "html") &&
          blocked.tagName === "IFRAME";
        if (!isPreviewTileIframe) return;
      }
    }

    // Multi-select gestures take precedence over preview. Shift extends a
    // range from the last clicked anchor; Cmd/Ctrl/Meta toggles a single
    // card in/out of the selection. Anything else falls through to the
    // normal preview behavior, and a plain click also clears any existing
    // selection (Finder-style — "click somewhere else = deselect").
    const shift = !!e?.shiftKey;
    const toggle = !!(e?.metaKey || e?.ctrlKey);
    if ((shift || toggle) && isSelectableCard(card)) {
      e?.preventDefault?.();
      closeAllVaultPopovers();
      setPreviewCard(null);
      if (shift) selectRangeTo(card);
      else toggleCardSelection(card);
      return;
    }
    if (selectedCardIds.size > 0) clearSelection();

    closeAllVaultPopovers();

    // Embedded (non-picker) = the Omnia chat "Pull from vault" sidebar. A
    // plain click should ADD the item to the chat (same logic as drag), not
    // open the full-size preview/view mode.
    if (isEmbeddedMode && !isPickerMode) {
      const payload = buildEmbeddedPayloadForCard(card);
      if (payload) {
        try {
          window.parent.postMessage({ type: "lykn-chat-vault-add", data: payload }, embeddedTargetOrigin);
        } catch {
          /* ignore */
        }
        setAddedCardIds((prev) => {
          const next = new Set(prev);
          next.add(card.id);
          return next;
        });
        return;
      }
    }

    // Every card type opens the same in-app view mode. Expand (in the
    // preview header) is what opens the full item in a separate window —
    // including HTML artifacts (via the branded file proxy).
    if (card.kind === "attachment") {
      const attType = resolveAttachmentType(card.attachment || {}) || card.type;
      if (attType === "html") {
        void resolveHtmlArtifactOpenUrl(card);
      }
    }

    setPreviewCard(card);
  }, [
    draggedCardId,
    isPickerMode,
    isEmbeddedMode,
    embeddedTargetOrigin,
    buildEmbeddedPayloadForCard,
    isSelectableCard,
    selectRangeTo,
    toggleCardSelection,
    toggleNoteSelectionInPicker,
    selectedCardIds,
    clearSelection,
    resolveHtmlArtifactOpenUrl,
    closeAllVaultPopovers,
    setOpenSourceFolder,
  ]);

  // ─── AI Drive window (Studio surface) ────────────────────────────────
  const {
    driveEntries,
    driveFolder,
    handleDriveSelect,
    handleDriveEnterFolder,
    handleDriveExitFolder,
    handleDriveOpen,
    handleDriveMenu,
    handleDriveSelectAll,
    handleDriveClearSearch,
  } = useVaultDriveWindow({
    studioSurface,
    location,
    nav,
    notes,
    vaultCards,
    vaultCardsRef,
    orderedVisibleCards,
    resolvedAttachmentUrls,
    resolvedVideoPosterUrls,
    driveMarkup,
    signedUrlCacheRef,
    resolveHtmlArtifactOpenUrl,
    isSelectableCard,
    clearSelection,
    closeAllVaultPopovers,
    lastSelectedCardIdRef,
    setSelectedCardIds,
    toggleCardSelection,
    openDriveFolder,
    setOpenDriveFolder,
    isChatPickMode,
    projectsRef,
    addCardToProject,
    moveCardToFolder,
    setPreviewDetailsOpen,
    setPreviewCard,
    isLoadingNotes,
    hasMoreNotes,
    loadMoreNotes,
    openCardMenuForAnchor,
    setEmbeddedSearch,
    setVaultSearch,
    setConceptResultIds,
  });

  // Card renderers: rebuilt each render from the page's current state, same
  // closure semantics as when they were defined inline. See
  // vaultCardRenderers.jsx for why these are factories.
  const renderAttachmentCard = createRenderAttachmentCard({
    drainUrlResolveQueue,
    failedImageIds,
    imageRetryCountsRef,
    isEmbeddedMode,
    isMountedRef,
    isPickerMode,
    isVaultFirstPaintRef,
    isWakePreview,
    learnedImageDimsRef,
    preDecodedUrlsRef,
    queuePersistAttachmentDims,
    resolvedAttachmentUrls,
    resolvedVideoPosterUrls,
    setFailedImageIds,
    setResolvedAttachmentUrls,
    signedUrlCacheRef,
    urlResolveQueueRef,
    visibleCardIdsRef,
  });

  const renderCollageCard = createRenderCollageCard({
    addedCardIds,
    closeAttachmentNotes,
    draggedCardId,
    dropTargetCardId,
    handleCardDragStart,
    handleCardPress,
    initialCardIdsRef,
    isEmbeddedMode,
    isPickerMode,
    isSelectableCard,
    isVaultFirstPaintRef,
    isWakePreview,
    openAttachmentNotesCardId,
    openAttachmentNotesForAnchor,
    openCardMenuForAnchor,
    registerCardRef,
    renderAttachmentCard,
    selectedCardIds,
    vaultView,
    virtualizedCardStyle,
  });


  if ((loading || isLoadingNotes || !vaultReady) && user && !isWakePreview) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div
      ref={vaultPreviewRootRef}
      className={`${
        isWakePreview || studioSurface ? "lykn-vault-boxed h-full min-h-0" : "min-h-screen"
      } ${
        isWakePreview ? "lykn-wake-vault-live-preview" : ""
      } bg-transparent text-black dark:text-white relative overflow-x-hidden`}
    >
      {!isWakePreview && (
      <DragDropFileUpload
        triggerRef={addMediaTriggerRef}
        beforeUpload={checkVaultLimit}
        refreshVaultCount={refreshVaultCount}
        onNoteCreated={incrementVaultCount}
        onRequireSignIn={() => setShowSignInBlocker(true)}
        onFileComplete={(note) => {
          if (note?.id) mergeUploadedNotes([note]);
        }}
        onVariantsReady={handleVariantsReady}
        onUploadComplete={(payload) => {
          const createdNotes = Array.isArray(payload?.createdNotes) ? payload.createdNotes : [];
          if (createdNotes.length > 0) {
            mergeUploadedNotes(createdNotes);
            return;
          }
          void refreshNotes();
        }}
      />
      )}

      {!isEmbeddedMode && (
        <>
          {!isWakePreview && (
          <>
          {/* Bottom-right FAB: voice or written note chooser. Not in AI Drive
              — `fixed` anchors to the viewport, so inside the file-manager
              window it would float over the whole Studio instead of the pane
              it belongs to. */}
          {!studioSurface && (
          <button
            type="button"
            onClick={handleToggleQuickNote}
            title={showQuickNote ? "Hide quick note" : "New note"}
            aria-label={showQuickNote ? "Hide quick note" : "New note"}
            className={`fixed right-6 z-[70] w-12 h-12 rounded-full border shadow-lg flex items-center justify-center transition touch-manipulation ${
              showQuickNote || showNewNoteChooser
                ? "bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/25 dark:bg-blue-400/20 dark:text-blue-400 dark:hover:bg-blue-400/30"
                : "border-black/[0.08] bg-panel text-black/80 hover:brightness-95 dark:border-white/[0.08] dark:text-white/90 dark:hover:brightness-125"
            }`}
            // Clear the mobile tab bar — without this the tab bar (z-[75])
            // paints over most of the FAB on phones, making it untappable.
            style={{ bottom: "calc(1.5rem + var(--mobile-tabbar-clear, 0px))" }}
          >
            <Plus className="w-5 h-5" />
          </button>
          )}

          {/* Bottom-center app dock lives one level up in
              VaultConnectionsShell so a single instance renders across
              both /vault and /connections — keeps the launcher visible
              while the user is browsing the apps grid and avoids two
              parallel polling loops fetching the same connection list. */}
          </>
          )}
        </>
      )}

      {/*
        In the Studio the same items are listed as a folder instead of laid out
        as a collage, so the window doesn't change its mind about what a file
        looks like between AI Drive and the Mac's own folders. That surface
        brings its own toolbar and status bar and owns the pane's full height,
        so it stands in for the page shell rather than sitting inside it.
      */}
      {studioSurface ? (
        <DriveListing
          entries={driveEntries}
          loading={isLoadingNotes || isLoadingMoreNotes}
          folder={driveFolder}
          onExitFolder={handleDriveExitFolder}
          onEnterFolder={handleDriveEnterFolder}
          query={embeddedSearch}
          onQueryChange={setEmbeddedSearch}
          onQuerySubmit={handleConceptSearch}
          searching={isConceptSearching}
          onClearSearch={handleDriveClearSearch}
          tags={driveTags}
          selectedTags={selectedFilterTags}
          onToggleTag={handleDriveToggleTag}
          onClearTags={() => setSelectedFilterTags([])}
          selectedIds={selectedCardIds}
          onSelect={handleDriveSelect}
          onOpen={handleDriveOpen}
          onMenu={handleDriveMenu}
          onClearSelection={clearSelection}
          onSelectAll={handleDriveSelectAll}
          onRefresh={refreshNotes}
          registerRef={registerCardRef}
          hasMore={hasMoreNotes}
          onLoadMore={loadMoreNotes}
          error={notesError}
          pickMode={isChatPickMode}
          onPickAdd={addSelectedVaultToChat}
          onPickCancel={cancelVaultChatPick}
        />
      ) : (
      /*
        Three layouts, and only two of them scroll the page itself. Standalone
        grows with its content and lets the document scroll. The wake preview
        and the Studio window are both boxed to their host's height by the
        root's `.lykn-wake-vault-live-preview`, which is `overflow: hidden` —
        so whichever one is active, this element has to own the scrolling or
        the grid simply gets cut off at the bottom of the frame.
      */
      <main
        className={`vault-preview-shell relative z-20 mx-auto w-full ${
          isWakePreview
            ? "h-full overflow-y-auto px-4 sm:px-6 pt-4 pb-12 scrollbar-hide"
            : `px-4 sm:px-6 lg:px-8 ${isEmbeddedMode ? "pt-6" : "pt-16"} pb-16`
        }`}
        style={{
          transform: "translateZ(0)",
          maxWidth: isWakePreview ? "100%" : "1560px",
        }}
        onDragEnter={handleMainDragEnter}
        onDragOver={handleMainDragOver}
        onDragLeave={handleMainDragLeave}
        onDrop={handleMainDrop}
      >
        {chatChunkDragOver && (
          <div className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center">
            <div className="absolute inset-0 bg-blue-500/5 border-2 border-dashed border-blue-400/40 rounded-3xl m-4" />
            <div className="relative bg-white/65 backdrop-blur-sm rounded-2xl px-6 py-4 shadow-md border border-blue-300/30 flex items-center gap-3">
              <StickyNote className="w-5 h-5 text-amber-500" />
              <span className="text-sm font-medium text-black/70 dark:text-white/70">Drop to save as Quick Note</span>
            </div>
          </div>
        )}
        <VaultToolbar
          allTags={allTags}
          conceptResultIds={conceptResultIds}
          embeddedSearch={embeddedSearch}
          embeddedTagDropdownRef={embeddedTagDropdownRef}
          handleConceptSearch={handleConceptSearch}
          isConceptSearching={isConceptSearching}
          isEmbeddedMode={isEmbeddedMode}
          isWakePreview={isWakePreview}
          nav={nav}
          onWakePreviewTabChange={onWakePreviewTabChange}
          selectedFilterTags={selectedFilterTags}
          setConceptResultIds={setConceptResultIds}
          setEmbeddedSearch={setEmbeddedSearch}
          setSelectedFilterTags={setSelectedFilterTags}
          setShowEmbeddedTagDropdown={setShowEmbeddedTagDropdown}
          setShowVaultViewDropdown={setShowVaultViewDropdown}
          setVaultSearch={setVaultSearch}
          setVaultView={setVaultView}
          showEmbeddedTagDropdown={showEmbeddedTagDropdown}
          showVaultViewDropdown={showVaultViewDropdown}
          studioSurface={studioSurface}
          vaultSearch={vaultSearch}
          vaultView={vaultView}
          vaultViewDropdownRef={vaultViewDropdownRef}
          visibleCards={visibleCards}
        />

        {notesError && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-red-600">{notesError}</p>
          </div>
        )}

        {(isWakePreview || (!loading && !isLoadingNotes && (vaultReady || !user))) && !notesError && (
          <VaultGrid
            collageColumnBuckets={collageColumnBuckets}
            collageGridCards={collageGridCards}
            embeddedSearch={embeddedSearch}
            handleCardDragStart={handleCardDragStart}
            handleCardPress={handleCardPress}
            handleRequestAddMedia={handleRequestAddMedia}
            handleRequestSaveLink={handleRequestSaveLink}
            initialCardIdsRef={initialCardIdsRef}
            isEmbeddedMode={isEmbeddedMode}
            isFeedView={isFeedView}
            isLoadingMoreNotes={isLoadingMoreNotes}
            isVaultFirstPaintRef={isVaultFirstPaintRef}
            isWakePreview={isWakePreview}
            loadMoreRef={loadMoreRef}
            openCardMenuForAnchor={openCardMenuForAnchor}
            openFolderConnector={openFolderConnector}
            openSourceFolder={openSourceFolder}
            orderedVisibleCards={orderedVisibleCards}
            pendingRevealCount={pendingRevealCount}
            registerCardRef={registerCardRef}
            renderAttachmentCard={renderAttachmentCard}
            renderCollageCard={renderCollageCard}
            selectedCardIds={selectedCardIds}
            selectedFilterTags={selectedFilterTags}
            setOpenSourceFolder={setOpenSourceFolder}
            tagGroupedCards={tagGroupedCards}
            typeGroupedCards={typeGroupedCards}
            useMasonryLayout={useMasonryLayout}
            vaultView={vaultView}
            virtualizedCardStyle={virtualizedCardStyle}
            wakeConnectorStripCards={wakeConnectorStripCards}
          />
        )}
      </main>
      )}

      {isWakePreview && (
        <button
          type="button"
          onClick={handleToggleQuickNote}
          title="New quick note"
          aria-label="New quick note"
          className="absolute bottom-4 right-4 z-[200] w-12 h-12 aspect-square shrink-0 rounded-full border border-white/[0.14] bg-white/[0.06] text-white/90 backdrop-blur shadow-lg flex items-center justify-center transition-colors touch-manipulation hover:bg-white/[0.12] hover:border-white/25"
        >
          <Plus className="w-5 h-5" />
        </button>
      )}

      <VaultNewNoteChooser
        open={showNewNoteChooser}
        userId={user?.id}
        onClose={() => setShowNewNoteChooser(false)}
        onChooseWritten={handleChooseWrittenNote}
        onRequireSignIn={() => setShowSignInBlocker(true)}
        beforeSave={checkVaultLimit}
        onNoteSaved={(note) => {
          if (note?.id) {
            mergeUploadedNotes([note]);
            incrementVaultCount();
          }
          toast({
            title: "Voice note saved",
            description: String(note?.title || "Added to your Vault."),
            action: note?.id ? (
              <ToastAction altText="Open note" onClick={() => nav(`/vault?note=${encodeURIComponent(String(note.id))}`)}>
                Open
              </ToastAction>
            ) : undefined,
          });
        }}
        onError={(message) => {
          if (!notifyVaultCapIfApplicable({ message })) {
            toast({
              title: "Voice note failed",
              description: message,
              variant: "destructive",
            });
          }
        }}
      />

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => {
            void handleCloseQuickNote();
          }}
          onDiscard={handleDiscardQuickNote}
          contained={isWakePreview}
          voiceEnabled={!isWakePreview}
          onVoiceError={(message) => {
            toast({
              title: "Dictation failed",
              description: message,
              variant: "destructive",
            });
          }}
        />
      )}


      <AddLinkDialog
        open={showSaveLink}
        onClose={() => setShowSaveLink(false)}
        confirming={isSaveLinkSaving}
        onConfirm={handleSaveLink}
      />

      <VaultCardPopovers
        addAttachmentNote={addAttachmentNote}
        addCardToProject={addCardToProject}
        addQuickNoteComment={addQuickNoteComment}
        addWakePreviewCardComment={addWakePreviewCardComment}
        allTags={allTags}
        attachmentNoteDraft={attachmentNoteDraft}
        blockWakePreviewVaultMutation={blockWakePreviewVaultMutation}
        cardMenuRef={cardMenuRef}
        closeAttachmentNotes={closeAttachmentNotes}
        confirmAndDeleteAttachment={confirmAndDeleteAttachment}
        createAndAssignTag={createAndAssignTag}
        isCardActionBusy={isCardActionBusy}
        isWakePreview={isWakePreview}
        newTagInput={newTagInput}
        noteComposerRef={noteComposerRef}
        openAttachmentNotesCardId={openAttachmentNotesCardId}
        openAttachmentNotesForAnchor={openAttachmentNotesForAnchor}
        openAttachmentNotesRect={openAttachmentNotesRect}
        openCardMenuId={openCardMenuId}
        openCardMenuPlacement={openCardMenuPlacement}
        openCardMenuRect={openCardMenuRect}
        orderedVisibleCards={orderedVisibleCards}
        previewCard={previewCard}
        projects={projects}
        removeAttachmentNote={removeAttachmentNote}
        removeQuickNoteCard={removeQuickNoteCard}
        removeQuickNoteComment={removeQuickNoteComment}
        removeWakePreviewCardComment={removeWakePreviewCardComment}
        setAttachmentNoteDraft={setAttachmentNoteDraft}
        setNewTagInput={setNewTagInput}
        setOpenAttachmentNotesCardId={setOpenAttachmentNotesCardId}
        setOpenAttachmentNotesRect={setOpenAttachmentNotesRect}
        setOpenCardMenuId={setOpenCardMenuId}
        setTagPickerCardId={setTagPickerCardId}
        setTagPickerPosition={setTagPickerPosition}
        setWakePreviewQuickNotes={setWakePreviewQuickNotes}
        tagPickerCardId={tagPickerCardId}
        tagPickerPosition={tagPickerPosition}
        tagPickerRef={tagPickerRef}
        toggleCardTag={toggleCardTag}
        trapPopoverWheel={trapPopoverWheel}
        vaultCards={vaultCards}
        vaultPreviewRootRef={vaultPreviewRootRef}
      />
      {previewCard && (
        <VaultPreviewOverlay
          addAttachmentNote={addAttachmentNote}
          addCardToProject={addCardToProject}
          addQuickNoteComment={addQuickNoteComment}
          addWakePreviewCardComment={addWakePreviewCardComment}
          blockWakePreviewVaultMutation={blockWakePreviewVaultMutation}
          chatAboutPreviewCard={chatAboutPreviewCard}
          confirmAndDeleteAttachment={confirmAndDeleteAttachment}
          drainUrlResolveQueue={drainUrlResolveQueue}
          driveMarkup={driveMarkup}
          failedImageIds={failedImageIds}
          imageRetryCountsRef={imageRetryCountsRef}
          isCardActionBusy={isCardActionBusy}
          isWakePreview={isWakePreview}
          notes={notes}
          openCardFullyInBrowser={openCardFullyInBrowser}
          previewCard={previewCard}
          previewCommentComposerOpen={previewCommentComposerOpen}
          previewCommentDraft={previewCommentDraft}
          previewDetailsOpen={previewDetailsOpen}
          previewEditingCommentId={previewEditingCommentId}
          previewFullUrl={previewFullUrl}
          previewProjectDropdownOpen={previewProjectDropdownOpen}
          previewProjectDropdownRef={previewProjectDropdownRef}
          previewShareMenuRect={previewShareMenuRect}
          projects={projects}
          removeAttachmentNote={removeAttachmentNote}
          removeQuickNoteCard={removeQuickNoteCard}
          removeQuickNoteComment={removeQuickNoteComment}
          removeWakePreviewCardComment={removeWakePreviewCardComment}
          resolvePreviewShareText={resolvePreviewShareText}
          resolvePreviewShareUrl={resolvePreviewShareUrl}
          resolvedAttachmentUrls={resolvedAttachmentUrls}
          saveCardWhy={saveCardWhy}
          setFailedImageIds={setFailedImageIds}
          setOpenCardMenuId={setOpenCardMenuId}
          setOpenCardMenuRect={setOpenCardMenuRect}
          setPreviewCard={setPreviewCard}
          setPreviewCommentComposerOpen={setPreviewCommentComposerOpen}
          setPreviewCommentDraft={setPreviewCommentDraft}
          setPreviewDetailsOpen={setPreviewDetailsOpen}
          setPreviewEditingCommentId={setPreviewEditingCommentId}
          setPreviewFullUrl={setPreviewFullUrl}
          setPreviewProjectDropdownOpen={setPreviewProjectDropdownOpen}
          setPreviewShareMenuRect={setPreviewShareMenuRect}
          setResolvedAttachmentUrls={setResolvedAttachmentUrls}
          setTagPickerCardId={setTagPickerCardId}
          setTagPickerPosition={setTagPickerPosition}
          setWakePreviewQuickNotes={setWakePreviewQuickNotes}
          signedUrlCacheRef={signedUrlCacheRef}
          updateAttachmentNote={updateAttachmentNote}
          updateQuickNoteComment={updateQuickNoteComment}
          updateWakePreviewCardComment={updateWakePreviewCardComment}
          urlResolveQueueRef={urlResolveQueueRef}
          vaultCards={vaultCards}
          visibleCardIdsRef={visibleCardIdsRef}
        />
      )}
      {previewShareMenuRect && previewCard && (
        <VaultPreviewShareMenu
          previewCard={previewCard}
          previewFullUrl={previewFullUrl}
          previewShareMenuRect={previewShareMenuRect}
          previewShareMenuRef={previewShareMenuRef}
          resolvePreviewShareText={resolvePreviewShareText}
          resolvePreviewShareUrl={resolvePreviewShareUrl}
          resolvedAttachmentUrls={resolvedAttachmentUrls}
          sharePreviewCopyLink={sharePreviewCopyLink}
          sharePreviewCopyText={sharePreviewCopyText}
          sharePreviewDownload={sharePreviewDownload}
          sharePreviewNative={sharePreviewNative}
          sharePreviewOpenLink={sharePreviewOpenLink}
          vaultCards={vaultCards}
        />
      )}
      {/* Drag-to-delete trash can — desktop only. On phones the bottom-left
          corner conflicts with the mobile tab bar and the drag-and-hold
          gesture isn't usable on touch, so the affordance is hidden. */}
      {!isEmbeddedMode && !isWakePreview && !studioSurface && !isMobileChat && !sidebarOpen && createPortal(
        <div
          className="fixed z-[200] flex items-end gap-2"
          style={{
            bottom: "calc(1rem + var(--mobile-tabbar-clear, 0px))",
            left: "calc(var(--sidebar-width, 0px) + 1rem)",
            pointerEvents: "none",
          }}
        >
          <div
            ref={vaultTrashRef}
            className={`flex items-center justify-center rounded-full transition-all duration-150 ${
              vaultTrashHoldReady
                ? "p-2.5"
                : draggedCardId
                  ? vaultTrashHover
                    ? "p-2.5 bg-red-500/15 ring-2 ring-red-400/40"
                    : "p-2 bg-black/5 dark:bg-white/10"
                  : "p-1.5"
            }`}
            title={
              vaultTrashHoldReady
                ? "Release to delete"
                : vaultTrashHover
                  ? "Hold for 1s to delete"
                  : "Drag a card here and hold to delete"
            }
          >
            <span className={vaultTrashHoldReady ? "lykn-chat-canvas-trash-ready-shake" : undefined}>
              <Trash2 className={`transition-all duration-150 ${
                vaultTrashHoldReady
                  ? "w-6 h-6 text-red-600 dark:text-red-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.65)]"
                  : vaultTrashHover
                    ? "w-5 h-5 text-red-500 dark:text-red-400 drop-shadow-[0_0_6px_rgba(239,68,68,0.5)]"
                    : draggedCardId
                      ? "w-5 h-5 text-black/55 dark:text-white/60"
                      : "w-4 h-4 text-black/35 dark:text-white/35"
              }`} />
            </span>
          </div>
        </div>,
        document.body
      )}
      {/* Multi-select action bar — appears any time at least one card is
          selected via shift/cmd-click. Centered on desktop, sits above the
          mobile tab bar on phones. Esc and Delete/Backspace also work as
          keyboard shortcuts (see the keydown effect alongside
          `deleteSelectedCards`). Not in AI Drive: it's `fixed`, so in the
          file-manager window it would float over the whole Studio, and the
          listing's status bar already reports the count. */}
      {selectedCardIds.size > 0 && !isPickerMode && !studioSurface && createPortal(
        <div
          // 6rem on desktop clears the bottom-center app dock so the two
          // don't pile up; phones sit just above the mobile tab bar.
          className="fixed z-[210] left-1/2 -translate-x-1/2 flex items-center"
          style={{
            bottom: isMobileChat
              ? "calc(1.5rem + var(--mobile-tabbar-clear, 0px))"
              : "6rem",
          }}
        >
          <div className="flex items-center gap-2 rounded-full bg-black/85 dark:bg-white/10 backdrop-blur-md text-white shadow-lg ring-1 ring-white/10 px-3 py-1.5">
            <span className="text-xs font-medium px-1.5">
              {selectedCardIds.size} selected
            </span>
            <button
              type="button"
              onClick={deleteSelectedCards}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-500/90 hover:bg-red-500 text-white text-xs font-medium px-3 py-1 transition-colors"
              title="Delete selected (Delete)"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center rounded-full text-white/80 hover:text-white text-xs font-medium px-2 py-1 transition-colors"
              title="Clear selection (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>,
        document.body
      )}
      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />
      {!isWakePreview && (
        <SignInActionBlocker
          open={showSignInBlocker}
          onClose={() => setShowSignInBlocker(false)}
        />
      )}
      {isWakePreview && walkthroughGateOpen && (
        <div
          className="lykn-wake-synth-gate-backdrop"
          role="presentation"
          onClick={() => setWalkthroughGateOpen(false)}
        >
          <div
            className="lykn-wake-synth-gate-card"
            role="alertdialog"
            aria-label="Walkthrough required"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="lykn-wake-synth-gate-text">{WAKE_WALKTHROUGH_GATE_TEXT}</p>
          </div>
        </div>
      )}
    </div>
  );
}
