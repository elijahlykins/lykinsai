import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, BookOpen, ChevronDown, ChevronUp, Clock, Edit2, FileText, Folder as FolderIcon, Image as ImageIcon, Link2, MessageSquare, Mic, MoreHorizontal, Music, Play, Plus, StickyNote, Trash2, Video, Volume2, X } from "lucide-react";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/canvas/utils/youtube";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import RichTextRenderer from "@/components/notes/RichTextRenderer";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getAiPrefs } from "@/lib/ai-prefs";
import { useQuery } from "@tanstack/react-query";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const TYPING_DELAY_MS = 14;
const BASE_ROTATING_PHRASES = [
  "Ask me anything.",
  "Ready when you are.",
  "How can I help today?",
  "What's on your mind?",
  "Where should we begin.",
];

const CHAT_TO_BOARD_IMPORT_KEY = "omnia_chat_board_import_v1";
const CANVAS_TO_CHAT_HANDOFF_KEY = "omnia_canvas_to_chat_handoff_v1";
const CHAT_ATTACHMENTS_PERSIST_KEY = "omnia_chat_attachments_v1";
const CHAT_MESSAGES_PERSIST_KEY = "omnia_chat_messages_v1";
const MEMORY_DRAG_MIME = "application/x-lykins-memory-card";
const OMNIA_MEMORY_MIME = "application/x-omnia-memory";
const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;
const FILE_ATTACHMENT_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "heic",
  "heif",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "aac",
  "flac",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "csv",
  "txt",
  "md",
  "json",
]);

const isYouTubeUrl = (url = "") =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());

const getUrlExtension = (url = "") => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return String(fileName.split(".").pop() || "").toLowerCase();
  } catch {
    const noQuery = raw.split("?")[0].split("#")[0];
    const fileName = decodeURIComponent(noQuery.split("/").pop() || "");
    return String(fileName.split(".").pop() || "").toLowerCase();
  }
};

const inferAttachmentType = (mime = "", fileName = "") => {
  const m = String(mime || "").toLowerCase();
  const ext = String(fileName || "").split(".").pop()?.toLowerCase() || "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv"].includes(ext)) return "sheet";
  if (["ppt", "pptx"].includes(ext)) return "slide";
  return "file";
};

const inferUrlAttachmentType = (url = "") => {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (isYouTubeUrl(trimmed)) return "youtube";
  const ext = getUrlExtension(trimmed);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (FILE_ATTACHMENT_EXTS.has(ext)) return "file";
  return "link";
};

const extractDroppedUrls = (dataTransfer) => {
  if (!dataTransfer) return [];
  const uri = String(dataTransfer.getData("text/uri-list") || "");
  const plain = String(dataTransfer.getData("text/plain") || "");
  const html = String(dataTransfer.getData("text/html") || "");
  const out = [];
  for (const line of uri.split("\n")) {
    const value = String(line || "").trim();
    if (value && !value.startsWith("#")) out.push(value);
  }
  for (const match of plain.match(/https?:\/\/[^\s<>"')]+/gi) || []) out.push(String(match || "").trim());
  for (const match of html.match(/href=["']([^"']+)["']/gi) || []) {
    const value = String(match || "").replace(/^href=["']|["']$/gi, "").trim();
    if (value) out.push(value);
  }
  return Array.from(new Set(out.filter(Boolean)));
};

const isValidCanvasHandoff = (payload) => {
  if (!payload || typeof payload !== "object") return false;
  if (String(payload.source || "") !== "canvas-page") return false;
  const createdAt = Number(payload.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  return Date.now() - createdAt <= 30 * 60 * 1000;
};

const flattenNodeText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => flattenNodeText(child)).join("");
  if (React.isValidElement(node)) return flattenNodeText(node.props?.children);
  return "";
};

const normalizeChecklistSyntax = (value) =>
  String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");

const buildPromptPairsForBoardImport = (messages) => {
  const prompts = [];
  let currentPrompt = null;

  messages.forEach((msg, idx) => {
    const role = String(msg?.role || "");
    const content = String(msg?.content || "").trim();
    if (!content) return;

    if (role === "user") {
      currentPrompt = {
        id: `import-prompt-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content,
        kind: "prompt",
      };
      prompts.push(currentPrompt);
      return;
    }

    if (role === "assistant" && currentPrompt) {
      currentPrompt.aiResponse = currentPrompt.aiResponse
        ? `${currentPrompt.aiResponse}\n\n${content}`
        : content;
    }
  });

  return prompts;
};

const extractTodoListsForBoardImport = (messages) => {
  const lists = [];
  let listCounter = 0;

  messages.forEach((msg) => {
    const text = String(msg?.content || "");
    if (!text.trim()) return;
    const roleLabel = String(msg?.role || "") === "assistant" ? "AI" : "User";
    const lines = text.split(/\r?\n/);
    let currentItems = [];

    const flush = () => {
      if (!currentItems.length) return;
      listCounter += 1;
      lists.push({
        id: `todo-list-${listCounter}`,
        title: `${roleLabel} To-do List ${listCounter}`,
        items: currentItems,
      });
      currentItems = [];
    };

    lines.forEach((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) {
        flush();
        return;
      }
      currentItems.push({
        text: String(match[2] || "").trim(),
        checked: String(match[1] || "").toLowerCase() === "x",
      });
    });

    flush();
  });

  return lists;
};

const stripAttachmentMetadata = (content = "") => {
  let text = String(content || "");
  const marker = "\n\n---ATTACHMENTS---\n";
  const idx = text.indexOf(marker);
  if (idx !== -1) text = text.slice(0, idx).trim();

  const startMarker = "[ATTACHMENTS_JSON:";
  const startIndex = text.indexOf(startMarker);
  if (startIndex !== -1) {
    const jsonStart = startIndex + startMarker.length;
    let bracketCount = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < text.length; i += 1) {
      if (text[i] === "[") bracketCount += 1;
      if (text[i] === "]") {
        bracketCount -= 1;
        if (bracketCount === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (jsonEnd > jsonStart) {
      text = `${text.substring(0, startIndex)}${text.substring(jsonEnd)}`.replace(/\n\n\n+/g, "\n\n").trim();
    }
  }
  return text;
};

const parseAttachmentsFromContent = (content = "") => {
  const text = String(content || "");
  const startMarker = "[ATTACHMENTS_JSON:";
  const startIndex = text.indexOf(startMarker);
  if (startIndex === -1) return [];
  const jsonStart = startIndex + startMarker.length;
  let bracketCount = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < text.length; i += 1) {
    if (text[i] === "[") bracketCount += 1;
    if (text[i] === "]") {
      bracketCount -= 1;
      if (bracketCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd <= jsonStart) return [];
  try {
    const parsed = JSON.parse(text.substring(jsonStart, jsonEnd));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const formatMemoryCardDate = (note) => {
  const raw = note?.created_at || note?.updated_at;
  if (!raw) return "No date";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "No date";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function ChatPage() {
  const nav = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [typedWelcome, setTypedWelcome] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [attachments, setAttachments] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState({});
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [showMemorySidebar, setShowMemorySidebar] = useState(false);
  const {
    data: memoryNotes = [],
    isLoading: memoryLoading,
    error: memoryQueryError,
  } = useQuery({
    queryKey: ["memory-notes", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notes")
        .select("id, title, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return Array.isArray(data)
        ? data.map((note) => {
            const directAttachments = Array.isArray(note?.attachments) ? note.attachments : [];
            const parsedAttachments = parseAttachmentsFromContent(note?.content || "");
            return { ...note, attachments: directAttachments.length ? directAttachments : parsedAttachments };
          })
        : [];
    },
    enabled: !!user?.id && showMemorySidebar,
    staleTime: 30_000,
  });
  const memoryError = memoryQueryError ? String(memoryQueryError?.message || "Unable to load memories.") : "";
  const [memorySearch, setMemorySearch] = useState("");
  const [interactionNote, setInteractionNote] = useState(null);
  const DialogAny = /** @type {any} */ (Dialog);
  const DialogContentAny = /** @type {any} */ (DialogContent);
  const DialogHeaderAny = /** @type {any} */ (DialogHeader);
  const DialogTitleAny = /** @type {any} */ (DialogTitle);
  const DialogDescriptionAny = /** @type {any} */ (DialogDescription);
  const scrollRef = useRef(null);
  const composerInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const canvasHandoffAppliedRef = useRef(false);
  const thinkingStatus = useThinkingStatus(isLoading);

  const rotatingPhrases = useMemo(() => {
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const preferredName = String(firstName || emailName || "there").trim();
    return [`Welcome back, ${preferredName}`, ...BASE_ROTATING_PHRASES];
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  useEffect(() => {
    const syncModelFromSettings = () => {
      try {
        const raw = localStorage.getItem("lykinsai_settings");
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.aiModel) setSelectedModel(String(parsed.aiModel));
      } catch {
        // ignore malformed settings
      }
    };
    syncModelFromSettings();
    window.addEventListener("storage", syncModelFromSettings);
    window.addEventListener("lykinsai_settings_changed", syncModelFromSettings);
    return () => {
      window.removeEventListener("storage", syncModelFromSettings);
      window.removeEventListener("lykinsai_settings_changed", syncModelFromSettings);
    };
  }, []);

  useEffect(() => {
    if (canvasHandoffAppliedRef.current) return;

    let payload = null;
    const statePayload = location.state?.canvasChatHandoff;
    if (isValidCanvasHandoff(statePayload)) {
      payload = statePayload;
    } else {
      try {
        const raw = localStorage.getItem(CANVAS_TO_CHAT_HANDOFF_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isValidCanvasHandoff(parsed)) payload = parsed;
        }
      } catch {
        // ignore malformed local payloads
      }
    }

    if (!payload) return;
    canvasHandoffAppliedRef.current = true;

    const importedMessages = Array.isArray(payload.messages)
      ? payload.messages
          .map((msg) => {
            const role = msg?.role === "assistant" ? "assistant" : msg?.role === "user" ? "user" : null;
            const content = String(msg?.content || "").trim();
            if (!role || !content) return null;
            return { role, content, ...(Array.isArray(msg?.attachments) && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}) };
          })
          .filter(Boolean)
      : [];

    const draftInput = String(payload.draftInput || "").trim();
    const handoffAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (importedMessages.length > 0) {
      setMessages(importedMessages);
    }
    if (draftInput) {
      setInput(draftInput);
    }
    if (handoffAttachments.length > 0) {
      setAttachments(handoffAttachments);
      setAttachmentCount(handoffAttachments.length);
    }

    try {
      localStorage.removeItem(CANVAS_TO_CHAT_HANDOFF_KEY);
      localStorage.removeItem(CHAT_MESSAGES_PERSIST_KEY);
    } catch {
      // ignore cleanup failures
    }
  }, [location.state]);

  useEffect(() => {
    if (attachments.length > 0 || canvasHandoffAppliedRef.current) return;
    try {
      const raw = localStorage.getItem(CHAT_ATTACHMENTS_PERSIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAttachments(parsed);
          setAttachmentCount(parsed.length);
        }
        localStorage.removeItem(CHAT_ATTACHMENTS_PERSIST_KEY);
      }
    } catch { /* ignore */ }

    try {
      const rawMsgs = localStorage.getItem(CHAT_MESSAGES_PERSIST_KEY);
      if (rawMsgs) {
        const parsedMsgs = JSON.parse(rawMsgs);
        if (Array.isArray(parsedMsgs) && parsedMsgs.length > 0) {
          setMessages(parsedMsgs);
        }
        localStorage.removeItem(CHAT_MESSAGES_PERSIST_KEY);
      }
    } catch { /* ignore */ }
  }, []);

  const updateSelectedModel = (value) => {
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
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [isLoading]);

  useEffect(() => {
    if (!rotatingPhrases.length) return;
    const text = rotatingPhrases[Math.floor(Math.random() * rotatingPhrases.length)];
    setTypedWelcome("");
    if (!text) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedWelcome(text.slice(0, i));
      if (i >= text.length) window.clearInterval(timer);
    }, 52);
    return () => window.clearInterval(timer);
  }, [rotatingPhrases]);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    const hasSupportedDropData = (event) => {
      const types = event?.dataTransfer?.types;
      if (!types) return false;
      const allTypes = Array.from(types);
      return (
        allTypes.includes("Files") ||
        allTypes.includes("text/uri-list") ||
        allTypes.includes("text/plain") ||
        allTypes.includes(MEMORY_DRAG_MIME) ||
        allTypes.includes(OMNIA_MEMORY_MIME)
      );
    };
    const win = /** @type {any} */ (window);
    const onWindowDragEnter = (event) => {
      if (!hasSupportedDropData(event) && !win.__omnia_pending_memory) return;
      event.preventDefault();
      setIsDragOver(true);
    };
    const onWindowDragOver = (event) => {
      if (!hasSupportedDropData(event) && !win.__omnia_pending_memory) return;
      event.preventDefault();
      setIsDragOver(true);
    };
    const onWindowDragLeave = (event) => {
      if (!hasSupportedDropData(event) && !win.__omnia_pending_memory) return;
      event.preventDefault();
      setIsDragOver(false);
    };
    const onWindowDrop = (event) => {
      event.preventDefault();
      setIsDragOver(false);
      handleDropPayload(event);
    };

    win.addEventListener("dragenter", onWindowDragEnter);
    win.addEventListener("dragover", onWindowDragOver);
    win.addEventListener("dragleave", onWindowDragLeave);
    win.addEventListener("drop", onWindowDrop);

    const onMessage = (event) => {
      if (event.data?.type === "omnia-memory-drag-start") {
        win.__omnia_pending_memory = event.data.data;
      } else if (event.data?.type === "omnia-memory-drag-end") {
        // Cleaned up after drop in handleDropPayload
      }
    };
    win.addEventListener("message", onMessage);

    return () => {
      win.removeEventListener("dragenter", onWindowDragEnter);
      win.removeEventListener("dragover", onWindowDragOver);
      win.removeEventListener("dragleave", onWindowDragLeave);
      win.removeEventListener("drop", onWindowDrop);
      win.removeEventListener("message", onMessage);
    };
  }, []);

  const conversation = useMemo(
    () =>
      messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    [messages]
  );

  const filteredMemoryNotes = useMemo(() => {
    const query = String(memorySearch || "").trim().toLowerCase();
    const visibleNotes = memoryNotes.filter((note) => !note?.trashed);
    if (!query) return visibleNotes;
    return visibleNotes.filter((note) => {
      const title = String(note?.title || "").toLowerCase();
      const content = String(note?.content || "").toLowerCase();
      const folder = String(note?.folder || "").toLowerCase();
      return title.includes(query) || content.includes(query) || folder.includes(query);
    });
  }, [memoryNotes, memorySearch]);

  const memoryNotesByFolder = useMemo(() => {
    const grouped = filteredMemoryNotes.reduce((acc, note) => {
      const folderName = String(note?.folder || "Uncategorized").trim() || "Uncategorized";
      if (!acc[folderName]) acc[folderName] = [];
      acc[folderName].push(note);
      return acc;
    }, {});
    const sortedFolders = Object.keys(grouped).sort((a, b) => {
      if (a === "Uncategorized") return 1;
      if (b === "Uncategorized") return -1;
      return a.localeCompare(b);
    });
    return { grouped, sortedFolders };
  }, [filteredMemoryNotes]);

  const sendMessage = async () => {
    const text = String(input || "").trim();
    if (!text || isLoading) return;

    const userAttachments = attachments.slice();

    // Fetch transcripts for any YouTube attachments that don't have one yet
    const { API_BASE_URL } = await import("@/lib/api-config");
    await Promise.all(
      userAttachments.map(async (att) => {
        if (att.type !== "youtube" || att.transcript) return;
        const vid = att.videoId || extractYouTubeVideoId(att.url || "");
        if (!vid) return;
        try {
          const resp = await fetch(`${API_BASE_URL}/api/youtube/transcript?id=${encodeURIComponent(vid)}`);
          if (resp.ok) {
            const data = await resp.json();
            if (data?.transcript) att.transcript = data.transcript;
          }
        } catch { /* proceed without transcript */ }
      })
    );

    // Extract text from PDF attachments that don't have pdfText yet
    await Promise.all(
      userAttachments.map(async (att) => {
        if (att.pdfText || att.extractedText) return;
        const isPdf = att.type === "pdf" || att.mime === "application/pdf" ||
          /\.pdf(\?|$)/i.test(att.url || "") || /\.pdf$/i.test(att.name || "");
        if (!isPdf || !att.url) return;
        try {
          const resp = await fetch(att.url);
          if (!resp.ok) return;
          const bytes = await resp.arrayBuffer();
          const [pdfjsLegacy, workerUrlMod] = await Promise.all([
            import("pdfjs-dist/legacy/build/pdf.mjs"),
            import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
          ]);
          if (pdfjsLegacy?.GlobalWorkerOptions) {
            pdfjsLegacy.GlobalWorkerOptions.workerSrc = String(workerUrlMod?.default || "");
          }
          const loadingTask = pdfjsLegacy.getDocument({ data: bytes });
          const pdf = await loadingTask.promise;
          const pageCount = Number(pdf?.numPages || 0);
          const maxPages = Math.min(pageCount, 20);
          const pages = [];
          for (let p = 1; p <= maxPages; p++) {
            try {
              const page = await pdf.getPage(p);
              const tc = await page.getTextContent();
              const text = (tc?.items || []).map((/** @type {any} */ i) => i?.str || "").join(" ").trim();
              if (text) pages.push(`--- Page ${p} ---\n${text}`);
            } catch { /* skip page */ }
          }
          if (pages.length > 0) {
            att.pdfText = pages.join("\n\n");
          }
        } catch { /* proceed without PDF text */ }
      })
    );

    const userMessage = { role: "user", content: text, attachments: userAttachments };
    const assistantMessageIndex = messages.length + 1;
    setMessages((prev) => [...prev, userMessage, { role: "assistant", content: "" }]);
    setInput("");
    setAttachments([]);
    setIsLoading(true);

    try {
      const attachmentContext = userAttachments
        .map((att) => {
          const parts = [];
          const label = att.memoryTitle || att.name || "";
          if (att.type === "youtube" && att.transcript) {
            parts.push(`[YouTube Video: ${label}]`);
            parts.push(`Transcript:\n${att.transcript}`);
          } else if (att.type === "youtube" && att.videoId) {
            parts.push(`[YouTube Video: ${label}] (video ID: ${att.videoId}, no transcript available)`);
          } else if (att.transcript) {
            parts.push(`[Video/Audio: ${label}]`);
            parts.push(`Transcript:\n${att.transcript}`);
          } else if (att.pdfText) {
            parts.push(`[Document: ${label}]`);
            parts.push(`Content:\n${att.pdfText}`);
          } else if (att.type === "memory" && att.memoryContent) {
            parts.push(`[Memory: ${label}]`);
            parts.push(att.memoryContent);
          }
          return parts.join("\n");
        })
        .filter(Boolean)
        .join("\n\n---\n\n");

      const prompt = attachmentContext
        ? `${text}\n\n[Attached content from the user's memories — use this to answer their question]\n${attachmentContext}`
        : text;

      const imageUrls = userAttachments
        .filter((a) => a.type === "image" && a.url)
        .map((a) => a.url);

      if (imageUrls.length > 0) {
        console.log(`🖼️ Sending ${imageUrls.length} image(s) to AI:`, imageUrls.map((u) => u.slice(0, 60)));
      }

      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel || DEFAULT_MODEL,
          intent: "ask",
          text: prompt,
          prompt,
          attachments: userAttachments,
          imageUrls,
          conversation: [...conversation, { ...userMessage, content: prompt }],
          returnActions: false,
          ...getAiPrefs(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errText = "This model isn\u2019t working properly right now \u2014 try another model.";
        setMessages((prev) => {
          const next = [...prev];
          next[assistantMessageIndex] = { role: "assistant", content: errText };
          return next;
        });
        return;
      }

      const reply = String(data?.response || "").trim() || "No response returned.";
      let currentText = "";
      for (let i = 0; i < reply.length; i++) {
        currentText += reply[i];
        setMessages((prev) => {
          const next = [...prev];
          next[assistantMessageIndex] = { role: "assistant", content: currentText };
          return next;
        });
        await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));
      }
    } catch {
      setMessages((prev) => {
        const next = [...prev];
        next[assistantMessageIndex] = {
          role: "assistant",
          content: "This model isn\u2019t working properly right now \u2014 try another model.",
        };
        return next;
      });
    } finally {
      setIsLoading(false);
      setAttachmentCount(0);
    }
  };

  const handleOpenAttachments = () => {
    fileInputRef.current?.click();
  };


  const useMemoryInChat = (note) => {
    const titleText = String(note?.title || "Untitled memory").trim() || "Untitled memory";
    const noteBody = stripAttachmentMetadata(String(note?.content || "").trim());
    const injected = noteBody ? `Use this memory as context:\n[${titleText}]\n${noteBody}` : `Use this memory as context:\n[${titleText}]`;
    setInput((prev) => {
      const base = String(prev || "").trim();
      return base ? `${base}\n\n${injected}` : injected;
    });
    setShowMemorySidebar(false);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== id);
      setAttachmentCount(next.length);
      return next;
    });
  };

  const attachFiles = (files = []) => {
    if (!Array.isArray(files) || files.length === 0) return;
    files.forEach((file) => {
      const f = file;
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const id =
          (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
          `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const attachment = {
          id,
          type: inferAttachmentType(f.type || "", f.name || ""),
          url: String(event?.target?.result || ""),
          name: f.name || "file",
          mime: f.type || "",
          size: Number(f.size || 0),
        };
        setAttachments((prev) => {
          const next = [...prev, attachment];
          setAttachmentCount(next.length);
          return next;
        });
      };
      reader.readAsDataURL(f);
    });
  };

  const attachUrl = (url) => {
    const trimmed = String(url || "").trim();
    if (!trimmed) return;
    const id =
      (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
      `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const attachment = {
      id,
      type: inferUrlAttachmentType(trimmed),
      url: trimmed,
      name: trimmed,
      mime: "",
      size: 0,
    };
    setAttachments((prev) => {
      const next = [...prev, attachment];
      setAttachmentCount(next.length);
      return next;
    });
  };

  const resolveSupabaseUrl = async (rawUrl, storagePath, storageBucket) => {
    if (rawUrl && (rawUrl.startsWith("http") || rawUrl.startsWith("data:"))) return rawUrl;
    const path = storagePath || rawUrl;
    const bucket = storageBucket || "user-files";
    if (!path) return rawUrl;
    try {
      const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
      if (data?.signedUrl) return data.signedUrl;
    } catch { /* ignore */ }
    return rawUrl;
  };

  const applyMemoryDrop = async (payload) => {
    if (!payload) return false;
    const title = String(payload.title || "Memory").trim();
    const content = String(payload.content || "").trim();
    const payloadAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (payloadAttachments.length > 0) {
      for (const att of payloadAttachments) {
        let url = String(att?.url || "").trim();
        if (!url) continue;
        const attType = String(att?.type || "").toLowerCase();
        const videoId = att?.videoId || (attType === "youtube" ? extractYouTubeVideoId(url) : "") || "";

        if (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube") {
          url = await resolveSupabaseUrl(url, att?.storagePath, att?.storageBucket);
        }

        const id =
          (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
          `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const transcript = String(att?.transcript || "").trim();
        const pdfText = String(att?.pdfText || att?.extractedText || "").trim();
        const newAtt = {
          id,
          type: attType || inferUrlAttachmentType(url),
          url,
          name: String(att?.name || att?.title || title || url).trim(),
          mime: String(att?.mime || ""),
          size: Number(att?.size || 0),
          memoryTitle: title,
          ...(videoId ? { videoId } : {}),
          ...(transcript ? { transcript } : {}),
          ...(pdfText ? { pdfText } : {}),
        };
        setAttachments((prev) => {
          const next = [...prev, newAtt];
          setAttachmentCount(next.length);
          return next;
        });
      }
    } else if (content) {
      const id =
        (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
        `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((prev) => {
        const next = [
          ...prev,
          { id, type: "memory", url: "", name: title || "Memory", mime: "", size: 0, memoryTitle: title, memoryContent: content },
        ];
        setAttachmentCount(next.length);
        return next;
      });
    }
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
    return true;
  };

  const handleDropPayload = async (event) => {
    const win = /** @type {any} */ (window);
    // 1. Cross-iframe memory drop via __omnia_pending_memory (set by postMessage or direct assignment)
    const pendingMemory = win.__omnia_pending_memory;
    if (pendingMemory && typeof pendingMemory === "object" && pendingMemory.timestamp) {
      const age = Date.now() - Number(pendingMemory.timestamp || 0);
      if (age < 30000) {
        await applyMemoryDrop(pendingMemory);
        win.__omnia_pending_memory = null;
        return;
      }
      win.__omnia_pending_memory = null;
    }

    // 2. application/x-omnia-memory MIME (same-window drags)
    let omniaRaw = "";
    try { omniaRaw = String(event?.dataTransfer?.getData?.(OMNIA_MEMORY_MIME) || ""); } catch {}
    if (omniaRaw) {
      try {
        if (await applyMemoryDrop(JSON.parse(omniaRaw))) return;
      } catch { /* fall through */ }
    }

    // 3. Legacy application/x-lykins-memory-card MIME
    const memoryPayloadRaw = String(event?.dataTransfer?.getData?.(MEMORY_DRAG_MIME) || "");
    if (memoryPayloadRaw) {
      try {
        if (await applyMemoryDrop(JSON.parse(memoryPayloadRaw))) return;
      } catch { /* fall through */ }
    }

    const files = Array.from(event?.dataTransfer?.files || []);
    if (files.length > 0) {
      attachFiles(files);
      return;
    }
    const urls = extractDroppedUrls(event?.dataTransfer);
    if (urls.length > 0) {
      urls.forEach((url) => attachUrl(url));
    }
  };

  const handleDictateToggle = () => {
    const stopRecorder = () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      mediaStreamRef.current = null;
    };

    const transcribeAudio = async (blob) => {
      if (!blob || blob.size <= 0) return;
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const formData = new FormData();
        formData.append("audio", blob, "dictation.webm");
        formData.append("model", "whisper-1");

        const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        const transcript = String(data?.text || "").trim();
        if (res.ok && transcript) {
          setInput((prev) => `${String(prev || "").trim()} ${transcript}`.trim());
        }
      } catch {
        // ignore transient dictation failures
      }
    };

    if (isDictating) {
      stopRecorder();
      setIsDictating(false);
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };
        recorder.onstop = async () => {
          setIsDictating(false);
          const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          audioChunksRef.current = [];
          await transcribeAudio(blob);
        };
        recorder.onerror = () => {
          setIsDictating(false);
        };
        recorder.start();
        setIsDictating(true);
      })
      .catch(() => {
        setIsDictating(false);
      });
  };

  const handleVoiceToggle = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const latestAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && String(m.content || "").trim());
    const textToRead = String(latestAssistant?.content || "").trim();
    if (!textToRead) return;

    const utterance = new SpeechSynthesisUtterance(textToRead);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.cancel();
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const handleSaveQuickNote = useCallback(async () => {
    if (!user?.id || isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;
    setIsQuickNoteSaving(true);
    try {
      const { error } = await supabase
        .from("notes")
        .insert({ user_id: user.id, title: "Quick Note", content, source: "quick_note" })
        .select("id")
        .single();
      if (error) {
        await supabase
          .from("notes")
          .insert({ user_id: user.id, title: "Quick Note", content })
          .select("id")
          .single();
      }
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch { /* ignore */ } finally {
      setIsQuickNoteSaving(false);
    }
  }, [user?.id, isQuickNoteSaving, quickNoteContent]);

  const handleCloseQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    if (!quickNoteContent.trim()) {
      setShowQuickNote(false);
      setQuickNoteContent("");
      return;
    }
    await handleSaveQuickNote();
  }, [handleSaveQuickNote, isQuickNoteSaving, quickNoteContent]);

  const hasMessages = messages.length > 0;

  const updateTaskCheck = (messageIndex, taskKey, checked) => {
    setAssistantTaskChecks((prev) => ({
      ...prev,
      [messageIndex]: {
        ...(prev[messageIndex] || {}),
        [taskKey]: checked,
      },
    }));
  };

  const handleSendChatToBoard = async () => {
    if (!user?.id) return;
    const prompts = buildPromptPairsForBoardImport(messages);
    const todoLists = extractTodoListsForBoardImport(messages);

    try {
      let boardTitle = `Chat Board ${new Date().toLocaleDateString()}`;
      const userMsgs = messages
        .filter((m) => m.role === "user" && String(m.content || "").trim())
        .map((m) => String(m.content).trim().slice(0, 200))
        .slice(0, 6)
        .join("\n");
      if (userMsgs) {
        try {
          const titleRes = await fetch("/api/ai/invoke", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o-mini", intent: "board_title", text: userMsgs }),
          });
          if (titleRes.ok) {
            const titleData = await titleRes.json();
            const raw = String(titleData?.response || "").trim();
            const cleaned = raw.replace(/^["']|["']$/g, "").replace(/\.+$/, "").trim();
            const words = cleaned.split(/\s+/).slice(0, 5).join(" ");
            if (words) boardTitle = words;
          }
        } catch { /* fall back to default title */ }
      }

      const { data: board, error: boardError } = await supabase
        .from("omnia_boards")
        .insert({ user_id: user.id, title: boardTitle })
        .select("id")
        .single();

      if (boardError || !board?.id) return;

      const allAttachments = [
        ...attachments,
        ...messages.flatMap((m) => (Array.isArray(m.attachments) ? m.attachments : [])),
      ];
      const seenIds = new Set();
      const dedupedAttachments = allAttachments.filter((a) => {
        if (!a?.id || seenIds.has(a.id)) return false;
        seenIds.add(a.id);
        return true;
      });

      const payload = {
        version: 1,
        createdAt: Date.now(),
        boardId: board.id,
        source: "chat-page",
        prompts,
        todoLists,
        attachments: dedupedAttachments,
      };
      localStorage.setItem(CHAT_TO_BOARD_IMPORT_KEY, JSON.stringify(payload));

      if (dedupedAttachments.length > 0) {
        try {
          localStorage.setItem(CHAT_ATTACHMENTS_PERSIST_KEY, JSON.stringify(dedupedAttachments));
        } catch { /* ignore quota errors */ }
      }

      try {
        localStorage.setItem(CHAT_MESSAGES_PERSIST_KEY, JSON.stringify(messages));
      } catch { /* ignore quota errors */ }

      localStorage.setItem("omnia_board_id", board.id);
      nav(`/canvas/${board.id}`);
    } catch {
      // ignore and keep user in chat
    }
  };


  const renderAttachmentPreview = (att) => {
    const t = String(att.type || "").toLowerCase();
    const videoId = att.videoId || (t === "youtube" ? extractYouTubeVideoId(att.url || "") : null);

    if (t === "youtube" && videoId) {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <img
            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
            alt={att.name || "YouTube"}
            className="w-full h-full object-cover"
            draggable={false}
          />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-red-600 rounded-lg flex items-center justify-center shadow-md">
              <Play className="w-3.5 h-3.5 text-white ml-0.5" fill="white" />
            </div>
          </div>
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">
            {att.memoryTitle || att.name || "YouTube Video"}
          </span>
        </div>
      );
    }

    if (t === "image") {
      return (
        <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-black/5 flex-shrink-0 group">
          <img
            src={att.url}
            alt={att.name || "Image"}
            className="w-full h-full object-cover"
            draggable={false}
          />
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }

    if (t === "video") {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <video
            src={att.url}
            className="w-full h-full object-cover"
            preload="metadata"
            muted
            draggable={false}
          />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-white/80 rounded-lg flex items-center justify-center shadow-md">
              <Play className="w-3.5 h-3.5 text-black ml-0.5" fill="black" />
            </div>
          </div>
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">
            {att.memoryTitle || att.name || "Video"}
          </span>
        </div>
      );
    }

    if (t === "audio") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 dark:bg-white/10 px-3 py-2 group">
          <Music className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[180px] truncate text-xs">{att.memoryTitle || att.name || "Audio"}</span>
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="h-4 w-4 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }

    if (t === "memory") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-violet-300/40 bg-violet-100/40 dark:bg-violet-900/20 px-3 py-2 max-w-[260px] group">
          <BookOpen className="w-4 h-4 flex-shrink-0 text-violet-500" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.memoryTitle || "Memory"}</span>
            {att.memoryContent && (
              <span className="block text-[0.625rem] opacity-60 truncate">{att.memoryContent.slice(0, 80)}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="h-4 w-4 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center flex-shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }

    if (t === "pdf") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 dark:bg-white/10 px-3 py-2 group">
          <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[180px] truncate text-xs">{att.memoryTitle || att.name || "PDF"}</span>
          <button
            type="button"
            onClick={() => removeAttachment(att.id)}
            className="h-4 w-4 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }

    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 dark:bg-white/10 px-3 py-2 group">
        <Link2 className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[200px] truncate text-xs">{att.memoryTitle || att.name || att.url || "Attachment"}</span>
        <button
          type="button"
          onClick={() => removeAttachment(att.id)}
          className="h-4 w-4 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  };

  const renderComposer = (autoFocus = false) => (
    <div className="glass-control rounded-2xl p-2 w-full transition-all duration-300">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 items-end">
          {attachments.map((att) => (
            <div key={att.id}>{renderAttachmentPreview(att)}</div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleOpenAttachments}
          className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          title={attachmentCount > 0 ? `${attachmentCount} attachment(s) selected` : "Add attachments"}
        >
          <Plus className="w-4 h-4" />
        </button>
        <input
          ref={composerInputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Ask me anything..."
          className="w-full h-11 rounded-xl bg-transparent border border-white/30 px-4 text-sm text-black placeholder:text-black/55 outline-none dark:text-white dark:placeholder:text-white/55"
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10 ${
            isDictating ? "bg-black/10 dark:bg-white/10 ring-1 ring-black/30 dark:ring-white/40" : ""
          }`}
          title="Dictate"
        >
          <Mic className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleVoiceToggle}
          className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10 ${
            isSpeaking ? "bg-black/10 dark:bg-white/10 ring-1 ring-black/30 dark:ring-white/40" : ""
          }`}
          title="Voice"
        >
          <Volume2 className="w-4 h-4" />
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,*/*"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) attachFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      {isDragOver && (
        <div className="fixed inset-0 z-[120] pointer-events-none border-4 border-dashed border-blue-500 bg-blue-500/20 dark:bg-blue-900/30 flex items-center justify-center">
          <div className="rounded-2xl border border-white/40 bg-white/70 dark:bg-black/40 px-6 py-4 text-center backdrop-blur-sm">
            <p className="text-base font-semibold">Drop to attach</p>
            <p className="text-xs opacity-80 mt-1">Memory cards, YouTube, images, videos, audio, PDF, and more</p>
          </div>
        </div>
      )}
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
              <button
                type="button"
                onClick={() => nav(-1)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <Select value={selectedModel} onValueChange={updateSelectedModel}>
                <SelectTrigger className="w-[130px] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
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

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  setAttachments([]);
                  setAttachmentCount(0);
                }}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title="Clear chat"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={handleSendChatToBoard}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={user?.id ? "Send chat to new board" : "Sign in to send chat to board"}
              >
                <MessageSquare className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowMemorySidebar((v) => !v)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={showMemorySidebar ? "Hide memory sidebar" : "Open memory sidebar"}
              >
                {showMemorySidebar ? <X className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={handleOpenAttachments}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={attachmentCount > 0 ? `${attachmentCount} attachment(s) selected` : "Add attachments"}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {!hasMessages ? (
        <div className="fixed inset-0 z-[85] pointer-events-none flex items-center justify-center px-4 transition-all duration-300">
          <div className="w-full max-w-2xl space-y-6">
            <p className="pointer-events-none text-center text-3xl font-semibold tracking-tight min-h-[44px] text-black">
              {typedWelcome}
            </p>
            <div className="pointer-events-auto">
              {renderComposer(true)}
            </div>
          </div>
        </div>
      ) : (
        <div className="h-screen flex flex-col">
          <div className="flex-1 min-h-0 px-4 pt-8 pb-2">
            <div className="h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl space-y-4 pb-6">
                {messages.map((msg, idx) => (
                  <div key={`${msg.role}-${idx}`} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`relative max-w-[85%] px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "rounded-[20px] rounded-br-md bg-gray-200/95 text-gray-900 dark:bg-white/18 dark:text-white border border-gray-300/70 dark:border-white/20 shadow-sm"
                          : "bg-transparent border-transparent shadow-none"
                      }`}
                    >
                      {msg.role === "assistant" ? (
                        <ReactMarkdown
                          components={{
                            h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
                            h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-base font-semibold mt-2.5 mb-1.5">{children}</h3>,
                            p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
                            ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
                            ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
                            li: ({ children }) => {
                              const raw = flattenNodeText(children).trim();
                              const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
                              if (!match) {
                                return <li className="leading-relaxed">{children}</li>;
                              }
                              const defaultChecked = String(match[1]).toLowerCase() === "x";
                              const taskText = match[2];
                              const taskKey = `${raw}`;
                              const checked = assistantTaskChecks[idx]?.[taskKey] ?? defaultChecked;
                              return (
                                <li className={`list-none ml-[-1.25rem] flex items-start gap-2 leading-relaxed ${checked ? "brick-todo-done" : ""}`}>
                                  <input
                                    type="checkbox"
                                    className="brick-todo-checkbox mt-[0.28rem] shrink-0"
                                    checked={checked}
                                    onChange={(e) => updateTaskCheck(idx, taskKey, e.target.checked)}
                                  />
                                  <span className={checked ? "line-through" : ""}>{taskText}</span>
                                </li>
                              );
                            },
                            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                            code: ({ children }) => (
                              <code className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[0.85em]">{children}</code>
                            ),
                          }}
                        >
                          {normalizeChecklistSyntax(msg.content)}
                        </ReactMarkdown>
                      ) : (
                        msg.content
                      )}
                      {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2 items-end">
                          {msg.attachments.map((att) => {
                            const t = String(att.type || "").toLowerCase();
                            const vid = att.videoId || (t === "youtube" ? extractYouTubeVideoId(att.url || "") : null);
                            if (t === "youtube" && vid) {
                              return (
                                <a key={att.id} href={att.url || `https://youtube.com/watch?v=${vid}`} target="_blank" rel="noopener noreferrer" className="block w-44 rounded-xl overflow-hidden bg-black relative group">
                                  <img src={`https://img.youtube.com/vi/${vid}/mqdefault.jpg`} alt={att.name || "YouTube"} className="w-full h-24 object-cover" />
                                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="w-9 h-7 bg-red-600 rounded-lg flex items-center justify-center"><Play className="w-3.5 h-3.5 text-white ml-0.5" fill="white" /></div>
                                  </div>
                                  <span className="block px-2 py-1 text-[0.625rem] text-white/80 truncate">{att.memoryTitle || att.name || "YouTube"}</span>
                                </a>
                              );
                            }
                            if (t === "image" && att.url) {
                              return <img key={att.id} src={att.url} alt={att.name} className="w-24 h-24 rounded-xl object-cover" />;
                            }
                            if (t === "video" && att.url) {
                              return (
                                <video key={att.id} src={att.url} controls preload="metadata" className="w-44 h-24 rounded-xl object-cover bg-black" />
                              );
                            }
                            if (t === "memory") {
                              return (
                                <div key={att.id} className="inline-flex items-center gap-1.5 rounded-xl border border-violet-300/40 bg-violet-100/30 dark:bg-violet-900/20 px-2 py-1 text-xs max-w-[220px]">
                                  <BookOpen className="w-3 h-3 text-violet-500 flex-shrink-0" />
                                  <span className="truncate">{att.memoryTitle || att.name || "Memory"}</span>
                                </div>
                              );
                            }
                            return (
                              <a key={att.id} href={att.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-full border border-white/30 bg-white/30 dark:bg-white/10 px-2 py-0.5 text-xs hover:opacity-90">
                                {att.name}
                              </a>
                            );
                          })}
                        </div>
                      )}
                      {msg.role === "assistant" && isLoading && idx === messages.length - 1 ? (
                        <span className="inline-flex items-center gap-1.5 ml-0.5 text-xs text-black/50 dark:text-white/50">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                          {thinkingStatus}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
                <div ref={scrollRef} />
              </div>
            </div>
          </div>
          <div className="px-4 pb-6">
            <div className="mx-auto w-full max-w-3xl">
              {renderComposer(false)}
            </div>
          </div>
        </div>
      )}

      <aside
        className={`fixed top-0 right-0 z-[95] h-[100svh] w-[380px] max-w-[92vw] border-l border-white/35 dark:border-white/15 bg-[linear-gradient(145deg,rgba(255,255,255,0.48),rgba(255,255,255,0.2))] dark:bg-[linear-gradient(145deg,rgba(25,25,28,0.92),rgba(14,14,16,0.8))] shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-2xl transition-transform duration-300 ${
          showMemorySidebar ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
        }`}
      >
        <div className="h-full flex flex-col">
          <div className="px-4 py-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-black dark:text-white">Memory</h2>
              <p className="text-xs opacity-70">Full memory view</p>
            </div>
            <button
              type="button"
              onClick={() => setShowMemorySidebar(false)}
              className="h-8 w-8 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
              title="Close memory sidebar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <iframe
              src="/memory?embedded=1"
              title="Memory"
              className="w-full h-full border-0 bg-transparent"
            />
          </div>
        </div>
      </aside>

      <DialogAny open={!!interactionNote} onOpenChange={() => setInteractionNote(null)}>
        <DialogContentAny className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white">
          <DialogHeaderAny>
            <DialogTitleAny>Open Memory</DialogTitleAny>
            <DialogDescriptionAny className="text-gray-500 dark:text-gray-400">
              How would you like to view this memory?
            </DialogDescriptionAny>
          </DialogHeaderAny>
          <div className="grid gap-4 py-4">
            <button
              type="button"
              onClick={() => {
                nav("/memory");
                setInteractionNote(null);
              }}
              className="bg-white hover:bg-gray-100 text-black border border-gray-200 dark:bg-white dark:text-black dark:hover:bg-gray-200 w-full h-12 text-lg text-left justify-start px-6 flex items-center"
            >
              <Clock className="w-5 h-5 mr-3" />
              View as Memory Card
            </button>
            <button
              type="button"
              onClick={() => {
                if (!interactionNote?.id) return;
                nav(`/create?id=${interactionNote.id}`);
                setInteractionNote(null);
              }}
              className="border border-gray-200 dark:border-gray-700 w-full h-12 text-lg text-left justify-start px-6 hover:bg-gray-50 dark:hover:bg-white/5 text-black dark:text-white flex items-center"
            >
              <Edit2 className="w-5 h-5 mr-3" />
              Open in Create Studio
            </button>
          </div>
        </DialogContentAny>
      </DialogAny>

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => { void handleCloseQuickNote(); }}
        />
      )}

      <button
        type="button"
        onClick={() => setShowQuickNote(true)}
        className="fixed bottom-8 right-8 w-14 h-14 rounded-full glass-control hover:opacity-90 shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 z-[80]"
        title="Quick Notes"
      >
        <StickyNote className="w-6 h-6" />
      </button>
    </div>
  );
}
