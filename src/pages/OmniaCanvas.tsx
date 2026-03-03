import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Canvas } from "@/canvas/Canvas";
import { useCanvasStore } from "@/store/canvasStore";
import type { Block } from "@/canvas/types";
import { ChevronDown, ChevronUp, ArrowLeft, Undo2, Redo2, Trash2, Plus, Link as LinkIcon, Image as ImageIcon, Zap, MessageSquare, Mic, Volume2, BookOpen, X, Clock, Edit2, Folder as FolderIcon, Link2, MoreHorizontal, PanelRightClose, StickyNote, Brain, List, Infinity, Play, FileText, Music, Video } from "lucide-react";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import RichTextRenderer from "@/components/notes/RichTextRenderer";
import { getProjectKnowledgeBase, projectKnowledgeBaseToText } from "@/lib/projectKnowledgeBase";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";
import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import { createDatabaseBlockData } from "@/canvas/blockSystem/notionModel";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";

type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  kind?: "prompt";
  attachments?: FocusedChatAttachment[];
};

type CreateAction =
  | { type: "create_sheet"; content?: string; title?: string }
  | { type: "create_spreadsheet"; rows?: number; cols?: number; cells?: Record<string, string>; cells2d?: string[][] }
  | { type: "create_list"; listType?: "todo" | "bulleted" | "numbered"; items?: string[] }
  | { type: "create_design_board"; board?: any; title?: string; seedText?: string }
  | { type: "create_code_block"; language?: string; content?: string }
  | { type: "create_universal_block"; universalType?: UniversalBlockType; name?: string; data?: Record<string, unknown> }
  | { type: "create_database_relation"; fromDatabaseName?: string; toDatabaseName?: string; relationType?: "one-to-one" | "one-to-many" | "many-to-many"; rollup?: { property?: string; aggregation?: "sum" | "count" | "average" } }
  | { type: string; [key: string]: any };

type OrchestratorResult = {
  response: string;
  followUpQuestions: string[];
  actions: CreateAction[];
  requiresClarification: boolean;
  groundingSummary?: string;
};

type AiMode = "think" | "plan" | "agent";

const AI_MODE_META: Record<AiMode, { label: string; icon: typeof Brain; description: string }> = {
  think: { label: "Think", icon: Brain,    description: "Brainstorm & ideate" },
  plan:  { label: "Plan",  icon: List,     description: "Strategize & outline" },
  agent: { label: "Agent", icon: Infinity, description: "Execute & automate" },
};

const CHAT_TO_BOARD_IMPORT_KEY = "omnia_chat_board_import_v1";

type ImportedChatPrompt = {
  id?: string;
  role?: "user";
  content?: string;
  aiResponse?: string;
  kind?: "prompt";
};

type ImportedTodoList = {
  id?: string;
  title?: string;
  items?: Array<{ text?: string; checked?: boolean }>;
};

type ImportedChatAttachment = {
  id?: string;
  type?: string;
  url?: string;
  name?: string;
  videoId?: string;
  memoryTitle?: string;
  memoryContent?: string;
  transcript?: string;
  pdfText?: string;
  extractedText?: string;
  mime?: string;
};

type ImportedChatBoardPayload = {
  version?: number;
  createdAt?: number;
  boardId?: string;
  source?: string;
  prompts?: ImportedChatPrompt[];
  todoLists?: ImportedTodoList[];
  attachments?: ImportedChatAttachment[];
};


type FocusedChatAttachment = {
  id: string;
  type: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  videoId?: string;
  memoryTitle?: string;
  memoryContent?: string;
  transcript?: string;
  pdfText?: string;
  canvasBlockId?: string;
};

const isYouTubeUrl = (url = "") =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());

const getUrlExtension = (url = "") => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() || "" : "";
    return ext;
  } catch { return ""; }
};

const inferUrlAttachmentType = (url = "") => {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (isYouTubeUrl(trimmed)) return "youtube";
  const ext = getUrlExtension(trimmed);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "link";
};

const makeAttId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type MemorySidebarNote = {
  id: string;
  title: string | null;
  content: string | null;
  attachments?: any[] | null;
  folder?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  tags?: string[] | null;
  connected_notes?: string[] | null;
  trashed?: boolean | null;
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

const formatMemoryCardDate = (note: MemorySidebarNote) => {
  const raw = note?.created_at || note?.updated_at;
  if (!raw) return "No date";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "No date";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function OmniaCanvasPage() {
  const SNAPSHOT_VERSION = 2;
  const nav = useNavigate();
  const { boardId: routeBoardId } = useParams<{ boardId?: string }>();
  const { user } = useAuth();
  const blocks = useCanvasStore((s) => s.blocks);
  const blockOrder = useCanvasStore((s) => s.blockOrder);
  const addTextBlockAt = useCanvasStore((s) => s.addTextBlockAt);
  const addListBlockAt = useCanvasStore((s) => s.addListBlockAt);
  const setListItems = useCanvasStore((s) => s.setListItems);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const loadBlocks = useCanvasStore((s) => s.loadBlocks);
  const reset = useCanvasStore((s) => s.reset);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.history.length > 0);
  const canRedo = useCanvasStore((s) => s.future.length > 0);
  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showMemorySidebar, setShowMemorySidebar] = useState(false);
  const [memoryNotes, setMemoryNotes] = useState<MemorySidebarNote[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [memorySearch, setMemorySearch] = useState("");
  const [interactionNote, setInteractionNote] = useState<MemorySidebarNote | null>(null);
  const [memoryDragActive, setMemoryDragActive] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 1280);
  const [chatRailWidthManual, setChatRailWidthManual] = useState<number | null>(null);
  const DialogAny = Dialog as any;
  const DialogContentAny = DialogContent as any;
  const DialogHeaderAny = DialogHeader as any;
  const DialogTitleAny = DialogTitle as any;
  const DialogDescriptionAny = DialogDescription as any;
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectFolders, setProjectFolders] = useState<Array<{ id: string; name: string; parentId: string | null }>>([]);
  const [projectFiles, setProjectFiles] = useState<
    Array<{ id: string; name: string; path: string; folderId: string | null; kind: string; url: string }>
  >([]);
  const refreshKnowledgeBase = useAiStore((s) => s.refreshKnowledgeBase);
  const markProjectDirty = useAiStore((s) => s.markProjectDirty);
  const getAISuggestions = useAiStore((s) => s.getAISuggestions);
  const organizeIdeas = useAiStore((s) => s.organizeIdeas);
  const generateProjectSummary = useAiStore((s) => s.generateProjectSummary);
  const aiSuggestions = useAiStore((s) => s.aiSuggestions);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const blobToDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  const dataUrlToFile = (dataUrl: string, name: string, fallbackType = "") => {
    try {
      const base64Match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (base64Match) {
        const mime = base64Match[1] || fallbackType || "application/octet-stream";
        const b64 = base64Match[2] || "";
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        return new File([blob], name, { type: mime });
      }
      const plainMatch = dataUrl.match(/^data:([^;]+)?,(.*)$/);
      if (plainMatch) {
        const mime = plainMatch[1] || fallbackType || "application/octet-stream";
        const text = decodeURIComponent(plainMatch[2] || "");
        const blob = new Blob([text], { type: mime });
        return new File([blob], name, { type: mime });
      }
      return null;
    } catch {
      return null;
    }
  };

  const persistProjectFileUrl = (fileId: string, url: string) => {
    setProjectFiles((prev) => {
      const next = prev.map((f) => (f.id === fileId ? { ...f, url } : f));
      if (projectId) {
        try {
          const raw = localStorage.getItem(`project:${projectId}`);
          const parsed = raw ? JSON.parse(raw) : {};
          const folders = Array.isArray(parsed?.folders) ? parsed.folders : projectFolders;
          localStorage.setItem(`project:${projectId}`, JSON.stringify({ folders, files: next, activeFolderId: parsed?.activeFolderId ?? null }));
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  const resolveProjectFileToFile = async (file: { name: string; kind: string; url: string; path: string }) => {
    const fallbackType =
      file.kind === "image"
        ? "image/png"
        : file.kind === "video"
        ? "video/mp4"
        : file.kind === "pdf"
        ? "application/pdf"
        : "";
    if (file.url?.startsWith("data:")) {
      return dataUrlToFile(file.url, file.name, fallbackType);
    }
    const candidate = file.url || file.path || "";
    if (!candidate) return null;
    let blob: Blob | null = null;
    try {
      const res = await fetch(candidate);
      blob = await res.blob();
    } catch {
      return null;
    }
    try {
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl) persistProjectFileUrl((file as any).id, dataUrl);
    } catch {
      // ignore
    }
    const type = blob.type || fallbackType;
    return new File([blob], file.name, { type });
  };
  const [isEditingField, setIsEditingField] = useState(false);
  const [aiMode, setAiMode] = useState<AiMode>(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiMode && ["think", "plan", "agent"].includes(parsed.aiMode)) return parsed.aiMode;
      }
    } catch { /* ignore */ }
    return "think";
  });
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
  const [title, setTitle] = useState(() => {
    try {
      return localStorage.getItem("omnia_title") || "";
    } catch {
      return "";
    }
  });
  const [boardId, setBoardId] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const lastSavedTitleRef = useRef<string>("");
  const [chatMode, setChatMode] = useState(false);
  const [chatMessages, setChatMessages] = useState<PromptMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [focusedChatAttachments, setFocusedChatAttachments] = useState<FocusedChatAttachment[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatPanelInputRef = useRef<HTMLTextAreaElement | null>(null);
  const centerChatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const aiTypingRunRef = useRef(0);
  const chatImportAppliedRef = useRef<string | null>(null);
  const isSendingRef = useRef(false);
  const lastAiResponseBlockRef = useRef<string | null>(null);
  const aiThreadRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const lastSendSigRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const clarificationSessionRef = useRef<{
    active: boolean;
    basePromptId: string;
    baseRequest: string;
    questions: string[];
    answers: string[];
    askedCount: number;
  }>({
    active: false,
    basePromptId: "",
    baseRequest: "",
    questions: [],
    answers: [],
    askedCount: 0,
  });
  const kbCacheRef = useRef<{ projectId: string; text: string; fetchedAt: number } | null>(null);
  const [chatFlowMode, setChatFlowMode] = useState<"idle" | "clarifying" | "generating">("idle");
  const [chatStatusText, setChatStatusText] = useState("");
  const [typedWelcome, setTypedWelcome] = useState("");
  const [showAiSuggestionToast, setShowAiSuggestionToast] = useState(false);
  const lastSuggestionKeyRef = useRef<string>("");
  const youtubeTranscriptCacheRef = useRef<
    Record<
      string,
      {
        fetchedAt: number;
        title: string;
        url: string;
        transcript: string;
        segments: Array<{ startSec: number; endSec: number; text: string }>;
      }
    >
  >({});

  const filteredMemoryNotes = useMemo(() => {
    const query = String(memorySearch || "").trim().toLowerCase();
    const visibleNotes = memoryNotes.filter((note) => !note?.trashed);
    if (!query) return visibleNotes;
    return visibleNotes.filter((note) => {
      const title = String(note.title || "").toLowerCase();
      const content = String(note.content || "").toLowerCase();
      const folder = String(note.folder || "").toLowerCase();
      return title.includes(query) || content.includes(query) || folder.includes(query);
    });
  }, [memoryNotes, memorySearch]);

  const memoryNotesByFolder = useMemo(() => {
    const grouped = filteredMemoryNotes.reduce((acc, note) => {
      const folderName = String(note.folder || "Uncategorized").trim() || "Uncategorized";
      if (!acc[folderName]) acc[folderName] = [];
      acc[folderName].push(note);
      return acc;
    }, {} as Record<string, MemorySidebarNote[]>);
    const sortedFolders = Object.keys(grouped).sort((a, b) => {
      if (a === "Uncategorized") return 1;
      if (b === "Uncategorized") return -1;
      return a.localeCompare(b);
    });
    return { grouped, sortedFolders };
  }, [filteredMemoryNotes]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const createWelcomeText = useMemo(() => {
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const preferredName = String(firstName || emailName || "there").trim();
    return `Welcome back, ${preferredName}`;
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  useEffect(() => {
    const text = String(createWelcomeText || "").trim();
    setTypedWelcome("");
    if (!text) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedWelcome(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(timer);
      }
    }, 52);
    return () => window.clearInterval(timer);
  }, [createWelcomeText]);

  useEffect(() => {
    try {
      localStorage.setItem("omnia_title", title);
    } catch {
      // ignore
    }
  }, [title]);

  const buildSnapshot = useCallback(() => {
    const st = useCanvasStore.getState();
    return {
      blocks: st.blocks,
      blockOrder: st.blockOrder,
      camera: st.camera,
      gridSize: st.gridSize,
      title: title || "Untitled board",
      version: SNAPSHOT_VERSION,
    };
  }, [SNAPSHOT_VERSION, title]);

  const applySnapshot = useCallback(
    (snapshot: any) => {
      if (!snapshot) return;
      const blocksRecord = snapshot.blocks || {};
      const order: string[] = Array.isArray(snapshot.blockOrder) ? snapshot.blockOrder : [];
      const isTransientTextBrick = (b: any) => {
        const data = (b?.data && typeof b.data === "object" ? b.data : {}) as Record<string, any>;
        if (Boolean(data.aiResponseBubble)) return true;
        const txt = String(data.content ?? data.body ?? b?.content ?? "")
          .trim()
          .toLowerCase();
        const title = String(data.title || "").trim().toLowerCase();
        const isBrickish =
          String(b?.universalType || b?.universal?.blockType || "").toLowerCase() === "brick" ||
          String(data.kind || "").toLowerCase() === "brick";
        if (isBrickish && (txt === "text brick" || title === "text brick")) return true;
        // Legacy starter text that should never auto-return after refresh.
        const isLegacyStarter =
          (title === "workspace note" || txt.startsWith("new ") || txt.includes("workspace")) &&
          txt.includes("click and type to edit this square");
        return isLegacyStarter;
      };
      const blocks: Block[] = order
        .map((id) => blocksRecord[id])
        .filter(Boolean)
        .filter((b: any) => !isTransientTextBrick(b))
        .map((b: any) => {
          if (!b?.universal) return b;
          return {
            ...b,
            universal: {
              ...b.universal,
              dataSource: {
                kind: b.universal?.dataSource?.kind || "none",
                inputs: Array.isArray(b.universal?.dataSource?.inputs) ? b.universal.dataSource.inputs : [],
                outputs: Array.isArray(b.universal?.dataSource?.outputs) ? b.universal.dataSource.outputs : [],
              },
              events: {
                emits: Array.isArray(b.universal?.events?.emits) ? b.universal.events.emits : [],
                listensTo: Array.isArray(b.universal?.events?.listensTo) ? b.universal.events.listensTo : [],
              },
              logic: {
                conditions: Array.isArray(b.universal?.logic?.conditions) ? b.universal.logic.conditions : [],
                filters: Array.isArray(b.universal?.logic?.filters) ? b.universal.logic.filters : [],
                dependencies: Array.isArray(b.universal?.logic?.dependencies) ? b.universal.logic.dependencies : [],
                triggers: Array.isArray(b.universal?.logic?.triggers) ? b.universal.logic.triggers : [],
              },
              aiContext: {
                purpose: String(b.universal?.aiContext?.purpose || ""),
                tags: Array.isArray(b.universal?.aiContext?.tags) ? b.universal.aiContext.tags : [],
                semanticType: String(b.universal?.aiContext?.semanticType || ""),
              },
              permissions: Array.isArray(b.universal?.permissions) ? b.universal.permissions : ["view", "edit", "admin"],
              visibility: b.universal?.visibility || "visible",
              connections: Array.isArray(b.universal?.connections) ? b.universal.connections : [],
            },
          };
        });
      const camera = snapshot.camera || { x: 0, y: 0, zoom: 1 };
      const g = Number.isFinite(snapshot.gridSize) ? Number(snapshot.gridSize) : gridSize;
      loadBlocks(blocks, { camera, gridSize: g });
      if (snapshot.title) setTitle(String(snapshot.title));
    },
    [gridSize, loadBlocks]
  );

  const clampChatRailWidth = useCallback((raw: number, vw: number) => {
    const width = Math.max(0, Math.floor(vw || 0));
    const minW = width <= 900 ? 200 : 220;
    const maxW = Math.max(minW + 20, Math.min(520, Math.floor(width * 0.55)));
    return Math.max(minW, Math.min(maxW, Math.floor(raw || minW)));
  }, []);

  const getChatRailWidthPx = useCallback(
    (vw: number) => {
      if (chatMode) return 0;
      const width = Math.max(0, Math.floor(vw || 0));
      if (width <= 900) return Math.max(220, Math.min(280, Math.floor(width * 0.34)));
      if (width <= 1300) return Math.max(240, Math.min(320, Math.floor(width * 0.3)));
      return Math.min(380, Math.floor(width * 0.42));
    },
    [chatMode]
  );

  const chatRailWidthPx = !chatMode && chatMessages.length > 0
    ? clampChatRailWidth(chatRailWidthManual ?? getChatRailWidthPx(viewportWidth), viewportWidth)
    : 0;

  useEffect(() => {
    if (!chatMode) return;
    if (chatRailWidthManual == null) return;
    const next = clampChatRailWidth(chatRailWidthManual, viewportWidth);
    if (next !== chatRailWidthManual) setChatRailWidthManual(next);
  }, [chatRailWidthManual, clampChatRailWidth, chatMode, viewportWidth]);

  const handleStartChatResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = chatRailWidthPx;

      const onMove = (ev: PointerEvent) => {
        const dx = startX - ev.clientX;
        const vw = window.innerWidth || viewportWidth || 1280;
        const next = clampChatRailWidth(startWidth + dx, vw);
        setChatRailWidthManual(next);
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
    [chatRailWidthPx, clampChatRailWidth, viewportWidth]
  );

  const buildCanvasContext = useCallback(() => {
    const st = useCanvasStore.getState();
    const ids = (Array.isArray(st.blockOrder) ? st.blockOrder : []).slice(-40);
    const take = (v: any, n = 180) =>
      String(v || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, n);
    const host = (u: string) => {
      try {
        return new URL(String(u || "")).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    const lines = ids
      .map((id) => (st.blocks as any)?.[id])
      .filter(Boolean)
      .map((b: any) => {
        const base = `- type=${b.type} x=${Math.floor(b.x || 0)} y=${Math.floor(b.y || 0)} w=${Math.floor(b.width || 0)} h=${Math.floor(
          b.height || 0
        )}`;
        if (b?.type === "text") {
          const format = String(b?.format || "plain");
          const content = take(b?.content, 220);
          return `${base} format=${format}${content ? ` content="${content}"` : ""}`;
        }
        if (b?.type === "youtube" || (b?.type === "create" && String(b?.mode || "").toLowerCase() === "video")) {
          const videoId = String(b?.videoId || b?.data?.videoId || "");
          const url = String(b?.url || b?.data?.url || "");
          return `${base} kind=youtube videoId=${videoId || "unknown"}${url ? ` url="${take(url, 120)}"` : ""}`;
        }
        if (b?.type === "image" || (b?.type === "create" && ["image", "generated"].includes(String(b?.mode || "").toLowerCase()))) {
          const src = String(b?.src || b?.data?.src || "");
          return `${base} kind=image${src ? ` srcHost=${host(src) || "local"} src="${take(src, 120)}"` : ""}`;
        }
        if (b?.type === "file" || (b?.type === "create" && String(b?.mode || "").toLowerCase() === "embed")) {
          const name = take(b?.name || b?.data?.name, 80);
          const mime = take(b?.mime || b?.data?.mime, 60);
          const dataUrl = String(b?.dataUrl || b?.data?.dataUrl || "");
          const url = String(b?.url || b?.data?.url || "");
          return `${base} kind=file${name ? ` name="${name}"` : ""}${mime ? ` mime=${mime}` : ""}${url ? ` url="${take(url, 120)}"` : ""}${
            dataUrl ? ` dataUrl=true` : ""
          }`;
        }
        if (b?.type === "link" || (b?.type === "create" && String(b?.mode || "").toLowerCase() === "embed")) {
          const url = String(b?.url || b?.data?.url || "");
          if (url) return `${base} kind=link host=${host(url) || "unknown"} url="${take(url, 140)}"`;
        }
        if (b?.type === "create" && String(b?.mode || "").toLowerCase() === "design") {
          const elCount = Array.isArray(b?.data?.board?.elements) ? b.data.board.elements.length : 0;
          const seedText = take(b?.data?.seedText || "", 120);
          return `${base} kind=design elements=${elCount}${seedText ? ` seed="${seedText}"` : ""}`;
        }
        if (b?.type === "create" && String(b?.mode || "").toLowerCase() === "taskboard") {
          const colCount = Array.isArray(b?.data?.columns) ? b.data.columns.length : 0;
          const title = take(b?.data?.title || "", 80);
          return `${base} kind=taskboard columns=${colCount}${title ? ` title="${title}"` : ""}`;
        }
        const content = take(b?.content || b?.data?.content || "", 180);
        return `${base}${content ? ` content="${content}"` : ""}`;
      });
    return lines.join("\n");
  }, []);
  const getVisibleYouTubeBlocks = useCallback(() => {
    const st = useCanvasStore.getState() as any;
    const cam = st.camera || { x: 0, y: 0 };
    const vw = window.innerWidth || viewportWidth || 1280;
    const vh = window.innerHeight || 800;
    const rightRail = getChatRailWidthPx(vw);
    const boardViewportWidth = Math.max(gridSize * 8, vw - rightRail);
    const viewLeft = Number(cam.x || 0);
    const viewTop = Number(cam.y || 0);
    const viewRight = viewLeft + boardViewportWidth;
    const viewBottom = viewTop + vh;
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const out: Array<{ videoId: string; url: string; title: string; visibleScore: number }> = [];
    for (const id of ids) {
      const b: any = st.blocks?.[id];
      if (!b) continue;
      const type = String(b.type || "").toLowerCase();
      const isYouTube = type === "youtube" || (type === "create" && String(b.mode || "").toLowerCase() === "video");
      if (!isYouTube) continue;
      const bx = Number(b.x || 0);
      const by = Number(b.y || 0);
      const bw = Math.max(1, Number(b.width || gridSize));
      const bh = Math.max(1, Number(b.height || gridSize));
      const overlapW = Math.max(0, Math.min(bx + bw, viewRight) - Math.max(bx, viewLeft));
      const overlapH = Math.max(0, Math.min(by + bh, viewBottom) - Math.max(by, viewTop));
      const overlapArea = overlapW * overlapH;
      if (overlapArea <= 0) continue;
      const rawVideoId = String((type === "youtube" ? b.videoId : b?.data?.videoId) || "");
      const rawUrl = String((type === "youtube" ? b.url : b?.data?.url) || "");
      const videoId = rawVideoId || extractYouTubeVideoId(rawUrl) || "";
      if (!videoId) continue;
      const title = String((b?.data?.title || b?.data?.name || "").trim());
      out.push({
        videoId,
        url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`,
        title,
        visibleScore: overlapArea,
      });
    }
    out.sort((a, b) => b.visibleScore - a.visibleScore);
    const dedup: Array<{ videoId: string; url: string; title: string; visibleScore: number }> = [];
    const seen = new Set<string>();
    for (const item of out) {
      if (seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      dedup.push(item);
    }
    return dedup.slice(0, 2);
  }, [getChatRailWidthPx, gridSize, viewportWidth]);
  const formatSec = (n: number) => {
    const sec = Math.max(0, Math.floor(Number(n || 0)));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };
  const buildYouTubeGrounding = useCallback(
    async (apiBaseUrl: string, userText: string) => {
      const visible = getVisibleYouTubeBlocks();
      if (!visible.length) return "";
      const tokenSet = new Set(
        String(userText || "")
          .toLowerCase()
          .split(/[^a-z0-9]+/g)
          .map((t) => t.trim())
          .filter((t) => t.length >= 4)
      );
      const sections: string[] = [];
      for (const video of visible) {
        const cached = youtubeTranscriptCacheRef.current[video.videoId];
        let data = cached;
        if (!data || Date.now() - data.fetchedAt > 30 * 60 * 1000) {
          const [tRes, vRes] = await Promise.all([
            fetch(`${apiBaseUrl}/api/youtube/transcript?id=${encodeURIComponent(video.videoId)}`).catch(() => null),
            fetch(`${apiBaseUrl}/api/youtube/video?id=${encodeURIComponent(video.videoId)}`).catch(() => null),
          ]);
          const tJson = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
          const vJson = vRes && vRes.ok ? await vRes.json().catch(() => ({})) : {};
          const fallbackDescription = String((vJson as any)?.description || "").trim();
          const segRaw = Array.isArray((tJson as any)?.segments) ? (tJson as any).segments : [];
          const segments = segRaw
            .map((s: any) => {
              const startSec = Number(s?.offset ?? s?.start ?? s?.startSec ?? 0);
              const dur = Number(s?.duration ?? s?.dur ?? s?.length ?? 0);
              return {
                startSec: Number.isFinite(startSec) ? startSec : 0,
                endSec: Number.isFinite(startSec + dur) ? startSec + dur : startSec,
                text: String(s?.text || "").trim(),
              };
            })
            .filter((s: any) => s.text)
            .slice(0, 900);
          const transcriptText = String((tJson as any)?.transcript || "").trim();
          const hasTranscript = Boolean(transcriptText || segments.length);
          const effectiveTranscript = hasTranscript ? transcriptText : fallbackDescription.slice(0, 4000);
          const effectiveSegments =
            hasTranscript || !fallbackDescription
              ? segments
              : fallbackDescription
                  .split(/\n+/)
                  .map((x: string) => x.trim())
                  .filter(Boolean)
                  .slice(0, 8)
                  .map((text: string, idx: number) => ({
                    startSec: idx * 30,
                    endSec: idx * 30 + 29,
                    text,
                  }));
          data = {
            fetchedAt: Date.now(),
            title: String((vJson as any)?.title || video.title || `YouTube ${video.videoId}`),
            url: video.url,
            transcript: effectiveTranscript,
            segments: effectiveSegments,
          };
          youtubeTranscriptCacheRef.current[video.videoId] = data;
        }
        if (!data || (!data.transcript && !data.segments.length)) continue;
        const candidates = data.segments.length
          ? data.segments
          : [{ startSec: 0, endSec: 0, text: String(data.transcript || "").slice(0, 3000) }];
        const scored = candidates
          .map((c) => {
            const lt = c.text.toLowerCase();
            let score = 0;
            for (const tok of tokenSet) if (lt.includes(tok)) score += 1;
            return { ...c, score };
          })
          .sort((a, b) => b.score - a.score || a.startSec - b.startSec);
        const matched = tokenSet.size ? scored.filter((x) => x.score > 0) : scored;
        const picked = (matched.length ? matched : scored).slice(0, 8);
        const lines = picked.map((p) => `- [${formatSec(p.startSec)}-${formatSec(p.endSec)}] ${p.text}`);
        sections.push(`Video: ${data.title} (${video.videoId})\n${lines.join("\n")}`);
      }
      return sections.join("\n\n");
    },
    [getVisibleYouTubeBlocks]
  );
  const looksLikeDeflectingQuestion = useCallback((s: string) => {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return true;
    return /(would you like|do you want|want me to|should i|it seems like|would you want|do you need)/i.test(t);
  }, []);
  const isVideoQuestion = useCallback((s: string) => {
    const t = String(s || "").toLowerCase();
    return /(video|youtube|clip|summari[sz]e.*video|explain.*video|talk.*about.*video|what.*video.*about|what.*youtube.*about)/i.test(t);
  }, []);
  const sanitizeAssistantResponse = useCallback((s: string) => {
    const raw = String(s || "").trim();
    if (!raw) return "";
    const cleaned = raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/(would you like|do you want|want me to|should i|it seems like|would you want|do you need)/i.test(line))
      .join("\n");
    return cleaned.trim();
  }, []);
  const buildDirectVideoAnswerFromGrounding = useCallback((grounding: string) => {
    const raw = String(grounding || "").trim();
    if (!raw || raw === "(none)") return "";
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\-\s*\[\d{2}:\d{2}\-\d{2}:\d{2}\]\s+/.test(l))
      .slice(0, 8)
      .map((l) => l.replace(/^\-\s*/, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!lines.length) return "";
    const keyPoints = lines.slice(0, 5).map((l) => `- ${l}`);
    const direct = lines[0];
    return [`From the on-board video transcript:`, `Answer: ${direct}`, `Key grounded points:\n${keyPoints.join("\n")}`].join("\n\n");
  }, []);
  const formatGroundedVideoAnswer = useCallback((payload: any) => {
    const base = String(payload?.answer || "").trim();
    const evidence = Array.isArray(payload?.evidence) ? payload.evidence : [];
    const topEvidence = evidence.slice(0, 3).map((e: any) => {
      const ts = String(e?.timestamp || "").trim();
      const text = String(e?.text || "").trim();
      if (!text) return "";
      return ts ? `[${ts}] ${text}` : text;
    }).filter(Boolean);
    const uncertainty = String(payload?.uncertainty || "").trim();
    const grounded = Boolean(payload?.grounded);
    const out: string[] = [];
    if (base) out.push(base);
    if (topEvidence.length) out.push(`Evidence:\n- ${topEvidence.join("\n- ")}`);
    if (uncertainty) out.push(`Uncertainty: ${uncertainty}`);
    if (!grounded && !out.length) {
      return "I couldn't find grounded spoken evidence in the selected video for that question.";
    }
    return out.join("\n\n").trim();
  }, []);

  const getKnowledgeBaseContext = useCallback(async () => {
    if (!projectId) return "";
    const now = Date.now();
    const cached = kbCacheRef.current;
    if (cached && cached.projectId === projectId && now - cached.fetchedAt < 90000) {
      return cached.text;
    }
    try {
      const kb = await getProjectKnowledgeBase(projectId);
      const text = projectKnowledgeBaseToText(kb, 9000);
      kbCacheRef.current = { projectId, text, fetchedAt: now };
      return text;
    } catch {
      return "";
    }
  }, [projectId]);

  const parseOrchestratorResult = useCallback((raw: any): OrchestratorResult => {
    const response = String(raw?.response || raw?.assistant || "").trim();
    const followUpQuestionsRaw = raw?.followUpQuestions ?? raw?.follow_up_questions ?? raw?.followUps;
    const followUpQuestions = Array.isArray(followUpQuestionsRaw)
      ? followUpQuestionsRaw
          .map((q: any) => String(q || "").trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    const actions = Array.isArray(raw?.actions) ? (raw.actions as CreateAction[]) : [];
    const requiresClarification = Boolean(raw?.requiresClarification) || (followUpQuestions.length > 0 && actions.length === 0);
    const groundingSummary = String(raw?.groundingSummary || raw?.grounding_summary || "").trim();
    return { response, followUpQuestions, actions, requiresClarification, groundingSummary: groundingSummary || undefined };
  }, []);

  const makeConciseAssistantText = useCallback((text: string) => {
    const cleaned = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!cleaned) return "";
    // Keep only the first non-empty paragraph to avoid long recap walls.
    const firstParagraph =
      cleaned
        .split("\n\n")
        .map((p) => p.trim())
        .find(Boolean) || cleaned;
    const singleLine = firstParagraph.replace(/\s+/g, " ").trim();
    // Keep at most first 2 sentence-like chunks.
    const sentences = singleLine
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const concise = (sentences.slice(0, 2).join(" ") || singleLine).trim();
    const MAX_LEN = 260;
    if (concise.length <= MAX_LEN) return concise;
    return `${concise.slice(0, MAX_LEN - 1).trimEnd()}…`;
  }, []);

  const isLikelyCreationIntent = useCallback((input: string) => {
    const t = String(input || "").toLowerCase();
    if (!t) return false;
    // Creation should be explicit; regular questions stay in chat mode.
    return /\b(create|make|build|add|insert|open|generate)\b[\s\S]{0,80}\b(block|brick|board|sheet|spreadsheet|table|list|todo|task board|kanban|code|document|note)\b/.test(
      t
    );
  }, []);

  const isContinuationAffirmation = useCallback((input: string) => {
    const t = String(input || "")
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/g, "");
    if (!t) return false;
    return [
      "yes",
      "yeah",
      "yep",
      "sure",
      "ok",
      "okay",
      "go on",
      "continue",
      "keep going",
      "tell me more",
      "explain more",
      "more",
      "please continue",
    ].includes(t);
  }, []);

  const addAiResponseBlock = useCallback((initialContent = "") => {
    const st = useCanvasStore.getState();
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || viewportWidth || 1280;
    const rightRail = getChatRailWidthPx(vw);
    const boardViewportWidth = Math.max(g * 8, vw - rightRail);

    // Always place AI response in the visible center of the board interface.
    const centerX = st.camera.x + Math.floor(boardViewportWidth * 0.5);
    const centerY = st.camera.y + Math.floor(window.innerHeight * 0.5);

    // Start small like a regular text block; TextBlock auto-grow expands as AI types.
    const initialW = g * 8;
    const initialH = g;
    const worldX = Math.max(g, centerX - Math.floor(initialW / 2));
    const worldY = Math.max(g, centerY - Math.floor(initialH / 2));

    const id = addTextBlockAt(
      { x: worldX, y: worldY },
      { width: initialW, height: initialH, content: initialContent, format: "rich" }
    );
    st.updateBlock(id as any, { data: { ...((st.blocks as any)?.[id]?.data || {}), aiResponseBubble: true } } as any);
    return id;
  }, [addTextBlockAt, getChatRailWidthPx, viewportWidth]);

  const normalizeAiTextForBlock = useCallback((text: string) => {
    return String(text || "").replace(/\r\n?/g, "\n");
  }, []);

  const calcAiBubbleSize = useCallback((text: string) => {
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const availableWidth = Number.isFinite(st.canvasWidth) && (st.canvasWidth as number) > 0
      ? (st.canvasWidth as number)
      : (window.innerWidth || 1280);
    const maxWidthPx = Math.min(g * 24, Math.floor(availableWidth * 0.85));
    const horizontalPad = 24;
    const charWidthPx = 7.2;

    const lines = String(text || "").split("\n");
    const longest = lines.reduce((m, l) => Math.max(m, String(l || "").length), 0);
    const naturalWidth = Math.ceil(longest * charWidthPx + horizontalPad);
    const widthPx = Math.max(g * 8, Math.min(maxWidthPx, naturalWidth));

    const usableWidth = Math.max(1, widthPx - horizontalPad);
    const charsPerLine = Math.max(1, Math.floor(usableWidth / charWidthPx));
    let wrappedLines = 0;
    for (const line of lines) {
      wrappedLines += Math.max(1, Math.ceil((line.length || 1) / charsPerLine));
    }
    const lineHeightPx = 20;
    const verticalPad = 16;
    const contentHeight = wrappedLines * lineHeightPx + verticalPad;
    const heightPx = Math.max(g, Math.ceil(contentHeight / g) * g);

    return { width: widthPx, height: heightPx };
  }, []);

  const typeIntoAiResponseBlock = useCallback(
    async (blockId: string, fullText: string) => {
      const runId = ++aiTypingRunRef.current;
      const text = normalizeAiTextForBlock(fullText);
      let shown = "";

      while (shown.length < text.length && aiTypingRunRef.current === runId) {
        const nextChar = text.charAt(shown.length);
        const step = nextChar === "\n" ? 4 : 2;
        const delay = nextChar === "\n" ? 24 : /[.,!?]/.test(nextChar) ? 28 : 16;
        const nextLen = Math.min(text.length, shown.length + step);
        shown = text.slice(0, nextLen);
        const size = calcAiBubbleSize(shown);
        updateBlock(blockId as any, { content: shown, width: size.width, height: size.height } as any);
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }

      if (aiTypingRunRef.current === runId) {
        const size = calcAiBubbleSize(text);
        updateBlock(blockId as any, { content: text, width: size.width, height: size.height } as any);
      }
    },
    [calcAiBubbleSize, normalizeAiTextForBlock, updateBlock]
  );

  const replaySavedPromptResponse = useCallback(
    async (msg: PromptMessage) => {
      const saved = String(msg?.aiResponse || "").trim();
      if (!saved) return;
      const existingAiIds = (Array.isArray(blockOrder) ? blockOrder : []).filter((id) =>
        Boolean((blocks as any)?.[id]?.data?.aiResponseBubble)
      );
      for (const id of existingAiIds) {
        try {
          deleteBlock(id as any);
        } catch {
          // ignore
        }
      }
      const responseBlockId = addAiResponseBlock("");
      if (!responseBlockId) return;
      lastAiResponseBlockRef.current = String(responseBlockId);
      await typeIntoAiResponseBlock(String(responseBlockId), saved);
    },
    [addAiResponseBlock, blockOrder, blocks, deleteBlock, typeIntoAiResponseBlock]
  );

  useEffect(() => {
    if (!boardId || !user?.id) return;
    if (chatImportAppliedRef.current === boardId) return;

    let raw = "";
    try {
      raw = String(localStorage.getItem(CHAT_TO_BOARD_IMPORT_KEY) || "");
    } catch {
      return;
    }
    if (!raw) return;

    let payload: ImportedChatBoardPayload | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    if (!payload || String(payload.boardId || "") !== String(boardId)) return;

    const createdAt = Number(payload.createdAt || 0);
    if (createdAt > 0 && Date.now() - createdAt > 30 * 60 * 1000) {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    const importedPrompts = (Array.isArray(payload.prompts) ? payload.prompts : [])
      .map((p, idx) => {
        const content = String(p?.content || "").trim();
        if (!content) return null;
        const aiResponse = String(p?.aiResponse || "").trim();
        return {
          id: String(p?.id || `import-prompt-${idx + 1}`),
          role: "user" as const,
          content,
          kind: "prompt" as const,
          aiResponse: aiResponse || undefined,
        };
      })
      .filter(Boolean) as PromptMessage[];

    const importedTodoLists = (Array.isArray(payload.todoLists) ? payload.todoLists : [])
      .map((list, listIdx) => {
        const items = (Array.isArray(list?.items) ? list.items : [])
          .map((item, itemIdx) => {
            const text = String(item?.text || "").trim();
            if (!text) return null;
            return {
              id: `li-import-${listIdx + 1}-${itemIdx + 1}-${Date.now().toString(36)}`,
              text,
              checked: Boolean(item?.checked),
            };
          })
          .filter(Boolean);
        return {
          id: String(list?.id || `import-todo-${listIdx + 1}`),
          title: String(list?.title || `To-do ${listIdx + 1}`),
          items,
        };
      })
      .filter((list) => list.items.length > 0);

    try {
      localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
    } catch {
      // ignore
    }
    chatImportAppliedRef.current = String(boardId);

    if (importedPrompts.length) {
      setChatMode(true);
      setChatMessages(importedPrompts);
      aiThreadRef.current = importedPrompts.flatMap((p) =>
        p.aiResponse
          ? [
              { role: "user" as const, content: p.content },
              { role: "assistant" as const, content: p.aiResponse },
            ]
          : [{ role: "user" as const, content: p.content }]
      );

      const latestAi = [...importedPrompts]
        .reverse()
        .map((p) => String(p.aiResponse || "").trim())
        .find(Boolean);

      if (latestAi) {
        const st = useCanvasStore.getState() as any;
        const existingAiIds = (Array.isArray(st.blockOrder) ? st.blockOrder : []).filter((id) =>
          Boolean((st.blocks as any)?.[id]?.data?.aiResponseBubble)
        );
        for (const id of existingAiIds) {
          try {
            deleteBlock(id as any);
          } catch {
            // ignore
          }
        }
        const responseBlockId = addAiResponseBlock("");
        if (responseBlockId) {
          lastAiResponseBlockRef.current = String(responseBlockId);
          void typeIntoAiResponseBlock(String(responseBlockId), latestAi);
        }
      }
    }

    if (importedTodoLists.length) {
      const st = useCanvasStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const camera = st.camera || { x: 0, y: 0 };
      const startX = Math.max(g, Math.floor(-camera.x + g * 2));
      const startY = Math.max(g, Math.floor(-camera.y + g * 2));
      let x = startX;
      let y = startY;

      importedTodoLists.forEach((todoList, idx) => {
        const listId = addListBlockAt({ x, y }, { listType: "todo", width: g * 12 });
        setListItems(listId as any, todoList.items as any, "todo");

        y += Math.max(g * 3, (todoList.items.length + 2) * g);
        if ((idx + 1) % 3 === 0) {
          x += g * 14;
          y = startY;
        }
      });
    }

    const importedAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (importedAttachments.length) {
      const st = useCanvasStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const camera = st.camera || { x: 0, y: 0 };
      let ax = Math.max(g, Math.floor(-camera.x + g * 16));
      let ay = Math.max(g, Math.floor(-camera.y + g * 2));

      for (const att of importedAttachments) {
        const url = String(att.url || "").trim();
        const attType = String(att.type || "").toLowerCase();
        const videoId = att.videoId || (attType === "youtube" ? (extractYouTubeVideoId(url) || "") : "");

        if (attType === "youtube" && (videoId || url)) {
          const ytUrl = url || `https://www.youtube.com/watch?v=${videoId}`;
          st.addYouTubeBlockAt({ x: ax, y: ay }, { url: ytUrl, videoId });
          ay += g * 10;
        } else if (attType === "image" && url) {
          if (url.startsWith("data:image/")) {
            const parts = url.split(",");
            const mm = parts[0]?.match(/:(.*?);/);
            if (mm && parts[1]) {
              try {
                const bstr = atob(parts[1]);
                const u8 = new Uint8Array(bstr.length);
                for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
                const file = new File([u8], att.name || "image.png", { type: mm[1] });
                window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX: ax, clientY: ay } }));
              } catch { /* ignore */ }
            }
          } else {
            window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: ax, clientY: ay } }));
          }
          ay += g * 10;
        } else if (attType === "video" && url) {
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: ax, clientY: ay } }));
          ay += g * 10;
        } else if (attType === "pdf") {
          const pdfText = String(att.pdfText || att.extractedText || "").trim();
          if (pdfText) {
            const title = String(att.name || att.memoryTitle || "PDF").trim();
            const combined = `# ${title}\n\n${pdfText}`;
            const charsPerLine = Math.max(1, Math.floor((g * 16 * 0.85) / 8));
            const wrappedLines = combined.split("\n").reduce((sum: number, line: string) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
            const height = Math.max(g * 6, Math.min(g * 30, wrappedLines * 22 + 32));
            st.addTextBlockAt({ x: ax, y: ay }, { width: g * 16, height, content: combined, format: "plain" });
          } else if (url) {
            const pdfName = String(att.name || att.memoryTitle || "document.pdf").trim();
            const pdfUrl = url;
            const px = ax;
            const py = ay;
            (async () => {
              try {
                const resp = await fetch(pdfUrl);
                if (resp.ok) {
                  const blob = await resp.blob();
                  const file = new File([blob], pdfName.endsWith(".pdf") ? pdfName : `${pdfName}.pdf`, { type: "application/pdf" });
                  window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX: px, clientY: py } }));
                  return;
                }
              } catch { /* fetch failed, fall through */ }
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: pdfUrl, clientX: px, clientY: py } }));
            })();
          }
          ay += g * 10;
        } else if (attType === "memory" && att.memoryContent) {
          const content = att.memoryTitle ? `# ${att.memoryTitle}\n\n${att.memoryContent}` : att.memoryContent;
          st.addTextBlockAt({ x: ax, y: ay }, { width: g * 12, height: g * 6, content, format: "rich" });
          ay += g * 8;
        } else if (url) {
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: ax, clientY: ay } }));
          ay += g * 8;
        }

        if (ay > Math.floor(-camera.y + g * 40)) {
          ax += g * 14;
          ay = Math.max(g, Math.floor(-camera.y + g * 2));
        }
      }
    }
  }, [addAiResponseBlock, addListBlockAt, boardId, deleteBlock, setListItems, typeIntoAiResponseBlock, user?.id]);

  const applyProjectActions = useCallback((actions: CreateAction[]) => {
    const list = Array.isArray(actions) ? actions : [];
    if (!list.length) return { created: 0, failures: [] as string[] };
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const camera = st.camera || { x: 0, y: 0, zoom: 1 };
    let x = Math.max(0, Math.floor(-camera.x + g * 2));
    let y = Math.max(0, Math.floor(-camera.y + g * 2));
    let created = 0;
    const failures: string[] = [];
    const makeId = (prefix = "b") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    for (const raw of list) {
      try {
        const type = String(raw?.type || "").trim().toLowerCase();
        const nextId = (id: string) => {
          const h = Number((st.blocks as any)[id]?.height || g);
          y += h + g;
          created += 1;
        };

        const normalizeLanguage = (lang: string) => {
          const value = String(lang || "plaintext").trim().toLowerCase();
          if (!value) return "plaintext";
          if (["js", "node", "nodejs"].includes(value)) return "javascript";
          if (["ts"].includes(value)) return "typescript";
          if (["py"].includes(value)) return "python";
          if (["sh", "shell"].includes(value)) return "bash";
          if (["md"].includes(value)) return "markdown";
          return value;
        };

        const defaultCodeFor = (language: string) => {
          if (language === "python") return `# Starter\n\ndef main():\n    print("Hello world")\n\n\nif __name__ == "__main__":\n    main()\n`;
          if (language === "javascript") return `// Starter\nfunction main() {\n  console.log("Hello world");\n}\n\nmain();\n`;
          if (language === "typescript") return `// Starter\ntype AppConfig = { name: string };\n\nconst config: AppConfig = { name: "My App" };\nconsole.log(config.name);\n`;
          if (language === "sql") return `-- Starter query\nSELECT 1 AS value;\n`;
          return "";
        };
        const setTextKind = (id: string, kind: string) => {
          const block = st.blocks?.[id];
          if (!block || block.type !== "text") return;
          st.updateBlock(id, {
            data: {
              ...((block as any)?.data || {}),
              kind,
            },
          } as any);
        };
        const normalizeCellKey = (k: string) => {
          const key = String(k || "").trim();
          if (!key) return null;
          if (/^\d+,\d+$/.test(key)) return key;
          if (/^\d+:\d+$/.test(key)) return key.replace(":", ",");
          const a1 = key.toUpperCase().match(/^([A-Z]+)(\d+)$/);
          if (a1) {
            const letters = a1[1];
            const row = Math.max(0, Number(a1[2]) - 1);
            let col = 0;
            for (let i = 0; i < letters.length; i += 1) col = col * 26 + (letters.charCodeAt(i) - 64);
            return `${row},${Math.max(0, col - 1)}`;
          }
          return null;
        };

        const createUniversalBlock = (rawAction: any) => {
          const definition = getBlockDefinition("brick");
          const width = g * Math.max(1, Number(definition?.defaultSize?.w || 8));
          const height = g * Math.max(1, Number(definition?.defaultSize?.h || 6));
          const extraData = rawAction?.data && typeof rawAction.data === "object" ? rawAction.data : {};
          const contentText = String((extraData as any)?.content || (extraData as any)?.body || "");
          const createdId = st.addTextBlockAt({ x, y }, { width, height, content: contentText, format: "plain" } as any);
          nextId(createdId);
        };

        const createDatabaseRelation = (rawAction: any) => {
          const fromName = String(rawAction?.fromDatabaseName || "").trim().toLowerCase();
          const toName = String(rawAction?.toDatabaseName || "").trim().toLowerCase();
          if (!fromName || !toName) {
            failures.push("create_database_relation missing from/to database names.");
            return;
          }
          const allBlocks = Object.values(st.blocks || {}) as any[];
          const fromDb = allBlocks.find((b) => String(b?.universalType || b?.universal?.blockType || "").toLowerCase() === "database" && String(b?.data?.title || "").toLowerCase() === fromName);
          const toDb = allBlocks.find((b) => String(b?.universalType || b?.universal?.blockType || "").toLowerCase() === "database" && String(b?.data?.title || "").toLowerCase() === toName);
          if (!fromDb || !toDb) {
            failures.push(`Could not find databases for relation: ${fromName} -> ${toName}`);
            return;
          }
          const relationType = (rawAction?.relationType || "one-to-many") as "one-to-one" | "one-to-many" | "many-to-many";
          const relation = { targetDatabaseId: toDb.id, relationType };
          const dbData = { ...(fromDb.data?.database || createDatabaseBlockData()) };
          dbData.relations = Array.isArray(dbData.relations) ? [...dbData.relations, relation] : [relation];
          const roll = rawAction?.rollup;
          if (roll?.property) {
            const rollup = {
              sourceRelation: toDb.id,
              property: String(roll.property),
              aggregation: (roll.aggregation || "count") as "sum" | "count" | "average",
            };
            dbData.rollups = Array.isArray(dbData.rollups) ? [...dbData.rollups, rollup] : [rollup];
          }
          st.updateBlock(fromDb.id, {
            data: {
              ...(fromDb.data || {}),
              database: dbData,
            },
          } as any);
        };

        if (type !== "create_universal_block") {
          failures.push(`Skipped legacy action in brick mode: ${type}`);
          continue;
        }

        if (false && (type === "create_sheet" || type === "paper_outline" || type === "create_paper")) {
          const title = String((raw as any)?.title || "").trim();
          const body = String((raw as any)?.content || (raw as any)?.outline || "").trim();
          const content = [title ? `# ${title}` : "", body].filter(Boolean).join("\n\n");
          const id = st.addSheetBlockAt({ x, y }, { content });
          setTextKind(id, "sheet");
          nextId(id);
          continue;
        }
        if (type === "create_universal_block") {
          createUniversalBlock(raw);
          continue;
        }
        if (type === "create_database_relation") {
          createDatabaseRelation(raw);
          continue;
        }
        if (type === "create_task_board") {
          const columnsRaw =
            Array.isArray((raw as any)?.columns) && (raw as any).columns.length
              ? (raw as any).columns
              : ["To Do", "In Progress", "Done"];
          const columns = columnsRaw
            .map((c: any, idx: number) => {
              const title = String(c?.title ?? c ?? `Column ${idx + 1}`).trim() || `Column ${idx + 1}`;
              const fromCardsByColumn = (raw as any)?.cardsByColumn?.[title];
              const fallbackCards = (raw as any)?.cards?.[title];
              const cards = Array.isArray(c?.cards)
                ? c.cards
                : Array.isArray(fromCardsByColumn)
                ? fromCardsByColumn
                : Array.isArray(fallbackCards)
                ? fallbackCards
                : [];
              return {
                id: String(c?.id || `col-${idx + 1}`),
                title,
                cards: cards.map((v: any) => String(v || "")).filter(Boolean),
              };
            })
            .slice(0, 6);

          const title = String((raw as any)?.title || "Task Board").trim() || "Task Board";
          const boardW = g * Math.max(18, columns.length * 6 + 4);
          const boardH = g * 16;
          const boardId = makeId("create");
          st.addBlock({
            id: boardId,
            type: "create",
            x,
            y,
            width: boardW,
            height: boardH,
            mode: "taskboard",
            data: { kind: "taskboard", title, columns },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as any);
          y += boardH + g;
          created += 1;
          continue;
        }
        if (type === "create_design_board" || type === "brainstorm") {
          const width = g * 20;
          const height = g * 14;
          const id = makeId("create");
          const seedText = String((raw as any)?.seedText || (raw as any)?.content || "").trim();
          st.addBlock({
            id,
            type: "create",
            x,
            y,
            width,
            height,
            mode: "design",
            data: {
              board: (raw as any)?.board || { version: 1, elements: [] },
              seedText,
              title: String((raw as any)?.title || "Design Board").trim() || "Design Board",
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as any);
          y += height + g;
          created += 1;
          continue;
        }
        if (type === "create_spreadsheet") {
          const rows = Math.max(1, Math.min(1000, Number((raw as any)?.rows || 30)));
          const cols = Math.max(1, Math.min(100, Number((raw as any)?.cols || 20)));
          const id = st.addSpreadsheetBlockAt({ x, y }, { rows, cols });
          setTextKind(id, "spreadsheet");
          const existing = String((st.blocks as any)?.[id]?.content || "");
          let parsedSheet: any = null;
          try {
            parsedSheet = JSON.parse(existing);
          } catch {
            parsedSheet = null;
          }
          const cellMap = { ...(parsedSheet?.cells || {}) } as Record<string, string>;
          const cellsObj = (raw as any)?.cells;
          const cells2d = Array.isArray((raw as any)?.cells2d) ? (raw as any).cells2d : null;
          if (cellsObj && typeof cellsObj === "object" && !Array.isArray(cellsObj)) {
            for (const [k, v] of Object.entries(cellsObj)) {
              const norm = normalizeCellKey(String(k));
              if (!norm) continue;
              cellMap[norm] = String(v ?? "");
            }
          }
          if (cells2d) {
            for (let r = 0; r < cells2d.length; r += 1) {
              const row = Array.isArray(cells2d[r]) ? cells2d[r] : [];
              for (let c = 0; c < row.length; c += 1) {
                if (row[c] == null) continue;
                cellMap[`${r},${c}`] = String(row[c]);
              }
            }
          }
          if (parsedSheet) {
            st.updateBlock(id, {
              content: JSON.stringify({
                ...parsedSheet,
                rows: Math.max(parsedSheet.rows || 0, rows),
                cols: Math.max(parsedSheet.cols || 0, cols),
                cells: cellMap,
              }),
            } as any);
          }
          nextId(id);
          continue;
        }
        if (type === "create_code_block" || type === "create_code_project") {
          const language = normalizeLanguage(String((raw as any)?.language || "plaintext"));
          const provided = String((raw as any)?.content || "").trim();
          const content = provided || defaultCodeFor(language);
          const id = st.addCodeBlockAt({ x, y }, { width: g * 14, height: g * 7, language, content });
          setTextKind(id, "code");
          nextId(id);
          continue;
        }
        if (type === "create_list" || type === "todo_list" || type === "bulleted_list" || type === "numbered_list") {
          const requested = String((raw as any)?.listType || "");
          const listType =
            requested === "numbered" || type === "numbered_list"
              ? "numbered"
              : requested === "bulleted" || type === "bulleted_list"
              ? "bulleted"
              : "todo";
          const id = st.addListBlockAt({ x, y }, { listType });
          const items = Array.isArray((raw as any)?.items)
            ? (raw as any).items
            : String((raw as any)?.content || "")
                .split(/\n+/)
                .map((s) => s.replace(/^\s*[-*]\s*/, "").trim())
                .filter(Boolean);
          if (items.length) {
            st.setListItems(
              id,
              items.map((text: string) => ({ id: `li-${Date.now()}-${Math.random()}`, text }))
            );
          }
          setTextKind(id, "list");
          nextId(id);
          continue;
        }
        failures.push(`Unsupported action: ${type || "unknown"}`);
      } catch {
        failures.push(`Failed action: ${String((raw as any)?.type || "unknown")}`);
      }
    }
    return { created, failures };
  }, []);

  const handleOrganizeIdeas = useCallback(
    async (intentText: string) => {
      if (!projectId) return;
      const result = await organizeIdeas(projectId, intentText);
      if (Array.isArray(result.actions) && result.actions.length) {
        applyProjectActions(result.actions);
      }
    },
    [applyProjectActions, organizeIdeas, projectId]
  );

  const handleProjectSuggestions = useCallback(
    async (promptText: string) => {
      if (!projectId) return;
      await getAISuggestions(projectId, promptText);
    },
    [getAISuggestions, projectId]
  );

  const handleProjectSummary = useCallback(async () => {
    if (!projectId) return;
    await generateProjectSummary(projectId);
  }, [generateProjectSummary, projectId]);

  const saveSnapshot = useCallback(async () => {
    if (!user?.id || !boardId || savingRef.current || !hydratedRef.current) return;
    savingRef.current = true;
    try {
      const snapshot = buildSnapshot();
      await supabase.from("omnia_board_states").insert({ board_id: boardId, state: snapshot, version: snapshot.version || SNAPSHOT_VERSION });
      await supabase
        .from("omnia_boards")
        .update({ title: snapshot.title || "Untitled board", updated_at: new Date().toISOString() })
        .eq("id", boardId);
      lastSavedTitleRef.current = snapshot.title || "Untitled board";
    } catch {
      // ignore
    } finally {
      savingRef.current = false;
    }
  }, [boardId, buildSnapshot, user?.id]);

  const commitBoardTitle = useCallback(async () => {
    if (!boardId || !user?.id) return;
    const next = String(title || "").trim() || "New Board";
    if (next === lastSavedTitleRef.current) return;
    lastSavedTitleRef.current = next;
    setTitle(next);
    await supabase
      .from("omnia_boards")
      .update({ title: next, updated_at: new Date().toISOString() })
      .eq("id", boardId)
      .eq("user_id", user.id);
  }, [boardId, title, user?.id]);

  const scheduleSave = useCallback(() => {
    if (!user?.id || !boardId || !hydratedRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveSnapshot();
    }, 15000);
  }, [boardId, saveSnapshot, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const loadBoard = async () => {
      hydratedRef.current = false;
      let id: string | null = routeBoardId || null;
      try {
        const existing = routeBoardId || localStorage.getItem("omnia_board_id");
        if (existing) {
          const { data } = await supabase
            .from("omnia_boards")
            .select("id, title")
            .eq("id", existing)
            .eq("user_id", user.id)
            .maybeSingle();
          if (data?.id) {
            id = data.id;
            if (data.title) setTitle(String(data.title));
            lastSavedTitleRef.current = String(data.title || "New Board");
          }
        }
      } catch {
        // ignore
      }
      if (!id) {
        const { data } = await supabase
          .from("omnia_boards")
          .insert(routeBoardId ? { id: routeBoardId, user_id: user.id, title: "New Board" } : { user_id: user.id, title: "New Board" })
          .select("id, title")
          .single();
        id = data?.id || null;
        if (data?.title) setTitle(String(data.title));
        lastSavedTitleRef.current = String(data?.title || "New Board");
        if (id) localStorage.setItem("omnia_board_id", id);
      }
      if (cancelled) return;
      setBoardId(id);
      if (!id) {
        hydratedRef.current = true;
        return;
      }
      reset();
      try {
        const { data } = await supabase
          .from("omnia_board_states")
          .select("state, version")
          .eq("board_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (data?.state) applySnapshot({ ...(data.state || {}), version: (data as any)?.version || (data.state as any)?.version || 1 });
      } catch {
        // ignore
      }
      hydratedRef.current = true;
    };
    loadBoard();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, routeBoardId, user?.id]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    let cancelled = false;
    const loadProjectForBoard = async () => {
      const { data } = await supabase
        .from("omnia_boards")
        .select("project_id")
        .eq("id", boardId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      const pid = data?.project_id || null;
      setProjectId(pid);
      if (!pid) {
        setProjectFolders([]);
        setProjectFiles([]);
        return;
      }
      try {
        const raw = localStorage.getItem(`project:${pid}`);
        if (!raw) {
          setProjectFolders([]);
          setProjectFiles([]);
          return;
        }
        const parsed = JSON.parse(raw);
        setProjectFolders(Array.isArray(parsed?.folders) ? parsed.folders : []);
        setProjectFiles(Array.isArray(parsed?.files) ? parsed.files : []);
      } catch {
        setProjectFolders([]);
        setProjectFiles([]);
      }
    };
    loadProjectForBoard();
    return () => {
      cancelled = true;
    };
  }, [boardId, user?.id]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    const unsubscribe = useCanvasStore.subscribe(() => {
      scheduleSave();
      if (projectId) markProjectDirty(projectId);
    });
    return () => {
      unsubscribe();
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [boardId, markProjectDirty, projectId, scheduleSave, user?.id]);

  useEffect(() => {
    if (!boardId || !user?.id || !hydratedRef.current) return;
    scheduleSave();
  }, [boardId, scheduleSave, title, user?.id]);

  useEffect(() => {
    if (!projectId) return;
    refreshKnowledgeBase(projectId);
  }, [projectId, refreshKnowledgeBase]);

  useEffect(() => {
    if (!aiSuggestions.length) return;
    const key = aiSuggestions.map((s) => s.id).join("|");
    if (key === lastSuggestionKeyRef.current) return;
    lastSuggestionKeyRef.current = key;
    setShowAiSuggestionToast(true);
    const timer = window.setTimeout(() => setShowAiSuggestionToast(false), 6000);
    return () => window.clearTimeout(timer);
  }, [aiSuggestions]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    const onBlur = () => saveSnapshot();
    const onVis = () => {
      if (document.visibilityState === "hidden") saveSnapshot();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [boardId, saveSnapshot, user?.id]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    return () => {
      saveSnapshot();
    };
  }, [boardId, saveSnapshot, user?.id]);

  useEffect(() => {
    // Disable auto-seeding on refresh. Canvas should only create blocks from explicit user actions.
    try {
      localStorage.removeItem("omnia_seed_v2");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const compute = () => {
      const el = document.activeElement as HTMLElement | null;
      const isEditable =
        !!el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          Boolean(el.closest?.("[contenteditable='true']")));
      setIsEditingField(isEditable);
    };
    compute();
    window.addEventListener("focusin", compute, true);
    window.addEventListener("focusout", compute, true);
    window.addEventListener("blur", compute, true);
    return () => {
      window.removeEventListener("focusin", compute, true);
      window.removeEventListener("focusout", compute, true);
      window.removeEventListener("blur", compute, true);
    };
  }, []);

  // Sync model picker with settings changes (same-tab + cross-tab), like the old Create panel.
  useEffect(() => {
    const sync = () => {
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) setSelectedModel(parsed.aiModel);
        if (typeof parsed.liveAIMode !== "undefined") setLiveAIMode(Boolean(parsed.liveAIMode));
        if (parsed.aiMode && ["think", "plan", "agent"].includes(parsed.aiMode)) setAiMode(parsed.aiMode);
      } catch {
        // ignore
      }
    };
    window.addEventListener("lykinsai_settings_changed", sync as any);
    window.addEventListener("storage", sync as any);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync as any);
      window.removeEventListener("storage", sync as any);
    };
  }, []);

  const runNativeUndoRedo = (kind: "undo" | "redo") => {
    const el = document.activeElement as HTMLElement | null;
    const isEditable =
      !!el &&
      (el.isContentEditable ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        Boolean(el.closest?.("[contenteditable='true']")));
    if (!isEditable) return false;
    try {
      // Prefer native editor history (letter-level) when typing inside a block.
      const ok = document.execCommand(kind);
      return Boolean(ok);
    } catch {
      return false;
    }
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

  const clearCanvasAndPrompts = useCallback(() => {
    reset();
    setChatMessages([]);
    setChatInput("");
    setFocusedChatAttachments([]);
    setChatStatusText("");
    setChatFlowMode("idle");
    aiThreadRef.current = [];
    clarificationSessionRef.current = {
      active: false,
      basePromptId: "",
      baseRequest: "",
      questions: [],
      answers: [],
      askedCount: 0,
    };
    lastAiResponseBlockRef.current = null;
    lastSendSigRef.current = { text: "", at: 0 };
    kbCacheRef.current = null;
    aiTypingRunRef.current += 1;
    isSendingRef.current = false;
  }, [reset]);

  const loadMemoryNotes = useCallback(async () => {
    if (!user?.id) {
      setMemoryNotes([]);
      setMemoryError("Sign in to access memories.");
      return;
    }
    setMemoryLoading(true);
    setMemoryError("");
    try {
      let data: MemorySidebarNote[] | null = null;
      let error: any = null;
      const fetchWithColumns = async (columns: string) =>
        supabase.from("notes").select(columns).eq("user_id", user.id).order("updated_at", { ascending: false }).limit(500);
      ({ data, error } = await supabase
        .from("notes")
        .select("id, title, content, attachments, folder, updated_at, created_at, tags, connected_notes, trashed")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(500));
      if (error && /column .*notes\.folder/i.test(String(error?.message || ""))) {
        ({ data, error } = (await fetchWithColumns("id, title, content, attachments, updated_at, created_at, tags, connected_notes, trashed")) as any);
      }
      if (error && /column .*notes\.attachments/i.test(String(error?.message || ""))) {
        ({ data, error } = (await fetchWithColumns("id, title, content, updated_at, created_at, tags, connected_notes, trashed")) as any);
      }
      if (error && /column .*notes\.(tags|connected_notes|trashed)/i.test(String(error?.message || ""))) {
        ({ data, error } = (await fetchWithColumns("id, title, content, updated_at, created_at")) as any);
      }
      if (error) throw error;
      setMemoryNotes(
        Array.isArray(data)
          ? data.map((note: any) => {
              const directAttachments = Array.isArray(note?.attachments) ? note.attachments : [];
              const parsedAttachments = parseAttachmentsFromContent(note?.content || "");
              return { ...note, attachments: directAttachments.length ? directAttachments : parsedAttachments } as MemorySidebarNote;
            })
          : []
      );
    } catch (err: any) {
      setMemoryError(String(err?.message || "Unable to load memories."));
      setMemoryNotes([]);
    } finally {
      setMemoryLoading(false);
    }
  }, [user?.id]);

  const insertMemoryNoteToCanvas = useCallback(
    (note: MemorySidebarNote) => {
      const st = useCanvasStore.getState();
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const cameraY = Number(st.camera?.y || 0);
      const worldX = g * 2;
      const worldY = Math.max(g, cameraY + Math.floor((window.innerHeight || 900) * 0.3));
      const titleText = String(note.title || "Untitled memory").trim();
      const bodyText = String(note.content || "").trim();
      const combined = bodyText ? `# ${titleText}\n\n${bodyText}` : `# ${titleText}`;
      const width = g * 12;
      const roughLines = combined.split("\n").length + Math.ceil(combined.length / 90);
      const height = Math.max(g * 4, Math.min(g * 30, roughLines * g));
      addTextBlockAt({ x: worldX, y: worldY }, { width, height, content: combined, format: "rich" });
      setShowMemorySidebar(false);
    },
    [addTextBlockAt]
  );

  // handleGoToChatPage removed — chat is now an inline mode on the canvas.

  useEffect(() => {
    if (!showMemorySidebar) return;
    void loadMemoryNotes();
  }, [showMemorySidebar, loadMemoryNotes]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "omnia-memory-drag-start" && e.data.data) {
        console.log("[MEMORY-DRAG] postMessage received: drag-start", e.data.data?.attachments?.map((a: any) => ({ type: a.type, url: a.url?.substring(0, 60), videoId: a.videoId })));
        (window as any).__omnia_pending_memory = { ...e.data.data, timestamp: Date.now() };
        setMemoryDragActive(true);
      }
      if (e.data.type === "omnia-memory-drag-end") {
        console.log("[MEMORY-DRAG] postMessage received: drag-end");
        setMemoryDragActive(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading || isSendingRef.current) return;
    // Keep typing flow uninterrupted after send.
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);

    const now = Date.now();
    if (lastSendSigRef.current.text === text && now - lastSendSigRef.current.at < 900) return;
    lastSendSigRef.current = { text, at: now };

    isSendingRef.current = true;
    const sentAttachments = [...focusedChatAttachments];
    setChatInput("");
    setFocusedChatAttachments([]);
    setIsChatLoading(true);
    setChatStatusText("Understanding your request...");
    setChatFlowMode("idle");
    const promptId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    // Whisper-transcribe video/YouTube attachments that have no transcript yet
    const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
    for (const att of sentAttachments) {
      if (att.transcript) continue;
      const isVideoType = ["video", "youtube"].includes(att.type?.toLowerCase());
      if (!isVideoType) continue;
      // YouTube attachments: use the transcript endpoint (server now has Whisper fallback)
      if (att.videoId) {
        try {
          setChatStatusText("Transcribing video with Whisper...");
          const tRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}`);
          if (tRes.ok) {
            const tData = await tRes.json();
            const t = String(tData?.transcript || "").trim();
            if (t) att.transcript = t;
          }
        } catch { /* continue without transcript */ }
        continue;
      }
      // Uploaded video with a data URL or blob: send to Whisper endpoint
      if (att.url && (att.url.startsWith("data:video/") || att.url.startsWith("data:audio/"))) {
        try {
          setChatStatusText("Transcribing uploaded video with Whisper...");
          const base64 = att.url.split(",")[1];
          if (base64) {
            const binaryStr = atob(base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const mime = att.mime || att.url.split(";")[0].split(":")[1] || "video/webm";
            const ext = mime.split("/")[1] || "webm";
            const blob = new Blob([bytes], { type: mime });
            const formData = new FormData();
            formData.append("file", blob, att.name || `video.${ext}`);
            const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, { method: "POST", body: formData });
            if (wRes.ok) {
              const wData = await wRes.json();
              const t = String(wData?.transcript || "").trim();
              if (t) att.transcript = t;
            }
          }
        } catch { /* continue without transcript */ }
      }
    }

    const attachmentContext = sentAttachments.length > 0
      ? "\n\n[Attached content]\n" + sentAttachments.map((a) => {
          const t = (a.type || "").toLowerCase();
          const label = a.name || a.memoryTitle || "Untitled";
          const parts: string[] = [];
          if (a.memoryContent) parts.push(a.memoryContent);
          if (a.pdfText) parts.push(a.pdfText);
          if (a.transcript) parts.push(a.transcript);
          if (t === "memory" || t === "note") {
            return `${t === "note" ? "Note" : "Memory"} "${label}": ${parts.join("\n") || "(empty)"}`;
          }
          if (t === "pdf") return `PDF "${label}": ${parts.join("\n") || `(PDF at ${a.url})`}`;
          if (t === "youtube") {
            const ctx = parts.length ? parts.join("\n") : "";
            return `YouTube video "${label}"${a.videoId ? ` (${a.videoId})` : ""}${a.url ? ` — ${a.url}` : ""}${ctx ? `\nTranscript: ${ctx}` : ""}`;
          }
          if (t === "video" || t === "audio") {
            return `${t === "video" ? "Video" : "Audio"} "${label}"${a.url ? ` — ${a.url}` : ""}${parts.length ? `\nTranscript: ${parts.join("\n")}` : ""}`;
          }
          if (t === "image") return `Image "${label}"${a.url ? ` — ${a.url}` : ""}`;
          if (t === "link") return `Link "${label}"${a.url ? ` — ${a.url}` : ""}${parts.length ? `\nContent: ${parts.join("\n")}` : ""}`;
          if (parts.length) return `${label}: ${parts.join("\n")}`;
          if (a.url) return `${t || "File"} "${label}" — ${a.url}`;
          return `${t || "File"}: ${label}`;
        }).join("\n\n")
      : "";

    const displayText = text;
    setChatMessages((prev) => [...prev, {
      id: promptId, role: "user", content: displayText, kind: "prompt",
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    }]);

    // In focused chat mode, skip canvas brick — responses go inline in the chat.
    let responseBlockId: string | null = null;
    if (!chatMode) {
      const existingAiIds = (Array.isArray(blockOrder) ? blockOrder : []).filter((id) =>
        Boolean((blocks as any)?.[id]?.data?.aiResponseBubble)
      );
      for (const id of existingAiIds) {
        try { deleteBlock(id as any); } catch { /* ignore */ }
      }
      lastAiResponseBlockRef.current = null;
      responseBlockId = addAiResponseBlock("AI is thinking...") as string | null;
      lastAiResponseBlockRef.current = responseBlockId ? String(responseBlockId) : null;
    }

    try {
      aiThreadRef.current.push({ role: "user", content: text + attachmentContext });
      if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);

      const history = aiThreadRef.current
        .slice(-40)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const canvasContext = buildCanvasContext();
      const kbText = await getKnowledgeBaseContext();
      const API_BASE_URL = apiBase;
      const asksAboutVideo = isVideoQuestion(text);
      const visibleVideos = getVisibleYouTubeBlocks();
      // Also consider YouTube attachments sent alongside the message
      const attachedYouTubeVideos = sentAttachments
        .filter((a) => a.type?.toLowerCase() === "youtube" && a.videoId)
        .map((a) => ({ videoId: a.videoId!, url: a.url, title: a.name || `YouTube ${a.videoId}` }));
      const allYouTubeVideos = [
        ...visibleVideos,
        ...attachedYouTubeVideos.filter((av) => !visibleVideos.some((vv) => vv.videoId === av.videoId)),
      ];
      let youtubeGrounding = "";
      if (!asksAboutVideo) {
        setChatStatusText("Analyzing visible YouTube videos...");
        youtubeGrounding = await buildYouTubeGrounding(API_BASE_URL, text);
      }
      if (asksAboutVideo && allYouTubeVideos.length) {
        setChatStatusText("Answering from YouTube transcript...");
        const targetVideo = allYouTubeVideos[0];
        const answerRes = await fetch(`${API_BASE_URL}/api/youtube/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: targetVideo.videoId,
            question: text,
            allowOcr: false,
          }),
        });
        const answerData = await answerRes.json().catch(() => ({}));
        if (!answerRes.ok) {
          setChatStatusText("No captions found — transcribing with Whisper...");
          const whisperTRes = await fetch(`${API_BASE_URL}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}`).catch(() => null);
          const whisperTJson = whisperTRes && whisperTRes.ok ? await whisperTRes.json().catch(() => ({})) : {};
          const whisperTranscript = String((whisperTJson as any)?.transcript || "").trim();
          if (whisperTranscript) {
            youtubeTranscriptCacheRef.current[targetVideo.videoId] = {
              fetchedAt: Date.now(),
              title: targetVideo.title || `YouTube ${targetVideo.videoId}`,
              url: targetVideo.url,
              transcript: whisperTranscript,
              segments: Array.isArray((whisperTJson as any)?.segments) ? (whisperTJson as any).segments : [],
            };
            setChatStatusText("Whisper transcript ready — answering...");
            const retryRes = await fetch(`${API_BASE_URL}/api/youtube/answer`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoId: targetVideo.videoId, question: text, allowOcr: false }),
            });
            const retryData = await retryRes.json().catch(() => ({}));
            if (retryRes.ok) {
              const finalText = formatGroundedVideoAnswer(retryData);
              setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
              aiThreadRef.current.push({ role: "assistant", content: finalText });
              if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
              if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
              setChatStatusText("Answered");
              return;
            }
          }
          setChatStatusText("Falling back to available YouTube context...");
          youtubeGrounding = await buildYouTubeGrounding(API_BASE_URL, text);
          const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
          const apiReason = String((answerData as any)?.reason || (answerData as any)?.error || "").trim();
          const finalText =
            fallback ||
            apiReason ||
            "I can see the video, but I couldn't fetch enough transcript data right now. I can still answer once captions/transcript become available.";
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
          aiThreadRef.current.push({ role: "assistant", content: finalText });
          if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
          if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
          setChatStatusText("Answered");
          return;
        }
        const finalText = formatGroundedVideoAnswer(answerData);
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
        aiThreadRef.current.push({ role: "assistant", content: finalText });
        if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
        if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
        setChatStatusText("Answered");
        return;
      }
      if (asksAboutVideo && !allYouTubeVideos.length) {
        const finalText = "I can't find a YouTube video on the board or in your attachments. Add a YouTube video and ask again.";
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
        aiThreadRef.current.push({ role: "assistant", content: finalText });
        if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
        if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
        setChatStatusText("Answered");
        return;
      }
      const prompt = `You are LYKN — a multi-model orchestration agent powering an infinite canvas workspace.
Answer the user's latest message directly.
Do not ask follow-up questions unless the user explicitly asks you to ask them.
Do not suggest taking notes. Just answer.
Use available board context, YouTube transcript context, and any attached content when relevant.
The user may attach files, notes, images, videos, PDFs, links, or memory items alongside their message — always read and reference that attached content in your answer.
If transcript evidence is missing, say that clearly.

Conversation so far:
${history || "(none)"}

Canvas context:
${canvasContext || "(empty)"}

Project knowledge base:
${kbText || "(none)"}

Visible YouTube transcript context:
${youtubeGrounding || "(none)"}

Latest user message:
${text}${attachmentContext}`;
      const attachedImageUrls = sentAttachments
        .filter((a) => a.type?.toLowerCase() === "image" && a.url)
        .map((a) => a.url);
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          prompt,
          text,
          intent: "ask",
          aiMode,
          returnActions: false,
          context: `${canvasContext || ""}\n\nYouTube transcript context:\n${youtubeGrounding || "(none)"}`.trim(),
          knowledgeBase: kbText,
          projectId,
          ...(attachedImageUrls.length ? { imageUrls: attachedImageUrls } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const apiError = String((data as any)?.error || "").trim();
        const finalText =
          apiError ||
          "The AI service is available but returned an error for this request. Please try again.";
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
        aiThreadRef.current.push({ role: "assistant", content: finalText });
        if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
        if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
        setChatStatusText("Answered");
        return;
      }
      let aiText = String(data?.response || data?.answer || data?.text || "").trim();
      const hasYouTubeGrounding = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
      aiText = sanitizeAssistantResponse(aiText);
      if (!hasYouTubeGrounding && asksAboutVideo) {
        aiText = "I can see a YouTube block, but I couldn't access a usable transcript yet. Please play/reload the video or share a link with captions enabled, and I will answer directly from it.";
      } else if (hasYouTubeGrounding && asksAboutVideo) {
        // For direct video questions, force transcript-grounded answer instead of model guesses.
        const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
        if (fallback) aiText = fallback;
      } else if (hasYouTubeGrounding && (looksLikeDeflectingQuestion(aiText) || !aiText)) {
        const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
        if (fallback) aiText = fallback;
      }
      const finalText = String(aiText || "").trim() || "I couldn't find enough grounded information on the board to answer that yet.";
      setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
      aiThreadRef.current.push({ role: "assistant", content: finalText });
      if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
      if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
      setChatStatusText("Answered");
    } catch {
      setChatFlowMode("idle");
      setChatStatusText("Generation failed. Please retry.");
      if (responseBlockId) {
        updateBlock(String(responseBlockId) as any, { content: "I couldn't process that request. Please try again." } as any);
      }
    } finally {
      setIsChatLoading(false);
      isSendingRef.current = false;
      setChatFlowMode("idle");
      window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    }
  };

  const handleCenterAskSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading || isSendingRef.current) return;
    setChatMode(true);
    await handleChatSend();
  }, [chatInput, handleChatSend, isChatLoading]);

  useEffect(() => {
    if (!chatMode) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading, chatMode]);

  useEffect(() => {
    if (!chatMode) return;
    const t = window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [chatMode]);

  const resizeChatInput = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const maxHeight = 220;
    el.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(44, el.scrollHeight));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  const canvasFileBlocks = useMemo(() => {
    if (!chatMode) return [];
    const st = useCanvasStore.getState();
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const items: { id: string; type: string; name: string; url: string; thumbUrl: string; videoId?: string; content?: string }[] = [];
    for (const id of ids) {
      const b = (st.blocks as any)?.[id];
      if (!b) continue;
      const bType = String(b.type || "");
      const mode = String(b.mode || b.data?.mode || "").toLowerCase();

      if (bType === "youtube" || (bType === "create" && mode === "video")) {
        const videoId = String(b.videoId || b.data?.videoId || "");
        const url = String(b.url || b.data?.url || "");
        const vid = videoId || extractYouTubeVideoId(url) || "";
        if (vid || url) {
          items.push({ id, type: "youtube", name: b.data?.title || `YouTube ${vid}`, url: url || `https://www.youtube.com/watch?v=${vid}`, thumbUrl: vid ? `https://img.youtube.com/vi/${vid}/mqdefault.jpg` : "", videoId: vid });
        }
        continue;
      }
      if (bType === "image" || (bType === "create" && ["image", "generated"].includes(mode))) {
        const src = String(b.src || b.data?.src || b.url || b.data?.url || b.dataUrl || b.data?.dataUrl || "");
        if (src) items.push({ id, type: "image", name: b.name || b.data?.name || "Image", url: src, thumbUrl: src });
        continue;
      }
      if (bType === "file" || (bType === "create" && mode === "embed")) {
        const url = String(b.url || b.data?.url || b.dataUrl || b.data?.dataUrl || "");
        const name = String(b.name || b.data?.name || "File");
        const mime = String(b.mime || b.data?.mime || "").toLowerCase();
        if (mime.startsWith("image/")) { items.push({ id, type: "image", name, url, thumbUrl: url }); continue; }
        if (mime.startsWith("video/")) { items.push({ id, type: "video", name, url, thumbUrl: "" }); continue; }
        if (mime.startsWith("audio/")) { items.push({ id, type: "audio", name, url, thumbUrl: "" }); continue; }
        if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) { items.push({ id, type: "pdf", name, url, thumbUrl: "", content: String(b.data?.pdfText || b.data?.extractedText || "") }); continue; }
        if (url) items.push({ id, type: "file", name, url, thumbUrl: "" });
        continue;
      }
      if (bType === "link") {
        const url = String(b.url || b.data?.url || "");
        if (url) {
          const yt = extractYouTubeVideoId(url);
          if (yt) { items.push({ id, type: "youtube", name: b.data?.title || "YouTube", url, thumbUrl: `https://img.youtube.com/vi/${yt}/mqdefault.jpg`, videoId: yt }); }
          else { items.push({ id, type: "link", name: b.data?.title || url, url, thumbUrl: "" }); }
        }
        continue;
      }
      if (bType === "text") {
        const content = String(b.content || "").trim();
        if (content) {
          const isAi = Boolean(b.data?.aiResponseBubble);
          const label = isAi ? "AI Response" : (content.split("\n")[0].slice(0, 40) || "Note");
          items.push({ id, type: "note", name: label, url: "", thumbUrl: "", content });
        }
        continue;
      }
      // Catch-all for any remaining create blocks with content
      if (bType === "create") {
        const content = String(b.content || b.data?.content || b.data?.seedText || "").trim();
        const name = String(b.data?.title || mode || "Block").trim();
        if (content || mode) {
          items.push({ id, type: "note", name, url: "", thumbUrl: "", content: content || `(${mode} block)` });
        }
      }
    }
    const attachedBlockIds = new Set(focusedChatAttachments.map((a) => a.canvasBlockId).filter(Boolean));
    return attachedBlockIds.size > 0 ? items.filter((item) => !attachedBlockIds.has(item.id)) : items;
  }, [chatMode, blocks, blockOrder, focusedChatAttachments]);

  const removeFocusedAttachment = useCallback((id: string) => {
    setFocusedChatAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const addFocusedAttachment = useCallback((att: FocusedChatAttachment) => {
    setFocusedChatAttachments((prev) => {
      const isDup = prev.some((existing) => {
        if (att.url && existing.url && att.url === existing.url) return true;
        if (att.videoId && existing.videoId && att.videoId === existing.videoId) return true;
        if (att.type === "memory" && existing.type === "memory" && att.memoryContent && existing.memoryContent && att.memoryContent === existing.memoryContent) return true;
        if (att.type === "note" && existing.type === "note" && att.memoryContent && existing.memoryContent && att.memoryContent === existing.memoryContent) return true;
        return false;
      });
      if (isDup) return prev;
      return [...prev, att];
    });
  }, []);

  const applyMemoryDropToChat = useCallback(async (payload: any) => {
    if (!payload) return;
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
          try {
            const path = att?.storagePath || url;
            const bucket = att?.storageBucket || "user-files";
            const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24);
            if (data?.signedUrl) url = data.signedUrl;
          } catch { /* ignore */ }
        }

        const transcript = String(att?.transcript || "").trim();
        const pdfText = String(att?.pdfText || att?.extractedText || "").trim();
        addFocusedAttachment({
          id: makeAttId(),
          type: attType || inferUrlAttachmentType(url),
          url,
          name: String(att?.name || att?.title || title || url).trim(),
          mime: String(att?.mime || ""),
          size: Number(att?.size || 0),
          memoryTitle: title,
          ...(videoId ? { videoId } : {}),
          ...(transcript ? { transcript } : {}),
          ...(pdfText ? { pdfText } : {}),
        });
      }
    } else if (content) {
      addFocusedAttachment({
        id: makeAttId(),
        type: "memory",
        url: "",
        name: title || "Memory",
        mime: "",
        size: 0,
        memoryTitle: title,
        memoryContent: content,
      });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment]);

  const renderFocusedAttachmentPreview = useCallback((att: FocusedChatAttachment) => {
    const t = att.type.toLowerCase();
    const videoId = att.videoId || (t === "youtube" ? extractYouTubeVideoId(att.url) : null);

    if (t === "youtube" && videoId) {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} alt={att.name || "YouTube"} className="w-full h-full object-cover" draggable={false} />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-red-600 rounded-lg flex items-center justify-center shadow-md"><Play className="w-3.5 h-3.5 text-white ml-0.5" fill="white" /></div>
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.memoryTitle || att.name || "YouTube Video"}</span>
        </div>
      );
    }
    if (t === "image") {
      return (
        <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-black/5 flex-shrink-0 group">
          <img src={att.url} alt={att.name || "Image"} className="w-full h-full object-cover" draggable={false} />
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "video") {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <video src={att.url} className="w-full h-full object-cover" preload="metadata" muted draggable={false} />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-white/80 rounded-lg flex items-center justify-center shadow-md"><Play className="w-3.5 h-3.5 text-black ml-0.5" fill="black" /></div>
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.memoryTitle || att.name || "Video"}</span>
        </div>
      );
    }
    if (t === "audio") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <Music className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.memoryTitle || att.name || "Audio"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "memory") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-violet-300/40 bg-violet-100/40 px-3 py-2 max-w-[16.25rem] group">
          <BookOpen className="w-4 h-4 flex-shrink-0 text-violet-500" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.memoryTitle || "Memory"}</span>
            {att.memoryContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.memoryContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "pdf") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.memoryTitle || att.name || "PDF"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "note") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-100/40 px-3 py-2 max-w-[16.25rem] group">
          <StickyNote className="w-4 h-4 flex-shrink-0 text-amber-600" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.name || "Note"}</span>
            {att.memoryContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.memoryContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
        <Link2 className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[12.5rem] truncate text-xs">{att.memoryTitle || att.name || att.url || "Attachment"}</span>
        <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
      </div>
    );
  }, [removeFocusedAttachment]);

  const handleFocusedChatDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFocusedChatDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Canvas file collage item
    const canvasFileRaw = e.dataTransfer.getData("application/x-canvas-file");
    if (canvasFileRaw) {
      try {
        const item = JSON.parse(canvasFileRaw);
        const itemType = String(item.type || "link").toLowerCase();
        const hasContent = Boolean(item.content);
        addFocusedAttachment({
          id: makeAttId(),
          type: itemType,
          url: item.url || "",
          name: item.name || "Canvas file",
          mime: "",
          size: 0,
          ...(item.videoId ? { videoId: item.videoId } : {}),
          ...(hasContent && (itemType === "note" || itemType === "memory") ? { memoryContent: item.content } : {}),
          ...(hasContent && itemType === "pdf" ? { pdfText: item.content } : {}),
          ...(hasContent && !["note", "memory", "pdf"].includes(itemType) ? { memoryContent: item.content } : {}),
          ...(item.id ? { canvasBlockId: item.id } : {}),
        });
        window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
        return;
      } catch { /* fall through */ }
    }

    const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text") || "").trim();
    if (text) {
      const urls = text.split(/\r?\n/).filter((u: string) => /^https?:\/\//i.test(u.trim()));
      if (urls.length > 0) {
        for (const u of urls) {
          addFocusedAttachment({ id: makeAttId(), type: inferUrlAttachmentType(u.trim()), url: u.trim(), name: u.trim(), mime: "", size: 0 });
        }
      } else {
        addFocusedAttachment({ id: makeAttId(), type: "memory", url: "", name: "Dropped text", mime: "", size: 0, memoryTitle: "Dropped text", memoryContent: text });
      }
    }
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const reader = new FileReader();
      const file = f;
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const mime = file.type || "";
        let type = "file";
        if (mime.startsWith("image/")) type = "image";
        else if (mime.startsWith("video/")) type = "video";
        else if (mime.startsWith("audio/")) type = "audio";
        else if (mime === "application/pdf") type = "pdf";
        addFocusedAttachment({ id: makeAttId(), type, url: dataUrl, name: file.name, mime, size: file.size });
      };
      reader.readAsDataURL(f);
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment]);

  useEffect(() => {
    // Keep whichever composer is visible synced with current text height.
    resizeChatInput(chatPanelInputRef.current);
    resizeChatInput(centerChatInputRef.current);
  }, [chatInput, resizeChatInput, chatMode]);

  useEffect(() => {
    return () => {
      aiTypingRunRef.current += 1;
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

  const handleOpenAttachments = useCallback(() => {
    setShowAttachMenu(true);
  }, []);

  const handleDictateToggle = useCallback(() => {
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

    const transcribeAudio = async (blob: Blob) => {
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
          setChatInput((prev) => `${String(prev || "").trim()} ${transcript}`.trim());
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
  }, [isDictating]);

  const handleVoiceToggle = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const latestAssistant = [...chatMessages]
      .reverse()
      .find((m) => String(m?.aiResponse || "").trim());
    const textToRead = String(latestAssistant?.aiResponse || "").trim();
    if (!textToRead) return;

    const utterance = new SpeechSynthesisUtterance(textToRead);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.cancel();
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [chatMessages, isSpeaking]);

  return (
    <div className="w-full h-[100svh] relative overflow-hidden bg-transparent">
      {/* Match BrickEditor layout: minimal chrome + floating controls */}
      {/* Heading panel (matches Create view top pill) */}
      <div className={`fixed top-3 left-0 z-[70] px-3 flex items-center justify-end pointer-events-none transition-[right] duration-300 ${showMemorySidebar ? "right-[380px]" : "right-0"}`}>
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

              {/* AI mode selector (Think / Plan / Agent) */}
              <Select
                value={aiMode}
                onValueChange={(value: string) => {
                  const mode = value as AiMode;
                  setAiMode(mode);
                  try {
                    const saved = localStorage.getItem("lykinsai_settings");
                    const settings = saved ? JSON.parse(saved) : {};
                    settings.aiMode = mode;
                    localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                    window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                  } catch { /* ignore */ }
                }}
              >
                <SelectTrigger className="w-[8.125rem] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium justify-center gap-1">
                  <SelectValue placeholder="Mode" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="glass-control border border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/10 backdrop-blur-xl shadow-lg overflow-hidden"
                >
                  {(Object.entries(AI_MODE_META) as [AiMode, typeof AI_MODE_META["think"]][]).map(([key, meta]) => {
                    const Icon = meta.icon;
                    return (
                      <SelectItem key={key} value={key}>
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          {meta.label}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              {/* AI model selector (matches old Create panel) */}
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
                <SelectTrigger className="w-[8.125rem] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
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

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onPointerDown={(e) => {
                  // Keep focus in the active editor so native undo works.
                  e.preventDefault();
                }}
                onClick={() => {
                  if (!runNativeUndoRedo("undo")) undo();
                }}
                disabled={!isEditingField && !canUndo}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                title="Undo (Ctrl/Cmd+Z)"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  // Keep focus in the active editor so native redo works.
                  e.preventDefault();
                }}
                onClick={() => {
                  if (!runNativeUndoRedo("redo")) redo();
                }}
                disabled={!isEditingField && !canRedo}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                title="Redo (Ctrl/Cmd+Shift+Z / Ctrl+Y)"
              >
                <Redo2 className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={clearCanvasAndPrompts}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title="Clear canvas"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setChatMode((v) => !v)}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${chatMode ? "bg-blue-500/15" : ""}`}
                title={chatMode ? "Exit chat" : "Open chat"}
              >
                <MessageSquare className={`w-4 h-4 ${chatMode ? "text-blue-500" : ""}`} />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowMemorySidebar((v) => !v)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={showMemorySidebar ? "Hide memory sidebar" : "Open memory sidebar"}
              >
                {showMemorySidebar ? <PanelRightClose className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowAttachMenu(true)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title="Attachments"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        className={`h-full transition-[width,margin-right] duration-300 ${chatMode ? "invisible pointer-events-none" : ""}`}
        style={{
          marginRight: `${chatRailWidthPx + (showMemorySidebar ? 380 : 0)}px`,
          width: `calc(100% - ${chatRailWidthPx + (showMemorySidebar ? 380 : 0)}px)`,
        }}
      >
        <Canvas liveAIMode={false} isAiThinking={isChatLoading} />
      </div>

      {memoryDragActive && (
        <div
          className="fixed inset-0 z-[90]"
          style={{ background: "transparent" }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMemoryDragActive(false);
            const pending = (window as any).__omnia_pending_memory;
            console.log("[MEMORY-DROP] overlay onDrop fired, pending:", !!pending, pending);
            if (!pending || typeof pending !== "object") { console.log("[MEMORY-DROP] no pending data, aborting"); return; }
            (window as any).__omnia_pending_memory = null;

            const attachments = Array.isArray(pending.attachments) ? pending.attachments : [];

            // In focused chat mode, route dropped content as visual attachments
            if (chatMode) {
              void applyMemoryDropToChat(pending);
              return;
            }

            console.log("[MEMORY-DROP] attachments:", attachments.map((a: any) => ({ type: a.type, url: a.url?.substring(0, 80), videoId: a.videoId })));
            const youtubeAttach = attachments.find((a: any) =>
              a.type === "youtube" || a.videoId || (a.url && (a.url.includes("youtube.com") || a.url.includes("youtu.be")))
            );
            console.log("[MEMORY-DROP] youtubeAttach:", youtubeAttach ? { type: youtubeAttach.type, url: youtubeAttach.url?.substring(0, 80), videoId: youtubeAttach.videoId } : null);
            const imageAttach = attachments.find((a: any) =>
              a.type === "image" || (a.url && /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:image/"))
            );
            const videoAttach = attachments.find((a: any) =>
              a.type === "video" || (a.url && /\.(mp4|mov|webm|avi)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:video/"))
            );
            const linkAttach = attachments.find((a: any) => a.url && a.type !== "file");
            const cx = e.clientX;
            const cy = e.clientY;

            const toFile = (dataUrl: string, name: string): File | null => {
              try {
                const parts = dataUrl.split(",");
                const mm = parts[0].match(/:(.*?);/);
                if (!mm || !parts[1]) return null;
                const bstr = atob(parts[1]);
                const u8 = new Uint8Array(bstr.length);
                for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
                return new File([u8], name, { type: mm[1] });
              } catch { return null; }
            };

            // YouTube → direct store call (bypasses all event chains)
            if (youtubeAttach) {
              let ytUrl = String(youtubeAttach.url || "").trim();
              const vid = String(youtubeAttach.videoId || "").trim();
              if (!extractYouTubeVideoId(ytUrl) && vid) {
                ytUrl = `https://www.youtube.com/watch?v=${vid}`;
              }
              if (!ytUrl && vid) {
                ytUrl = `https://www.youtube.com/watch?v=${vid}`;
              }
              const extractedVid = extractYouTubeVideoId(ytUrl) || vid;
              console.log("[MEMORY-DROP] YouTube processing:", { ytUrl, vid, extractedVid });
              if (ytUrl && extractedVid) {
                const st = useCanvasStore.getState();
                const existingIds = Array.isArray(st.blockOrder) ? st.blockOrder : [];
                const alreadyOnCanvas = existingIds.some((bid: string) => {
                  const blk = (st.blocks as any)?.[bid];
                  return blk && (blk.videoId === extractedVid || blk.data?.videoId === extractedVid || blk.url === ytUrl || blk.data?.url === ytUrl);
                });
                if (alreadyOnCanvas) { console.log("[MEMORY-DROP] YouTube duplicate, skipping"); return; }
                const g = Math.max(1, Math.floor(st.gridSize || 24));
                const canvasEl = document.querySelector<HTMLElement>(".overflow-auto.overscroll-contain");
                const rect = canvasEl?.getBoundingClientRect();
                const localX = rect ? cx - rect.left : cx;
                const localY = rect ? cy - rect.top : cy;
                const wx = Math.round(localX / g) * g;
                const wy = Math.round((Number(st.camera?.y || 0) + localY) / g) * g;
                console.log("[MEMORY-DROP] Creating YouTube block at", { wx, wy, ytUrl, extractedVid });
                st.addYouTubeBlockAt({ x: wx, y: wy }, { url: ytUrl, videoId: extractedVid });
              } else {
                console.log("[MEMORY-DROP] YouTube: no valid URL or videoId, skipping");
              }
              return;
            }

            // Images → file pipeline (same as dragging from desktop)
            if (imageAttach?.url) {
              if (imageAttach.url.startsWith("data:image/")) {
                const f = toFile(imageAttach.url, imageAttach.name || "image.png");
                if (f) { window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
              }
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: imageAttach.url, clientX: cx, clientY: cy } }));
              return;
            }

            // Videos → file pipeline for data URLs
            if (videoAttach?.url) {
              if (videoAttach.url.startsWith("data:video/")) {
                const f = toFile(videoAttach.url, videoAttach.name || "video.mp4");
                if (f) { window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
              }
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: videoAttach.url, clientX: cx, clientY: cy } }));
              return;
            }

            // PDFs → text block with extracted content, or embed fallback
            const pdfAttach = attachments.find((a: any) =>
              a.type === "pdf" || (a.url && /\.pdf(\?|$)/i.test(a.url)) || (a.mime && a.mime === "application/pdf")
            );
            if (pdfAttach) {
              const pdfText = String(pdfAttach.pdfText || pdfAttach.extractedText || "").trim();
              if (pdfText) {
                const st = useCanvasStore.getState();
                const g = Math.max(1, Math.floor(st.gridSize || 24));
                const canvasEl = document.querySelector<HTMLElement>(".overflow-auto.overscroll-contain");
                const rect = canvasEl?.getBoundingClientRect();
                const localX = rect ? cx - rect.left : cx;
                const localY = rect ? cy - rect.top : cy;
                const wx = Math.round(localX / g) * g;
                const wy = Math.round((Number(st.camera?.y || 0) + localY) / g) * g;
                const title = String(pdfAttach.name || pdfAttach.title || "PDF").trim();
                const combined = `# ${title}\n\n${pdfText}`;
                const charsPerLine = Math.max(1, Math.floor((g * 16 * 0.85) / 8));
                const wrappedLines = combined.split("\n").reduce((sum: number, line: string) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
                const height = Math.max(g * 6, Math.min(g * 30, wrappedLines * 22 + 32));
                st.addTextBlockAt({ x: wx, y: wy }, { width: g * 16, height, content: combined, format: "plain" });
                return;
              }
              if (pdfAttach.url) {
                const pdfUrl = String(pdfAttach.url);
                const pdfName = String(pdfAttach.name || pdfAttach.title || "document.pdf").trim();
                (async () => {
                  try {
                    const resp = await fetch(pdfUrl);
                    if (resp.ok) {
                      const blob = await resp.blob();
                      const file = new File([blob], pdfName.endsWith(".pdf") ? pdfName : `${pdfName}.pdf`, { type: "application/pdf" });
                      window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX: cx, clientY: cy } }));
                      return;
                    }
                  } catch { /* fetch failed, fall through */ }
                  window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: pdfUrl, clientX: cx, clientY: cy } }));
                })();
                return;
              }
            }

            // Other links
            if (linkAttach?.url) {
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: linkAttach.url, clientX: cx, clientY: cy } }));
              return;
            }

            // Check content for URLs
            const content = String(pending.content || "");
            const urlMatch = content.match(/https?:\/\/[^\s<>"')]+/i);
            if (urlMatch) {
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: urlMatch[0], clientX: cx, clientY: cy } }));
              return;
            }

            // Pure text → text block
            window.dispatchEvent(
              new CustomEvent("omnia_attach_memory_text", { detail: { title: pending.title, content: pending.content, clientX: cx, clientY: cy } })
            );
          }}
          onDragLeave={(e) => {
            if (!e.relatedTarget) setMemoryDragActive(false);
          }}
        />
      )}

      <aside
        className={`fixed top-0 right-0 z-[95] h-[100svh] w-[23.75rem] max-w-[92vw] border-l border-white/20 dark:border-white/10 bg-white/40 dark:bg-[rgba(20,20,24,0.55)] shadow-[0_18px_60px_rgba(0,0,0,0.22)] backdrop-blur-[40px] backdrop-saturate-[1.6] transition-transform duration-300 ${
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
              <PanelRightClose className="w-4 h-4" />
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

      {/* Center welcome prompt (no messages yet, not in chat mode) */}
      {!chatMode && chatMessages.length === 0 && (
        <div className="fixed inset-0 z-[85] pointer-events-none flex items-center justify-center px-4 transition-all duration-300">
          <div className="w-full max-w-2xl space-y-6">
            <p className="pointer-events-none text-center text-3xl font-semibold tracking-tight min-h-[44px] text-black">
              {typedWelcome}
            </p>
            <div className="pointer-events-auto glass-control rounded-2xl p-2 w-full transition-all duration-300">
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleOpenAttachments} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10" title="Add attachments">
                  <Plus className="w-4 h-4" />
                </button>
                <textarea
                  ref={centerChatInputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onInput={(e) => resizeChatInput(e.currentTarget)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleCenterAskSend(); } }}
                  placeholder="Ask me anything..."
                  rows={1}
                  className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                />
                <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isDictating ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Dictate">
                  <Mic className="w-4 h-4" />
                </button>
                <button type="button" onClick={handleVoiceToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isSpeaking ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Voice">
                  <Volume2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Side rail chat (canvas mode — messages exist) */}
      {!chatMode && chatMessages.length > 0 && (
        <div
          className={`fixed top-[4.9rem] bottom-0 z-[64] flex flex-col bg-transparent border-l border-black/10 transition-[right] duration-300 ${showMemorySidebar ? "right-[380px]" : "right-0"}`}
          style={{ width: `${chatRailWidthPx}px` }}
        >
          <div className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize z-[70] pointer-events-auto" onPointerDown={handleStartChatResize} title="Drag to resize chat" />
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-3">
            {isChatLoading && (<div className="text-[0.6875rem] text-black/60 px-1" aria-live="polite">Working...</div>)}
            {chatMessages.map((msg, idx) => (
              <div key={msg.id || idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                {msg.role === "user" && msg.attachments && msg.attachments.length > 0 && (
                  <div className="max-w-[94%] flex flex-wrap gap-1.5 justify-end mb-1.5">
                    {msg.attachments.map((att) => {
                      const at = (att.type || "").toLowerCase();
                      if (at === "youtube" && att.videoId) {
                        return <div key={att.id} className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} /></div>;
                      }
                      if (at === "image" && att.url) return <img key={att.id} src={att.url} alt={att.name || "Image"} className="max-w-[11.25rem] max-h-[120px] rounded-lg border border-white/30 object-cover" />;
                      if (at === "video" && att.url) return <div key={att.id} className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><video src={att.url} controls className="w-full" preload="metadata" /></div>;
                      return <div key={att.id} className="flex items-center gap-1 rounded-lg border border-white/30 bg-white/20 px-2 py-1 text-[0.625rem]"><FileText className="w-3 h-3 opacity-60" /><span className="truncate max-w-[7.5rem]">{att.name || "File"}</span></div>;
                    })}
                  </div>
                )}
                {msg.role === "user" ? (
                  <button type="button" onClick={() => { void replaySavedPromptResponse(msg); }} disabled={!msg.aiResponse} className="group relative text-left max-w-[94%] disabled:cursor-default" title={msg.aiResponse ? "Show saved AI response" : "Waiting for AI response"}>
                    {msg.aiResponse ? (<span className="pointer-events-none absolute -top-6 right-0 rounded-md bg-black/70 px-2 py-1 text-[0.625rem] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 whitespace-nowrap">Tap to view AI response</span>) : null}
                    <div className="w-full rounded-2xl rounded-br-md px-3 py-2 text-xs leading-relaxed text-black/90 whitespace-pre-wrap break-words border border-white/55 bg-[linear-gradient(135deg,rgba(255,255,255,0.32),rgba(255,255,255,0.16))] backdrop-blur-xl shadow-[0_10px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.35)]">{msg.content}</div>
                  </button>
                ) : (
                  <div className="max-w-[94%] rounded-2xl rounded-bl-md px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words border bg-white/70 border-white/70 text-black/85">{msg.content}</div>
                )}
              </div>
            ))}
          </div>
          <div className="p-2 pb-3">
            <div className="glass-control rounded-2xl p-2 w-full">
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleOpenAttachments} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10" title="Add attachments">
                  <Plus className="w-4 h-4" />
                </button>
                <textarea
                  ref={chatPanelInputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onInput={(e) => resizeChatInput(e.currentTarget)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                  placeholder="Ask me anything..."
                  rows={1}
                  className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-white/12 border border-white/30 px-3 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                />
                <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isDictating ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Dictate">
                  <Mic className="w-4 h-4" />
                </button>
                <button type="button" onClick={handleVoiceToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isSpeaking ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Voice">
                  <Volume2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Focused chat mode — centered, below top panel, no overlay */}
      {chatMode && (
        <>
          {/* Left collage panel — canvas files */}
          {canvasFileBlocks.length > 0 && (
            <div className="fixed top-[4.2rem] bottom-0 left-0 z-[66] w-[13.75rem] overflow-y-auto scrollbar-hide p-3 space-y-2 bg-white/20 backdrop-blur-sm border-r border-black/5 transition-all duration-300">
              <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 px-1 mb-1">Canvas Files</p>
              <div className="flex flex-col gap-2">
                {canvasFileBlocks.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("application/x-canvas-file", JSON.stringify(item));
                      e.dataTransfer.setData("text/plain", item.url);
                    }}
                    className="relative rounded-xl overflow-hidden bg-black/5 border border-white/30 cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-400/50 transition-all group"
                    title={`Drag to chat: ${item.name}`}
                  >
                    {item.type === "youtube" && item.thumbUrl ? (
                      <div className="aspect-video relative">
                        <img src={item.thumbUrl} alt={item.name} className="w-full h-full object-cover" draggable={false} />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-7 h-5 bg-red-600 rounded flex items-center justify-center"><Play className="w-2.5 h-2.5 text-white ml-px" fill="white" /></div>
                        </div>
                      </div>
                    ) : item.type === "image" && item.thumbUrl ? (
                      <div className="aspect-square">
                        <img src={item.thumbUrl} alt={item.name} className="w-full h-full object-cover" draggable={false} />
                      </div>
                    ) : item.type === "video" ? (
                      <div className="aspect-video bg-black flex items-center justify-center">
                        <Play className="w-5 h-5 text-white/60" />
                      </div>
                    ) : item.type === "audio" ? (
                      <div className="aspect-square flex items-center justify-center bg-white/30">
                        <Music className="w-5 h-5 text-black/40" />
                      </div>
                    ) : item.type === "pdf" ? (
                      <div className="aspect-square flex items-center justify-center bg-white/30">
                        <FileText className="w-5 h-5 text-black/40" />
                      </div>
                    ) : item.type === "note" ? (
                      <div className="aspect-square flex items-center justify-center bg-white/20 px-1.5">
                        <span className="text-[8px] text-black/50 leading-tight line-clamp-4 text-center">{(item.content || "").slice(0, 80)}</span>
                      </div>
                    ) : (
                      <div className="aspect-square flex items-center justify-center bg-white/30">
                        <Link2 className="w-5 h-5 text-black/40" />
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3">
                      <span className="text-[9px] text-white leading-tight line-clamp-2 break-all">{item.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {chatMessages.length === 0 ? (
            /* Empty state: identical to the canvas first-render welcome */
            <div
              className={`fixed inset-0 z-[65] flex items-center justify-center px-4 transition-all duration-300 ${canvasFileBlocks.length > 0 ? "pl-[232px]" : ""}`}
              onDragOver={handleFocusedChatDragOver}
              onDrop={handleFocusedChatDrop}
            >
              <div className="w-full max-w-2xl space-y-6">
                <p className="text-center text-3xl font-semibold tracking-tight min-h-[44px] text-black pointer-events-none">
                  {typedWelcome}
                </p>
                <div className="glass-control rounded-2xl p-2 w-full transition-all duration-300">
                  {focusedChatAttachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2 items-end">
                      {focusedChatAttachments.map((att) => (
                        <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={handleOpenAttachments} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10" title="Add attachments">
                      <Plus className="w-4 h-4" />
                    </button>
                    <textarea
                      ref={chatPanelInputRef}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onInput={(e) => resizeChatInput(e.currentTarget)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                      placeholder="Ask me anything..."
                      rows={1}
                      className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                    />
                    <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isDictating ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Dictate">
                      <Mic className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={handleVoiceToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isSpeaking ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Voice">
                      <Volume2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Active conversation: messages scrollable, input pinned to bottom */
            <div
              className={`fixed top-[4.2rem] bottom-0 right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300 ${canvasFileBlocks.length > 0 ? "left-[220px]" : "left-0"}`}
              onDragOver={handleFocusedChatDragOver}
              onDrop={handleFocusedChatDrop}
            >
              <div ref={chatScrollRef} className="flex-1 w-full max-w-2xl overflow-y-auto scrollbar-hide px-4 pt-6 pb-4 space-y-4">
                {chatMessages.map((msg, idx) => (
                  <React.Fragment key={msg.id || idx}>
                    {msg.role === "user" && (
                      <div className="flex flex-col items-end gap-2">
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="max-w-[80%] flex flex-wrap gap-2 justify-end">
                            {msg.attachments.map((att) => {
                              const at = (att.type || "").toLowerCase();
                              if (at === "youtube" && att.videoId) {
                                return (
                                  <div key={att.id} className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm">
                                    <iframe
                                      src={`https://www.youtube.com/embed/${att.videoId}`}
                                      className="w-full aspect-video"
                                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                      allowFullScreen
                                      title={att.name || "YouTube"}
                                    />
                                  </div>
                                );
                              }
                              if (at === "image" && att.url) {
                                return <img key={att.id} src={att.url} alt={att.name || "Image"} className="max-w-[16.25rem] max-h-[200px] rounded-xl border border-white/30 object-cover shadow-sm" />;
                              }
                              if (at === "video" && att.url) {
                                return (
                                  <div key={att.id} className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm">
                                    <video src={att.url} controls className="w-full" preload="metadata" />
                                  </div>
                                );
                              }
                              if (at === "audio" && att.url) {
                                return (
                                  <div key={att.id} className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2">
                                    <Music className="w-4 h-4 opacity-60" />
                                    <audio src={att.url} controls className="h-8" preload="metadata" />
                                    <span className="text-[0.625rem] truncate max-w-[7.5rem]">{att.name || "Audio"}</span>
                                  </div>
                                );
                              }
                              if (at === "pdf") {
                                return (
                                  <div key={att.id} className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2">
                                    <FileText className="w-4 h-4 opacity-60" />
                                    <span className="text-xs truncate max-w-[12.5rem]">{att.name || "PDF"}</span>
                                  </div>
                                );
                              }
                              if (at === "note" || at === "memory") {
                                return (
                                  <div key={att.id} className="rounded-xl border border-white/30 bg-white/20 px-3 py-2 max-w-[16.25rem]">
                                    <div className="flex items-center gap-1 mb-1"><StickyNote className="w-3.5 h-3.5 opacity-60" /><span className="text-[0.625rem] font-medium truncate">{att.name || "Note"}</span></div>
                                    {att.memoryContent && <p className="text-[0.6875rem] text-black/70 line-clamp-3 whitespace-pre-wrap">{att.memoryContent.slice(0, 200)}</p>}
                                  </div>
                                );
                              }
                              return (
                                <div key={att.id} className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2">
                                  <FileText className="w-4 h-4 opacity-60" />
                                  <span className="text-xs truncate max-w-[12.5rem]">{att.name || att.url || "File"}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-black/90 whitespace-pre-wrap break-words border border-white/55 bg-[linear-gradient(135deg,rgba(255,255,255,0.32),rgba(255,255,255,0.16))] backdrop-blur-xl shadow-[0_10px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.35)]">{msg.content}</div>
                      </div>
                    )}
                    {msg.role === "user" && msg.aiResponse && (
                      <div className="flex justify-start">
                        <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words border bg-white/80 border-white/70 text-black/85 backdrop-blur-md">{msg.aiResponse}</div>
                      </div>
                    )}
                    {msg.role !== "user" && (
                      <div className="flex justify-start">
                        <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words border bg-white/80 border-white/70 text-black/85 backdrop-blur-md">{msg.content}</div>
                      </div>
                    )}
                  </React.Fragment>
                ))}
                {isChatLoading && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed border bg-white/80 border-white/70 text-black/60 backdrop-blur-md animate-pulse">Thinking...</div>
                  </div>
                )}
              </div>
              <div className="w-full max-w-2xl px-4 pb-6 pt-2">
                <div className="glass-control rounded-2xl p-2 w-full">
                  {focusedChatAttachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2 items-end">
                      {focusedChatAttachments.map((att) => (
                        <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={handleOpenAttachments} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10" title="Add attachments">
                      <Plus className="w-4 h-4" />
                    </button>
                    <textarea
                      ref={chatPanelInputRef}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onInput={(e) => resizeChatInput(e.currentTarget)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                      placeholder="Ask me anything..."
                      rows={1}
                      className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                    />
                    <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isDictating ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Dictate">
                      <Mic className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={handleVoiceToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 ${isSpeaking ? "bg-black/10 ring-1 ring-black/30" : ""}`} title="Voice">
                      <Volume2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <DialogAny open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContentAny className="rounded-2xl border border-white/60 bg-[#f2f2f7]/80 backdrop-blur-lg text-black shadow-2xl">
          <DialogHeaderAny>
            <DialogTitleAny className="text-black">Add Attachment</DialogTitleAny>
            <DialogDescriptionAny className="text-black/60">
              Add links or upload files onto your canvas
            </DialogDescriptionAny>
          </DialogHeaderAny>

          <div className="space-y-3 py-2">
            <button
              type="button"
              onClick={() => {
                const url = prompt("Enter any URL:");
                if (!url) return;
                window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url } }));
                setShowAttachMenu(false);
              }}
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/60 border border-white/60 backdrop-blur-md hover:opacity-90"
            >
              <LinkIcon className="w-5 h-5" />
              Add Link
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/60 border border-white/60 backdrop-blur-md hover:opacity-90"
            >
              <ImageIcon className="w-5 h-5" />
              Add Media / Files
            </button>
          </div>

          {projectId && projectFiles.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-semibold text-black/70 dark:text-white/70 px-1 pb-2">
                Project Files
              </div>
              <div className="max-h-[220px] overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                {projectFolders.map((folder) => {
                  const files = projectFiles.filter((f) => f.folderId === folder.id);
                  if (!files.length) return null;
                  return (
                    <div key={folder.id}>
                      <div className="text-[0.6875rem] font-semibold text-black/60 dark:text-white/60 px-2 py-1">
                        {folder.name}
                      </div>
                      <div className="space-y-1">
                        {files.map((file) => (
                          <button
                            key={file.id}
                            type="button"
                            onClick={async () => {
                              if ((file.kind === "link" || file.kind === "youtube") && file.url) {
                                window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: file.url } }));
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                window.dispatchEvent(
                                  new CustomEvent("omnia_attach_files", {
                                    detail: { files: [f], clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
                                  })
                                );
                                setShowAttachMenu(false);
                              } catch {
                                // ignore
                              }
                            }}
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/60 border border-white/60 backdrop-blur-md hover:opacity-90"
                          >
                            {file.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {projectFiles.filter((f) => !f.folderId).length > 0 && (
                  <div>
                    <div className="text-[0.6875rem] font-semibold text-black/60 dark:text-white/60 px-2 py-1">
                      Unsorted
                    </div>
                    <div className="space-y-1">
                      {projectFiles
                        .filter((f) => !f.folderId)
                        .map((file) => (
                          <button
                            key={file.id}
                            type="button"
                            onClick={async () => {
                              if ((file.kind === "link" || file.kind === "youtube") && file.url) {
                                window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: file.url } }));
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                window.dispatchEvent(
                                  new CustomEvent("omnia_attach_files", {
                                    detail: { files: [f], clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
                                  })
                                );
                                setShowAttachMenu(false);
                              } catch {
                                // ignore
                              }
                            }}
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/60 border border-white/60 backdrop-blur-md hover:opacity-90"
                          >
                            {file.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="*/*,.pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length) window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files } }));
              e.target.value = "";
              setShowAttachMenu(false);
            }}
          />
        </DialogContentAny>
      </DialogAny>

      {aiSuggestions.length > 0 && (
        <div
          className={`fixed right-6 bottom-6 z-[85] w-[20rem] rounded-2xl border border-white/60 bg-[#f2f2f7]/85 backdrop-blur-lg shadow-2xl shadow-white/20 p-4 text-black transition-transform duration-300 ${
            showAiSuggestionToast ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
        >
          <div className="text-xs font-semibold text-black/70 mb-2">AI Suggestions</div>
          <ul className="space-y-2 text-xs text-black/70">
            {aiSuggestions.slice(0, 4).map((suggestion) => (
              <li key={suggestion.id} className="rounded-xl border border-white/60 bg-white/60 px-3 py-2">
                {suggestion.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => { void handleCloseQuickNote(); }}
        />
      )}
    </div>
  );
}

