import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Grid3X3,
  Layers,
  LayoutGrid,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Music,
  Plus,
  Search,
  StickyNote,
  Tag,
  Send,
  Square,
  Trash2,
  ArrowUp,
  Table2,
  Upload,
  Video,
  X,
  GripVertical,
  Copy,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/canvas/utils/youtube";
import { detectSocialPlatform, isSocialEmbedType, isVerticalSocialContent } from "@/canvas/utils/socialEmbed";
import { SocialEmbedInline } from "@/canvas/blocks/SocialEmbedBlock";
import LoadingScreen from "@/components/LoadingScreen";
import { getAiPrefs } from "@/lib/ai-prefs";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { purgeVaultNoteEmbeddings } from "@/lib/synthesis/queueReindex";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { splitResponseIntoChunks, normalizeChecklistSyntax, flattenNodeText, handleChunkDragStart } from "@/lib/chatChunks";

function stripAttachmentJsonMarker(content) {
  if (!content) return "";
  const marker = "[ATTACHMENTS_JSON:";
  const start = content.indexOf(marker);
  if (start === -1) return content;

  const jsonStart = start + marker.length;
  let bracketCount = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < content.length; i += 1) {
    if (content[i] === "[") bracketCount += 1;
    if (content[i] === "]") {
      bracketCount -= 1;
      if (bracketCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd <= jsonStart) return content;
  let stripEnd = jsonEnd;
  if (content[stripEnd] === "]") stripEnd += 1;
  return `${content.slice(0, start)}${content.slice(stripEnd)}`.replace(/\n{3,}/g, "\n\n").trim();
}

function parseAttachmentsFromNote(note) {
  const normalized = [];

  if (Array.isArray(note.attachments)) {
    normalized.push(...note.attachments);
  } else if (typeof note.attachments === "string") {
    try {
      const parsed = JSON.parse(note.attachments);
      if (Array.isArray(parsed)) normalized.push(...parsed);
    } catch {
      // Keep going, content marker parsing below may still work.
    }
  }

  if (normalized.length === 0 && note.content) {
    const marker = "[ATTACHMENTS_JSON:";
    const start = note.content.indexOf(marker);
    if (start !== -1) {
      const jsonStart = start + marker.length;
      let bracketCount = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < note.content.length; i += 1) {
        if (note.content[i] === "[") bracketCount += 1;
        if (note.content[i] === "]") {
          bracketCount -= 1;
          if (bracketCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      if (jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(note.content.slice(jsonStart, jsonEnd));
          if (Array.isArray(parsed)) normalized.push(...parsed);
        } catch {
          // Ignore malformed attachment marker data.
        }
      }
    }
  }

  return normalized.filter(Boolean);
}

function resolveAttachmentType(attachment = {}) {
  const url = String(attachment.url || "");
  const name = String(attachment.name || "");

  if (isSocialEmbedType(attachment.oembedType)) return attachment.oembedType;
  const socialPlatform = detectSocialPlatform(url);
  if (socialPlatform) return socialPlatform;

  if (attachment.type === "bookmark" || attachment.type === "link" || attachment.siteName || attachment.articleText) return "bookmark";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";

  const explicit = attachment.type;
  if (explicit && explicit !== "file") return explicit;
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";

  const urlNoQuery = url.split("?")[0];
  const extMatch = (urlNoQuery.split("/").pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv"].includes(ext) || attachment.type === "spreadsheet") return "spreadsheet";
  if (["doc", "docx", "ppt", "pptx", "txt", "md"].includes(ext)) return "file";

  return "file";
}

function parseTagActions(text) {
  const match = text.match(/\[TAG_ACTIONS\]\s*([\s\S]*?)\s*\[\/TAG_ACTIONS\]/);
  if (!match) return { cleanText: text, actions: [] };
  const cleanText = text.replace(/\[TAG_ACTIONS\][\s\S]*?\[\/TAG_ACTIONS\]/, "").trim();
  try {
    const parsed = JSON.parse(match[1].trim());
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const valid = actions.filter(
      (a) => a.noteId && Array.isArray(a.tags) && a.tags.every((t) => typeof t === "string")
    );
    return { cleanText, actions: valid };
  } catch {
    return { cleanText, actions: [] };
  }
}

function parseStorageTarget(attachment = {}) {
  const explicitPath = String(attachment.storagePath || "").trim();
  const explicitBucket = String(attachment.storageBucket || "user-files").trim() || "user-files";
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

function buildTextExcerpt(htmlOrText = "") {
  let text = String(htmlOrText);
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, "");
  text = text.replace(/File uploaded:\s*/i, "");
  text = text.replace(/Type:\s*\w+/i, "");
  text = text.replace(/Size:\s*[\d.]+ [A-Z]+/i, "");
  text = text.replace(/\[ATTACHMENTS_JSON:[^\]]*\]/g, "");
  return text.replace(/\s+/g, " ").trim();
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

function withAttachmentJsonMarker(content = "", attachments = []) {
  const marker = "[ATTACHMENTS_JSON:";
  const payload = `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
  const raw = String(content || "");
  const start = raw.indexOf(marker);
  if (start === -1) {
    return `${raw.trim()}\n\n${payload}`.trim();
  }
  const jsonStart = start + marker.length;
  let bracketCount = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < raw.length; i += 1) {
    if (raw[i] === "[") bracketCount += 1;
    if (raw[i] === "]") {
      bracketCount -= 1;
      if (bracketCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd <= jsonStart) return `${raw.trim()}\n\n${payload}`.trim();
  return `${raw.slice(0, start)}${payload}${raw.slice(jsonEnd)}`.replace(/\n{3,}/g, "\n\n").trim();
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
  if (type === "pdf") return "h-80 md:h-[30rem] xl:h-[36rem]";
  if (type === "bookmark") return "h-auto";
  if (type === "spreadsheet") return "h-auto";
  if (type === "doc" || type === "word" || type === "file") return "h-56 md:h-64 xl:h-72";
  if (type === "audio") return "h-40 md:h-44 xl:h-52";
  return "h-56 md:h-64 xl:h-72";
}

function extractYouTubeLinks(content = "") {
  const text = String(content || "");
  if (!text) return [];
  const regex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+(?:[^\s<)]*)?|youtu\.be\/[\w-]+(?:[^\s<)]*)?)/gi;
  const matches = text.match(regex) || [];
  return [...new Set(matches)];
}

export default function VaultNew() {
  const location = useLocation();
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const addMediaTriggerRef = useRef(null);
  const isEmbeddedMode = useMemo(
    () => new URLSearchParams(location.search).get("embedded") === "1",
    [location.search]
  );
  useEffect(() => {
    if (isEmbeddedMode) {
      document.documentElement.classList.add("embedded-transparent");
      return () => document.documentElement.classList.remove("embedded-transparent");
    }
  }, [isEmbeddedMode]);


  const { checkVaultLimit, incrementVaultCount, upgradeModal, dismissUpgradeModal } = useUsageGate();
  const [embeddedSearch, setEmbeddedSearch] = useState("");
  const vaultQueryClient = useQueryClient();
  const [notes, setNotes] = useState([]);
  const [isLoadingNotes, setIsLoadingNotes] = useState(true);
  const [vaultReady, setVaultReady] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [orderByPage, setOrderByPage] = useState({ everything: [] });
  const [draggedCardId, setDraggedCardId] = useState(null);
  const [dropTargetCardId, setDropTargetCardId] = useState(null);
  const [hasMoreNotes, setHasMoreNotes] = useState(true);
  const [isLoadingMoreNotes, setIsLoadingMoreNotes] = useState(false);
  const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState({});
  const [failedImageIds, setFailedImageIds] = useState(new Set());
  const imageRetryCountsRef = useRef(new Map());
  // projects fetched via React Query above
  const [openCardMenuId, setOpenCardMenuId] = useState(null);
  const [openCardMenuPlacement, setOpenCardMenuPlacement] = useState("down");
  const [openCardMenuRect, setOpenCardMenuRect] = useState(null);
  const [openAttachmentNotesCardId, setOpenAttachmentNotesCardId] = useState(null);
  const [attachmentNoteDraft, setAttachmentNoteDraft] = useState("");
  const [isCardActionBusy, setIsCardActionBusy] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState(null);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState({});
  const [chatChunkDragOver, setChatChunkDragOver] = useState(false);
  const chatChunkDragDepthRef = useRef(0);
  const [showSaveLink, setShowSaveLink] = useState(false);
  const [saveLinkUrl, setSaveLinkUrl] = useState("");
  const [saveLinkPreview, setSaveLinkPreview] = useState(null);
  const [isSaveLinkLoading, setIsSaveLinkLoading] = useState(false);
  const [isSaveLinkSaving, setIsSaveLinkSaving] = useState(false);
  const [vaultSearch, setVaultSearch] = useState("");
  const [vaultView, setVaultView] = useState(() => {
    try { return localStorage.getItem("lykn_vault_view") || "collage"; } catch { return "collage"; }
  });
  const [conceptResultIds, setConceptResultIds] = useState(null);
  const [isConceptSearching, setIsConceptSearching] = useState(false);
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [showEmbeddedTagDropdown, setShowEmbeddedTagDropdown] = useState(false);
  const embeddedTagDropdownRef = useRef(null);
  const [tagPickerCardId, setTagPickerCardId] = useState(null);
  const [tagPickerPosition, setTagPickerPosition] = useState(null);
  const [newTagInput, setNewTagInput] = useState("");
  const tagPickerRef = useRef(null);
  const conceptSearchAbortRef = useRef(null);
  const lastHoverTargetRef = useRef(null);
  const loadMoreRef = useRef(null);
  const cardMenuRef = useRef(null);
  const noteComposerRef = useRef(null);
  const assistantIndexRef = useRef(null);
  const chatScrollRef = useRef(null);
  const chatUserScrolledUpRef = useRef(false);
  const chatInputRef = useRef(null);
  const [expandedAiMsgIds, setExpandedAiMsgIds] = useState(new Set());
  const prevMsgCountRef = useRef(0);
  const signedUrlCacheRef = useRef(new Map());

  const CHAT_RAIL_DEFAULT_WIDTH = 340;
  const [chatRailWidthManual, setChatRailWidthManual] = useState(null);
  const thinkingStatus = useThinkingStatus(isChatLoading);

  const clampChatRailWidth = useCallback((raw, vw) => {
    const width = Math.max(0, Math.floor(vw || 0));
    if (width < 640) return width;
    const minW = width <= 900 ? 200 : 260;
    const maxW = Math.max(minW + 20, Math.floor(width * 0.45));
    return Math.max(minW, Math.min(maxW, Math.floor(raw || minW)));
  }, []);

  const isMobileChat = typeof window !== "undefined" && window.innerWidth < 640;

  const chatRailWidthPx = showChat
    ? clampChatRailWidth(chatRailWidthManual ?? CHAT_RAIL_DEFAULT_WIDTH, window.innerWidth)
    : 0;

  const handleStartChatResize = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = chatRailWidthPx;
      const onMove = (ev) => {
        const dx = startX - ev.clientX;
        const vw = window.innerWidth || 1280;
        setChatRailWidthManual(clampChatRailWidth(startWidth + dx, vw));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    },
    [chatRailWidthPx, clampChatRailWidth]
  );
  const MEMORY_PAGE_SIZE = 100;

  const getCollapsedPreview = useCallback((text) => {
    const clean = text.replace(/[#*_`~>\[\]()!|]/g, "").replace(/\n+/g, " ").trim();
    return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  }, []);

  const toggleAiExpanded = useCallback((msgId) => {
    setExpandedAiMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  const updateTaskCheck = useCallback((msgId, taskKey, checked) => {
    setAssistantTaskChecks((prev) => ({
      ...prev,
      [msgId]: { ...(prev[msgId] || {}), [taskKey]: checked },
    }));
  }, []);

  const buildChatMarkdownComponents = useCallback((msgId) => ({
    h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
    h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
    h3: ({ children }) => <h3 className="text-base font-semibold mt-2.5 mb-1.5">{children}</h3>,
    p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
    li: ({ children }) => {
      const raw = flattenNodeText(children).trim();
      const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
      if (!match) return <li className="leading-relaxed">{children}</li>;
      const defaultChecked = String(match[1]).toLowerCase() === "x";
      const taskText = match[2];
      const taskKey = raw;
      const checked = assistantTaskChecks[msgId]?.[taskKey] ?? defaultChecked;
      return (
        <li className={`list-none ml-[-1.25rem] flex items-start gap-2 leading-relaxed ${checked ? "opacity-60" : ""}`}>
          <input
            type="checkbox"
            className="mt-[0.28rem] shrink-0 accent-blue-500"
            checked={checked}
            onChange={(e) => updateTaskCheck(msgId, taskKey, e.target.checked)}
          />
          <span className={checked ? "line-through" : ""}>{taskText}</span>
        </li>
      );
    },
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-black/20 dark:border-white/20 pl-3 my-2 text-black/70 dark:text-white/70 italic">{children}</blockquote>,
    code: ({ children, className }) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) return <pre className="rounded-lg bg-black/5 p-3 my-2 overflow-x-auto text-[0.85em]"><code>{children}</code></pre>;
      return <code className="rounded bg-black/10 px-1.5 py-0.5 text-[0.85em]">{children}</code>;
    },
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
    thead: ({ children }) => <thead className="border-b border-black/20">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-black/10">{children}</tr>,
    th: ({ children }) => <th className="text-left px-3 py-2 font-semibold">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2">{children}</td>,
  }), [assistantTaskChecks, updateTaskCheck]);

  const saveChunkAsQuickNote = useCallback((text) => {
    setQuickNoteContent(text);
    setShowQuickNote(true);
  }, []);

  const handleMainDragEnter = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-omnia-chat-response")) {
      e.preventDefault();
      chatChunkDragDepthRef.current += 1;
      setChatChunkDragOver(true);
    }
  }, []);

  const handleMainDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-omnia-chat-response")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleMainDragLeave = useCallback((e) => {
    if (e.dataTransfer.types.includes("application/x-omnia-chat-response")) {
      e.preventDefault();
      chatChunkDragDepthRef.current = Math.max(0, chatChunkDragDepthRef.current - 1);
      if (chatChunkDragDepthRef.current === 0) setChatChunkDragOver(false);
    }
  }, []);

  const handleMainDrop = useCallback(async (e) => {
    const chatText = e.dataTransfer.getData("application/x-omnia-chat-response");
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
        .from("notes")
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
      setNotesError("Couldn't save the dropped note. Please try again.");
    }
  }, [user?.id, checkVaultLimit, incrementVaultCount]);

  const chatIsNearBottom = useCallback((threshold = 80) => {
    const el = chatScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      chatUserScrolledUpRef.current = !chatIsNearBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [showChat, chatIsNearBottom]);

  useEffect(() => {
    if (!showChat) return;
    if (chatUserScrolledUpRef.current) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading, showChat]);

  useEffect(() => {
    const count = chatMessages.length;
    if (count > prevMsgCountRef.current && count > 0) {
      const latest = chatMessages[count - 1];
      if (latest?.id) setExpandedAiMsgIds(new Set([latest.id]));
    }
    prevMsgCountRef.current = count;
  }, [chatMessages.length]);

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
      deduped.sort((a, b) => {
        const at = new Date(a?.updated_at || a?.created_at || 0).getTime();
        const bt = new Date(b?.updated_at || b?.created_at || 0).getTime();
        return bt - at;
      });
      return deduped;
    });
  }, []);
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) return parsed.aiModel;
      }
    } catch {
      // ignore
    }
    return "claude-sonnet-4-6";
  });

  const notesCursorRef = useRef(null);

  const resolvedColumnsRef = useRef(null);

  const COLUMN_SETS = [
    "id, title, content, attachments, tags, created_at, updated_at",
    "id, title, content, tags, created_at, updated_at",
    "id, title, content, attachments, created_at, updated_at",
    "id, title, content, created_at, updated_at",
  ];

  const fetchNotesBatch = useCallback(
    async (cursor) => {
      const buildQuery = (cols) => {
        let q = supabase
          .from("notes")
          .select(cols)
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(MEMORY_PAGE_SIZE);
        if (cursor) q = q.lt("updated_at", cursor);
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

  const refreshNotes = useCallback(async () => {
    if (!user?.id) {
      setNotes([]);
      setIsLoadingNotes(false);
      setHasMoreNotes(false);
      return;
    }

    setIsLoadingNotes(true);
    setVaultReady(false);
    eagerResolveRunRef.current = false;
    initialCardIdsRef.current = null;
    setNotesError("");
    notesCursorRef.current = null;
    try {
      const { data, error } = await fetchNotesBatch(null);

      if (error) {
        if (["PGRST116", "42P01"].includes(error.code) || error.message?.includes("placeholder")) {
          setNotes([]);
          setHasMoreNotes(false);
        } else {
          throw error;
        }
      } else {
        const list = Array.isArray(data) ? data : [];
        setNotes(list);
        setHasMoreNotes(list.length === MEMORY_PAGE_SIZE);
        if (list.length > 0) notesCursorRef.current = list[list.length - 1].updated_at;
      }
    } catch (err) {
      setNotesError("Couldn't load your memories right now. Please try again later.");
      setHasMoreNotes(false);
    } finally {
      setIsLoadingNotes(false);
    }
  }, [fetchNotesBatch, user?.id]);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_projects")
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
    setIsLoadingMoreNotes(true);
    try {
      const { data, error } = await fetchNotesBatch(notesCursorRef.current);
      if (error) throw error;
      const list = Array.isArray(data) ? data : [];
      if (list.length === 0) {
        setHasMoreNotes(false);
        return;
      }
      setNotes((prev) => [...prev, ...list]);
      setHasMoreNotes(list.length === MEMORY_PAGE_SIZE);
      if (list.length > 0) notesCursorRef.current = list[list.length - 1].updated_at;
    } catch {
      setHasMoreNotes(false);
      setNotesError((prev) => prev || "Some memories could not be loaded.");
    } finally {
      setIsLoadingMoreNotes(false);
    }
  }, [fetchNotesBatch, hasMoreNotes, isLoadingMoreNotes, isLoadingNotes, user?.id]);

  useEffect(() => {
    const handleSettingsChange = () => {
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) setSelectedModel(parsed.aiModel);
      } catch {
        // ignore
      }
    };

    window.addEventListener("lykinsai_settings_changed", handleSettingsChange);
    window.addEventListener("storage", handleSettingsChange);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", handleSettingsChange);
      window.removeEventListener("storage", handleSettingsChange);
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    void refreshNotes();
  }, [loading, refreshNotes]);


  useEffect(() => {
    const onPointerDown = (event) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(event.target)) {
        setOpenCardMenuId(null);
      }
      if (noteComposerRef.current && !noteComposerRef.current.contains(event.target)) {
        setOpenAttachmentNotesCardId(null);
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
    };
    const onBlur = () => setShowEmbeddedTagDropdown(false);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("blur", onBlur);
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

  useEffect(() => {
    if (!loadMoreRef.current || loading || !user?.id) return;
    const target = loadMoreRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          void loadMoreNotes();
        }
      },
      { rootMargin: "320px 0px 320px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMoreNotes, loading, user?.id]);

  const vaultCards = useMemo(() => {
    const safeNotes = notes.filter((n) => n && !n.trashed);
    const cards = [];

    safeNotes.forEach((note) => {
      const attachments = parseAttachmentsFromNote(note);
      const cleanContent = stripAttachmentJsonMarker(note.content || "");
      const chatPreview = extractChatPreview(cleanContent);
      const youtubeLinks = extractYouTubeLinks(cleanContent);
      const dateLabel = formatDate(note.updated_at || note.created_at);
      const isStandaloneQuickNote =
        String(note?.source || "").toLowerCase() === "quick_note" ||
        (String(note?.title || "").trim().toLowerCase() === "quick note" && attachments.length === 0);
      const excerpt = isStandaloneQuickNote
        ? buildTextExcerpt(String(cleanContent || "").replace(/\r\n/g, "\n"))
        : buildTextExcerpt(cleanContent);

      const noteTags = Array.isArray(note.tags) ? note.tags : [];
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
        });
      });

      if (attachments.length === 0 && youtubeLinks.length > 0) {
        youtubeLinks.forEach((url, idx) => {
          cards.push({
            id: `${note.id}-yt-${idx}`,
            kind: "attachment",
            noteId: note.id,
            type: "youtube",
            attachment: { url, name: "YouTube Video" },
            title: "YouTube Video",
            parentTitle: note.title || "Untitled note",
            noteExcerpt,
            dateLabel,
            tags: noteTags,
          });
        });
      }

      if (!isStandaloneQuickNote && chatPreview && attachments.length === 0) {
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
        });
      }

      // For media-backed memories, show only the media tile in collage.
      if (excerpt && attachments.length === 0 && (isStandaloneQuickNote || !chatPreview)) {
        cards.push({
          id: `${note.id}-quick-note`,
          kind: "quick-note",
          noteId: note.id,
          title: note.title || "Quick Note",
          excerpt,
          dateLabel,
          tags: noteTags,
        });
      }
    });

    const seen = new Set();
    return cards.filter((card) => {
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
  }, [notes]);

  const [allTagsRaw, setAllTagsRaw] = useState([]);

  useEffect(() => {
    if (!user?.id) { setAllTagsRaw([]); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("notes")
        .select("tags")
        .eq("user_id", user.id)
        .not("tags", "is", null);
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
  }, [user?.id, notes]);

  const allTags = allTagsRaw;

  const updateNoteTags = useCallback(
    async (noteId, newTags) => {
      if (!user?.id) return;
      if (resolvedColumnsRef.current && !resolvedColumnsRef.current.includes("tags")) return;
      const { error } = await supabase
        .from("notes")
        .update({ tags: newTags })
        .eq("id", noteId)
        .eq("user_id", user.id);
      if (error) {
        console.error("Failed to update tags:", error);
        return;
      }
      setNotes((prev) =>
        prev.map((n) => (String(n.id) === String(noteId) ? { ...n, tags: newTags } : n))
      );
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

  const resolveSignedUrlForCard = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return;
    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) {
      const rawUrl = String(card.attachment?.url || "").trim();
      if (rawUrl && (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || !rawUrl.includes("supabase.co/storage/"))) {
        return;
      }
      setFailedImageIds((prev) => new Set(prev).add(card.id));
      return;
    }
    const cacheKey = `${target.bucket}:${target.path}`;
    if (signedUrlCacheRef.current.has(cacheKey)) {
      setResolvedAttachmentUrls((prev) => {
        if (prev[card.id]) return prev;
        return { ...prev, [card.id]: signedUrlCacheRef.current.get(cacheKey) };
      });
      return;
    }
    let objectNotFound = false;
    try {
      const { data, error } = await supabase.storage
        .from(target.bucket)
        .createSignedUrl(target.path, 60 * 60 * 24 * 7);
      if (data?.signedUrl) {
        signedUrlCacheRef.current.set(cacheKey, data.signedUrl);
        setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
        return;
      }
      if (error) {
        objectNotFound = /not found/i.test(error.message || "");
        if (!objectNotFound) console.warn("[Vault] Signed URL error for", target.path, error.message);
      }
    } catch (err) {
      console.warn("[Vault] Signed URL exception for", target.path, err);
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
              signedUrlCacheRef.current.set(cacheKey, signedUrl);
              setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: signedUrl }));
              return;
            }
          }
        }
      } catch (err) {
        console.warn("[Vault] Server-side signed URL fallback failed for", target.path, err);
      }
    }
    imageRetryCountsRef.current.set(card.id, 99);
    setFailedImageIds((prev) => new Set(prev).add(card.id));
    visibleCardIdsRef.current.delete(card.id);
  }, []);

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
      { rootMargin: "200px" }
    );

    for (const [, el] of cardElementsRef.current) {
      urlResolveObserverRef.current.observe(el);
    }

    return () => {
      urlResolveObserverRef.current?.disconnect();
      urlResolveObserverRef.current = null;
    };
  }, [vaultCards, user?.id, resolveSignedUrlForCard, drainUrlResolveQueue]);

  const eagerResolveRunRef = useRef(false);
  useEffect(() => {
    if (!user?.id || isLoadingNotes || eagerResolveRunRef.current) return;
    if (vaultCards.length === 0) { setVaultReady(true); return; }
    eagerResolveRunRef.current = true;
    const attachmentCards = vaultCards.filter(
      (c) => c.kind === "attachment"
    );
    if (attachmentCards.length === 0) {
      setVaultReady(true);
      return;
    }
    for (const card of attachmentCards) {
      visibleCardIdsRef.current.add(card.id);
      urlResolveQueueRef.current.push(card);
    }
    const safetyTimer = setTimeout(() => setVaultReady(true), 8000);
    drainUrlResolveQueue().then(() => {
      clearTimeout(safetyTimer);
      setVaultReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultCards, user?.id, isLoadingNotes, drainUrlResolveQueue]);

  const visibleCards = useMemo(() => {
    return vaultCards.filter((card) => card.kind !== "chat-preview");
  }, [vaultCards]);

  const initialCardIdsRef = useRef(null);
  if (vaultReady && initialCardIdsRef.current === null) {
    initialCardIdsRef.current = new Set(vaultCards.map((c) => c.id));
  }

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

          const { data: note } = await supabase
            .from("notes")
            .select("content")
            .eq("id", card.noteId)
            .single();
          if (!note?.content) continue;

          const marker = "[ATTACHMENTS_JSON:";
          const start = note.content.indexOf(marker);
          if (start === -1) continue;
          const jsonStart = start + marker.length;
          let bracketCount = 0;
          let jsonEnd = jsonStart;
          for (let i = jsonStart; i < note.content.length; i++) {
            if (note.content[i] === "[") bracketCount++;
            if (note.content[i] === "]") {
              bracketCount--;
              if (bracketCount === 0) { jsonEnd = i + 1; break; }
            }
          }
          if (jsonEnd <= jsonStart) continue;

          let attachments;
          try { attachments = JSON.parse(note.content.slice(jsonStart, jsonEnd)); } catch { continue; }
          if (!Array.isArray(attachments)) continue;

          const attIdx = card.attachmentIndex ?? 0;
          if (attachments[attIdx]) attachments[attIdx].aiDescription = description;

          const updatedContent = note.content.slice(0, start) +
            `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]` +
            note.content.slice(jsonEnd + (note.content[jsonEnd] === "]" ? 1 : 0));

          await supabase.from("notes").update({ content: updatedContent }).eq("id", card.noteId);

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
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.everything) &&
        Array.isArray(parsed.chats)
      ) {
        setOrderByPage({ everything: parsed.everything, chats: parsed.chats });
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
    try { localStorage.setItem("lykn_vault_view", vaultView); } catch {}
  }, [vaultView]);

  const orderedVisibleCards = useMemo(() => {
    const currentOrder = orderByPage.everything || [];
    const visibleMap = new Map(filteredVisibleCards.map((card) => [card.id, card]));
    const ordered = currentOrder.map((id) => visibleMap.get(id)).filter(Boolean);
    const remaining = filteredVisibleCards.filter((card) => !currentOrder.includes(card.id));
    return [...ordered, ...remaining];
  }, [filteredVisibleCards, orderByPage]);

  const tagGroupedCards = useMemo(() => {
    if (vaultView !== "tags") return [];
    const groups = {};
    const untagged = [];
    for (const card of orderedVisibleCards) {
      const tags = card.tags || [];
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
      pdf: "PDFs", spreadsheet: "Spreadsheets", bookmark: "Links", file: "Files",
      instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook",
      "quick-note": "Quick Notes", "chat-preview": "Chats",
    };
    const groups = {};
    for (const card of orderedVisibleCards) {
      const key = card.kind === "attachment" ? (card.type || "file") : card.kind;
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

  const handleCardDragStart = useCallback((e, card) => {
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
      const pendingData = {
        id: card.id,
        title: card.title || "",
        content: "",
        attachments: [{ ...att, url: resolvedForDrag, type: card.type, videoId, ...(pdfText ? { pdfText, extractedText: pdfText } : {}) }],
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
      try { e.dataTransfer.setData("application/x-omnia-vault", JSON.stringify(pendingData)); } catch {}
      try {
        const target = window.parent !== window ? window.parent : window;
        /** @type {any} */ (target).__omnia_pending_vault = pendingData;
      } catch {}
      try {
        window.parent.postMessage({ type: "omnia-vault-drag-start", data: pendingData }, "*");
      } catch {}
      e.dataTransfer.effectAllowed = "copyMove";
    } else if (isEmbeddedMode && card.kind === "quick-note") {
      const pendingData = {
        id: card.id,
        title: card.title || "Quick Note",
        content: card.excerpt || "",
        attachments: [],
        tags: Array.isArray(card.tags) ? card.tags : [],
        timestamp: Date.now(),
      };
      try {
        e.dataTransfer.setData("text/plain", card.excerpt || card.title || "Quick Note");
        e.dataTransfer.setData("application/x-omnia-vault", JSON.stringify(pendingData));
      } catch {}
      try {
        const target = window.parent !== window ? window.parent : window;
        /** @type {any} */ (target).__omnia_pending_vault = pendingData;
      } catch {}
      try {
        window.parent.postMessage({ type: "omnia-vault-drag-start", data: pendingData }, "*");
      } catch {}
      e.dataTransfer.effectAllowed = "copyMove";
    } else {
      e.dataTransfer.effectAllowed = "move";
    }

    setDraggedCardId(card.id);
    lastHoverTargetRef.current = card.id;
    window.dispatchEvent(new CustomEvent("vault_collage_reorder_drag_start"));
    try { e.dataTransfer.setData("application/x-lykins-vault-card-id", card.id); } catch {}
  }, [isEmbeddedMode, resolvedAttachmentUrls]);

  const handleCardDragEnd = useCallback(() => {
    setDraggedCardId(null);
    setDropTargetCardId(null);
    lastHoverTargetRef.current = null;
    window.dispatchEvent(new CustomEvent("vault_collage_reorder_drag_end"));
    if (isEmbeddedMode) {
      try { window.parent.postMessage({ type: "omnia-vault-drag-end" }, "*"); } catch {}
    }
  }, [isEmbeddedMode]);

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
        console.log("[VaultSearch] All items matched locally:", localMatches.length);
        setConceptResultIds(localMatches);
        return;
      }

      const itemSummaries = remaining.map((card) => buildCardSummary(card)).join("\n");

      const prompt = [
        `Search: "${q}"`,
        "",
        `${remaining.length} items. Find anything conceptually related.`,
        "",
        "ITEMS:",
        itemSummaries,
        "",
        'Return ONLY a JSON array of matching IDs. Example: ["id-1","id-2"]',
        "If nothing matches: []",
      ].join("\n");

      const { API_BASE_URL } = await import("@/lib/api-config");
      console.log("[VaultSearch] Local matches:", localMatches.length, "| Sending", remaining.length, "to AI");
      const res = await fetch(`${API_BASE_URL}/api/ai/vault-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      if (searchId !== conceptSearchIdRef.current) return;

      let aiMatchIds = [];
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
        console.warn("[VaultSearch] Server returned", res.status);
      }

      if (searchId !== conceptSearchIdRef.current) return;

      const combined = [...localMatches, ...aiMatchIds];
      console.log("[VaultSearch] Results:", localMatches.length, "local +", aiMatchIds.length, "AI =", combined.length, "total");
      setConceptResultIds(combined);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (searchId !== conceptSearchIdRef.current) return;
      console.error("[VaultSearch] Error:", err);
      setConceptResultIds(null);
    } finally {
      if (searchId === conceptSearchIdRef.current) {
        setIsConceptSearching(false);
      }
    }
  }, [visibleCards, buildCardSummary, getCardSearchText]);

  const handleSaveQuickNote = async () => {
    if (!user?.id || isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;
    if (!(await checkVaultLimit())) return;

    setIsQuickNoteSaving(true);
    try {
      let insertedNote = null;
      let noteError = null;

      ({ data: insertedNote, error: noteError } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: "Quick Note",
          content,
        })
        .select("id, title, content, created_at, updated_at")
        .single());

      if (noteError || !insertedNote?.id) {
        throw noteError || new Error("Unable to save quick note.");
      }

      setQuickNoteContent("");
      setShowQuickNote(false);
      setNotes((prev) => [insertedNote, ...prev]);
      incrementVaultCount();
    } catch (error) {
      setNotesError("Couldn't save your note. Please try again.");
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

  const handleUnfurlLink = useCallback(async (rawUrl) => {
    const url = String(rawUrl || "").trim();
    if (!url) return;
    setIsSaveLinkLoading(true);
    setSaveLinkPreview(null);
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error("Unfurl failed");
      const data = await res.json();
      setSaveLinkPreview(data);
    } catch {
      setSaveLinkPreview({ url, title: url, description: "", image: "", siteName: "", favicon: "", articleText: "", _error: true });
    } finally {
      setIsSaveLinkLoading(false);
    }
  }, []);

  const handleSaveLink = useCallback(async () => {
    if (!user?.id || isSaveLinkSaving || !saveLinkPreview) return;
    if (!(await checkVaultLimit())) return;
    setIsSaveLinkSaving(true);
    try {
      const attachment = [{
        type: "bookmark",
        url: saveLinkPreview.url || saveLinkUrl,
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
        .from("notes")
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
      }
      setShowSaveLink(false);
      setSaveLinkUrl("");
      setSaveLinkPreview(null);
    } catch (err) {
      setNotesError("Couldn't save the link. Please try again.");
    } finally {
      setIsSaveLinkSaving(false);
    }
  }, [user?.id, isSaveLinkSaving, saveLinkPreview, saveLinkUrl, checkVaultLimit, incrementVaultCount]);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;

    chatUserScrolledUpRef.current = false;
    setChatInput("");
    setIsChatLoading(true);
    const asstId = `msg-${Date.now()}`;
    setChatMessages((prev) => {
      const idx = prev.length + 1;
      assistantIndexRef.current = idx;
      return [...prev, { role: "user", content: text }, { role: "assistant", content: "", id: asstId }];
    });

    try {
      const history = chatMessages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const memoryText = user?.id ? await getMemoryForPrompt(user.id) : "";

      const vaultItems = orderedVisibleCards.slice(0, 40).map((card) => {
        const date = card.dateLabel || "unknown date";
        const tagStr = card.tags?.length ? ` [tags: ${card.tags.join(", ")}]` : "";
        const nid = card.noteId ? ` {noteId:${card.noteId}}` : "";
        if (card.kind === "attachment") {
          const att = card.attachment || {};
          const type = (card.type || "file").toUpperCase();
          const name = card.title || att.name || "Untitled file";
          const extras = [];
          if (card.parentTitle && card.parentTitle !== name && card.parentTitle !== "Untitled note") {
            extras.push(`From note: "${card.parentTitle}"`);
          }
          if (card.noteExcerpt) extras.push(`Note context: ${card.noteExcerpt.slice(0, 300)}`);
          if (att.aiDescription) extras.push(`Visual: ${String(att.aiDescription).slice(0, 300)}`);
          if (att.extractedText) extras.push(`Content: ${String(att.extractedText).slice(0, 500)}`);
          if (att.description) extras.push(`Desc: ${String(att.description).slice(0, 250)}`);
          if (att.articleText) extras.push(`Article: ${String(att.articleText).slice(0, 500)}`);
          if (att.siteName) extras.push(`Site: ${att.siteName}`);
          if (att.url) extras.push(`URL: ${att.url}`);
          const fileNotes = parseAttachmentNotes(att);
          if (fileNotes.length > 0) extras.push(`User notes (context on why they saved this): ${fileNotes.map((n) => n.text).join(" | ").slice(0, 400)}`);
          return `[${type}]${nid} "${name}" (${date})${tagStr}${extras.length ? " — " + extras.join(" | ") : ""}`;
        }
        if (card.kind === "quick-note") {
          return `[NOTE]${nid} "${card.title || "Quick Note"}" — ${(card.excerpt || "").slice(0, 500)} (${date})${tagStr}`;
        }
        if (card.kind === "chat-preview") {
          const q = (card.question || "").slice(0, 250);
          const a = (card.answer || "").slice(0, 250);
          return `[CHAT]${nid} "${card.title || "AI Chat"}" — Q: ${q}${a ? ` A: ${a}` : ""} (${date})${tagStr}`;
        }
        return `[ITEM]${nid} "${card.title || "Untitled"}" (${date})${tagStr}`;
      }).join("\n");

      const totalCount = orderedVisibleCards.length;
      const existingTags = allTags.map((t) => t.name);
      const existingTagStr = existingTags.length ? existingTags.join(", ") : "(none yet)";

      const tagDirLines = [];
      if (allTags.length > 0) {
        const tagToCards = {};
        orderedVisibleCards.forEach((card) => {
          (card.tags || []).forEach((t) => {
            const tag = String(t).trim();
            if (!tag) return;
            if (!tagToCards[tag]) tagToCards[tag] = [];
            tagToCards[tag].push({ noteId: card.noteId, title: String(card.title || "Untitled").slice(0, 60) });
          });
        });
        const sorted = Object.entries(tagToCards).sort((a, b) => b[1].length - a[1].length);
        for (const [tag, items] of sorted) {
          const refs = items.slice(0, 8).map((n) => `"${n.title}" {noteId:${n.noteId}}`).join(", ");
          const overflow = items.length > 8 ? ` +${items.length - 8} more` : "";
          tagDirLines.push(`#${tag} (${items.length}): ${refs}${overflow}`);
        }
      }
      const tagDirBlock = tagDirLines.length
        ? `\nTAG DIRECTORY — every tag with its items:\n${tagDirLines.join("\n")}\n`
        : "";

      const prompt = `You are the Vault Assistant — the AI helper inside The Vault, a personal collection space within LYKN where users save and organise their files, images, videos, links, notes, and ideas.

YOUR ROLE:
- Help the user find, understand, and organise what's in their Vault.
- Answer questions about their saved content — summarise notes, describe files, spot themes, draw connections between items.
- Help them brainstorm, expand on ideas captured in their notes, and suggest how to organise or tag things.
- Be conversational, concise, and helpful. Speak naturally.
- When the user asks you to organise, tag, or categorise their vault items, you can ACTUALLY DO IT — not just suggest. Use TAG_ACTIONS (described below) to apply changes directly.

WHAT YOU CAN SEE:
Below is the user's Vault content (${totalCount} items total, showing up to 40). Each item has a type tag: NOTE (text notes), IMAGE/VIDEO/AUDIO/PDF/DOC/YOUTUBE (media files), CHAT (saved AI conversations), LINK (saved URLs). Items may also have [tags: ...] which are user-created labels, and "User notes" which are personal annotations the user wrote about why they saved something.
Each item has a {noteId:...} identifier you can reference when applying tag actions.

EXISTING TAGS IN USE: ${existingTagStr}
${tagDirBlock}
=== VAULT CONTENTS ===
${vaultItems || "(The Vault is empty)"}
=== END VAULT CONTENTS ===

TAG ACTIONS — ORGANISING THE VAULT:
When the user asks you to organise, tag, categorise, or auto-tag their vault items, you can apply tags directly. To do this, include a TAG_ACTIONS block at the END of your response (after your conversational message). Format:

[TAG_ACTIONS]
{"actions":[{"noteId":"<id>","tags":["tag1","tag2"]},...]}
[/TAG_ACTIONS]

Rules for TAG_ACTIONS:
- "tags" is the COMPLETE new tag list for that note (replaces existing tags). Include any existing tags you want to keep.
- Only include TAG_ACTIONS when the user explicitly asks you to organise, tag, auto-tag, or categorise items. Don't add tags unprompted.
- Re-use existing tags (listed above) when they fit before creating new ones.
- Keep tag names short, lowercase, and descriptive (e.g. "design", "travel", "work", "inspiration").
- You can tag as many or as few items as makes sense.
- Briefly explain in your message what you're tagging and why, so the user knows what's happening.
- If the user says something like "organise my vault", "auto-tag everything", "categorise these", or "tag my stuff", that IS permission to apply tags.

GUIDELINES:
- When the user asks "what do I have about X" or "find my notes on Y", search through the vault contents above and answer from them. Think conceptually — match by theme, topic, and meaning, not just keywords.
- Pay special attention to tags and user notes — these reveal the user's intent and how they think about their content. A file tagged "inspiration" with a note "use this style for the rebrand" tells you far more than the filename alone.
- When searching, treat user notes as high-signal context. They explain WHY the user saved something and what it means to them.
- Use tags to understand groupings and themes the user has already established. If they ask about a topic, check if any tags relate to it.
- When asked to help organise, suggest groupings, themes, or connections you notice across their items. Reference existing tags and notes to ground your suggestions — and use TAG_ACTIONS to actually apply the changes.
- If the user asks about something not in their Vault, you can still help — just be clear you're giving general knowledge rather than referencing their saved content.
- Never say you can't see or access their Vault. The contents are right above.
- Reference specific items by name when relevant.
- When the user asks to find things by concept or idea (e.g. "anything about creativity", "stuff related to travel", "ideas about productivity"), look for thematic and conceptual connections across ALL vault items — don't limit to exact keyword matches. Group and present the results clearly.

Conversation so far:
${history || "(none)"}
${memoryText ? `\n[CONVERSATION MEMORY — your past exchanges with this user across all surfaces]\n${memoryText}` : ""}

User: ${text}`;

      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, prompt, ...getAiPrefs() }),
      });
      if (!res.ok) throw new Error("AI request failed");
      const data = await res.json().catch(() => ({}));
      const rawAiText = String(data.response || "").trim();

      const { cleanText: aiText, actions: tagActions } = parseTagActions(rawAiText);

      const idx = assistantIndexRef.current;
      if (idx == null) return;

      if (tagActions.length > 0) {
        let applied = 0;
        const noteIdSet = new Set(notes.map((n) => String(n.id)));
        for (const action of tagActions) {
          if (noteIdSet.has(String(action.noteId))) {
            await updateNoteTags(String(action.noteId), action.tags);
            applied += 1;
          }
        }
        const newTagNames = [...new Set(tagActions.flatMap((a) => a.tags))];
        const tagSummary = applied > 0
          ? `\n\n---\n✅ **Tagged ${applied} item${applied !== 1 ? "s" : ""}** with: ${newTagNames.map((t) => `\`${t}\``).join(", ")}`
          : "";
        const fullText = aiText + tagSummary;

        const words = fullText.split(" ").filter(Boolean);
        if (words.length === 0) {
          setChatMessages((prev) => {
            const next = prev.slice();
            if (next[idx]) next[idx] = { ...next[idx], content: fullText, tagActions: { applied, tags: newTagNames } };
            return next;
          });
        } else {
          let i = 0;
          let current = "";
          const tick = () => {
            current += (i === 0 ? "" : " ") + words[i];
            i += 1;
            const done = i >= words.length;
            setChatMessages((prev) => {
              const next = prev.slice();
              if (next[idx]) next[idx] = { ...next[idx], content: current, ...(done ? { tagActions: { applied, tags: newTagNames } } : {}) };
              return next;
            });
            if (!chatUserScrolledUpRef.current) {
              const el = chatScrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }
            if (!done) window.setTimeout(tick, 18);
          };
          tick();
        }
      } else {
        const words = aiText.split(" ").filter(Boolean);
        if (words.length === 0) {
          setChatMessages((prev) => {
            const next = prev.slice();
            if (next[idx]) next[idx] = { ...next[idx], content: aiText };
            return next;
          });
        } else {
          let i = 0;
          let current = "";
          const tick = () => {
            current += (i === 0 ? "" : " ") + words[i];
            i += 1;
            setChatMessages((prev) => {
              const next = prev.slice();
              if (next[idx]) next[idx] = { ...next[idx], content: current };
              return next;
            });
            if (!chatUserScrolledUpRef.current) {
              const el = chatScrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }
            if (i < words.length) window.setTimeout(tick, 18);
          };
          tick();
        }
      }
      if (user?.id) { invalidateMemoryCache(); saveExchange(user.id, "vault", null, null, text, aiText); }
    } catch {
      const idx = assistantIndexRef.current;
      if (idx != null) {
        setChatMessages((prev) => {
          const next = prev.slice();
          if (next[idx]) next[idx] = { ...next[idx], content: "This model isn\u2019t working properly right now \u2014 try another model." };
          return next;
        });
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const renderAttachmentCard = (card, tileHeightClass) => {
    const { attachment, type, title } = card;
    const resolvedUrl = resolvedAttachmentUrls[card.id] || attachment.url;

    if (type === "image") {
      const storageTarget = parseStorageTarget(attachment || {});
      const isStorageBacked = !!(storageTarget?.bucket && storageTarget?.path);
      const hasResolvedUrl = !!resolvedAttachmentUrls[card.id];
      const hasFailed = failedImageIds.has(card.id);

      if (isStorageBacked && !hasResolvedUrl && !hasFailed) {
        return (
          <div className={`w-full ${tileHeightClass || "h-44"} rounded-2xl bg-white/5 animate-pulse flex items-center justify-center`}>
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      if (hasFailed) {
        return (
          <div className={`w-full ${tileHeightClass || "h-44"} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}>
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

      return (
        <img
          key={resolvedUrl}
          src={resolvedUrl}
          alt={title}
          className="w-full h-auto max-h-[42rem] rounded-2xl"
          loading="lazy"
          draggable={false}
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
                  try {
                    const { data } = await supabase.storage
                      .from(target.bucket)
                      .createSignedUrl(target.path, 60 * 60 * 24 * 7);
                    if (data?.signedUrl) {
                      signedUrlCacheRef.current.set(cacheKey, data.signedUrl);
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
                          signedUrlCacheRef.current.set(cacheKey, signedUrl);
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
      );
    }

    if (type === "video") {
      const videoMime = attachment.mimeType || "video/mp4";
      const videoStorageTarget = parseStorageTarget(attachment || {});
      const videoIsStorageBacked = !!(videoStorageTarget?.bucket && videoStorageTarget?.path);

      if (videoIsStorageBacked && !resolvedAttachmentUrls[card.id]) {
        return (
          <div className={`w-full ${tileHeightClass || "h-44"} rounded-2xl bg-black/10 animate-pulse flex items-center justify-center`}>
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      return (
        <video
          key={resolvedUrl}
          className="w-full h-auto max-h-[42rem] rounded-2xl bg-black/10"
          controls
          playsInline
          preload="metadata"
          draggable={false}
        >
          <source src={resolvedUrl} type={videoMime} />
        </video>
      );
    }

    if (type === "audio") {
      return (
        <div className="p-3 space-y-3 rounded-2xl">
          <div className="flex items-center gap-2 text-black/80 dark:text-white/80">
            <Music className="w-4 h-4" />
            <span className="text-xs font-medium truncate">{title}</span>
          </div>
          <audio src={resolvedUrl} controls className="w-full h-10" preload="metadata" />
        </div>
      );
    }

    if (type === "pdf") {
      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-white/20`}>
          <iframe
            src={resolvedUrl}
            title={title || "PDF preview"}
            className="w-full h-full border-0"
            draggable={false}
          />
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
            compact={isEmbeddedMode}
          />
        </div>
      );
    }

    if (type === "youtube") {
      const videoId = extractYouTubeVideoId(String(attachment.url || "")) || String(attachment.videoId || "").trim() || null;
      const embedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";

      if (isEmbeddedMode && videoId) {
        const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
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
        return (
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
            title="Open YouTube video"
            draggable={false}
          >
            <div className="flex items-start gap-2 h-full">
              <Video className="w-4 h-4 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
                <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1 truncate">{attachment.url}</p>
              </div>
            </div>
          </a>
        );
      }

      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black`} draggable={false}>
          <iframe
            src={embedUrl}
            title={title || "YouTube video"}
            className="w-full h-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      );
    }

    if (type === "bookmark") {
      const linkUrl = attachment.url || resolvedUrl || "";
      const domain = attachment.siteName || (() => { try { return new URL(linkUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      const displayTitle = attachment.title || title || linkUrl;
      const desc = String(attachment.description || "").slice(0, 200);
      const hasImage = Boolean(attachment.image);
      const isTweet = attachment.oembedType === "twitter" && desc;

      if (isTweet) {
        return (
          <a
            href={linkUrl}
            target="_blank"
            rel="noreferrer"
            className="block rounded-2xl overflow-hidden border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-md hover:bg-white/40 dark:hover:bg-white/10 transition-colors group/bm"
            draggable={false}
          >
            <div className="p-4 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 fill-current text-black/70 dark:text-white/70" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-black/85 dark:text-white/85 truncate block leading-tight">{attachment.authorName || displayTitle}</span>
                  {attachment.authorHandle && <span className="text-[0.625rem] text-black/45 dark:text-white/45 truncate block leading-tight">{attachment.authorHandle}</span>}
                </div>
                <ExternalLink className="w-3 h-3 opacity-0 group-hover/bm:opacity-60 transition-opacity shrink-0" />
              </div>
              <p className="text-[13px] text-black/75 dark:text-white/75 leading-relaxed whitespace-pre-line line-clamp-6">{desc}</p>
              <div className="flex items-center gap-1.5 text-black/35 dark:text-white/35 pt-1.5 border-t border-black/8 dark:border-white/8">
                <span className="text-[0.6rem]">X (Twitter)</span>
              </div>
            </div>
          </a>
        );
      }

      return (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="block rounded-2xl overflow-hidden border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-md hover:bg-white/40 dark:hover:bg-white/10 transition-colors group/bm"
          draggable={false}
        >
          {hasImage && (
            <div className="w-full h-36 overflow-hidden bg-black/5">
              <img
                src={attachment.image}
                alt=""
                className="w-full h-full object-cover group-hover/bm:scale-[1.03] transition-transform duration-300"
                loading="lazy"
                draggable={false}
                onError={(e) => { e.currentTarget.parentElement.style.display = "none"; }}
              />
            </div>
          )}
          <div className="p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
              {attachment.favicon ? (
                <img src={attachment.favicon} alt="" className="w-3.5 h-3.5 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none"; }} />
              ) : (
                <Globe className="w-3.5 h-3.5" />
              )}
              <span className="text-[0.625rem] font-medium truncate">{domain}</span>
              <ExternalLink className="w-2.5 h-2.5 ml-auto opacity-0 group-hover/bm:opacity-100 transition-opacity" />
            </div>
            <p className="text-sm font-semibold text-black/85 dark:text-white/85 leading-snug line-clamp-2">{displayTitle}</p>
            {desc && <p className="text-xs text-black/55 dark:text-white/55 leading-relaxed line-clamp-3">{desc}</p>}
            {!hasImage && !desc && linkUrl && (
              <p className="text-xs text-black/40 dark:text-white/40 truncate">{linkUrl}</p>
            )}
          </div>
        </a>
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
      return (
        <a
          href={resolvedUrl}
          target="_blank"
          rel="noreferrer"
          className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
          title={`Open ${type.toUpperCase()} file`}
          draggable={false}
        >
          <div className="flex items-start gap-2 h-full">
            <FileText className="w-4 h-4 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
              <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">{type.toUpperCase()} file</p>
            </div>
          </div>
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
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length || attachments.length <= 1) {
        await supabase.from("notes").delete().eq("id", card.noteId).eq("user_id", user.id);
        purgeVaultNoteEmbeddings(card.noteId);
        setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
      } else {
        const nextAttachments = attachments.filter((_, i) => i !== idx);
        const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);
        const nextAttachmentsString = JSON.stringify(nextAttachments);
        let updateError = null;
        ({ error: updateError } = await supabase
          .from("notes")
          .update({
            content: nextContent,
            attachments: nextAttachmentsString,
            updated_at: new Date().toISOString(),
          })
          .eq("id", card.noteId)
          .eq("user_id", user.id));
        if (
          updateError &&
          (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist"))
        ) {
          ({ error: updateError } = await supabase
            .from("notes")
            .update({
              content: nextContent,
              updated_at: new Date().toISOString(),
            })
            .eq("id", card.noteId)
            .eq("user_id", user.id));
        }
        if (!updateError) {
          setNotes((prev) =>
            prev.map((n) =>
              String(n?.id) === String(card.noteId)
                ? { ...n, content: nextContent, attachments: nextAttachmentsString, updated_at: new Date().toISOString() }
                : n
            )
          );
        }
      }

      removeCardFromProjects(card);

      const storageTarget = parseStorageTarget(card.attachment || {});
      if (storageTarget?.bucket && storageTarget?.path) {
        await supabase.storage.from(storageTarget.bucket).remove([storageTarget.path]);
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
      await supabase.from("notes").delete().eq("id", card.noteId).eq("user_id", user.id);
      purgeVaultNoteEmbeddings(card.noteId);
      setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
      removeCardFromProjects(card);
      setOpenCardMenuId(null);
    } finally {
      setIsCardActionBusy(false);
    }
  }, [user?.id, removeCardFromProjects]);

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
      alert(`Added to project: ${project.name}`);
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
        .from("omnia_projects")
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
      alert(`Created project "${project.name}" and added this file.`);
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
      const nextAttachmentsString = JSON.stringify(nextAttachments);

      let updateError = null;
      ({ error: updateError } = await supabase
        .from("notes")
        .update({
          content: nextContent,
          attachments: nextAttachmentsString,
          updated_at: new Date().toISOString(),
        })
        .eq("id", card.noteId)
        .eq("user_id", user.id));

      if (
        updateError &&
        (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist"))
      ) {
        ({ error: updateError } = await supabase
          .from("notes")
          .update({
            content: nextContent,
            updated_at: new Date().toISOString(),
          })
          .eq("id", card.noteId)
          .eq("user_id", user.id));
      }

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, attachments: nextAttachmentsString, updated_at: new Date().toISOString() }
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


  const confirmAndDeleteAttachment = useCallback((card) => {
    if (!card) return;
    const label = String(card?.title || "this file");
    const ok = window.confirm(`Are you sure you want to delete "${label}"? This cannot be undone.`);
    if (!ok) return;
    void removeAttachmentFromNote(card);
  }, [removeAttachmentFromNote]);


  const openCardMenuForAnchor = useCallback((cardId, anchorEl) => {
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
  }, []);

  if ((loading || isLoadingNotes || !vaultReady) && user) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div className={`min-h-screen bg-transparent text-black dark:text-white relative overflow-x-hidden`}>
      <DragDropFileUpload
        triggerRef={addMediaTriggerRef}
        beforeUpload={checkVaultLimit}
        onUploadComplete={(payload) => {
          const createdNotes = Array.isArray(payload?.createdNotes) ? payload.createdNotes : [];
          if (createdNotes.length > 0) {
            mergeUploadedNotes(createdNotes);
            return;
          }
          void refreshNotes();
        }}
      />

      {!isEmbeddedMode && (
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTopPanelOpen((v) => !v)}
            className="rounded-full w-9 h-9 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
          </button>

          {topPanelOpen && (
            <div className="flex items-center gap-1 p-1 rounded-full glass-control flex-wrap">
              <Select
                value={selectedModel}
                onValueChange={(value) => {
                  setSelectedModel(value);
                  try {
                    const saved = localStorage.getItem("lykinsai_settings");
                    const settings = saved ? JSON.parse(saved) : {};
                    settings.aiModel = value;
                    localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                    window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                  } catch {
                    // ignore
                  }
                }}
              >
                <SelectTrigger className="w-[100px] sm:w-[124px] !h-7 rounded-full glass-control hover:opacity-90 text-[0.6875rem] font-medium px-2">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md overflow-hidden"
                >
                  <SelectGroup>
                    <SelectLabel>Latest</SelectLabel>
                    <SelectItem value="claude-sonnet-4-6" hint="Anthropic flagship">Claude Sonnet 4.6</SelectItem>
                    <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                    <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                    <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Fastest</SelectLabel>
                    <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                    <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                    <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                    <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                    <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                    <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                    <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                    <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Cheap</SelectLabel>
                    <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                    <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                    <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Image Gen</SelectLabel>
                    <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                    <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                    <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                    <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Deep Thinking</SelectLabel>
                    <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                    <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                    <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                    <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                    <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                    <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                    <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Code</SelectLabel>
                    <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                    <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                    <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                    <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>General</SelectLabel>
                    <SelectItem value="gpt-5.2" hint="OpenAI, previous gen">GPT-5.2</SelectItem>
                    <SelectItem value="gpt-5.1" hint="OpenAI, previous gen">GPT-5.1</SelectItem>
                    <SelectItem value="gpt-5" hint="OpenAI, previous gen">GPT-5</SelectItem>
                    <SelectItem value="gpt-4o" hint="OpenAI, versatile">GPT-4o</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514" hint="Anthropic, balanced">Claude Sonnet 4</SelectItem>
                    <SelectItem value="grok-4-fast-non-reasoning" hint="xAI, general">Grok 4 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-4-0709" hint="xAI, general">Grok 4 0709</SelectItem>
                    <SelectItem value="grok-3" hint="xAI, previous gen">Grok 3</SelectItem>
                    <SelectItem value="grok-2-vision-1212" hint="xAI, vision">Grok 2 Vision</SelectItem>
                    <SelectItem value="unified-auto" hint="Auto-picks best">Unified AI (Auto)</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowChat((v) => !v)}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${showChat ? "bg-blue-500/15" : ""}`}
                title={showChat ? "Hide chat" : "Open chat"}
              >
                <MessageSquare className={`w-4 h-4 ${showChat ? "text-blue-500" : ""}`} />
              </button>

              <button
                type="button"
                onClick={() => setShowQuickNote((v) => !v)}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${showQuickNote ? "bg-amber-500/15" : ""}`}
                title={showQuickNote ? "Hide quick note" : "New quick note"}
              >
                <StickyNote className={`w-4 h-4 ${showQuickNote ? "text-amber-500" : ""}`} />
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      <main
        className={`relative z-20 mx-auto w-full px-4 sm:px-6 lg:px-8 ${isEmbeddedMode ? "pt-6" : "pt-24"} pb-16 transition-[margin-right,max-width] duration-300`}
        style={{ transform: "translateZ(0)", marginRight: showChat && !isMobileChat ? `${chatRailWidthPx}px` : 0, maxWidth: showChat && !isMobileChat ? `calc(100% - ${chatRailWidthPx}px)` : "1560px" }}
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
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={embeddedSearch}
                  onChange={(e) => setEmbeddedSearch(e.target.value)}
                  placeholder="Search memories..."
                  className="flex-1 h-10 rounded-xl border border-black/8 dark:border-white/8 bg-white/55 dark:bg-white/4 px-3 text-sm outline-none"
                />
                <div className="flex items-center rounded-xl glass-control p-0.5 gap-0.5 shrink-0">
                  {[
                    { id: "collage", icon: Layers, label: "Collage" },
                    { id: "grid", icon: Grid3X3, label: "Grid" },
                    { id: "tags", icon: Tag, label: "Tags" },
                    { id: "type", icon: LayoutGrid, label: "Type" },
                  ].map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setVaultView(v.id)}
                      className={`flex items-center justify-center w-8 h-8 rounded-lg text-[0.6875rem] font-medium transition-all ${
                        vaultView === v.id
                          ? "bg-blue-500 text-white shadow-sm"
                          : "text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      }`}
                      title={v.label}
                    >
                      <v.icon className="w-3.5 h-3.5" />
                    </button>
                  ))}
                </div>
              </div>
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
                    <div className="absolute top-full left-0 mt-1 w-52 max-h-56 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1e]/80 backdrop-blur-md shadow-md z-50 py-1 scrollbar-hide">
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
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${untaggedActive ? "bg-blue-500 text-white" : "border border-black/20 dark:border-white/20"}`}>
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
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${active ? "bg-blue-500 text-white" : "border border-black/20 dark:border-white/20"}`}>
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
          ) : (
            <>
              <h1 className="text-3xl font-semibold">The Vault</h1>
              <p className="text-black/60 dark:text-white/60 mt-1">
                Your digital collage of media files, videos, images, and quick notes. Drag and drop files or folders anywhere on this page.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
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
                    placeholder="Search your vault — type an idea, topic, or keyword and press Enter"
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

                <div className="flex items-center rounded-xl glass-control p-0.5 gap-0.5 shrink-0 w-full sm:w-auto">
                  {[
                    { id: "collage", icon: Layers, label: "Collage" },
                    { id: "grid", icon: Grid3X3, label: "Grid" },
                    { id: "tags", icon: Tag, label: "Tags" },
                    { id: "type", icon: LayoutGrid, label: "Type" },
                  ].map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setVaultView(v.id)}
                      className={`flex-1 sm:flex-initial flex items-center justify-center sm:justify-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium transition-all ${
                        vaultView === v.id
                          ? "bg-blue-500 text-white shadow-sm"
                          : "text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      }`}
                      title={v.label}
                    >
                      <v.icon className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{v.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              {isConceptSearching && (
                <p className="mt-2 text-xs text-black/40 dark:text-white/40">Reading through your vault...</p>
              )}
              {conceptResultIds !== null && !isConceptSearching && (
                <div className="mt-2 flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
                  <span>
                    {conceptResultIds.length === 0
                      ? "Nothing in your vault matches that"
                      : `Found ${conceptResultIds.length} related item${conceptResultIds.length === 1 ? "" : "s"}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setVaultSearch(""); setConceptResultIds(null); }}
                    className="text-blue-500 hover:text-blue-600"
                  >
                    Show all
                  </button>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2" style={{ minHeight: 1, transform: "translateZ(0)" }}>
                {allTags.length > 0 && (
                  <>
                    <Tag className="w-3.5 h-3.5 text-black/35 dark:text-white/35 shrink-0" />
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
                          className={`inline-flex items-center gap-1 rounded-full font-medium transition-all ${
                            active
                              ? "bg-blue-500 text-white shadow-sm"
                              : "glass-control text-black/65 dark:text-white/65 hover:text-black/85 dark:hover:text-white/85"
                          }`}
                          style={{ fontSize: 11, lineHeight: 1, height: 22, paddingLeft: 8, paddingRight: 8 }}
                        >
                          {tag.name}
                          <span className={`text-[0.625rem] ${active ? "text-white/70" : "text-black/35 dark:text-white/35"}`}>
                            {tag.count}
                          </span>
                        </button>
                      );
                    })}
                    {selectedFilterTags.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedFilterTags([])}
                        className="text-[0.6875rem] text-blue-500 hover:text-blue-600 ml-1"
                      >
                        Clear filters
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>

        {!user && !loading && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-black/70 dark:text-white/70">Sign in to view your vault.</p>
          </div>
        )}

        {notesError && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-red-600">{notesError}</p>
          </div>
        )}

        {!loading && !isLoadingNotes && vaultReady && user && !notesError && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35, ease: "easeOut" }}>
            {orderedVisibleCards.length === 0 ? (
              <div className="flex flex-col items-start gap-4">
                <div className="break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 p-6 flex flex-col items-center justify-center text-center w-full sm:w-64 min-h-[160px] gap-3">
                  <div className="text-sm font-medium text-black/40 dark:text-white/40 mb-1">Add to Vault</div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => addMediaTriggerRef.current?.()}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Upload className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Upload Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSaveLink(true)}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Globe className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Save Link</span>
                    </button>
                  </div>
                </div>
                {embeddedSearch.trim() && (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70 dark:text-white/70">No results match your search.</p>
                  </div>
                )}
              </div>
            ) : vaultView === "tags" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={() => addMediaTriggerRef.current?.()} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={() => setShowSaveLink(true)} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
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
                      {cards.map((card) => (
                        <motion.article
                          initial={initialCardIdsRef.current?.has(card.id) ? false : { opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.15 }}
                          key={`${tagName}-${card.id}`}
                          data-vault-card-id={card.id}
                          data-card-id={card.id}
                          ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                          draggable
                          onDragStart={(e) => handleCardDragStart(e, card)}
                          onDragEnd={handleCardDragEnd}
                          className={`rounded-2xl relative overflow-hidden cursor-grab ${
                            card.kind === "attachment" || card.kind === "quick-note"
                              ? "bg-transparent border-0 shadow-none"
                              : "glass-control"
                          }`}
                        >
                          {card.kind === "attachment" ? (
                            <>
                              {renderAttachmentCard(card, "h-40")}
                              {card.tags?.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1 px-1">
                                  {card.tags.map((t) => (
                                    <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[7px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">{t}</span>
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
                                  <StickyNote className="w-3.5 h-3.5" />
                                  <span className="text-[0.625rem] font-medium">Quick Note</span>
                                </div>
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
                                  title="Quick note actions"
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
                      ))}
                    </div>
                  </div>
                ))}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : vaultView === "type" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={() => addMediaTriggerRef.current?.()} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={() => setShowSaveLink(true)} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
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
                        {cards.map((card) => (
                          <motion.article
                            initial={initialCardIdsRef.current?.has(card.id) ? false : { opacity: 0, scale: 0.97 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.15 }}
                            key={`${typeName}-${card.id}`}
                            data-vault-card-id={card.id}
                            data-card-id={card.id}
                            ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                            draggable
                            onDragStart={(e) => handleCardDragStart(e, card)}
                            onDragEnd={handleCardDragEnd}
                            className={`rounded-2xl relative overflow-hidden cursor-grab ${
                              card.kind === "attachment" || card.kind === "quick-note"
                                ? "bg-transparent border-0 shadow-none"
                                : "glass-control"
                            }`}
                          >
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
                                    <StickyNote className="w-3.5 h-3.5" />
                                    <span className="text-[0.625rem] font-medium">Quick Note</span>
                                  </div>
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
                                    title="Quick note actions"
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
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : (
              <div className={
                isEmbeddedMode
                  ? vaultView === "grid"
                    ? "grid grid-cols-2 gap-3"
                    : "columns-2 gap-3"
                  : vaultView === "grid"
                    ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"
                    : "columns-1 sm:columns-2 md:columns-3 xl:columns-4 2xl:columns-5 gap-4 md:gap-5"
              }>
                {vaultView === "collage" && (
                <div className="break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[130px] gap-2">
                  <div className="text-xs font-medium text-black/40 dark:text-white/40">Add to Vault</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => addMediaTriggerRef.current?.()}
                      className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Upload className="w-4 h-4 text-blue-500" />
                      </div>
                      <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSaveLink(true)}
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
                {vaultView === "grid" && (
                  <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center aspect-square gap-2">
                    <div className="text-xs font-medium text-black/40 dark:text-white/40">Add</div>
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => addMediaTriggerRef.current?.()} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                        <Upload className="w-3.5 h-3.5 text-blue-500" />
                      </button>
                      <button type="button" onClick={() => setShowSaveLink(true)} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                        <Globe className="w-3.5 h-3.5 text-blue-500" />
                      </button>
                    </div>
                  </div>
                )}
                {orderedVisibleCards.map((card) => (
                  <motion.article
                    initial={initialCardIdsRef.current?.has(card.id) ? false : { opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    key={card.id}
                    data-vault-card-id={card.id}
                    data-card-id={card.id}
                    ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                    draggable
                    onDragStart={(e) => handleCardDragStart(e, card)}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      if (!draggedCardId || draggedCardId === card.id) return;
                      if (lastHoverTargetRef.current === card.id) return;
                      lastHoverTargetRef.current = card.id;
                      setDropTargetCardId(card.id);
                      // Live reorder on enter to create "push cards around" behavior.
                      reorderActivePage(draggedCardId, card.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropTargetCardId(card.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
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
                    className={`${vaultView === "grid" ? "" : "break-inside-avoid"} ${isEmbeddedMode ? "mb-0" : vaultView === "grid" ? "" : "mb-5"} rounded-2xl relative ${
                      card.kind === "chat-preview" ? "overflow-hidden" : vaultView === "grid" ? "overflow-hidden" : "overflow-visible"
                    } ${
                      card.kind === "attachment" || card.kind === "quick-note"
                        ? "bg-transparent border-0 shadow-none backdrop-blur-0"
                        : "glass-control"
                    } ${
                      draggedCardId === card.id
                        ? "opacity-30 cursor-grabbing ring-2 ring-blue-400/50"
                        : "cursor-grab"
                    } ${dropTargetCardId === card.id && draggedCardId !== card.id ? "ring-2 ring-blue-400/40" : ""} ${
                      card.kind === "attachment" && card.type === "youtube"
                        ? getYouTubeOffsetClass(card.id)
                        : ""
                    } ${
                      openAttachmentNotesCardId === card.id
                        ? "z-[310]"
                        : "z-0"
                    }`}
                  >
                    {card.kind === "attachment" ? (
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
                              setOpenAttachmentNotesCardId((prev) => (prev === card.id ? null : card.id));
                            }}
                            className="absolute top-2 right-2 h-6 min-w-6 px-1.5 rounded-full bg-white/45 backdrop-blur-sm border border-white/30 text-[0.6875rem] font-semibold text-black flex items-center justify-center gap-1 z-[125] shadow-sm"
                            title="View file notes"
                          >
                            <MessageSquare className="w-3 h-3 text-black" />
                            <span>{parseAttachmentNotes(card.attachment).length}</span>
                          </button>
                        )}
                        {card.tags?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1 px-1" data-no-drag="true">
                            {card.tags.map((t) => (
                              <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[7px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="mt-2 flex justify-end px-1" data-no-drag="true">
                          <div className="relative" ref={openAttachmentNotesCardId === card.id ? noteComposerRef : null}>
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
                            {openAttachmentNotesCardId === card.id && (
                              <div
                                className="absolute right-0 bottom-full mb-2 w-64 rounded-2xl border border-white/30 dark:border-white/10 bg-white/60 dark:bg-gray-900/65 backdrop-blur-md shadow-lg p-3 z-[140]"
                                data-no-drag="true"
                                draggable={false}
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <div className="text-[0.6875rem] font-medium text-black/60 dark:text-white/60 mb-2">Add a note</div>
                                <textarea
                                  value={attachmentNoteDraft}
                                  onChange={(e) => setAttachmentNoteDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey && attachmentNoteDraft.trim()) {
                                      e.preventDefault();
                                      void addAttachmentNote(card, attachmentNoteDraft);
                                      setAttachmentNoteDraft("");
                                      setOpenAttachmentNotesCardId(null);
                                    }
                                  }}
                                  placeholder="Write a note about this file…"
                                  className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/45 dark:bg-white/4 px-2.5 py-2 text-xs outline-none resize-none placeholder:text-black/40 dark:placeholder:text-white/40"
                                  rows={3}
                                  autoFocus
                                />
                                <div className="flex items-center justify-between mt-2">
                                  <button
                                    type="button"
                                    onClick={() => { setOpenAttachmentNotesCardId(null); setAttachmentNoteDraft(""); }}
                                    className="text-[0.6875rem] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (attachmentNoteDraft.trim()) {
                                        void addAttachmentNote(card, attachmentNoteDraft);
                                        setAttachmentNoteDraft("");
                                        setOpenAttachmentNotesCardId(null);
                                      }
                                    }}
                                    disabled={!attachmentNoteDraft.trim()}
                                    className="rounded-lg bg-blue-500 text-white text-[0.6875rem] font-medium px-3 py-1 disabled:opacity-40 hover:bg-blue-600 transition-colors"
                                  >
                                    Save
                                  </button>
                                </div>
                                {parseAttachmentNotes(card.attachment).length > 0 && (
                                  <div className="mt-3 border-t border-black/10 dark:border-white/10 pt-2 max-h-32 overflow-y-auto scrollbar-hide space-y-1.5">
                                    {parseAttachmentNotes(card.attachment).map((note) => (
                                      <div key={note.id} className="rounded-md bg-black/5 dark:bg-white/5 px-2 py-1.5">
                                        <p className="text-xs text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{note.text}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
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
                              <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[7px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
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
                        <div className={`glass-control rounded-2xl p-4 ${vaultView === "grid" ? "h-44 overflow-hidden" : ""}`}>
                          <div className="flex items-center gap-2 text-black/70 dark:text-white/70 mb-2">
                            <StickyNote className="w-4 h-4" />
                            <span className="text-xs font-medium">Quick Note</span>
                          </div>
                          <div className={vaultView === "grid" ? "overflow-hidden" : "max-h-56 overflow-y-auto scrollbar-hide"}>
                            <p className={`text-sm text-black/70 dark:text-white/70 whitespace-pre-wrap break-words ${vaultView === "grid" ? "line-clamp-5" : ""}`}>{card.excerpt}</p>
                          </div>
                          {card.tags?.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {card.tags.map((t) => (
                                <span key={t} className="vault-tag-pill inline-flex items-center rounded-full bg-black/5 dark:bg-white/10 text-[7px] leading-none px-2 py-px font-medium text-black/55 dark:text-white/55">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-3 text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{card.dateLabel}</span>
                          </div>
                        </div>
                        <div className="mt-2 flex justify-end px-1" data-no-drag="true">
                          <button
                            type="button"
                            data-no-drag="true"
                            draggable={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenAttachmentNotesCardId(null);
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
                      </>
                    )}
                  </motion.article>
                ))}
                <div ref={loadMoreRef} className="break-inside-avoid h-6" />
              </div>
            )}
            {isLoadingMoreNotes && (
              <div className="mt-4 text-xs text-black/60 dark:text-white/60">Loading more memories...</div>
            )}
          </motion.div>
        )}
      </main>

      {showChat && isMobileChat && (
        <div
          className="fixed inset-0 z-[63] bg-black/20 backdrop-blur-[2px]"
          onClick={() => setShowChat(false)}
        />
      )}
      {showChat && isMobileChat && (
        <div
          className="fixed inset-0 z-[63] bg-black/20 backdrop-blur-[2px]"
          onClick={() => setShowChat(false)}
        />
      )}
      {showChat && (
        <div
          className={`fixed bottom-0 flex flex-col bg-white/40 dark:bg-white/5 backdrop-blur-sm border-l border-black/10 dark:border-white/10 transition-[right] duration-300 ${isMobileChat ? "z-[80] inset-x-0 border-l-0" : "z-[64]"}`}
          style={{
            top: isMobileChat ? 0 : "var(--header-height, 4.9rem)",
            right: isMobileChat ? undefined : 0,
            width: isMobileChat ? undefined : `${chatRailWidthPx}px`,
            animation: "chatRailSlideIn 350ms cubic-bezier(0.22,1,0.36,1) both",
          }}
        >
          {!isMobileChat && (
            <div className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize z-[70] pointer-events-auto" onPointerDown={handleStartChatResize} title="Drag to resize chat" />
          )}
          {isMobileChat && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 dark:border-white/10 shrink-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-black/80 dark:text-white/80">
                <MessageSquare className="w-3.5 h-3.5" />
                Chat
              </div>
              <button type="button" onClick={() => setShowChat(false)} className="h-6 w-6 rounded-full flex items-center justify-center text-black/40 dark:text-white/40 hover:text-red-500 hover:bg-red-500/10 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-3">
            {chatMessages.map((msg, idx) => (
              <div key={msg.id || idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                {msg.role === "user" ? (
                  <div className="max-w-[94%] rounded-2xl rounded-br-md px-3 py-2 text-xs leading-relaxed text-black/90 dark:text-white/90 border border-white/30 dark:border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.14),rgba(255,255,255,0.06))] dark:bg-[linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] backdrop-blur-md shadow-[0_4px_14px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_14px_rgba(0,0,0,0.16)] [&_table]:text-[0.6875rem] [&_td]:py-1 [&_th]:py-1">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                      {normalizeChecklistSyntax(msg.content || "")}
                    </ReactMarkdown>
                  </div>
                ) : (() => {
                  const isExpanded = msg.id ? expandedAiMsgIds.has(msg.id) : true;
                  return (
                    <div className="self-start max-w-[94%] mt-1.5">
                      {msg.id && (
                        <button
                          type="button"
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-white/50 dark:border-white/12 bg-white/40 dark:bg-white/5 backdrop-blur-sm hover:bg-white/60 dark:hover:bg-white/10 transition-all text-left group/collapse"
                          onClick={() => toggleAiExpanded(msg.id)}
                        >
                          <ChevronRight className={`w-3 h-3 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                          {!isExpanded && (
                            <span className="text-[0.6875rem] text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                              {getCollapsedPreview(msg.content || "")}
                            </span>
                          )}
                          {isExpanded && (
                            <span className="text-[0.6875rem] text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
                          )}
                        </button>
                      )}
                      <div className={msg.id ? `overflow-hidden transition-all duration-200 ease-in-out ${isExpanded ? "max-h-[5000px] opacity-100 mt-1" : "max-h-0 opacity-0"}` : ""}>
                        <div className="space-y-1">
                          {(() => {
                            const chunks = splitResponseIntoChunks(msg.content || "");
                            const isSingle = chunks.length <= 1;
                            return (
                              <>
                                {chunks.map((chunk, ci) => (
                                  <div key={`${msg.id}-chunk-${ci}`} className="group/chunk relative">
                                    <div
                                      draggable
                                      onDragStart={(e) => handleChunkDragStart(e, chunk)}
                                      className={`rounded-xl px-3 py-1.5 text-xs leading-relaxed break-words border text-black/85 dark:text-white/85 cursor-grab active:cursor-grabbing transition-all ${isSingle ? "bg-white/45 dark:bg-white/6 border-white/40 dark:border-white/8 rounded-2xl rounded-bl-md" : "bg-white/30 dark:bg-white/4 border-white/25 dark:border-white/8 hover:bg-white/45 dark:hover:bg-white/8 hover:border-blue-300/40 hover:shadow-sm"}`}
                                    >
                                      <div className={`absolute -left-5 top-1/2 -translate-y-1/2 opacity-0 group-hover/chunk:opacity-100 transition-opacity ${isSingle ? "hidden" : ""}`}>
                                        <GripVertical className="w-3 h-3 text-blue-400/60" />
                                      </div>
                                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                                        {normalizeChecklistSyntax(chunk)}
                                      </ReactMarkdown>
                                    </div>
                                    {!isSingle && (
                                      <button
                                        type="button"
                                        title="Save this section as quick note"
                                        className="absolute -right-1 top-0.5 opacity-0 group-hover/chunk:opacity-100 transition-opacity p-0.5 rounded text-amber-400/70 hover:text-amber-500 hover:bg-amber-500/10"
                                        onClick={() => saveChunkAsQuickNote(chunk)}
                                      >
                                        <StickyNote className="w-2.5 h-2.5" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </>
                            );
                          })()}
                          <div className="flex items-center gap-0.5 px-1">
                            <button type="button" title="Save full response as quick note" className="p-1 rounded-md text-black/30 dark:text-white/30 hover:text-amber-500 hover:bg-amber-500/10 transition-colors" onClick={() => saveChunkAsQuickNote(msg.content || "")}>
                              <StickyNote className="w-3 h-3" />
                            </button>
                            <button type="button" title="Copy" className={`p-1 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/30 dark:text-white/30 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5"}`} onClick={() => { void navigator.clipboard.writeText(msg.content || ""); setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId((cur) => cur === msg.id ? null : cur), 2000); }}>
                              {copiedMsgId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
            {chatMessages.length > 0 && (() => {
              const last = chatMessages[chatMessages.length - 1];
              return last?.role === "assistant" && last?.tagActions?.applied > 0 ? (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 text-[11px] font-medium">
                    <Tag className="w-3 h-3" />
                    <span>Organised {last.tagActions.applied} item{last.tagActions.applied !== 1 ? "s" : ""}</span>
                  </div>
                </div>
              ) : null;
            })()}
            {isChatLoading && (
              <div className="flex flex-col items-end w-full">
                <div className="max-w-[94%] text-[0.6875rem] text-black/60 dark:text-white/60 px-1 flex items-center justify-end gap-2" aria-live="polite">
                  <div className="brick-spinner" />
                  {thinkingStatus}
                </div>
              </div>
            )}
          </div>
          <div className="p-3 pb-3">
            <div className="omnia-neu-chat-shell omnia-chat-border-run-once px-2.5 py-2 w-full flex flex-col gap-1.5">
              <textarea
                ref={chatInputRef}
                data-min-h="44"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 160) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
                placeholder="Ask me anything..."
                rows={1}
                className="w-full min-h-[2.75rem] max-h-[160px] omnia-neu-chat-field px-2.5 py-1.5 text-[0.6875rem] leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide"
                disabled={isChatLoading}
              />
              <div className="flex items-center gap-2 pt-0.5">
                <Select value={selectedModel} onValueChange={(value) => {
                  setSelectedModel(value);
                  try {
                    const saved = localStorage.getItem("lykinsai_settings");
                    const settings = saved ? JSON.parse(saved) : {};
                    settings.aiModel = value;
                    localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                    window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                  } catch { /* ignore */ }
                }}>
                  <SelectTrigger className="omnia-neu-chat-toolbar-select-trigger h-8 max-w-[6.5rem] min-w-0 shrink-0 rounded-lg border-0 bg-transparent text-[0.625rem] px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 [&>span]:truncate">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent side="top" align="start" className="glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]">
                    <SelectGroup>
                      <SelectLabel>Latest</SelectLabel>
                      <SelectItem value="claude-sonnet-4-6" hint="Anthropic flagship">Claude Sonnet 4.6</SelectItem>
                      <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                      <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                      <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Fastest</SelectLabel>
                      <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                      <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                      <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                      <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                      <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                      <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                      <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                      <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Cheap</SelectLabel>
                      <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                      <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                      <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Image Gen</SelectLabel>
                      <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                      <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                      <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                      <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                      <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                      <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Deep Thinking</SelectLabel>
                      <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                      <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                      <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                      <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                      <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                      <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                      <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Code</SelectLabel>
                      <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                      <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                      <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                      <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="flex-1 min-w-[4px]" aria-hidden />
                <button type="button" onClick={() => addMediaTriggerRef.current?.()} className="h-8 w-8 omnia-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0" title="Add attachments">
                  <Plus className="w-3 h-3" />
                </button>
                {isChatLoading ? (
                  <button type="button" onClick={() => setIsChatLoading(false)} className="h-8 w-8 omnia-neu-chat-icon-plain flex items-center justify-center shrink-0" title="Stop generating">
                    <Square className="w-2.5 h-2.5 text-red-600 dark:text-red-400" fill="currentColor" />
                  </button>
                ) : (
                  <button type="button" className="h-8 w-8 omnia-neu-chat-icon-plain flex items-center justify-center shrink-0" title="Dictate">
                    <Mic className="w-3 h-3 text-black/75 dark:text-white/80" />
                  </button>
                )}
                <button type="button" onClick={() => handleChatSend()} disabled={!chatInput.trim() || isChatLoading} className={`h-8 w-8 omnia-neu-chat-send-btn flex items-center justify-center shrink-0 ${!chatInput.trim() || isChatLoading ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`} title="Send">
                  <ArrowUp className="w-3 h-3" strokeWidth={2.25} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => {
            void handleCloseQuickNote();
          }}
        />
      )}


      {showSaveLink && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => { setShowSaveLink(false); setSaveLinkUrl(""); setSaveLinkPreview(null); }}>
          <div
            className="w-[420px] max-w-[92vw] glass-control rounded-2xl shadow-lg p-5 space-y-4"
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
                  const pasted = e.clipboardData.getData("text").trim();
                  if (pasted && /^https?:\/\//i.test(pasted)) {
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
          if (openCardMenuPlacement === "up") {
            top = undefined;
            maxH = openCardMenuRect.top - pad;
          } else {
            top = openCardMenuRect.bottom + pad;
            maxH = window.innerHeight - top - pad;
          }
          let left = openCardMenuRect.right - menuW;
          if (left < pad) left = pad;
          if (left + menuW > window.innerWidth - pad) left = window.innerWidth - pad - menuW;

          return (
            <div
              ref={cardMenuRef}
              className="rounded-2xl border border-white/30 dark:border-white/10 bg-white/60 dark:bg-[#171515]/60 backdrop-blur-md shadow-md p-2 overflow-y-auto scrollbar-hide"
              style={{
                position: "fixed",
                width: menuW,
                left,
                ...(openCardMenuPlacement === "up"
                  ? { bottom: window.innerHeight - openCardMenuRect.top + pad }
                  : { top }),
                maxHeight: maxH,
                zIndex: 9999,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60 dark:text-white/60">Add to project</div>
              <div className="space-y-1">
                <button
                  type="button"
                  disabled={isCardActionBusy}
                  onClick={() => void createProjectFromCard(menuCard)}
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
                        onClick={() => void addCardToProject(menuCard, project.id)}
                        className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-60 truncate"
                        title={project.name}
                      >
                        {project.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
              {menuCard.kind === "attachment" && (
                <>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <button
                    type="button"
                    disabled={isCardActionBusy}
                    onClick={() => {
                      setOpenAttachmentNotesCardId(menuCard.id);
                      setAttachmentNoteDraft("");
                      setOpenCardMenuId(null);
                    }}
                    className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2"
                  >
                    <StickyNote className="w-3.5 h-3.5" />
                    Note
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
              <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
              <button
                type="button"
                disabled={isCardActionBusy}
                onClick={() => {
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
          );
        })(),
        document.body
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
          if (top + 320 > window.innerHeight) top = tagPickerPosition.top - 340;

          const filteredTags = newTagInput.trim()
            ? allTags.filter((t) => t.name.toLowerCase().includes(newTagInput.trim().toLowerCase()))
            : allTags;
          const exactMatch = allTags.some((t) => t.name.toLowerCase() === newTagInput.trim().toLowerCase());

          return (
            <div
              ref={tagPickerRef}
              className="rounded-2xl border border-white/30 dark:border-white/10 bg-white/65 dark:bg-[#171515]/65 backdrop-blur-md shadow-md p-3 overflow-hidden"
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
                      className="vault-tag-pill inline-flex items-center gap-1 rounded-full bg-blue-500/15 text-blue-700 text-[7px] leading-none px-2 py-px font-medium"
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
      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />
    </div>
  );
}
