import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Plus,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  createVaultWrites,
  getVaultRepository,
} from "@/lib/vault/repository";
import {
  isAiGeneratedVaultRow,
} from "@/lib/vault/aiDriveContents";
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
import { DRIVE_FOLDERS, useVaultDriveWindow } from "@/hooks/useVaultDriveWindow";
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
import {
  SIGNED_URL_TTL_SECONDS,
  readCachedSignedUrl,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";
import { listUserProjects } from "@/lib/userProjects";
import { emitProjectsChanged } from "@/lib/synthesis/projectLiveSync";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import VaultNewNoteChooser from "@/components/vault/VaultNewNoteChooser";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { safeExternalUrl, safeAttachmentUrl } from "@/lib/safeExternalUrl";
import { useVaultUploadStore } from "@/store/vaultUploadStore";
import { useUsageGate } from "@/lib/useUsageGate";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import {
  VAULT_PICKER_CHANGE,
  VAULT_PICKER_SET_SELECTION,
} from "@/lib/vault/vaultPickerProtocol";
import {
  findAttachmentsMarker,
  parseAttachmentsFromNote,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import UpgradeModal from "@/components/UpgradeModal";
import SignInActionBlocker from "@/components/SignInActionBlocker";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { looksLikeImageAttachment, resolveRenderType } from "@/lib/vault/attachmentType";
import {
  buildSpacedExcerpt,
  buildTextExcerpt,
  driveFolderIdFor,
  extractChatPreview,
  extractYouTubeLinks,
  formatDate,
  parseQuickNoteComments,
  parseStorageTarget,
  resolveTextNoteStyle,
  sanitizeCardTitle,
  stripAttachmentJsonMarker,
  textNoteLabel,
  withAttachmentJsonMarker,
} from "@/lib/vault/vaultCardHelpers";
import LoadingScreen from "@/components/LoadingScreen";
import AddLinkDialog from "@/components/AddLinkDialog";
import DriveListing from "@/components/macfiles/DriveListing";
import { buildWakeVaultDemoCards } from "@/lib/wake/wakeVaultDemoCards";
import { WAKE_WALKTHROUGH_GATE_TEXT } from "@/components/wake/wakeSynthesisAddMenu";
import {
  buildWakePreviewUserQuickNoteCards,
  readWakeVaultPreviewQuickNotes,
} from "@/lib/wake/wakeVaultPreviewQuickNotes";
import {
  applyWakePreviewCommentsToCard,
  readWakeVaultPreviewComments,
  readWakeVaultPreviewDeletedComments,
} from "@/lib/wake/wakeVaultPreviewComments";
import { CONNECTORS } from "@/lib/connectors/catalog";
// Tracks whether the vault has completed its initial image-preload gating at
// least once during this SPA session. Persists across route remounts so
// navigating away from /vault and back does not re-show the LoadingScreen
// while the browser's image cache is already warm.
let sessionVaultReady = false;

// Connector-sourced notes (Notion pages, Gmail stars, Slack saves, …)
// land in the vault as one note per item. Without grouping, a freshly-
// synced Gmail or Notion workspace floods the grid with dozens of nearly
// identical cards before the user sees their own work, so we collapse
// every per-connector batch into a single app-style tile labelled with
// the connector name + item count. Tapping the tile drills into a
// folder-view of just that connector's items (`openSourceFolder`).
//
// The map below keys on the `source` column each adapter writes to the
// notes table (see e.g. connectors/notion.js → 'notion_page',
// connectors/gmail.js → 'gmail_starred') and points at the connector id
// in `src/lib/connectors/catalog.js`. Display fields (name, domain,
// favicon) are then derived from that single catalog at runtime, so
// adding a new collapsable connector is one line here once the adapter
// is writing a stable `source` value.
//
// Multiple sources can fold into the same connector tile when one
// platform exposes more than one ingest stream — Reddit saves both
// posts and comments, Mastodon both favourites and bookmarks. They all
// roll up under their parent app.
const SOURCE_TO_CONNECTOR_ID = {
  notion_page: "notion",
  gmail_starred: "gmail",
  gmail_inbox: "gmail",
  outlook_flagged: "outlook-365",
  gdrive_starred: "google-drive",
  gdocs_starred: "google-docs",
  gsheets_starred: "google-sheets",
  gslides_starred: "google-drive",
  gcal_event: "google-calendar",
  youtube_liked: "youtube",
  slack_saved: "slack",
  github_starred: "github",
  linear_issue: "linear",
  todoist_task: "todoist",
  trello_card: "trello",
  canva_design: "canva",
  vimeo_liked: "vimeo",
  dribbble_liked: "dribbble",
  readwise: "readwise",
  raindrop_bookmark: "raindrop",
  spotify_liked: "spotify",
  pinterest_pin: "pinterest",
  x_bookmark: "x",
  bluesky_like: "bluesky",
  reddit_saved_post: "reddit",
  reddit_saved_comment: "reddit",
  mastodon_favourite: "mastodon",
  mastodon_bookmark: "mastodon",
};


const isAiGeneratedNote = isAiGeneratedVaultRow;


// Resolve a note's `source` value to the display config used by the
// folder tile. Caches lookups so the per-card visibleCards loop doesn't
// pay a CONNECTORS.find() cost on every render.
const sourceFolderCache = new Map();
function resolveSourceFolder(source) {
  if (!source) return null;
  if (sourceFolderCache.has(source)) return sourceFolderCache.get(source);
  const connectorId = SOURCE_TO_CONNECTOR_ID[source];
  if (!connectorId) {
    sourceFolderCache.set(source, null);
    return null;
  }
  const connector = CONNECTORS.find((c) => c.id === connectorId);
  if (!connector) {
    sourceFolderCache.set(source, null);
    return null;
  }
  const cfg = {
    connectorId,
    name: connector.name,
    domain: connector.domain || "",
    // Prefer the catalog's explicit `iconUrl` (Google's per-product
    // brand assets, etc.) so e.g. Sheets renders the green spreadsheet
    // glyph instead of a generic Google "G". Fall back to S2 favicons —
    // same resolver path the connections-page DockFavicon uses — for
    // connectors that don't ship a custom icon.
    favicon:
      connector.iconUrl ||
      (connector.domain
        ? `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(connector.domain)}`
        : ""),
  };
  sourceFolderCache.set(source, cfg);
  return cfg;
}

// Legacy granular render type, now centralized in attachmentType.ts so the
// Vault, AI-context builder, and renderers all classify identically.
const resolveAttachmentType = resolveRenderType;


/**
 * Keep wheel/trackpad gestures inside a floating vault popover from scrolling
 * the page behind it. Without this, hovering a non-scroll region (or
 * overscrolling past the list end) scrolls the grid and the scroll-dismiss
 * handler closes the menu.
 */
function trapPopoverWheel(event) {
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
  const [embeddedSearch, setEmbeddedSearch] = useState("");
  // Tracks cards the user has click-added to the chat from the embedded vault
  // popup, so we can show an "added" checkmark and let them add several in a row.
  const [addedCardIds, setAddedCardIds] = useState(() => new Set());
  const vaultQueryClient = useQueryClient();
  const [vaultReady, setVaultReadyRaw] = useState(() => sessionVaultReady);
  const markVaultReady = useCallback(() => {
    sessionVaultReady = true;
    setVaultReadyRaw(true);
  }, []);
  const setVaultReady = useCallback((value) => {
    if (value === true) {
      markVaultReady();
    } else if (typeof value === "function") {
      setVaultReadyRaw((prev) => {
        const next = value(prev);
        if (next === true) sessionVaultReady = true;
        return next;
      });
    } else {
      setVaultReadyRaw(value);
    }
  }, [markVaultReady]);
  useEffect(() => {
    if (!isWakePreview) return;
    setVaultReady(true);
  }, [isWakePreview, setVaultReady]);
  const [notesError, setNotesError] = useState("");
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
  const [draggedCardId, setDraggedCardId] = useState(null);
  const [dropTargetCardId, setDropTargetCardId] = useState(null);
  const [vaultTrashHover, setVaultTrashHover] = useState(false);
  const [vaultTrashHoldReady, setVaultTrashHoldReady] = useState(false);
  const vaultTrashHoldStartAtRef = useRef(null);
  const vaultTrashHoldTimeoutRef = useRef(null);
  const vaultTrashRef = useRef(null);
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
  // Cards the user just drag-dropped on the trash but whose actual
  // server delete is still pending behind an undo grace window. Hidden
  // from the grid optimistically; restored if the user clicks Undo;
  // committed (real delete) when the timer fires.
  const [pendingDeleteCardIds, setPendingDeleteCardIds] = useState(() => new Set());
  const pendingDeleteTimersRef = useRef(new Map());

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
  const draggedCardMetricsRef = useRef(null);
  // Full-res signed URL for the open lightbox (original storage object).
  // Grid tiles use the medium variant; opening an image upgrades to original
  // so expanded viewing stays sharp on retina.
  const [previewFullUrl, setPreviewFullUrl] = useState(null);
  // projects fetched via React Query above
  const [openCardMenuId, setOpenCardMenuId] = useState(null);
  const [openCardMenuPlacement, setOpenCardMenuPlacement] = useState("down");
  const [openCardMenuRect, setOpenCardMenuRect] = useState(null);
  const [openAttachmentNotesCardId, setOpenAttachmentNotesCardId] = useState(null);
  // Viewport-space anchor rect for the comment composer popover. We
  // render the composer via React portal (see bottom of the component)
  // so it can escape the card's `overflow-hidden` clip — historically
  // the composer was an `absolute` element inside the card and got cut
  // off in grid mode, making it impossible to type into.
  const [openAttachmentNotesRect, setOpenAttachmentNotesRect] = useState(null);
  const [attachmentNoteDraft, setAttachmentNoteDraft] = useState("");
  const [chatChunkDragOver, setChatChunkDragOver] = useState(false);
  const chatChunkDragDepthRef = useRef(0);
  const [showSignInBlocker, setShowSignInBlocker] = useState(false);
  const [walkthroughGateOpen, setWalkthroughGateOpen] = useState(false);
  const [previewCard, setPreviewCard] = useState(null);
  const [previewDetailsOpen, setPreviewDetailsOpen] = useState(false);
  // Share sheet anchored to the preview modal's Share button.
  const [previewShareMenuRect, setPreviewShareMenuRect] = useState(null);
  const [previewProjectDropdownOpen, setPreviewProjectDropdownOpen] = useState(false);
  // Inline comment composer under "Why I saved this" in the pulled-up card.
  const [previewCommentComposerOpen, setPreviewCommentComposerOpen] = useState(false);
  const [previewCommentDraft, setPreviewCommentDraft] = useState("");
  const [previewEditingCommentId, setPreviewEditingCommentId] = useState(null);
  // Per-connector "folder" view. When non-null, the vault grid collapses
  // every connector-sourced card (e.g. Notion pages) into a single tile
  // and clicking that tile opens this state to the connector's id. The
  // grid then renders only that connector's items plus a "back to all"
  // affordance. null = normal mixed view.
  const [openSourceFolder, setOpenSourceFolder] = useState(null);
  // Which of AI Drive's two folders is open ("artifacts" / "images"), or null
  // for the drive's root. See DRIVE_FOLDERS and visibleCards.
  const [openDriveFolder, setOpenDriveFolder] = useState(null);
  // Display data for the folder-view header (name, domain, favicon).
  // Derived from the shared CONNECTORS catalog so we don't duplicate
  // app metadata in this file — any change to a connector's branding
  // flows here automatically.
  const openFolderConnector = useMemo(() => {
    if (!openSourceFolder) return null;
    const connector = CONNECTORS.find((c) => c.id === openSourceFolder);
    if (!connector) return null;
    return {
      name: connector.name,
      domain: connector.domain || "",
      favicon:
        connector.iconUrl ||
        (connector.domain
          ? `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(connector.domain)}`
          : ""),
    };
  }, [openSourceFolder]);
  const [vaultSearch, setVaultSearch] = useState("");
  // Collage/Grid/Tags/Type belong to the Vault page. AI Drive is a folder
  // listing with its own icons/list preference (see DriveListing), so it has no
  // stake in this one.
  const viewStorageKey = "lykn_vault_view";
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
  const [conceptResultIds, setConceptResultIds] = useState(null);
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
  const blockWakePreviewVaultMutation = useCallback((card) => {
    if (!isWakePreview) return false;
    if (card?.isWakePreviewNote) return false;
    setWalkthroughGateOpen(true);
    setOpenCardMenuId(null);
    return true;
  }, [isWakePreview]);
  const handleRequestAddMedia = useCallback(() => {
    if (requireSignInForAction()) return;
    addMediaTriggerRef.current?.();
  }, [requireSignInForAction]);
  const [isConceptSearching, setIsConceptSearching] = useState(false);
  const [showVaultViewDropdown, setShowVaultViewDropdown] = useState(false);
  const vaultViewDropdownRef = useRef(null);
  const lastHoverTargetRef = useRef(null);
  const loadMoreRef = useRef(null);
  const cardMenuRef = useRef(null);
  const noteComposerRef = useRef(null);
  const previewShareMenuRef = useRef(null);
  const previewProjectDropdownRef = useRef(null);

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

  const MEMORY_PAGE_SIZE = 100;

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
  }, [user?.id, checkVaultLimit, incrementVaultCount]);

  const mergeUploadedNotes = useCallback((incoming = []) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    setNotes((prev) => {
      const merged = [...incoming, ...prev];
      const deduped = [];
      const seen = new Set();
      for (const note of merged) {
        const id = String(note?.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        deduped.push(note);
      }
      // Sort by created_at (upload time) DESC to match both the grid's
      // display order and the keyset pagination cursor (which reads the last
      // item's created_at). Sorting by updated_at here would desync the
      // collapsed-page cursor and could skip/refetch rows after an upload.
      deduped.sort((a, b) => {
        const at = new Date(a?.created_at || a?.updated_at || 0).getTime();
        const bt = new Date(b?.created_at || b?.updated_at || 0).getTime();
        return bt - at;
      });
      return deduped;
    });
  }, []);

  // Called when a freshly-uploaded image/video's medium/thumb variants finish
  // generating. For videos this is what lets the grid card swap its black
  // <video> box for the real poster frame without waiting for a reload.
  const handleVariantsReady = useCallback(async (noteId, variants) => {
    if (!noteId || !variants) return;
    const posterPath = String(
      variants.variantThumbPath || variants.variantMediumPath || "",
    ).trim();

    // Persist the variant paths onto the in-memory note marker so they
    // survive re-derivation / pagination (mirrors the DB row the pipeline
    // just wrote).
    setNotes((prev) =>
      prev.map((n) => {
        if (String(n?.id) !== String(noteId)) return n;
        const content = String(n.content || "");
        const span = findAttachmentsMarker(content);
        const head = span?.attachments?.[0];
        if (!span || !head || typeof head !== "object") return n;
        const next = span.attachments.slice();
        next[0] = {
          ...head,
          ...(variants.variantThumbPath ? { variantThumbPath: variants.variantThumbPath } : {}),
          ...(variants.variantMediumPath ? { variantMediumPath: variants.variantMediumPath } : {}),
        };
        return { ...n, content: withAttachmentJsonMarker(content, next) };
      }),
    );

    if (!posterPath) return;
    // Uploaded files always produce a single attachment at index 0.
    const cardId = `${noteId}-att-0`;
    try {
      const cacheKey = `user-files:${posterPath}`;
      let signed = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
      if (!signed) {
        const { data } = await supabase.storage
          .from("user-files")
          .createSignedUrl(posterPath, SIGNED_URL_TTL_SECONDS);
        if (data?.signedUrl) {
          signed = data.signedUrl;
          writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signed);
        }
      }
      if (signed) {
        setResolvedVideoPosterUrls((prev) => ({ ...prev, [cardId]: signed }));
      }
    } catch {
      /* best-effort — poster will resolve on next view/reload */
    }
  }, []);

  // Every row write in this file goes through here rather than straight to
  // Supabase, so the whole vault follows whichever backend is active. The
  // helpers return `{ data, error }` to match what the call sites already
  // expect — see repository/writes.ts.
  const vaultWrites = useMemo(() => createVaultWrites(user?.id), [user?.id]);

  // Attachments live inside `notes.content` as an `[ATTACHMENTS_JSON:[…]]`
  // marker (see `attachmentsMarker.ts`) — there is intentionally no
  // `attachments` column on the `notes` table. Older revisions probed for
  // one and ate a 400 on every cold load; the probe is gone.
  //
  // Which columns a given database actually has is now the repository's
  // problem; see supabaseRepository.ts for the progressive fallback.
  const fetchNotesBatch = useCallback(
    async (cursor) => {
      // Paginate by `created_at` (UPLOAD time) DESC so the fetch order
      // matches the grid's display order (orderedVisibleCards also sorts by
      // createdAtMs desc). If we paginated by `updated_at` while displaying
      // by `created_at`, each newly-loaded page would land in the MIDDLE of
      // the list (its rows' upload times interleave with already-shown ones),
      // reshuffling the grid as the user scrolls — the load-in "glitch".
      //
      // Cursor is `{ createdAt, id }` so we can break ties on equal
      // `created_at`. Plain `.lt("created_at", cursor)` would skip every row
      // that shares the boundary timestamp with the last item of the previous
      // page, silently dropping notes; the `.or(...and(...id.lt))` form is a
      // stable secondary keyset on `id` (we order by both).
      // Which store answers this is decided by the repository, not here. On
      // the cloud backend it runs exactly the query this function used to
      // build — including the progressive column fallback for older
      // databases — so nothing changes until local mode is switched on.
      try {
        const page = await getVaultRepository(user.id).listPage({
          cursor: cursor ?? null,
          limit: MEMORY_PAGE_SIZE,
        });
        return { data: page.rows, error: null };
      } catch (error) {
        // Keep returning errors rather than throwing: the query below already
        // knows which Postgres codes mean "empty vault" instead of "broken".
        return { data: null, error };
      }
    },
    [user?.id]
  );

  const notesQueryKey = useMemo(() => ["vault-notes", user?.id || null], [user?.id]);

  const notesQuery = useInfiniteQuery({
    queryKey: notesQueryKey,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchNotesBatch(pageParam ?? null);
      if (error) {
        if (["PGRST116", "42P01"].includes(error.code) || error.message?.includes("placeholder")) {
          return [];
        }
        throw error;
      }
      return Array.isArray(data) ? data : [];
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage) || lastPage.length < MEMORY_PAGE_SIZE) return undefined;
      const last = lastPage[lastPage.length - 1];
      if (!last?.created_at) return undefined;
      return { createdAt: last.created_at, id: last.id ?? null };
    },
    enabled: !!user?.id && !loading,
    // Keep notes fresh for 30s; within that window, remounts use cache immediately.
    staleTime: 30_000,
    // Hold cache for 10 minutes after the last observer unmounts.
    gcTime: 10 * 60_000,
    // Default refetchOnMount (true) + staleTime gives us stale-while-revalidate.
  });

  const notes = useMemo(
    () => notesQuery.data?.pages.flatMap((p) => (Array.isArray(p) ? p : [])) ?? [],
    [notesQuery.data]
  );

  // For guests the query is disabled, but react-query still reports status === "pending".
  // Treat it as not-loading so the vault UI (incl. the "Add attachments" tile) can render
  // before sign-in.
  const isLoadingNotes = !!user?.id && notesQuery.isPending;
  const hasMoreNotes = !!notesQuery.hasNextPage;
  const isLoadingMoreNotes = notesQuery.isFetchingNextPage;

  // Wrapper that keeps every existing `setNotes((prev) => ...)` call site working.
  // We flatten the cached pages, apply the updater, and store the result as a
  // single page so cursor pagination (based on the last item's updated_at) still works.
  const setNotes = useCallback(
    (updater) => {
      vaultQueryClient.setQueryData(notesQueryKey, (old) => {
        const current = old?.pages?.flatMap((p) => (Array.isArray(p) ? p : [])) ?? [];
        const next = typeof updater === "function" ? updater(current) : updater;
        const list = Array.isArray(next) ? next : [];
        return {
          pages: [list],
          pageParams: [null],
        };
      });
    },
    [vaultQueryClient, notesQueryKey]
  );

  const refreshNotes = useCallback(async () => {
    setNotesError("");
    eagerResolveRunRef.current = false;
    initialCardIdsRef.current = null;
    if (!user?.id) return;
    await vaultQueryClient.invalidateQueries({ queryKey: notesQueryKey });
  }, [vaultQueryClient, notesQueryKey, user?.id]);

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


  // Map query-level errors into the user-facing notesError banner.
  // Also clear the banner when the query recovers — without this, a
  // transient network blip leaves the banner pinned forever.
  useEffect(() => {
    if (notesQuery.isError) {
      setNotesError("Couldn't load your memories right now. Please try again later.");
    } else if (notesQuery.isSuccess) {
      setNotesError("");
    }
  }, [notesQuery.isError, notesQuery.isSuccess]);

  // Same synthesis projects the /projects page uses (`lykn_projects` +
  // `lykn_project_neurons`). The old vault menu still queried
  // `lykn_chat_projects` + localStorage `project:<id>` file trees, which
  // no longer backs the Projects UI.
  const { data: projects = [] } = useQuery({
    queryKey: ["lykn_projects", user?.id || "guest"],
    queryFn: () => listUserProjects(user?.id),
    enabled: !!user?.id && !loading,
    staleTime: 60 * 1000,
  });

  // A file window outlives the render that opened it, and its menus are read
  // when the user opens them — so they read the list through here.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const invalidateVaultProjects = useCallback(() => {
    vaultQueryClient.invalidateQueries({ queryKey: ["lykn_projects", user?.id || "guest"] });
    emitProjectsChanged({ userId: user?.id || null });
  }, [user?.id, vaultQueryClient]);

  const loadMoreNotes = useCallback(async () => {
    if (!user?.id || isLoadingNotes || isLoadingMoreNotes || !hasMoreNotes) return;
    try {
      await notesQuery.fetchNextPage();
    } catch {
      // Pagination failure — vault is still usable, the next page just
      // didn't arrive. Toast keeps the user informed without locking
      // the load-more banner permanently red.
      toast({
        title: "Couldn't load more memories",
        description: "Scroll back later or refresh to try again.",
        variant: "destructive",
      });
    }
  }, [notesQuery, hasMoreNotes, isLoadingMoreNotes, isLoadingNotes, user?.id]);

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


  // Optimistic "ghost" cards: in-flight uploads that already have a local
  // preview URL but don't yet have a DB note. We render them right in the
  // vault grid so users can play a dropped video or view a dropped image
  // immediately — compression/upload continues in the background and the
  // ghost swaps for the real note as soon as `onFileComplete` fires.
  const uploadItems = useVaultUploadStore((s) => s.items);
  const ghostCards = useMemo(() => {
    if (!Array.isArray(uploadItems) || uploadItems.length === 0) return [];
    const existingNoteIds = new Set(notes.map((n) => String(n?.id || "")));
    const out = [];
    for (const item of uploadItems) {
      if (!item || !item.previewUrl) continue;
      if (item.status === "error") continue;
      // Once the real note has been merged into state, drop the ghost.
      if (item.noteId && existingNoteIds.has(String(item.noteId))) continue;
      const ghostType =
        item.fileType === "image" || item.fileType === "video"
          ? item.fileType
          : null;
      if (!ghostType) continue;
      out.push({
        id: `ghost-${item.id}`,
        kind: "attachment",
        ghost: true,
        uploadItemId: item.id,
        uploadStatus: item.status,
        uploadProgress: item.progress,
        noteId: null,
        attachmentIndex: 0,
        type: ghostType,
        attachment: {
          type: ghostType,
          url: item.previewUrl,
          name: item.filename,
          mimeType: item.mimeType || "",
          size: item.sizeBytes,
        },
        title: sanitizeCardTitle(item.filename || "Uploading…"),
        parentTitle: sanitizeCardTitle(item.filename || "Uploading…"),
        noteExcerpt: "",
        dateLabel: "Uploading…",
        tags: [],
        // In-progress uploads are the newest thing in the vault by
        // definition, so pin them to the very top of the upload-time sort.
        createdAtMs: Date.now(),
        lastTouchedMs: Date.now(),
      });
    }
    return out;
  }, [uploadItems, notes]);

  // The Vault never renders synthetic/template content. Signed-out users
  // and brand-new signed-in users both see an empty grid until they save
  // something themselves — no demo cards, no prototype-preview cards, no
  // seeded notes.
  const wakeDemoCards = useMemo(
    () => (isWakePreview ? buildWakeVaultDemoCards() : []),
    [isWakePreview],
  );

  const wakePreviewUserQuickNoteCards = useMemo(
    () => (isWakePreview ? buildWakePreviewUserQuickNoteCards(wakePreviewQuickNotes) : []),
    [isWakePreview, wakePreviewQuickNotes],
  );

  // Ref-mirrored vaultCards for handlers that fire outside React's
  // render cycle (drag-end fires from a DOM event, by which time the
  // closed-over `vaultCards` array can be stale — e.g. an upload just
  // landed, the user just deleted a card, etc.).
  const vaultCardsRef = useRef([]);

  // ─── Multi-select helpers ───────────────────────────────────────────
  //
  // Declared up here (rather than next to the bulk-delete logic that
  // uses them most) because the card-click handler defined further
  // down depends on these in its `useCallback` deps array. Moving
  // them later in the component body produced a TDZ error
  // ("Cannot access 'isSelectableCard' before initialization") since
  // the click handler's `useCallback` runs during render and reads
  // these refs before the original declarations executed. Only real
  // content cards (attachment + quick-note) are selectable —
  // source-folder tiles, chat-previews, and ghost upload cards are
  // navigation/transient affordances and aren't deletable as a group.
  const isSelectableCard = useCallback((card) => {
    if (!card) return false;
    if (card.isDemo) return false;
    // Ghost upload cards carry `ghost: true` (see ghostCards builder);
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
  }, [isSelectableCard]);

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
  }, [isSelectableCard, toggleCardSelection]);

  const vaultCards = useMemo(() => {
    const safeNotes = notes.filter((n) => n && !n.trashed);
    const cards = [];

    // Ghost cards first so they render at the top of the grid — matches
    // how fresh drops normally land (mergeUploadedNotes also prepends).
    for (const ghost of ghostCards) cards.push(ghost);

    // Walkthrough quick notes the guest saved this session — local only,
    // prepended above the demo starter pack so new captures feel immediate.
    for (const previewNote of wakePreviewUserQuickNoteCards) cards.push(previewNote);

    for (const demo of wakeDemoCards) cards.push(demo);

    safeNotes.forEach((note) => {
      const attachments = parseAttachmentsFromNote(note);
      const cleanContent = stripAttachmentJsonMarker(note.content || "");
      const chatPreview = extractChatPreview(cleanContent);
      const youtubeLinks = extractYouTubeLinks(cleanContent);
      // Show the UPLOAD time (created_at), not last-touched. Background AI
      // enrichment (vision descriptions, summaries) writes back to the row
      // and bumps `updated_at`, which would otherwise make a card's date —
      // and its sort position — drift after the user uploaded it.
      const dateLabel = formatDate(note.created_at || note.updated_at);
      const rawSource = String(note?.source || "").toLowerCase();
      const rawTags = Array.isArray(note?.tags) ? note.tags.map((t) => String(t).toLowerCase()) : [];
      // Legacy guard: normalize older rows to the source values the
      // current folder-collapse logic expects.
      //   • Pre-`source`-column Notion rows can still be identified by
      //     the `notion` tag the connector has always written.
      //   • Pre-`source`-column Gmail rows (and any rows that hit the
      //     fallback insert path in `saveGoogleNote` — caps trigger /
      //     schema mismatch — which drops `source` + `tags`) likewise
      //     leak through with blank source. The connector always writes
      //     a `gmail` tag, so we recover them by tag and fold to
      //     `gmail_starred` (any `gmail_*` slug maps to the same
      //     "gmail" connector tile via SOURCE_TO_CONNECTOR_ID, so the
      //     specific choice doesn't matter — the UI just needs *some*
      //     value that resolves to the Gmail folder).
      //   • Drive items synced before the per-app split (Docs / Sheets /
      //     Drive) all landed under `gdrive_starred`. Split them retro-
      //     actively by the mime-derived tag (`doc`, `sheet`, `slides`)
      //     so historical Docs flow into the Google Docs tile and
      //     historical Sheets flow into the Google Sheets tile without
      //     requiring a DB migration or a re-sync.
      let noteSource = rawSource;
      if (rawSource === "" && rawTags.includes("notion")) {
        noteSource = "notion_page";
      } else if (rawSource === "" && rawTags.includes("gmail")) {
        noteSource = rawTags.includes("inbox") ? "gmail_inbox" : "gmail_starred";
      } else if (rawSource === "" && rawTags.includes("google-calendar")) {
        // Calendar.js always writes a `google-calendar` tag alongside
        // the source. Recover rows whose `source` column was dropped by
        // the fallback insert path in `saveGoogleNote` so they still
        // fold into the Google Calendar folder tile.
        noteSource = "gcal_event";
      } else if (rawSource === "gdrive_starred") {
        if (rawTags.includes("doc")) noteSource = "gdocs_starred";
        else if (rawTags.includes("sheet")) noteSource = "gsheets_starred";
        else if (rawTags.includes("slides")) noteSource = "gslides_starred";
      }

      // Belt-and-suspenders URL fallback for rows that hit the truly-
      // degraded fallback insert path in `saveGoogleNote` (caps trigger
      // / schema mismatch), which drops BOTH `source` and `tags`. The
      // bookmark URL inside the attachment payload is the only signal
      // left, so we sniff well-known connector domains for the few
      // sources we know historically broke. Order matters: more
      // specific hosts (mail/calendar/drive) come before any catch-alls.
      if (noteSource === "" && attachments.length > 0) {
        const firstUrl = String(attachments[0]?.url || "").toLowerCase();
        if (firstUrl.includes("mail.google.com")) {
          noteSource = "gmail_starred";
        } else if (
          // Google Calendar's `htmlLink` is `https://www.google.com/calendar/event?eid=...`,
          // not `calendar.google.com/...`, so the bare-host substring
          // check below would never match real event URLs. Accept both
          // the modern (`www.google.com/calendar/`) and legacy
          // (`calendar.google.com`) shapes so historical rows still
          // collapse into the Google Calendar folder tile.
          firstUrl.includes("/calendar/event") ||
          firstUrl.includes("calendar.google.com")
        ) {
          noteSource = "gcal_event";
        } else if (firstUrl.includes("drive.google.com") || firstUrl.includes("docs.google.com")) {
          if (firstUrl.includes("/document/")) noteSource = "gdocs_starred";
          else if (firstUrl.includes("/spreadsheets/")) noteSource = "gsheets_starred";
          else if (firstUrl.includes("/presentation/")) noteSource = "gslides_starred";
          else noteSource = "gdrive_starred";
        } else if (firstUrl.includes("notion.so") || firstUrl.includes("notion.site")) {
          noteSource = "notion_page";
        }
      }
      const updatedAtMs = note?.updated_at ? new Date(note.updated_at).getTime() : 0;
      const createdAtMs = note?.created_at ? new Date(note.created_at).getTime() : 0;
      const lastTouchedMs = Math.max(updatedAtMs, createdAtMs);
      const noteTags = Array.isArray(note.tags) ? note.tags : [];
      const aiGenerated = isAiGeneratedNote(note, noteSource, noteTags);
      const noteBody = String(cleanContent || "").replace(/\r\n/g, "\n").trim();
      const textNoteStyle = resolveTextNoteStyle(noteSource, noteTags, note.title, noteBody);
      const isFormattedTextNote = textNoteStyle !== "quick";
      const isStandaloneQuickNote =
        noteSource === "quick_note" ||
        noteSource === "voice_note" ||
        (String(note?.title || "").trim().toLowerCase() === "quick note" && attachments.length === 0);
      const excerpt = isFormattedTextNote
        ? buildSpacedExcerpt(noteBody)
        : buildTextExcerpt(noteBody);
      const noteExcerpt = excerpt || "";

      attachments.forEach((attachment, idx) => {
        let type = resolveAttachmentType(attachment);
        // Recover mis-typed storage images (e.g. variant path `medium.jpg`
        // saved as type "file") so the grid/preview never fall back to a
        // raw supabase download link.
        if (type === "file" && looksLikeImageAttachment(attachment)) {
          type = "image";
        }
        const noteTitle = String(note.title || "").trim();
        const attName = String(attachment.name || "").trim();
        cards.push({
          id: `${note.id}-att-${attachment.id || idx}`,
          kind: "attachment",
          noteId: note.id,
          attachmentIndex: idx,
          type,
          attachment,
          title: sanitizeCardTitle(
            attName,
            sanitizeCardTitle(noteTitle, type === "image" ? "Image" : "Vault item"),
          ),
          parentTitle: sanitizeCardTitle(note.title || "Untitled note"),
          noteExcerpt,
          dateLabel,
          tags: noteTags,
          source: noteSource,
          aiGenerated,
          lastTouchedMs,
          createdAtMs,
        });
      });

      if (attachments.length === 0 && youtubeLinks.length > 0) {
        youtubeLinks.forEach((url, idx) => {
          cards.push({
            id: `${note.id}-yt-${idx}`,
            kind: "attachment",
            noteId: note.id,
            // Mark this tile as derived from a URL embedded in note content
            // (no real attachment payload). `removeAttachmentFromNote` keys
            // off this so deleting the tile only strips the URL from the
            // note instead of dropping the whole row, which previously
            // wiped notes that had real attachments alongside a YT link.
            syntheticType: "youtube-link",
            syntheticUrl: url,
            type: "youtube",
            attachment: { url, name: "YouTube Video" },
            title: "YouTube Video",
            parentTitle: note.title || "Untitled note",
            noteExcerpt,
            dateLabel,
            tags: noteTags,
            source: noteSource,
            aiGenerated,
            lastTouchedMs,
            createdAtMs,
          });
        });
      }

      if (!isStandaloneQuickNote && !isFormattedTextNote && chatPreview && attachments.length === 0) {
        cards.push({
          id: `${note.id}-chat-preview`,
          kind: "chat-preview",
          noteId: note.id,
          title: note.title || "AI Chat",
          question: chatPreview.question,
          answer: chatPreview.answer,
          turnsCount: chatPreview.turnsCount,
          noteExcerpt,
          dateLabel,
          tags: noteTags,
          source: noteSource,
          aiGenerated,
          lastTouchedMs,
          createdAtMs,
        });
      }

      // Text-only memories: quick notes, meeting notes, browser tasks, docs.
      // Meetings/tasks keep full `body` + spaced excerpt so preview formatting
      // survives (buildTextExcerpt alone collapses newlines).
      if (noteBody && attachments.length === 0 && (isStandaloneQuickNote || isFormattedTextNote || !chatPreview)) {
        cards.push({
          id: `${note.id}-quick-note`,
          kind: "quick-note",
          noteId: note.id,
          noteStyle: textNoteStyle,
          label: textNoteLabel(textNoteStyle),
          title: note.title || textNoteLabel(textNoteStyle),
          excerpt,
          body: noteBody,
          formatted: isFormattedTextNote,
          dateLabel,
          tags: noteTags,
          comments: parseQuickNoteComments(note),
          source: noteSource,
          aiGenerated,
          lastTouchedMs,
          createdAtMs,
        });
      }
    });

    const cardsWithPreviewComments = isWakePreview
      ? cards.map((card) =>
          applyWakePreviewCommentsToCard(card, wakePreviewCardComments, wakePreviewDeletedComments),
        )
      : cards;

    const seen = new Set();
    return cardsWithPreviewComments.filter((card) => {
      if (card.kind === "attachment") {
        const att = card.attachment || {};
        const url = String(att.url || "").trim();
        const videoId = String(att.videoId || "").trim();
        const storagePath = String(att.storagePath || att.fileId || "").trim();
        const key =
          (videoId && `yt:${videoId}`) ||
          (storagePath && `path:${storagePath}`) ||
          (url && !url.startsWith("data:") && `url:${url}`) ||
          null;
        if (key) {
          if (seen.has(key)) return false;
          seen.add(key);
        }
      } else if (card.kind === "quick-note") {
        const text = String(card.excerpt || "").trim().slice(0, 200);
        if (text) {
          const key = `qn:${text}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
      }
      return true;
    });
  }, [notes, ghostCards, wakeDemoCards, wakePreviewUserQuickNoteCards, isWakePreview, wakePreviewCardComments, wakePreviewDeletedComments]);

  // Signed-URL / media resolution subsystem (cache, visibility queue, poster
  // signing, artifact markup, dims backfill, tab-refocus recovery). The
  // first-paint eager preload below and the AI-describe backfill stay in this
  // file and reach the machinery through the exposed refs/functions.
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

  // Tag subsystem: directory (DB counts + fallback), filter selection, the
  // per-card tag picker popover state, tag mutations, and the AI Drive tag
  // strip. Shared popover dismissal effects remain below.
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
  }, [openAttachmentNotesCardId, tagPickerCardId]);


  // Keep the ref in sync so handlers that fire from raw DOM events
  // (drag-end, etc.) can read the current grid without going through
  // a stale closure.
  useEffect(() => {
    vaultCardsRef.current = vaultCards;
  }, [vaultCards]);

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
  }, [isPickerMode, isEmbeddedMode, selectedCardIds, embeddedTargetOrigin]);

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
  }, [isPickerMode, embeddedTargetOrigin, isSelectableCard]);

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

  // ─── Deep-link: ?note=<noteId> ─────────────────────────────────────
  //
  // The synthesis-layer NeuronPanel's "Open in vault" button navigates
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
    // handled by the drive deep-link effect below.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioSurface, location.search, location.pathname, vaultCards, isLoadingNotes, hasMoreNotes]);


  const eagerResolveRunRef = useRef(false);
  // Gate the LoadingScreen on a one-shot image preload. Snapshot cards from
  // the ref (not vaultCards in the dep list) so ghost/note identity churn
  // doesn't cancel mid-flight. A cancelled run used to leave
  // eagerResolveRunRef=true forever, which stuck first visit on LoadingScreen
  // until a remount (navigate away → back) reset the ref.
  useEffect(() => {
    if (isWakePreview) return;
    if (!user?.id || isLoadingNotes) return;
    if (sessionVaultReady || eagerResolveRunRef.current) return;

    const cards = vaultCardsRef.current;
    if (cards.length === 0) {
      setVaultReady(true);
      return;
    }

    const attachmentCards = cards.filter((c) => c.kind === "attachment");
    if (attachmentCards.length === 0) {
      setVaultReady(true);
      return;
    }

    eagerResolveRunRef.current = true;
    for (const card of attachmentCards) {
      visibleCardIdsRef.current.add(card.id);
      urlResolveQueueRef.current.push(card);
    }
    let cancelled = false;
    const safetyTimer = setTimeout(() => {
      if (!cancelled) setVaultReady(true);
    }, 10000);
    let preloadTimeout = null;
    drainUrlResolveQueue().then(() => {
      if (cancelled) return;
      const imageCards = attachmentCards.filter((c) => {
        const t = resolveAttachmentType(c.attachment || {});
        return t === "image";
      });
      const urlsToPreload = imageCards
        .slice(0, 24)
        .map((c) => {
          const t = parseStorageTarget(c.attachment || {});
          const key = `${t?.bucket || "user-files"}:${t?.path || ""}`;
          return readCachedSignedUrl(signedUrlCacheRef.current, key) || c.attachment?.url;
        })
        .filter((u) => u && !String(u).startsWith("data:"));
      if (urlsToPreload.length === 0) {
        clearTimeout(safetyTimer);
        setVaultReady(true);
        return;
      }
      let settled = 0;
      const preloadDone = () => {
        settled += 1;
        if (settled >= urlsToPreload.length && !cancelled) {
          clearTimeout(safetyTimer);
          if (preloadTimeout) clearTimeout(preloadTimeout);
          setVaultReady(true);
        }
      };
      preloadTimeout = setTimeout(() => {
        if (cancelled) return;
        clearTimeout(safetyTimer);
        setVaultReady(true);
      }, 4000);
      for (const url of urlsToPreload) {
        const img = new window.Image();
        // Some browsers won't pre-decode cross-origin images without
        // the CORS hint. Signed Supabase URLs serve the right headers,
        // so this is safe to set unconditionally; if it fails, the
        // catch path falls back to a plain onload signal so we still
        // unblock vaultReady.
        img.crossOrigin = "anonymous";
        // Capture natural dims as early as possible. We do this here,
        // BEFORE the real <img> in the grid mounts, so the wrapper can
        // reserve the correct aspect-ratio slot from the very first
        // paint — eliminating the "card grows from skeleton size to
        // real image size" jump that caused the visible scroll glitch
        // for old images without stored metadata.
        const captureDims = () => {
          if (cancelled) return;
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;
          if (nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(url)) {
            learnedImageDimsRef.current.set(url, { w: nw, h: nh });
          }
        };
        const markDecoded = () => {
          if (cancelled) return;
          captureDims();
          preDecodedUrlsRef.current.add(url);
          preloadDone();
        };
        const fallbackOnLoad = () => {
          if (cancelled) return;
          // We still consider the URL "ready enough" — the browser has
          // it in HTTP cache so the real <img> will paint quickly.
          // We just don't add it to the no-fade set, so the existing
          // fade-in still runs as a graceful safety net. Dims still
          // get captured so the wrapper can reserve correct space.
          captureDims();
          preloadDone();
        };
        img.onload = () => {
          if (cancelled) return;
          if (typeof img.decode === "function") {
            img.decode().then(markDecoded).catch(fallbackOnLoad);
          } else {
            // Old browser without HTMLImageElement.decode — treat as
            // pre-decoded (good enough; the visible-fade fallback
            // still works if it isn't).
            markDecoded();
          }
        };
        img.onerror = () => { if (!cancelled) preloadDone(); };
        img.src = url;
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      if (preloadTimeout) clearTimeout(preloadTimeout);
      // If we aborted before marking ready, allow the next effect pass to
      // retry. Leaving the ref true here permanently stuck first visit.
      if (!sessionVaultReady) {
        eagerResolveRunRef.current = false;
      }
    };
  }, [user?.id, isLoadingNotes, drainUrlResolveQueue, setVaultReady, isWakePreview]);


  const visibleCards = useMemo(() => {
    const baseline = vaultCards.filter(
      (card) =>
        card.kind !== "chat-preview" &&
        !pendingDeleteCardIds.has(card.id) &&
        // The drive and the vault divide what LYKN made from what the user
        // put in, and the split runs both ways: generated work is filed in
        // the AI Drive and only there, so saving an image doesn't also leave
        // a copy of it in the middle of the Vault page.
        (studioSurface || !driveFolderIdFor(card)),
    );

    // AI Drive is not a view of the vault — it's the drive for what LYKN made.
    // Two folders, the AI's output sorted between them, and nothing else: no
    // uploads, no connector syncs, no notes. Those stay on the Vault page,
    // which is why none of the passes below apply here.
    if (studioSurface) {
      const generated = baseline.filter((card) => driveFolderIdFor(card));
      if (openDriveFolder) {
        return generated.filter((card) => driveFolderIdFor(card) === openDriveFolder);
      }
      // Searching looks through the drive rather than at it, so matches surface
      // as items instead of as the folders they happen to live in.
      const searching =
        Boolean(String(embeddedSearch || "").trim()) ||
        Boolean(String(vaultSearch || "").trim()) ||
        conceptResultIds !== null;
      if (searching) return generated;

      // Both folders show even while empty: they're where the AI's next image
      // and next artifact will land, and a drive that changes shape as it fills
      // is harder to learn than one that doesn't.
      return DRIVE_FOLDERS.map(({ id, name }) => {
        const items = generated.filter((card) => driveFolderIdFor(card) === id);
        const lastTouchedMs = items.reduce((max, card) => Math.max(max, card.lastTouchedMs || 0), 0);
        return {
          id: `__drive_folder:${id}`,
          kind: "drive-folder",
          folderId: id,
          folderName: name,
          title: name,
          count: items.length,
          dateLabel: lastTouchedMs ? formatDate(new Date(lastTouchedMs).toISOString()) : "",
          tags: [],
          allTags: [],
          lastTouchedMs,
        };
      });
    }

    // Folder-view: when the user has tapped into a connector tile, the
    // grid is dedicated to that connector's items. We skip the collapse
    // pass entirely and just narrow the list. Matching is done by
    // connector id (not raw `source`) so a connector that writes
    // multiple source strings — Reddit posts+comments, Mastodon
    // favourites+bookmarks — still shows everything under one folder.
    if (openSourceFolder) {
      return baseline.filter((card) => {
        const cfg = resolveSourceFolder(card.source);
        return cfg && cfg.connectorId === openSourceFolder;
      });
    }

    // The Type view slices by media type, where a per-app folder tile has no
    // natural bucket, so it passes through unchanged. The Tags view DOES
    // collapse (below): each 3rd-party app becomes one folder tile, grouped
    // under the union of its items' tags, matching collage/grid.
    if (vaultView === "type") return baseline;

    // When the user is actively searching or running a concept query,
    // skip the collapse so individual connector items surface in the
    // results. Without this a search for "roadmap" would never match
    // anything from Notion because the only Notion-shaped card in the
    // visible list is the synthetic folder tile, whose title is just
    // "Notion".
    const hasActiveQuery =
      Boolean(String(embeddedSearch || "").trim()) ||
      Boolean(String(vaultSearch || "").trim()) ||
      conceptResultIds !== null;
    if (hasActiveQuery) return baseline;

    // Bucket every connector-sourced card by its connector id so we can
    // synthesize one folder tile per app. Two different `source` values
    // that fold into the same connector (Reddit posts + comments,
    // Mastodon favourites + bookmarks, …) share a single bucket and
    // therefore a single tile.
    const grouped = new Map();
    for (const card of baseline) {
      const cfg = resolveSourceFolder(card.source);
      if (!cfg) continue;
      let bucket = grouped.get(cfg.connectorId);
      if (!bucket) {
        bucket = {
          cfg,
          count: 0,
          lastTouchedMs: 0,
          sampleTags: new Set(),
          allTags: new Set(),
          sourceValues: new Set(),
          firstIndex: Infinity,
        };
        grouped.set(cfg.connectorId, bucket);
      }
      bucket.count += 1;
      bucket.sourceValues.add(card.source);
      if ((card.lastTouchedMs || 0) > bucket.lastTouchedMs) {
        bucket.lastTouchedMs = card.lastTouchedMs || 0;
      }
      (card.tags || []).slice(0, 3).forEach((t) => bucket.sampleTags.add(t));
      // Full tag union drives the Tags view grouping so the app's folder tile
      // shows up under every tag its underlying items carry.
      (card.tags || []).forEach((t) => bucket.allTags.add(t));
    }

    if (grouped.size === 0) return baseline;

    const result = [];
    const injectedConnectors = new Set();
    for (const card of baseline) {
      const cfg = resolveSourceFolder(card.source);
      if (cfg) {
        if (!injectedConnectors.has(cfg.connectorId)) {
          injectedConnectors.add(cfg.connectorId);
          const bucket = grouped.get(cfg.connectorId);
          result.push({
            id: `__source_folder:${cfg.connectorId}`,
            kind: "source-folder",
            // `source` on the synthetic tile stores the connector id so
            // openSourceFolder filtering and tile click handling can key
            // on a single stable value regardless of how many underlying
            // source strings the connector writes.
            source: cfg.connectorId,
            connectorId: cfg.connectorId,
            sourceName: cfg.name,
            domain: cfg.domain,
            favicon: cfg.favicon,
            count: bucket.count,
            title: cfg.name,
            dateLabel: bucket.lastTouchedMs
              ? formatDate(new Date(bucket.lastTouchedMs).toISOString())
              : "",
            tags: Array.from(bucket.sampleTags),
            allTags: Array.from(bucket.allTags),
            lastTouchedMs: bucket.lastTouchedMs,
          });
        }
        // Skip the original — it's represented by the folder tile.
        continue;
      }
      result.push(card);
    }
    return result;
  }, [
    vaultCards,
    pendingDeleteCardIds,
    openSourceFolder,
    openDriveFolder,
    studioSurface,
    vaultView,
    embeddedSearch,
    vaultSearch,
    conceptResultIds,
  ]);

  const initialCardIdsRef = useRef(null);
  if (vaultReady && initialCardIdsRef.current === null) {
    initialCardIdsRef.current = new Set(vaultCards.map((c) => c.id));
  }

  // Suppress per-card entry motion + image fade-ins on the first paint
  // after the loading gate lifts. Without this, masonry columns reflow
  // while each card's opacity transition starts on a different frame —
  // the "pile in" / "click downward" effect users see on cold load.
  const isVaultFirstPaintRef = useRef(true);
  useEffect(() => {
    if (!vaultReady) return;
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        isVaultFirstPaintRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [vaultReady]);

  const backfillDescribedRef = useRef(new Set());
  const backfillRunningRef = useRef(false);

  useEffect(() => {
    if (!user?.id || isLoadingNotes || backfillRunningRef.current) return;

    const undescribed = vaultCards.filter(
      (card) =>
        card.kind === "attachment" &&
        card.noteId &&
        !card.attachment?.aiDescription &&
        !backfillDescribedRef.current.has(card.id) &&
        !failedImageIds.has(card.id)
    );
    if (undescribed.length === 0) return;

    const pendingAttachments = vaultCards.filter(
      (c) => c.kind === "attachment" && !resolvedAttachmentUrls[c.id] && !failedImageIds.has(c.id) && visibleCardIdsRef.current.has(c.id)
    );
    if (pendingAttachments.length > 0) return;

    let cancelled = false;
    backfillRunningRef.current = true;

    (async () => {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const batch = undescribed.slice(0, 5);

      for (const card of batch) {
        if (cancelled) break;
        backfillDescribedRef.current.add(card.id);

        const att = card.attachment || {};
        const isVisual = card.type === "image" || card.type === "video";
        const hasResolvedUrl = !!resolvedAttachmentUrls[card.id];
        if (isVisual && !hasResolvedUrl) continue;
        const rawUrl = resolvedAttachmentUrls[card.id] || att.url || "";
        const imageUrl = isVisual && rawUrl && !rawUrl.startsWith("data:") ? rawUrl : undefined;
        const textContent = att.extractedText || att.articleText || att.description || "";
        const fileName = att.name || card.title || "";

        if (!imageUrl && !textContent && !fileName) continue;

        try {
          const session = (await supabase.auth.getSession())?.data?.session;
          const token = session?.access_token;
          if (!token) continue;
          const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              imageUrl,
              textContent: textContent ? textContent.slice(0, 5000) : undefined,
              fileType: card.type,
              fileName,
            }),
          });
          if (!res.ok) continue;
          const { description } = await res.json();
          if (!description || cancelled) continue;

          // Fetch with `updated_at` so we can guard against trampling user
          // edits made between the AI request and the persist below.
          const { data: note } = await vaultWrites.readForUpdate(card.noteId);
          if (!note?.content) continue;

          const span = findAttachmentsMarker(String(note.content));
          if (!span) continue;

          const attachments = span.attachments.slice();
          const attIdx = card.attachmentIndex ?? 0;
          if (!attachments[attIdx] || typeof attachments[attIdx] !== "object") continue;
          attachments[attIdx] = { ...attachments[attIdx], aiDescription: description };

          const updatedContent = withAttachmentsMarker(String(note.content), attachments);

          // Lost-update guard: only commit if the row hasn't been updated
          // since we read it.
          const { error: updateError } = await vaultWrites.updateIfUnchanged(
            card.noteId,
            { content: updatedContent },
            note.updated_at,
          );
          if (updateError) continue;

          if (!cancelled) {
            setNotes((prev) =>
              prev.map((n) => (String(n.id) === String(card.noteId) ? { ...n, content: updatedContent } : n))
            );
          }

          await new Promise((r) => setTimeout(r, 2000));
        } catch {
          // best-effort backfill
        }
      }

      backfillRunningRef.current = false;
    })();

    return () => { cancelled = true; backfillRunningRef.current = false; };
  }, [vaultCards, user?.id, isLoadingNotes, resolvedAttachmentUrls, failedImageIds]);

  const filteredVisibleCards = useMemo(() => {
    let cards = visibleCards;

    if (selectedFilterTags.length > 0) {
      const wantUntagged = selectedFilterTags.includes("__untagged__");
      const realTags = selectedFilterTags.filter((t) => t !== "__untagged__");
      cards = cards.filter((card) => {
        const cardTags = card.tags || [];
        if (wantUntagged && cardTags.length === 0) return true;
        if (realTags.length > 0 && realTags.every((t) => cardTags.includes(t))) return true;
        return false;
      });
    }

    if (conceptResultIds !== null) {
      if (conceptResultIds.length === 0) return [];
      const idSet = new Set(conceptResultIds);
      const matched = cards.filter((card) => idSet.has(card.id));
      matched.sort((a, b) => conceptResultIds.indexOf(a.id) - conceptResultIds.indexOf(b.id));
      return matched;
    }

    const query = String(embeddedSearch || "").trim().toLowerCase();
    if (!query) return cards;
    return cards.filter((card) => {
      const fields = [
        card?.title,
        card?.parentTitle,
        card?.excerpt,
        card?.question,
        card?.answer,
        card?.attachment?.name,
        card?.attachment?.url,
        card?.dateLabel,
      ];
      return fields.some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [embeddedSearch, visibleCards, conceptResultIds, selectedFilterTags]);

  // Ordering/grouping of the visible cards (manual collage order, connector
  // pinning, tags/type groupings).
  const {
    orderedVisibleCards,
    wakeConnectorStripCards,
    wakeCollageCards,
    tagGroupedCards,
    typeGroupedCards,
  } = useVaultCardOrdering({ user, isWakePreview, vaultView, filteredVisibleCards });

  useEffect(() => {
    // Only persist the user's real preference. Wake-preview forces "grid" and
    // picker mode forces "collage" (see the vaultView initializer + isPickerMode
    // effect); if we wrote those forced values back to localStorage they'd
    // clobber the stored preference, so the next normal vault load would wrongly
    // default to the forced view.
    if (isWakePreview || isPickerMode) return;
    try { localStorage.setItem(viewStorageKey, vaultView); } catch {}
  }, [vaultView, isWakePreview, isPickerMode, viewStorageKey]);

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

  // NOTE: `removeAttachmentFromNote` and `removeQuickNoteCard` are
  // defined later in this component (TDZ), so they are intentionally
  // omitted from the deps array — the closure resolves them via
  // lexical lookup at call time (always after render completes).
  // We read from `vaultCardsRef.current` instead of the closed-over
  // `vaultCards`: the latter is the snapshot from whichever render
  // memoized this callback, which can lag behind the actual current
  // grid by several updates (uploads landing, deletes, drag-and-drop
  // reorders), causing trash-on-drop to operate on the wrong card or
  // a card that no longer exists.
  // Window before a drag-trashed card is actually deleted on the server.
  // Long enough to let the user notice "wait, I didn't mean to" and click
  // Undo; short enough that the card actually disappears soon if they
  // meant it. The card is hidden from the grid for the whole window.
  const TRASH_UNDO_GRACE_MS = 6000;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEmbeddedMode, clearVaultTrashHold, vaultTrashHoldReady, draggedCardId, embeddedTargetOrigin]);

  // Note on lifecycle: we deliberately do NOT clear pending-delete
  // timers on unmount. The user dragged to trash WITH intent to delete;
  // if they navigate away during the undo window, the timer fires on
  // the global event loop and the supabase delete still goes through.
  // Any stale `setState` inside the commit closure becomes a no-op on
  // an unmounted component (React 18+ doesn't throw), which is fine —
  // the server state is the source of truth.

  // Build the same payload a drag would carry so the embedded chat sidebar
  // can add an item to the chat on a plain click (no drag required). Mirrors
  // the attachment / quick-note branches in `handleCardDragStart`.
  const buildEmbeddedVaultPayload = useCallback((card) => {
    if (!card) return null;
    if (card.kind === "attachment" && card.attachment) {
      const att = card.attachment;
      const videoId = card.type === "youtube" ? (att.videoId || extractYouTubeVideoId(att.url || "") || "") : "";
      const resolvedForDrag = resolvedAttachmentUrls[card.id] || att.url || "";
      const pdfText = (card.type === "pdf" && att.extractedText) ? String(att.extractedText) : "";
      const dragAttachment = { ...att, url: resolvedForDrag, type: card.type, videoId, ...(pdfText ? { pdfText, extractedText: pdfText } : {}) };
      return {
        id: card.id,
        noteId: card.noteId || card.id,
        attachmentIndex: Number.isInteger(card.attachmentIndex) ? card.attachmentIndex : 0,
        title: card.title || "",
        content: "",
        attachments: [dragAttachment],
        attachment: dragAttachment,
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
    }
    if (card.kind === "quick-note") {
      return {
        id: card.id,
        noteId: card.noteId || card.id,
        attachmentIndex: 0,
        title: card.title || "Quick Note",
        content: card.excerpt || "",
        attachments: [],
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
    }
    return null;
  }, [resolvedAttachmentUrls]);

  const openUrlInSystemBrowser = useCallback((url) => {
    const safe = safeAttachmentUrl(url) || safeExternalUrl(url);
    if (!safe || !/^https?:\/\//i.test(safe)) return false;
    try {
      if (typeof window.lykn?.openExternal === "function") {
        window.lykn.openExternal(safe);
        return true;
      }
    } catch {
      /* fall through to window.open */
    }
    const win = window.open(safe, "_blank", "noopener,noreferrer");
    return !!win;
  }, []);

  // Mint (or reuse) a branded file-proxy URL so HTML artifacts render with the
  // right MIME/CSP in an external browser tab — not a blank Supabase storage URL.
  const resolveHtmlArtifactOpenUrl = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return "";
    const existing = resolvedAttachmentUrls[card.id];
    if (existing && !/supabase\.co\/storage\//i.test(existing)) return existing;

    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) {
      const raw = String(card.attachment?.url || "").trim();
      if (raw && !/supabase\.co\/storage\//i.test(raw)) return raw;
      return "";
    }

    const cacheKey = `file-proxy:${target.bucket}:${target.path}`;
    const cachedFresh = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
    if (cachedFresh && !/supabase\.co\/storage\//i.test(cachedFresh)) {
      setResolvedAttachmentUrls((prev) => (
        prev[card.id] === cachedFresh ? prev : { ...prev, [card.id]: cachedFresh }
      ));
      return cachedFresh;
    }

    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const session = (await supabase.auth.getSession())?.data?.session;
      const token = session?.access_token;
      if (!token) return "";
      const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          storagePath: target.path,
          bucket: target.bucket,
          filename: String(card.attachment?.name || "artifact.html"),
        }),
      });
      if (!resp.ok) return "";
      const { url } = await resp.json();
      if (!url || /supabase\.co\/storage\//i.test(url)) return "";
      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: url }));
      return url;
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[Vault] Artifact browser URL mint failed:", err);
      return "";
    }
  }, [resolvedAttachmentUrls]);

  const openVaultArtifactInBrowser = useCallback(async (card) => {
    const url = await resolveHtmlArtifactOpenUrl(card);
    if (!url || !openUrlInSystemBrowser(url)) {
      toast({
        title: "Couldn't open artifact",
        description: "Try again in a moment.",
      });
      return false;
    }
    return true;
  }, [resolveHtmlArtifactOpenUrl, openUrlInSystemBrowser]);

  // Preview "Expand" — open the full item in a separate browser/system window.
  // Card click stays in the in-app view mode for every type (including HTML).
  const openCardFullyInBrowser = useCallback(async (card) => {
    if (!card) return false;
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      const t = resolveAttachmentType(att) || card.type;
      if (t === "html") return openVaultArtifactInBrowser(card);
      if (t === "youtube" || t === "bookmark" || t === "link") {
        const url = String(att.url || "").trim();
        if (!url || !openUrlInSystemBrowser(url)) {
          toast({ title: "Couldn't open", description: "No link available for this item." });
          return false;
        }
        return true;
      }
      const target = parseStorageTarget(att);
      let url = "";
      if (target?.bucket && target?.path) {
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          url = data?.signedUrl || "";
        } catch {
          /* fall through */
        }
      }
      if (!url) url = resolvedAttachmentUrls[card.id] || String(att.url || "").trim();
      if (!url || !openUrlInSystemBrowser(url)) {
        toast({ title: "Couldn't open", description: "Try again in a moment." });
        return false;
      }
      return true;
    }
    toast({
      title: "Already open",
      description: "This item is shown in the preview — there's no separate page to expand.",
    });
    return false;
  }, [openVaultArtifactInBrowser, openUrlInSystemBrowser, resolvedAttachmentUrls]);

  const chatAboutPreviewCard = useCallback((card) => {
    const payload = buildEmbeddedVaultPayload(card);
    if (!payload) {
      toast({ title: "Couldn't open chat", description: "This item can't be added to chat." });
      return;
    }
    if (isEmbeddedMode) {
      try {
        window.parent.postMessage({ type: "lykn-chat-vault-add", data: payload }, embeddedTargetOrigin);
      } catch {
        /* ignore */
      }
      setPreviewCard(null);
      return;
    }
    setPreviewCard(null);
    if (studioSurface) {
      // The Studio-owned Home bar receives and visibly holds this payload; it
      // hands it to the real chat surface only when the user sends.
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
      return;
    }
    try {
      sessionStorage.setItem("lykn_pending_vault_chat_add", JSON.stringify({ ...payload, timestamp: Date.now() }));
    } catch {
      /* ignore */
    }
    nav("/app");
  }, [buildEmbeddedVaultPayload, isEmbeddedMode, embeddedTargetOrigin, nav, studioSurface]);

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
      const payloads = cards.map(buildEmbeddedVaultPayload).filter(Boolean);
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
  }, [selectedCardIds, buildEmbeddedVaultPayload, clearSelection, activePickTarget]);

  const cancelVaultChatPick = useCallback(() => {
    setPreviewCard(null);
    clearSelection();
    closeVaultPicker();
  }, [clearSelection]);

  const resolvePreviewShareUrl = useCallback((card, urlHint = "") => {
    const url = String(urlHint || card?.attachment?.url || "").trim();
    return safeAttachmentUrl(url) || safeExternalUrl(url) || "";
  }, []);

  const resolvePreviewShareText = useCallback((card) => {
    const title = String(card?.title || card?.label || "").trim();
    const body = String(card?.body || card?.excerpt || card?.question || "").trim();
    const whyNote = card?.noteId
      ? notes.find((n) => String(n?.id) === String(card.noteId))
      : null;
    const why = String(whyNote?.why || "").trim();
    const parts = [title, body, why ? `Why I saved this:\n${why}` : ""].filter(Boolean);
    return parts.join("\n\n").trim();
  }, [notes]);

  const sharePreviewNative = useCallback(async (card, urlHint = "") => {
    const title = String(card?.title || "LYKN vault item");
    const safe = resolvePreviewShareUrl(card, urlHint);
    const text = resolvePreviewShareText(card);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({
          title,
          ...(safe ? { url: safe } : {}),
          ...(text ? { text } : !safe ? { text: title } : {}),
        });
        setPreviewShareMenuRect(null);
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
    toast({ title: "Share unavailable", description: "Use Copy link or Download instead." });
  }, [resolvePreviewShareUrl, resolvePreviewShareText]);

  const sharePreviewCopyLink = useCallback(async (card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    if (!safe) {
      toast({ title: "No link", description: "This item doesn't have a shareable link." });
      return;
    }
    try {
      await navigator.clipboard.writeText(safe);
      toast({ title: "Link copied" });
      setPreviewShareMenuRect(null);
    } catch {
      toast({ title: "Couldn't copy", description: "Copy the link manually instead." });
    }
  }, [resolvePreviewShareUrl]);

  const sharePreviewCopyText = useCallback(async (card) => {
    const text = resolvePreviewShareText(card);
    if (!text) {
      toast({ title: "Nothing to copy", description: "This item has no text to copy." });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Text copied" });
      setPreviewShareMenuRect(null);
    } catch {
      toast({ title: "Couldn't copy" });
    }
  }, [resolvePreviewShareText]);

  const sharePreviewOpenLink = useCallback((card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    if (!safe) {
      toast({ title: "No link", description: "This item doesn't have a link to open." });
      return;
    }
    openUrlInSystemBrowser(safe);
    setPreviewShareMenuRect(null);
  }, [resolvePreviewShareUrl, openUrlInSystemBrowser]);

  const sharePreviewDownload = useCallback(async (card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    const filename = String(card?.attachment?.name || card?.title || "lykn-download")
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .slice(0, 120);
    if (!safe) {
      toast({ title: "Can't download", description: "This item doesn't have a downloadable file." });
      return;
    }
    try {
      const res = await fetch(safe);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: "Download started" });
      setPreviewShareMenuRect(null);
    } catch {
      openUrlInSystemBrowser(safe);
      setPreviewShareMenuRect(null);
    }
  }, [resolvePreviewShareUrl, openUrlInSystemBrowser]);

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
      const payload = buildEmbeddedVaultPayload(card);
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
    buildEmbeddedVaultPayload,
    isSelectableCard,
    selectRangeTo,
    toggleCardSelection,
    toggleNoteSelectionInPicker,
    selectedCardIds,
    clearSelection,
    resolveHtmlArtifactOpenUrl,
    closeAllVaultPopovers,
  ]);

  useEffect(() => {
    if (!previewCard) {
      setPreviewShareMenuRect(null);
      setPreviewProjectDropdownOpen(false);
      setPreviewCommentComposerOpen(false);
      setPreviewCommentDraft("");
      setPreviewEditingCommentId(null);
      return;
    }
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (previewShareMenuRect) {
        setPreviewShareMenuRect(null);
        return;
      }
      if (previewProjectDropdownOpen) {
        setPreviewProjectDropdownOpen(false);
        return;
      }
      if (previewCommentComposerOpen || previewEditingCommentId) {
        setPreviewCommentComposerOpen(false);
        setPreviewCommentDraft("");
        setPreviewEditingCommentId(null);
        return;
      }
      setPreviewCard(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewCard, previewShareMenuRect, previewProjectDropdownOpen, previewCommentComposerOpen, previewEditingCommentId]);

  // Lightbox: re-sign storage images whenever preview opens. Never rely on a
  // stale `attachment.url` (expired signed URL) as the <img> src — that path
  // is what left users staring at a supabase link / blank "Image" tile.
  useEffect(() => {
    if (!previewCard || previewCard.kind !== "attachment") {
      setPreviewFullUrl(null);
      return undefined;
    }
    const att = previewCard.attachment || {};
    const isImage =
      resolveAttachmentType(att) === "image" || looksLikeImageAttachment(att);
    if (!isImage) {
      setPreviewFullUrl(null);
      return undefined;
    }

    // Clear a prior failure so opening the card always retries.
    setFailedImageIds((prev) => {
      if (!prev.has(previewCard.id)) return prev;
      const next = new Set(prev);
      next.delete(previewCard.id);
      return next;
    });

    const original = parseStorageTarget(att);
    const medium = parseStorageTarget(att, "medium");
    const targets = [original, medium].filter(
      (t, i, arr) => t?.bucket && t?.path && arr.findIndex((x) => x.path === t.path) === i,
    );
    if (targets.length === 0) {
      setPreviewFullUrl(null);
      // Still try the grid resolver — it may recover from url parsing.
      urlResolveQueueRef.current.push(previewCard);
      drainUrlResolveQueue();
      return undefined;
    }

    let cancelled = false;
    setPreviewFullUrl(null);

    (async () => {
      for (const target of targets) {
        if (cancelled) return;
        const cacheKey = `full:${target.bucket}:${target.path}`;
        const cached = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
        if (cached) {
          setPreviewFullUrl(cached);
          setResolvedAttachmentUrls((prev) =>
            prev[previewCard.id] ? prev : { ...prev, [previewCard.id]: cached },
          );
          return;
        }
        try {
          const { data, error } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          if (!error && data?.signedUrl) {
            writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
            if (cancelled) return;
            setPreviewFullUrl(data.signedUrl);
            setResolvedAttachmentUrls((prev) => ({
              ...prev,
              [previewCard.id]: data.signedUrl,
            }));
            return;
          }
        } catch {
          /* try next target */
        }
      }
      if (!cancelled) {
        // Last resort: grid resolve pipeline (medium prefer + server fallback).
        urlResolveQueueRef.current.push({ ...previewCard, attachment: att });
        drainUrlResolveQueue();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewCard, drainUrlResolveQueue]);

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

  // Concept search behavior (local keyword pass + AI pass). State lives
  // above; see useVaultConceptSearch for why.
  const { handleConceptSearch } = useVaultConceptSearch({
    visibleCards,
    setConceptResultIds,
    setIsConceptSearching,
  });

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, selectedCardIds]);

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
  }, [isWakePreview, requireSignInForAction]);

  // AI Drive (the Studio's folder listing) — same cards drawn as a file
  // listing. See useVaultDriveWindow.
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

