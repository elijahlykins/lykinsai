import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Download,
  FileText,
  FolderInput,
  FolderKanban,
  Globe,
  Grid2X2,
  Layers,
  LayoutGrid,
  Link as LinkIcon,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Music,
  Pencil,
  Plug,
  Plus,
  Search,
  Share,
  Sparkles,
  StickyNote,
  Tag,
  Trash2,
  ArrowRight,
  Table2,
  Upload,
  Video,
  X,
  CalendarDays,
  ListTodo,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  createVaultWrites,
  getVaultRepository,
  isLocalTarget,
  localBlobUrl,
} from "@/lib/vault/repository";
import {
  AI_DRIVE_FOLDER,
  AI_DRIVE_FOLDERS,
  clearAiDriveCache,
  isAiGeneratedVaultRow,
} from "@/lib/vault/aiDriveContents";
import {
  VAULT_PICK_ITEMS_EVENT,
  VAULT_PICK_PROJECT_EVENT,
  closeVaultPicker,
  deliverVaultPick,
  pickTargetFromParams,
} from "@/lib/vault/vaultPicker";
import { lazyBackfillCardVariants } from "@/lib/vault/lazyVariantBackfill";
import {
  addNeuronsToProject,
  listUserProjects,
  removeNeuronFromProject,
} from "@/lib/userProjects";
import { emitProjectsChanged } from "@/lib/synthesis/projectLiveSync";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import VaultNewNoteChooser from "@/components/vault/VaultNewNoteChooser";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { safeExternalUrl, safeAttachmentUrl, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
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
  stripAttachmentsMarker,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import UpgradeModal from "@/components/UpgradeModal";
import SignInActionBlocker from "@/components/SignInActionBlocker";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/lib/media/youtube";
import { looksLikeImageAttachment, normalizeUrl, resolveRenderType } from "@/lib/vault/attachmentType";
import {
  buildSpacedExcerpt,
  buildTextExcerpt,
  driveFolderIdFor,
  estimateCardHeightUnit,
  extractChatPreview,
  extractYouTubeLinks,
  formatDate,
  getAttachmentHeightClass,
  getYouTubeOffsetClass,
  isSupabaseStorageUrlText,
  isUniformVaultTileClass,
  isVoiceNoteCard,
  parseAttachmentNotes,
  parseQuickNoteComments,
  parseStorageTarget,
  resolveAttachmentAspectRatio,
  resolveStableTileHeight,
  resolveTextNoteStyle,
  sanitizeCardTitle,
  stripAttachmentJsonMarker,
  textNoteLabel,
  toNumber,
  vaultPdfEmbedUrl,
  withAttachmentJsonMarker,
} from "@/lib/vault/vaultCardHelpers";
import { SocialEmbedInline } from "@/components/media/SocialEmbedInline";
import LoadingScreen from "@/components/LoadingScreen";
import LinkPreview from "@/components/LinkPreview";
import AddLinkDialog from "@/components/AddLinkDialog";
import DriveListing from "@/components/macfiles/DriveListing";
import { driveEntryFor } from "@/components/macfiles/driveKinds";
import { openFileWindow } from "@/lib/files/fileWindows";
import { canSaveFileAs, saveFileToChosenFolder } from "@/lib/files/downloadToComputer";
import LyknMediaPop from "@/components/lyknChat/LyknMediaPop";
import ReactMarkdown from "react-markdown";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import { buildWakeVaultDemoCards, WAKE_DEMO_CONNECTOR_CARD_IDS } from "@/lib/wake/wakeVaultDemoCards";
import { WAKE_WALKTHROUGH_GATE_TEXT } from "@/components/wake/wakeSynthesisAddMenu";
import {
  appendWakeVaultPreviewQuickNote,
  buildWakePreviewUserQuickNoteCards,
  readWakeVaultPreviewQuickNotes,
  removeWakeVaultPreviewQuickNote,
} from "@/lib/wake/wakeVaultPreviewQuickNotes";
import {
  appendWakeVaultPreviewComment,
  applyWakePreviewCommentsToCard,
  readWakeVaultPreviewComments,
  readWakeVaultPreviewDeletedComments,
  removeWakeVaultPreviewComment,
} from "@/lib/wake/wakeVaultPreviewComments";
import { purgeVaultNoteEmbeddings } from "@/lib/synthesis/queueReindex";
import { motion } from "framer-motion";
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

// AI Drive holds what LYKN made, and only that. Uploads, connector syncs and
// notes stay on the Vault page; two folders is the whole structure. Shared with
// aiDriveContents.ts, which lists the same items for the AI — the drive the
// model is told about has to be the drive the user is looking at.
const DRIVE_FOLDERS = AI_DRIVE_FOLDERS.map((f) => ({ id: f.id, name: f.name }));

const isAiGeneratedNote = isAiGeneratedVaultRow;

// Files whose first lines are worth showing as their preview. Everything the AI
// writes that isn't a picture or a framed page ends up here: React source, a
// CSV, a rendered document's markup. Binary formats are excluded — their bytes
// as text are noise.
const TEXT_PREVIEW_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsx", "tsx", "js", "mjs",
  "cjs", "ts", "css", "html", "htm", "xml", "yml", "yaml", "py", "rb", "sh",
  "sql", "log",
]);

// Ceiling on markup we'll inline into a preview frame. A generated page is tens
// of kilobytes; anything past this is a data blob, and its thumbnail isn't worth
// holding in memory.
const ARTIFACT_MARKUP_LIMIT = 2_000_000;

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

// Normalize a user-typed URL into a fully-qualified absolute URL.
// Accepts inputs like "youtube.com", "www.example.com/path", or
// "https://example.com" and always returns an `https://`-prefixed URL
// when the scheme is missing — without this the browser treats bare
// hostnames as relative paths (so `<a href="youtube.com">` would
// navigate to `/youtube.com` on the current origin instead of YouTube).
//
// Returns `null` for empty input or strings that can't possibly be
// URLs (e.g. a single word with no dot like "asdf"), so callers can
/**
 * What the AI Drive tells the shared file window it is looking at. Anything not
 * named here still opens in that window — the window sniffs the name and the
 * mime — so this is only for the types the vault classifies better than a file
 * extension can (an artifact is HTML that should run, not HTML to read).
 */
const DRIVE_WINDOW_MEDIA = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  html: "html",
};

/** Drive rows that are an address rather than bytes; the vault reader keeps these. */
const DRIVE_LINK_TYPES = new Set(["youtube", "bookmark", "link"]);

// The one entry in the move menu that isn't a folder name — it leaves the vault
// entirely. Fenced off so a folder someone actually names can't collide with it.
const MOVE_TO_DEVICE = "\u0000device";

// Signed-URL freshness ----------------------------------------------------
// Supabase signed URLs embed a JWT in the `?token=` query param whose `exp`
// claim is the absolute UNIX expiry. The previous implementation cached
// these URLs forever (effectively for 7 days, which was the requested TTL),
// so a long-open tab eventually served URLs that 403'd on every request.
// The retry budget would then exhaust and the user was stuck on a "Try
// again" button that re-used the same expired URL.
//
// We now (a) request short-lived URLs (1h), (b) decode the JWT to learn
// the real expiry, and (c) refetch any cached URL within 5 minutes of
// expiry so a refetch happens proactively rather than waiting for the
// browser to surface a 403.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min early

function parseSignedUrlExpiry(url) {
  try {
    const u = new URL(url);
    // Supabase signed URLs embed a JWT in `?token=`.
    const token = u.searchParams.get("token");
    if (token) {
      const parts = token.split(".");
      if (parts.length >= 2) {
        let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = payload.length % 4;
        if (pad) payload += "=".repeat(4 - pad);
        const json = JSON.parse(atob(payload));
        if (typeof json.exp === "number") return json.exp * 1000;
      }
    }
    // Branded file-proxy links: `/f/<payloadB64>.<sig>` with unix `e` in payload.
    const proxyMatch = u.pathname.match(/^\/f\/([A-Za-z0-9_-]+)\./);
    if (proxyMatch) {
      let payload = proxyMatch[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = payload.length % 4;
      if (pad) payload += "=".repeat(4 - pad);
      const json = JSON.parse(atob(payload));
      if (typeof json.e === "number") return json.e * 1000;
    }
  } catch {
    // Malformed token / non-JWT URL — caller falls back to a default TTL.
  }
  return null;
}

// Read a cached signed URL, returning null if the entry is missing OR
// within `SIGNED_URL_REFRESH_BUFFER_MS` of expiry. Stale entries are
// evicted as a side effect so subsequent reads don't re-trigger the
// expensive expiry check on every render.
function readCachedSignedUrl(cache, cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  // Back-compat: older code paths stored a bare string. Treat as
  // unknown-expiry and refetch on next miss; for now return it so we
  // don't break in-flight renders during the upgrade.
  if (typeof entry === "string") return entry;
  if (entry.expiresAt && entry.expiresAt - Date.now() <= SIGNED_URL_REFRESH_BUFFER_MS) {
    cache.delete(cacheKey);
    return null;
  }
  return entry.url;
}

function writeCachedSignedUrl(cache, cacheKey, url) {
  if (!url) return;
  const exp = parseSignedUrlExpiry(url);
  // If the JWT has no usable exp claim, assume the URL lives for the
  // configured TTL minus the refresh buffer so we still rotate it.
  const expiresAt = exp || Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  cache.set(cacheKey, { url, expiresAt });
}

function renderConnectorListCard(attachment, title, { expanded = false, compact = false } = {}) {
  const items = Array.isArray(attachment?.listItems) ? attachment.listItems : [];
  const siteLabel = attachment?.siteName || title || "Connected app";
  // Compact = grid / tags / type tiles: keep the list short so it fits a
  // square card instead of stretching the whole row.
  const maxItems = expanded ? items.length : compact ? 2 : 5;

  return (
    <div className={`rounded-2xl overflow-hidden glass-control h-full ${expanded ? "" : "cursor-pointer"}`}>
      <div className={`flex items-center gap-2 border-b border-black/8 dark:border-white/8 ${compact ? "px-2.5 py-1.5" : "px-3.5 py-2.5"}`}>
        {attachment?.favicon ? (
          <img
            src={attachment.favicon}
            alt=""
            className={`${compact ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0 object-contain`}
            draggable={false}
          />
        ) : (
          <Globe className={`${compact ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0 text-black/50 dark:text-white/50`} />
        )}
        <span className={`${compact ? "text-xs" : "text-sm"} font-medium text-black/80 dark:text-white/80 truncate`}>{siteLabel}</span>
        <span className={`ml-auto shrink-0 ${compact ? "text-[0.625rem]" : "text-[0.6875rem]"} text-black/45 dark:text-white/45`}>
          {items.length}
        </span>
      </div>
      <ul className={`divide-y divide-black/6 dark:divide-white/6 ${expanded ? "max-h-[70vh] overflow-y-auto scrollbar-hide" : "overflow-hidden"}`}>
        {items.slice(0, maxItems).map((item, index) => (
          <li key={`${item.label}-${index}`} className={compact ? "px-2.5 py-1" : "px-3.5 py-2.5"}>
            <div className={`${compact ? "text-[0.6875rem]" : "text-xs"} font-medium text-black/80 dark:text-white/80 truncate`}>{item.label}</div>
            {!compact && item.meta ? (
              <div className="text-[0.6875rem] text-black/50 dark:text-white/50 truncate mt-0.5">{item.meta}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const VAULT_VIEW_OPTIONS = [
  { id: "collage", icon: Layers, label: "Collage" },
  { id: "grid", icon: Grid2X2, label: "Grid" },
  { id: "tags", icon: Tag, label: "Tags" },
  { id: "type", icon: LayoutGrid, label: "Type" },
];

function VaultPickerTapOverlay({ show }) {
  if (!show) return null;
  return (
    <div
      className="absolute inset-0 z-[130] cursor-pointer"
      aria-hidden
      data-vault-picker-overlay="true"
    />
  );
}

// Varied heights give masonry skeletons the same staggered rhythm as real
// cards, so the placeholder reads as "content loading here" rather than a
// uniform progress block. Listed as literal class strings so Tailwind's
// scanner keeps them in the build.
const VAULT_SKELETON_HEIGHTS = [
  "h-44",
  "h-60",
  "h-52",
  "h-72",
  "h-48",
  "h-64",
  "h-40",
  "h-56",
];

function VaultLoadMoreSkeleton({ masonry = false, embedded = false, count = 10 }) {
  const tiles = Array.from({ length: count });
  if (masonry) {
    return (
      <div
        aria-hidden
        className={`mt-2 columns-2 sm:columns-3 md:columns-4 xl:columns-5 2xl:columns-6 ${
          embedded ? "gap-2" : "gap-2 md:gap-2.5"
        }`}
      >
        {tiles.map((_, i) => (
          <div
            key={`vault-skeleton-${i}`}
            className={`break-inside-avoid inline-block w-full rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] animate-pulse ${
              embedded ? "mb-2" : "mb-2"
            } ${VAULT_SKELETON_HEIGHTS[i % VAULT_SKELETON_HEIGHTS.length]}`}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={
        embedded
          ? "mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2"
          : "mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"
      }
    >
      {tiles.map((_, i) => (
        <div
          key={`vault-skeleton-${i}`}
          className="aspect-square w-full rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] animate-pulse"
        />
      ))}
    </div>
  );
}

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

/**
 * Phase 4 "why" editor — the single, scalar reason the user saved a vault
 * item (distinct from the comments thread). Self-contained so it owns its
 * draft state; the parent only supplies the initial value + a save handler.
 */
function WhyEditor({ initialValue = "", onSave, busy = false, variant = "default", onAddComment = null, commentActive = false }) {
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const cardStyle = variant === "card";

  useEffect(() => {
    setDraft(initialValue);
    setEditing(false);
  }, [initialValue]);

  const trimmed = String(initialValue || "").trim();
  const dirty = String(draft || "").trim() !== trimmed;

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    try {
      const ok = await onSave(draft);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const addCommentBtn = typeof onAddComment === "function" ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onAddComment(e);
      }}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-white transition-colors ${
        commentActive ? "bg-blue-600" : "bg-blue-500 hover:bg-blue-600"
      }`}
      title="Add comment"
      aria-label="Add comment"
      aria-expanded={commentActive}
    >
      <MessageCircle className="w-3.5 h-3.5" />
    </button>
  ) : null;

  if (!editing && trimmed) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className={cardStyle
            ? "text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40"
            : "text-xs text-black/45 dark:text-white/45"}>
            Why I saved this
          </p>
          <div className="flex items-center gap-1.5">
            {addCommentBtn}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cardStyle
                ? "p-1 rounded-md text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                : "text-xs text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"}
              title="Edit"
              aria-label="Edit why you saved this"
            >
              {cardStyle ? <Pencil className="w-3.5 h-3.5" /> : "Edit"}
            </button>
          </div>
        </div>
        <p className="text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{trimmed}</p>
      </div>
    );
  }

  if (!editing && !trimmed) {
    return (
      <div className="space-y-1.5">
        {cardStyle ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40">
              Why I saved this
            </p>
            <div className="flex items-center gap-1.5">
              {addCommentBtn}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="p-1 rounded-md text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                title="Add why"
                aria-label="Add why you saved this"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cardStyle
            ? "text-left text-sm italic text-black/35 dark:text-white/35 hover:text-black/55 dark:hover:text-white/55 transition-colors"
            : "text-left text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"}
        >
          Add why you saved this
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className={cardStyle
          ? "text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40"
          : "text-xs text-black/45 dark:text-white/45"}>
          Why I saved this
        </p>
        {addCommentBtn}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoFocus
        rows={3}
        maxLength={2000}
        placeholder="A short note on why this matters to you…"
        className="w-full resize-y bg-transparent border-0 border-b border-black/15 dark:border-white/15 px-0 py-1.5 text-sm text-black/85 dark:text-white/85 outline-none focus:border-black/40 dark:focus:border-white/40"
      />
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || busy || !dirty}
          className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setDraft(initialValue); setEditing(false); }}
          className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
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

  const [showQuickNote, setShowQuickNote] = useState(false);
  const [showNewNoteChooser, setShowNewNoteChooser] = useState(false);
  const [wakePreviewQuickNotes, setWakePreviewQuickNotes] = useState(() =>
    wakePreview ? readWakeVaultPreviewQuickNotes() : [],
  );
  const [wakePreviewCardComments, setWakePreviewCardComments] = useState(() =>
    wakePreview ? readWakeVaultPreviewComments() : {},
  );
  const [wakePreviewDeletedComments, setWakePreviewDeletedComments] = useState(() =>
    wakePreview ? readWakeVaultPreviewDeletedComments() : {},
  );
  const [orderByPage, setOrderByPage] = useState({ everything: [] });
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
  const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState({});
  // Full-res signed URL for the open lightbox (original storage object).
  // Grid tiles use the medium variant; opening an image upgrades to original
  // so expanded viewing stays sharp on retina.
  const [previewFullUrl, setPreviewFullUrl] = useState(null);
  // Signed URLs for video poster frames (the generated thumb/medium JPEG).
  // Used as the <video poster> so grid cards show a real frame instead of a
  // black box while the video itself only preloads metadata.
  const [resolvedVideoPosterUrls, setResolvedVideoPosterUrls] = useState({});
  // AI Drive previews artifacts from their own markup (cardId → HTML source)
  // rather than by framing the file proxy. See `resolveDriveMarkupForCard`.
  const [driveMarkup, setDriveMarkup] = useState({});
  const driveMarkupTriedRef = useRef(new Set());
  const [failedImageIds, setFailedImageIds] = useState(new Set());
  const imageRetryCountsRef = useRef(new Map());
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
  const [isCardActionBusy, setIsCardActionBusy] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [chatChunkDragOver, setChatChunkDragOver] = useState(false);
  const chatChunkDragDepthRef = useRef(0);
  const [showSaveLink, setShowSaveLink] = useState(false);
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
  const [isSaveLinkSaving, setIsSaveLinkSaving] = useState(false);
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
  const handleRequestSaveLink = useCallback(() => {
    if (requireSignInForAction()) return;
    setShowSaveLink(true);
  }, [requireSignInForAction]);
  const handleToggleQuickNote = useCallback(() => {
    if (isWakePreview) {
      setShowQuickNote((v) => !v);
      return;
    }
    if (requireSignInForAction()) return;
    if (showQuickNote) {
      setShowQuickNote(false);
      return;
    }
    setShowNewNoteChooser(true);
  }, [requireSignInForAction, isWakePreview, showQuickNote]);

  const handleChooseWrittenNote = useCallback(() => {
    setShowNewNoteChooser(false);
    setShowQuickNote(true);
  }, []);
  const [isConceptSearching, setIsConceptSearching] = useState(false);
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [showEmbeddedTagDropdown, setShowEmbeddedTagDropdown] = useState(false);
  const embeddedTagDropdownRef = useRef(null);
  const [showVaultViewDropdown, setShowVaultViewDropdown] = useState(false);
  const vaultViewDropdownRef = useRef(null);
  const [tagPickerCardId, setTagPickerCardId] = useState(null);
  const [tagPickerPosition, setTagPickerPosition] = useState(null);
  const [newTagInput, setNewTagInput] = useState("");
  const tagPickerRef = useRef(null);
  const conceptSearchAbortRef = useRef(null);
  const lastHoverTargetRef = useRef(null);
  const loadMoreRef = useRef(null);
  const cardMenuRef = useRef(null);
  const noteComposerRef = useRef(null);
  const previewShareMenuRef = useRef(null);
  const previewProjectDropdownRef = useRef(null);
  const signedUrlCacheRef = useRef(new Map());

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

  useEffect(() => {
    if (!loadMoreRef.current || loading || !user?.id) return;
    const target = loadMoreRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        setSentinelInView(!!entries[0]?.isIntersecting);
      },
      { rootMargin: "320px 0px 320px 0px" }
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      setSentinelInView(false);
    };
    // `vaultView` is included so the observer re-attaches to the sentinel that
    // the freshly-rendered view branch mounts (each view renders its own).
  }, [loading, user?.id, vaultView]);

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

  /**
   * Drops the deep-link params once they've been acted on, so a re-render (or
   * a refresh) doesn't reopen what the user has since closed. Routed rather
   * than replaceState'd: the effect that reads them watches the router's
   * location, and history alone would leave it looking at a stale search.
   */
  const clearDriveLinkParams = useCallback(() => {
    const next = new URLSearchParams(location.search);
    if (!next.has("folder") && !next.has("note")) return;
    next.delete("folder");
    next.delete("note");
    const search = next.toString();
    nav({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
  }, [location.pathname, location.search, nav]);

  const [allTagsRaw, setAllTagsRaw] = useState([]);

  useEffect(() => {
    if (!user?.id) { setAllTagsRaw([]); return; }
    let cancelled = false;
    (async () => {
      // Prefer the backend's own aggregation: migration 053's RPC in the
      // cloud, a single SQL pass over the local table on device. Either way
      // this avoids pulling every tag cell into the browser and counting them
      // on the main thread.
      try {
        const rpcData = await getVaultRepository(user.id).tagCounts();
        if (cancelled) return;
        if (Array.isArray(rpcData)) {
          setAllTagsRaw(
            rpcData
              .map((row) => ({
                name: String(row.tag || "").trim(),
                count: Number(row.count) || 0,
              }))
              .filter((entry) => entry.name),
          );
          return;
        }
        // Anything else falls through to the legacy path below.
      } catch (e) {
        // The RPC may simply not be deployed yet (PGRST202 = function not
        // found); a transient blip must not blank the directory either.
        if (cancelled) return;
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Vault] vault_tag_counts RPC threw, using fallback:", e);
        }
      }

      // Legacy in-browser aggregation. Kept as a safety net for envs
      // missing migration 053. Capped at 5000 rows so a runaway account
      // can't OOM the tab while the RPC migration is pending.
      //
      // Cloud-only: the local store has no such gap, and falling back here
      // would quietly read the vault the user just migrated away from.
      if (getVaultRepository(user.id).backend !== "supabase") {
        setAllTagsRaw([]);
        return;
      }
      const { data, error } = await supabase
        .from("vault_items")
        .select("tags")
        .eq("user_id", user.id)
        .not("tags", "is", null)
        .limit(5000);
      if (cancelled) return;
      if (error || !data) { setAllTagsRaw([]); return; }
      const tagMap = {};
      data.forEach((row) => {
        (row.tags || []).forEach((t) => {
          const tag = String(t).trim();
          if (!tag) return;
          if (!tagMap[tag]) tagMap[tag] = 0;
          tagMap[tag] += 1;
        });
      });
      setAllTagsRaw(
        Object.entries(tagMap)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count }))
      );
    })();
    return () => { cancelled = true; };
    // Depend on `notes.length` (not `notes`) so this query doesn't
    // re-run on every tag-toggle, attachment edit, or content rewrite —
    // those don't change the global tag distribution we'd hit the DB
    // for. The visible-cards-derived `allTags` fallback in the memo
    // below still picks up local tag changes between refetches.
  }, [user?.id, notes.length]);

  // Guests have no rows in Supabase, so `allTagsRaw` stays empty. Fall back
  // to deriving the top tag filter row from whatever cards are rendered
  // (including the starter-pack demo cards) so the filter bar isn't empty
  // pre sign-in. For signed-in users we keep the DB-sourced counts because
  // they reflect ALL notes, not just the ones currently on screen.
  const allTags = useMemo(() => {
    if (allTagsRaw.length > 0) return allTagsRaw;
    const tagMap = {};
    vaultCards.forEach((card) => {
      (card.tags || []).forEach((t) => {
        const tag = String(t).trim();
        if (!tag) return;
        tagMap[tag] = (tagMap[tag] || 0) + 1;
      });
    });
    return Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [allTagsRaw, vaultCards]);

  const updateNoteTags = useCallback(
    async (noteId, newTags) => {
      if (!user?.id) return false;
      const { error } = await vaultWrites.update(noteId, { tags: newTags });
      if (error) {
        if (import.meta.env.DEV) console.error("Failed to update tags:", error);
        return false;
      }
      setNotes((prev) =>
        prev.map((n) => (String(n.id) === String(noteId) ? { ...n, tags: newTags } : n))
      );
      return true;
    },
    [user?.id]
  );

  const toggleCardTag = useCallback(
    async (noteId, tag) => {
      const note = notes.find((n) => String(n.id) === String(noteId));
      if (!note) return;
      const current = Array.isArray(note.tags) ? [...note.tags] : [];
      const idx = current.indexOf(tag);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(tag);
      await updateNoteTags(noteId, current);
    },
    [notes, updateNoteTags]
  );

  const createAndAssignTag = useCallback(
    async (noteId, tagName) => {
      const trimmed = tagName.trim();
      if (!trimmed || !noteId) return;
      const note = notes.find((n) => String(n.id) === String(noteId));
      if (!note) return;
      const current = Array.isArray(note.tags) ? [...note.tags] : [];
      if (!current.includes(trimmed)) {
        current.push(trimmed);
        await updateNoteTags(noteId, current);
      }
    },
    [notes, updateNoteTags]
  );

  const visibleCardIdsRef = useRef(new Set());
  const urlResolveObserverRef = useRef(null);

  // For image-type attachments, pre-load the image with `new Image()`
  // (HEAD-style) before triggering the React state update that mounts
  // the real <img>. This:
  //   1. captures naturalWidth/Height into `learnedImageDimsRef`, so
  //      the wrapper can reserve correct aspect-ratio from first paint
  //      (eliminates the "card grows from skeleton size to real size"
  //      jump that caused the visible scroll glitch);
  //   2. seeds the browser HTTP cache, so the real <img> paints
  //      instantly when it mounts.
  //
  // We give it a budget — if dims don't come back within 600ms we
  // setState anyway. Better to risk a small first-load shift on a slow
  // image than to leave the user staring at a skeleton.
  const resolveImageDimsAndCommit = useCallback((cardId, signedUrl) => {
    const PROBE_BUDGET_MS = 1200;
    const learned = learnedImageDimsRef.current.get(signedUrl);
    if (learned) {
      // Already know dims (preload covered it, or we've seen this URL).
      // Commit immediately — the wrapper will reserve correctly.
      setResolvedAttachmentUrls((prev) => {
        if (prev[cardId]) return prev;
        return { ...prev, [cardId]: signedUrl };
      });
      return;
    }
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      setResolvedAttachmentUrls((prev) => {
        if (prev[cardId]) return prev;
        return { ...prev, [cardId]: signedUrl };
      });
    };
    const probe = new window.Image();
    probe.crossOrigin = "anonymous";
    const budgetTimer = setTimeout(commit, PROBE_BUDGET_MS);
    probe.onload = () => {
      clearTimeout(budgetTimer);
      const nw = probe.naturalWidth;
      const nh = probe.naturalHeight;
      if (nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(signedUrl)) {
        learnedImageDimsRef.current.set(signedUrl, { w: nw, h: nh });
      }
      commit();
    };
    probe.onerror = () => {
      // Network/CORS fail on the probe — let the real <img> retry path
      // handle it. Commit the URL so the user at least sees the
      // skeleton replaced with the real <img> (which will trigger its
      // own retry-with-fresh-signed-URL flow on error).
      clearTimeout(budgetTimer);
      commit();
    };
    probe.src = signedUrl;
  }, []);

  const resolveSignedUrlForCard = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return;
    // Grid cards prefer the medium variant for images (sharp on retina tiles);
    // thumb is reserved for video posters. Video keeps the original playable
    // file (its variant is a poster JPEG, not a playable file).
    const cardType = resolveAttachmentType(card.attachment || {});
    const isImage = cardType === "image";
    // Existing images without variants: backfill them in the background on
    // first view so future loads use the medium / thumb renditions.
    if (isImage && user?.id && card.noteId) {
      lazyBackfillCardVariants({ userId: user.id, noteId: card.noteId, attachment: card.attachment || {} });
    }

    // Video poster: sign the generated thumb/medium JPEG (if any) so the grid
    // <video> can show a real frame instead of a black box. Best-effort and
    // independent of the playable-original resolution below.
    if (cardType === "video") {
      const posterTarget = parseStorageTarget(card.attachment || {}, "thumb");
      const originalTarget = parseStorageTarget(card.attachment || {});
      // parseStorageTarget falls back to the original when no variant exists;
      // only treat it as a poster when it's actually a distinct variant path.
      const hasPosterVariant =
        posterTarget?.path &&
        posterTarget?.bucket &&
        posterTarget.path !== originalTarget?.path;
      if (hasPosterVariant) {
        const posterKey = `${posterTarget.bucket}:${posterTarget.path}`;
        const cachedPoster = readCachedSignedUrl(signedUrlCacheRef.current, posterKey);
        if (cachedPoster) {
          setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: cachedPoster }));
        } else {
          supabase.storage
            .from(posterTarget.bucket)
            .createSignedUrl(posterTarget.path, SIGNED_URL_TTL_SECONDS)
            .then(({ data }) => {
              if (data?.signedUrl) {
                writeCachedSignedUrl(signedUrlCacheRef.current, posterKey, data.signedUrl);
                setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: data.signedUrl }));
              }
            })
            .catch(() => {});
        }
      } else if (user?.id && card.noteId) {
        // Legacy video with no poster yet: generate one on first view, store
        // it, and show it live so the card stops being a black box.
        lazyBackfillCardVariants({
          userId: user.id,
          noteId: card.noteId,
          attachment: card.attachment || {},
          onPosterReady: ({ bucket, variantThumbPath, variantMediumPath }) => {
            const path = String(variantThumbPath || variantMediumPath || "").trim();
            if (!path) return;
            const posterKey = `${bucket}:${path}`;
            const cached = readCachedSignedUrl(signedUrlCacheRef.current, posterKey);
            if (cached) {
              setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: cached }));
              return;
            }
            supabase.storage
              .from(bucket)
              .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
              .then(({ data }) => {
                if (data?.signedUrl) {
                  writeCachedSignedUrl(signedUrlCacheRef.current, posterKey, data.signedUrl);
                  setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: data.signedUrl }));
                }
              })
              .catch(() => {});
          },
        });
      }
    }
    const isHtml = cardType === "html";
    const target = parseStorageTarget(card.attachment || {}, isImage ? "medium" : null);
    if (!target?.path || !target?.bucket) {
      const rawUrl = String(card.attachment?.url || "").trim();
      if (rawUrl && (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || !rawUrl.includes("supabase.co/storage/"))) {
        return;
      }
      setFailedImageIds((prev) => new Set(prev).add(card.id));
      return;
    }
    // HTML previews MUST use the branded file proxy (correct MIME +
    // frame-ancestors + permissive script CSP for React/Babel runners).
    // Raw Supabase signed URLs blank the iframe (text/plain / frame deny),
    // so never cache a storage URL under the file-proxy key — that poisoned
    // both the grid tile and the click-to-open view mode permanently.
    const cacheKey = isHtml
      ? `file-proxy:${target.bucket}:${target.path}`
      : `${target.bucket}:${target.path}`;
    const isSupabaseStorageUrl = (u) => /supabase\.co\/storage\//i.test(String(u || ""));
    const commitUrl = (signedUrl, { force = false } = {}) => {
      if (isImage) {
        // Image path: probe dims first so the slot reserves correctly,
        // then setState. See `resolveImageDimsAndCommit` for the full
        // budget/fallback story.
        resolveImageDimsAndCommit(card.id, signedUrl);
      } else {
        setResolvedAttachmentUrls((prev) => {
          if (!force && prev[card.id] && !isSupabaseStorageUrl(prev[card.id])) return prev;
          return { ...prev, [card.id]: signedUrl };
        });
      }
    };
    // Bytes already on this device need no signing, no cache and no expiry —
    // the protocol handler in the main process serves them straight off disk.
    // Checked before the cache so a local card never takes an entry that
    // exists only to track a TTL it does not have.
    if (isLocalTarget(target)) {
      const blobUrl = localBlobUrl(target.path);
      if (blobUrl) {
        commitUrl(blobUrl, { force: true });
        return;
      }
    }

    const cachedFresh = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
    // Ignore a poisoned cache entry that somehow stored a storage URL as
    // a "file-proxy" result from an older build.
    if (cachedFresh && !(isHtml && isSupabaseStorageUrl(cachedFresh))) {
      commitUrl(cachedFresh);
      return;
    }

    if (isHtml) {
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const session = (await supabase.auth.getSession())?.data?.session;
        const token = session?.access_token;
        if (token) {
          const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              storagePath: target.path,
              bucket: target.bucket,
              filename: String(card.attachment?.name || "artifact.html"),
            }),
          });
          if (resp.ok) {
            const { url } = await resp.json();
            if (url && !isSupabaseStorageUrl(url)) {
              writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
              commitUrl(url, { force: true });
              return;
            }
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[Vault] File-proxy URL mint failed:", err);
      }
      // Do NOT fall back to a raw Supabase signed URL for HTML — it paints a
      // permanent white blank in the iframe. Surface "unavailable" instead.
      imageRetryCountsRef.current.set(card.id, 99);
      setFailedImageIds((prev) => new Set(prev).add(card.id));
      visibleCardIdsRef.current.delete(card.id);
      return;
    }

    let objectNotFound = false;
    try {
      const { data, error } = await supabase.storage
        .from(target.bucket)
        .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
      if (data?.signedUrl) {
        writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
        commitUrl(data.signedUrl);
        return;
      }
      if (error) {
        objectNotFound = /not found/i.test(error.message || "");
        if (!objectNotFound && import.meta.env.DEV) console.warn("[Vault] Signed URL error for", target.path, error.message);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[Vault] Signed URL exception for", target.path, err);
    }
    if (!objectNotFound) {
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const session = (await supabase.auth.getSession())?.data?.session;
        const token = session?.access_token;
        if (token) {
          const resp = await fetch(`${API_BASE_URL}/api/storage/signed-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ storagePath: target.path, bucket: target.bucket }),
          });
          if (resp.ok) {
            const { signedUrl } = await resp.json();
            if (signedUrl) {
              writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signedUrl);
              commitUrl(signedUrl);
              return;
            }
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[Vault] Server-side signed URL fallback failed:", err);
      }
    }
    imageRetryCountsRef.current.set(card.id, 99);
    setFailedImageIds((prev) => new Set(prev).add(card.id));
    visibleCardIdsRef.current.delete(card.id);
  }, [resolveImageDimsAndCommit, user?.id]);

  /**
   * Reads an artifact's markup so AI Drive can render it itself.
   *
   * The obvious way to preview an artifact is to frame the file proxy, which is
   * what the Vault grid does — but the proxy names the origins allowed to embed
   * it in `frame-ancestors`, and the desktop shell isn't one of them, so the
   * frame is refused and paints nothing. Fetching the markup and handing it to
   * a `srcDoc` frame has no such header to satisfy: the document is inlined by
   * this app, not loaded from the proxy.
   *
   * Storage is signed directly (rather than proxied) because only storage
   * answers a cross-origin fetch. Local-first vaults read straight off disk.
   */
  const resolveDriveMarkupForCard = useCallback(async (card) => {
    if (!studioSurface || card?.kind !== "attachment") return;
    if (resolveAttachmentType(card.attachment || {}) !== "html") return;
    if (driveMarkupTriedRef.current.has(card.id)) return;
    driveMarkupTriedRef.current.add(card.id);

    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) {
      driveMarkupTriedRef.current.delete(card.id);
      return;
    }

    let url = "";
    if (isLocalTarget(target)) {
      url = localBlobUrl(target.path) || "";
    } else {
      const cacheKey = `${target.bucket}:${target.path}`;
      url = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey) || "";
      if (!url) {
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          url = data?.signedUrl || "";
          if (url) writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
        } catch {
          driveMarkupTriedRef.current.delete(card.id);
          return;
        }
      }
    }
    if (!url) {
      driveMarkupTriedRef.current.delete(card.id);
      return;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      const size = Number(resp.headers.get("content-length") || 0);
      if (size > ARTIFACT_MARKUP_LIMIT) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      const markup = await resp.text();
      if (!markup.trim()) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      setDriveMarkup((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: markup.slice(0, ARTIFACT_MARKUP_LIMIT) }));
    } catch {
      // Offline, most likely — worth another go when it scrolls back into view.
      // The cover stands in for it meanwhile.
      driveMarkupTriedRef.current.delete(card.id);
    }
  }, [studioSurface]);

  // Opening the viewport must not wait on artifact I/O. Once it is mounted,
  // resolve any missing markup and let the portal re-render with srcDoc.
  useEffect(() => {
    const card = previewCard;
    if (!studioSurface || card?.kind !== "attachment") return;
    if (resolveAttachmentType(card.attachment || {}) !== "html") return;
    if (driveMarkup[card.id]) return;
    driveMarkupTriedRef.current.delete(card.id);
    void resolveDriveMarkupForCard(card);
  }, [previewCard, studioSurface, driveMarkup, resolveDriveMarkupForCard]);

  const cardElementsRef = useRef(new Map());

  const registerCardRef = useCallback((cardId, element) => {
    if (element) {
      cardElementsRef.current.set(cardId, element);
      urlResolveObserverRef.current?.observe(element);
    } else {
      const prev = cardElementsRef.current.get(cardId);
      if (prev) urlResolveObserverRef.current?.unobserve(prev);
      cardElementsRef.current.delete(cardId);
    }
  }, []);

  const urlResolveQueueRef = useRef([]);
  const urlResolveDrainingRef = useRef(false);

  const drainPromiseRef = useRef(null);
  const drainUrlResolveQueue = useCallback(async () => {
    if (urlResolveDrainingRef.current) return drainPromiseRef.current;
    urlResolveDrainingRef.current = true;
    drainPromiseRef.current = (async () => {
      while (urlResolveQueueRef.current.length > 0) {
        const batch = urlResolveQueueRef.current.splice(0, 20);
        // Artifact markup is read alongside the signing pass, not after it: the
        // proxy URL it would otherwise wait on is the thing AI Drive can't use.
        for (const card of batch) void resolveDriveMarkupForCard(card);
        await Promise.allSettled(batch.map((card) => resolveSignedUrlForCard(card)));
      }
      urlResolveDrainingRef.current = false;
    })();
    return drainPromiseRef.current;
  }, [resolveSignedUrlForCard, resolveDriveMarkupForCard]);

  useEffect(() => {
    if (!user?.id) return;
    const cardLookup = new Map(vaultCards.map((c) => [c.id, c]));
    visibleCardIdsRef.current.clear();

    urlResolveObserverRef.current = new IntersectionObserver(
      (entries) => {
        let queued = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cardId = entry.target.dataset?.cardId;
          if (!cardId || visibleCardIdsRef.current.has(cardId)) continue;
          visibleCardIdsRef.current.add(cardId);
          const card = cardLookup.get(cardId);
          if (card) {
            urlResolveQueueRef.current.push(card);
            queued = true;
          }
        }
        if (queued) drainUrlResolveQueue();
      },
      // 1200px lead time: this needs to cover (signed-URL fetch time)
      // + (image probe download time) + (decode) so that by the time
      // the card actually enters the viewport, we already have its
      // dimensions in `learnedImageDimsRef` and the image bytes in
      // the HTTP cache. ~3-4 rows ahead at typical row heights.
      // Trade-off: too aggressive wastes bandwidth on cards the user
      // never reaches; too conservative leaves visible layout shifts
      // on first scroll. 1200px is the sweet spot for typical scroll
      // velocity on a feed-style grid.
      { rootMargin: "1200px" }
    );

    for (const [, el] of cardElementsRef.current) {
      urlResolveObserverRef.current.observe(el);
    }

    return () => {
      urlResolveObserverRef.current?.disconnect();
      urlResolveObserverRef.current = null;
    };
  }, [vaultCards, user?.id, resolveSignedUrlForCard, drainUrlResolveQueue]);

  // Caches the natural width/height of every image we've loaded at
  // least once, keyed by URL. Used by the image render path to set the
  // `<img>`'s `width` + `height` HTML attributes on subsequent renders
  // so the browser can reserve the correct aspect-ratio slot BEFORE
  // the image loads. Without this, scrolling new cards into view caused
  // the card to grow/shrink from the placeholder height to the real
  // image height, which cascaded into "cards shifting up and down"
  // jitter for the rest of the visible row.
  //
  // We use a ref (not state) on purpose — we only want this data to
  // influence the next render of the same component instance, not
  // trigger a global re-render every time an image loads.
  const learnedImageDimsRef = useRef(new Map());

  // Tracks image URLs we've already pre-DECODED (not just downloaded).
  // The render path uses this to skip the per-image opacity fade-in for
  // first-viewport images so they reveal atomically instead of popping
  // in one at a time. See `renderAttachmentCard` below for the
  // consumer side.
  //
  // `image.decode()` (vs plain `new Image().onload`) is the key: onload
  // fires when bytes arrive, but the GPU bitmap isn't ready yet. The
  // first paint then triggers a synchronous decode, and because each
  // image's decode finishes on a different frame, every card's
  // `transition-opacity` starts at a slightly different moment — which
  // is exactly the "popcorn" / "glitching" effect users see on first
  // load.
  const preDecodedUrlsRef = useRef(new Set());

  // ── Dimension backfill (self-heal the existing vault) ──────────────────
  // New uploads now store intrinsic width/height (see uploadPipeline.ts), so
  // the masonry estimate + skeleton + image all reserve the SAME aspect from
  // first paint — zero layout shift. Items uploaded before that change have
  // no stored dims, so they still shift their column once when the image
  // resolves. This persister closes that gap: the first time we learn an
  // image's real natural dimensions (from the <img> onLoad / preload probe),
  // we write them back into the note's attachment marker. From then on the
  // card reserves its true aspect on every load — the vault converges to a
  // totally shift-free feed as the user browses it once.
  const persistDimsAttemptedRef = useRef(new Set());
  const persistDimsQueueRef = useRef([]);
  const persistDimsDrainingRef = useRef(false);
  const drainPersistDimsQueue = useCallback(async () => {
    if (persistDimsDrainingRef.current) return;
    persistDimsDrainingRef.current = true;
    try {
      while (persistDimsQueueRef.current.length > 0) {
        const job = persistDimsQueueRef.current.shift();
        if (!job?.noteId || !user?.id) continue;
        try {
          const { data: note } = await vaultWrites.readForUpdate(job.noteId);
          if (!note?.content) continue;
          const span = findAttachmentsMarker(String(note.content));
          if (!span) continue;
          const attachments = span.attachments.slice();
          const idx = job.attachmentIndex ?? 0;
          const current = attachments[idx];
          if (!current || typeof current !== "object") continue;
          // Someone (a newer upload path, a concurrent backfill) may have
          // filled dims since we queued — don't trample.
          if (resolveAttachmentAspectRatio(current)) continue;
          attachments[idx] = { ...current, width: job.w, height: job.h };
          const updatedContent = withAttachmentsMarker(String(note.content), attachments);
          // Lost-update guard: only commit if the row hasn't changed since
          // we read it, so we never clobber a concurrent edit / description
          // backfill writing the same row.
          const { error } = await vaultWrites.updateIfUnchanged(
            job.noteId,
            { content: updatedContent },
            note.updated_at,
          );
          if (error) continue;
          // Intentionally NOT updating the in-memory notes here. Feeding the
          // freshly-learned dims back into the live card would change its
          // masonry height estimate and could re-bucket it into a different
          // column WHILE the user is looking — the exact jump we're killing.
          // The DB now has the dims; the NEXT cold load reserves the true
          // aspect from first paint. Within this session the already-resolved
          // image is shift-free via learnedImageDimsRef.
          // Gentle pacing so a freshly-opened vault full of legacy images
          // doesn't fire dozens of writes in the same tick.
          await new Promise((r) => setTimeout(r, 400));
        } catch {
          // best-effort — a failed backfill just leaves the old behaviour
          // for that one card; we'll retry next session.
        }
      }
    } finally {
      persistDimsDrainingRef.current = false;
    }
  }, [user?.id]);

  const queuePersistAttachmentDims = useCallback(
    (card, w, h) => {
      if (!card?.noteId || card.kind !== "attachment") return;
      if (!(w > 0) || !(h > 0)) return;
      // Skip connector-synced / demo / ghost cards and anything that already
      // carries usable dimensions.
      if (card.ghost || card.isDemo) return;
      if (resolveAttachmentAspectRatio(card.attachment)) return;
      if (persistDimsAttemptedRef.current.has(card.id)) return;
      persistDimsAttemptedRef.current.add(card.id);
      persistDimsQueueRef.current.push({
        noteId: card.noteId,
        attachmentIndex: card.attachmentIndex ?? 0,
        w: Math.round(w),
        h: Math.round(h),
      });
      void drainPersistDimsQueue();
    },
    [drainPersistDimsQueue]
  );

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

  // Tab-refocus recovery -------------------------------------------------
  // If the user leaves a vault tab open for hours/days and comes back,
  // every cached signed URL is likely either expired or about to expire.
  // The on-demand `readCachedSignedUrl` expiry check covers most reads,
  // but cards already mounted with their (now-stale) URL won't refetch
  // on their own — they only retry on a 4xx, and even then they burn
  // through their bounded retry budget. This effect makes refocus
  // recovery deterministic: if the tab was hidden for >2 minutes we
  // wipe the URL cache + retry counts and force currently-visible
  // attachment cards back through `resolveSignedUrlForCard` so they
  // pick up fresh URLs immediately.
  useEffect(() => {
    if (!user?.id) return;
    let hiddenAt = null;
    const STALE_AFTER_MS = 2 * 60 * 1000;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState !== "visible" || hiddenAt === null) return;
      const wasHiddenFor = Date.now() - hiddenAt;
      hiddenAt = null;
      if (wasHiddenFor < STALE_AFTER_MS) return;
      // Drop every cached signed URL — most are stale and the cost of
      // re-signing the still-fresh ones is negligible compared to the
      // UX cost of showing broken/expired images.
      signedUrlCacheRef.current.clear();
      // Forgive the retry budget so users get a clean slate after
      // returning to the tab.
      imageRetryCountsRef.current.clear();
      const failedIdsToRequeue = Array.from(failedImageIds);
      if (failedIdsToRequeue.length > 0) {
        setFailedImageIds(new Set());
      }
      // Re-queue every currently-visible attachment card so the new
      // signed URLs land before the user notices anything is wrong.
      const cardsByIdLocal = new Map(vaultCards.map((c) => [c.id, c]));
      const visibleIds = new Set([...visibleCardIdsRef.current, ...failedIdsToRequeue]);
      let queued = false;
      for (const id of visibleIds) {
        const card = cardsByIdLocal.get(id);
        if (!card || card.kind !== "attachment") continue;
        // Drop any stale resolved URL so the next render either shows
        // the spinner (briefly) or, more often, the image just swaps
        // to the fresh URL the moment `setResolvedAttachmentUrls`
        // fires — no broken-image flash in between.
        setResolvedAttachmentUrls((prev) => {
          if (!(card.id in prev)) return prev;
          const next = { ...prev };
          delete next[card.id];
          return next;
        });
        visibleCardIdsRef.current.delete(card.id);
        visibleCardIdsRef.current.add(card.id);
        urlResolveQueueRef.current.push(card);
        queued = true;
      }
      if (queued) drainUrlResolveQueue();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, vaultCards, drainUrlResolveQueue, failedImageIds]);

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

  const orderStorageKey = useMemo(
    () => (user?.id ? `vault_collage_order_v1_${user.id}` : "vault_collage_order_v1_guest"),
    [user?.id]
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(orderStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Current saves only write `{ everything }` (the legacy `chats` page
      // was removed); requiring `chats` here made every restore silently
      // fail, so manual drag-order never survived a refresh.
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.everything)
      ) {
        setOrderByPage({ everything: parsed.everything });
      }
    } catch {
      // ignore localStorage parse issues
    }
  }, [orderStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(orderStorageKey, JSON.stringify(orderByPage));
    } catch {
      // ignore localStorage write issues
    }
  }, [orderByPage, orderStorageKey]);

  useEffect(() => {
    // Only persist the user's real preference. Wake-preview forces "grid" and
    // picker mode forces "collage" (see the vaultView initializer + isPickerMode
    // effect); if we wrote those forced values back to localStorage they'd
    // clobber the stored preference, so the next normal vault load would wrongly
    // default to the forced view.
    if (isWakePreview || isPickerMode) return;
    try { localStorage.setItem(viewStorageKey, vaultView); } catch {}
  }, [vaultView, isWakePreview, isPickerMode, viewStorageKey]);

  const orderedVisibleCards = useMemo(() => {
    // Source-folder tiles (the Notion/Gmail/Slack/etc. summary cards) are
    // pinned to the top of the grid no matter what the user's manual
    // drag-reorder state looks like. The intent is "your connected apps
    // are always the first thing you see" — equivalent to the macOS
    // dock's leading-edge anchor — so even after a user has dragged
    // their own memories around, the connector row stays put.
    //
    // Among themselves the tiles sort by recency of last-touched item
    // (most active connector first). We deliberately do NOT thread them
    // through `orderByPage` because:
    //   • Source-folder cards are synthetic — they vanish when a
    //     connector is disconnected and reappear on next sync, so
    //     persisting their position in localStorage would leak stale
    //     ids.
    //   • Dragging them is already blocked in handleCardDragStart
    //     (they collapse N real cards behind one tile; reordering
    //     across that boundary has no sensible target), so there's
    //     nothing the user could persist anyway.
    const folderCards = [];
    const otherCards = [];
    for (const card of filteredVisibleCards) {
      if (card.kind === "source-folder" || card.kind === "drive-folder") folderCards.push(card);
      else otherCards.push(card);
    }
    folderCards.sort((a, b) => (b.lastTouchedMs || 0) - (a.lastTouchedMs || 0));

    // Default ordering for the user's own memories is UPLOAD TIME, newest
    // first, so freshly uploaded items always surface right below the
    // connected-app folders. Any card the user has explicitly drag-reordered
    // is pinned by `orderByPage` and keeps its manual position BELOW the
    // freshly-sorted ones (the drag handler snapshots the full visible order,
    // so once a user arranges things, those ids live in `currentOrder`).
    const currentOrder = orderByPage.everything || [];
    const orderedIdSet = new Set(currentOrder);
    const visibleMap = new Map(otherCards.map((card) => [card.id, card]));
    const manuallyOrdered = currentOrder.map((id) => visibleMap.get(id)).filter(Boolean);
    const byUploadTime = otherCards
      .filter((card) => !orderedIdSet.has(card.id))
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    return [...folderCards, ...byUploadTime, ...manuallyOrdered];
  }, [filteredVisibleCards, orderByPage]);

  const wakeConnectorStripCards = useMemo(() => {
    if (!isWakePreview) return [];
    return WAKE_DEMO_CONNECTOR_CARD_IDS
      .map((id) => orderedVisibleCards.find((card) => card.id === id))
      .filter(Boolean);
  }, [isWakePreview, orderedVisibleCards]);

  const wakeCollageCards = useMemo(() => {
    if (!isWakePreview) return orderedVisibleCards;
    const connectorIds = new Set(WAKE_DEMO_CONNECTOR_CARD_IDS);
    return orderedVisibleCards.filter((card) => !connectorIds.has(card.id));
  }, [isWakePreview, orderedVisibleCards]);

  // ── Batched reveal (feed views) ────────────────────────────────────────
  // Collage (masonry) and Grid are "feed" views: instead of dumping every
  // fetched card on screen at once, they reveal in groups of REVEAL_BATCH.
  // When the user scrolls to the bottom we show that many skeletons and gate
  // the next group on its media actually resolving/decoding — so the user
  // never scrolls into a wall of empty placeholders, and the page only grows
  // once the next batch is genuinely ready. Tags/Type are grouped views and
  // always render their full set.
  const REVEAL_BATCH = 7;
  const isFeedView = !isWakePreview && (vaultView === "collage" || vaultView === "grid");
  const [revealCount, setRevealCount] = useState(REVEAL_BATCH);
  const [sentinelInView, setSentinelInView] = useState(false);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const batchPreparingRef = useRef(false);

  const collageGridCardsAll = isWakePreview ? wakeCollageCards : orderedVisibleCards;
  const collageGridCards = useMemo(
    () => (isFeedView ? collageGridCardsAll.slice(0, revealCount) : collageGridCardsAll),
    [collageGridCardsAll, isFeedView, revealCount],
  );

  const hasMoreLocalToReveal = isFeedView && revealCount < collageGridCardsAll.length;
  const canRevealMore = isFeedView && (hasMoreLocalToReveal || hasMoreNotes);

  // How many skeletons to show under the revealed cards: the size of the next
  // group still waiting to come in.
  const pendingRevealCount = (() => {
    if (!isFeedView) return 0;
    const localRemaining = collageGridCardsAll.length - revealCount;
    if (localRemaining > 0) return Math.min(REVEAL_BATCH, localRemaining);
    if (hasMoreNotes) return REVEAL_BATCH;
    return 0;
  })();

  // A card is "ready" once anything it needs to paint is in hand. Notes/links
  // render from text immediately; image/video attachments backed by storage
  // need their signed URL resolved (the resolve path also probes/decodes the
  // image), so we wait on `resolvedAttachmentUrls` (or a definitive failure).
  const isCardMediaReady = useCallback(
    (card) => {
      if (!card || card.kind !== "attachment") return true;
      const t = resolveAttachmentType(card.attachment || {});
      if (t !== "image" && t !== "video") return true;
      const target = parseStorageTarget(card.attachment || {});
      const isStorageBacked = !!(target?.bucket && target?.path);
      if (!isStorageBacked) return true;
      return !!resolvedAttachmentUrls[card.id] || failedImageIds.has(card.id);
    },
    [resolvedAttachmentUrls, failedImageIds],
  );

  const prepareNextBatch = useCallback(() => {
    if (!isFeedView || batchPreparingRef.current) return;
    if (!hasMoreLocalToReveal) {
      // Nothing left in the local cache to reveal — pull the next server page.
      // The trigger effect re-runs once those rows land and the cache grows.
      if (hasMoreNotes) void loadMoreNotes();
      return;
    }
    const next = collageGridCardsAll.slice(revealCount, revealCount + REVEAL_BATCH);
    for (const card of next) {
      if (card.kind === "attachment") {
        visibleCardIdsRef.current.add(card.id);
        urlResolveQueueRef.current.push(card);
      }
    }
    void drainUrlResolveQueue();
    batchPreparingRef.current = true;
    setBatchPreparing(true);
  }, [
    isFeedView,
    hasMoreLocalToReveal,
    hasMoreNotes,
    loadMoreNotes,
    collageGridCardsAll,
    revealCount,
    drainUrlResolveQueue,
  ]);

  // Kick off the next batch when the bottom sentinel scrolls into view.
  useEffect(() => {
    if (!sentinelInView || !isFeedView || batchPreparing || !canRevealMore) return;
    prepareNextBatch();
  }, [sentinelInView, isFeedView, batchPreparing, canRevealMore, prepareNextBatch]);

  // Forward-progress safety net for the reveal window. The bottom sentinel's
  // IntersectionObserver fires reliably in the grid layout but NOT in the
  // collage masonry (the sentinel sits after a flex container that never
  // reports as intersecting), which left collage frozen on the first group of
  // REVEAL_BATCH items. Independently of the sentinel: whenever there's more to
  // reveal and the page isn't tall enough to scroll, advance directly. This
  // re-runs on every revealCount change and loops until the content overflows
  // the viewport, after which scroll-driven reveal takes over. The
  // `batchPreparing` gate (and the media-ready/6s safety valve that clears it)
  // throttles this to one batch at a time, so it can't runaway-reveal.
  useEffect(() => {
    if (!isFeedView || batchPreparing || !canRevealMore) return;
    if (typeof window === "undefined") return;
    const id = window.requestAnimationFrame(() => {
      const doc = document.scrollingElement || document.documentElement;
      const pageScrollable = doc && doc.scrollHeight > window.innerHeight + 200;
      if (!pageScrollable) prepareNextBatch();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isFeedView, batchPreparing, canRevealMore, revealCount, collageGridCardsAll.length, prepareNextBatch]);

  // Scroll-driven reveal/pagination that works in EVERY view (collage, grid,
  // tags, type). The bottom sentinel's IntersectionObserver fires in the grid
  // layout but NOT in the collage masonry, and the non-feed views (tags/type)
  // also leaned on it to fetch the next page — so anything but grid could stall
  // once scrollable. Drive everything directly off scroll position instead:
  // whenever the sentinel is within ~700px of the viewport, advance the reveal
  // window (feed views) or load the next server page (non-feed views).
  // Capture-phase listening catches scroll from a nested scroll container too;
  // batchPreparingRef / isLoadingMoreNotes gate to one step at a time.
  useEffect(() => {
    if (isWakePreview) return;
    const maybeReveal = () => {
      const el = loadMoreRef.current;
      if (!el) return;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (el.getBoundingClientRect().top > vh + 700) return;
      if (isFeedView) {
        if (!batchPreparingRef.current && canRevealMore) prepareNextBatch();
      } else if (hasMoreNotes && !isLoadingMoreNotes) {
        void loadMoreNotes();
      }
    };
    maybeReveal();
    window.addEventListener("scroll", maybeReveal, true);
    window.addEventListener("resize", maybeReveal);
    return () => {
      window.removeEventListener("scroll", maybeReveal, true);
      window.removeEventListener("resize", maybeReveal);
    };
  }, [isWakePreview, isFeedView, canRevealMore, prepareNextBatch, hasMoreNotes, isLoadingMoreNotes, loadMoreNotes]);

  // Once every card in the preparing batch has its media ready, reveal them.
  useEffect(() => {
    if (!batchPreparing) return;
    const next = collageGridCardsAll.slice(revealCount, revealCount + REVEAL_BATCH);
    if (next.length === 0) {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      return;
    }
    if (next.every((card) => isCardMediaReady(card))) {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      setRevealCount((c) => c + REVEAL_BATCH);
    }
  }, [batchPreparing, collageGridCardsAll, revealCount, isCardMediaReady]);

  // Safety valve: never trap the user behind a batch that won't resolve (a
  // dead signed URL, a stalled network). Reveal anyway after a grace period.
  useEffect(() => {
    if (!batchPreparing) return;
    const t = setTimeout(() => {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      setRevealCount((c) => c + REVEAL_BATCH);
    }, 6000);
    return () => clearTimeout(t);
  }, [batchPreparing]);

  // Reset the reveal window whenever the feed itself changes (search, tag
  // filter, concept results, or switching views) so a new result set starts
  // from the first group again instead of inheriting a stale large window.
  useEffect(() => {
    setRevealCount(REVEAL_BATCH);
    batchPreparingRef.current = false;
    setBatchPreparing(false);
  }, [embeddedSearch, selectedFilterTags, conceptResultIds, vaultView, isFeedView]);

  // Non-feed views (Tags/Type) keep plain infinite scroll.
  useEffect(() => {
    if (isFeedView) return;
    if (sentinelInView && hasMoreNotes && !isLoadingMoreNotes) void loadMoreNotes();
  }, [isFeedView, sentinelInView, hasMoreNotes, isLoadingMoreNotes, loadMoreNotes]);

  // ── Fixed-column JS masonry (collage view) ──
  //
  // The collage previously used CSS multi-column (`columns-*`). CSS columns
  // re-balance ALL columns whenever total content height changes — i.e. every
  // time an image resolves or a new page appends on scroll — which visually
  // threw cards in and out of order. Instead we assign each card to a fixed
  // column with a greedy "shortest column" pass over a DETERMINISTIC height
  // estimate (see `estimateCardHeightUnit`). Because the estimate never changes
  // as content loads and the greedy pass is order-preserving, a card's column
  // and position are stable across loads and pagination — nothing already on
  // screen ever moves. Grid view (CSS grid, row-major) and the wake marketing
  // preview keep their own layouts and don't use this.
  const computeCollageColumns = useCallback(() => {
    if (typeof window === "undefined") return isEmbeddedMode ? 3 : 3;
    const w = window.innerWidth;
    if (isEmbeddedMode) {
      // The embedded vault renders inside a centered modal iframe whose width
      // can be ~1100px, so scale the column count with the available width to
      // keep cards from blowing up huge.
      if (w >= 1000) return 4;
      if (w >= 720) return 3;
      if (w >= 480) return 2;
      return 1;
    }
    if (w >= 1536) return 5; // 2xl
    if (w >= 1280) return 4; // xl
    if (w >= 768) return 3; // md
    if (w >= 640) return 2; // sm
    return 1;
  }, [isEmbeddedMode]);

  const [collageColumns, setCollageColumns] = useState(computeCollageColumns);
  useEffect(() => {
    const onResize = () => setCollageColumns(computeCollageColumns());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [computeCollageColumns]);

  const useMasonryLayout = !isWakePreview && vaultView !== "grid";

  // Freeze each card's masonry height estimate the first time we see it, keyed
  // by card id. The estimate drives column assignment; if it changed after
  // mount (e.g. a dimension backfill or a background react-query refetch fed
  // real dims into a previously dim-less card) the greedy packer could move an
  // already-placed card to a different column WHILE the user is looking — a
  // visible reshuffle. Locking the estimate per id for the component's
  // lifetime guarantees the design's invariant: nothing already on screen ever
  // moves. New cards (uploads/pagination) compute fresh — with their real dims
  // if present — and a remount (route change) recomputes everything against
  // whatever dims are now persisted, so balance still improves over time.
  const heightEstimateCacheRef = useRef(new Map());
  const stableHeightEstimate = useCallback((card) => {
    const cache = heightEstimateCacheRef.current;
    const cached = cache.get(card.id);
    if (cached !== undefined) return cached;
    const value = estimateCardHeightUnit(card);
    cache.set(card.id, value);
    return value;
  }, []);

  const collageColumnBuckets = useMemo(() => {
    const count = Math.max(1, collageColumns);
    const buckets = Array.from({ length: count }, () => []);
    if (!useMasonryLayout) return buckets;
    const heights = new Array(count).fill(0);
    for (const card of collageGridCards) {
      let min = 0;
      for (let i = 1; i < count; i += 1) {
        if (heights[i] < heights[min]) min = i;
      }
      buckets[min].push(card);
      heights[min] += stableHeightEstimate(card);
    }
    return buckets;
  }, [collageGridCards, collageColumns, useMasonryLayout, stableHeightEstimate]);

  // Single source of truth for a collage/grid card's JSX, so the masonry
  // columns and the grid/wake layouts render identical cards. Defined in
  // component scope (not module scope) so it closes over the drag handlers,
  // selection state, and render helpers it needs.
  const renderCollageCard = (card) => {
    const isSelected = selectedCardIds.has(card.id);
    const isAdded = isEmbeddedMode && !isPickerMode && addedCardIds.has(card.id);
    return (
                  <motion.article
                    initial={
                      isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                        ? false
                        : { opacity: 0, scale: 0.97 }
                    }
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    key={card.id}
                    data-vault-card-id={card.id}
                    data-card-id={card.id}
                    ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                    draggable={false}
                    onDragStart={handleCardDragStart}
                    onClick={(e) => handleCardPress(e, card)}
                    // The card menu was previously reachable only from a ⋯
                    // button that no longer exists, so right-click is now how
                    // you get at project, tag, comment, and delete.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openCardMenuForAnchor(card.id, e.currentTarget);
                    }}
                    // Browser-native off-screen culling for large vaults.
                    // While being dragged, opt OUT — `content-visibility:
                    // hidden` (which the browser applies under the hood
                    // for off-screen content) would clip the drag image
                    // mid-flight if we crossed the threshold during the
                    // drag. Currently-dragged card always paints.
                    style={
                      virtualizedCardStyle && draggedCardId !== card.id
                        ? virtualizedCardStyle
                        : undefined
                    }
                    className={`${vaultView === "grid" ? "" : "break-inside-avoid"} ${vaultView === "grid" ? "" : isEmbeddedMode ? "mb-2" : "mb-2"} rounded-2xl relative ${
                      card.kind === "chat-preview" ? "overflow-hidden" : vaultView === "grid" ? "overflow-hidden" : "overflow-visible"
                    } ${
                      card.kind === "attachment" || card.kind === "quick-note"
                        ? "bg-transparent border-0 shadow-none backdrop-blur-0"
                        : "glass-control"
                    } ${
                      draggedCardId === card.id
                        ? "opacity-30 cursor-grabbing ring-2 ring-blue-400/50"
                        : "cursor-pointer"
                    } ${dropTargetCardId === card.id && draggedCardId !== card.id ? "ring-2 ring-blue-400/40" : ""} ${
                      isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""
                    } ${
                      isAdded ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-transparent" : ""
                    } ${
                      card.kind === "attachment" && card.type === "youtube"
                        ? getYouTubeOffsetClass(card.id)
                        : ""
                    } ${
                      openAttachmentNotesCardId === card.id
                        ? "z-[310]"
                        : "z-0"
                    }`}
                  >
                    {isSelected && (
                      <span
                        data-no-preview="true"
                        className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                    )}
                    {isAdded && !isSelected && (
                      <span
                        data-no-preview="true"
                        className="absolute top-2 right-2 z-[120] inline-flex items-center gap-1 rounded-full bg-emerald-500 text-white text-[0.625rem] font-semibold pl-1 pr-2 py-0.5 shadow-md pointer-events-none"
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                        Added
                      </span>
                    )}
                    {card.isDemo && !isWakePreview && (
                      <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                        Sample
                      </span>
                    )}
                    {card.kind === "source-folder" ? (
                      <SourceFolderTile
                        card={card}
                        heightClass={vaultView === "grid" ? "aspect-square w-full" : "h-44"}
                      />
                    ) : card.kind === "attachment" ? (
                      <>
                        {renderAttachmentCard(
                          card,
                          vaultView === "grid" ? "aspect-square w-full" : getAttachmentHeightClass(card),
                        )}
                        {parseAttachmentNotes(card.attachment).length > 0 && (
                          <button
                            type="button"
                            data-vault-popover-trigger=""
                            data-no-drag="true"
                            draggable={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openAttachmentNotesCardId === card.id) {
                                closeAttachmentNotes();
                              } else {
                                openAttachmentNotesForAnchor(card.id, e.currentTarget);
                              }
                            }}
                            className={`absolute top-2 ${
                              // Shift left when a selection check / "Added" pill
                              // occupies the top-right corner so both stay visible.
                              isAdded && !isSelected ? "right-20" : isSelected ? "right-9" : "right-2"
                            } h-6 min-w-6 px-1.5 rounded-full bg-white/45 backdrop-blur-sm border border-white/30 text-[0.6875rem] font-semibold text-black flex items-center justify-center gap-1 z-[125] shadow-sm`}
                            title="View comments"
                          >
                            <MessageCircle className="w-3 h-3 text-black" />
                            <span>{parseAttachmentNotes(card.attachment).length}</span>
                          </button>
                        )}
                      </>
                    ) : card.kind === "chat-preview" ? (
                      <div className={`p-4 space-y-3 ${vaultView === "grid" ? "aspect-square w-full overflow-hidden" : ""}`}>
                        <div className="flex items-center justify-between">
                          <h2 className="text-sm font-semibold text-black/90 dark:text-white/90 truncate">{card.title}</h2>
                          <span className="text-[0.6875rem] text-black/60 dark:text-white/60">{card.turnsCount} turns</span>
                        </div>
                        <div className="rounded-xl bg-white/40 border border-white/45 px-3 py-2">
                          <p className={`text-[0.75rem] text-black/80 dark:text-white/80 ${vaultView === "grid" ? "line-clamp-2" : "line-clamp-3"}`}>{card.question}</p>
                        </div>
                        {card.answer && vaultView !== "grid" && (
                          <div className="rounded-xl bg-black/10 border border-white/30 px-3 py-2">
                            <p className="text-[0.75rem] text-black/75 dark:text-white/75 line-clamp-4">{card.answer}</p>
                          </div>
                        )}
                        {vaultView !== "grid" && (
                        <div className="text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>{card.dateLabel}</span>
                        </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className={`glass-control rounded-2xl p-4 relative ${vaultView === "grid" ? "aspect-square w-full overflow-hidden" : ""}`}>
                          <div className="flex items-center gap-2 text-black/70 dark:text-white/70 mb-2">
                            {card.noteStyle === "meeting" ? (
                              <CalendarDays className="w-4 h-4" />
                            ) : card.noteStyle === "task" ? (
                              <ListTodo className="w-4 h-4" />
                            ) : (
                              <StickyNote className="w-4 h-4" />
                            )}
                            <span className="text-xs font-medium">{card.label || "Quick Note"}</span>
                          </div>
                          {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                            <p className="text-sm font-semibold text-black/80 dark:text-white/80 truncate mb-1.5">{card.title}</p>
                          ) : null}
                          <div className={vaultView === "grid" ? "overflow-hidden" : "max-h-56 overflow-y-auto scrollbar-hide"}>
                            <p className={`text-sm text-black/70 dark:text-white/70 whitespace-pre-wrap break-words ${vaultView === "grid" ? "line-clamp-5" : ""}`}>{card.excerpt}</p>
                          </div>
                          <div className="mt-3 text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{card.dateLabel}</span>
                          </div>
                          {(card.comments?.length || 0) > 0 && (
                            <button
                              type="button"
                              data-vault-popover-trigger=""
                              data-no-drag="true"
                              draggable={false}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (openAttachmentNotesCardId === card.id) {
                                  closeAttachmentNotes();
                                } else {
                                  openAttachmentNotesForAnchor(card.id, e.currentTarget);
                                }
                              }}
                              className="absolute top-2 right-2 h-6 min-w-6 px-1.5 rounded-full bg-white/45 backdrop-blur-sm border border-white/30 text-[0.6875rem] font-semibold text-black flex items-center justify-center gap-1 z-[125] shadow-sm"
                              title="View comments"
                            >
                              <MessageCircle className="w-3 h-3 text-black" />
                              <span>{card.comments.length}</span>
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    <VaultPickerTapOverlay
                      show={isPickerMode && isSelectableCard(card)}
                    />
                  </motion.article>
    );
  };

  // ── Off-screen card culling (browser-native virtualization) ──
  //
  // Above ~80 cards on screen, paint/layout cost gets noticeable: every
  // card mounts framer-motion, runs the URL resolver IO, renders an
  // image/video, etc. Rather than swap the whole grid out for a
  // react-window/react-virtual rewrite — which would break drag-and-drop,
  // masonry/columns layout, and the existing ordering refs — we lean on
  // CSS `content-visibility: auto`. The browser then:
  //   * still places the element in layout (so masonry / grid math is
  //     correct, drag targets stay clickable, IntersectionObservers fire),
  //   * but skips painting + descendant rendering until the element
  //     enters the viewport.
  //
  // `contain-intrinsic-size` gives the browser a stable size estimate
  // before paint, so scrollbar height and scroll position stay sane.
  // The estimates differ per view mode:
  //   * grid: aspect-square cards at our typical column width (~200px),
  //     plus a small action footer → ~280–300px tall slot.
  //   * collage / masonry / tags: variable height, lean a little taller
  //     to avoid scroll jumps when off-screen cards repaint shorter than
  //     estimated. Browser corrects on first real layout.
  //
  // We deliberately gate on a count threshold so small vaults pay zero
  // cost — `content-visibility` adds layout containment which can change
  // a few subtle behaviors (printing, find-in-page focus order), and
  // there's no upside on a 12-card vault.
  // ── Off-screen card culling — currently DISABLED ──
  //
  // We previously gated `content-visibility: auto` +
  // `contain-intrinsic-size` on cards once the rendered count crossed
  // a threshold. In theory this gives free browser-native virtualization;
  // in practice the `contain-intrinsic-size` estimate is necessarily
  // a guess (cards are variable height in masonry/collage and even
  // grid mode varies with content), so the FIRST time each card was
  // revealed during scroll its real layout differed from the estimate
  // and shoved every other card up or down. The `auto` keyword in
  // `contain-intrinsic-size` only helps on subsequent reveals, not the
  // first one — and "first scroll-down through a vault" is exactly when
  // glitching is most visible to users.
  //
  // The aspect-ratio fix on the image wrapper (see `renderAttachmentCard`
  // image branch: `learnedImageDimsRef` + `aspectRatio` style) already
  // gives us the layout-stability win this was meant to enable, without
  // the per-reveal intrinsic-size mismatch problem. We can re-introduce
  // a real virtualization layer (react-virtual etc.) later if profiling
  // shows we need it; until then, render every visible card normally.
  const virtualizedCardStyle = undefined;

  const tagGroupedCards = useMemo(() => {
    if (vaultView !== "tags") return [];
    const groups = {};
    const untagged = [];
    for (const card of orderedVisibleCards) {
      // Connector folder tiles group by the union of their items' tags so one
      // app card appears under each relevant tag (and "Untagged" if none).
      const tags = card.kind === "source-folder" ? (card.allTags || []) : (card.tags || []);
      if (tags.length === 0) {
        untagged.push(card);
      } else {
        tags.forEach((t) => {
          if (!groups[t]) groups[t] = [];
          groups[t].push(card);
        });
      }
    }
    const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    if (untagged.length > 0) sorted.push(["Untagged", untagged]);
    return sorted;
  }, [orderedVisibleCards, vaultView]);

  const typeGroupedCards = useMemo(() => {
    if (vaultView !== "type") return [];
    const typeLabels = {
      image: "Images", video: "Videos", youtube: "YouTube", audio: "Audio",
      pdf: "PDFs", html: "Artifacts", spreadsheet: "Spreadsheets", bookmark: "Links", file: "Files",
      instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook",
      "quick-note": "Quick Notes", meeting: "Meeting notes", task: "Tasks", doc: "Notes",
      "chat-preview": "Chats",
    };
    const groups = {};
    for (const card of orderedVisibleCards) {
      const key =
        card.kind === "attachment"
          ? (card.type || "file")
          : card.kind === "quick-note" && card.noteStyle && card.noteStyle !== "quick"
            ? card.noteStyle
            : card.kind;
      const label = typeLabels[key] || key;
      if (!groups[label]) groups[label] = [];
      groups[label].push(card);
    }
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  }, [orderedVisibleCards, vaultView]);

  const reorderActivePage = useCallback(
    (dragId, overId) => {
      if (!dragId || !overId || dragId === overId) return;
      setOrderByPage((prev) => {
        const pageOrder = prev.everything || [];
        const baseline = [
          ...pageOrder.filter((id) => orderedVisibleCards.some((card) => card.id === id)),
          ...orderedVisibleCards.map((card) => card.id).filter((id) => !pageOrder.includes(id)),
        ];
        const from = baseline.indexOf(dragId);
        const to = baseline.indexOf(overId);
        if (from === -1 || to === -1 || from === to) return prev;
        const next = baseline.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return { ...prev, everything: next };
      });
    },
    [orderedVisibleCards]
  );

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

  const getCardSearchText = useCallback((card) => {
    const parts = [];
    parts.push(card.title || "");
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      parts.push(att.name || "");
      if (att.aiDescription) parts.push(String(att.aiDescription));
      const fileNotes = parseAttachmentNotes(att);
      fileNotes.forEach((n) => parts.push(n.text));
    } else if (card.kind === "quick-note") {
      parts.push(card.excerpt || "");
    } else if (card.kind === "chat-preview") {
      parts.push(card.question || "", card.answer || "");
    }
    (card.tags || []).forEach((t) => parts.push(t));
    return parts.join(" ").toLowerCase();
  }, []);

  const buildCardSummary = useCallback((card) => {
    const parts = [card.id];
    parts.push(card.title || card.attachment?.name || "Untitled");
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      if (att.aiDescription) parts.push(String(att.aiDescription).slice(0, 150));
      const fileNotes = parseAttachmentNotes(att);
      if (fileNotes.length > 0) parts.push(fileNotes.map((n) => n.text).join("; ").slice(0, 100));
    } else if (card.kind === "quick-note") {
      if (card.excerpt) parts.push(card.excerpt.slice(0, 200));
    } else if (card.kind === "chat-preview") {
      if (card.question) parts.push(card.question.slice(0, 150));
    }
    const cardTags = card.tags || [];
    if (cardTags.length > 0) parts.push(`Tags: ${cardTags.join(", ")}`);
    return parts.join(" | ");
  }, []);

  const conceptSearchIdRef = useRef(0);

  const handleConceptSearch = useCallback(async (query) => {
    const q = (query || "").trim();
    if (!q) {
      setConceptResultIds(null);
      setIsConceptSearching(false);
      return;
    }
    if (visibleCards.length === 0) {
      setIsConceptSearching(false);
      return;
    }

    if (conceptSearchAbortRef.current) {
      conceptSearchAbortRef.current.abort();
      conceptSearchAbortRef.current = null;
    }

    const searchId = ++conceptSearchIdRef.current;
    const controller = new AbortController();
    conceptSearchAbortRef.current = controller;
    setIsConceptSearching(true);
    setConceptResultIds(null);

    try {
      const keywords = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const localMatches = [];
      const remaining = [];

      for (const card of visibleCards) {
        const text = getCardSearchText(card);
        const hit = keywords.some((kw) => text.includes(kw));
        if (hit) {
          localMatches.push(card.id);
        } else {
          remaining.push(card);
        }
      }

      if (remaining.length === 0) {
        if (import.meta.env.DEV) console.log("[VaultSearch] All matched locally:", localMatches.length);
        setConceptResultIds(localMatches);
        return;
      }

      // Cap how many items we ship to the model. With a few hundred cards
      // and no local keyword hit, `remaining` could be effectively the
      // entire grid — turning every concept search into a megabyte-class
      // prompt. We prioritize the most-recently-touched items (those at
      // the top of the visible order) since concept search is usually
      // about "stuff I worked on lately."
      //
      // The cap (300) is a balance: enough to make conceptual searches
      // meaningful on real vaults, small enough that the prompt stays
      // bounded and the request fits comfortably in the AI rate limit's
      // per-call budget.
      const CONCEPT_SEARCH_MAX_ITEMS = 300;
      const truncated = remaining.length > CONCEPT_SEARCH_MAX_ITEMS;
      const candidateCards = truncated
        ? remaining.slice(0, CONCEPT_SEARCH_MAX_ITEMS)
        : remaining;

      const itemSummaries = candidateCards.map((card) => buildCardSummary(card)).join("\n");

      const prompt = [
        `Search: "${q}"`,
        "",
        truncated
          ? `${candidateCards.length} of ${remaining.length} items shown (most recent). Find anything conceptually related.`
          : `${candidateCards.length} items. Find anything conceptually related.`,
        "",
        "ITEMS:",
        itemSummaries,
        "",
        'Return ONLY a JSON array of matching IDs. Example: ["id-1","id-2"]',
        "If nothing matches: []",
      ].join("\n");

      const { API_BASE_URL } = await import("@/lib/api-config");
      if (import.meta.env.DEV) console.log("[VaultSearch] Local:", localMatches.length, "| AI:", remaining.length);
      const res = await fetch(`${API_BASE_URL}/api/ai/vault-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      if (searchId !== conceptSearchIdRef.current) return;

      let aiMatchIds = [];
      let aiFailed = false;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const raw = String(data.response || "").trim();
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const ids = JSON.parse(jsonMatch[0]);
            if (Array.isArray(ids)) aiMatchIds = ids.map(String);
          } catch { /* use empty */ }
        }
      } else {
        aiFailed = true;
        if (import.meta.env.DEV) console.warn("[VaultSearch] Server returned", res.status);
      }

      if (searchId !== conceptSearchIdRef.current) return;

      const combined = [...localMatches, ...aiMatchIds];
      if (import.meta.env.DEV) console.log("[VaultSearch] Results:", combined.length);
      setConceptResultIds(combined);
      // Tell the user when the AI half of the search dropped out so
      // they can retry. Without this, "no results" silently masks
      // a backend outage and looks like an empty vault.
      if (aiFailed) {
        toast({
          title: "Search partially unavailable",
          description:
            localMatches.length > 0
              ? "Couldn't reach the AI search service. Showing keyword matches only."
              : "Couldn't reach the AI search service and no keyword matches were found. Try again in a moment.",
          variant: "destructive",
        });
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (searchId !== conceptSearchIdRef.current) return;
      if (import.meta.env.DEV) console.error("[VaultSearch] Error:", err);
      setConceptResultIds(null);
      toast({
        title: "Search failed",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      if (searchId === conceptSearchIdRef.current) {
        setIsConceptSearching(false);
      }
    }
  }, [visibleCards, buildCardSummary, getCardSearchText]);

  const handleSaveQuickNote = async () => {
    if (isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;

    if (isWakePreview) {
      setIsQuickNoteSaving(true);
      try {
        const saved = appendWakeVaultPreviewQuickNote(content);
        setWakePreviewQuickNotes((prev) => [saved, ...prev]);
        setQuickNoteContent("");
        setShowQuickNote(false);
      } finally {
        setIsQuickNoteSaving(false);
      }
      return;
    }

    if (!user?.id) { setShowSignInBlocker(true); return; }
    if (!(await checkVaultLimit())) return;

    setIsQuickNoteSaving(true);
    try {
      let insertedNote = null;
      let noteError = null;

      ({ data: insertedNote, error: noteError } = await vaultWrites.insert({
        title: "Quick Note",
        content,
        source: "quick_note",
        tags: ["note"],
      }));

      const missingColumnError =
        noteError &&
        (
          noteError.code === "PGRST204" ||
          noteError.message?.includes("Could not find") ||
          String(noteError.message || "").toLowerCase().includes("does not exist")
        );

      // Older cloud databases lack `source` / `tags`; retry with the columns
      // every deployment is guaranteed to have.
      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await vaultWrites.insert({
          title: "Quick Note",
          content,
        }));
      }

      if (noteError || !insertedNote?.id) {
        throw noteError || new Error("Unable to save quick note.");
      }

      afterVaultNoteSaved(user.id, insertedNote.id, {
        title: insertedNote.title || "Quick Note",
        content,
      });

      setQuickNoteContent("");
      setShowQuickNote(false);
      setNotes((prev) => [insertedNote, ...prev]);
      incrementVaultCount();
    } catch (error) {
      if (!notifyVaultCapIfApplicable(error)) {
        toast({
          title: "Couldn't save note",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsQuickNoteSaving(false);
    }
  };

  const handleCloseQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    const hasContent = Boolean(String(quickNoteContent || "").trim());
    if (!hasContent) {
      setShowQuickNote(false);
      setQuickNoteContent("");
      return;
    }
    await handleSaveQuickNote();
  }, [handleSaveQuickNote, isQuickNoteSaving, quickNoteContent]);

  // Explicit discard: throw away the draft without saving. Distinct
  // from `handleCloseQuickNote` which auto-saves any non-empty draft
  // (close = "minimize and persist"; discard = "throw it away").
  // Wired to the trash button in `DraggableQuickNote`.
  const handleDiscardQuickNote = useCallback(() => {
    if (isQuickNoteSaving) return;
    setShowQuickNote(false);
    setQuickNoteContent("");
  }, [isQuickNoteSaving]);

  const handleSaveLink = useCallback(async (saveLinkPreview) => {
    if (!user?.id) { setShowSignInBlocker(true); return; }
    if (isSaveLinkSaving || !saveLinkPreview) return;
    if (!(await checkVaultLimit())) return;
    setIsSaveLinkSaving(true);
    try {
      // Defense in depth: AddLinkDialog normalizes on the way in, but
      // force a final pass before persistence in case the server echo
      // re-introduces a bare hostname.
      const safeUrl = normalizeUrl(saveLinkPreview.url) || saveLinkPreview.url;
      const attachment = [{
        type: "bookmark",
        url: safeUrl,
        name: saveLinkPreview.title || saveLinkPreview.url || "Saved Link",
        title: saveLinkPreview.title || "",
        description: saveLinkPreview.description || "",
        image: saveLinkPreview.image || "",
        favicon: saveLinkPreview.favicon || "",
        siteName: saveLinkPreview.siteName || "",
        articleText: saveLinkPreview.articleText || "",
        oembedType: saveLinkPreview.oembedType || "",
        oembedHtml: saveLinkPreview.oembedHtml || "",
        authorName: saveLinkPreview.authorName || "",
        authorHandle: saveLinkPreview.authorHandle || "",
      }];
      const noteContent = `${saveLinkPreview.title || safeUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: insertedNote, error } = await vaultWrites.insert({
        title: saveLinkPreview.title || safeUrl,
        content: noteContent,
      });
      if (error) throw error;
      if (insertedNote) {
        setNotes((prev) => [insertedNote, ...prev]);
        incrementVaultCount();
        // Index into the synthesis layer the same way quick notes and
        // dropped links do — without this, dialog-saved links never
        // appear in the brain map until some other reindex pass runs.
        const linkText = [
          saveLinkPreview.title,
          saveLinkPreview.description,
          saveLinkPreview.articleText,
        ].filter(Boolean).join("\n").slice(0, 5000);
        describeVaultItemInBackground(insertedNote.id, {
          imageUrl: saveLinkPreview.image || undefined,
          textContent: linkText || undefined,
          fileType: "bookmark",
          fileName: saveLinkPreview.title || safeUrl,
        });
        afterVaultNoteSaved(user.id, insertedNote.id, {
          title: insertedNote.title || saveLinkPreview.title || safeUrl,
          content: insertedNote.content || noteContent,
          extraPlain: linkText || undefined,
        });
      }
      setShowSaveLink(false);
    } catch (err) {
      if (!notifyVaultCapIfApplicable(err)) {
        toast({
          title: "Couldn't save link",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSaveLinkSaving(false);
    }
  }, [user?.id, isSaveLinkSaving, checkVaultLimit, incrementVaultCount]);

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

  const renderAttachmentCard = (card, tileHeightClass) => {
    const { attachment, title } = card;
    let type = card.type;
    if (type === "file" || type === "bookmark" || type === "link") {
      if (looksLikeImageAttachment(attachment || {})) type = "image";
    }
    // Never paint an expired/raw storage URL into an <img> — wait for a
    // freshly signed URL from the resolver instead.
    const rawAttUrl = String(attachment?.url || "");
    const resolvedUrl =
      resolvedAttachmentUrls[card.id] ||
      (isSupabaseStorageUrlText(rawAttUrl) ? "" : rawAttUrl);
    const wakeDemoCard = isWakePreview && card.isDemo;
    const stableTileHeight = resolveStableTileHeight(card, tileHeightClass);
    // Grid/tags/type views pass a single fixed / square class and expect
    // uniform tiles. The collage passes responsive bucketed classes.
    // When the tile is uniform, keep that size instead of switching to the
    // media's real aspect-ratio — otherwise a portrait image (or a long
    // connector bookmark card) stretches its whole grid row.
    const uniformTile = isUniformVaultTileClass(tileHeightClass);

    // Ghost cards represent uploads still in flight. We render the local
    // blob preview directly — no signed-URL resolver, no retry logic —
    // so the file is immediately usable as if it were already a normal
    // embedded video / image.
    //
    // Intentionally NO compression chrome in the grid: no progress bar,
    // no "Compressing…" label, no overlays. The only place the user sees
    // upload / compression state is the global upload toast. Once the
    // pipeline finishes, `onFileComplete` swaps this for the real
    // DB-backed card transparently.
    if (card.ghost) {
      if (type === "video") {
        return (
          <video
            className="w-full h-auto max-h-[42rem] rounded-2xl bg-black/10"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="auto"
            draggable={false}
            src={attachment.url}
          />
        );
      }
      return (
        <img
          src={attachment.url}
          alt={title}
          className="w-full h-auto max-h-[42rem] rounded-2xl"
          draggable={false}
        />
      );
    }

    if (type === "image") {
      const storageTarget = parseStorageTarget(attachment || {});
      const isStorageBacked = !!(storageTarget?.bucket && storageTarget?.path);
      const hasResolvedUrl = !!resolvedAttachmentUrls[card.id];
      const hasFailed = failedImageIds.has(card.id);

      // Compute the reserved aspect ratio BEFORE the skeleton/failed returns
      // so the placeholder, the loaded image, and the error state all occupy
      // the SAME height. Previously the skeleton used a fixed `stableTileHeight`
      // and the loaded image switched to its real `aspectRatio`, so every
      // async signed-URL resolve changed a card's height — and in the CSS
      // multi-column collage that rebalances all columns, throwing cards in
      // and out of order as they load (and again as more resolve on scroll).
      const learnedDims = resolvedUrl ? learnedImageDimsRef.current.get(resolvedUrl) : null;
      const metaW =
        toNumber(attachment.width) ??
        toNumber(attachment.imageWidth) ??
        toNumber(attachment.metadata?.width) ??
        toNumber(attachment.metadata?.imageWidth);
      const metaH =
        toNumber(attachment.height) ??
        toNumber(attachment.imageHeight) ??
        toNumber(attachment.metadata?.height) ??
        toNumber(attachment.metadata?.imageHeight);
      const reservedW = metaW || learnedDims?.w || null;
      const reservedH = metaH || learnedDims?.h || null;
      const hasReservedAspect = !!(reservedW && reservedH && reservedW > 0 && reservedH > 0);
      const reservedAspectStyle = hasReservedAspect && !uniformTile
        ? { aspectRatio: `${reservedW} / ${reservedH}` }
        : undefined;
      const reservedHeightClass = uniformTile
        ? tileHeightClass
        : hasReservedAspect
          ? ""
          : stableTileHeight;

      if (isStorageBacked && !hasResolvedUrl && !hasFailed) {
        return (
          <div
            className={`w-full ${reservedHeightClass} rounded-2xl bg-white/5 animate-pulse flex items-center justify-center`}
            style={reservedAspectStyle}
          >
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      if (hasFailed) {
        const failedLabel = sanitizeCardTitle(title || attachment.name || "", "Image");
        const canRetry =
          isStorageBacked ||
          isSupabaseStorageUrlText(attachment.url || resolvedUrl || "");
        return (
          <div
            className={`w-full ${reservedHeightClass} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}
            style={reservedAspectStyle}
          >
            <FileText className="w-8 h-8 text-black/20 dark:text-white/20" />
            <span className="text-xs text-black/40 dark:text-white/40 text-center truncate max-w-full">{failedLabel}</span>
            {canRetry && (
              <button
                type="button"
                className="text-[0.625rem] font-medium text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  imageRetryCountsRef.current.delete(card.id);
                  setFailedImageIds((prev) => { const next = new Set(prev); next.delete(card.id); return next; });
                  const retryTarget = parseStorageTarget(attachment || {}) || storageTarget;
                  if (retryTarget?.bucket && retryTarget?.path) {
                    signedUrlCacheRef.current.delete(`${retryTarget.bucket}:${retryTarget.path}`);
                  }
                  setResolvedAttachmentUrls((prev) => { const next = { ...prev }; delete next[card.id]; return next; });
                  visibleCardIdsRef.current.delete(card.id);
                  urlResolveQueueRef.current.push(card);
                  drainUrlResolveQueue();
                }}
              >
                Try again
              </button>
            )}
          </div>
        );
      }

      // Pre-decoded above-fold images skip the per-image opacity
      // fade-in. Their bitmap is already on the GPU thanks to the
      // preload step (see `preDecodedUrlsRef` above), so painting them
      // synchronously avoids the cascading "popcorn" reveal where each
      // card's fade kicks off on a different frame.
      //
      // For below-the-fold images we now use a *short* (150ms) fade
      // instead of the previous 300ms. The longer fade was the source
      // of the visible "scroll glitch" — when several cards scrolled
      // into view at roughly the same time, each one started its
      // 300ms opacity transition on a slightly different frame, which
      // looks staggered/jittery to the eye. 150ms is short enough to
      // read as "just appeared" while still hiding the brief frame
      // between mount and paint, and uses the standard Tailwind scale
      // so it doesn't trip the ambiguous-arbitrary-value warning.
      const isPreDecoded =
        wakeDemoCard || (!!resolvedUrl && preDecodedUrlsRef.current.has(resolvedUrl));
      const skipEntryFade = isVaultFirstPaintRef.current || isPreDecoded || wakeDemoCard;

      // Aspect-ratio reservation (`reservedW`/`reservedH`/`hasReservedAspect`)
      // is computed once at the top of the image branch so the skeleton,
      // loaded image, and error state share one reserved height. Setting the
      // `width` + `height` HTML attributes (modern browsers' "aspect ratio
      // mapping") tells the browser to reserve the correct slot BEFORE the
      // image loads, eliminating the layout shift that caused cards to "shift
      // and move and cut up and down" on first scroll.

      return (
        <div
          className={`w-full rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-center overflow-hidden ${reservedHeightClass}`}
          style={reservedAspectStyle}
        >
        <img
          key={resolvedUrl}
          src={resolvedUrl}
          alt={title}
          // Width/height HTML attributes are critical here — even
          // though CSS overrides the visual size, the browser uses
          // the ratio of these two numbers to reserve aspect-ratio
          // space. This is the modern (Chrome 79+, Firefox 71+,
          // Safari 14+) "aspect ratio mapping" feature.
          {...(hasReservedAspect ? { width: reservedW, height: reservedH } : {})}
          className={
            skipEntryFade
              ? `${uniformTile ? "w-full h-full object-cover" : "max-w-full max-h-full w-auto h-auto object-contain"} rounded-2xl`
              : `${uniformTile ? "w-full h-full object-cover" : "max-w-full max-h-full w-auto h-auto object-contain"} rounded-2xl opacity-0 transition-opacity duration-150 ease-out`
          }
          loading={skipEntryFade ? "eager" : "lazy"}
          decoding={skipEntryFade ? "sync" : "async"}
          draggable={false}
          onLoad={(e) => {
            // Cache the actual natural dims so the next time this
            // URL renders (e.g. after content-visibility culls and
            // re-reveals on scroll-back), we can reserve the right
            // slot from the start. No-op if we already had metadata.
            const nw = e.currentTarget.naturalWidth;
            const nh = e.currentTarget.naturalHeight;
            if (resolvedUrl && nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(resolvedUrl)) {
              learnedImageDimsRef.current.set(resolvedUrl, { w: nw, h: nh });
            }
            // Persist these dims back to the note so this (legacy, dim-less)
            // image reserves its true aspect on every future load — no more
            // column shift when it resolves. No-op for items that already
            // have stored dims.
            queuePersistAttachmentDims(card, nw, nh);
            // Reset the retry budget on success. Without this, a card
            // that briefly fails (expired URL → fresh URL → success)
            // permanently keeps a shrunken retry budget, so the next
            // failure days later has fewer attempts before giving up.
            imageRetryCountsRef.current.delete(card.id);
            e.currentTarget.style.opacity = "1";
            const wrapper = e.currentTarget.parentElement;
            if (wrapper) { wrapper.style.minHeight = "0"; wrapper.style.background = "transparent"; }
          }}
          onError={() => {
            const retryCount = imageRetryCountsRef.current.get(card.id) || 0;
            if (retryCount < 2) {
              imageRetryCountsRef.current.set(card.id, retryCount + 1);
              const target = parseStorageTarget(attachment || {});
              if (target?.bucket && target?.path) {
                const cacheKey = `${target.bucket}:${target.path}`;
                signedUrlCacheRef.current.delete(cacheKey);
                const delay = (retryCount + 1) * 800;
                setTimeout(async () => {
                  // Guard against the component unmounting between
                  // the failed image load and this retry tick — without
                  // it we'd setState on a torn-down tree and warm
                  // closures into the long-lived image cache.
                  if (!isMountedRef.current) return;
                  try {
                    const { data } = await supabase.storage
                      .from(target.bucket)
                      .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
                    if (data?.signedUrl) {
                      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
                      if (!isMountedRef.current) return;
                      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
                      return;
                    }
                  } catch { /* fall through to server fallback */ }
                  try {
                    const { API_BASE_URL } = await import("@/lib/api-config");
                    const session = (await supabase.auth.getSession())?.data?.session;
                    const token = session?.access_token;
                    if (token) {
                      const resp = await fetch(`${API_BASE_URL}/api/storage/signed-url`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ storagePath: target.path, bucket: target.bucket }),
                      });
                      if (resp.ok) {
                        const { signedUrl } = await resp.json();
                        if (signedUrl) {
                          writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signedUrl);
                          setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: signedUrl }));
                          return;
                        }
                      }
                    }
                  } catch { /* exhausted */ }
                  setFailedImageIds((prev) => new Set(prev).add(card.id));
                }, delay);
              } else {
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }
            } else {
              setFailedImageIds((prev) => new Set(prev).add(card.id));
            }
          }}
        />
        </div>
      );
    }

    if (type === "video") {
      const videoMime = attachment.mimeType || "video/mp4";
      const videoStorageTarget = parseStorageTarget(attachment || {});
      const videoIsStorageBacked = !!(videoStorageTarget?.bucket && videoStorageTarget?.path);

      // Reserve the video's aspect ratio (same approach as images) so the
      // tile is exactly as tall as the frame from the FIRST paint — the old
      // fixed-height box came from a coarse height bucket that rarely matched
      // the real shape, leaving dead letterbox space. Videos don't carry
      // stored dimensions, so when the real shape is unknown we reserve a
      // 16:9 slot (the overwhelming majority of uploads); `onLoadedMetadata`
      // only nudges the rare non-16:9 clip. Computed before the loading
      // skeleton so the skeleton and the loaded video share one slot and the
      // tile never jumps as the URL resolves / scrolls in.
      const learnedVideoDims = resolvedUrl ? learnedImageDimsRef.current.get(resolvedUrl) : null;
      const reservedVW =
        toNumber(attachment.videoWidth) ??
        toNumber(attachment.width) ??
        toNumber(attachment.metadata?.videoWidth) ??
        toNumber(attachment.metadata?.width) ??
        learnedVideoDims?.w ??
        null;
      const reservedVH =
        toNumber(attachment.videoHeight) ??
        toNumber(attachment.height) ??
        toNumber(attachment.metadata?.videoHeight) ??
        toNumber(attachment.metadata?.height) ??
        learnedVideoDims?.h ??
        null;
      const hasReservedVideoAspect = !!(reservedVW && reservedVH && reservedVW > 0 && reservedVH > 0);
      const videoAspect = hasReservedVideoAspect ? `${reservedVW} / ${reservedVH}` : "16 / 9";
      const videoPosterUrl = resolvedVideoPosterUrls[card.id] || undefined;
      const videoHasFailed = failedImageIds.has(card.id);

      // Don't skeleton-spin a card we've already given up on — fall through to
      // the failed state below. Without the `!videoHasFailed` guard a video
      // whose object is missing (re-sign returns 400, or the object 404s) sat
      // in this <Loader2> skeleton forever; the image branch has had a failed
      // state for ages, this mirrors it.
      if (videoIsStorageBacked && !resolvedAttachmentUrls[card.id] && !videoHasFailed) {
        return (
          <div
            className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/10 animate-pulse flex items-center justify-center`}
            style={uniformTile ? undefined : { aspectRatio: videoAspect }}
          >
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      // Failed state — mirrors the image branch (same visual + "Try again"
      // reset handler). Reserves the same aspect ratio so the tile doesn't jump
      // when it flips between skeleton / failed / loaded.
      if (videoHasFailed) {
        return (
          <div
            className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}
            style={uniformTile ? undefined : { aspectRatio: videoAspect }}
          >
            <FileText className="w-8 h-8 text-black/20 dark:text-white/20" />
            <span className="text-xs text-black/40 dark:text-white/40 text-center truncate max-w-full">{title}</span>
            {videoIsStorageBacked && (
              <button
                type="button"
                className="text-[0.625rem] font-medium text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  imageRetryCountsRef.current.delete(card.id);
                  setFailedImageIds((prev) => { const next = new Set(prev); next.delete(card.id); return next; });
                  signedUrlCacheRef.current.delete(`${videoStorageTarget?.bucket || "user-files"}:${videoStorageTarget?.path || ""}`);
                  setResolvedAttachmentUrls((prev) => { const next = { ...prev }; delete next[card.id]; return next; });
                  visibleCardIdsRef.current.delete(card.id);
                  urlResolveQueueRef.current.push(card);
                  drainUrlResolveQueue();
                }}
              >
                Try again
              </button>
            )}
          </div>
        );
      }

      // When we have a poster frame, paint immediately — the poster image is
      // already a real frame, so there's no black flash to hide behind a fade.
      const skipVideoFade = isVaultFirstPaintRef.current || wakeDemoCard || !!videoPosterUrl;

      return (
        <div
          className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] pointer-events-none flex items-center justify-center overflow-hidden`}
          style={uniformTile ? undefined : { aspectRatio: videoAspect }}
        >
          <video
            key={resolvedUrl}
            className={`max-w-full max-h-full w-auto h-auto object-contain rounded-2xl bg-black/10 ${
              skipVideoFade ? "" : "opacity-0 transition-opacity duration-150 ease-out"
            }`}
            // No native controls on grid tiles: the wrapper is
            // pointer-events-none (click opens the preview modal), so the
            // controls rendered but never responded — reading as broken.
            playsInline
            preload="metadata"
            poster={videoPosterUrl}
            draggable={false}
            muted={isPickerMode}
            onLoadedMetadata={(e) => {
              // Videos often have no width/height stored at upload time, so
              // learn the real frame dims here and collapse the tile to the
              // exact aspect ratio right away (inline style beats the fixed
              // Tailwind height class, including its responsive variants).
              const vw = e.currentTarget.videoWidth;
              const vh = e.currentTarget.videoHeight;
              if (vw > 0 && vh > 0) {
                if (resolvedUrl && !learnedImageDimsRef.current.has(resolvedUrl)) {
                  learnedImageDimsRef.current.set(resolvedUrl, { w: vw, h: vh });
                }
                // Uniform tiles (grid/tags/type views) keep their fixed
                // height — resizing to the real aspect here would make the
                // row ragged again.
                const wrapper = e.currentTarget.parentElement;
                if (wrapper && !uniformTile) {
                  wrapper.style.aspectRatio = `${vw} / ${vh}`;
                  wrapper.style.height = "auto";
                }
                // Persist so this legacy video reserves its true aspect on
                // every future load instead of falling back to 16/9.
                queuePersistAttachmentDims(card, vw, vh);
              }
            }}
            onLoadedData={(e) => {
              // Reset the retry budget on success (parity with the image
              // branch) so a clip that briefly failed then recovered keeps a
              // full budget for any future failure.
              imageRetryCountsRef.current.delete(card.id);
              e.currentTarget.style.opacity = "1";
              const wrapper = e.currentTarget.parentElement;
              if (wrapper) { wrapper.style.minHeight = "0"; wrapper.style.background = "transparent"; }
            }}
            // A URL that resolves but then fails to LOAD (object deleted /
            // undecodable) used to leave an invisible opacity-0 box. Mirror the
            // image branch: re-sign + retry a couple of times, then flip the
            // card into the failed state so it shows the "Try again" tile.
            onError={() => {
              const retryCount = imageRetryCountsRef.current.get(card.id) || 0;
              if (retryCount < 2 && videoStorageTarget?.bucket && videoStorageTarget?.path) {
                imageRetryCountsRef.current.set(card.id, retryCount + 1);
                const cacheKey = `${videoStorageTarget.bucket}:${videoStorageTarget.path}`;
                signedUrlCacheRef.current.delete(cacheKey);
                const delay = (retryCount + 1) * 800;
                setTimeout(async () => {
                  if (!isMountedRef.current) return;
                  try {
                    const { data } = await supabase.storage
                      .from(videoStorageTarget.bucket)
                      .createSignedUrl(videoStorageTarget.path, SIGNED_URL_TTL_SECONDS);
                    if (data?.signedUrl) {
                      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
                      if (!isMountedRef.current) return;
                      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
                      return;
                    }
                  } catch { /* fall through to server fallback */ }
                  try {
                    const { API_BASE_URL } = await import("@/lib/api-config");
                    const session = (await supabase.auth.getSession())?.data?.session;
                    const token = session?.access_token;
                    if (token) {
                      const resp = await fetch(`${API_BASE_URL}/api/storage/signed-url`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ storagePath: videoStorageTarget.path, bucket: videoStorageTarget.bucket }),
                      });
                      if (resp.ok) {
                        const { signedUrl } = await resp.json();
                        if (signedUrl) {
                          writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signedUrl);
                          if (!isMountedRef.current) return;
                          setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: signedUrl }));
                          return;
                        }
                      }
                    }
                  } catch { /* exhausted */ }
                  if (!isMountedRef.current) return;
                  setFailedImageIds((prev) => new Set(prev).add(card.id));
                }, delay);
              } else {
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }
            }}
          >
            <source
              src={resolvedUrl}
              type={videoMime}
              onError={() => {
                // A failing <source> only bubbles to <video> error when ALL
                // sources fail; with a single source this is the reliable
                // signal, so flip straight to the failed state.
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }}
            />
          </video>
        </div>
      );
    }

    if (type === "audio") {
      const voiceNote = isVoiceNoteCard(card);
      return (
        <div className="p-3 space-y-3 rounded-2xl">
          <div className="flex items-center gap-2 text-black/80 dark:text-white/80">
            {voiceNote ? <Mic className="w-4 h-4" /> : <Music className="w-4 h-4" />}
            <span className="text-xs font-medium truncate">{title}</span>
          </div>
          {/* No native controls: the element is pointer-events-none (click
              opens the preview modal, which has a working player), so the
              controls rendered but never responded. */}
          <audio src={resolvedUrl} className="w-full h-10 pointer-events-none" preload="metadata" />
        </div>
      );
    }

    if (type === "pdf") {
      const fileName = attachment.name || title || "PDF";
      const embedUrl = vaultPdfEmbedUrl(resolvedUrl);
      return (
        <div className="rounded-2xl overflow-hidden glass-control cursor-pointer">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8 dark:border-white/8 pointer-events-none">
            <FileText className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
          </div>
          <div className={`w-full ${tileHeightClass} overflow-hidden bg-white dark:bg-[#f4f4f4]`}>
            <iframe
              src={embedUrl}
              title={title || "PDF preview"}
              className="w-full h-full border-0 opacity-0 transition-opacity duration-150 ease-out pointer-events-none"
              draggable={false}
              onLoad={(e) => { e.currentTarget.style.opacity = "1"; }}
            />
          </div>
        </div>
      );
    }

    if (type === "html") {
      const fileName = attachment.name || title || "Interactive artifact";
      // Prefer the freshly minted file-proxy URL; never paint a raw Supabase
      // storage URL into the iframe (wrong MIME / CSP → permanent blank).
      const storageTarget = parseStorageTarget(attachment || {});
      const isStorageBacked = !!(storageTarget?.bucket && storageTarget?.path);
      const candidate =
        resolvedAttachmentUrls[card.id] || (!isStorageBacked ? resolvedUrl : "");
      const htmlPreview = /supabase\.co\/storage\//i.test(candidate || "")
        ? null
        : safeHtmlPreviewUrl(candidate);
      const htmlFailed = failedImageIds.has(card.id);
      return (
        <div className="rounded-2xl overflow-hidden glass-control cursor-pointer">
          <div className={`w-full ${tileHeightClass} overflow-hidden bg-[#15130f]`}>
            {htmlPreview ? (
              <iframe
                src={htmlPreview.url}
                title={title || "Artifact preview"}
                className="w-full h-full border-0 pointer-events-none"
                sandbox={htmlPreview.sandbox}
                loading="lazy"
                referrerPolicy="no-referrer"
                draggable={false}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-white/45">
                {htmlFailed ? "Preview unavailable" : "Loading preview…"}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-black/8 dark:border-white/8 pointer-events-none">
            <FileText className="w-4 h-4 text-blue-500 shrink-0" />
            <div className="min-w-0">
              <span className="block text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
              <span className="block text-[0.625rem] text-black/45 dark:text-white/45">Interactive preview</span>
            </div>
          </div>
        </div>
      );
    }

    if (type === "instagram" || type === "tiktok" || type === "facebook") {
      const socialOembedHtml = String(attachment.oembedHtml || "");
      const socialUrl = String(attachment.url || resolvedUrl || "");
      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden`} draggable={false}>
          <SocialEmbedInline
            platform={type}
            oembedHtml={socialOembedHtml}
            url={socialUrl}
            thumbnailUrl={attachment.image || attachment.thumbnail_url || ""}
            title={attachment.title || title || ""}
            authorName={attachment.authorName || ""}
            authorHandle={attachment.authorHandle || ""}
            compact={isEmbeddedMode || isPickerMode}
          />
        </div>
      );
    }

    if (type === "youtube") {
      const videoId = extractYouTubeVideoId(String(attachment.url || "")) || String(attachment.videoId || "").trim() || null;
      const embedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";
      const customThumb = String(attachment.image || attachment.thumbnail_url || "").trim();

      if ((isEmbeddedMode || isWakePreview || isPickerMode) && (customThumb || videoId)) {
        const thumbUrl = customThumb || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return (
          <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black relative`} draggable={false}>
            <img
              src={thumbUrl}
              alt={title || "YouTube Video"}
              className="w-full h-full object-cover"
              draggable={false}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-14 h-10 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6 ml-0.5"><polygon points="8,5 20,12 8,19" /></svg>
              </div>
            </div>
          </div>
        );
      }

      if (!embedUrl) {
        const linkBody = (
          <div className="flex items-start gap-2 h-full">
            <Video className="w-4 h-4 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
              <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1 truncate">YouTube video</p>
            </div>
          </div>
        );
        if (isPickerMode) {
          return (
            <div className={`block p-4 rounded-2xl ${tileHeightClass} pointer-events-none`} draggable={false}>
              {linkBody}
            </div>
          );
        }
        return (
          <a
            href={safeExternalUrl(attachment.url) || undefined}
            target="_blank"
            rel="noreferrer"
            className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
            title="Open YouTube video"
            draggable={false}
          >
            {linkBody}
          </a>
        );
      }

      if (isPickerMode && videoId) {
        const thumbUrl = customThumb || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return (
          <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black relative pointer-events-none`} draggable={false}>
            <img
              src={thumbUrl}
              alt={title || "YouTube Video"}
              className="w-full h-full object-cover"
              draggable={false}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-14 h-10 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6 ml-0.5"><polygon points="8,5 20,12 8,19" /></svg>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black pointer-events-none`} draggable={false}>
          <iframe
            src={embedUrl}
            title={title || "YouTube video"}
            className="w-full h-full border-0 pointer-events-none"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      );
    }

    if (type === "bookmark") {
      if (attachment.connectorList && Array.isArray(attachment.listItems)) {
        const listCard = renderConnectorListCard(attachment, title, {
          compact: isWakePreview || uniformTile,
        });
        if (uniformTile) {
          return (
            <div className={`w-full ${tileHeightClass} overflow-hidden rounded-2xl`}>
              {listCard}
            </div>
          );
        }
        return listCard;
      }
      const linkUrl = attachment.url || resolvedUrl || "";
      // Never paint a Supabase storage URL as a "link" card — that used to
      // dump the signed URL into the tile when an image lost its type.
      if (
        isSupabaseStorageUrlText(linkUrl) ||
        attachment.storagePath ||
        attachment.storage_path ||
        attachment.variantMediumPath ||
        looksLikeImageAttachment(attachment)
      ) {
        // Recover as an image tile when possible; otherwise a neutral file
        // label (never the raw URL).
        if (looksLikeImageAttachment(attachment) || /\.(jpe?g|png|gif|webp|heic|avif)$/i.test(String(attachment.variantMediumPath || attachment.storagePath || ""))) {
          const imageCard = { ...card, type: "image" };
          return renderAttachmentCard(imageCard, tileHeightClass);
        }
        const storageLabel = sanitizeCardTitle(attachment.name || title || "", "Image");
        return (
          <div className={`p-4 rounded-2xl ${tileHeightClass}`}>
            <div className="flex items-start gap-2 h-full">
              <FileText className="w-4 h-4 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{storageLabel}</p>
                <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">Image</p>
              </div>
            </div>
          </div>
        );
      }
      const preview = (
        <div className={isPickerMode ? "pointer-events-none h-full" : "h-full"}>
          <LinkPreview
            url={linkUrl}
            title={sanitizeCardTitle(attachment.title || title || "")}
            description={String(attachment.description || "")}
            image={attachment.image || ""}
            siteName={attachment.siteName || ""}
            favicon={attachment.favicon || ""}
            authorName={attachment.authorName || ""}
            authorHandle={attachment.authorHandle || ""}
            oembedType={attachment.oembedType || ""}
            variant="vault"
          />
        </div>
      );
      if (uniformTile) {
        return (
          <div className={`w-full ${tileHeightClass} overflow-hidden rounded-2xl`}>
            {preview}
          </div>
        );
      }
      return preview;
    }

    if (type === "spreadsheet") {
      const cells = attachment.cells || {};
      const totalRows = Math.min(Number(attachment.rows) || 0, 8);
      const totalCols = Math.min(Number(attachment.cols) || 0, 6);
      const hasData = totalRows > 0 && totalCols > 0 && Object.keys(cells).length > 0;
      const fileName = attachment.name || title || "Spreadsheet";
      return (
        <div className={`rounded-2xl overflow-hidden glass-control ${uniformTile ? `w-full ${tileHeightClass}` : ""}`}>
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8 dark:border-white/8">
            <Table2 className="w-4 h-4 text-green-600 shrink-0" />
            <span className="text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
          </div>
          {hasData ? (
            <div className="overflow-hidden">
              <table className="w-full border-collapse text-[11px]">
                <tbody>
                  {Array.from({ length: totalRows }, (_, r) => (
                    <tr key={r} className={r === 0 ? "bg-black/5 font-semibold" : ""}>
                      {Array.from({ length: totalCols }, (_, c) => (
                        <td key={c} className="px-2 py-1 border-b border-r border-black/6 dark:border-white/6 text-black/70 dark:text-white/70 truncate max-w-[120px]">
                          {cells[`${r},${c}`] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(Number(attachment.rows) > 8 || Number(attachment.cols) > 6) && (
                <div className="px-3 py-1.5 text-[0.6rem] text-black/35 dark:text-white/35 text-center">
                  {attachment.rows} rows × {attachment.cols} cols
                </div>
              )}
            </div>
          ) : (
            <div className="px-3.5 py-4 text-center text-xs text-black/40 dark:text-white/40">Spreadsheet file</div>
          )}
        </div>
      );
    }

    if (type === "doc" || type === "word") {
      const fileBody = (
        <div className="flex items-start gap-2 h-full">
          <FileText className="w-4 h-4 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
            <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">{type.toUpperCase()} file</p>
          </div>
        </div>
      );
      if (isPickerMode) {
        return (
          <div className={`block p-4 rounded-2xl ${tileHeightClass} pointer-events-none`} draggable={false}>
            {fileBody}
          </div>
        );
      }
      return (
        <a
          href={safeAttachmentUrl(resolvedUrl) || undefined}
          target="_blank"
          rel="noreferrer"
          className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
          title={`Open ${type.toUpperCase()} file`}
          draggable={false}
        >
          {fileBody}
        </a>
      );
    }

    return (
      <div className={`p-4 rounded-2xl ${tileHeightClass}`}>
        <div className="flex items-start gap-2 h-full">
          {type === "youtube" ? <Video className="w-4 h-4 mt-0.5" /> : <FileText className="w-4 h-4 mt-0.5" />}
          <div className="min-w-0">
            <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
            <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">
              {type === "youtube" ? "YouTube video" : "File"}
            </p>
          </div>
        </div>
      </div>
    );
  };

  const vaultMemberFromCard = useCallback((card) => {
    const noteId = card?.noteId;
    if (!noteId) return null;
    return {
      nodeId: `vault_${noteId}`,
      label: String(card.title || (card.kind === "quick-note" ? "Quick Note" : "Vault item")).trim() || "Vault item",
      kind: "vault",
    };
  }, []);

  const removeCardFromProjects = useCallback(async (card) => {
    const member = vaultMemberFromCard(card);
    if (!member) return;
    const userId = user?.id || null;
    const list = Array.isArray(projects) && projects.length > 0
      ? projects
      : await listUserProjects(userId);
    const containing = list.filter(
      (p) => Array.isArray(p.members) && p.members.some((m) => m.nodeId === member.nodeId)
    );
    if (containing.length === 0) return;
    await Promise.all(
      containing.map((p) => removeNeuronFromProject(userId, p.id, member.nodeId))
    );
    invalidateVaultProjects();
  }, [invalidateVaultProjects, projects, user?.id, vaultMemberFromCard]);

  const removeAttachmentFromNote = useCallback(async (card) => {
    if (!user?.id || !card?.noteId) return;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);

      // Synthetic tiles built from URLs in note text (e.g. a YouTube link
      // pasted into a quick note) carry `syntheticType` and no real
      // `attachmentIndex`. Previously this fell through to the "delete the
      // whole note" branch via NaN — wiping notes that legitimately still
      // held other content. Strip just the URL from the note content
      // instead and bail before touching storage.
      if (card.syntheticType === "youtube-link") {
        const url = String(card.syntheticUrl || card.attachment?.url || "").trim();
        if (!url) return;
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stripped = String(note.content || "").replace(new RegExp(escaped, "g"), "").replace(/\n{3,}/g, "\n\n").trim();
        const { error: stripError } = await vaultWrites.update(card.noteId, {
          content: stripped,
          updated_at: new Date().toISOString(),
        });
        if (stripError) {
          notifyVaultCapIfApplicable(stripError);
          if (import.meta.env.DEV) console.error("[Vault] strip youtube link failed:", stripError);
          return;
        }
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: stripped, updated_at: new Date().toISOString() }
              : n
          )
        );
        removeCardFromProjects(card);
        return;
      }

      let storageRemovalAllowed = false;
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length || attachments.length <= 1) {
        const { error: deleteError } = await vaultWrites.remove(card.noteId);
        if (deleteError) {
          notifyVaultCapIfApplicable(deleteError);
          if (import.meta.env.DEV) console.error("[Vault] delete note failed:", deleteError);
          return;
        }
        purgeVaultNoteEmbeddings(card.noteId);
        setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
        // Bust the synthesis-layer's cached vault graph query so
        // the deleted vault note disappears from the brain on the
        // user's next visit without waiting for the realtime
        // postgres_changes event (which usually arrives ~100-300ms
        // later and won't fire at all if the project hasn't enabled
        // realtime on the `notes` table yet).
        vaultQueryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph"] });
        storageRemovalAllowed = true;
      } else {
        const nextAttachments = attachments.filter((_, i) => i !== idx);
        const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);
        let updateError = null;
        ({ error: updateError } = await vaultWrites.update(card.noteId, {
          content: nextContent,
          updated_at: new Date().toISOString(),
        }));
        if (updateError) {
          // Bail without touching storage — otherwise the file disappears
          // while the DB row still references it.
          notifyVaultCapIfApplicable(updateError);
          if (import.meta.env.DEV) console.error("[Vault] partial attachment removal failed:", updateError);
          return;
        }
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        storageRemovalAllowed = true;
      }

      removeCardFromProjects(card);

      if (storageRemovalAllowed) {
        const storageTarget = parseStorageTarget(card.attachment || {});
        // Local files are already gone: deleting the row takes its whole blob
        // directory with it, so there is nothing left to clean up here.
        if (storageTarget?.bucket && storageTarget?.path && !isLocalTarget(storageTarget)) {
          const { error: storageError } = await supabase.storage
            .from(storageTarget.bucket)
            .remove([storageTarget.path]);
          if (storageError && import.meta.env.DEV) {
            console.warn("[Vault] storage cleanup failed:", storageError);
          }
        }
      }
    } finally {
      setOpenCardMenuId(null);
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id, removeCardFromProjects]);

  const removeQuickNoteCard = useCallback(async (card) => {
    if (!user?.id || !card?.noteId) return;
    setIsCardActionBusy(true);
    try {
      // Check the delete actually succeeded before optimistically
      // dropping the card. If RLS or the network rejected, we used to
      // silently remove the row from local state and leak it on the
      // server until the next refetch — which made deleted-then-
      // reappearing cards a user-visible mystery.
      const { error: deleteError } = await vaultWrites.remove(card.noteId);
      if (deleteError) {
        notifyVaultCapIfApplicable(deleteError);
        if (import.meta.env.DEV) console.error("[Vault] delete quick note failed:", deleteError);
        return;
      }
      purgeVaultNoteEmbeddings(card.noteId);
      setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
      // Mirror the attachment-delete path above: bust the synthesis-
      // layer cache so the quick-note neuron disappears from the brain
      // without waiting on the postgres_changes realtime round-trip.
      vaultQueryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph"] });
      removeCardFromProjects(card);
      setOpenCardMenuId(null);
    } finally {
      setIsCardActionBusy(false);
    }
  }, [user?.id, removeCardFromProjects, vaultQueryClient]);

  const addCardToProject = useCallback(async (card, projectId) => {
    if (!card || !projectId) return;
    const member = vaultMemberFromCard(card);
    if (!member) {
      toast({
        title: "Couldn't add to project",
        description: "This item isn't linked to a vault note yet.",
        variant: "destructive",
      });
      return;
    }
    setIsCardActionBusy(true);
    try {
      const project = projects.find((p) => String(p.id) === String(projectId));
      if (!project) return;
      await addNeuronsToProject(user?.id || null, projectId, [member]);
      invalidateVaultProjects();
      setOpenCardMenuId(null);
      setPreviewProjectDropdownOpen(false);
      toast({
        title: "Added to project",
        description: project.name,
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error("[Vault] add to project failed:", err);
      toast({
        title: "Couldn't add to project",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, [invalidateVaultProjects, projects, user?.id, vaultMemberFromCard]);

  const addAttachmentNote = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      const newNote = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
      const nextAttachmentNotes = [...existingNotes, newNote];
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const addQuickNoteComment = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      const newComment = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
      const nextComments = [...existing, newComment];

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        // Column not deployed yet — surface a clear error rather than
        // silently dropping the comment.
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  // Phase 4: the single "why" field — one scalar reason per vault item,
  // distinct from the comments thread. Persisted to notes.why (utf8).
  const saveCardWhy = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const why = String(textInput || "").trim().slice(0, 2000);
    setIsCardActionBusy(true);
    try {
      const { error: updateError } = await vaultWrites.update(card.noteId, {
        why,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.why column missing — run migration 105_vault_why_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, why, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [user?.id]);

  const addWakePreviewCardComment = useCallback((card, textInput) => {
    const text = String(textInput || "").trim();
    if (!text || !card?.id) return false;
    const saved = appendWakeVaultPreviewComment(card.id, text);
    setWakePreviewCardComments((prev) => ({
      ...prev,
      [card.id]: [...(prev[card.id] || []), saved],
    }));
    return true;
  }, []);

  const removeAttachmentNote = useCallback(async (card, commentId) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      const nextAttachmentNotes = existingNotes.filter((entry) => entry.id !== commentId);
      if (nextAttachmentNotes.length === existingNotes.length) return false;
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const removeQuickNoteComment = useCallback(async (card, commentId) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      const nextComments = existing.filter((entry) => entry.id !== commentId);
      if (nextComments.length === existing.length) return false;

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateAttachmentNote = useCallback(async (card, commentId, textInput) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      let changed = false;
      const nextAttachmentNotes = existingNotes.map((entry) => {
        if (entry.id !== commentId) return entry;
        changed = true;
        return { ...entry, text };
      });
      if (!changed) return false;
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateQuickNoteComment = useCallback(async (card, commentId, textInput) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      let changed = false;
      const nextComments = existing.map((entry) => {
        if (entry.id !== commentId) return entry;
        changed = true;
        return { ...entry, text };
      });
      if (!changed) return false;

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateWakePreviewCardComment = useCallback((card, commentId, textInput) => {
    const text = String(textInput || "").trim();
    if (!text || !card?.id || !commentId) return false;
    setWakePreviewCardComments((prev) => {
      const list = prev[card.id] || [];
      const nextForCard = list.map((entry) =>
        entry.id === commentId ? { ...entry, text } : entry,
      );
      return { ...prev, [card.id]: nextForCard };
    });
    return true;
  }, []);

  const removeWakePreviewCardComment = useCallback((card, commentId) => {
    if (!card?.id || !commentId) return false;
    removeWakeVaultPreviewComment(card.id, commentId);
    setWakePreviewCardComments((prev) => {
      const nextForCard = (prev[card.id] || []).filter((entry) => entry.id !== commentId);
      if (nextForCard.length === 0) {
        const next = { ...prev };
        delete next[card.id];
        return next;
      }
      return { ...prev, [card.id]: nextForCard };
    });
    setWakePreviewDeletedComments((prev) => ({
      ...prev,
      [card.id]: Array.from(new Set([...(prev[card.id] || []), commentId])),
    }));
    return true;
  }, []);

  const confirmAndDeleteAttachment = useCallback((card) => {
    if (!card) return;
    const label = String(card?.title || "this file");
    const ok = window.confirm(`Are you sure you want to delete "${label}"? This cannot be undone.`);
    if (!ok) return;
    void removeAttachmentFromNote(card);
  }, [removeAttachmentFromNote]);

  // Bulk delete with the same 6-second undo grace window as drag-to-trash.
  // Each card is hidden optimistically, then committed individually once the
  // timer fires. Undo restores everything that hasn't been committed yet.
  const deleteSelectedCards = useCallback(() => {
    const ids = Array.from(selectedCardIds);
    if (ids.length === 0) return;
    const allCards = vaultCardsRef.current || [];
    const cards = ids
      .map((id) => allCards.find((c) => c.id === id))
      .filter((c) => isSelectableCard(c) && !pendingDeleteCardIds.has(c.id));
    if (cards.length === 0) {
      clearSelection();
      return;
    }
    const label = cards.length === 1
      ? `"${String(cards[0].title || "this item").slice(0, 60)}"`
      : `${cards.length} items`;
    const ok = window.confirm(
      `Delete ${label}? This cannot be undone after the undo window.`
    );
    if (!ok) return;

    setPendingDeleteCardIds((prev) => {
      const next = new Set(prev);
      for (const c of cards) next.add(c.id);
      return next;
    });

    const snapshots = cards.slice();
    for (const card of snapshots) {
      const commitDelete = () => {
        pendingDeleteTimersRef.current.delete(card.id);
        setPendingDeleteCardIds((prev) => {
          if (!prev.has(card.id)) return prev;
          const next = new Set(prev);
          next.delete(card.id);
          return next;
        });
        if (card.kind === "attachment") {
          void removeAttachmentFromNote(card);
        } else if (card.kind === "quick-note") {
          void removeQuickNoteCard(card);
        }
      };
      const timerId = setTimeout(commitDelete, TRASH_UNDO_GRACE_MS);
      pendingDeleteTimersRef.current.set(card.id, timerId);
    }

    const t = toast({
      title: snapshots.length === 1 ? "Moved to trash" : `${snapshots.length} items moved to trash`,
      description: snapshots.length === 1
        ? `"${String(snapshots[0].title || "Item").slice(0, 60)}" will be deleted.`
        : "Items will be deleted shortly.",
      duration: TRASH_UNDO_GRACE_MS,
      action: (
        <ToastAction
          altText="Undo delete"
          onClick={() => {
            for (const card of snapshots) {
              const pending = pendingDeleteTimersRef.current.get(card.id);
              if (pending) {
                clearTimeout(pending);
                pendingDeleteTimersRef.current.delete(card.id);
              }
            }
            setPendingDeleteCardIds((prev) => {
              const next = new Set(prev);
              for (const card of snapshots) next.delete(card.id);
              return next;
            });
            t.dismiss();
          }}
        >
          Undo
        </ToastAction>
      ),
    });

    clearSelection();
  }, [
    selectedCardIds,
    pendingDeleteCardIds,
    isSelectableCard,
    clearSelection,
    removeAttachmentFromNote,
    removeQuickNoteCard,
  ]);

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

  // ── AI Drive (the Studio's folder listing) ────────────────────────────────
  //
  // Same cards, same previews, same deletes — a different way of drawing them.
  // Everything below translates between the two: a card into a row, a click on
  // a row back into the card handler it belongs to.

  /**
   * What a row shows before you open it, in descending order of how much it
   * tells you.
   *
   * Anything with real image bytes — a photo, a video's poster frame, a link's
   * card art — is an image. A web artifact or a PDF has no such bytes, so it's
   * drawn by rendering it (`embed`). Everything else the AI writes is text at
   * bottom — React source, a CSV, markup we couldn't frame — and the head of
   * that text is its own best preview (`textUrl`). `paper` is the floor: a
   * document we can't read still gets drawn as a document.
   */
  const driveArtFor = useCallback((card) => {
    if (card.kind !== "attachment") return {};
    const att = card.attachment || {};
    const type = String(card.type || "");
    const resolved = resolvedAttachmentUrls[card.id] || "";
    if (type === "image") {
      if (resolved) return { thumb: resolved };
      // An unsigned storage URL would only paint a broken image.
      const raw = String(att.url || "");
      if (!raw || isSupabaseStorageUrlText(raw) || att.storagePath) return {};
      return { thumb: raw };
    }
    if (type === "video") return { thumb: resolvedVideoPosterUrls[card.id] || "" };
    if (type === "youtube") {
      const videoId = att.videoId || extractYouTubeVideoId(att.url || "");
      return { thumb: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : "" };
    }
    // The URL stored with the attachment is a live proxy link too, so a preview
    // doesn't have to wait for (or depend on) a freshly minted one.
    const fileUrl = resolved || String(att.url || "");

    if (type === "pdf") {
      // The viewer's own chrome would be most of what you see at this size.
      return fileUrl ? { embed: vaultPdfEmbedUrl(fileUrl), portrait: true } : { paper: true };
    }
    if (type === "html") {
      // The artifact's own markup, rendered inline. Preferred over framing the
      // proxied page because it doesn't need the shell's origin to appear in
      // the proxy's frame-ancestors — see `resolveDriveMarkupForCard`.
      const markup = driveMarkup[card.id];
      if (markup) return { srcDoc: markup };
      // Not read yet (or unreadable): a raw storage URL must never go in a frame
      // — wrong MIME and a blocking CSP leave it permanently blank — so let
      // safeHtmlPreviewUrl decide the host allowlist and the sandbox.
      const isStorageUrl = isSupabaseStorageUrlText(fileUrl);
      const preview = isStorageUrl ? null : safeHtmlPreviewUrl(fileUrl);
      if (preview) return { embed: preview.url, sandbox: preview.sandbox, paper: true };
      return { paper: true };
    }
    if (type === "spreadsheet" || type === "file") {
      const name = String(att.name || card.title || "");
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      return { textUrl: TEXT_PREVIEW_EXTS.has(ext) ? fileUrl : "", paper: true };
    }
    return { thumb: att.image || att.favicon || "" };
  }, [resolvedAttachmentUrls, resolvedVideoPosterUrls, driveMarkup]);

  const driveEntries = useMemo(() => {
    if (!studioSurface) return [];
    return orderedVisibleCards.map((card) => ({
      ...driveEntryFor(card),
      ...driveArtFor(card),
    }));
  }, [studioSurface, orderedVisibleCards, driveArtFor]);

  // Only the tags actually worn by the AI's output. `allTags` covers the whole
  // vault, and offering a filter for tags nothing in this drive carries would
  // just be a menu of ways to empty the window.
  const driveTags = useMemo(() => {
    if (!studioSurface) return [];
    const counts = new Map();
    for (const card of vaultCards) {
      if (!driveFolderIdFor(card)) continue;
      for (const raw of card.tags || []) {
        const tag = String(raw).trim();
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [studioSurface, vaultCards]);

  const selectableIdsAmong = useCallback((ids) => {
    const byId = new Map((vaultCardsRef.current || []).map((c) => [c.id, c]));
    return ids.filter((id) => isSelectableCard(byId.get(id)));
  }, [isSelectableCard]);

  // A listing selects on click and opens on double-click, so this deliberately
  // does NOT go through `handleCardPress` (which opens a preview on a single
  // click, the right behaviour for a collage tile and the wrong one here).
  const handleDriveSelect = useCallback((event, entry, orderedIds) => {
    const card = entry?.card;
    if (!card) return;
    closeAllVaultPopovers();
    if (!isSelectableCard(card)) {
      clearSelection();
      return;
    }
    const anchorId = lastSelectedCardIdRef.current;
    if (event?.shiftKey && anchorId) {
      const from = orderedIds.indexOf(anchorId);
      const to = orderedIds.indexOf(card.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedCardIds(new Set(selectableIdsAmong(orderedIds.slice(lo, hi + 1))));
        return;
      }
    }
    if (event?.metaKey || event?.ctrlKey) {
      toggleCardSelection(card);
      return;
    }
    setSelectedCardIds(new Set([card.id]));
    lastSelectedCardIdRef.current = card.id;
  }, [closeAllVaultPopovers, isSelectableCard, clearSelection, selectableIdsAmong, toggleCardSelection]);

  const handleDriveEnterFolder = useCallback((entry) => {
    const folderId = entry?.card?.folderId;
    if (!folderId) return;
    closeAllVaultPopovers();
    clearSelection();
    setOpenDriveFolder(folderId);
  }, [closeAllVaultPopovers, clearSelection]);

  const handleDriveExitFolder = useCallback(() => {
    setOpenDriveFolder(null);
  }, []);

  /** What the breadcrumb says we're inside. */
  const driveFolder = useMemo(() => {
    const match = DRIVE_FOLDERS.find((f) => f.id === openDriveFolder);
    return match ? { id: match.id, name: match.name } : null;
  }, [openDriveFolder]);

  /**
   * The address for a card's bytes. Bytes on this device resolve at once, a
   * cloud object is signed (and cached the same way the grid caches), and an
   * artifact goes through the file proxy, whose relaxed script policy is what
   * interactive React/Babel builds need to actually run.
   */
  const resolveCardMediaUrl = useCallback(async (card, type) => {
    if (!card) return "";
    const att = card.attachment || {};

    const bytesUrl = async () => {
      const target = parseStorageTarget(att);
      if (target?.bucket && target?.path) {
        if (isLocalTarget(target)) return localBlobUrl(target.path) || "";
        const cacheKey = `full:${target.bucket}:${target.path}`;
        const cached = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
        if (cached) return cached;
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          if (data?.signedUrl) {
            writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
            return data.signedUrl;
          }
        } catch {
          /* fall back to whatever address the card already carries */
        }
      }
      return resolvedAttachmentUrls[card.id] || String(att.url || "").trim();
    };

    if (type !== "html") return bytesUrl();

    const proxied = await resolveHtmlArtifactOpenUrl(card);
    if (proxied) return proxied;
    // Nothing hosted it — a build that only exists on this device, or the proxy
    // is down. Frame the markup itself; a blob URL is its own opaque origin, so
    // the artifact still runs without reaching anything of the user's.
    const direct = await bytesUrl();
    if (!direct) return "";
    try {
      const resp = await fetch(direct);
      if (!resp.ok) return "";
      return URL.createObjectURL(new Blob([await resp.text()], { type: "text/html" }));
    } catch {
      return "";
    }
  }, [resolveHtmlArtifactOpenUrl, resolvedAttachmentUrls]);

  /**
   * The folders the vault actually has — the distinct names rows are filed
   * under. There is no folder table; a folder exists because something is in
   * it, which is also why AI Drive's own name is left off this list (it has its
   * own entry in the move menu).
   */
  const vaultFolders = useMemo(() => {
    const names = new Set();
    for (const note of notes) {
      const name = String(note?.folder || "").trim();
      if (name && name !== AI_DRIVE_FOLDER) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [notes]);

  // A file window outlives the render that opened it and reads its menus when
  // the user opens them, so these go through refs rather than closed-over state.
  const vaultFoldersRef = useRef(vaultFolders);
  vaultFoldersRef.current = vaultFolders;
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const moveCardToFolder = useCallback(async (card, folder) => {
    if (!card?.noteId) {
      toast({
        title: "Couldn't move this",
        description: "This item isn't linked to a vault note yet.",
        variant: "destructive",
      });
      return;
    }
    const next = String(folder || "").trim();
    const updatedAt = new Date().toISOString();
    setIsCardActionBusy(true);
    try {
      const { error } = await vaultWrites.update(card.noteId, {
        folder: next,
        updated_at: updatedAt,
      });
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.error("[Vault] move to folder failed:", error);
        toast({
          title: "Couldn't move this",
          description: "Something went wrong. Please try again.",
          variant: "destructive",
        });
        return;
      }
      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId) ? { ...n, folder: next, updated_at: updatedAt } : n,
        ),
      );
      // What the model is told the drive holds is cached; this just changed it.
      clearAiDriveCache();
      toast({
        title: "Moved",
        description: next === AI_DRIVE_FOLDER ? "AI Drive" : next,
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, []);

  /** Out of the vault and onto the disk, wherever the save sheet is pointed. */
  const saveCardToDevice = useCallback(async (card, type) => {
    const name = String(card?.attachment?.name || card?.title || "file");
    try {
      const url = await resolveCardMediaUrl(card, type);
      const response = url ? await fetch(url) : null;
      if (!response?.ok) throw new Error("no bytes");
      const blob = await response.blob();
      const saved = await saveFileToChosenFolder(blob, name, blob.type);
      // No path means they closed the sheet, which needs no announcement.
      if (saved) toast({ title: "Saved to this Mac", description: saved });
    } catch {
      toast({
        title: "Couldn't save this",
        description: "The file couldn't be read. Try again in a moment.",
        variant: "destructive",
      });
    }
  }, [resolveCardMediaUrl]);

  const handleDriveOpen = useCallback((entry) => {
    const card = entry?.card;
    if (!card) return;
    closeAllVaultPopovers();
    // Chat-bar "+" is a picker: click selects, Add confirms. Don't steal
    // the listing out from under the Add / Cancel bar.
    if (isChatPickMode) return;

    // What LYKN made opens in the same window a document on the Desktop opens
    // in. A generated image and a downloaded one are both just files, and
    // there was no reason left for them to behave differently.
    const att = card.attachment || {};
    const type = resolveAttachmentType(att) || card.type;
    if (card.kind === "attachment" && !DRIVE_LINK_TYPES.has(type)) {
      openFileWindow({
        itemId: card.id,
        name: att.name || card.title || "File",
        mime: att.mimeType || att.mime || null,
        size: att.size ?? att.fileSize ?? null,
        media: DRIVE_WINDOW_MEDIA[type] || null,
        resolveUrl: () => resolveCardMediaUrl(card, type),
        picks: [
          {
            id: "project",
            label: "Add to project",
            icon: FolderKanban,
            empty: "No projects yet.",
            options: () =>
              projectsRef.current.map((project) => ({
                id: String(project.id),
                label: project.name,
              })),
            onPick: (projectId) => addCardToProject(card, projectId),
          },
          {
            id: "move",
            label: "Move to",
            icon: FolderInput,
            options: () => {
              const note = notesRef.current.find(
                (n) => String(n?.id) === String(card.noteId),
              );
              const at = String(note?.folder || "").trim();
              return [
                { id: AI_DRIVE_FOLDER, label: "AI Drive", current: at === AI_DRIVE_FOLDER },
                ...(canSaveFileAs()
                  ? [{ id: MOVE_TO_DEVICE, label: "A folder on this Mac…" }]
                  : []),
                ...vaultFoldersRef.current.map((name) => ({
                  id: name,
                  label: name,
                  current: at === name,
                })),
              ];
            },
            onPick: (choice) =>
              choice === MOVE_TO_DEVICE
                ? saveCardToDevice(card, type)
                : moveCardToFolder(card, choice),
          },
        ],
      });
      return;
    }

    // Notes and links aren't files; they keep the vault's own reader.
    setPreviewDetailsOpen(false);
    setPreviewCard(card);
  }, [
    closeAllVaultPopovers,
    isChatPickMode,
    resolveCardMediaUrl,
    addCardToProject,
    moveCardToFolder,
    saveCardToDevice,
  ]);

  /**
   * `/vault?pane=drive[&folder=…][&note=…]` — how something in AI Drive gets
   * put on screen from outside. lykn_open_app settles WHICH item was meant and
   * hands the vault tab this route; landing on it happens here.
   *
   * A row older than the first page isn't loaded yet, so the link survives
   * until the pages run out rather than being dropped on the first miss — this
   * re-runs as each page lands.
   */
  useEffect(() => {
    if (!studioSurface) return;
    const params = new URLSearchParams(location.search);
    const wantFolder = params.get("folder");
    const wantNote = params.get("note");
    if (!wantFolder && !wantNote) return;

    if (wantNote) {
      const match = vaultCards.find(
        (card) => card && String(card.noteId) === wantNote && driveFolderIdFor(card),
      );
      if (!match) {
        if (isLoadingNotes) return;
        if (hasMoreNotes) { void loadMoreNotes(); return; }
        // Deleted, or never in the drive. Fall through to the folder so the
        // window still shows something related rather than nothing.
      } else {
        setOpenDriveFolder(driveFolderIdFor(match));
        handleDriveOpen({ card: match });
        clearDriveLinkParams();
        return;
      }
    }

    if (wantFolder === "artifacts" || wantFolder === "images") setOpenDriveFolder(wantFolder);
    clearDriveLinkParams();
  }, [
    studioSurface, location.search, vaultCards, isLoadingNotes, hasMoreNotes,
    loadMoreNotes, handleDriveOpen, clearDriveLinkParams,
  ]);

  const handleDriveMenu = useCallback((entry, element) => {
    if (!entry?.card) return;
    // Folder tiles are synthetic — there's no row behind them to tag or delete.
    if (entry.card.kind === "source-folder" || entry.card.kind === "drive-folder") return;
    openCardMenuForAnchor(entry.id, element);
  }, [openCardMenuForAnchor]);

  const handleDriveSelectAll = useCallback((ids) => {
    setSelectedCardIds(new Set(selectableIdsAmong(ids)));
  }, [selectableIdsAmong]);

  const handleDriveClearSearch = useCallback(() => {
    setEmbeddedSearch("");
    setVaultSearch("");
    setConceptResultIds(null);
  }, []);

  const handleDriveToggleTag = useCallback((tag) => {
    setSelectedFilterTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

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
        <section className="mb-6">
          {isEmbeddedMode ? (
            <div className="space-y-3">
              <div className="relative w-full">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
                <input
                  type="text"
                  value={embeddedSearch}
                  onChange={(e) => setEmbeddedSearch(e.target.value)}
                  placeholder="Search your vault: type an idea, topic, or keyword"
                  className="w-full h-11 rounded-2xl glass-control pl-10 pr-12 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                />
                {embeddedSearch.trim() ? (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                    <button
                      type="button"
                      onClick={() => setEmbeddedSearch("")}
                      className="w-5 h-5 flex items-center justify-center text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
                      title="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(() => {
                  const current = VAULT_VIEW_OPTIONS.find((v) => v.id === vaultView) || VAULT_VIEW_OPTIONS[0];
                  const CurrentIcon = current.icon;
                  return (
                    <div className="relative" ref={vaultViewDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowVaultViewDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium bg-black/[0.04] hover:bg-black/[0.07] text-black/60 hover:text-black/80 dark:bg-white/10 dark:hover:bg-white/15 dark:text-white/60 transition-colors"
                      >
                        <CurrentIcon className="w-3 h-3" />
                        {current.label}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showVaultViewDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {showVaultViewDropdown && (
                        <div className="lg-menu absolute top-full left-0 mt-1 w-44 z-[400] py-1">
                          {VAULT_VIEW_OPTIONS.map((v) => {
                            const Icon = v.icon;
                            const active = vaultView === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                  setVaultView(v.id);
                                  setShowVaultViewDropdown(false);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors ${
                                  active ? "text-blue-600 dark:text-blue-400 font-medium" : "text-black/70 dark:text-white/70"
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5 shrink-0" />
                                <span className="flex-1 truncate">{v.label}</span>
                                {active && <Check className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              {allTags.length > 0 && (
                <div className="relative" ref={embeddedTagDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setShowEmbeddedTagDropdown((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium bg-black/[0.04] hover:bg-black/[0.07] text-black/60 hover:text-black/80 dark:bg-white/10 dark:hover:bg-white/15 dark:text-white/60 transition-colors"
                  >
                    <Tag className="w-3 h-3" />
                    {selectedFilterTags.length > 0
                      ? `${selectedFilterTags.length} tag${selectedFilterTags.length > 1 ? "s" : ""} selected`
                      : "Filter by tag"}
                    <ChevronDown className={`w-3 h-3 transition-transform ${showEmbeddedTagDropdown ? "rotate-180" : ""}`} />
                  </button>
                  {selectedFilterTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedFilterTags([])}
                      className="ml-1.5 text-[0.625rem] text-blue-500 hover:text-blue-600"
                    >
                      Clear
                    </button>
                  )}
                  {showEmbeddedTagDropdown && (
                    <div className="lg-menu absolute top-full left-0 mt-1 w-52 max-h-56 overflow-y-auto z-[400] py-1 scrollbar-hide">
                      {(() => {
                        const untaggedActive = selectedFilterTags.includes("__untagged__");
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedFilterTags((prev) =>
                                untaggedActive ? prev.filter((t) => t !== "__untagged__") : [...prev, "__untagged__"]
                              )
                            }
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors border-b border-black/5 dark:border-white/5 mb-0.5"
                          >
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${untaggedActive ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                              {untaggedActive && <Check className="w-2.5 h-2.5" />}
                            </div>
                            <span className={`flex-1 truncate italic ${untaggedActive ? "text-black/90 dark:text-white/90 font-medium" : "text-black/50 dark:text-white/50"}`}>
                              Not Tagged
                            </span>
                          </button>
                        );
                      })()}
                      {allTags.map((tag) => {
                        const active = selectedFilterTags.includes(tag.name);
                        return (
                          <button
                            key={tag.name}
                            type="button"
                            onClick={() =>
                              setSelectedFilterTags((prev) =>
                                active ? prev.filter((t) => t !== tag.name) : [...prev, tag.name]
                              )
                            }
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                          >
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${active ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                              {active && <Check className="w-2.5 h-2.5" />}
                            </div>
                            <span className={`flex-1 truncate ${active ? "text-black/90 dark:text-white/90 font-medium" : "text-black/65 dark:text-white/65"}`}>
                              {tag.name}
                            </span>
                            <span className="text-[0.625rem] text-black/30 dark:text-white/30">{tag.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              </div>
            </div>
          ) : (
            <>
              {!isWakePreview && (
                <>
                  <h1 className="text-3xl font-semibold">The Vault</h1>
                  <p className="text-black/60 dark:text-white/60 mt-1">
                    Your digital collage of media files, videos, images, and quick notes. Drag and drop files or folders anywhere on this page.
                  </p>
                </>
              )}
              <div
                className="relative z-[400] mt-4 flex flex-wrap items-center gap-3"
                style={{ minHeight: 1 }}
              >
                <form
                  className="relative w-full sm:flex-1 sm:max-w-xl"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleConceptSearch(vaultSearch);
                  }}
                >
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35 dark:text-white/35" />
                  <input
                    type="text"
                    value={vaultSearch}
                    onChange={(e) => {
                      setVaultSearch(e.target.value);
                      if (conceptResultIds !== null) setConceptResultIds(null);
                    }}
                    placeholder={
                      isWakePreview
                        ? "Search your vault: type an idea, topic, or keyword"
                        : "Search your vault: type an idea, topic, or keyword and press Enter"
                    }
                    className="w-full h-11 rounded-2xl glass-control pl-10 pr-20 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {isConceptSearching ? (
                      <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                    ) : vaultSearch.trim() ? (
                      <>
                        <button
                          type="submit"
                          className="w-7 h-7 flex items-center justify-center text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 transition-colors"
                          title="Search"
                        >
                          <Search className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setVaultSearch(""); setConceptResultIds(null); }}
                          className="w-5 h-5 flex items-center justify-center text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </form>
                {(() => {
                  const current = VAULT_VIEW_OPTIONS.find((v) => v.id === vaultView) || VAULT_VIEW_OPTIONS[0];
                  const CurrentIcon = current.icon;
                  return (
                    <div className="relative shrink-0" ref={vaultViewDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowVaultViewDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        <CurrentIcon className="w-3 h-3" />
                        {current.label}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showVaultViewDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {showVaultViewDropdown && (
                        <div className={`lg-menu absolute top-full mt-1 w-44 max-w-[calc(100vw-1.5rem)] z-[400] py-1 ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
                          {VAULT_VIEW_OPTIONS.map((v) => {
                            const Icon = v.icon;
                            const active = vaultView === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                  setVaultView(v.id);
                                  setShowVaultViewDropdown(false);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors ${
                                  active ? "text-blue-600 dark:text-blue-400 font-medium" : "text-black/70 dark:text-white/70"
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5 shrink-0" />
                                <span className="flex-1 truncate">{v.label}</span>
                                {active && <Check className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {allTags.length > 0 && (
                  <div className="relative shrink-0" ref={embeddedTagDropdownRef}>
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowEmbeddedTagDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        <Tag className="w-3 h-3" />
                        {selectedFilterTags.length > 0
                          ? `${selectedFilterTags.length} tag${selectedFilterTags.length > 1 ? "s" : ""} selected`
                          : "Filter by tag"}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showEmbeddedTagDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {selectedFilterTags.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedFilterTags([])}
                          className="text-[0.6875rem] text-blue-500 hover:text-blue-600"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                    {showEmbeddedTagDropdown && (
                      <div className={`lg-menu absolute top-full mt-1 w-56 md:w-64 max-w-[calc(100vw-1.5rem)] max-h-72 overflow-y-auto z-[400] py-1 scrollbar-hide ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
                        {(() => {
                          const untaggedActive = selectedFilterTags.includes("__untagged__");
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedFilterTags((prev) =>
                                  untaggedActive ? prev.filter((t) => t !== "__untagged__") : [...prev, "__untagged__"]
                                )
                              }
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors border-b border-black/5 dark:border-white/5 mb-0.5"
                            >
                              <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${untaggedActive ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                                {untaggedActive && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <span className={`flex-1 truncate italic ${untaggedActive ? "text-black/90 dark:text-white/90 font-medium" : "text-black/50 dark:text-white/50"}`}>
                                Not Tagged
                              </span>
                            </button>
                          );
                        })()}
                        {allTags.map((tag) => {
                          const active = selectedFilterTags.includes(tag.name);
                          return (
                            <button
                              key={tag.name}
                              type="button"
                              onClick={() =>
                                setSelectedFilterTags((prev) =>
                                  active ? prev.filter((t) => t !== tag.name) : [...prev, tag.name]
                                )
                              }
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                            >
                              <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${active ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                                {active && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <span className={`flex-1 truncate ${active ? "text-black/90 dark:text-white/90 font-medium" : "text-black/65 dark:text-white/65"}`}>
                                {tag.name}
                              </span>
                              <span className="text-[0.625rem] text-black/30 dark:text-white/30">{tag.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {!isWakePreview && !studioSurface && (
                  <button
                    type="button"
                    onClick={() => nav("/settings?section=connections")}
                    className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-full bg-blue-500 px-3.5 py-2 text-[0.75rem] font-medium text-white shadow-sm hover:bg-blue-600 transition-colors"
                    title="Connect apps to your Vault"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    Connect apps
                  </button>
                )}
                {isWakePreview && (
                  <button
                    type="button"
                    onClick={() => onWakePreviewTabChange?.("connections")}
                    className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-full bg-blue-500 px-3.5 py-2 text-[0.75rem] font-medium text-white shadow-sm hover:bg-blue-600 transition-colors"
                    title="Connect apps to your Vault"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    Connect apps
                  </button>
                )}
                </div>
              {isConceptSearching && (
                <p className="mt-2 text-xs text-black/40 dark:text-white/40">Reading through your vault...</p>
              )}
              {conceptResultIds !== null && !isConceptSearching && (() => {
                // Count only IDs that are actually present in the current
                // visible card list. The raw `conceptResultIds.length`
                // includes notes that have been filtered out (tag filter,
                // search), deleted, or aren't loaded — leading to "Found
                // 12 related items" when only 5 cards actually appear.
                const visibleIds = new Set(visibleCards.map((c) => c.id));
                const matchedCount = conceptResultIds.filter((id) => visibleIds.has(id)).length;
                return (
                <div className="mt-2 flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
                  <span>
                    {matchedCount === 0
                      ? "Nothing in your vault matches that"
                      : `Found ${matchedCount} related item${matchedCount === 1 ? "" : "s"}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setVaultSearch(""); setConceptResultIds(null); }}
                    className="text-blue-500 hover:text-blue-600"
                  >
                    Show all
                  </button>
                </div>
                );
              })()}
            </>
          )}
        </section>

        {notesError && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-red-600">{notesError}</p>
          </div>
        )}

        {(isWakePreview || (!loading && !isLoadingNotes && (vaultReady || !user))) && !notesError && (
          <motion.div initial={false} animate={{ opacity: 1 }}>
            {openSourceFolder && openFolderConnector && (
              <div className="mb-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setOpenSourceFolder(null)}
                  className="inline-flex items-center gap-1.5 rounded-full glass-control px-3 py-1.5 text-[0.75rem] font-medium text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                  <span>Back to Vault</span>
                </button>
                <div className="flex items-center gap-2 min-w-0">
                  {openFolderConnector.favicon && (
                    <img
                      src={openFolderConnector.favicon}
                      alt=""
                      width={20}
                      height={20}
                      className="block rounded-sm shrink-0"
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                    />
                  )}
                  <h2 className="text-sm font-semibold text-black/80 dark:text-white/80 truncate">
                    {openFolderConnector.name}
                  </h2>
                  <span className="text-xs text-black/40 dark:text-white/40 font-medium shrink-0">
                    {orderedVisibleCards.length} {orderedVisibleCards.length === 1 ? "item" : "items"}
                  </span>
                </div>
              </div>
            )}
            {orderedVisibleCards.length === 0 ? (
              <div className="flex flex-col items-start gap-4">
                <div className="break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 p-6 flex flex-col items-center justify-center text-center w-full sm:w-64 min-h-[160px] gap-3">
                  <div className="text-sm font-medium text-black/40 dark:text-white/40 mb-1">Add attachments</div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={handleRequestAddMedia}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Upload className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Upload Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRequestSaveLink}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Globe className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Save Link</span>
                    </button>
                  </div>
                </div>
                {embeddedSearch.trim() ? (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70 dark:text-white/70">No results match your search.</p>
                  </div>
                ) : selectedFilterTags.length > 0 ? (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70 dark:text-white/70">Nothing matches the selected tags.</p>
                  </div>
                ) : null}
              </div>
            ) : vaultView === "tags" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={handleRequestAddMedia} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={handleRequestSaveLink} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Globe className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                  </button>
                </div>
                {tagGroupedCards.map(([tagName, cards]) => (
                  <div key={tagName}>
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="w-4 h-4 text-black/40 dark:text-white/40" />
                      <h2 className="text-lg font-semibold text-black/80 dark:text-white/80">{tagName}</h2>
                      <span className="text-xs text-black/40 dark:text-white/40 font-medium">{cards.length}</span>
                    </div>
                    <div className={isEmbeddedMode ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"}>
                      {cards.map((card) => {
                        const isSelected = selectedCardIds.has(card.id);
                        return (
                        <motion.article
                          initial={
                            isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                              ? false
                              : { opacity: 0, scale: 0.97 }
                          }
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.15 }}
                          key={`${tagName}-${card.id}`}
                          data-vault-card-id={card.id}
                          data-card-id={card.id}
                          ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                          draggable={false}
                          onDragStart={handleCardDragStart}
                          onClick={(e) => handleCardPress(e, card)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            openCardMenuForAnchor(card.id, e.currentTarget);
                          }}
                          // Same browser-native culling as the main grid;
                          // tag view often renders the largest single
                          // page (every card duplicated per tag).
                          style={virtualizedCardStyle}
                          className={`rounded-2xl relative overflow-hidden cursor-pointer ${
                            card.kind === "attachment" || card.kind === "quick-note" || card.kind === "source-folder"
                              ? "bg-transparent border-0 shadow-none"
                              : "glass-control"
                          } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""}`}
                        >
                          {isSelected && card.kind !== "source-folder" && (
                            <span
                              data-no-preview="true"
                              className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                            >
                              <Check className="w-3 h-3" strokeWidth={3} />
                            </span>
                          )}
                          {card.isDemo && !isWakePreview && (
                            <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                              Sample
                            </span>
                          )}
                          {card.kind === "source-folder" ? (
                            <SourceFolderTile card={card} heightClass="aspect-square w-full" />
                          ) : card.kind === "attachment" ? (
                            renderAttachmentCard(card, "aspect-square w-full")
                          ) : card.kind === "quick-note" ? (
                              <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                <div className="flex items-center gap-1.5 text-black/60 dark:text-white/60 mb-1.5">
                                  {card.noteStyle === "meeting" ? (
                                    <CalendarDays className="w-3.5 h-3.5" />
                                  ) : card.noteStyle === "task" ? (
                                    <ListTodo className="w-3.5 h-3.5" />
                                  ) : (
                                    <StickyNote className="w-3.5 h-3.5" />
                                  )}
                                  <span className="text-[0.625rem] font-medium">{card.label || "Quick Note"}</span>
                                </div>
                                {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                                  <p className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</p>
                                ) : null}
                                <p className="text-xs text-black/70 dark:text-white/70 whitespace-pre-wrap break-words line-clamp-5">{card.excerpt}</p>
                              </div>
                          ) : (
                              <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                              </div>
                          )}
                        </motion.article>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : vaultView === "type" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={handleRequestAddMedia} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={handleRequestSaveLink} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Globe className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                  </button>
                </div>
                {typeGroupedCards.map(([typeName, cards]) => {
                  return (
                    <div key={typeName}>
                      <div className="flex items-center gap-2 mb-3">
                        <h2 className="text-lg font-semibold text-black/80 dark:text-white/80">{typeName}</h2>
                        <span className="text-xs text-black/40 dark:text-white/40 font-medium">{cards.length}</span>
                      </div>
                      <div className={isEmbeddedMode ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"}>
                        {cards.map((card) => {
                          const isSelected = selectedCardIds.has(card.id);
                          return (
                          <motion.article
                            initial={
                              isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                                ? false
                                : { opacity: 0, scale: 0.97 }
                            }
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.15 }}
                            key={`${typeName}-${card.id}`}
                            data-vault-card-id={card.id}
                            data-card-id={card.id}
                            ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                            draggable={false}
                            onDragStart={handleCardDragStart}
                            onClick={(e) => handleCardPress(e, card)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              openCardMenuForAnchor(card.id, e.currentTarget);
                            }}
                            // See `virtualizedCardStyle` definition above:
                            // browser-native off-screen culling kicks in
                            // once the rendered count crosses
                            // `VIRTUALIZE_AT`. No-op for small vaults.
                            style={virtualizedCardStyle}
                            className={`rounded-2xl relative overflow-hidden cursor-pointer ${
                              card.kind === "attachment" || card.kind === "quick-note"
                                ? "bg-transparent border-0 shadow-none"
                                : "glass-control"
                            } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""}`}
                          >
                            {isSelected && (
                              <span
                                data-no-preview="true"
                                className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                              >
                                <Check className="w-3 h-3" strokeWidth={3} />
                              </span>
                            )}
                            {card.isDemo && !isWakePreview && (
                              <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                                Sample
                              </span>
                            )}
                            {card.kind === "attachment" ? (
                              renderAttachmentCard(card, "aspect-square w-full")
                            ) : card.kind === "quick-note" ? (
                                <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                  <div className="flex items-center gap-1.5 text-black/60 dark:text-white/60 mb-1.5">
                                    {card.noteStyle === "meeting" ? (
                                      <CalendarDays className="w-3.5 h-3.5" />
                                    ) : card.noteStyle === "task" ? (
                                      <ListTodo className="w-3.5 h-3.5" />
                                    ) : (
                                      <StickyNote className="w-3.5 h-3.5" />
                                    )}
                                    <span className="text-[0.625rem] font-medium">{card.label || "Quick Note"}</span>
                                  </div>
                                  {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                                    <p className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</p>
                                  ) : null}
                                  <p className="text-xs text-black/70 dark:text-white/70 whitespace-pre-wrap break-words line-clamp-5">{card.excerpt}</p>
                                </div>
                            ) : (
                                <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                  <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                  {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                                </div>
                            )}
                          </motion.article>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : (
              <div className={isWakePreview ? "grid grid-cols-3 gap-3 items-start" : undefined}>
                {isWakePreview && (
                  <>
                    <div className="col-start-1 row-start-1 w-full rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[11rem] gap-2">
                      <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleRequestAddMedia}
                          className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                            <Upload className="w-4 h-4 text-blue-500" />
                          </div>
                          <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleRequestSaveLink}
                          className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                            <Globe className="w-4 h-4 text-blue-500" />
                          </div>
                          <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                        </button>
                      </div>
                    </div>
                    <div className="col-start-2 col-span-2 row-start-1 min-w-0 self-start">
                      <div className="grid grid-cols-2 gap-3">
                        {wakeConnectorStripCards.map((card) => (
                          <article
                            key={card.id}
                            data-vault-card-id={card.id}
                            data-card-id={card.id}
                            onClick={(e) => handleCardPress(e, card)}
                            className="rounded-2xl relative cursor-pointer overflow-visible"
                          >
                            {renderAttachmentCard(card, "h-20")}
                          </article>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              {useMasonryLayout ? (
                <div className={`flex items-start ${isEmbeddedMode ? "gap-2" : "gap-2 md:gap-2.5"}`}>
                  {collageColumnBuckets.map((bucket, colIdx) => (
                    <div key={`vault-col-${colIdx}`} className="flex-1 min-w-0 flex flex-col">
                      {colIdx === 0 && vaultView === "collage" && !isWakePreview && (
                        <div className="mb-2 rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[130px] gap-2">
                          <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleRequestAddMedia}
                              className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                            >
                              <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                                <Upload className="w-4 h-4 text-blue-500" />
                              </div>
                              <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleRequestSaveLink}
                              className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                            >
                              <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                                <Globe className="w-4 h-4 text-blue-500" />
                              </div>
                              <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {bucket.map((card) => renderCollageCard(card))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={
                  isWakePreview
                    ? "lykn-wake-vault-preview-grid col-start-1 col-span-3 row-start-2 grid grid-cols-3 gap-2"
                    : isEmbeddedMode
                    ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2"
                    : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"
                }>
                  {vaultView === "grid" && !isWakePreview && (
                    <div className="rounded-2xl border-2 border-dashed border-blue-500/30 flex flex-col items-center justify-center text-center aspect-square gap-2 p-4">
                      <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                      <div className="flex gap-1.5">
                        <button type="button" onClick={handleRequestAddMedia} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                          <Upload className="w-3.5 h-3.5 text-blue-500" />
                        </button>
                        <button type="button" onClick={handleRequestSaveLink} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                          <Globe className="w-3.5 h-3.5 text-blue-500" />
                        </button>
                      </div>
                    </div>
                  )}
                  {collageGridCards.map((card) => renderCollageCard(card))}
                </div>
              )}
              <div ref={loadMoreRef} className="h-6" />
              </div>
            )}
            {isFeedView
              ? pendingRevealCount > 0 && (
                  <VaultLoadMoreSkeleton
                    masonry={useMasonryLayout}
                    embedded={isEmbeddedMode}
                    count={pendingRevealCount}
                  />
                )
              : isLoadingMoreNotes && (
                  <VaultLoadMoreSkeleton
                    masonry={useMasonryLayout}
                    embedded={isEmbeddedMode}
                  />
                )}
          </motion.div>
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

      {openCardMenuId && openCardMenuRect && createPortal(
        (() => {
          const menuCard = orderedVisibleCards.find((c) => c.id === openCardMenuId);
          if (!menuCard) return null;
          const menuW = Math.min(224, window.innerWidth - 16);
          const pad = 8;
          let top, maxH;
          const previewRoot = isWakePreview ? vaultPreviewRootRef.current : null;
          const previewRootRect = previewRoot?.getBoundingClientRect?.() || null;
          if (openCardMenuPlacement === "up") {
            top = undefined;
            maxH = openCardMenuRect.top - pad - (previewRootRect?.top ?? 0);
          } else {
            top = openCardMenuRect.bottom + pad - (previewRootRect?.top ?? 0);
            maxH = (previewRootRect?.bottom ?? window.innerHeight) - openCardMenuRect.bottom - pad;
          }
          let left = openCardMenuRect.right - menuW - (previewRootRect?.left ?? 0);
          const maxLeft = (previewRootRect?.width ?? window.innerWidth) - menuW - pad;
          if (left < pad) left = pad;
          if (left > maxLeft) left = Math.max(pad, maxLeft);

          return (
            <div
              ref={cardMenuRef}
              data-vault-popover=""
              className="lg-menu p-1.5 flex flex-col overflow-hidden overscroll-contain"
              style={{
                position: previewRoot ? "absolute" : "fixed",
                width: menuW,
                left: previewRoot ? left : openCardMenuRect.right - menuW,
                ...(openCardMenuPlacement === "up"
                  ? previewRoot
                    ? { bottom: (previewRootRect?.bottom ?? 0) - openCardMenuRect.top + pad }
                    : { bottom: window.innerHeight - openCardMenuRect.top + pad }
                  : previewRoot
                    ? { top }
                    : { top: openCardMenuRect.bottom + pad }),
                maxHeight: maxH,
                // Above the card lightbox (z-9999) when opened from Expand view.
                zIndex: previewCard ? 10050 : 9999,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              {/*
                Tall cards (notably drag-dropped YouTube embeds) anchor the
                ⋯ menu near the bottom of the viewport. When the menu opens
                upward with a tight maxHeight, a single scroll container
                hid Delete below the fold — link-added YouTube stayed as
                shorter bookmark tiles so the bug only showed on drag-drop.
                Keep Delete pinned outside the scroll region.
              */}
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
                <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60 dark:text-white/60">Add to project</div>
                <div className="space-y-1">
                  <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                    {projects.length === 0 ? (
                      <div className="px-2 py-1.5 text-[0.6875rem] text-black/55 dark:text-white/55">No projects found.</div>
                    ) : (
                      projects.map((project) => (
                        <button
                          key={project.id}
                          type="button"
                          disabled={isCardActionBusy}
                          onClick={() => {
                            if (blockWakePreviewVaultMutation(menuCard)) return;
                            void addCardToProject(menuCard, project.id);
                          }}
                          className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-60 truncate"
                          title={project.name}
                        >
                          {project.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
                {(menuCard.kind === "attachment" || menuCard.kind === "quick-note") && (
                  <>
                    <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                    <button
                      type="button"
                      disabled={isCardActionBusy}
                      onClick={() => {
                        // Anchor the composer to the card itself rather
                        // than this menu item — the menu is closing as
                        // we click, so its rect would jump. The card
                        // wrapper carries `data-vault-card-id` and is
                        // always present in the DOM while the card is
                        // visible.
                        const anchor =
                          document.querySelector(`[data-vault-card-id="${menuCard.id}"]`) ||
                          cardMenuRef.current;
                        openAttachmentNotesForAnchor(menuCard.id, anchor);
                        setOpenCardMenuId(null);
                      }}
                      className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      Comment
                    </button>
                  </>
                )}
                {menuCard.noteId && (
                  <>
                    <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                    <button
                      type="button"
                      onClick={() => {
                        const rect = openCardMenuRect;
                        setOpenAttachmentNotesCardId(null);
                        setOpenAttachmentNotesRect(null);
                        setAttachmentNoteDraft("");
                        setTagPickerCardId(menuCard.id);
                        setTagPickerPosition(
                          rect
                            ? { left: rect.left, top: rect.bottom + 8 }
                            : { left: 16, top: 16 },
                        );
                        setOpenCardMenuId(null);
                      }}
                      className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-2"
                    >
                      <Tag className="w-3.5 h-3.5" />
                      Tags
                    </button>
                  </>
                )}
              </div>
              <div className="shrink-0 pt-1 mt-1 border-t border-black/10 dark:border-white/10">
                <button
                  type="button"
                  disabled={isCardActionBusy}
                  onClick={() => {
                    if (isWakePreview && menuCard.isWakePreviewNote) {
                      const ok = window.confirm(`Are you sure you want to delete "${menuCard.title || "Quick Note"}"? This cannot be undone.`);
                      if (!ok) return;
                      removeWakeVaultPreviewQuickNote(menuCard.id);
                      setWakePreviewQuickNotes((prev) => prev.filter((note) => note.id !== menuCard.id));
                      setOpenCardMenuId(null);
                      return;
                    }
                    if (blockWakePreviewVaultMutation(menuCard)) return;
                    if (menuCard.kind === "attachment") {
                      confirmAndDeleteAttachment(menuCard);
                    } else {
                      const ok = window.confirm(`Are you sure you want to delete "${menuCard.title || "Quick Note"}"? This cannot be undone.`);
                      if (!ok) return;
                      void removeQuickNoteCard(menuCard);
                    }
                  }}
                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2 text-red-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </div>
          );
        })(),
        isWakePreview && vaultPreviewRootRef.current
          ? vaultPreviewRootRef.current
          : document.body
      )}
      {/*
        Comment composer popover. Rendered via portal (not inline inside
        the card) so it can escape the card's `overflow-hidden` clip —
        previously the composer would render INSIDE the card and get cut
        off in grid mode, which made it impossible to type into.

        Anchoring uses the viewport rect captured at open-time
        (`openAttachmentNotesRect`). We flip the placement up when there
        isn't room below, mirroring the `openCardMenuPlacement`
        behavior for the action menu.
      */}
      {openAttachmentNotesCardId && createPortal(
        (() => {
          const card =
            orderedVisibleCards.find((c) => c.id === openAttachmentNotesCardId) ||
            vaultCards.find((c) => c.id === openAttachmentNotesCardId) ||
            (previewCard && previewCard.id === openAttachmentNotesCardId ? previewCard : null);
          if (!card) return null;
          const isAttachment = card.kind === "attachment";
          const existingComments = isAttachment
            ? parseAttachmentNotes(card.attachment)
            : (card.comments || []);
          const onSave = isAttachment ? addAttachmentNote : addQuickNoteComment;
          const onDelete = isAttachment ? removeAttachmentNote : removeQuickNoteComment;
          const placeholder = isAttachment
            ? "Write a comment about this file…"
            : "Write a comment on this quick note…";
          const trySaveComment = () => {
            if (!attachmentNoteDraft.trim()) return;
            if (isWakePreview) {
              addWakePreviewCardComment(card, attachmentNoteDraft);
              closeAttachmentNotes();
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            void onSave(card, attachmentNoteDraft);
            closeAttachmentNotes();
          };
          const tryDeleteComment = (commentId) => {
            if (!commentId || isCardActionBusy) return;
            if (isWakePreview) {
              removeWakePreviewCardComment(card, commentId);
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            void onDelete(card, commentId);
          };

          const COMP_W = Math.min(288, window.innerWidth - 16);
          const COMP_H_EST = 240; // textarea + buttons + a few existing comments
          const pad = 8;
          const rect = openAttachmentNotesRect;
          const previewRoot = isWakePreview ? vaultPreviewRootRef.current : null;
          const previewRootRect = previewRoot?.getBoundingClientRect?.() || null;

          // Fall back to a centered overlay if we somehow opened without
          // an anchor rect (e.g. if the anchor scrolled out of frame).
          let positionStyle;
          if (rect) {
            const spaceBelow = (previewRootRect?.bottom ?? window.innerHeight) - rect.bottom;
            const spaceAbove = rect.top - (previewRootRect?.top ?? 0);
            const useUp = spaceBelow < COMP_H_EST && spaceAbove > spaceBelow;
            let left = rect.right - COMP_W - (previewRootRect?.left ?? 0);
            const maxLeft = (previewRootRect?.width ?? window.innerWidth) - COMP_W - pad;
            if (left < pad) left = pad;
            if (left > maxLeft) left = Math.max(pad, maxLeft);
            positionStyle = useUp
              ? previewRoot
                ? {
                    position: "absolute",
                    width: COMP_W,
                    left,
                    bottom: (previewRootRect?.bottom ?? 0) - rect.top + pad,
                    maxHeight: rect.top - (previewRootRect?.top ?? 0) - pad * 2,
                    zIndex: 9999,
                  }
                : {
                    position: "fixed",
                    width: COMP_W,
                    left: rect.right - COMP_W,
                    bottom: window.innerHeight - rect.top + pad,
                    maxHeight: rect.top - pad * 2,
                    zIndex: 9999,
                  }
              : previewRoot
                ? {
                    position: "absolute",
                    width: COMP_W,
                    left,
                    top: rect.bottom + pad - (previewRootRect?.top ?? 0),
                    maxHeight: (previewRootRect?.bottom ?? window.innerHeight) - rect.bottom - pad * 2,
                    zIndex: 9999,
                  }
                : {
                    position: "fixed",
                    width: COMP_W,
                    left: rect.right - COMP_W,
                    top: rect.bottom + pad,
                    maxHeight: window.innerHeight - rect.bottom - pad * 2,
                    zIndex: 9999,
                  };
          } else if (previewRoot && previewRootRect) {
            positionStyle = {
              position: "absolute",
              width: COMP_W,
              left: Math.max(pad, (previewRootRect.width - COMP_W) / 2),
              top: Math.max(pad, (previewRootRect.height - COMP_H_EST) / 2),
              maxHeight: previewRootRect.height - pad * 2,
              zIndex: 9999,
            };
          } else {
            positionStyle = {
              position: "fixed",
              width: COMP_W,
              left: Math.max(pad, (window.innerWidth - COMP_W) / 2),
              top: Math.max(pad, (window.innerHeight - COMP_H_EST) / 2),
              maxHeight: window.innerHeight - pad * 2,
              zIndex: 9999,
            };
          }
          // Sit above the pulled-up card lightbox when commenting from preview.
          if (positionStyle && previewCard) {
            positionStyle = { ...positionStyle, zIndex: 10050 };
          }

          return (
            <div
              ref={noteComposerRef}
              data-vault-popover=""
              className="rounded-2xl border border-white/30 dark:border-white/10 bg-panel backdrop-blur-md shadow-xl p-3 overflow-y-auto scrollbar-hide overscroll-contain"
              style={positionStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              <div className="text-[0.6875rem] font-medium text-black/60 dark:text-white/60 mb-2">
                Add a comment
              </div>
              <textarea
                value={attachmentNoteDraft}
                onChange={(e) => setAttachmentNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && attachmentNoteDraft.trim()) {
                    e.preventDefault();
                    trySaveComment();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeAttachmentNotes();
                  }
                }}
                placeholder={placeholder}
                className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/45 dark:bg-white/5 px-2.5 py-2 text-xs outline-none resize-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black dark:text-white"
                rows={3}
                autoFocus
              />
              <div className="flex items-center justify-between mt-2">
                <button
                  type="button"
                  onClick={closeAttachmentNotes}
                  className="text-[0.6875rem] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={trySaveComment}
                  disabled={!attachmentNoteDraft.trim()}
                  className="rounded-lg bg-neutral-700 hover:bg-neutral-800 dark:bg-neutral-700 dark:hover:bg-neutral-600 text-white text-[0.6875rem] font-medium px-3 py-1 disabled:opacity-40 transition-colors"
                >
                  Save
                </button>
              </div>
              {existingComments.length > 0 && (
                <div className="mt-3 border-t border-black/10 dark:border-white/10 pt-2 max-h-40 overflow-y-auto scrollbar-hide space-y-1.5">
                  {existingComments.map((entry) => (
                    <div
                      key={entry.id}
                      className="group flex items-start gap-1.5 rounded-md bg-black/5 dark:bg-white/5 px-2 py-1.5"
                    >
                      <p className="flex-1 min-w-0 text-xs text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">
                        {entry.text}
                      </p>
                      <button
                        type="button"
                        onClick={() => tryDeleteComment(entry.id)}
                        disabled={isCardActionBusy}
                        className="shrink-0 p-0.5 rounded text-black/35 dark:text-white/35 hover:text-red-600 dark:hover:text-red-400 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 transition-colors"
                        title="Delete comment"
                        aria-label="Delete comment"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })(),
        isWakePreview && vaultPreviewRootRef.current
          ? vaultPreviewRootRef.current
          : document.body,
      )}
      {tagPickerCardId && tagPickerPosition && createPortal(
        (() => {
          const pickerCard = vaultCards.find((c) => c.id === tagPickerCardId);
          if (!pickerCard || !pickerCard.noteId) return null;
          const cardTags = pickerCard.tags || [];
          const menuW = Math.min(260, window.innerWidth - 16);
          const pad = 8;
          let left = tagPickerPosition.left;
          let top = tagPickerPosition.top;
          if (left + menuW > window.innerWidth - pad) left = window.innerWidth - pad - menuW;
          if (left < pad) left = pad;
          if (top + 320 > window.innerHeight) top = Math.max(pad, tagPickerPosition.top - 340);

          const filteredTags = newTagInput.trim()
            ? allTags.filter((t) => t.name.toLowerCase().includes(newTagInput.trim().toLowerCase()))
            : allTags;
          const exactMatch = allTags.some((t) => t.name.toLowerCase() === newTagInput.trim().toLowerCase());

          return (
            <div
              ref={tagPickerRef}
              data-vault-popover=""
              className="lg-menu p-1.5 overflow-hidden overscroll-contain"
              style={{ position: "fixed", width: menuW, left, top, zIndex: previewCard ? 10050 : 10000 }}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              <div className="flex items-center gap-2 mb-2">
                <Tag className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
                <span className="text-xs font-medium text-black/70 dark:text-white/70">Tags</span>
              </div>
              <div className="relative mb-2">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTagInput.trim()) {
                      e.preventDefault();
                      void createAndAssignTag(pickerCard.noteId, newTagInput.trim());
                      setNewTagInput("");
                    }
                  }}
                  placeholder="Search or create tag..."
                  className="w-full h-8 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.06] px-2.5 text-xs outline-none placeholder:text-black/35 dark:placeholder:text-white/35 focus:border-blue-400/50"
                  autoFocus
                />
              </div>
              {newTagInput.trim() && !exactMatch && (
                <button
                  type="button"
                  onClick={() => {
                    void createAndAssignTag(pickerCard.noteId, newTagInput.trim());
                    setNewTagInput("");
                  }}
                  className="w-full text-left rounded-md px-2 py-1.5 text-xs hover:bg-blue-500/10 text-blue-600 flex items-center gap-2 mb-1"
                >
                  <Plus className="w-3 h-3" />
                  Create "{newTagInput.trim()}"
                </button>
              )}
              <div className="max-h-48 overflow-y-auto scrollbar-hide space-y-0.5">
                {filteredTags.length === 0 && !newTagInput.trim() && (
                  <div className="px-2 py-2 text-[0.6875rem] text-black/45 dark:text-white/45">No tags yet. Type to create one.</div>
                )}
                {filteredTags.map((tag) => {
                  const isAssigned = cardTags.includes(tag.name);
                  return (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => void toggleCardTag(pickerCard.noteId, tag.name)}
                      className={`w-full text-left rounded-md px-2 py-1.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                        isAssigned ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : "hover:bg-black/5 dark:hover:bg-white/5 text-black/70 dark:text-white/70"
                      }`}
                    >
                      <span className="truncate">{tag.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[0.625rem] text-black/35 dark:text-white/35">{tag.count}</span>
                        {isAssigned && <Check className="w-3 h-3 text-blue-500" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {cardTags.length > 0 && (
                <div className="mt-2 pt-2 border-t border-black/8 dark:border-white/8 flex flex-wrap gap-1">
                  {cardTags.map((tag) => (
                    <span
                      key={tag}
                      className="vault-tag-pill inline-flex items-center gap-1 rounded-full bg-blue-500/15 text-blue-700 text-[10px] leading-none px-2 py-px font-medium"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => void toggleCardTag(pickerCard.noteId, tag)}
                        className="hover:text-red-500 transition-colors"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })(),
        document.body
      )}
      {previewCard && createPortal(
        (() => {
          // Prefer the live vaultCards entry so comment deletes (and other
          // in-place edits) reflect immediately without reopening preview.
          const card =
            vaultCards.find((c) => c.id === previewCard.id) || previewCard;
          const att = card.attachment || {};
          const previewStorageTarget =
            parseStorageTarget(att) || parseStorageTarget(att, "medium");
          const previewIsStorageBacked = !!(previewStorageTarget?.bucket && previewStorageTarget?.path);
          let type = card.type || resolveAttachmentType(att) || card.kind;
          // Storage images must never render as bookmark/file — that path
          // paints the raw supabase URL via LinkPreview / download links.
          const attLooksLikeImage =
            looksLikeImageAttachment(att) ||
            looksLikeImageAttachment({
              ...att,
              name: att.name || previewStorageTarget?.path || "",
              url: att.url || "",
            });
          if (
            card.kind === "attachment" &&
            attLooksLikeImage &&
            !["video", "audio", "pdf", "html", "youtube"].includes(String(type))
          ) {
            type = "image";
          }
          // Fresh signed URLs only — never fall back to attachment.url for
          // images (those are often expired signed storage links that then
          // surface as visible text in bookmark/file fallbacks).
          const signedOnly =
            previewFullUrl || resolvedAttachmentUrls[card.id] || "";
          const resolvedUrl =
            type === "image"
              ? signedOnly
              : (signedOnly || (!isSupabaseStorageUrlText(att.url) ? String(att.url || "") : "") || "");
          const imagePreviewUrl = signedOnly;
          const title = sanitizeCardTitle(
            card.title || att.name || "",
            card.kind === "quick-note" ? (card.label || "Quick Note") : (type === "image" ? "Image" : "Vault Item"),
          );
          const previewImageFailed = type === "image" && failedImageIds.has(card.id);
          const previewImageLoading =
            type === "image" && !previewImageFailed && !imagePreviewUrl && previewIsStorageBacked;
          const retryPreviewImage = () => {
            imageRetryCountsRef.current.delete(card.id);
            setFailedImageIds((prev) => {
              const next = new Set(prev);
              next.delete(card.id);
              return next;
            });
            if (previewStorageTarget?.bucket && previewStorageTarget?.path) {
              signedUrlCacheRef.current.delete(
                `${previewStorageTarget.bucket}:${previewStorageTarget.path}`,
              );
            }
            setResolvedAttachmentUrls((prev) => {
              const next = { ...prev };
              delete next[card.id];
              return next;
            });
            setPreviewFullUrl(null);
            visibleCardIdsRef.current.delete(card.id);
            urlResolveQueueRef.current.push(card);
            drainUrlResolveQueue();
          };
          const cardTags = Array.isArray(card.tags) ? card.tags : [];
          const previewNote = card.noteId
            ? notes.find((n) => String(n?.id) === String(card.noteId))
            : null;
          const previewWhy = String(previewNote?.why || "").trim();
          // Prefer live note body from the query cache so formatting stays
          // intact even if the card was built before `body` was attached.
          const previewTextBody = String(
            previewNote?.content
              ? stripAttachmentsMarker(String(previewNote.content)).replace(/\r\n/g, "\n").trim()
              : (card.body || card.excerpt || ""),
          ).trim();
          const canEditWhy = !isWakePreview && !!card.noteId;
          const videoId = type === "youtube"
            ? (extractYouTubeVideoId(String(att.url || "")) || String(att.videoId || "").trim() || null)
            : null;
          const youtubeEmbedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";

          let body;
          if (card.kind === "attachment" && type === "image") {
            if (previewImageFailed) {
              body = (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-6 h-full">
                  <FileText className="w-14 h-14 text-black/25 dark:text-white/25" />
                  <p className="text-sm text-black/60 dark:text-white/60">{title}</p>
                  <p className="text-xs text-black/40 dark:text-white/40">Preview unavailable</p>
                  <button
                    type="button"
                    onClick={retryPreviewImage}
                    className="text-sm font-medium text-blue-500 hover:text-blue-600 transition-colors"
                  >
                    Try again
                  </button>
                </div>
              );
            } else if (previewImageLoading || !imagePreviewUrl) {
              body = (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center h-full">
                  <Loader2 className="w-8 h-8 text-black/25 dark:text-white/25 animate-spin" />
                  <p className="text-sm text-black/45 dark:text-white/45">Loading image…</p>
                  {previewIsStorageBacked ? (
                    <button
                      type="button"
                      onClick={retryPreviewImage}
                      className="text-xs font-medium text-blue-500 hover:text-blue-600 transition-colors"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              );
            } else {
              body = (
                <img
                  src={imagePreviewUrl}
                  alt={title}
                  className="max-h-full max-w-full w-auto h-auto object-contain bg-black/[0.03]"
                  draggable={false}
                  onError={() => {
                    setFailedImageIds((prev) => new Set(prev).add(card.id));
                  }}
                />
              );
            }
          } else if (card.kind === "attachment" && type === "video") {
            body = (
              <video
                src={resolvedUrl}
                controls
                autoPlay
                playsInline
                className="max-h-full max-w-full w-auto h-auto object-contain rounded-xl bg-black"
              />
            );
          } else if (card.kind === "attachment" && type === "audio") {
            const voiceNote = isVoiceNoteCard(card);
            body = (
              <div className="flex flex-col items-center justify-center gap-4 py-8 h-full">
                {voiceNote ? (
                  <Mic className="w-14 h-14 text-black/40 dark:text-white/40" />
                ) : (
                  <Music className="w-14 h-14 text-black/40 dark:text-white/40" />
                )}
                <p className="text-sm text-black/70 dark:text-white/70 text-center">{title}</p>
                <audio src={resolvedUrl} controls autoPlay className="w-full max-w-xl" />
              </div>
            );
          } else if (card.kind === "attachment" && type === "pdf") {
            body = (
              <iframe
                title={title}
                src={vaultPdfEmbedUrl(resolvedUrl)}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-white"
              />
            );
          } else if (card.kind === "attachment" && type === "html") {
            const htmlStorage = parseStorageTarget(att);
            const htmlIsStorage = !!(htmlStorage?.bucket && htmlStorage?.path);
            const markup = driveMarkup[card.id] || "";
            // Non-storage artifacts may still frame their original safe URL.
            // Storage-backed artifacts render from fetched markup above.
            const candidate =
              resolvedAttachmentUrls[card.id] || (!htmlIsStorage ? resolvedUrl : "");
            const htmlEmbed = /supabase\.co\/storage\//i.test(candidate || "")
              ? null
              : safeHtmlPreviewUrl(candidate);
            body = htmlEmbed ? (
              <iframe
                title={title}
                src={htmlEmbed.url}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-[#15130f]"
                sandbox={htmlEmbed.sandbox}
                referrerPolicy="no-referrer"
              />
            ) : markup ? (
              <iframe
                title={title}
                srcDoc={markup}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-white"
                sandbox="allow-scripts allow-popups allow-forms allow-modals allow-presentation"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-10 text-center h-full">
                <FileText className="w-14 h-14 text-black/30 dark:text-white/30" />
                <p className="text-sm text-black/70 dark:text-white/70">
                  {failedImageIds.has(card.id) ? "Preview unavailable" : "Loading preview…"}
                </p>
              </div>
            );
          } else if (card.kind === "attachment" && type === "youtube") {
            const isMockDemoYoutube = Boolean(card.isDemo && !youtubeEmbedUrl);
            if (isMockDemoYoutube) {
              body = (
                <div className="flex flex-col items-center justify-center gap-5 py-20 px-6 text-center rounded-xl bg-black/5 dark:bg-white/5 h-full">
                  <div className="w-16 h-11 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                    <svg viewBox="0 0 24 24" fill="white" className="w-7 h-7 ml-0.5" aria-hidden>
                      <polygon points="8,5 20,12 8,19" />
                    </svg>
                  </div>
                  <p className="text-base font-medium text-black/75 dark:text-white/80">Sample YouTube video</p>
                </div>
              );
            } else if (youtubeEmbedUrl) {
              body = (
                <iframe
                  title={title}
                  src={youtubeEmbedUrl}
                  className="w-full h-full min-h-[22rem] rounded-xl border-0 bg-black"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              );
            } else {
              body = (
                <a href={safeExternalUrl(att.url) || undefined} target="_blank" rel="noreferrer" className="text-sm text-blue-500 underline">
                  Open YouTube video
                </a>
              );
            }
          } else if (card.kind === "attachment" && (type === "instagram" || type === "tiktok" || type === "facebook")) {
            body = (
              <div className="w-full h-full max-h-full overflow-auto rounded-xl">
                <SocialEmbedInline
                  platform={type}
                  oembedHtml={String(att.oembedHtml || "")}
                  url={String(att.url || resolvedUrl || "")}
                  thumbnailUrl={att.image || att.thumbnail_url || ""}
                  title={att.title || title || ""}
                  authorName={att.authorName || ""}
                  authorHandle={att.authorHandle || ""}
                />
              </div>
            );
          } else if (card.kind === "attachment" && type === "bookmark" && att.connectorList) {
            body = renderConnectorListCard(att, title, { expanded: true });
          } else if (card.kind === "attachment" && type === "bookmark") {
            body = (
              <div className="space-y-4">
                <LinkPreview
                  url={att.url || resolvedUrl || ""}
                  title={att.title || title || ""}
                  description={String(att.description || "")}
                  image={att.image || ""}
                  siteName={att.siteName || ""}
                  favicon={att.favicon || ""}
                  authorName={att.authorName || ""}
                  authorHandle={att.authorHandle || ""}
                  oembedType={att.oembedType || ""}
                  variant="vault"
                />
                {att.articleText && (
                  <div className="rounded-xl bg-white/40 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3 max-h-[min(40vh,22rem)] overflow-y-auto text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap">
                    {att.articleText}
                  </div>
                )}
                {(() => {
                  const openHref = safeAttachmentUrl(att.url || resolvedUrl);
                  if (!openHref || isSupabaseStorageUrlText(openHref)) return null;
                  return (
                    <a
                      href={openHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-600"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      Open link in new tab
                    </a>
                  );
                })()}
              </div>
            );
          } else if (card.kind === "attachment" && type === "spreadsheet") {
            const cells = att.cells || {};
            const totalRows = Math.min(Number(att.rows) || 0, 200);
            const totalCols = Math.min(Number(att.cols) || 0, 50);
            body = (
              <div className="rounded-xl overflow-auto h-full max-h-full border border-white/30 dark:border-white/10 bg-white/60 dark:bg-white/5">
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    {Array.from({ length: totalRows }, (_, r) => (
                      <tr key={r} className={r === 0 ? "bg-black/5 dark:bg-white/10 font-semibold" : ""}>
                        {Array.from({ length: totalCols }, (_, c) => (
                          <td key={c} className="px-2.5 py-1.5 border-b border-r border-black/6 dark:border-white/6 text-black/80 dark:text-white/80 whitespace-nowrap">
                            {cells[`${r},${c}`] || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          } else if (card.kind === "attachment") {
            const safeDownload = safeAttachmentUrl(resolvedUrl);
            const hideStorageLink = isSupabaseStorageUrlText(safeDownload || resolvedUrl || "");
            body = (
              <div className="flex flex-col items-center gap-4 py-10 text-center">
                <FileText className="w-14 h-14 text-black/30 dark:text-white/30" />
                <p className="text-sm text-black/70 dark:text-white/70 break-words max-w-lg">{title}</p>
                {previewIsStorageBacked ? (
                  <button
                    type="button"
                    onClick={retryPreviewImage}
                    className="text-sm font-medium text-blue-500 hover:text-blue-600 transition-colors"
                  >
                    Try again
                  </button>
                ) : safeDownload && !hideStorageLink ? (
                  <a
                    href={safeDownload}
                    target="_blank"
                    rel="noreferrer"
                    download={title}
                    className="text-xs font-medium text-blue-500 hover:text-blue-600 underline"
                  >
                    Open / download file
                  </a>
                ) : null}
              </div>
            );
          } else if (card.kind === "quick-note") {
            const useMarkdown = !!(card.formatted || (card.noteStyle && card.noteStyle !== "quick"));
            body = (
              <div className="rounded-xl bg-white/45 dark:bg-white/5 border border-white/40 dark:border-white/10 px-5 py-4 h-full max-h-full overflow-y-auto">
                {useMarkdown ? (
                  <div className="vault-note-md text-sm text-black/85 dark:text-white/85 leading-relaxed break-words">
                    <style>{`
                      .vault-note-md h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.75em; }
                      .vault-note-md h2 { font-size: 1.1rem; font-weight: 600; margin: 1.25em 0 0.5em; }
                      .vault-note-md h3 { font-size: 1rem; font-weight: 600; margin: 1em 0 0.4em; }
                      .vault-note-md p { margin: 0 0 0.85em; white-space: pre-wrap; }
                      .vault-note-md ul, .vault-note-md ol { margin: 0 0 0.85em; padding-left: 1.35em; }
                      .vault-note-md ul { list-style: disc; }
                      .vault-note-md ol { list-style: decimal; }
                      .vault-note-md li { margin: 0.25em 0; }
                      .vault-note-md li + li { margin-top: 0.35em; }
                      .vault-note-md strong { font-weight: 600; }
                      .vault-note-md hr { margin: 1em 0; border-color: rgba(0,0,0,0.1); }
                      .dark .vault-note-md hr { border-color: rgba(255,255,255,0.12); }
                    `}</style>
                    <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS}>
                      {previewTextBody}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words leading-relaxed">
                    {previewTextBody}
                  </p>
                )}
              </div>
            );
          } else if (card.kind === "chat-preview") {
            body = (
              <div className="space-y-3 h-full max-h-full overflow-y-auto">
                {card.question && (
                  <div className="rounded-xl bg-white/45 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3">
                    <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45 mb-1">You</div>
                    <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words">{card.question}</p>
                  </div>
                )}
                {card.answer && (
                  <div className="rounded-xl bg-black/5 dark:bg-white/[0.03] border border-black/8 dark:border-white/8 px-4 py-3">
                    <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45 mb-1">Assistant</div>
                    <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words">{card.answer}</p>
                  </div>
                )}
                {card.turnsCount ? (
                  <div className="text-[0.6875rem] text-black/50 dark:text-white/50">{card.turnsCount} turns in this thread</div>
                ) : null}
              </div>
            );
          } else {
            body = (
              <div className="text-sm text-black/60 dark:text-white/60">No preview available.</div>
            );
          }

          const canExpandExternally =
            card.kind === "attachment" &&
            ["html", "image", "video", "audio", "pdf", "youtube", "bookmark", "link", "file", "spreadsheet"].includes(
              String(type || resolveAttachmentType(att) || ""),
            );
          const shareUrl =
            type === "image"
              ? (previewFullUrl || resolvedUrl)
              : (resolvedUrl || String(att.url || ""));
          const openTagsPicker = (anchorEl) => {
            if (!card.noteId) return;
            const rect = anchorEl?.getBoundingClientRect?.();
            setOpenCardMenuId(null);
            setTagPickerCardId(card.id);
            setTagPickerPosition(
              rect
                ? { left: rect.left, top: rect.bottom + 8 }
                : { left: 24, top: 96 },
            );
          };
          const deleteFromPreview = () => {
            if (isWakePreview && card.isWakePreviewNote) {
              const ok = window.confirm(`Are you sure you want to delete "${card.title || "Quick Note"}"? This cannot be undone.`);
              if (!ok) return;
              removeWakeVaultPreviewQuickNote(card.id);
              setWakePreviewQuickNotes((prev) => prev.filter((note) => note.id !== card.id));
              setPreviewCard(null);
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            if (card.kind === "attachment") {
              confirmAndDeleteAttachment(card);
              setPreviewCard(null);
              return;
            }
            const ok = window.confirm(`Are you sure you want to delete "${card.title || "Quick Note"}"? This cannot be undone.`);
            if (!ok) return;
            void removeQuickNoteCard(card);
            setPreviewCard(null);
          };
          const togglePreviewShare = (event) => {
            event.stopPropagation();
            if (previewShareMenuRect) {
              setPreviewShareMenuRect(null);
              return;
            }
            setPreviewProjectDropdownOpen(false);
            setOpenCardMenuId(null);
            setOpenCardMenuRect(null);
            setTagPickerCardId(null);
            const rect = event.currentTarget.getBoundingClientRect();
            const anchor = {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            };
            const nativeShare = window.lykn?.nativeShare;
            if (typeof nativeShare === "function") {
              const safeUrl = resolvePreviewShareUrl(card, shareUrl);
              // Images, video, PDFs and files share as attachments; artifacts
              // and links share as a URL (that's what the recipient needs).
              const shareType = String(type || resolveAttachmentType(att) || "");
              const shareAsFile =
                card.kind === "attachment" &&
                ["image", "video", "audio", "pdf", "file", "spreadsheet"].includes(shareType);
              void nativeShare({
                title: title || "LYKN vault item",
                text: resolvePreviewShareText(card),
                url: safeUrl || "",
                asFile: shareAsFile,
                filename: String(att.name || title || ""),
                x: Math.round(rect.left),
                y: Math.round(rect.bottom),
              })
                .then((result) => {
                  // A main process from before the last restart still answers
                  // `ok` while showing nothing, so require the current API too:
                  // otherwise the click has no visible effect at all.
                  if (!result?.ok || result.api !== 2) setPreviewShareMenuRect(anchor);
                })
                .catch(() => setPreviewShareMenuRect(anchor));
              return;
            }
            setPreviewShareMenuRect(anchor);
          };

          return (
            <LyknMediaPop
              open
              onClose={() => setPreviewCard(null)}
              title={title || "Preview"}
              zIndex={9999}
            >
              <div className="flex max-h-[min(78vh,820px)] w-[min(96vw,980px)] flex-col overflow-hidden">
                <div className="mb-2 flex items-center justify-end gap-0.5 self-end rounded-full border border-black/10 bg-white/80 px-1.5 py-1 backdrop-blur-2xl dark:border-white/12 dark:bg-black/45">
                    {canExpandExternally ? (
                      <button
                        type="button"
                        onClick={() => { void openCardFullyInBrowser(card); }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
                        title="Open in a separate window"
                        aria-label="Open in a separate window"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setPreviewDetailsOpen((open) => !open)}
                      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                        previewDetailsOpen
                          ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white"
                          : "text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
                      }`}
                      title={previewDetailsOpen ? "Hide details" : "Show details"}
                      aria-label={previewDetailsOpen ? "Hide details" : "Show details"}
                      aria-pressed={previewDetailsOpen}
                    >
                      <Layers className="h-3.5 w-3.5" />
                    </button>
                    {card.noteId && !isWakePreview ? (
                      <button
                        type="button"
                        data-vault-popover-trigger=""
                        onClick={(event) => {
                          event.stopPropagation();
                          openTagsPicker(event.currentTarget);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
                        title="Tags"
                        aria-label="Tags"
                      >
                        <Tag className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => chatAboutPreviewCard(card)}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-blue-500/15 px-2 text-[0.68rem] font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-200 dark:hover:bg-blue-500/30 transition-colors"
                      title="Chat about this"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Chat
                    </button>
                    <button
                      type="button"
                      data-vault-popover-trigger=""
                      onClick={togglePreviewShare}
                      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                        previewShareMenuRect
                          ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white"
                          : "text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
                      }`}
                      title="Share"
                      aria-label="Share"
                    >
                      <Share className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isCardActionBusy}
                      onClick={deleteFromPreview}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-black/40 hover:bg-red-500/15 hover:text-red-600 dark:text-white/50 dark:hover:text-red-300 disabled:opacity-40 transition-colors"
                      title="Delete"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl lg:flex-row">
                <div className="relative min-h-0 flex-1 overflow-hidden lg:flex-[1.9]">
                  <div className="h-full min-h-[16rem] lg:min-h-0 overflow-y-auto flex items-center justify-center">
                    <div className={`w-full h-full ${
                      type === "image"
                        ? "flex items-center justify-center p-5 sm:p-8"
                        : "p-3 sm:p-4"
                    }`}>
                      {body}
                    </div>
                  </div>
                </div>

                {/* Inspector stays tucked away by default, like Preview's sidebar. */}
                {previewDetailsOpen ? (
                <div className="shrink-0 w-full lg:w-[20rem] xl:w-[22rem] flex flex-col min-h-0 lg:max-h-full overflow-visible bg-[#f4f4f4] dark:bg-[#242424] px-5 sm:px-6 pt-5 pb-5">
                  <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-0.5">
                    {title ? (
                      <h2 className="pr-10 text-lg font-semibold text-black/85 dark:text-white/90 leading-snug line-clamp-3">
                        {title}
                      </h2>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {cardTags.map((t) => (
                        <span
                          key={t}
                          className="vault-tag-pill inline-flex items-center rounded-full border border-black/10 dark:border-white/12 bg-[#f4f1ea] dark:bg-white/[0.08] text-[11px] leading-none px-2.5 py-1 font-medium text-black/65 dark:text-white/70"
                        >
                          {t}
                        </span>
                      ))}
                      {card.noteId && !isWakePreview ? (
                        <button
                          type="button"
                          data-vault-popover-trigger=""
                          onClick={(e) => {
                            e.stopPropagation();
                            openTagsPicker(e.currentTarget);
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                          title="Add tag"
                          aria-label="Add tag"
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      ) : null}
                    </div>

                    {/* Add to project — above Why I saved this. */}
                    {!isWakePreview ? (
                      <div className="relative z-20" ref={previewProjectDropdownRef}>
                        <button
                          type="button"
                          data-vault-popover-trigger=""
                          disabled={isCardActionBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewShareMenuRect(null);
                            setPreviewProjectDropdownOpen((open) => !open);
                          }}
                          className={`w-full inline-flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                            previewProjectDropdownOpen
                              ? "border-black/15 dark:border-white/20 bg-black/[0.04] dark:bg-white/[0.08] text-black/80 dark:text-white/85"
                              : "border-black/10 dark:border-white/12 bg-black/[0.02] dark:bg-white/[0.04] text-black/70 dark:text-white/75 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                          }`}
                          aria-expanded={previewProjectDropdownOpen}
                          aria-haspopup="listbox"
                        >
                          <span className="truncate">Add to project</span>
                          <ChevronDown
                            className={`w-4 h-4 shrink-0 opacity-60 transition-transform ${
                              previewProjectDropdownOpen ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                        {previewProjectDropdownOpen ? (
                          <div
                            data-vault-popover=""
                            role="listbox"
                            className="lg-menu absolute left-0 right-0 top-full mt-1.5 z-30 max-h-52 overflow-y-auto scrollbar-hide p-1.5"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {projects.length === 0 ? (
                              <div className="px-3 py-2.5 text-sm text-black/45 dark:text-white/45">
                                No projects yet
                              </div>
                            ) : (
                              projects.map((project) => (
                                <button
                                  key={project.id}
                                  type="button"
                                  role="option"
                                  disabled={isCardActionBusy}
                                  onClick={() => {
                                    if (blockWakePreviewVaultMutation(card)) return;
                                    void addCardToProject(card, project.id);
                                  }}
                                  className="w-full text-left rounded-lg px-3 py-2 text-sm text-black/80 dark:text-white/85 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-50 truncate transition-colors"
                                  title={project.name}
                                >
                                  {project.name}
                                </button>
                              ))
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div
                      data-vault-preview-comments=""
                      className="border-t border-black/8 dark:border-white/10 pt-4 space-y-3"
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {(() => {
                        const canAddComment =
                          card.kind === "attachment" || card.kind === "quick-note";
                        const canMutateComments =
                          canAddComment && (!isWakePreview || card.isWakePreviewNote);
                        // Prefer live note/attachment from query cache so newly
                        // saved comments show immediately in the pulled-up card.
                        const liveAttachment = (() => {
                          if (card.kind !== "attachment" || !previewNote) return att;
                          const list = parseAttachmentsFromNote(previewNote);
                          const idx = Number(card.attachmentIndex);
                          if (Number.isFinite(idx) && idx >= 0 && idx < list.length) {
                            return list[idx] || att;
                          }
                          return att;
                        })();
                        const previewComments = card.kind === "attachment"
                          ? parseAttachmentNotes(liveAttachment)
                          : parseQuickNoteComments(previewNote || card);
                        const toggleNewComment = () => {
                          setPreviewShareMenuRect(null);
                          setPreviewProjectDropdownOpen(false);
                          if (previewCommentComposerOpen && !previewEditingCommentId) {
                            setPreviewCommentComposerOpen(false);
                            setPreviewCommentDraft("");
                            return;
                          }
                          setPreviewEditingCommentId(null);
                          setPreviewCommentDraft("");
                          setPreviewCommentComposerOpen(true);
                        };
                        const cancelCommentForm = () => {
                          setPreviewCommentComposerOpen(false);
                          setPreviewCommentDraft("");
                          setPreviewEditingCommentId(null);
                        };
                        const saveCommentForm = async () => {
                          const text = previewCommentDraft.trim();
                          if (!text || isCardActionBusy) return;
                          if (isWakePreview) {
                            if (previewEditingCommentId) {
                              updateWakePreviewCardComment(card, previewEditingCommentId, text);
                            } else {
                              addWakePreviewCardComment(card, text);
                            }
                            cancelCommentForm();
                            return;
                          }
                          if (blockWakePreviewVaultMutation(card)) return;
                          let ok = false;
                          if (previewEditingCommentId) {
                            ok = card.kind === "attachment"
                              ? await updateAttachmentNote(card, previewEditingCommentId, text)
                              : await updateQuickNoteComment(card, previewEditingCommentId, text);
                          } else {
                            ok = card.kind === "attachment"
                              ? await addAttachmentNote(card, text)
                              : await addQuickNoteComment(card, text);
                          }
                          if (ok) cancelCommentForm();
                        };
                        const startEditComment = (entry) => {
                          setPreviewShareMenuRect(null);
                          setPreviewProjectDropdownOpen(false);
                          setPreviewEditingCommentId(entry.id);
                          setPreviewCommentDraft(entry.text || "");
                          setPreviewCommentComposerOpen(false);
                        };
                        const showNewComposer =
                          canMutateComments && previewCommentComposerOpen && !previewEditingCommentId;

                        return (
                          <>
                            {canEditWhy ? (
                              <WhyEditor
                                variant="card"
                                initialValue={previewWhy}
                                busy={isCardActionBusy}
                                onSave={(value) => saveCardWhy(card, value)}
                                onAddComment={canMutateComments ? toggleNewComment : null}
                                commentActive={showNewComposer}
                              />
                            ) : (
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40">
                                    Why I saved this
                                  </p>
                                  {canMutateComments ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleNewComment();
                                      }}
                                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                        showNewComposer
                                          ? "bg-blue-600 text-white"
                                          : "bg-blue-500 text-white hover:bg-blue-600"
                                      }`}
                                      title="Add comment"
                                      aria-label="Add comment"
                                    >
                                      <MessageCircle className="w-3.5 h-3.5" />
                                    </button>
                                  ) : null}
                                </div>
                                {previewWhy ? (
                                  <p className="text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{previewWhy}</p>
                                ) : (
                                  <p className="text-sm italic text-black/35 dark:text-white/35">Add why you saved this</p>
                                )}
                              </div>
                            )}

                            {showNewComposer ? (
                              <div className="space-y-2 rounded-xl border border-black/10 dark:border-white/12 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2.5">
                                <textarea
                                  value={previewCommentDraft}
                                  onChange={(e) => setPreviewCommentDraft(e.target.value)}
                                  autoFocus
                                  rows={3}
                                  maxLength={2000}
                                  placeholder="Write a comment…"
                                  className="w-full resize-y bg-transparent border-0 text-sm text-black/85 dark:text-white/85 outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                                />
                                <div className="flex items-center gap-4">
                                  <button
                                    type="button"
                                    disabled={isCardActionBusy || !previewCommentDraft.trim()}
                                    onClick={() => { void saveCommentForm(); }}
                                    className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                  >
                                    {isCardActionBusy ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelCommentForm}
                                    className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {previewComments.length > 0 ? (
                              <div className="space-y-1.5">
                                {previewComments.map((entry) => {
                                  const isEditing = previewEditingCommentId === entry.id;
                                  return (
                                    <div
                                      key={entry.id}
                                      className="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-2.5 py-2"
                                    >
                                      {isEditing ? (
                                        <div className="space-y-2">
                                          <textarea
                                            value={previewCommentDraft}
                                            onChange={(e) => setPreviewCommentDraft(e.target.value)}
                                            autoFocus
                                            rows={3}
                                            maxLength={2000}
                                            className="w-full resize-y bg-transparent border-0 text-sm text-black/85 dark:text-white/85 outline-none"
                                          />
                                          <div className="flex items-center gap-4">
                                            <button
                                              type="button"
                                              disabled={isCardActionBusy || !previewCommentDraft.trim()}
                                              onClick={() => { void saveCommentForm(); }}
                                              className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                              {isCardActionBusy ? "Saving…" : "Save"}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={cancelCommentForm}
                                              className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="group flex items-start gap-1.5">
                                          <p className="flex-1 min-w-0 text-sm text-black/75 dark:text-white/75 whitespace-pre-wrap break-words">
                                            {entry.text}
                                          </p>
                                          {canMutateComments ? (
                                            <div className="flex items-center gap-0.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                                              <button
                                                type="button"
                                                disabled={isCardActionBusy}
                                                onClick={() => startEditComment(entry)}
                                                className="p-0.5 rounded text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 disabled:opacity-40 transition-colors"
                                                title="Edit comment"
                                                aria-label="Edit comment"
                                              >
                                                <Pencil className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                disabled={isCardActionBusy}
                                                onClick={() => {
                                                  if (isWakePreview) {
                                                    removeWakePreviewCardComment(card, entry.id);
                                                    return;
                                                  }
                                                  if (blockWakePreviewVaultMutation(card)) return;
                                                  if (card.kind === "attachment") {
                                                    void removeAttachmentNote(card, entry.id);
                                                  } else {
                                                    void removeQuickNoteComment(card, entry.id);
                                                  }
                                                }}
                                                className="p-0.5 rounded text-black/30 dark:text-white/30 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
                                                title="Delete comment"
                                                aria-label="Delete comment"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                </div>
                ) : null}
              </div>
              </div>
            </LyknMediaPop>
          );
        })(),
        document.body
      )}
      {previewShareMenuRect && previewCard && createPortal(
        (() => {
          const card =
            vaultCards.find((c) => c.id === previewCard.id) || previewCard;
          const att = card.attachment || {};
          const type = card.type || card.kind;
          const shareUrl =
            type === "image"
              ? (previewFullUrl || resolvedAttachmentUrls[card.id] || att.url || "")
              : (resolvedAttachmentUrls[card.id] || att.url || "");
          const safeUrl = resolvePreviewShareUrl(card, shareUrl);
          const shareText = resolvePreviewShareText(card);
          const canNativeShare =
            typeof navigator !== "undefined" && typeof navigator.share === "function";
          const canDownload =
            !!safeUrl &&
            card.kind === "attachment" &&
            ["image", "video", "audio", "pdf", "file", "html", "spreadsheet"].includes(
              String(type || resolveAttachmentType(att) || ""),
            );
          const menuW = Math.min(220, window.innerWidth - 16);
          const pad = 8;
          let left = previewShareMenuRect.left;
          if (left + menuW > window.innerWidth - pad) {
            left = Math.max(pad, window.innerWidth - menuW - pad);
          }
          if (left < pad) left = pad;
          // Prefer opening above the Share button so it stays over the card.
          const estimatedH = 220;
          const openUp = previewShareMenuRect.top > estimatedH + pad;
          const style = openUp
            ? { bottom: window.innerHeight - previewShareMenuRect.top + 8, left }
            : { top: previewShareMenuRect.bottom + 8, left };

          const itemClass =
            "w-full text-left rounded-xl px-3 py-2.5 text-sm hover:bg-black/[0.05] dark:hover:bg-white/[0.08] flex items-center gap-2.5 text-black/80 dark:text-white/85 transition-colors";

          return (
            <div
              ref={previewShareMenuRef}
              data-vault-popover=""
              className="lg-menu p-1.5 flex flex-col min-w-[11rem]"
              style={{ position: "fixed", width: menuW, zIndex: 10060, ...style }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {canNativeShare ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewNative(card, shareUrl); }}
                  className={itemClass}
                >
                  <Share className="w-4 h-4 shrink-0 opacity-70" />
                  Share…
                </button>
              ) : null}
              {safeUrl ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewCopyLink(card, shareUrl); }}
                  className={itemClass}
                >
                  <LinkIcon className="w-4 h-4 shrink-0 opacity-70" />
                  Copy link
                </button>
              ) : null}
              {shareText ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewCopyText(card); }}
                  className={itemClass}
                >
                  <Copy className="w-4 h-4 shrink-0 opacity-70" />
                  Copy text
                </button>
              ) : null}
              {canDownload ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewDownload(card, shareUrl); }}
                  className={itemClass}
                >
                  <Download className="w-4 h-4 shrink-0 opacity-70" />
                  Download
                </button>
              ) : null}
              {safeUrl ? (
                <button
                  type="button"
                  onClick={() => sharePreviewOpenLink(card, shareUrl)}
                  className={itemClass}
                >
                  <Globe className="w-4 h-4 shrink-0 opacity-70" />
                  Open link
                </button>
              ) : null}
              {!canNativeShare && !safeUrl && !shareText ? (
                <div className="px-3 py-2.5 text-sm text-black/45 dark:text-white/45">
                  Nothing to share yet.
                </div>
              ) : null}
            </div>
          );
        })(),
        document.body
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

// ─── SourceFolderTile ──────────────────────────────────────────────────────
// A single tile that stands in for every card sourced from one connector
// (e.g. Notion). Visually it reads as "the connector's app icon" — favicon
// centered, name underneath, item count badge in the corner — so the user
// recognizes it at a glance rather than parsing it as a Finder-style
// folder. Tapping it opens a per-connector subview of the vault grid.
function SourceFolderTile({ card, heightClass = "aspect-square w-full" }) {
  const itemLabel = card.count === 1 ? "1 item" : `${card.count} items`;
  return (
    <div
      className={`relative rounded-2xl ${heightClass} flex flex-col items-center justify-center text-center overflow-hidden`}
    >
      <span className="absolute top-2 right-2 rounded-full bg-black/55 text-white text-[0.6875rem] font-semibold px-2 py-0.5 backdrop-blur-sm">
        {card.count}
      </span>
      <div className="w-14 h-14 rounded-2xl bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm flex items-center justify-center mb-2 overflow-hidden">
        {card.favicon ? (
          <img
            src={card.favicon}
            alt={`${card.sourceName} icon`}
            width={36}
            height={36}
            className="block object-contain"
            style={{ width: 36, height: 36 }}
            draggable={false}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <span className="text-lg font-semibold text-black/65 dark:text-zinc-700">
            {card.sourceName?.[0] || "?"}
          </span>
        )}
      </div>
      <div className="px-3">
        <div className="text-sm font-semibold text-black/85 dark:text-white/85 truncate">
          {card.sourceName}
        </div>
        <div className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-0.5">
          {itemLabel}
        </div>
      </div>
    </div>
  );
}
