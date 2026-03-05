import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Music,
  Plus,
  StickyNote,
  LayoutGrid,
  Trash2,
  Video,
  X,
  Zap,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import DragDropFileUpload from "@/components/files/DragDropFileUpload";
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
  return `${content.slice(0, start)}${content.slice(jsonEnd)}`.replace(/\n{3,}/g, "\n\n").trim();
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
  const explicit = attachment.type;
  if (explicit && explicit !== "file") return explicit;

  const url = String(attachment.url || "");
  const name = String(attachment.name || "");
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";

  const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "md", "csv"].includes(ext)) return "file";

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

  const [embeddedSearch, setEmbeddedSearch] = useState("");
  const [notes, setNotes] = useState([]);
  const [isLoadingNotes, setIsLoadingNotes] = useState(true);
  const [notesError, setNotesError] = useState("");
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [activeMemoryPage, setActiveMemoryPage] = useState("everything");
  const [orderByPage, setOrderByPage] = useState({ everything: [], boards: [] });
  const [boardCards, setBoardCards] = useState([]);
  const [draggedCardId, setDraggedCardId] = useState(null);
  const [dropTargetCardId, setDropTargetCardId] = useState(null);
  const [hasMoreNotes, setHasMoreNotes] = useState(true);
  const [isLoadingMoreNotes, setIsLoadingMoreNotes] = useState(false);
  const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState({});
  const [projects, setProjects] = useState([]);
  const [openCardMenuId, setOpenCardMenuId] = useState(null);
  const [openCardMenuPlacement, setOpenCardMenuPlacement] = useState("down");
  const [openAttachmentNotesCardId, setOpenAttachmentNotesCardId] = useState(null);
  const [openAttachmentNoteComposerCardId, setOpenAttachmentNoteComposerCardId] = useState(null);
  const [attachmentNoteComposerPosition, setAttachmentNoteComposerPosition] = useState(null);
  const [attachmentNoteDraft, setAttachmentNoteDraft] = useState("");
  const [attachmentNoteDraftSavedId, setAttachmentNoteDraftSavedId] = useState(null);
  const [isCardActionBusy, setIsCardActionBusy] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
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
    return "gemini-flash-latest";
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

  const fetchNotesBatch = useCallback(
    async (from, to) => {
      let { data, error } = await supabase
        .from("notes")
        .select("id, title, content, source, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .range(from, to);

      const missingSourceColumn =
        error &&
        (
          error.code === "PGRST204" ||
          error.message?.toLowerCase().includes("does not exist") ||
          error.message?.includes("Could not find")
        );

      if (missingSourceColumn) {
        ({ data, error } = await supabase
          .from("notes")
          .select("id, title, content, created_at, updated_at")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .range(from, to));
      }
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
    try {
      const { data, error } = await fetchNotesBatch(0, MEMORY_PAGE_SIZE - 1);

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
      }
    } catch (err) {
      setNotesError(err?.message || "Unable to load memories.");
      setHasMoreNotes(false);
    } finally {
      setIsLoadingNotes(false);
    }
  }, [fetchNotesBatch, user?.id]);

  const refreshProjects = useCallback(async () => {
    if (!user?.id) {
      setProjects([]);
      return;
    }
    const { data } = await supabase
      .from("omnia_projects")
      .select("id, name, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });
    setProjects(Array.isArray(data) ? data : []);
  }, [user?.id]);

  const loadMoreNotes = useCallback(async () => {
    if (!user?.id || isLoadingNotes || isLoadingMoreNotes || !hasMoreNotes) return;
    setIsLoadingMoreNotes(true);
    try {
      const from = notes.length;
      const to = from + MEMORY_PAGE_SIZE - 1;
      const { data, error } = await fetchNotesBatch(from, to);
      if (error) throw error;
      const list = Array.isArray(data) ? data : [];
      if (list.length === 0) {
        setHasMoreNotes(false);
        return;
      }
      setNotes((prev) => {
        const merged = [...prev, ...list];
        const deduped = [];
        const seen = new Set();
        for (const item of merged) {
          const id = String(item?.id || "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          deduped.push(item);
        }
        return deduped;
      });
      setHasMoreNotes(list.length === MEMORY_PAGE_SIZE);
    } catch {
      setHasMoreNotes(false);
      setNotesError((prev) => prev || "Some memories could not be loaded.");
    } finally {
      setIsLoadingMoreNotes(false);
    }
  }, [fetchNotesBatch, hasMoreNotes, isLoadingMoreNotes, isLoadingNotes, notes.length, user?.id]);

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
    if (loading) return;
    void refreshProjects();
  }, [loading, refreshProjects]);

  useEffect(() => {
    if (loading || !user?.id) return;
    let cancelled = false;
    const loadBoards = async () => {
      const { data: boards } = await supabase
        .from("omnia_boards")
        .select("id, title, project_id, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (cancelled || !boards?.length) {
        if (!cancelled) setBoardCards([]);
        return;
      }

      const boardIds = boards.map((b) => b.id);
      const { data: states } = await supabase
        .from("omnia_board_states")
        .select("board_id, state")
        .in("board_id", boardIds)
        .order("created_at", { ascending: false });

      const latestStateByBoard = {};
      for (const row of (states || [])) {
        if (!latestStateByBoard[row.board_id]) {
          latestStateByBoard[row.board_id] = row.state;
        }
      }

      const hasContent = (state) => {
        if (!state) return false;
        const blocksMap = state.blocks || {};
        const order = Array.isArray(state.blockOrder) ? state.blockOrder : Object.keys(blocksMap);
        return order.some((id) => {
          const b = blocksMap[id];
          if (!b) return false;
          const data = b?.data && typeof b.data === "object" ? b.data : {};
          const content = String(data.content ?? data.body ?? b?.content ?? "").trim();
          const fmt = String(b?.format || data.format || "").toLowerCase();
          if (["media", "calendar", "table", "button"].includes(fmt)) return true;
          return content.length > 0;
        });
      };

      const filtered = boards.filter((b) => {
        const state = latestStateByBoard[b.id];
        return hasContent(state);
      });

      if (cancelled) return;
      setBoardCards(
        filtered.map((b) => ({
          id: `board-${b.id}`,
          boardId: b.id,
          kind: "board",
          title: b.title || "Untitled Board",
          projectId: b.project_id,
          dateLabel: b.updated_at
            ? new Date(b.updated_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
            : "",
        }))
      );
    };
    loadBoards();
    return () => { cancelled = true; };
  }, [loading, user?.id]);

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

    return cards;
  }, [notes]);

  useEffect(() => {
    if (!user?.id || memoryCards.length === 0) return;
    let isActive = true;

    const resolvePrivateAttachmentUrls = async () => {
      const nextResolved = {};
      const attachmentCards = memoryCards.filter((card) => card?.kind === "attachment");

      for (const card of attachmentCards) {
        const target = parseStorageTarget(card.attachment || {});
        if (!target?.path || !target?.bucket) continue;
        const cacheKey = `${target.bucket}:${target.path}`;
        if (signedUrlCacheRef.current.has(cacheKey)) {
          nextResolved[card.id] = signedUrlCacheRef.current.get(cacheKey);
          continue;
        }
        const { data, error } = await supabase.storage
          .from(target.bucket)
          .createSignedUrl(target.path, 60 * 60 * 24);
        if (error || !data?.signedUrl) continue;
        signedUrlCacheRef.current.set(cacheKey, data.signedUrl);
        nextResolved[card.id] = data.signedUrl;
      }

      if (!isActive || Object.keys(nextResolved).length === 0) return;
      setResolvedAttachmentUrls((prev) => ({ ...prev, ...nextResolved }));
    };

    void resolvePrivateAttachmentUrls();
    return () => {
      isActive = false;
    };
  }, [memoryCards, user?.id]);

  const visibleCards = useMemo(() => {
    if (activeMemoryPage === "boards") {
      return boardCards;
    }
    return memoryCards.filter((card) => card.kind !== "chat-preview");
  }, [activeMemoryPage, memoryCards, boardCards]);

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
    const currentOrder = orderByPage[activeMemoryPage] || [];
    const visibleMap = new Map(filteredVisibleCards.map((card) => [card.id, card]));
    const ordered = currentOrder.map((id) => visibleMap.get(id)).filter(Boolean);
    const remaining = filteredVisibleCards.filter((card) => !currentOrder.includes(card.id));
    return [...ordered, ...remaining];
  }, [activeMemoryPage, filteredVisibleCards, orderByPage]);

  const reorderActivePage = useCallback(
    (dragId, overId) => {
      if (!dragId || !overId || dragId === overId) return;
      setOrderByPage((prev) => {
        const pageKey = activeMemoryPage;
        const pageOrder = prev[pageKey] || [];
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
        return { ...prev, [pageKey]: next };
      });
    },
    [activeMemoryPage, orderedVisibleCards]
  );

  const handleSaveQuickNote = async () => {
    if (!user?.id || isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;

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
          source: "quick_note",
        })
        .select("id, title, content, source, created_at, updated_at")
        .single());

      const missingColumnError =
        noteError &&
        (
          noteError.code === "PGRST204" ||
          noteError.message?.includes("Could not find") ||
          noteError.message?.toLowerCase().includes("does not exist")
        );

      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await supabase
          .from("notes")
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

      setQuickNoteContent("");
      setShowQuickNote(false);
      setNotes((prev) => [insertedNote, ...prev]);
    } catch (error) {
      setNotesError(error?.message || "Unable to save quick note.");
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
          if (next[idx]) next[idx] = { ...next[idx], content: "Sorry - the AI request failed. Please try again." };
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
        />
      );
    }

    if (type === "video") {
      return (
        <video
          src={resolvedUrl}
          className="w-full h-auto max-h-[42rem] rounded-2xl"
          controls
          preload="metadata"
          draggable={false}
        />
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
      const videoId = extractYouTubeVideoId(String(attachment.url || ""));
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

      setProjects((prev) => [project, ...prev]);
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
      setOpenCardMenuId(cardId);
      return;
    }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldOpenUp =
      spaceBelow < menuEstimatedHeight && spaceAbove > spaceBelow;

    setOpenCardMenuPlacement(shouldOpenUp ? "up" : "down");
    setOpenCardMenuId(cardId);
  }, []);

  if ((loading || isLoadingNotes) && user) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div className={`min-h-screen bg-transparent text-black relative overflow-x-hidden`}>
      <DragDropFileUpload
        triggerRef={addMediaTriggerRef}
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
                  <SelectItem value="gpt-5.2">GPT-5.2 (Latest)</SelectItem>
                  <SelectItem value="gpt-5.1">GPT-5.1</SelectItem>
                  <SelectItem value="gpt-5">GPT-5</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                  <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="claude-opus-4-1-20250805">Claude Opus 4.1</SelectItem>
                  <SelectItem value="claude-opus-4-20250514">Claude Opus 4</SelectItem>
                  <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                  <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5</SelectItem>
                  <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                  <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
                  <SelectItem value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</SelectItem>
                  <SelectItem value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash Image</SelectItem>
                  <SelectItem value="gemini-2.5-flash-live-preview">Gemini 2.5 Flash Live</SelectItem>
                  <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                  <SelectItem value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</SelectItem>
                  <SelectItem value="grok-4-1-fast-reasoning">Grok 4.1 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-code-fast-1">Grok Code Fast 1</SelectItem>
                  <SelectItem value="grok-4-fast-reasoning">Grok 4 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-fast-non-reasoning">Grok 4 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-4-0709">Grok 4 0709</SelectItem>
                  <SelectItem value="grok-3-mini">Grok 3 Mini</SelectItem>
                  <SelectItem value="grok-3">Grok 3</SelectItem>
                  <SelectItem value="grok-2-vision-1212">Grok 2 Vision 1212</SelectItem>
                  <SelectItem value="grok-imagine-image-pro">Grok Imagine Image Pro</SelectItem>
                  <SelectItem value="grok-imagine-image">Grok Imagine Image</SelectItem>
                  <SelectItem value="grok-2-image-1212">Grok 2 Image 1212</SelectItem>
                  <SelectItem value="grok-imagine-video">Grok Imagine Video</SelectItem>
                  <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
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
              <h1 className="text-3xl font-semibold">Media</h1>
              <p className="text-black/60 mt-1">
                Your digital collage of media files, videos, images, and quick notes. Drag and drop files or folders anywhere on this page.
              </p>
            </>
          )}
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <div className="inline-flex items-center gap-1 p-1 rounded-full glass-control">
              <button
                type="button"
                onClick={() => setActiveMemoryPage("everything")}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  activeMemoryPage === "everything" ? "bg-white/50 text-black" : "text-black/65 hover:text-black"
                }`}
              >
                Media
              </button>
              <button
                type="button"
                onClick={() => setActiveMemoryPage("boards")}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  activeMemoryPage === "boards" ? "bg-white/50 text-black" : "text-black/65 hover:text-black"
                }`}
              >
                Boards
              </button>
            </div>
          </div>
        </section>

        {!user && !loading && (
          <div className="glass-control rounded-2xl px-5 py-4 inline-block">
            <p className="text-sm text-black/70">Sign in to view your memory board.</p>
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
                <button
                  type="button"
                  onClick={() => addMediaTriggerRef.current?.()}
                  className="group/add break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 hover:border-blue-500/50 p-6 flex flex-col items-center justify-center text-center transition-all hover:bg-blue-500/[0.04] dark:hover:bg-blue-400/[0.04] w-full sm:w-64 min-h-[160px]"
                >
                  <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mb-3 group-hover/add:bg-blue-500/20 transition-colors">
                    <Plus className="w-6 h-6 text-blue-500" />
                  </div>
                  <span className="text-sm font-medium text-black/40 dark:text-white/40 group-hover/add:text-blue-500 transition-colors">
                    Add Media
                  </span>
                </button>
                {(embeddedSearch.trim() || activeMemoryPage === "boards") && (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70">
                      {embeddedSearch.trim()
                        ? "No results match your search."
                        : "No boards yet. Create a board inside a project to get started."}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className={isEmbeddedMode ? "columns-2 gap-3" : "columns-1 sm:columns-2 md:columns-3 xl:columns-4 2xl:columns-5 gap-4 md:gap-5"}>
                <button
                  type="button"
                  onClick={() => addMediaTriggerRef.current?.()}
                  className="group/add break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 hover:border-blue-500/50 p-6 flex flex-col items-center justify-center text-center transition-all hover:bg-blue-500/[0.04] dark:hover:bg-blue-400/[0.04] min-h-[160px]"
                >
                  <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mb-3 group-hover/add:bg-blue-500/20 transition-colors">
                    <Plus className="w-6 h-6 text-blue-500" />
                  </div>
                  <span className="text-sm font-medium text-black/40 dark:text-white/40 group-hover/add:text-blue-500 transition-colors">
                    Add Media
                  </span>
                </button>
                {orderedVisibleCards.map((card) => (
                  <article
                    key={card.id}
                    data-memory-card-id={card.id}
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
                      card.kind === "chat-preview" || card.kind === "board" ? "overflow-hidden" : "overflow-visible"
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
                        : openCardMenuId === card.id
                        ? "z-[120]"
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
                          <div className="relative" ref={openCardMenuId === card.id ? cardMenuRef : null}>
                            <button
                              type="button"
                              data-no-drag="true"
                              draggable={false}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                              }}
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
                              title="Media actions"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                            {openCardMenuId === card.id && (
                              <div
                                className={`absolute right-0 w-56 rounded-2xl border border-white/60 bg-white/85 dark:bg-[#171515]/85 backdrop-blur-xl shadow-2xl p-2 z-[130] ${
                                  openCardMenuPlacement === "up" ? "bottom-full mb-2" : "top-full mt-2"
                                }`}
                                data-no-drag="true"
                                draggable={false}
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60">Add to project</div>
                                <div className="space-y-1">
                                  <button
                                    type="button"
                                    data-no-drag="true"
                                    draggable={false}
                                    disabled={isCardActionBusy}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={() => {
                                      void createProjectFromCard(card);
                                    }}
                                    className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                    New project
                                  </button>
                                  <div className="my-1 h-px bg-black/10" />
                                  <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                                    {projects.length === 0 ? (
                                      <div className="px-2 py-1.5 text-[0.6875rem] text-black/55">
                                        No projects found.
                                      </div>
                                    ) : (
                                      projects.map((project) => (
                                        <button
                                          key={project.id}
                                          type="button"
                                          data-no-drag="true"
                                          draggable={false}
                                          disabled={isCardActionBusy}
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={() => {
                                            void addCardToProject(card, project.id);
                                          }}
                                          className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 disabled:opacity-60 truncate"
                                          title={project.name}
                                        >
                                          {project.name}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                </div>
                                <div className="my-1 h-px bg-black/10" />
                                <button
                                  type="button"
                                  data-no-drag="true"
                                  draggable={false}
                                  disabled={isCardActionBusy}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    const articleEl = e.currentTarget.closest("[data-memory-card-id]");
                                    const rect = articleEl?.getBoundingClientRect() || null;
                                    openAttachmentComposerForCard(card.id, rect);
                                  }}
                                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2"
                                >
                                  <StickyNote className="w-3.5 h-3.5" />
                                  Note
                                </button>
                                <div className="my-1 h-px bg-black/10" />
                                <button
                                  type="button"
                                  data-no-drag="true"
                                  draggable={false}
                                  disabled={isCardActionBusy}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={() => {
                                    confirmAndDeleteAttachment(card);
                                  }}
                                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2 text-red-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    ) : card.kind === "board" ? (
                      <button
                        type="button"
                        onClick={() => nav(`/canvas/${card.boardId}`)}
                        className="w-full text-left p-4 space-y-3"
                      >
                        <div className="flex items-center gap-2">
                          <LayoutGrid className="w-4 h-4 text-blue-500 shrink-0" />
                          <h2 className="text-sm font-semibold text-black/90 dark:text-white/90 truncate">{card.title}</h2>
                        </div>
                        {card.dateLabel && (
                          <div className="text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{card.dateLabel}</span>
                          </div>
                        )}
                      </button>
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
                          <div className="relative" ref={openCardMenuId === card.id ? cardMenuRef : null}>
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
                            {openCardMenuId === card.id && (
                              <div
                                className={`absolute right-0 w-56 rounded-2xl border border-white/60 bg-white/85 dark:bg-[#171515]/85 backdrop-blur-xl shadow-2xl p-2 z-[130] ${
                                  openCardMenuPlacement === "up" ? "bottom-full mb-2" : "top-full mt-2"
                                }`}
                                data-no-drag="true"
                                draggable={false}
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60">Add to project</div>
                                <div className="space-y-1">
                                  <button
                                    type="button"
                                    data-no-drag="true"
                                    draggable={false}
                                    disabled={isCardActionBusy}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={() => {
                                      void createProjectFromCard(card);
                                    }}
                                    className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                    New project
                                  </button>
                                  <div className="my-1 h-px bg-black/10" />
                                  <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                                    {projects.length === 0 ? (
                                      <div className="px-2 py-1.5 text-[0.6875rem] text-black/55">
                                        No projects found.
                                      </div>
                                    ) : (
                                      projects.map((project) => (
                                        <button
                                          key={project.id}
                                          type="button"
                                          data-no-drag="true"
                                          draggable={false}
                                          disabled={isCardActionBusy}
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={() => {
                                            void addCardToProject(card, project.id);
                                          }}
                                          className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 disabled:opacity-60 truncate"
                                          title={project.name}
                                        >
                                          {project.name}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                </div>
                                <div className="my-1 h-px bg-black/10" />
                                <button
                                  type="button"
                                  data-no-drag="true"
                                  draggable={false}
                                  disabled={isCardActionBusy}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={() => {
                                    const ok = window.confirm(`Are you sure you want to delete "${card.title || "Quick Note"}"? This cannot be undone.`);
                                    if (!ok) return;
                                    void removeQuickNoteCard(card);
                                  }}
                                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 disabled:opacity-60 flex items-center gap-2 text-red-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
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
    </div>
  );
}
