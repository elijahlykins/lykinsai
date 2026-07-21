import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Info,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Grid2X2,
  Layers,
  LayoutGrid,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Music,
  Plug,
  Plus,
  Search,
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
import { lazyBackfillCardVariants } from "@/lib/vault/lazyVariantBackfill";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import VaultNewNoteChooser from "@/components/vault/VaultNewNoteChooser";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { safeExternalUrl, safeAttachmentUrl } from "@/lib/safeExternalUrl";
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
import { isVerticalSocialContent } from "@/lib/media/socialEmbed";
import { resolveRenderType } from "@/lib/vault/attachmentType";
import { SocialEmbedInline } from "@/components/media/SocialEmbedInline";
import LoadingScreen from "@/components/LoadingScreen";
import LinkPreview from "@/components/LinkPreview";
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

// Marker parsing is delegated to `attachmentsMarker.ts` so all consumers
// share the same JSON-string-aware scanner. The previous inline bracket
// counter mishandled `[`/`]` characters that appear inside JSON string
// fields (e.g. a filename like `report[2025].pdf`), which corrupted slices.
function stripAttachmentJsonMarker(content) {
  return stripAttachmentsMarker(String(content || ""));
}

// Legacy granular render type, now centralized in attachmentType.ts so the
// Vault, AI-context builder, and renderers all classify identically.
const resolveAttachmentType = resolveRenderType;

function isVoiceNoteCard(card = {}) {
  if (String(card.source || "").toLowerCase() === "voice_note") return true;
  if ((card.tags || []).some((t) => String(t).toLowerCase() === "voice")) return true;
  const label = String(card.attachment?.name || card.title || "").trim().toLowerCase();
  return label === "voice recording" || label.startsWith("voice note");
}

// Normalize a user-typed URL into a fully-qualified absolute URL.
// Accepts inputs like "youtube.com", "www.example.com/path", or
// "https://example.com" and always returns an `https://`-prefixed URL
// when the scheme is missing — without this the browser treats bare
// hostnames as relative paths (so `<a href="youtube.com">` would
// navigate to `/youtube.com` on the current origin instead of YouTube).
//
// Returns `null` for empty input or strings that can't possibly be
// URLs (e.g. a single word with no dot like "asdf"), so callers can
// short-circuit and surface a clear error instead of firing a doomed
// unfurl request.
function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  // Already has a scheme (http:, https:, mailto:, ftp:, etc.). Run
  // through the URL constructor so we get a canonical form and reject
  // truly malformed strings like "https:///".
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
    try { return new URL(trimmed).toString(); } catch { return null; }
  }
  // Heuristic: a bare hostname / path needs at least one dot
  // ("youtube.com") or to start with localhost/an IP. This blocks the
  // pathological case where a user typing "asdf" + Enter would get
  // upgraded to "https://asdf" and trigger a wasted unfurl request.
  const looksLikeHost =
    trimmed.includes(".") ||
    /^localhost(:\d+)?(\/|$|\?|#)/i.test(trimmed) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed);
  if (!looksLikeHost) return null;
  try {
    return new URL(`https://${trimmed}`).toString();
  } catch {
    return null;
  }
}

function parseStorageTarget(attachment = {}, prefer = null) {
  const explicitBucket = String(attachment.storageBucket || "user-files").trim() || "user-files";

  // Prefer a smaller rendition when asked and available (Phase 3 variants):
  // thumb → medium → original; medium → original.
  if (prefer) {
    const thumb = String(attachment.variantThumbPath || "").trim();
    const medium = String(attachment.variantMediumPath || "").trim();
    const variantPath = prefer === "thumb" ? thumb || medium : medium;
    if (variantPath) return { bucket: explicitBucket, path: variantPath };
  }

  const explicitPath = String(attachment.storagePath || "").trim();
  if (explicitPath) {
    return { bucket: explicitBucket, path: explicitPath };
  }

  const url = String(attachment.url || "").trim();
  if (!url || url.startsWith("data:")) return null;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "";
    const publicMatch = path.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (publicMatch) {
      return {
        bucket: decodeURIComponent(publicMatch[1] || "user-files"),
        path: decodeURIComponent(publicMatch[2] || ""),
      };
    }
    const signedMatch = path.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (signedMatch) {
      return {
        bucket: decodeURIComponent(signedMatch[1] || "user-files"),
        path: decodeURIComponent(signedMatch[2] || ""),
      };
    }
  } catch {
    // Non-URL strings are handled by the raw attachment URL fallback.
  }
  return null;
}

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

function buildTextExcerpt(htmlOrText = "") {
  // Strip the attachments marker first via the JSON-aware parser so a stray
  // `]` inside attachment metadata doesn't leave residue in the excerpt.
  let text = stripAttachmentsMarker(String(htmlOrText));
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, "");
  text = text.replace(/File uploaded:\s*/i, "");
  text = text.replace(/Type:\s*\w+/i, "");
  text = text.replace(/Size:\s*[\d.]+ [A-Z]+/i, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Preserve paragraph breaks for card previews of formatted notes (meetings, tasks). */
function buildSpacedExcerpt(htmlOrText = "", maxLen = 420) {
  let text = stripAttachmentsMarker(String(htmlOrText || ""));
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "• ");
  text = text.replace(/^\s*\[[ xX]\]\s+/gm, "• ");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen).trim()}…`;
  return text;
}

/**
 * Classify text-only vault rows so meeting notes + browser tasks don't land
 * in the generic "Quick Note" bucket (wrong label + collapsed whitespace).
 */
function resolveTextNoteStyle(noteSource = "", tags = [], title = "", content = "") {
  const src = String(noteSource || "").toLowerCase();
  const tagSet = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()));
  const titleLower = String(title || "").trim().toLowerCase();
  if (
    src === "meeting_notes" ||
    src.includes("meeting") ||
    tagSet.has("meeting-notes") ||
    titleLower.startsWith("meeting:") ||
    titleLower.startsWith("meeting notes")
  ) {
    return "meeting";
  }
  if (
    src === "browser_task" ||
    src.endsWith(":task") ||
    tagSet.has("browser-task") ||
    titleLower.startsWith("browser task:")
  ) {
    return "task";
  }
  // Markdown docs with headings (saved summaries, etc.) — still not a sticky note.
  if (/^#{1,3}\s+\S+/m.test(String(content || "")) && String(content || "").length > 160) {
    return "doc";
  }
  return "quick";
}

function textNoteLabel(style) {
  if (style === "meeting") return "Meeting notes";
  if (style === "task") return "Task";
  if (style === "doc") return "Note";
  return "Quick Note";
}

function sanitizeCardTitle(raw = "") {
  const s = String(raw).trim();
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return "Saved Item"; }
  }
  return s || "Untitled";
}

function parseAttachmentNotes(attachment = {}) {
  const raw = Array.isArray(attachment?.notes) ? attachment.notes : [];
  return raw
    .map((item, idx) => {
      const text = String(item?.text || "").trim();
      if (!text) return null;
      return {
        id: String(item?.id || `note-${idx}`),
        text,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

// Quick notes don't have an attachment to hang per-file notes off, so
// comments live in a sibling jsonb column on the row itself. Same shape
// as parseAttachmentNotes so the UI can render either with one helper.
function parseQuickNoteComments(note = {}) {
  let raw = note?.comments;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx) => {
      const text = String(item?.text || "").trim();
      if (!text) return null;
      return {
        id: String(item?.id || `comment-${idx}`),
        text,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

function withAttachmentJsonMarker(content = "", attachments = []) {
  return withAttachmentsMarker(String(content || ""), attachments);
}

function decodeHtmlEntities(input = "") {
  const map = {
    "&quot;": "\"",
    "&#039;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  return String(input).replace(/&quot;|&#039;|&amp;|&lt;|&gt;/g, (m) => map[m] || m);
}

function extractChatPreview(content = "") {
  const raw = String(content || "").trim();
  if (!raw) return null;

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const decoded = decodeHtmlEntities(raw);
  const candidateStrings = [raw, decoded];

  const extractJsonCandidates = (value) => {
    const candidates = [];
    const firstBrace = value.indexOf("{");
    const lastBrace = value.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(value.slice(firstBrace, lastBrace + 1));
    }
    const blocksIdx = value.indexOf("\"blocks\"");
    if (blocksIdx !== -1) {
      const left = value.lastIndexOf("{", blocksIdx);
      if (left !== -1) {
        const right = value.lastIndexOf("}");
        if (right > left) candidates.push(value.slice(left, right + 1));
      }
    }
    return candidates;
  };

  let parsed = null;
  for (const source of candidateStrings) {
    parsed = tryParse(source);
    if (parsed) break;
    const embeddedCandidates = extractJsonCandidates(source);
    for (const candidate of embeddedCandidates) {
      parsed = tryParse(candidate);
      if (parsed) break;
    }
    if (parsed) break;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) return null;

  const turns = [];
  const textOnlyPrompts = [];
  parsed.blocks.forEach((block) => {
    const userText = block?.content?.text ? buildTextExcerpt(block.content.text) : "";
    if (userText) textOnlyPrompts.push(userText);
    const answers = Array.isArray(block?.content?.aiAnswers) ? block.content.aiAnswers : [];
    answers.forEach((answer) => {
      const q = buildTextExcerpt(answer?.q || userText || "");
      const a = buildTextExcerpt(answer?.a || "");
      if (q || a) turns.push({ q, a, ts: answer?.ts || null });
    });
  });

  if (turns.length === 0) {
    // Still return a chat-style preview for brick documents so raw JSON
    // never falls back into a plain quick-note text dump.
    const firstPrompt = textOnlyPrompts[0] || "";
    return {
      turnsCount: 0,
      question: firstPrompt || "Chat draft",
      answer: firstPrompt ? "" : "No messages yet.",
    };
  }

  const first = turns[0];
  return {
    turnsCount: turns.length,
    question: first.q || "Chat message",
    answer: first.a || "",
  };
}

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveAttachmentAspectRatio(attachment = {}) {
  const width =
    toNumber(attachment.width) ??
    toNumber(attachment.imageWidth) ??
    toNumber(attachment.videoWidth) ??
    toNumber(attachment.metadata?.width) ??
    toNumber(attachment.metadata?.imageWidth) ??
    toNumber(attachment.metadata?.videoWidth);
  const height =
    toNumber(attachment.height) ??
    toNumber(attachment.imageHeight) ??
    toNumber(attachment.videoHeight) ??
    toNumber(attachment.metadata?.height) ??
    toNumber(attachment.metadata?.imageHeight) ??
    toNumber(attachment.metadata?.videoHeight);

  if (!width || !height || height <= 0) return null;
  return width / height;
}

function isYouTubeShortUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes("youtube.com") && host !== "youtu.be") return false;
    const path = parsed.pathname.toLowerCase();
    return path.includes("/shorts/");
  } catch {
    return value.toLowerCase().includes("youtube.com/shorts/");
  }
}

function stableBucket(value, count) {
  const source = String(value || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return count > 0 ? hash % count : 0;
}

function getYouTubeOffsetClass(seed) {
  const offsets = ["", "mt-1", "mt-2", "mt-3", "mt-4"];
  return offsets[stableBucket(seed, offsets.length)];
}

function vaultPdfEmbedUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const params = "toolbar=0&navpanes=0&scrollbar=1";
  return raw.includes("#") ? raw : `${raw}#${params}`;
}

function renderConnectorListCard(attachment, title, { expanded = false, compact = false } = {}) {
  const items = Array.isArray(attachment?.listItems) ? attachment.listItems : [];
  const siteLabel = attachment?.siteName || title || "Connected app";
  const maxItems = expanded ? items.length : compact ? 3 : 5;

  return (
    <div className={`rounded-2xl overflow-hidden glass-control ${expanded ? "" : "cursor-pointer"}`}>
      <div className={`flex items-center gap-2 border-b border-black/8 dark:border-white/8 ${compact ? "px-3 py-2" : "px-3.5 py-2.5"}`}>
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
          {items.length} items
        </span>
      </div>
      <ul className={`divide-y divide-black/6 dark:divide-white/6 ${expanded ? "max-h-[70vh] overflow-y-auto scrollbar-hide" : ""}`}>
        {items.slice(0, maxItems).map((item, index) => (
          <li key={`${item.label}-${index}`} className={compact ? "px-3 py-1.5" : "px-3.5 py-2.5"}>
            <div className={`${compact ? "text-[0.6875rem]" : "text-xs"} font-medium text-black/80 dark:text-white/80 truncate`}>{item.label}</div>
            {item.meta ? (
              <div className={`${compact ? "text-[0.625rem]" : "text-[0.6875rem]"} text-black/50 dark:text-white/50 truncate mt-0.5`}>{item.meta}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function getAttachmentHeightClass(card) {
  const type = card?.type;
  const ratio = resolveAttachmentAspectRatio(card?.attachment);

  if (type === "youtube") {
    const url = String(card?.attachment?.url || "");
    // Shorts should be tall, longform should be middle.
    if (isYouTubeShortUrl(url)) return "h-96 md:h-[34rem] xl:h-[42rem]";
    const middleVariants = [
      "h-44 md:h-52 xl:h-[15rem]",
      "h-48 md:h-56 xl:h-[16rem]",
      "h-52 md:h-60 xl:h-[17rem]",
      "h-56 md:h-64 xl:h-[18rem]",
      "h-60 md:h-72 xl:h-[19rem]",
      "h-64 md:h-80 xl:h-[22rem]",
    ];
    const bucket = stableBucket(card?.id || url, middleVariants.length);
    return middleVariants[bucket];
  }

  // If we know dimensions, size to fit content shape.
  if (ratio) {
    if (ratio <= 0.8) return "h-96 md:h-[34rem] xl:h-[42rem]"; // Pinterest-style tall
    if (ratio <= 1.05) return "h-72 md:h-80 xl:h-96"; // 3/4
    if (ratio <= 1.6) return "h-56 md:h-64 xl:h-72"; // half
    return "h-44 md:h-52 xl:h-60"; // 1/4 (wide)
  }

  // Social media embeds — vertical content (Reels, TikTok) is taller
  if (type === "instagram" || type === "tiktok" || type === "facebook") {
    const socialUrl = String(card?.attachment?.url || "");
    if (isVerticalSocialContent(socialUrl)) return "h-[28rem] md:h-[36rem] xl:h-[44rem]";
    return "h-80 md:h-[26rem] xl:h-[32rem]";
  }

  // Fallback by content type when dimensions are not present.
  if (type === "image") return "h-auto";
  if (type === "video" || type === "youtube") return "h-auto";
  if (type === "pdf" || type === "html") return "h-56 md:h-64 xl:h-72";
  if (type === "bookmark") return "h-auto";
  if (type === "spreadsheet") return "h-auto";
  if (type === "doc" || type === "word" || type === "file") return "h-56 md:h-64 xl:h-72";
  if (type === "audio") return "h-40 md:h-44 xl:h-52";
  return "h-56 md:h-64 xl:h-72";
}

// Relative height estimate (taller = bigger number) used ONLY to assign a
// card to a masonry column. It must be DETERMINISTIC and independent of async
// load state — we base it on attachment metadata / type defaults, never on
// live-measured dimensions — so the column a card lands in never changes as
// images resolve or more pages append. Approximate balance is fine; stability
// is the goal. The unit is "height relative to one column's width" (1 / aspect)
// plus a small constant for the tag/action footer.
function estimateCardHeightUnit(card) {
  if (!card) return 1;
  const FOOTER = 0.28;
  if (card.kind === "source-folder") return 0.62;
  if (card.kind === "chat-preview") return 1.0 + FOOTER;
  if (card.kind === "quick-note") {
    const len = String(card.excerpt || "").length;
    const text = Math.min(1.4, 0.45 + len / 600);
    return text + FOOTER;
  }
  if (card.kind === "attachment") {
    const t = card.type;
    if (t === "audio") return 0.32 + FOOTER;
    if (t === "youtube") {
      const isShort = isYouTubeShortUrl(String(card.attachment?.url || ""));
      return (isShort ? 1.78 : 0.5625) + FOOTER;
    }
    if (t === "image" || t === "video") {
      const ratio = resolveAttachmentAspectRatio(card.attachment) || (t === "video" ? 16 / 9 : 1);
      const unit = ratio > 0 ? 1 / ratio : 1;
      // Clamp so a freak ratio can't dominate a column's estimate.
      return Math.min(2.2, Math.max(0.4, unit)) + FOOTER;
    }
    if (t === "pdf" || t === "html" || t === "doc" || t === "word" || t === "file") return 0.85 + FOOTER;
    if (t === "instagram" || t === "tiktok" || t === "facebook") return 1.4 + FOOTER;
    return 0.9 + FOOTER; // bookmark / link / unknown
  }
  return 0.9 + FOOTER;
}

// `h-auto` tiles reserve zero height in masonry/collage columns, so the
// skeleton collapses and every subsequent image load shoves the column
// downward. Always map to a stable bucket before first paint.
function resolveStableTileHeight(card, tileHeightClass) {
  if (tileHeightClass && tileHeightClass !== "h-auto") return tileHeightClass;
  const fromCard = getAttachmentHeightClass(card);
  if (fromCard && fromCard !== "h-auto") return fromCard;
  return "h-56 md:h-64 xl:h-72";
}

function extractYouTubeLinks(content = "") {
  const text = String(content || "");
  if (!text) return [];
  const regex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+(?:[^\s<)]*)?|youtu\.be\/[\w-]+(?:[^\s<)]*)?)/gi;
  const matches = text.match(regex) || [];
  return [...new Set(matches)];
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
        className={`mt-4 md:mt-5 columns-2 sm:columns-3 md:columns-4 xl:columns-5 2xl:columns-6 ${
          embedded ? "gap-3" : "gap-4 md:gap-5"
        }`}
      >
        {tiles.map((_, i) => (
          <div
            key={`vault-skeleton-${i}`}
            className={`break-inside-avoid inline-block w-full rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] animate-pulse ${
              embedded ? "mb-3" : "mb-4 md:mb-5"
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
          ? "mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
          : "mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"
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
 * Phase 4 "why" editor — the single, scalar reason the user saved a vault
 * item (distinct from the comments thread). Self-contained so it owns its
 * draft state; the parent only supplies the initial value + a save handler.
 */
function WhyEditor({ initialValue = "", onSave, busy = false }) {
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

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

  if (!editing && trimmed) {
    return (
      <div className="rounded-xl bg-amber-500/[0.07] dark:bg-amber-400/[0.08] border border-amber-500/20 dark:border-amber-400/15 px-4 py-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[0.625rem] uppercase tracking-wide text-amber-700/70 dark:text-amber-300/70">Why I saved this</div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[0.625rem] font-medium text-amber-700/80 dark:text-amber-300/80 hover:underline"
          >
            Edit
          </button>
        </div>
        <p className="text-sm text-black/80 dark:text-white/85 whitespace-pre-wrap break-words">{trimmed}</p>
      </div>
    );
  }

  if (!editing && !trimmed) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full text-left rounded-xl border border-dashed border-black/15 dark:border-white/15 px-4 py-2.5 text-[0.8125rem] text-black/45 dark:text-white/45 hover:border-amber-500/40 hover:text-amber-700/80 dark:hover:text-amber-300/80 transition-colors"
      >
        + Add why you saved this
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-white/40 dark:bg-white/5 border border-amber-500/30 dark:border-amber-400/20 px-4 py-3">
      <div className="text-[0.625rem] uppercase tracking-wide text-amber-700/70 dark:text-amber-300/70 mb-1.5">Why I saved this</div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoFocus
        rows={3}
        maxLength={2000}
        placeholder="A short note on why this matters to you…"
        className="w-full resize-y rounded-lg bg-white/70 dark:bg-black/30 border border-black/10 dark:border-white/10 px-3 py-2 text-sm text-black/85 dark:text-white/85 outline-none focus:border-amber-500/50"
      />
      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={() => { setDraft(initialValue); setEditing(false); }}
          className="text-xs font-medium text-black/55 dark:text-white/55 hover:text-black/80 dark:hover:text-white/80 px-2 py-1"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || busy || !dirty}
          className="text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-full px-3.5 py-1.5 transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export default function Vault({ wakePreview = false, onWakePreviewTabChange } = {}) {
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
  // Signed URLs for video poster frames (the generated thumb/medium JPEG).
  // Used as the <video poster> so grid cards show a real frame instead of a
  // black box while the video itself only preloads metadata.
  const [resolvedVideoPosterUrls, setResolvedVideoPosterUrls] = useState({});
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
  const [saveLinkUrl, setSaveLinkUrl] = useState("");
  const [saveLinkPreview, setSaveLinkPreview] = useState(null);
  const [showSignInBlocker, setShowSignInBlocker] = useState(false);
  const [walkthroughGateOpen, setWalkthroughGateOpen] = useState(false);
  const [previewCard, setPreviewCard] = useState(null);
  // "Details" dropdown in the item preview — everything tied to the item
  // (notes/comments, description, tags, date) is tucked behind it so the item
  // itself reads as the screen. Reset closed whenever a different item opens.
  const [previewDetailsOpen, setPreviewDetailsOpen] = useState(false);
  // Per-connector "folder" view. When non-null, the vault grid collapses
  // every connector-sourced card (e.g. Notion pages) into a single tile
  // and clicking that tile opens this state to the connector's id. The
  // grid then renders only that connector's items plus a "back to all"
  // affordance. null = normal mixed view.
  const [openSourceFolder, setOpenSourceFolder] = useState(null);
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
  const [isSaveLinkLoading, setIsSaveLinkLoading] = useState(false);
  const [isSaveLinkSaving, setIsSaveLinkSaving] = useState(false);
  const [vaultSearch, setVaultSearch] = useState("");
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
      return localStorage.getItem("lykn_vault_view") || "collage";
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
  const unfurlAbortRef = useRef(null);
  const lastHoverTargetRef = useRef(null);
  const loadMoreRef = useRef(null);
  const cardMenuRef = useRef(null);
  const noteComposerRef = useRef(null);
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
      const { data: insertedNote, error } = await supabase
        .from("vault_items")
        .insert({
          user_id: user.id,
          title: "Quick Note",
          content: chatText,
        })
        .select("id, title, content, created_at, updated_at")
        .single();
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

  const resolvedColumnsRef = useRef(null);

  // Attachments live inside `notes.content` as an `[ATTACHMENTS_JSON:[…]]`
  // marker (see `attachmentsMarker.ts`) — there is intentionally no
  // `attachments` column on the `notes` table. Older revisions probed for
  // one and ate a 400 on every cold load; the probe is gone.
  const COLUMN_SETS = [
    // Richest first; PostgREST errors on an unknown column so we fall back
    // through these on older DBs that lack `comments`/`why`.
    "id, title, content, tags, created_at, updated_at, comments, why",
    "id, title, content, tags, created_at, updated_at, comments",
    "id, title, content, tags, created_at, updated_at",
    "id, title, content, created_at, updated_at",
  ];

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
      const buildQuery = (cols) => {
        let q = supabase
          .from("vault_items")
          .select(cols)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MEMORY_PAGE_SIZE);
        if (cursor && cursor.createdAt) {
          if (cursor.id) {
            q = q.or(
              `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
            );
          } else {
            q = q.lt("created_at", cursor.createdAt);
          }
        }
        return q;
      };

      if (resolvedColumnsRef.current) {
        const { data, error } = await buildQuery(resolvedColumnsRef.current);
        return { data, error };
      }

      for (const cols of COLUMN_SETS) {
        const { data, error } = await buildQuery(cols);
        if (!error) {
          resolvedColumnsRef.current = cols;
          return { data, error: null };
        }
      }

      resolvedColumnsRef.current = COLUMN_SETS[COLUMN_SETS.length - 1];
      return await buildQuery(resolvedColumnsRef.current);
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

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("lykn_chat_projects")
        .select("id, name, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      return Array.isArray(data) ? data : [];
    },
    enabled: !!user?.id && !loading,
  });

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

  useEffect(() => {
    const onPointerDown = (event) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(event.target)) {
        setOpenCardMenuId(null);
      }
      if (noteComposerRef.current && !noteComposerRef.current.contains(event.target)) {
        setOpenAttachmentNotesCardId(null);
        setOpenAttachmentNotesRect(null);
        setAttachmentNoteDraft("");
      }
      if (tagPickerRef.current && !tagPickerRef.current.contains(event.target)) {
        setTagPickerCardId(null);
        setTagPickerPosition(null);
        setNewTagInput("");
      }
      if (embeddedTagDropdownRef.current && !embeddedTagDropdownRef.current.contains(event.target)) {
        setShowEmbeddedTagDropdown(false);
      }
      if (vaultViewDropdownRef.current && !vaultViewDropdownRef.current.contains(event.target)) {
        setShowVaultViewDropdown(false);
      }
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
      setOpenCardMenuId(null);
      setOpenAttachmentNotesCardId(null);
      setAttachmentNoteDraft("");
      setTagPickerCardId(null);
      setTagPickerPosition(null);
      setNewTagInput("");
      setShowEmbeddedTagDropdown(false);
      setShowVaultViewDropdown(false);
      // Escape should also dismiss the Save Link dialog and the new-note
      // chooser — previously they were backdrop-click/X only.
      setShowSaveLink(false);
      setSaveLinkUrl("");
      setSaveLinkPreview(null);
      setShowNewNoteChooser(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!openCardMenuId) return;
    const close = () => setOpenCardMenuId(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [openCardMenuId]);

  // The comment composer and tag picker are position:fixed popovers anchored
  // to a rect captured at open time. Close them on scroll/resize so they
  // don't float detached from their card when the grid scrolls behind them.
  useEffect(() => {
    if (!openAttachmentNotesCardId && !tagPickerCardId) return;
    const close = (event) => {
      // Ignore scrolls that originate inside the popovers themselves
      // (e.g. scrolling the comment list or the tag list).
      const target = event?.target;
      if (target instanceof Element && target.closest("[data-vault-popover]")) return;
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
        const type = resolveAttachmentType(attachment);
        cards.push({
          id: `${note.id}-att-${attachment.id || idx}`,
          kind: "attachment",
          noteId: note.id,
          attachmentIndex: idx,
          type,
          attachment,
          title: sanitizeCardTitle(attachment.name || note.title),
          parentTitle: sanitizeCardTitle(note.title || "Untitled note"),
          noteExcerpt,
          dateLabel,
          tags: noteTags,
          source: noteSource,
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
          lastTouchedMs,
          createdAtMs,
        });
      }
    });

    const cardsWithPreviewComments = isWakePreview
      ? cards.map((card) => applyWakePreviewCommentsToCard(card, wakePreviewCardComments))
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
  }, [notes, ghostCards, wakeDemoCards, wakePreviewUserQuickNoteCards, isWakePreview, wakePreviewCardComments]);

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
      pickerParentInitReceivedRef.current = true;
      pickerSyncedWithParentRef.current = false;
      pickerUserAdjustedRef.current = false;
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
  }, [location.search, location.pathname, vaultCards, isLoadingNotes, hasMoreNotes]);

  const [allTagsRaw, setAllTagsRaw] = useState([]);

  useEffect(() => {
    if (!user?.id) { setAllTagsRaw([]); return; }
    let cancelled = false;
    (async () => {
      // Prefer the server-side aggregation (migration 053). It returns
      // pre-sorted (tag, count) rows from a single SQL pass, scoped by
      // `auth.uid()`. For large accounts this avoids pulling every
      // tag cell into the browser and aggregating on the main thread.
      try {
        const { data: rpcData, error: rpcError } = await supabase
          .rpc("vault_tag_counts");
        if (cancelled) return;
        if (!rpcError && Array.isArray(rpcData)) {
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
        // Fall through to legacy path if the RPC isn't deployed yet
        // (PGRST202 = function not found). Other RPC errors also degrade
        // gracefully so a transient blip doesn't blank the directory.
        if (rpcError && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.info("[Vault] vault_tag_counts RPC unavailable, using fallback:", rpcError?.message || rpcError);
        }
      } catch (e) {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Vault] vault_tag_counts RPC threw, using fallback:", e);
        }
      }

      // Legacy in-browser aggregation. Kept as a safety net for envs
      // missing migration 053. Capped at 5000 rows so a runaway account
      // can't OOM the tab while the RPC migration is pending.
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
      if (resolvedColumnsRef.current && !resolvedColumnsRef.current.includes("tags")) return false;
      const { error } = await supabase
        .from("vault_items")
        .update({ tags: newTags })
        .eq("id", noteId)
        .eq("user_id", user.id);
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
    // Grid cards prefer the small thumb variant for images (big bandwidth win);
    // video keeps the original (its variant is a poster, not a playable file).
    const cardType = resolveAttachmentType(card.attachment || {});
    const isImage = cardType === "image";
    // Existing images without variants: backfill them in the background on
    // first view so future loads use the small rendition.
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
    const target = parseStorageTarget(card.attachment || {}, isImage ? "thumb" : null);
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
        await Promise.allSettled(batch.map((card) => resolveSignedUrlForCard(card)));
      }
      urlResolveDrainingRef.current = false;
    })();
    return drainPromiseRef.current;
  }, [resolveSignedUrlForCard]);

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
          const { data: note } = await supabase
            .from("vault_items")
            .select("content, updated_at")
            .eq("id", job.noteId)
            .eq("user_id", user.id)
            .single();
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
          const { error } = await supabase
            .from("vault_items")
            .update({ content: updatedContent })
            .eq("id", job.noteId)
            .eq("user_id", user.id)
            .eq("updated_at", note.updated_at);
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
      (card) => card.kind !== "chat-preview" && !pendingDeleteCardIds.has(card.id),
    );

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
  }, [vaultCards, pendingDeleteCardIds, openSourceFolder, vaultView, embeddedSearch, vaultSearch, conceptResultIds]);

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
          const { data: note } = await supabase
            .from("vault_items")
            .select("content, updated_at")
            .eq("id", card.noteId)
            .eq("user_id", user.id)
            .single();
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
          const { error: updateError } = await supabase
            .from("vault_items")
            .update({ content: updatedContent })
            .eq("id", card.noteId)
            .eq("user_id", user.id)
            .eq("updated_at", note.updated_at);
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
    try { localStorage.setItem("lykn_vault_view", vaultView); } catch {}
  }, [vaultView, isWakePreview, isPickerMode]);

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
      if (card.kind === "source-folder") folderCards.push(card);
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
                    draggable={!isPickerMode && !isEmbeddedMode}
                    onDragStart={(e) => handleCardDragStart(e, card)}
                    onDrag={handleCardDrag}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      if (!draggedCardId || draggedCardId === card.id) return;
                      // While the dragged card is overlapping the trash, suspend
                      // the live "push cards around" reorder so dropping deletes
                      // cleanly rather than racing with a reorder.
                      if (vaultTrashHover || vaultTrashHoldReady) return;
                      if (lastHoverTargetRef.current === card.id) return;
                      lastHoverTargetRef.current = card.id;
                      setDropTargetCardId(card.id);
                      reorderActivePage(draggedCardId, card.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (vaultTrashHover || vaultTrashHoldReady) return;
                      setDropTargetCardId(card.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      // Trash overlap takes precedence — let dragend run the
                      // delete; don't reorder onto the hovered card.
                      if (vaultTrashHoldReady) {
                        setDropTargetCardId(null);
                        return;
                      }
                      const droppedId = e.dataTransfer.getData("application/x-lykins-vault-card-id") || draggedCardId;
                      if (droppedId && droppedId !== card.id) {
                        reorderActivePage(droppedId, card.id);
                      }
                      setDraggedCardId(null);
                      setDropTargetCardId(null);
                      lastHoverTargetRef.current = null;
                      window.dispatchEvent(new CustomEvent("vault_collage_reorder_drag_end"));
                    }}
                    onDragEnd={handleCardDragEnd}
                    onClick={(e) => handleCardPress(e, card)}
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
                    className={`${vaultView === "grid" ? "" : "break-inside-avoid"} ${vaultView === "grid" ? "" : isEmbeddedMode ? "mb-3" : "mb-5"} rounded-2xl relative ${
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
                        heightClass={vaultView === "grid" ? "h-44" : "h-44"}
                      />
                    ) : card.kind === "attachment" ? (
                      <>
                        {renderAttachmentCard(card, vaultView === "grid" ? "h-44" : getAttachmentHeightClass(card))}
                        {parseAttachmentNotes(card.attachment).length > 0 && (
                          <button
                            type="button"
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
                            <MessageSquare className="w-3 h-3 text-black" />
                            <span>{parseAttachmentNotes(card.attachment).length}</span>
                          </button>
                        )}
                        {card.tags?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1 px-1" data-no-drag="true">
                            {card.tags.map((t) => (
                              <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="mt-2 flex justify-end px-1" data-no-drag="true">
                          <div className="relative">
                            <button
                              type="button"
                              data-no-drag="true"
                              draggable={false}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (openCardMenuId === card.id) {
                                  setOpenCardMenuId(null);
                                  return;
                                }
                                openCardMenuForAnchor(card.id, e.currentTarget);
                              }}
                              className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                              title="Actions"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </>
                    ) : card.kind === "chat-preview" ? (
                      <div className={`p-4 space-y-3 ${vaultView === "grid" ? "h-44 overflow-hidden" : ""}`}>
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
                        {card.tags?.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {card.tags.map((t) => (
                              <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                {t}
                              </span>
                            ))}
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
                        <div className={`glass-control rounded-2xl p-4 relative ${vaultView === "grid" ? "h-44 overflow-hidden" : ""}`}>
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
                          {card.tags?.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {card.tags.map((t) => (
                                <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-3 text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{card.dateLabel}</span>
                          </div>
                          {(card.comments?.length || 0) > 0 && (
                            <button
                              type="button"
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
                              <MessageSquare className="w-3 h-3 text-black" />
                              <span>{card.comments.length}</span>
                            </button>
                          )}
                        </div>
                        <div className="mt-2 flex justify-end px-1" data-no-drag="true">
                          <div className="relative">
                            <button
                              type="button"
                              data-no-drag="true"
                              draggable={false}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (openCardMenuId === card.id) {
                                  setOpenCardMenuId(null);
                                  return;
                                }
                                openCardMenuForAnchor(card.id, e.currentTarget);
                              }}
                              className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                              title="Quick note actions"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </div>
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

  const handleCardDragStart = useCallback((e, card) => {
    if (isPickerMode) {
      e.preventDefault();
      return;
    }
    // Guest demo cards aren't backed by a real note — dragging them into a
    // project or the canvas would have nowhere to land. Block the drag and
    // surface the sign-in prompt instead.
    if (card?.isDemo) {
      e.preventDefault();
      requireSignInForAction();
      return;
    }
    // In-flight (ghost) uploads aren't backed by a note yet, so dragging
    // them around the grid (or out to the canvas) has no meaningful target.
    if (card?.ghost) {
      e.preventDefault();
      return;
    }
    // Source-folder tiles are synthetic — they collapse N real cards into
    // one. Reordering or dragging them out of the vault has no sensible
    // semantics, so block the drag entirely.
    if (card?.kind === "source-folder") {
      e.preventDefault();
      return;
    }
    if (e.target instanceof Element && e.target.closest("[data-no-drag='true']")) {
      e.preventDefault();
      return;
    }
    const resolvedUrl =
      card.kind === "attachment"
        ? resolvedAttachmentUrls[card.id] || card?.attachment?.url || ""
        : "";
    if (resolvedUrl) {
      try {
        e.dataTransfer.setData("text/uri-list", resolvedUrl);
        e.dataTransfer.setData("text/plain", resolvedUrl);
      } catch {}
    }

    if (isEmbeddedMode && card.kind === "attachment" && card.attachment) {
      const att = card.attachment;
      const videoId = card.type === "youtube" ? (att.videoId || extractYouTubeVideoId(att.url || "") || "") : "";
      const resolvedForDrag = resolvedAttachmentUrls[card.id] || att.url || "";
      const pdfText = (card.type === "pdf" && att.extractedText) ? String(att.extractedText) : "";
      const dragAttachment = { ...att, url: resolvedForDrag, type: card.type, videoId, ...(pdfText ? { pdfText, extractedText: pdfText } : {}) };
      const pendingData = {
        id: card.id,
        // Persist the source note id and the original attachment index so
        // canvas drop handlers can target the exact attachment the user
        // dragged, not just "the first attachment whose mime matches". Today
        // attachments[] always has length 1 (per-tile drag), but keeping
        // these explicit means future flows that drag a whole note with
        // multiple attachments don't silently lose precision.
        noteId: card.noteId || card.id,
        attachmentIndex: Number.isInteger(card.attachmentIndex) ? card.attachmentIndex : 0,
        title: card.title || "",
        content: "",
        attachments: [dragAttachment],
        attachment: dragAttachment,
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
      try { e.dataTransfer.setData("application/x-lykn-chat-vault", JSON.stringify(pendingData)); } catch {}
      try {
        const target = window.parent !== window ? window.parent : window;
        /** @type {any} */ (target).__lyknchat_pending_vault = pendingData;
      } catch {}
      try {
        window.parent.postMessage({ type: "lykn-chat-vault-drag-start", data: pendingData }, embeddedTargetOrigin);
      } catch {}
      e.dataTransfer.effectAllowed = "copyMove";
    } else if (isEmbeddedMode && card.kind === "quick-note") {
      const pendingData = {
        id: card.id,
        noteId: card.noteId || card.id,
        attachmentIndex: 0,
        title: card.title || "Quick Note",
        content: card.excerpt || "",
        attachments: [],
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
      try {
        e.dataTransfer.setData("text/plain", card.excerpt || card.title || "Quick Note");
        e.dataTransfer.setData("application/x-lykn-chat-vault", JSON.stringify(pendingData));
      } catch {}
      try {
        const target = window.parent !== window ? window.parent : window;
        /** @type {any} */ (target).__lyknchat_pending_vault = pendingData;
      } catch {}
      try {
        window.parent.postMessage({ type: "lykn-chat-vault-drag-start", data: pendingData }, embeddedTargetOrigin);
      } catch {}
      e.dataTransfer.effectAllowed = "copyMove";
    } else {
      e.dataTransfer.effectAllowed = "move";
    }

    setDraggedCardId(card.id);
    lastHoverTargetRef.current = card.id;
    // Capture the card's bounding rect + cursor offset so we can compute
    // the dragged card's virtual rect during the drag (the HTML5 drag
    // image follows the cursor with this same offset). This mirrors the
    // canvas trash overlap logic, where the dragged element's rect — not
    // the cursor — drives trash detection.
    const targetEl = e.currentTarget;
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      draggedCardMetricsRef.current = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      };
    } else {
      draggedCardMetricsRef.current = null;
    }
    window.dispatchEvent(new CustomEvent("vault_collage_reorder_drag_start"));
    try { e.dataTransfer.setData("application/x-lykins-vault-card-id", card.id); } catch {}
  }, [isPickerMode, isEmbeddedMode, resolvedAttachmentUrls, requireSignInForAction, embeddedTargetOrigin]);

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

  // Open a full-size preview/view window when a card is clicked. Interactive
  // elements (buttons, links, form fields, media controls, menus) opt-out
  // either via stopPropagation or by being covered in this selector.
  const handleCardPress = useCallback((e, card) => {
    if (!card) return;
    if (draggedCardId) return;
    // Connector folder tiles aren't previewable — they're a navigation
    // affordance into a per-connector subview of the grid.
    if (card.kind === "source-folder") {
      setOpenCardMenuId(null);
      setOpenAttachmentNotesCardId(null);
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
      setOpenCardMenuId(null);
      setOpenAttachmentNotesCardId(null);
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
      setOpenCardMenuId(null);
      setOpenAttachmentNotesCardId(null);
      setPreviewCard(null);
      if (shift) selectRangeTo(card);
      else toggleCardSelection(card);
      return;
    }
    if (selectedCardIds.size > 0) clearSelection();

    setOpenCardMenuId(null);
    setOpenAttachmentNotesCardId(null);

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

    setPreviewDetailsOpen(false);
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
  ]);

  useEffect(() => {
    if (!previewCard) return;
    const onKey = (e) => {
      if (e.key === "Escape") setPreviewCard(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewCard]);

  // Opening an HTML artifact in the preview modal must mint a file-proxy URL
  // even if the grid tile never entered the intersection observer viewport —
  // or if the grid somehow cached a raw Supabase URL that blanks the iframe.
  useEffect(() => {
    if (!previewCard || previewCard.kind !== "attachment") return;
    const t = resolveAttachmentType(previewCard.attachment || {});
    if (t !== "html") return;
    if (failedImageIds.has(previewCard.id)) return;
    const existing = resolvedAttachmentUrls[previewCard.id];
    if (existing && !/supabase\.co\/storage\//i.test(existing)) return;
    void resolveSignedUrlForCard(previewCard);
  }, [previewCard, resolvedAttachmentUrls, failedImageIds, resolveSignedUrlForCard]);

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

      ({ data: insertedNote, error: noteError } = await supabase
        .from("vault_items")
        .insert({
          user_id: user.id,
          title: "Quick Note",
          content,
          source: "quick_note",
          tags: ["note"],
        })
        .select("id, title, content, tags, created_at, updated_at")
        .single());

      const missingColumnError =
        noteError &&
        (
          noteError.code === "PGRST204" ||
          noteError.message?.includes("Could not find") ||
          String(noteError.message || "").toLowerCase().includes("does not exist")
        );

      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await supabase
          .from("vault_items")
          .insert({
            user_id: user.id,
            title: "Quick Note",
            content,
          })
          .select("id, title, content, created_at, updated_at")
          .single());
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

  const handleUnfurlLink = useCallback(async (rawUrl) => {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      // Bare strings like "asdf" or "" — user gets a toast instead of a
      // silent failure so they understand why nothing happened.
      const trimmed = String(rawUrl || "").trim();
      if (trimmed) {
        toast({
          title: "Invalid URL",
          description: "Please enter a full link, e.g. youtube.com or https://example.com.",
          variant: "destructive",
        });
      }
      return;
    }
    // Reflect the canonical form back into the input so the user can
    // see what's actually being saved (and so the preview pane and
    // input agree on the same string).
    setSaveLinkUrl(url);
    // Cancel any in-flight unfurl. Without this, a user pasting two URLs
    // in rapid succession can have the older (slower) request resolve
    // last and overwrite the newer preview — looks like the link
    // changed itself in the dialog.
    if (unfurlAbortRef.current) {
      try { unfurlAbortRef.current.abort(); } catch { /* ignore */ }
    }
    const controller = new AbortController();
    unfurlAbortRef.current = controller;
    setIsSaveLinkLoading(true);
    setSaveLinkPreview(null);
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Unfurl failed");
      const data = await res.json();
      // Guard against a stale request resolving after a newer one
      // already replaced the controller.
      if (unfurlAbortRef.current !== controller) return;
      // Force the preview to use the normalized URL even if the server
      // echoed back the bare input — the saved attachment record reads
      // `saveLinkPreview.url` and a bare hostname there would still
      // render as a relative href in any consumer that doesn't
      // re-normalize.
      setSaveLinkPreview({ ...data, url: data?.url ? normalizeUrl(data.url) || url : url });
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (unfurlAbortRef.current !== controller) return;
      setSaveLinkPreview({ url, title: url, description: "", image: "", siteName: "", favicon: "", articleText: "", _error: true });
    } finally {
      if (unfurlAbortRef.current === controller) {
        unfurlAbortRef.current = null;
        setIsSaveLinkLoading(false);
      }
    }
  }, []);

  const handleSaveLink = useCallback(async () => {
    if (!user?.id) { setShowSignInBlocker(true); return; }
    if (isSaveLinkSaving || !saveLinkPreview) return;
    if (!(await checkVaultLimit())) return;
    setIsSaveLinkSaving(true);
    try {
      // Defense in depth: even though `handleUnfurlLink` normalizes the
      // URL on the way in, anything that mutates `saveLinkPreview.url`
      // after the fact (e.g. server echo) could re-introduce a bare
      // hostname. Force a final pass before persistence.
      const safeUrl = normalizeUrl(saveLinkPreview.url || saveLinkUrl) || (saveLinkPreview.url || saveLinkUrl);
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
      const noteContent = `${saveLinkPreview.title || saveLinkUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: insertedNote, error } = await supabase
        .from("vault_items")
        .insert({
          user_id: user.id,
          title: saveLinkPreview.title || saveLinkUrl,
          content: noteContent,
        })
        .select("id, title, content, created_at, updated_at")
        .single();
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
      setSaveLinkUrl("");
      setSaveLinkPreview(null);
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
  }, [user?.id, isSaveLinkSaving, saveLinkPreview, saveLinkUrl, checkVaultLimit, incrementVaultCount]);

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
    const { attachment, type, title } = card;
    const resolvedUrl = resolvedAttachmentUrls[card.id] || attachment.url;
    const wakeDemoCard = isWakePreview && card.isDemo;
    const stableTileHeight = resolveStableTileHeight(card, tileHeightClass);
    // Grid/tags/type views pass a single fixed height class (e.g. "h-44") and
    // expect uniform tiles. The collage passes responsive bucketed classes.
    // When the tile is uniform, keep the fixed height instead of switching to
    // the media's real aspect-ratio — otherwise a portrait image stretches its
    // whole grid row and leaves large gaps under shorter neighbors.
    const uniformTile =
      typeof tileHeightClass === "string" && /^h-\d+$/.test(tileHeightClass.trim());

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
        return (
          <div
            className={`w-full ${reservedHeightClass} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}
            style={reservedAspectStyle}
          >
            <FileText className="w-8 h-8 text-black/20 dark:text-white/20" />
            <span className="text-xs text-black/40 dark:text-white/40 text-center truncate max-w-full">{title}</span>
            {isStorageBacked && (
              <button
                type="button"
                className="text-[0.625rem] font-medium text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  imageRetryCountsRef.current.delete(card.id);
                  setFailedImageIds((prev) => { const next = new Set(prev); next.delete(card.id); return next; });
                  signedUrlCacheRef.current.delete(`${storageTarget?.bucket || "user-files"}:${storageTarget?.path || ""}`);
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
      const embedUrl = /supabase\.co\/storage\//i.test(candidate || "")
        ? null
        : safeAttachmentUrl(candidate);
      const htmlFailed = failedImageIds.has(card.id);
      return (
        <div className="rounded-2xl overflow-hidden glass-control cursor-pointer">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8 dark:border-white/8 pointer-events-none">
            <FileText className="w-4 h-4 text-blue-500 shrink-0" />
            <div className="min-w-0">
              <span className="block text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
              <span className="block text-[0.625rem] text-black/45 dark:text-white/45">Interactive preview</span>
            </div>
          </div>
          <div className={`w-full ${tileHeightClass} overflow-hidden bg-[#15130f]`}>
            {embedUrl ? (
              <iframe
                src={embedUrl}
                title={title || "Artifact preview"}
                className="w-full h-full border-0 pointer-events-none"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
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
              <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1 truncate">{attachment.url}</p>
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
        return renderConnectorListCard(attachment, title, { compact: isWakePreview });
      }
      const linkUrl = attachment.url || resolvedUrl || "";
      return (
        <div className={isPickerMode ? "pointer-events-none" : undefined}>
          <LinkPreview
            url={linkUrl}
            title={attachment.title || title || ""}
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
    }

    if (type === "spreadsheet") {
      const cells = attachment.cells || {};
      const totalRows = Math.min(Number(attachment.rows) || 0, 8);
      const totalCols = Math.min(Number(attachment.cols) || 0, 6);
      const hasData = totalRows > 0 && totalCols > 0 && Object.keys(cells).length > 0;
      const fileName = attachment.name || title || "Spreadsheet";
      return (
        <div className="rounded-2xl overflow-hidden glass-control">
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

  const removeCardFromProjects = useCallback((card) => {
    const storageTarget = parseStorageTarget(card?.attachment || {});
    const storagePath = storageTarget?.path || "";
    const cardUrl = card?.attachment?.url || "";
    if (!storagePath && !cardUrl) return;

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("project:")) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key));
        const files = Array.isArray(parsed?.files) ? parsed.files : [];
        const filtered = files.filter((f) => {
          if (storagePath && (f.path === storagePath || f.url?.includes(storagePath))) return false;
          if (cardUrl && f.url === cardUrl) return false;
          return true;
        });
        if (filtered.length !== files.length) {
          localStorage.setItem(key, JSON.stringify({ ...parsed, files: filtered }));
        }
      } catch {
        // ignore malformed project data
      }
    }
  }, []);

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
        const { error: stripError } = await supabase
          .from("vault_items")
          .update({ content: stripped, updated_at: new Date().toISOString() })
          .eq("id", card.noteId)
          .eq("user_id", user.id);
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
        const { error: deleteError } = await supabase
          .from("vault_items")
          .delete()
          .eq("id", card.noteId)
          .eq("user_id", user.id);
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
        ({ error: updateError } = await supabase
          .from("vault_items")
          .update({
            content: nextContent,
            updated_at: new Date().toISOString(),
          })
          .eq("id", card.noteId)
          .eq("user_id", user.id));
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
        if (storageTarget?.bucket && storageTarget?.path) {
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
      const { error: deleteError } = await supabase
        .from("vault_items")
        .delete()
        .eq("id", card.noteId)
        .eq("user_id", user.id);
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
    setIsCardActionBusy(true);
    try {
      const project = projects.find((p) => String(p.id) === String(projectId));
      if (!project) return;

      const storageTarget = parseStorageTarget(card.attachment || {});
      let fileUrl =
        card.kind === "quick-note"
          ? `data:text/plain;charset=utf-8,${encodeURIComponent(String(card.excerpt || card.title || "Quick Note"))}`
          : resolvedAttachmentUrls[card.id] || card.attachment?.url || "";
      if (card.kind !== "quick-note" && storageTarget?.bucket && storageTarget?.path) {
        const { data } = await supabase.storage
          .from(storageTarget.bucket)
          .createSignedUrl(storageTarget.path, 60 * 60 * 24 * 7);
        if (data?.signedUrl) fileUrl = data.signedUrl;
      }

      const kindByType = {
        image: "image",
        video: "video",
        pdf: "pdf",
        youtube: "link",
        instagram: "link",
        tiktok: "link",
        facebook: "link",
        "quick-note": "text",
      };
      const kind = kindByType[card.type || card.kind] || "file";
      let parsed = {};
      try {
        const raw = localStorage.getItem(`project:${projectId}`);
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }
      const existingFolders = Array.isArray(parsed?.folders) ? parsed.folders : [];
      const existingFiles = Array.isArray(parsed?.files) ? parsed.files : [];
      const newFile = {
        id: crypto.randomUUID(),
        name: card.title || (card.kind === "quick-note" ? "Quick Note" : "Vault File"),
        path: storageTarget?.path || fileUrl,
        folderId: null,
        kind,
        url: fileUrl,
        tags: Array.isArray(card.tags) ? card.tags : [],
      };
      const nextFiles = [newFile, ...existingFiles];
      localStorage.setItem(
        `project:${projectId}`,
        JSON.stringify({
          folders: existingFolders,
          files: nextFiles,
          activeFolderId: parsed?.activeFolderId ?? null,
        })
      );
      setOpenCardMenuId(null);
      // Replaced blocking `window.alert` with a toast — alerts pause the
      // event loop, can't be dismissed by Esc consistently across browsers,
      // and look nothing like the rest of the app.
      toast({
        title: "Added to project",
        description: project.name,
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, [projects, resolvedAttachmentUrls]);

  const createProjectFromCard = useCallback(async (card) => {
    if (!user?.id || !card) return;
    setIsCardActionBusy(true);
    try {
      const projectNameBase = String(card.title || "New Project").trim() || "New Project";
      const projectName = projectNameBase.length > 60 ? `${projectNameBase.slice(0, 60)}...` : projectNameBase;
      const { data: project, error: projectError } = await supabase
        .from("lykn_chat_projects")
        .insert({ user_id: user.id, name: projectName })
        .select("id, name, updated_at")
        .single();
      if (projectError || !project?.id) return;

      const storageTarget = parseStorageTarget(card.attachment || {});
      let fileUrl =
        card.kind === "quick-note"
          ? `data:text/plain;charset=utf-8,${encodeURIComponent(String(card.excerpt || card.title || "Quick Note"))}`
          : resolvedAttachmentUrls[card.id] || card.attachment?.url || "";
      if (card.kind !== "quick-note" && storageTarget?.bucket && storageTarget?.path) {
        const { data } = await supabase.storage
          .from(storageTarget.bucket)
          .createSignedUrl(storageTarget.path, 60 * 60 * 24 * 7);
        if (data?.signedUrl) fileUrl = data.signedUrl;
      }

      const kindByType = {
        image: "image",
        video: "video",
        pdf: "pdf",
        youtube: "link",
        instagram: "link",
        tiktok: "link",
        facebook: "link",
        "quick-note": "text",
      };
      const kind = kindByType[card.type || card.kind] || "file";
      const newFile = {
        id: crypto.randomUUID(),
        name: card.title || (card.kind === "quick-note" ? "Quick Note" : "Vault File"),
        path: storageTarget?.path || fileUrl,
        folderId: null,
        kind,
        url: fileUrl,
      };
      localStorage.setItem(
        `project:${project.id}`,
        JSON.stringify({
          folders: [],
          files: [newFile],
          activeFolderId: null,
        })
      );

      vaultQueryClient.invalidateQueries({ queryKey: ["projects", user?.id] });
      setOpenCardMenuId(null);
      toast({
        title: "Project created",
        description: `Added this item to "${project.name}".`,
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, [resolvedAttachmentUrls, user?.id]);

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

      const { error: updateError } = await supabase
        .from("vault_items")
        .update({
          content: nextContent,
          updated_at: new Date().toISOString(),
        })
        .eq("id", card.noteId)
        .eq("user_id", user.id);

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

      const { error: updateError } = await supabase
        .from("vault_items")
        .update({
          comments: nextComments,
          updated_at: new Date().toISOString(),
        })
        .eq("id", card.noteId)
        .eq("user_id", user.id);

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
      const { error: updateError } = await supabase
        .from("vault_items")
        .update({ why, updated_at: new Date().toISOString() })
        .eq("id", card.noteId)
        .eq("user_id", user.id);

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

  if ((loading || isLoadingNotes || !vaultReady) && user && !isWakePreview) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div
      ref={vaultPreviewRootRef}
      className={`${
        isWakePreview ? "lykn-wake-vault-live-preview h-full min-h-0" : "min-h-screen"
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
          {/* Bottom-right FAB: voice or written note chooser. */}
          <button
            type="button"
            onClick={handleToggleQuickNote}
            title={showQuickNote ? "Hide quick note" : "New note"}
            aria-label={showQuickNote ? "Hide quick note" : "New note"}
            className={`fixed right-6 z-[70] w-12 h-12 rounded-full border shadow-lg flex items-center justify-center transition touch-manipulation ${
              showQuickNote || showNewNoteChooser
                ? "bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/25 dark:bg-blue-400/20 dark:text-blue-400 dark:hover:bg-blue-400/30"
                : "border-black/[0.08] bg-[hsl(var(--sidebar-surface))] text-black/80 hover:brightness-95 dark:border-white/[0.08] dark:bg-[hsl(0_0%_16%)] dark:text-white/90 dark:hover:brightness-125"
            }`}
            // Clear the mobile tab bar — without this the tab bar (z-[75])
            // paints over most of the FAB on phones, making it untappable.
            style={{ bottom: "calc(1.5rem + var(--mobile-tabbar-clear, 0px))" }}
          >
            <Plus className="w-5 h-5" />
          </button>

          {/* Bottom-center app dock lives one level up in
              VaultConnectionsShell so a single instance renders across
              both /vault and /connections — keeps the launcher visible
              while the user is browsing the apps grid and avoids two
              parallel polling loops fetching the same connection list. */}
          </>
          )}
        </>
      )}

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
                        <div className="absolute top-full left-0 mt-1 w-44 rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur-md shadow-md z-[400] py-1">
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
                    <div className="absolute top-full left-0 mt-1 w-52 max-h-56 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur-md shadow-md z-[400] py-1 scrollbar-hide">
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
                className="mt-4 flex flex-wrap items-center gap-3 relative z-[400]"
                style={{ minHeight: 1 }}
              >
                <form
                  className="relative w-full sm:flex-1 sm:max-w-xl"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleConceptSearch(vaultSearch);
                  }}
                >
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
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
                        <div className={`absolute top-full mt-1 w-44 max-w-[calc(100vw-1.5rem)] rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur-md shadow-md z-[400] py-1 ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
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
                      <div className={`absolute top-full mt-1 w-56 md:w-64 max-w-[calc(100vw-1.5rem)] max-h-72 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur-md shadow-md z-[400] py-1 scrollbar-hide ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
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
                {!isWakePreview && (
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
                    <div className={isEmbeddedMode ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"}>
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
                          draggable
                          onDragStart={(e) => handleCardDragStart(e, card)}
                          onDrag={handleCardDrag}
                          onDragEnd={handleCardDragEnd}
                          onClick={(e) => handleCardPress(e, card)}
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
                            <SourceFolderTile card={card} heightClass="h-40" />
                          ) : card.kind === "attachment" ? (
                            <>
                              {renderAttachmentCard(card, "h-40")}
                              {card.tags?.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1 px-1">
                                  {card.tags.map((t) => (
                                    <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">{t}</span>
                                  ))}
                                </div>
                              )}
                              <div className="mt-1 flex justify-end px-1">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenAttachmentNotesCardId(null);
                                    if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                    openCardMenuForAnchor(card.id, e.currentTarget);
                                  }}
                                  className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                  title="Actions"
                                >
                                  <MoreHorizontal className="w-4 h-4" />
                                </button>
                              </div>
                            </>
                          ) : card.kind === "quick-note" ? (
                            <>
                              <div className="glass-control rounded-2xl p-3 h-40 overflow-hidden">
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
                              <div className="mt-1 flex justify-end px-1">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenAttachmentNotesCardId(null);
                                    if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                    openCardMenuForAnchor(card.id, e.currentTarget);
                                  }}
                                  className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                  title="Actions"
                                >
                                  <MoreHorizontal className="w-4 h-4" />
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="glass-control rounded-2xl p-3 h-40 overflow-hidden">
                                <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                              </div>
                              <div className="mt-1 flex justify-end px-1">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenAttachmentNotesCardId(null);
                                    if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                    openCardMenuForAnchor(card.id, e.currentTarget);
                                  }}
                                  className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                  title="Actions"
                                >
                                  <MoreHorizontal className="w-4 h-4" />
                                </button>
                              </div>
                            </>
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
                      <div className={isEmbeddedMode ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"}>
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
                            draggable
                            onDragStart={(e) => handleCardDragStart(e, card)}
                            onDrag={handleCardDrag}
                            onDragEnd={handleCardDragEnd}
                            onClick={(e) => handleCardPress(e, card)}
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
                              <>
                                {renderAttachmentCard(card, "h-40")}
                                <div className="mt-1 flex justify-end px-1">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenAttachmentNotesCardId(null);
                                      if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                      openCardMenuForAnchor(card.id, e.currentTarget);
                                    }}
                                    className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                    title="Actions"
                                  >
                                    <MoreHorizontal className="w-4 h-4" />
                                  </button>
                                </div>
                              </>
                            ) : card.kind === "quick-note" ? (
                              <>
                                <div className="glass-control rounded-2xl p-3 h-40 overflow-hidden">
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
                                <div className="mt-1 flex justify-end px-1">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenAttachmentNotesCardId(null);
                                      if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                      openCardMenuForAnchor(card.id, e.currentTarget);
                                    }}
                                    className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                    title="Actions"
                                  >
                                    <MoreHorizontal className="w-4 h-4" />
                                  </button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="glass-control rounded-2xl p-3 h-40 overflow-hidden">
                                  <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                  {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                                </div>
                                <div className="mt-1 flex justify-end px-1">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenAttachmentNotesCardId(null);
                                      if (openCardMenuId === card.id) { setOpenCardMenuId(null); return; }
                                      openCardMenuForAnchor(card.id, e.currentTarget);
                                    }}
                                    className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                    title="Actions"
                                  >
                                    <MoreHorizontal className="w-4 h-4" />
                                  </button>
                                </div>
                              </>
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
                            {card.tags?.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1 px-1" data-no-drag="true">
                                {card.tags.map((t) => (
                                  <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="mt-2 flex justify-end px-1" data-no-drag="true">
                              <button
                                type="button"
                                data-no-drag="true"
                                draggable={false}
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (openCardMenuId === card.id) {
                                    setOpenCardMenuId(null);
                                    return;
                                  }
                                  openCardMenuForAnchor(card.id, e.currentTarget);
                                }}
                                className="px-1 py-0.5 text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white leading-none text-base font-semibold"
                                title="Actions"
                              >
                                <MoreHorizontal className="w-4 h-4" />
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              {useMasonryLayout ? (
                <div className={`flex items-start ${isEmbeddedMode ? "gap-3" : "gap-4 md:gap-5"}`}>
                  {collageColumnBuckets.map((bucket, colIdx) => (
                    <div key={`vault-col-${colIdx}`} className="flex-1 min-w-0 flex flex-col">
                      {colIdx === 0 && vaultView === "collage" && !isWakePreview && (
                        <div className="mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[130px] gap-2">
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
                    ? "lykn-wake-vault-preview-grid col-start-1 col-span-3 row-start-2 grid grid-cols-3 gap-3"
                    : isEmbeddedMode
                    ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
                    : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"
                }>
                  {vaultView === "grid" && !isWakePreview && (
                    <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center aspect-square gap-2">
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


      {showSaveLink && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => { setShowSaveLink(false); setSaveLinkUrl(""); setSaveLinkPreview(null); }}>
          <div
            className="w-[420px] max-w-[92vw] max-h-[90vh] overflow-y-auto glass-control rounded-2xl shadow-lg p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-black/85 dark:text-white/85 flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Save Link to Vault
              </h2>
              <button type="button" onClick={() => { setShowSaveLink(false); setSaveLinkUrl(""); setSaveLinkPreview(null); }} className="text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="url"
                value={saveLinkUrl}
                onChange={(e) => setSaveLinkUrl(e.target.value)}
                onPaste={(e) => {
                  // Always reflect what was pasted into the input and
                  // hand it to the unfurl helper — `handleUnfurlLink`
                  // is responsible for adding `https://`, validating,
                  // and showing a toast for nonsense input. The old
                  // `^https?://` gate silently swallowed bare-hostname
                  // pastes like "youtube.com", which is what produced
                  // the "saved link goes to /youtube.com on localhost"
                  // bug.
                  const pasted = e.clipboardData.getData("text").trim();
                  if (pasted) {
                    setSaveLinkUrl(pasted);
                    void handleUnfurlLink(pasted);
                  }
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && saveLinkUrl.trim()) void handleUnfurlLink(saveLinkUrl); }}
                placeholder="Paste or type a URL..."
                className="flex-1 rounded-xl border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-black/40 dark:placeholder:text-white/40 focus:border-blue-400/50"
                autoFocus
              />
              <button
                type="button"
                disabled={!saveLinkUrl.trim() || isSaveLinkLoading}
                onClick={() => void handleUnfurlLink(saveLinkUrl)}
                className="rounded-xl px-3 py-2 text-xs font-medium bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 disabled:opacity-40 transition-colors"
              >
                {isSaveLinkLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview"}
              </button>
            </div>

            {isSaveLinkLoading && (
              <div className="flex items-center justify-center py-6 text-black/50 dark:text-white/50">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span className="text-xs">Fetching link preview...</span>
              </div>
            )}

            {saveLinkPreview && !isSaveLinkLoading && (
                <div className="rounded-xl border border-white/40 dark:border-white/15 overflow-hidden bg-white/20 dark:bg-white/5">
                {saveLinkPreview.image && (
                  <div className="w-full h-40 overflow-hidden bg-black/5">
                    <img src={saveLinkPreview.image} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                  </div>
                )}
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
                    <Globe className="w-3 h-3" />
                    <span className="text-[0.625rem] font-medium">{saveLinkPreview.siteName || (() => { try { return new URL(saveLinkPreview.url).hostname.replace(/^www\./, ""); } catch { return ""; } })()}</span>
                  </div>
                  <p className="text-sm font-semibold text-black/85 dark:text-white/85 leading-snug">{saveLinkPreview.title}</p>
                  {saveLinkPreview.description && (
                    <p className="text-xs text-black/55 dark:text-white/55 leading-relaxed line-clamp-3">{saveLinkPreview.description}</p>
                  )}
                  {saveLinkPreview.articleText && (
                    <p className="text-[0.625rem] text-black/40 dark:text-white/40 mt-1">Article text captured ({saveLinkPreview.articleText.length.toLocaleString()} chars)</p>
                  )}
                </div>
              </div>
            )}

            {saveLinkPreview && !isSaveLinkLoading && (
              <button
                type="button"
                disabled={isSaveLinkSaving}
                onClick={() => void handleSaveLink()}
                className="w-full rounded-xl py-2.5 text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
              >
                {isSaveLinkSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
                {isSaveLinkSaving ? "Saving..." : "Save to Vault"}
              </button>
            )}
          </div>
        </div>
      )}

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
              className="rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-[hsl(var(--sidebar-surface))] dark:bg-[hsl(0_0%_16%)] shadow-lg text-black/80 dark:text-white/90 p-1.5 flex flex-col overflow-hidden"
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
                zIndex: 9999,
              }}
              onMouseDown={(e) => e.stopPropagation()}
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
                  <button
                    type="button"
                    disabled={isCardActionBusy}
                    onClick={() => {
                      if (blockWakePreviewVaultMutation(menuCard)) return;
                      void createProjectFromCard(menuCard);
                    }}
                    className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New project
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
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
                      <MessageSquare className="w-3.5 h-3.5" />
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
                        setTagPickerCardId(menuCard.id);
                        setTagPickerPosition({ left: rect.left, top: rect.bottom + 8 });
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
          const card = orderedVisibleCards.find((c) => c.id === openAttachmentNotesCardId);
          if (!card) return null;
          const isAttachment = card.kind === "attachment";
          const existingComments = isAttachment
            ? parseAttachmentNotes(card.attachment)
            : (card.comments || []);
          const onSave = isAttachment ? addAttachmentNote : addQuickNoteComment;
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

          return (
            <div
              ref={noteComposerRef}
              data-vault-popover=""
              className="rounded-2xl border border-white/30 dark:border-white/10 bg-white/90 dark:bg-[#171515]/90 backdrop-blur-md shadow-xl p-3 overflow-y-auto scrollbar-hide"
              style={positionStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
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
                    <div key={entry.id} className="rounded-md bg-black/5 dark:bg-white/5 px-2 py-1.5">
                      <p className="text-xs text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">
                        {entry.text}
                      </p>
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
              className="rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5 overflow-hidden"
              style={{ position: "fixed", width: menuW, left, top, zIndex: 10000 }}
              onMouseDown={(e) => e.stopPropagation()}
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
                  className="w-full h-8 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-[#1f1d1d]/60 px-2.5 text-xs outline-none placeholder:text-black/35 dark:placeholder:text-white/35 focus:border-blue-400/50"
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
          const card = previewCard;
          const att = card.attachment || {};
          const type = card.type || card.kind;
          const resolvedUrl = resolvedAttachmentUrls[card.id] || att.url || "";
          const title = card.title || att.name || (card.kind === "quick-note" ? (card.label || "Quick Note") : "Vault Item");
          const cardTags = Array.isArray(card.tags) ? card.tags : [];
          const fileNotes = card.kind === "attachment" ? parseAttachmentNotes(att) : [];
          const quickNoteComments = card.kind === "quick-note" ? parseQuickNoteComments(card) : [];
          const previewDescription =
            card.kind === "attachment"
              ? att.aiDescription
              : card.aiDescription;
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
          // The "why" editor is available for any real (non-wake-preview)
          // saved item, so the Details panel must open even when nothing else
          // is filled in yet.
          const canEditWhy = !isWakePreview && !!card.noteId;
          const videoId = type === "youtube"
            ? (extractYouTubeVideoId(String(att.url || "")) || String(att.videoId || "").trim() || null)
            : null;
          const youtubeEmbedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";

          let body;
          if (card.kind === "attachment" && type === "image") {
            body = (
              <img
                src={resolvedUrl}
                alt={title}
                className="w-full max-h-[78vh] object-contain rounded-xl bg-black/5 dark:bg-white/5"
                draggable={false}
              />
            );
          } else if (card.kind === "attachment" && type === "video") {
            body = (
              <video
                src={resolvedUrl}
                controls
                autoPlay
                playsInline
                className="w-full max-h-[78vh] rounded-xl bg-black"
              />
            );
          } else if (card.kind === "attachment" && type === "audio") {
            const voiceNote = isVoiceNoteCard(card);
            body = (
              <div className="flex flex-col items-center gap-4 py-8">
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
                className="w-full h-[78vh] rounded-xl border border-white/30 dark:border-white/10 bg-white"
              />
            );
          } else if (card.kind === "attachment" && type === "html") {
            const htmlStorage = parseStorageTarget(att);
            const htmlIsStorage = !!(htmlStorage?.bucket && htmlStorage?.path);
            // Wait for the file-proxy mint when storage-backed — painting a
            // raw Supabase signed URL blanks the iframe (wrong MIME / CSP).
            const candidate =
              resolvedAttachmentUrls[card.id] || (!htmlIsStorage ? resolvedUrl : "");
            const htmlEmbed = /supabase\.co\/storage\//i.test(candidate || "")
              ? null
              : safeAttachmentUrl(candidate);
            body = htmlEmbed ? (
              <iframe
                title={title}
                src={htmlEmbed}
                className="w-full h-[78vh] rounded-xl border border-white/30 dark:border-white/10 bg-[#15130f]"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex flex-col items-center gap-4 py-10 text-center">
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
                <div className="flex flex-col items-center justify-center gap-5 py-20 px-6 text-center rounded-xl bg-black/5 dark:bg-white/5">
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
                  className="w-full h-[70vh] rounded-xl border-0 bg-black"
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
              <div className="w-full max-h-[78vh] overflow-auto rounded-xl">
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
                  <div className="rounded-xl bg-white/40 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3 max-h-[40vh] overflow-y-auto text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap">
                    {att.articleText}
                  </div>
                )}
                {safeAttachmentUrl(att.url || resolvedUrl) && (
                  <a
                    href={safeAttachmentUrl(att.url || resolvedUrl) || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-600"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    Open link in new tab
                  </a>
                )}
              </div>
            );
          } else if (card.kind === "attachment" && type === "spreadsheet") {
            const cells = att.cells || {};
            const totalRows = Math.min(Number(att.rows) || 0, 200);
            const totalCols = Math.min(Number(att.cols) || 0, 50);
            body = (
              <div className="rounded-xl overflow-auto max-h-[78vh] border border-white/30 dark:border-white/10 bg-white/60 dark:bg-white/5">
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
            body = (
              <div className="flex flex-col items-center gap-4 py-10 text-center">
                <FileText className="w-14 h-14 text-black/30 dark:text-white/30" />
                <p className="text-sm text-black/70 dark:text-white/70 break-all max-w-lg">{title}</p>
                {safeAttachmentUrl(resolvedUrl) && (
                  <a
                    href={safeAttachmentUrl(resolvedUrl) || undefined}
                    target="_blank"
                    rel="noreferrer"
                    download={title}
                    className="text-xs font-medium text-blue-500 hover:text-blue-600 underline"
                  >
                    Open / download file
                  </a>
                )}
              </div>
            );
          } else if (card.kind === "quick-note") {
            const useMarkdown = !!(card.formatted || (card.noteStyle && card.noteStyle !== "quick"));
            body = (
              <div className="rounded-xl bg-white/45 dark:bg-white/5 border border-white/40 dark:border-white/10 px-5 py-4 max-h-[72vh] overflow-y-auto">
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
              <div className="space-y-3 max-h-[72vh] overflow-y-auto">
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

          // Everything tied to the item (its writeup/description, notes a.k.a.
          // "comments", tags, date) lives behind one Details dropdown so the
          // item itself shows plainly — "just what it is" — with only a little X.
          const allComments = [...fileNotes, ...quickNoteComments];
          const hasDetails =
            !!previewDescription || allComments.length > 0 || cardTags.length > 0 || !!card.dateLabel || canEditWhy || !!previewWhy;

          return (
            <div
              className="fixed inset-0 z-[9999] bg-black/55 backdrop-blur-sm flex items-start justify-center p-4 sm:p-6 md:p-10"
              onClick={() => setPreviewCard(null)}
            >
              <div
                className="relative w-[min(1100px,96vw)] max-h-[90vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Minimal floating controls: one Details dropdown + a little X. */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  {hasDetails ? (
                    <button
                      type="button"
                      onClick={() => setPreviewDetailsOpen((v) => !v)}
                      aria-expanded={previewDetailsOpen}
                      className="inline-flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-full bg-white/90 dark:bg-white/10 backdrop-blur border border-black/10 dark:border-white/15 text-[0.75rem] font-medium text-black/65 dark:text-white/75 hover:bg-white dark:hover:bg-white/15 shadow-sm transition-colors"
                    >
                      <Info className="w-3.5 h-3.5" />
                      <span className="max-w-[16rem] truncate">{title}</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${previewDetailsOpen ? "rotate-180" : ""}`} />
                    </button>
                  ) : (
                    <span className="text-[0.78rem] font-medium text-white/85 px-1 max-w-[18rem] truncate drop-shadow">{title}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewCard(null)}
                    className="rounded-full w-9 h-9 flex items-center justify-center bg-white/90 dark:bg-white/10 backdrop-blur border border-black/10 dark:border-white/15 text-black/60 dark:text-white/70 hover:bg-white dark:hover:bg-white/15 shadow-sm transition-colors"
                    title="Close (Esc)"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Details dropdown — description, notes/comments, tags, date. */}
                {previewDetailsOpen && hasDetails && (
                  <div className="mb-2 rounded-2xl border border-white/30 dark:border-white/10 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md shadow-2xl px-4 py-3.5 max-h-[42vh] overflow-y-auto space-y-3">
                    {card.dateLabel && (
                      <div className="flex items-center gap-1 text-[0.6875rem] text-black/50 dark:text-white/50">
                        <Clock className="w-3 h-3" />
                        <span>{card.dateLabel}</span>
                      </div>
                    )}
                    {canEditWhy ? (
                      <WhyEditor
                        initialValue={previewWhy}
                        busy={isCardActionBusy}
                        onSave={(value) => saveCardWhy(card, value)}
                      />
                    ) : previewWhy ? (
                      <div className="rounded-xl bg-amber-500/[0.07] dark:bg-amber-400/[0.08] border border-amber-500/20 dark:border-amber-400/15 px-4 py-3">
                        <div className="text-[0.625rem] uppercase tracking-wide text-amber-700/70 dark:text-amber-300/70 mb-1">Why I saved this</div>
                        <p className="text-sm text-black/80 dark:text-white/85 whitespace-pre-wrap break-words">{previewWhy}</p>
                      </div>
                    ) : null}
                    {previewDescription && (
                      <div className="rounded-xl bg-white/40 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3">
                        <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45 mb-1">Description</div>
                        <p className="text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{String(previewDescription)}</p>
                      </div>
                    )}
                    {allComments.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45">Notes</div>
                        {allComments.map((n) => (
                          <div key={n.id} className="rounded-lg bg-black/5 dark:bg-white/5 px-3 py-2">
                            <p className="text-xs text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{n.text}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {cardTags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {cardTags.map((t) => (
                          <span
                            key={t}
                            className="inline-flex items-center rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-300 text-[0.6875rem] leading-none px-2.5 py-1 font-medium"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* The item itself — shown plainly as what it is. */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {body}
                </div>
              </div>
            </div>
          );
        })(),
        document.body
      )}
      {/* Drag-to-delete trash can — desktop only. On phones the bottom-left
          corner conflicts with the mobile tab bar and the drag-and-hold
          gesture isn't usable on touch, so the affordance is hidden. */}
      {!isEmbeddedMode && !isWakePreview && !isMobileChat && !sidebarOpen && createPortal(
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
          `deleteSelectedCards`). */}
      {selectedCardIds.size > 0 && !isPickerMode && createPortal(
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
function SourceFolderTile({ card, heightClass = "h-44" }) {
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
