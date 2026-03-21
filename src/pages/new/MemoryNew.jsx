import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Music,
  Plus,
  StickyNote,
  Trash2,
  Table2,
  Upload,
  Video,
  X,
  Zap,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/canvas/utils/youtube";
import LoadingScreen from "@/components/LoadingScreen";
import { getAiPrefs } from "@/lib/ai-prefs";

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

  if (attachment.type === "bookmark" || attachment.type === "link" || attachment.siteName || attachment.articleText) return "bookmark";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";

  const explicit = attachment.type;
  if (explicit && explicit !== "file") return explicit;
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";

  const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv"].includes(ext) || attachment.type === "spreadsheet") return "spreadsheet";
  if (["doc", "docx", "ppt", "pptx", "txt", "md"].includes(ext)) return "file";

  return "file";
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
  const noHtml = String(htmlOrText).replace(/<[^>]+>/g, " ");
  return noHtml.replace(/\s+/g, " ").trim();
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

export default function MemoryNew() {
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
  const memoryQueryClient = useQueryClient();
  const [notes, setNotes] = useState([]);
  const [isLoadingNotes, setIsLoadingNotes] = useState(true);
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
  // projects fetched via React Query above
  const [openCardMenuId, setOpenCardMenuId] = useState(null);
  const [openCardMenuPlacement, setOpenCardMenuPlacement] = useState("down");
  const [openCardMenuRect, setOpenCardMenuRect] = useState(null);
  const [openAttachmentNotesCardId, setOpenAttachmentNotesCardId] = useState(null);
  const [openAttachmentNoteComposerCardId, setOpenAttachmentNoteComposerCardId] = useState(null);
  const [attachmentNoteComposerPosition, setAttachmentNoteComposerPosition] = useState(null);
  const [attachmentNoteDraft, setAttachmentNoteDraft] = useState("");
  const [attachmentNoteDraftSavedId, setAttachmentNoteDraftSavedId] = useState(null);
  const [isCardActionBusy, setIsCardActionBusy] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [showSaveLink, setShowSaveLink] = useState(false);
  const [saveLinkUrl, setSaveLinkUrl] = useState("");
  const [saveLinkPreview, setSaveLinkPreview] = useState(null);
  const [isSaveLinkLoading, setIsSaveLinkLoading] = useState(false);
  const [isSaveLinkSaving, setIsSaveLinkSaving] = useState(false);
  const lastHoverTargetRef = useRef(null);
  const loadMoreRef = useRef(null);
  const cardMenuRef = useRef(null);
  const notesPopoverRef = useRef(null);
  const noteComposerRef = useRef(null);
  const assistantIndexRef = useRef(null);
  const signedUrlCacheRef = useRef(new Map());
  const lastAutoSavedAttachmentNoteTextRef = useRef("");
  const MEMORY_PAGE_SIZE = 24;

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
  const [liveAIMode, setLiveAIMode] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        return Boolean(parsed.liveAIMode);
      }
    } catch {
      // ignore
    }
    return false;
  });

  const notesCursorRef = useRef(null);

  const fetchNotesBatch = useCallback(
    async (cursor) => {
      let query = supabase
        .from("notes")
        .select("id, title, content, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(MEMORY_PAGE_SIZE);
      if (cursor) query = query.lt("updated_at", cursor);
      const { data, error } = await query;
      return { data, error };
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
        if (typeof parsed.liveAIMode !== "undefined") setLiveAIMode(Boolean(parsed.liveAIMode));
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
      if (notesPopoverRef.current && !notesPopoverRef.current.contains(event.target)) {
        setOpenAttachmentNotesCardId(null);
      }
      if (noteComposerRef.current && !noteComposerRef.current.contains(event.target)) {
        setOpenAttachmentNoteComposerCardId(null);
        setAttachmentNoteComposerPosition(null);
        setAttachmentNoteDraft("");
        setAttachmentNoteDraftSavedId(null);
        lastAutoSavedAttachmentNoteTextRef.current = "";
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
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

  const memoryCards = useMemo(() => {
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
        ? String(cleanContent || "").replace(/\r\n/g, "\n").trim()
        : buildTextExcerpt(cleanContent);

      attachments.forEach((attachment, idx) => {
        const type = resolveAttachmentType(attachment);
        cards.push({
          id: `${note.id}-att-${attachment.id || idx}`,
          kind: "attachment",
          noteId: note.id,
          attachmentIndex: idx,
          type,
          attachment,
          title: attachment.name || note.title || "Untitled",
          parentTitle: note.title || "Untitled note",
          dateLabel,
        });
      });

      // Support YouTube memories even when they are stored as plain links in note text.
      if (attachments.length === 0 && youtubeLinks.length > 0) {
        youtubeLinks.forEach((url, idx) => {
          cards.push({
            id: `${note.id}-yt-${idx}`,
            kind: "attachment",
            type: "youtube",
            attachment: { url, name: "YouTube Video" },
            title: "YouTube Video",
            parentTitle: note.title || "Untitled note",
            dateLabel,
          });
        });
      }

      if (!isStandaloneQuickNote && chatPreview && attachments.length === 0) {
        cards.push({
          id: `${note.id}-chat-preview`,
          kind: "chat-preview",
          title: note.title || "AI Chat",
          question: chatPreview.question,
          answer: chatPreview.answer,
          turnsCount: chatPreview.turnsCount,
          dateLabel,
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

  const visibleCardIdsRef = useRef(new Set());
  const urlResolveObserverRef = useRef(null);

  const resolveSignedUrlForCard = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return;
    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) return;
    const cacheKey = `${target.bucket}:${target.path}`;
    if (signedUrlCacheRef.current.has(cacheKey)) {
      setResolvedAttachmentUrls((prev) => {
        if (prev[card.id]) return prev;
        return { ...prev, [card.id]: signedUrlCacheRef.current.get(cacheKey) };
      });
      return;
    }
    const { data } = await supabase.storage
      .from(target.bucket)
      .createSignedUrl(target.path, 60 * 60 * 24 * 7);
    if (data?.signedUrl) {
      signedUrlCacheRef.current.set(cacheKey, data.signedUrl);
      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
    } else {
      const { data: pubData } = supabase.storage.from(target.bucket).getPublicUrl(target.path);
      if (pubData?.publicUrl) {
        signedUrlCacheRef.current.set(cacheKey, pubData.publicUrl);
        setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: pubData.publicUrl }));
      }
    }
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

  useEffect(() => {
    if (!user?.id) return;
    const cardLookup = new Map(memoryCards.map((c) => [c.id, c]));

    urlResolveObserverRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cardId = entry.target.dataset?.cardId;
          if (!cardId || visibleCardIdsRef.current.has(cardId)) continue;
          visibleCardIdsRef.current.add(cardId);
          const card = cardLookup.get(cardId);
          if (card) resolveSignedUrlForCard(card);
        }
      },
      { rootMargin: "200px" }
    );

    for (const [cardId, el] of cardElementsRef.current) {
      urlResolveObserverRef.current.observe(el);
    }

    return () => {
      urlResolveObserverRef.current?.disconnect();
      urlResolveObserverRef.current = null;
    };
  }, [memoryCards, user?.id, resolveSignedUrlForCard]);

  const visibleCards = useMemo(() => {
    return memoryCards.filter((card) => card.kind !== "chat-preview");
  }, [memoryCards]);

  const filteredVisibleCards = useMemo(() => {
    const query = String(embeddedSearch || "").trim().toLowerCase();
    if (!query) return visibleCards;
    return visibleCards.filter((card) => {
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
  }, [embeddedSearch, visibleCards]);

  const orderStorageKey = useMemo(
    () => (user?.id ? `memory_collage_order_v1_${user.id}` : "memory_collage_order_v1_guest"),
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

  const orderedVisibleCards = useMemo(() => {
    const currentOrder = orderByPage.everything || [];
    const visibleMap = new Map(filteredVisibleCards.map((card) => [card.id, card]));
    const ordered = currentOrder.map((id) => visibleMap.get(id)).filter(Boolean);
    const remaining = filteredVisibleCards.filter((card) => !currentOrder.includes(card.id));
    return [...ordered, ...remaining];
  }, [filteredVisibleCards, orderByPage]);

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

    setChatInput("");
    setIsChatLoading(true);
    setChatMessages((prev) => {
      const idx = prev.length + 1;
      assistantIndexRef.current = idx;
      return [...prev, { role: "user", content: text }, { role: "assistant", content: "" }];
    });

    try {
      const history = chatMessages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const memoryContext = notes
        .slice(0, 16)
        .map((n) => `- ${n.title || "Untitled"}: ${buildTextExcerpt(stripAttachmentJsonMarker(n.content || "")).slice(0, 160)}`)
        .join("\n");

      const prompt = `You are an AI assistant for a Memory page inside a creative workspace app.
Be concise and practical.

Recent memories:
${memoryContext || "(none)"}

Conversation:
${history || "(none)"}

User: ${text}`;

      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, prompt, ...getAiPrefs() }),
      });
      if (!res.ok) throw new Error("AI request failed");
      const data = await res.json().catch(() => ({}));
      const aiText = String(data.response || "").trim();

      const idx = assistantIndexRef.current;
      if (idx == null) return;

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
          if (i < words.length) window.setTimeout(tick, 18);
        };
        tick();
      }
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
      return (
        <img
          src={resolvedUrl}
          alt={title}
          className="w-full h-auto max-h-[42rem] rounded-2xl"
          loading="lazy"
          draggable={false}
          onError={(e) => {
            const img = e.currentTarget;
            if (img && !img.dataset.retried && attachment?.storagePath && attachment?.storageBucket) {
              img.dataset.retried = "1";
              supabase.storage
                .from(attachment.storageBucket)
                .createSignedUrl(attachment.storagePath, 60 * 60 * 24 * 7)
                .then(({ data }) => {
                  if (data?.signedUrl) img.src = data.signedUrl;
                });
            }
          }}
        />
      );
    }

    if (type === "video") {
      const videoMime = attachment.mimeType || "video/mp4";
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
          <div className="flex items-center gap-2 text-black/80">
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
                <p className="text-xs font-medium text-black/85 truncate">{title}</p>
                <p className="text-[0.6875rem] text-black/55 mt-1 truncate">{attachment.url}</p>
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
            className="block rounded-2xl overflow-hidden glass-control hover:shadow-lg transition-shadow group/bm"
            draggable={false}
          >
            <div className="p-4 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 fill-current text-black/70" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-black/85 truncate block leading-tight">{attachment.authorName || displayTitle}</span>
                  {attachment.authorHandle && <span className="text-[0.625rem] text-black/45 truncate block leading-tight">{attachment.authorHandle}</span>}
                </div>
                <ExternalLink className="w-3 h-3 opacity-0 group-hover/bm:opacity-60 transition-opacity shrink-0" />
              </div>
              <p className="text-[13px] text-black/75 leading-relaxed whitespace-pre-line line-clamp-6">{desc}</p>
              <div className="flex items-center gap-1.5 text-black/35 pt-1.5 border-t border-black/8">
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
          className="block rounded-2xl overflow-hidden glass-control hover:shadow-lg transition-shadow group/bm"
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
            <div className="flex items-center gap-1.5 text-black/50">
              {attachment.favicon ? (
                <img src={attachment.favicon} alt="" className="w-3.5 h-3.5 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none"; }} />
              ) : (
                <Globe className="w-3.5 h-3.5" />
              )}
              <span className="text-[0.625rem] font-medium truncate">{domain}</span>
              <ExternalLink className="w-2.5 h-2.5 ml-auto opacity-0 group-hover/bm:opacity-100 transition-opacity" />
            </div>
            <p className="text-sm font-semibold text-black/85 leading-snug line-clamp-2">{displayTitle}</p>
            {desc && <p className="text-xs text-black/55 leading-relaxed line-clamp-3">{desc}</p>}
            {!hasImage && !desc && linkUrl && (
              <p className="text-xs text-black/40 truncate">{linkUrl}</p>
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
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8">
            <Table2 className="w-4 h-4 text-green-600 shrink-0" />
            <span className="text-sm font-medium text-black/80 truncate">{fileName}</span>
          </div>
          {hasData ? (
            <div className="overflow-hidden">
              <table className="w-full border-collapse text-[11px]">
                <tbody>
                  {Array.from({ length: totalRows }, (_, r) => (
                    <tr key={r} className={r === 0 ? "bg-black/5 font-semibold" : ""}>
                      {Array.from({ length: totalCols }, (_, c) => (
                        <td key={c} className="px-2 py-1 border-b border-r border-black/6 text-black/70 truncate max-w-[120px]">
                          {cells[`${r},${c}`] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(Number(attachment.rows) > 8 || Number(attachment.cols) > 6) && (
                <div className="px-3 py-1.5 text-[0.6rem] text-black/35 text-center">
                  {attachment.rows} rows × {attachment.cols} cols
                </div>
              )}
            </div>
          ) : (
            <div className="px-3.5 py-4 text-center text-xs text-black/40">Spreadsheet file</div>
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
              <p className="text-xs font-medium text-black/85 truncate">{title}</p>
              <p className="text-[0.6875rem] text-black/55 mt-1">{type.toUpperCase()} file</p>
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
            <p className="text-xs font-medium text-black/85 truncate">{title}</p>
            <p className="text-[0.6875rem] text-black/55 mt-1">
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
        name: card.title || (card.kind === "quick-note" ? "Quick Note" : "Memory File"),
        path: storageTarget?.path || fileUrl,
        folderId: null,
        kind,
        url: fileUrl,
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
        "quick-note": "text",
      };
      const kind = kindByType[card.type || card.kind] || "file";
      const newFile = {
        id: crypto.randomUUID(),
        name: card.title || (card.kind === "quick-note" ? "Quick Note" : "Memory File"),
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

      memoryQueryClient.invalidateQueries({ queryKey: ["projects", user?.id] });
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
      const activeDraftId = attachmentNoteDraftSavedId || crypto.randomUUID();
      const existingIdx = existingNotes.findIndex((n) => String(n.id) === String(activeDraftId));
      const nextDraftNote = {
        id: activeDraftId,
        text,
        created_at:
          existingIdx >= 0
            ? existingNotes[existingIdx]?.created_at || new Date().toISOString()
            : new Date().toISOString(),
      };
      const nextAttachmentNotes =
        existingIdx >= 0
          ? existingNotes.map((item, i) => (i === existingIdx ? nextDraftNote : item))
          : [...existingNotes, nextDraftNote];
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
        setAttachmentNoteDraftSavedId(activeDraftId);
        lastAutoSavedAttachmentNoteTextRef.current = text;
        setOpenAttachmentNotesCardId(card.id);
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [attachmentNoteDraftSavedId, notes, user?.id]);

  const composerCard = useMemo(
    () =>
      memoryCards.find(
        (card) => card.kind === "attachment" && String(card.id) === String(openAttachmentNoteComposerCardId)
      ) || null,
    [memoryCards, openAttachmentNoteComposerCardId]
  );

  useEffect(() => {
    if (!composerCard) return;
    const text = attachmentNoteDraft.trim();
    if (!text) return;
    if (text === lastAutoSavedAttachmentNoteTextRef.current) return;
    const timer = window.setTimeout(() => {
      void addAttachmentNote(composerCard, text);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [addAttachmentNote, attachmentNoteDraft, composerCard]);

  const confirmAndDeleteAttachment = useCallback((card) => {
    if (!card) return;
    const label = String(card?.title || "this file");
    const ok = window.confirm(`Are you sure you want to delete "${label}"? This cannot be undone.`);
    if (!ok) return;
    void removeAttachmentFromNote(card);
  }, [removeAttachmentFromNote]);

  const openAttachmentComposerForCard = useCallback((cardId, anchorRect = null) => {
    const articleEl = document.querySelector(`[data-memory-card-id="${String(cardId)}"]`);
    const rect = anchorRect || articleEl?.getBoundingClientRect();
    const panelWidth = 380;
    const fallbackLeft = Math.max(12, Math.round(window.innerWidth * 0.55));
    const fallbackTop = Math.max(12, Math.round(window.innerHeight * 0.2));

    let left = rect ? rect.right + 12 : fallbackLeft;
    const top = rect ? Math.max(8, rect.top) : fallbackTop;

    if (left + panelWidth > window.innerWidth - 12) {
      left = rect ? Math.max(12, rect.left - panelWidth - 12) : Math.max(12, window.innerWidth - panelWidth - 12);
    }

    setOpenAttachmentNoteComposerCardId(cardId);
    setAttachmentNoteComposerPosition({ left, top });
    setOpenAttachmentNotesCardId(null);
    setOpenCardMenuId(null);
    setAttachmentNoteDraft("");
    setAttachmentNoteDraftSavedId(null);
    lastAutoSavedAttachmentNoteTextRef.current = "";
  }, []);

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

  if ((loading || isLoadingNotes) && user) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div className={`min-h-screen bg-transparent text-black relative overflow-x-hidden`}>
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
            className="rounded-full w-8 h-8 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
          </button>

          {topPanelOpen && (
            <div className="flex h-9 items-center gap-1 p-0.5 rounded-full glass-control flex-wrap">
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
                <SelectTrigger className="w-[124px] !h-7 rounded-full glass-control hover:opacity-90 text-[0.6875rem] font-medium px-2">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="glass-control border border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/10 backdrop-blur-xl shadow-lg overflow-hidden"
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
                    <SelectLabel>Image & Video Gen</SelectLabel>
                    <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                    <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                    <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                    <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                    <SelectItem value="veo-3.1-generate-preview" hint="Google, video">Veo 3.1</SelectItem>
                    <SelectItem value="grok-imagine-video" hint="xAI, video">Grok Imagine Video</SelectItem>
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

              <div className="w-px h-3 bg-black/10 dark:bg-white/10 mx-0.5" />

              <button
                type="button"
                onClick={() => {
                  const next = !liveAIMode;
                  setLiveAIMode(next);
                  try {
                    const saved = localStorage.getItem("lykinsai_settings");
                    const settings = saved ? JSON.parse(saved) : {};
                    settings.liveAIMode = next;
                    localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                    window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                  } catch {
                    // ignore
                  }
                }}
                className={`rounded-full px-1.5 h-7 gap-1 text-[0.6875rem] glass-control hover:opacity-90 touch-manipulation flex items-center ${
                  liveAIMode ? "ring-1 ring-white/40 dark:ring-white/20" : ""
                }`}
                title="Live AI"
              >
                <Zap className={`w-3 h-3 ${liveAIMode ? "text-yellow-500" : "text-black"}`} />
                <span>Live AI</span>
              </button>

              <div className="w-px h-3 bg-black/10 dark:bg-white/10 mx-0.5" />

              <button
                type="button"
                onClick={() => setShowChat((v) => !v)}
                className="rounded-full px-1.5 h-7 text-[0.6875rem] glass-control hover:opacity-90 touch-manipulation flex items-center gap-1"
                title="Chat with AI"
              >
                <span className="hidden md:inline">Chat</span>
                <MessageSquare className="w-3 h-3 md:hidden" />
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      <main className={`relative z-20 mx-auto w-full max-w-[1560px] px-4 sm:px-6 lg:px-8 ${isEmbeddedMode ? "pt-6" : "pt-24"} pb-16`}>
        <section className="mb-6">
          {isEmbeddedMode ? (
            <input
              type="text"
              value={embeddedSearch}
              onChange={(e) => setEmbeddedSearch(e.target.value)}
              placeholder="Search memories..."
              className="w-full h-10 rounded-xl border border-black/10 bg-white/80 px-3 text-sm outline-none"
            />
          ) : (
            <>
              <h1 className="text-3xl font-semibold">The Vault</h1>
              <p className="text-black/60 mt-1">
                Your digital collage of media files, videos, images, and quick notes. Drag and drop files or folders anywhere on this page.
              </p>
            </>
          )}
        </section>

        {!user && !loading && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-black/70">Sign in to view your vault.</p>
          </div>
        )}

        {notesError && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-red-600">{notesError}</p>
          </div>
        )}

        {!loading && !isLoadingNotes && user && !notesError && (
          <>
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
                      <span className="text-xs font-medium text-black/50 group-hover/opt:text-blue-500 transition-colors">Upload Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSaveLink(true)}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Globe className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 group-hover/opt:text-blue-500 transition-colors">Save Link</span>
                    </button>
                  </div>
                </div>
                {embeddedSearch.trim() && (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70">No results match your search.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className={isEmbeddedMode ? "columns-2 gap-3" : "columns-1 sm:columns-2 md:columns-3 xl:columns-4 2xl:columns-5 gap-4 md:gap-5"}>
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
                      <span className="text-[0.625rem] font-medium text-black/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSaveLink(true)}
                      className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Globe className="w-4 h-4 text-blue-500" />
                      </div>
                      <span className="text-[0.625rem] font-medium text-black/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                    </button>
                  </div>
                </div>
                {orderedVisibleCards.map((card) => (
                  <article
                    key={card.id}
                    data-memory-card-id={card.id}
                    data-card-id={card.id}
                    ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                    draggable
                    onDragStart={(e) => {
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
                        } catch {
                          // ignore drag payload issues between contexts
                        }
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
                          timestamp: Date.now(),
                        };
                        try { e.dataTransfer.setData("application/x-omnia-memory", JSON.stringify(pendingData)); } catch {}
                        try {
                          const target = window.parent !== window ? window.parent : window;
                          /** @type {any} */ (target).__omnia_pending_memory = pendingData;
                        } catch {}
                        try {
                          window.parent.postMessage({ type: "omnia-memory-drag-start", data: pendingData }, "*");
                        } catch {}
                        e.dataTransfer.effectAllowed = "copyMove";
                      } else if (isEmbeddedMode && card.kind === "quick-note") {
                        const pendingData = {
                          id: card.id,
                          title: card.title || "Quick Note",
                          content: card.excerpt || "",
                          attachments: [],
                          timestamp: Date.now(),
                        };
                        try {
                          e.dataTransfer.setData("text/plain", card.excerpt || card.title || "Quick Note");
                          e.dataTransfer.setData("application/x-omnia-memory", JSON.stringify(pendingData));
                        } catch {}
                        try {
                          const target = window.parent !== window ? window.parent : window;
                          /** @type {any} */ (target).__omnia_pending_memory = pendingData;
                        } catch {}
                        try {
                          window.parent.postMessage({ type: "omnia-memory-drag-start", data: pendingData }, "*");
                        } catch {}
                        e.dataTransfer.effectAllowed = "copyMove";
                      } else {
                        e.dataTransfer.effectAllowed = "move";
                      }

                      setDraggedCardId(card.id);
                      lastHoverTargetRef.current = card.id;
                      window.dispatchEvent(new CustomEvent("memory_collage_reorder_drag_start"));
                      try { e.dataTransfer.setData("application/x-lykins-memory-card-id", card.id); } catch {}
                    }}
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
                      const droppedId = e.dataTransfer.getData("application/x-lykins-memory-card-id") || draggedCardId;
                      if (droppedId && droppedId !== card.id) {
                        reorderActivePage(droppedId, card.id);
                      }
                      setDraggedCardId(null);
                      setDropTargetCardId(null);
                      lastHoverTargetRef.current = null;
                      window.dispatchEvent(new CustomEvent("memory_collage_reorder_drag_end"));
                    }}
                    onDragEnd={() => {
                      setDraggedCardId(null);
                      setDropTargetCardId(null);
                      lastHoverTargetRef.current = null;
                      window.dispatchEvent(new CustomEvent("memory_collage_reorder_drag_end"));
                      if (isEmbeddedMode) {
                        try { window.parent.postMessage({ type: "omnia-memory-drag-end" }, "*"); } catch {}
                      }
                    }}
                    className={`break-inside-avoid ${isEmbeddedMode ? "mb-0" : "mb-5"} rounded-2xl relative ${
                      card.kind === "chat-preview" ? "overflow-hidden" : "overflow-visible"
                    } ${
                      card.kind === "attachment" || card.kind === "quick-note"
                        ? "bg-transparent border-0 shadow-none backdrop-blur-0"
                        : "glass-control"
                    } ${
                      draggedCardId === card.id
                        ? "opacity-50 cursor-grabbing"
                        : "cursor-grab"
                    } ${dropTargetCardId === card.id ? "ring-2 ring-white/50" : ""} ${
                      card.kind === "attachment" && card.type === "youtube"
                        ? getYouTubeOffsetClass(card.id)
                        : ""
                    } ${
                      openAttachmentNoteComposerCardId === card.id
                        ? "z-[310]"
                        : "z-0"
                    }`}
                  >
                    {card.kind === "attachment" ? (
                      <>
                        {renderAttachmentCard(card, getAttachmentHeightClass(card))}
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
                            className="absolute top-2 right-2 h-6 min-w-6 px-1 rounded-full glass-control text-[0.6875rem] font-semibold flex items-center justify-center gap-1 z-[125]"
                            title="View file notes"
                          >
                            <MessageSquare className="w-3 h-3" />
                            <span>{parseAttachmentNotes(card.attachment).length}</span>
                          </button>
                        )}
                        {openAttachmentNotesCardId === card.id && (
                          <div
                            ref={notesPopoverRef}
                            className="absolute top-10 right-2 w-64 rounded-2xl border border-white/60 bg-white/85 dark:bg-[#171515]/85 backdrop-blur-xl shadow-2xl p-2 z-[130]"
                            data-no-drag="true"
                            draggable={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60">File notes</div>
                            <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                              {parseAttachmentNotes(card.attachment).map((note) => (
                                <div key={note.id} className="rounded-md px-2 py-2 bg-black/5">
                                  <p className="text-xs text-black/85 whitespace-pre-wrap break-words">{note.text}</p>
                                  <p className="mt-1 text-[0.625rem] text-black/50">
                                    {note.created_at ? formatDate(note.created_at) : ""}
                                  </p>
                                </div>
                              ))}
                            </div>
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
                              setOpenAttachmentNotesCardId(null);
                              if (openCardMenuId === card.id) {
                                setOpenCardMenuId(null);
                                return;
                              }
                              openCardMenuForAnchor(card.id, e.currentTarget);
                            }}
                            className="px-1 py-0.5 text-black/75 hover:text-black leading-none text-base font-semibold"
                            title="Actions"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    ) : card.kind === "chat-preview" ? (
                      <div className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <h2 className="text-sm font-semibold text-black/90 truncate">{card.title}</h2>
                          <span className="text-[0.6875rem] text-black/60">{card.turnsCount} turns</span>
                        </div>
                        <div className="rounded-xl bg-white/40 border border-white/45 px-3 py-2">
                          <p className="text-[0.75rem] text-black/80 line-clamp-3">{card.question}</p>
                        </div>
                        {card.answer && (
                          <div className="rounded-xl bg-black/10 border border-white/30 px-3 py-2">
                            <p className="text-[0.75rem] text-black/75 line-clamp-4">{card.answer}</p>
                          </div>
                        )}
                        <div className="text-[0.6875rem] text-black/55 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>{card.dateLabel}</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="glass-control rounded-2xl p-4">
                          <div className="flex items-center gap-2 text-black/70 mb-2">
                            <StickyNote className="w-4 h-4" />
                            <span className="text-xs font-medium">Quick Note</span>
                          </div>
                          <div className="max-h-56 overflow-y-auto scrollbar-hide">
                            <p className="text-sm text-black/70 whitespace-pre-wrap break-words">{card.excerpt}</p>
                          </div>
                          <div className="mt-3 text-[0.6875rem] text-black/55 flex items-center gap-1">
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
                            className="px-1 py-0.5 text-black/75 hover:text-black leading-none text-base font-semibold"
                            title="Quick note actions"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
                <div ref={loadMoreRef} className="break-inside-avoid h-6" />
              </div>
            )}
            {isLoadingMoreNotes && (
              <div className="mt-4 text-xs text-black/60">Loading more memories...</div>
            )}
          </>
        )}
      </main>

      {showChat && (
        <DraggableChat
          messages={chatMessages}
          input={chatInput}
          setInput={setChatInput}
          onSend={handleChatSend}
          isLoading={isChatLoading}
          onClose={() => setShowChat(false)}
          onNoteClick={() => {}}
        />
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

      {openAttachmentNoteComposerCardId && composerCard && attachmentNoteComposerPosition && (
        <div
          ref={noteComposerRef}
          className="fixed group pointer-events-auto w-[380px] max-w-[92vw] min-h-[360px] max-h-[86vh] glass-control rounded-2xl shadow-2xl p-3 z-[340]"
          style={{ left: `${attachmentNoteComposerPosition.left}px`, top: `${attachmentNoteComposerPosition.top}px` }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="relative h-full">
            <div className="absolute top-3 right-3 z-20 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                className="h-5 w-5 text-black/70 hover:text-red-500 flex items-center justify-center"
                onClick={() => {
                  setOpenAttachmentNoteComposerCardId(null);
                  setAttachmentNoteComposerPosition(null);
                  setOpenAttachmentNotesCardId(composerCard.id);
                  setAttachmentNoteDraft("");
                  setAttachmentNoteDraftSavedId(null);
                  lastAutoSavedAttachmentNoteTextRef.current = "";
                }}
                title="Close"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <textarea
              value={attachmentNoteDraft}
              onChange={(e) => setAttachmentNoteDraft(e.target.value)}
              placeholder=""
              className="h-full w-full min-h-[340px] resize-none rounded-lg bg-transparent border border-white/35 px-3 py-3 text-sm text-black outline-none"
              onPointerDown={(e) => e.stopPropagation()}
            />
            {!attachmentNoteDraft.trim() && (
              <div className="pointer-events-none absolute inset-0 px-6 py-6 text-sm text-black/45 select-none">
                <div>Write your quick note...</div>
                <div className="mt-2 text-[0.6875rem] text-black/50">Auto-saves as you type (empty notes are not saved).</div>
              </div>
            )}
          </div>
        </div>
      )}

      {showSaveLink && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => { setShowSaveLink(false); setSaveLinkUrl(""); setSaveLinkPreview(null); }}>
          <div
            className="w-[420px] max-w-[92vw] glass-control rounded-2xl shadow-2xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-black/85 flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Save Link to Vault
              </h2>
              <button type="button" onClick={() => { setShowSaveLink(false); setSaveLinkUrl(""); setSaveLinkPreview(null); }} className="text-black/50 hover:text-black/80">
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
                className="flex-1 rounded-xl border border-white/40 bg-white/30 px-3 py-2 text-sm outline-none placeholder:text-black/40 focus:border-blue-400/50"
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
              <div className="flex items-center justify-center py-6 text-black/50">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span className="text-xs">Fetching link preview...</span>
              </div>
            )}

            {saveLinkPreview && !isSaveLinkLoading && (
              <div className="rounded-xl border border-white/40 overflow-hidden bg-white/20">
                {saveLinkPreview.image && (
                  <div className="w-full h-40 overflow-hidden bg-black/5">
                    <img src={saveLinkPreview.image} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                  </div>
                )}
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-black/50">
                    <Globe className="w-3 h-3" />
                    <span className="text-[0.625rem] font-medium">{saveLinkPreview.siteName || (() => { try { return new URL(saveLinkPreview.url).hostname.replace(/^www\./, ""); } catch { return ""; } })()}</span>
                  </div>
                  <p className="text-sm font-semibold text-black/85 leading-snug">{saveLinkPreview.title}</p>
                  {saveLinkPreview.description && (
                    <p className="text-xs text-black/55 leading-relaxed line-clamp-3">{saveLinkPreview.description}</p>
                  )}
                  {saveLinkPreview.articleText && (
                    <p className="text-[0.625rem] text-black/40 mt-1">Article text captured ({saveLinkPreview.articleText.length.toLocaleString()} chars)</p>
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

      {!isEmbeddedMode && (
        <button
          type="button"
          onClick={() => setShowQuickNote(true)}
          className="fixed bottom-8 right-8 w-14 h-14 rounded-full glass-control hover:opacity-90 shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 z-[80]"
          title="Quick Notes"
        >
          <StickyNote className="w-6 h-6" />
        </button>
      )}

      {openCardMenuId && openCardMenuRect && createPortal(
        (() => {
          const menuCard = orderedVisibleCards.find((c) => c.id === openCardMenuId);
          if (!menuCard) return null;
          const menuW = 224;
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
              className="rounded-2xl border border-white/60 bg-white/85 dark:bg-[#171515]/85 backdrop-blur-xl shadow-2xl p-2 overflow-y-auto scrollbar-hide"
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
              <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60">Add to project</div>
              <div className="space-y-1">
                <button
                  type="button"
                  disabled={isCardActionBusy}
                  onClick={() => void createProjectFromCard(menuCard)}
                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New project
                </button>
                <div className="my-1 h-px bg-black/10" />
                <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                  {projects.length === 0 ? (
                    <div className="px-2 py-1.5 text-[0.6875rem] text-black/55">No projects found.</div>
                  ) : (
                    projects.map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        disabled={isCardActionBusy}
                        onClick={() => void addCardToProject(menuCard, project.id)}
                        className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 disabled:opacity-60 truncate"
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
                  <div className="my-1 h-px bg-black/10" />
                  <button
                    type="button"
                    disabled={isCardActionBusy}
                    onClick={() => {
                      const articleEl = document.querySelector(`[data-memory-card-id="${menuCard.id}"]`);
                      const rect = articleEl?.getBoundingClientRect() || null;
                      openAttachmentComposerForCard(menuCard.id, rect);
                      setOpenCardMenuId(null);
                    }}
                    className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2"
                  >
                    <StickyNote className="w-3.5 h-3.5" />
                    Note
                  </button>
                </>
              )}
              <div className="my-1 h-px bg-black/10" />
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
                className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2 text-red-600"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
          );
        })(),
        document.body
      )}
      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />
    </div>
  );
}
