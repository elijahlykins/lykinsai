import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Canvas } from "@/canvas/Canvas";
import { useCanvasStore } from "@/store/canvasStore";
import type { Block } from "@/canvas/types";
import { ChevronDown, ChevronUp, Plus, Link as LinkIcon, Image as ImageIcon, Zap, MessageSquare, Mic, BookOpen, X, Clock, Edit2, Folder as FolderIcon, Link2, MoreHorizontal, PanelRightClose, PanelRight, StickyNote, Play, FileText, Music, Video, Share2, Download, Copy, Check, RefreshCw, ThumbsUp, ThumbsDown, Square, Sparkles, Save, Globe, GripVertical, LayoutGrid } from "lucide-react";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import RichTextRenderer from "@/components/notes/RichTextRenderer";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";
import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import { createDatabaseBlockData } from "@/canvas/blockSystem/notionModel";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { getAiPrefs } from "@/lib/ai-prefs";
import { buildTieredCanvasContext } from "@/lib/ai/buildCanvasContext";

const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;

const flattenNodeText = (node: any): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join("");
  if (React.isValidElement(node)) return flattenNodeText((node.props as any)?.children);
  return "";
};

const normalizeChecklistSyntax = (value: string) =>
  String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");

const splitResponseIntoChunks = (text: string): string[] => {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) chunks.push(t);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s*#{1,6}\s/.test(line);
    const isListItem = /^\s*[-*]\s/.test(line);
    const isNumbered = /^\s*\d+[.)]\s/.test(line);
    const isCodeFence = /^\s*```/.test(line);
    const isEmpty = !line.trim();
    if (isCodeFence) {
      if (buf.length && !buf.some((l) => /^\s*```/.test(l))) flush();
      buf.push(line);
      const alreadyClosed = buf.filter((l) => /^\s*```/.test(l)).length >= 2;
      if (alreadyClosed) flush();
      continue;
    }
    if (buf.some((l) => /^\s*```/.test(l)) && buf.filter((l) => /^\s*```/.test(l)).length < 2) {
      buf.push(line);
      continue;
    }
    if (isHeading) {
      flush();
      buf.push(line);
      continue;
    }
    if (isEmpty && buf.length > 0) {
      const lastIsListOrNum = buf.some((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l));
      const nextIsListOrNum = (i + 1 < lines.length) && (/^\s*[-*]\s/.test(lines[i + 1]) || /^\s*\d+[.)]\s/.test(lines[i + 1]));
      if (lastIsListOrNum && nextIsListOrNum) {
        buf.push(line);
        continue;
      }
      flush();
      continue;
    }
    if ((isListItem || isNumbered) && buf.length > 0) {
      const lastLine = buf[buf.length - 1];
      const lastIsList = /^\s*[-*]\s/.test(lastLine) || /^\s*\d+[.)]\s/.test(lastLine);
      const lastIsHeading = /^\s*#{1,6}\s/.test(lastLine);
      const lastIsPlain = !lastIsList && !lastIsHeading && lastLine.trim();
      if (lastIsPlain) flush();
    }
    buf.push(line);
  }
  flush();
  if (chunks.length <= 1) return [raw];
  return chunks;
};

type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  aiImageUrl?: string;
  aiVideoUrl?: string;
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
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
  | { type: "create_youtube_block"; url?: string; title?: string }
  | { type: "create_database_relation"; fromDatabaseName?: string; toDatabaseName?: string; relationType?: "one-to-one" | "one-to-many" | "many-to-many"; rollup?: { property?: string; aggregation?: "sum" | "count" | "average" } }
  | { type: "delete_block"; blockId?: string; blockIds?: string[] }
  | { type: string; [key: string]: any };

type OrchestratorResult = {
  response: string;
  followUpQuestions: string[];
  actions: CreateAction[];
  requiresClarification: boolean;
  groundingSummary?: string;
};

/**
 * Layout-aware placement: finds a non-overlapping position by analysing existing
 * blocks, detecting gap spacing, spiralling outward from the viewport centre, and
 * falling back to extending detected row/column patterns.
 */
function findSmartPlacement(opts: {
  blockW: number;
  blockH: number;
  gridSize: number;
  camera: { x: number; y: number; zoom: number };
  viewportW: number;
  viewportH: number;
  railWidth: number;
  existingBlocks: Array<{ x: number; y: number; width: number; height: number }>;
}): { x: number; y: number } {
  const { blockW, blockH, gridSize: g, camera, viewportW, viewportH, railWidth, existingBlocks } = opts;
  const z = Math.max(0.1, camera.zoom || 1);
  const boardVW = Math.max(g * 8, (viewportW - railWidth) / z);
  const boardVH = Math.max(g * 8, viewportH / z);
  const camX = camera.x;
  const camY = camera.y;

  const rects = existingBlocks.map((b) => ({
    x: Number(b.x || 0),
    y: Number(b.y || 0),
    w: Number(b.width || g),
    h: Number(b.height || g),
  }));

  const defaultGap = g * 2;
  let gapX = defaultGap;
  let gapY = defaultGap;

  if (rects.length >= 2) {
    const hGaps: number[] = [];
    const vGaps: number[] = [];
    const sorted = rects.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      let bestRight = Infinity;
      let bestBelow = Infinity;
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue;
        const b = sorted[j];
        const hDist = b.x - (a.x + a.w);
        if (hDist > 0 && hDist < g * 20 && Math.abs(b.y - a.y) < Math.max(a.h, b.h)) {
          if (hDist < bestRight) bestRight = hDist;
        }
        const vDist = b.y - (a.y + a.h);
        if (vDist > 0 && vDist < g * 20 && Math.abs(b.x - a.x) < Math.max(a.w, b.w)) {
          if (vDist < bestBelow) bestBelow = vDist;
        }
      }
      if (bestRight < Infinity) hGaps.push(bestRight);
      if (bestBelow < Infinity) vGaps.push(bestBelow);
    }
    const median = (arr: number[]) => {
      if (!arr.length) return defaultGap;
      const s = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    };
    if (hGaps.length) gapX = Math.max(g, Math.round(median(hGaps) / g) * g);
    if (vGaps.length) gapY = Math.max(g, Math.round(median(vGaps) / g) * g);
  }

  const padX = Math.max(g, Math.floor(gapX / 2));
  const padY = Math.max(g, Math.floor(gapY / 2));

  const overlaps = (px: number, py: number, pw: number, ph: number) =>
    rects.some(
      (r) =>
        px < r.x + r.w + padX &&
        px + pw > r.x - padX &&
        py < r.y + r.h + padY &&
        py + ph > r.y - padY
    );

  const viewLeft = camX + g;
  const viewTop = camY + g;
  const viewRight = camX + boardVW - blockW - g;
  const viewBottom = camY + boardVH - blockH - g * 4;
  const cx = Math.round(((viewLeft + viewRight) / 2) / g) * g;
  const cy = Math.round(((viewTop + viewBottom) / 2) / g) * g;

  let placed = false;
  let worldX = cx;
  let worldY = cy;

  const maxRadius = Math.max(boardVW, boardVH);
  for (let radius = 0; radius <= maxRadius && !placed; radius += g) {
    if (radius === 0) {
      if (cx >= viewLeft && cx <= viewRight && cy >= viewTop && cy <= viewBottom && !overlaps(cx, cy, blockW, blockH)) {
        worldX = cx; worldY = cy; placed = true;
      }
      continue;
    }
    for (let dx = -radius; dx <= radius && !placed; dx += g) {
      for (const dy of [-radius, radius]) {
        const px = Math.round((cx + dx) / g) * g;
        const py = Math.round((cy + dy) / g) * g;
        if (px >= viewLeft && px <= viewRight && py >= viewTop && py <= viewBottom && !overlaps(px, py, blockW, blockH)) {
          worldX = px; worldY = py; placed = true; break;
        }
      }
    }
    if (placed) break;
    for (let dy = -radius + g; dy <= radius - g && !placed; dy += g) {
      for (const dx of [-radius, radius]) {
        const px = Math.round((cx + dx) / g) * g;
        const py = Math.round((cy + dy) / g) * g;
        if (px >= viewLeft && px <= viewRight && py >= viewTop && py <= viewBottom && !overlaps(px, py, blockW, blockH)) {
          worldX = px; worldY = py; placed = true; break;
        }
      }
    }
  }

  if (!placed) {
    const rowMap = new Map<number, typeof rects>();
    const colMap = new Map<number, typeof rects>();
    for (const r of rects) {
      const ry = Math.round(r.y / g) * g;
      const rx = Math.round(r.x / g) * g;
      if (!rowMap.has(ry)) rowMap.set(ry, []);
      rowMap.get(ry)!.push(r);
      if (!colMap.has(rx)) colMap.set(rx, []);
      colMap.get(rx)!.push(r);
    }

    let bestRowCount = 0;
    for (const members of rowMap.values()) if (members.length > bestRowCount) bestRowCount = members.length;
    let bestColCount = 0;
    for (const members of colMap.values()) if (members.length > bestColCount) bestColCount = members.length;

    if (bestRowCount >= 2 && bestRowCount >= bestColCount) {
      let bestRow: typeof rects = [];
      for (const members of rowMap.values()) if (members.length === bestRowCount) { bestRow = members; break; }
      const rightmost = bestRow.reduce((m, r) => r.x + r.w > m.x + m.w ? r : m, bestRow[0]);
      const cand = { x: Math.round((rightmost.x + rightmost.w + gapX) / g) * g, y: Math.round(rightmost.y / g) * g };
      if (!overlaps(cand.x, cand.y, blockW, blockH)) {
        worldX = cand.x; worldY = cand.y; placed = true;
      }
    }

    if (!placed && bestColCount >= 2) {
      let bestCol: typeof rects = [];
      for (const members of colMap.values()) if (members.length === bestColCount) { bestCol = members; break; }
      const bottommost = bestCol.reduce((m, r) => r.y + r.h > m.y + m.h ? r : m, bestCol[0]);
      const cand = { x: Math.round(bottommost.x / g) * g, y: Math.round((bottommost.y + bottommost.h + gapY) / g) * g };
      if (!overlaps(cand.x, cand.y, blockW, blockH)) {
        worldX = cand.x; worldY = cand.y; placed = true;
      }
    }

    if (!placed) {
      let maxBottom = camY;
      for (const r of rects) { const b = r.y + r.h; if (b > maxBottom) maxBottom = b; }
      worldX = Math.max(g, Math.round((camX + boardVW * 0.5 - blockW / 2) / g) * g);
      worldY = Math.max(g, Math.round((maxBottom + gapY) / g) * g);
    }
  }

  return { x: Math.max(g, worldX), y: Math.max(g, worldY) };
}

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
  extractedText?: string;
  canvasBlockId?: string;
  rawFile?: File;
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

const DOCUMENT_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf"]);

const inferUrlAttachmentType = (url = "") => {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (isYouTubeUrl(trimmed)) return "youtube";
  const ext = getUrlExtension(trimmed);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "link";
};

const makeAttId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showMemorySidebar, setShowMemorySidebar] = useState(false);
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
  const getCachedKbText = useAiStore((s) => s.getCachedKbText);
  const refreshWorkspaceSummary = useAiStore((s) => s.refreshWorkspaceSummary);
  const getCachedWorkspaceSummary = useAiStore((s) => s.getCachedWorkspaceSummary);
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
  const titleFromSaveRef = useRef(false);
  const [chatMode, setChatMode] = useState(false);
  const [chatMessages, setChatMessages] = useState<PromptMessage[]>([]);
  const chatMessagesRef = useRef<PromptMessage[]>([]);
  const titleRef = useRef<string>("");
  const [chatInput, setChatInput] = useState("");
  const [chatRailOpen, setChatRailOpen] = useState(false);
  const [chatRailVisible, setChatRailVisible] = useState(false);
  const [centerChatLeaving, setCenterChatLeaving] = useState(false);
  const [focusedChatAttachments, setFocusedChatAttachments] = useState<FocusedChatAttachment[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatReactions, setChatReactions] = useState<Record<string, "like" | "dislike" | null>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState<Record<string, Record<string, boolean>>>({});
  const [savedYouTubeIds, setSavedYouTubeIds] = useState<Set<string>>(new Set());
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set());
  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatUserScrolledUpRef = useRef(false);
  const chatPanelInputRef = useRef<HTMLTextAreaElement | null>(null);
  const centerChatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const dictationTimerRef = useRef<number | null>(null);
  const aiTypingRunRef = useRef(0);
  const chatTypingTimerRef = useRef<number | null>(null);
  const chatImportAppliedRef = useRef<string | null>(null);
  const isSendingRef = useRef(false);
  const activeAiAbortRef = useRef<AbortController | null>(null);
  const lastAiResponseBlockRef = useRef<string | null>(null);
  const aiThreadRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  useEffect(() => {
    return () => { activeAiAbortRef.current?.abort(); };
  }, []);
  useEffect(() => {
    activeAiAbortRef.current?.abort();
    activeAiAbortRef.current = null;
  }, [boardId]);
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
  const [chatFlowMode, setChatFlowMode] = useState<"idle" | "clarifying" | "generating">("idle");
  const [chatStatusText, setChatStatusText] = useState("");
  const thinkingStatus = useThinkingStatus(isChatLoading, chatStatusText);
  const [typedWelcome, setTypedWelcome] = useState("");
  const [showAiSuggestionToast, setShowAiSuggestionToast] = useState(false);
  const lastSuggestionKeyRef = useRef<string>("");
  const [connectionCards, setConnectionCards] = useState<Array<{ title: string; sourceType: "board" | "media"; reason: string }>>([]);
  const [showConnectionCard, setShowConnectionCard] = useState(false);
  const connectionDismissTimerRef = useRef<number | null>(null);
  const [mediaSuggestions, setMediaSuggestions] = useState<Array<{ title: string; reason: string; noteId: string }>>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [showMediaSuggestion, setShowMediaSuggestion] = useState(false);
  const [importingMedia, setImportingMedia] = useState(false);
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
  const youtubeTranscriptFailRef = useRef<Record<string, number>>({});

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
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  const buildSnapshot = useCallback(() => {
    const st = useCanvasStore.getState();
    const resolvedTitle = (title && String(title).trim()) ? String(title).trim() : "New Board";
    return {
      blocks: st.blocks,
      blockOrder: st.blockOrder,
      camera: st.camera,
      gridSize: st.gridSize,
      wireConnections: st.wireConnections,
      title: resolvedTitle,
      version: SNAPSHOT_VERSION,
      chatMessages: chatMessagesRef.current,
      aiThread: aiThreadRef.current,
    };
  }, [SNAPSHOT_VERSION, title]);

  const applySnapshot = useCallback(
    (snapshot: any) => {
      if (!snapshot) return;
      const blocksRecord = snapshot.blocks || {};
      const order: string[] = Array.isArray(snapshot.blockOrder) ? snapshot.blockOrder : [];
      const isTransientTextBrick = (b: any) => {
        const data = (b?.data && typeof b.data === "object" ? b.data : {}) as Record<string, any>;
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
      const wires = Array.isArray(snapshot.wireConnections) ? snapshot.wireConnections : [];
      loadBlocks(blocks, { camera, gridSize: g, wireConnections: wires });
      if (snapshot.title) setTitle(String(snapshot.title));

      // Re-resolve storage URLs for blocks whose base64 was stripped on save
      (async () => {
        const st = useCanvasStore.getState();
        const pending: { id: string; blk: any; field: string }[] = [];
        for (const id of st.blockOrder) {
          const blk: any = st.blocks[id];
          if (!blk?.data?.storagePath) continue;
          const field = blk.type === "create" && blk.mode === "image" ? "src" : "url";
          const current = String(blk.data[field] || "");
          if (current && !current.startsWith("data:") && current !== "") continue;
          pending.push({ id, blk, field });
        }
        if (pending.length === 0) return;
        const results = await Promise.allSettled(
          pending.map(({ id, blk, field }) =>
            supabase.storage
              .from(blk.data.storageBucket || "user-files")
              .createSignedUrl(blk.data.storagePath, 60 * 60 * 24 * 7)
              .then(({ data: signed }) => ({ id, blk, field, url: signed?.signedUrl }))
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.url) {
            const { id, blk, field, url } = r.value;
            st.updateBlock(id, { data: { ...blk.data, [field]: url } } as any);
          }
        }
      })();

      // Restore chat: prefer localStorage (updated more frequently) then fall back to DB snapshot.
      if (boardId) {
        const boardChatKey = `omnia_chat_${boardId}`;
        let chatLoaded = false;

        try {
          const chatRaw = localStorage.getItem(boardChatKey);
          if (chatRaw) {
            const chatData = JSON.parse(chatRaw);
            if (Array.isArray(chatData.chatMessages) && chatData.chatMessages.length > 0) {
              setChatMessages(chatData.chatMessages);
              setChatRailOpen(true);
              setChatRailVisible(true);
              chatLoaded = true;
            }
            if (Array.isArray(chatData.aiThread) && chatData.aiThread.length > 0) {
              aiThreadRef.current = chatData.aiThread;
            }
          }
        } catch { /* ignore corrupt localStorage */ }

        if (!chatLoaded && Array.isArray(snapshot.chatMessages) && snapshot.chatMessages.length > 0) {
          setChatMessages(snapshot.chatMessages);
          setChatRailOpen(true);
          setChatRailVisible(true);
          if (Array.isArray(snapshot.aiThread) && snapshot.aiThread.length > 0) {
            aiThreadRef.current = snapshot.aiThread;
          }
        }
      }
    },
    [boardId, gridSize, loadBlocks]
  );

  const applySnapshotRef = useRef(applySnapshot);
  useEffect(() => { applySnapshotRef.current = applySnapshot; }, [applySnapshot]);

  const clampChatRailWidth = useCallback((raw: number, vw: number) => {
    const width = Math.max(0, Math.floor(vw || 0));
    const minW = width <= 900 ? 200 : 220;
    const maxW = Math.max(minW + 20, Math.floor(width * 0.9));
    return Math.max(minW, Math.min(maxW, Math.floor(raw || minW)));
  }, []);

  const updateTaskCheck = useCallback((msgId: string, taskKey: string, checked: boolean) => {
    setAssistantTaskChecks((prev) => ({
      ...prev,
      [msgId]: { ...(prev[msgId] || {}), [taskKey]: checked },
    }));
  }, []);

  const buildChatMarkdownComponents = useCallback((msgId: string) => ({
    h1: ({ children }: any) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
    h2: ({ children }: any) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
    h3: ({ children }: any) => <h3 className="text-base font-semibold mt-2.5 mb-1.5">{children}</h3>,
    p: ({ children }: any) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
    ul: ({ children }: any) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
    ol: ({ children }: any) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
    li: ({ children }: any) => {
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
    strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
    blockquote: ({ children }: any) => <blockquote className="border-l-2 border-black/20 pl-3 my-2 text-black/70 italic">{children}</blockquote>,
    code: ({ children, className }: any) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) return <pre className="rounded-lg bg-black/5 p-3 my-2 overflow-x-auto text-[0.85em]"><code>{children}</code></pre>;
      return <code className="rounded bg-black/10 px-1.5 py-0.5 text-[0.85em]">{children}</code>;
    },
    pre: ({ children }: any) => <>{children}</>,
    table: ({ children }: any) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
    thead: ({ children }: any) => <thead className="border-b border-black/20">{children}</thead>,
    tbody: ({ children }: any) => <tbody>{children}</tbody>,
    tr: ({ children }: any) => <tr className="border-b border-black/10">{children}</tr>,
    th: ({ children }: any) => <th className="text-left px-3 py-2 font-semibold">{children}</th>,
    td: ({ children }: any) => <td className="px-3 py-2">{children}</td>,
  }), [assistantTaskChecks, updateTaskCheck]);

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

  const chatRailWidthPx = !chatMode && chatRailVisible
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
    const cam = (st as any).camera || { x: 0, y: 0 };
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    return buildTieredCanvasContext({
      blocks: st.blocks as Record<string, any>,
      blockOrder: Array.isArray(st.blockOrder) ? st.blockOrder : [],
      focusedBrickIds: Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [],
      viewportCenter: {
        x: (cam.x || 0) + vw / 2,
        y: (cam.y || 0) + vh / 2,
      },
    });
  }, []);
  const getAllYouTubeBlocks = useCallback(() => {
    const st = useCanvasStore.getState() as any;
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const out: Array<{ videoId: string; url: string; title: string }> = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const b: any = st.blocks?.[id];
      if (!b) continue;
      const type = String(b.type || "").toLowerCase();
      const mode = String(b.mode || b.data?.mode || "").toLowerCase();
      const isYouTube = type === "youtube" || (type === "create" && mode === "video") || type === "link";
      if (!isYouTube) continue;
      const rawVideoId = String(b.videoId || b?.data?.videoId || "");
      const rawUrl = String(b.url || b?.data?.url || "");
      const videoId = rawVideoId || extractYouTubeVideoId(rawUrl) || "";
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      out.push({
        videoId,
        url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`,
        title: String(b?.data?.title || b?.data?.name || "").trim(),
      });
    }
    return out.slice(0, 5);
  }, []);
  const getVisibleYouTubeBlocks = useCallback(() => {
    const all = getAllYouTubeBlocks();
    if (!all.length) return [];
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
    const seen = new Set<string>();
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
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      out.push({ videoId, url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`, title: String((b?.data?.title || b?.data?.name || "").trim()), visibleScore: overlapArea });
    }
    out.sort((a, b) => b.visibleScore - a.visibleScore);
    return out.slice(0, 2);
  }, [getAllYouTubeBlocks, getChatRailWidthPx, gridSize, viewportWidth]);
  const formatSec = (n: number) => {
    const sec = Math.max(0, Math.floor(Number(n || 0)));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };
  const buildYouTubeGrounding = useCallback(
    async (apiBaseUrl: string, userText: string, parentSignal?: AbortSignal) => {
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
        const failedAt = youtubeTranscriptFailRef.current[video.videoId];
        if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) continue;

        const cached = youtubeTranscriptCacheRef.current[video.videoId];
        let data = cached;
        if (!data || Date.now() - data.fetchedAt > 30 * 60 * 1000) {
          if (parentSignal?.aborted) continue;
          const groundAbort = new AbortController();
          const groundTimeout = setTimeout(() => groundAbort.abort(), 15000);
          if (parentSignal) parentSignal.addEventListener("abort", () => groundAbort.abort(), { once: true });
          const [tRes, vRes] = await Promise.all([
            fetch(`${apiBaseUrl}/api/youtube/transcript?id=${encodeURIComponent(video.videoId)}&fast=1`, { signal: groundAbort.signal }).catch(() => null),
            fetch(`${apiBaseUrl}/api/youtube/video?id=${encodeURIComponent(video.videoId)}`, { signal: groundAbort.signal }).catch(() => null),
          ]);
          clearTimeout(groundTimeout);
          const tJson = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
          const vJson = vRes && vRes.ok ? await vRes.json().catch(() => ({})) : {};
          if (!tRes || !tRes.ok) {
            youtubeTranscriptFailRef.current[video.videoId] = Date.now();
          }
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
    return String(s || "").trim();
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

  const getKnowledgeBaseContext = useCallback(() => {
    return getCachedKbText();
  }, [getCachedKbText]);

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

    // Fallback: detect YouTube URLs in the response text and auto-create embed blocks
    const hasYouTubeAction = actions.some((a) => String(a?.type || "").toLowerCase() === "create_youtube_block");
    if (!hasYouTubeAction && response) {
      const ytUrlRegex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/g;
      const seen = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = ytUrlRegex.exec(response)) !== null) {
        const videoId = match[1];
        if (videoId && !seen.has(videoId)) {
          seen.add(videoId);
          actions.push({ type: "create_youtube_block", url: match[0], title: `YouTube ${videoId}` } as any);
        }
      }
    }

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

  const extractSourceLinks = useCallback((text: string): { cleanText: string; sources: { title: string; url: string }[] } => {
    const sourcesMatch = text.match(/\n*(?:Sources?|References?):?\s*\n([\s\S]*?)$/i);
    if (!sourcesMatch) return { cleanText: text, sources: [] };
    const cleanText = text.slice(0, sourcesMatch.index).trimEnd();
    const block = sourcesMatch[1].trim();
    const sources: { title: string; url: string }[] = [];
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(block)) !== null) {
      sources.push({ title: m[1], url: m[2] });
    }
    if (sources.length === 0) {
      const bareUrlRe = /(?:^|\n)\s*\d+\.\s*(https?:\/\/[^\s]+)/g;
      while ((m = bareUrlRe.exec(block)) !== null) {
        try {
          const u = new URL(m[1]);
          sources.push({ title: u.hostname.replace(/^www\./, ""), url: m[1] });
        } catch { /* skip */ }
      }
    }
    return { cleanText, sources };
  }, []);

  const attachSourcesToBlock = useCallback((responseBlockId: string, sources: { title: string; url: string }[]) => {
    if (!sources.length || !responseBlockId) return;
    const st = useCanvasStore.getState();
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const rb = st.blocks[responseBlockId];
    if (!rb) return;
    const existingData = (rb as any).data && typeof (rb as any).data === "object" ? { ...(rb as any).data } : {};
    const sourcesWithState = sources.map((s) => ({ ...s, enabled: true }));
    const sourceRowHeight = Math.ceil(sources.length / 2) * 32 + 24;
    const extraHeight = Math.ceil(sourceRowHeight / g) * g;
    updateBlock(responseBlockId as any, {
      data: { ...existingData, sources: sourcesWithState },
      height: Number(rb.height || 0) + extraHeight,
    } as any);
  }, [updateBlock]);

  const extractAiConnections = useCallback((responseText: string): {
    connections: Array<{ title: string; sourceType: "board" | "media"; reason: string }>;
    cleanText: string;
  } => {
    const connectionRegex = /\[AI_CONNECTION:(.+?)\|(.+?)\|(.+?)\]/g;
    const connections: Array<{ title: string; sourceType: "board" | "media"; reason: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = connectionRegex.exec(responseText)) !== null) {
      const title = match[1].trim();
      const rawType = match[2].trim().toLowerCase();
      const reason = match[3].trim();
      const sourceType = rawType === "board" ? "board" : "media";
      if (title && reason) {
        connections.push({ title, sourceType, reason });
      }
    }
    const cleanText = responseText.replace(/\s*\[AI_CONNECTION:[^\]]*\]/g, "").trimEnd();
    return { connections: connections.slice(0, 3), cleanText };
  }, []);

  const extractAndEmbedYouTubeUrls = useCallback((
    aiText: string,
    promptId: string,
    responseBlockId: string | null,
  ): { urls: { url: string; videoId: string }[]; cleanText: string } => {
    const ytUrlRegex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/g;
    const urls: { url: string; videoId: string }[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = ytUrlRegex.exec(aiText)) !== null) {
      const videoId = match[1];
      if (videoId && !seen.has(videoId)) {
        seen.add(videoId);
        urls.push({ url: match[0], videoId });
      }
    }
    if (!urls.length) return { urls: [], cleanText: aiText };

    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const ytVw = window.innerWidth || 1280;
    const ytVh = window.innerHeight || 800;

    const existingOrder: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    for (const ytEntry of urls) {
      const alreadyExists = existingOrder.some((bid: string) => {
        const blk = st.blocks?.[bid];
        if (!blk) return false;
        const bVid = String(blk.videoId || blk.data?.videoId || "");
        return bVid === ytEntry.videoId;
      });
      if (alreadyExists) continue;
      const cur = useCanvasStore.getState() as any;
      const ytPos = findSmartPlacement({
        blockW: g * 12,
        blockH: g * 8,
        gridSize: g,
        camera: cur.camera || { x: 0, y: 0, zoom: 1 },
        viewportW: ytVw,
        viewportH: ytVh,
        railWidth: 0,
        existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
      });
      st.addYouTubeBlockAt({ x: ytPos.x, y: ytPos.y }, { url: ytEntry.url, videoId: ytEntry.videoId });
    }

    setChatMessages((prev) => prev.map((m) =>
      m.id === promptId ? { ...m, aiYouTubeUrls: urls } : m
    ));

    return { urls, cleanText: aiText };
  }, []);

  const extractWebLinksFromText = useCallback((text: string): string[] => {
    const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
    const ytHosts = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
    const seen = new Set<string>();
    const links: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
      const raw = m[0].replace(/[.,;:!?)]+$/, "");
      try {
        const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
        if (ytHosts.some((h) => host.includes(h))) continue;
        if (!seen.has(raw)) { seen.add(raw); links.push(raw); }
      } catch { /* skip malformed */ }
    }
    return links.slice(0, 5);
  }, []);

  const extractAndEmbedMediaItems = useCallback(async (
    aiText: string,
    responseBlockId: string | null,
  ): Promise<{ cleanText: string; pulled: number }> => {
    const pullRegex = /\[PULL_MEDIA:([^\]|]+?)(?:\|(\d+))?\]/g;
    const pulls: { noteId: string; attIndex: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = pullRegex.exec(aiText)) !== null) {
      const noteId = match[1].trim();
      const attIndex = match[2] !== undefined ? parseInt(match[2], 10) : 0;
      if (noteId) pulls.push({ noteId, attIndex });
    }
    if (!pulls.length) return { cleanText: aiText, pulled: 0 };

    const cleanText = aiText.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "").trimEnd();

    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const mpVw = window.innerWidth || 1280;
    const mpVh = window.innerHeight || 800;

    const mediaPos = (bw: number, bh: number) => {
      const cur = useCanvasStore.getState() as any;
      return findSmartPlacement({
        blockW: bw,
        blockH: bh,
        gridSize: g,
        camera: cur.camera || { x: 0, y: 0, zoom: 1 },
        viewportW: mpVw,
        viewportH: mpVh,
        railWidth: 0,
        existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
      });
    };

    const uniqueNoteIds = [...new Set(pulls.map(p => p.noteId))];
    let notesData: Record<string, any> = {};
    try {
      const { data } = await supabase
        .from("notes")
        .select("id, title, content")
        .in("id", uniqueNoteIds);
      for (const n of (data || [])) notesData[n.id] = n;
    } catch (err) {
      console.warn("[LYKN] Failed to fetch notes for media pull:", err);
      return { cleanText, pulled: 0 };
    }

    const parseNoteAttachments = (content: string): any[] => {
      const marker = "[ATTACHMENTS_JSON:";
      const start = (content || "").indexOf(marker);
      if (start === -1) return [];
      const jsonStart = start + marker.length;
      let bc = 0, jsonEnd = jsonStart;
      for (let i = jsonStart; i < content.length; i++) {
        if (content[i] === "[") bc++;
        if (content[i] === "]") { bc--; if (bc === 0) { jsonEnd = i + 1; break; } }
      }
      if (jsonEnd <= jsonStart) return [];
      try { const p = JSON.parse(content.slice(jsonStart, jsonEnd)); return Array.isArray(p) ? p : []; }
      catch { return []; }
    };

    const resolveType = (att: any): string => {
      const url = String(att?.url || "");
      const name = String(att?.name || "");
      if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
      const explicit = att?.type;
      if (explicit && explicit !== "file") return explicit;
      if (url.startsWith("data:image/")) return "image";
      if (url.startsWith("data:video/")) return "video";
      if (url.startsWith("data:audio/")) return "audio";
      const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : "";
      if (["jpg","jpeg","png","gif","webp","svg","bmp","heic","heif","tiff"].includes(ext)) return "image";
      if (["mp4","mov","avi","mkv","webm","m4v","wmv"].includes(ext)) return "video";
      if (["mp3","wav","ogg","m4a","aac","flac","wma"].includes(ext)) return "audio";
      if (ext === "pdf") return "pdf";
      if (["doc","docx","ppt","pptx","xls","xlsx","txt","md","csv"].includes(ext)) return "file";
      return url ? "link" : "text";
    };

    let pulled = 0;
    for (const pull of pulls) {
      const note = notesData[pull.noteId];
      if (!note) { console.warn("[LYKN] Media pull: note not found:", pull.noteId); continue; }
      const attachments = parseNoteAttachments(note.content || "");

      if (attachments.length === 0 && note.content) {
        const ytMatch = (note.content || "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
        if (ytMatch) {
          const videoId = ytMatch[1];
          const p = mediaPos(g * 12, g * 8);
          st.addYouTubeBlockAt({ x: p.x, y: p.y }, { url: ytMatch[0], videoId });
          pulled++;
          continue;
        }
        const p = mediaPos(g * 10, g * 4);
        st.addBlock({
          id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: "text" as const,
          x: p.x, y: p.y,
          width: g * 10, height: g * 4,
          content: note.content.replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, "").trim(),
          format: "rich",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any);
        pulled++;
        continue;
      }

      const att = attachments[pull.attIndex] || attachments[0];
      if (!att) continue;
      const url = String(att.url || "").trim();
      const type = resolveType(att);
      const blockId = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      if (type === "youtube") {
        const vid = att.videoId || extractYouTubeVideoId(url) || "";
        const p = mediaPos(g * 12, g * 8);
        st.addYouTubeBlockAt({ x: p.x, y: p.y }, { url, videoId: vid });
      } else if (type === "image") {
        const p = mediaPos(g * 12, g * 12);
        st.addBlock({ id: blockId, type: "create" as const, mode: "image", x: p.x, y: p.y, width: g * 12, height: g * 12, data: { src: url, name: att.name || "Image" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
      } else if (type === "video") {
        const p = mediaPos(g * 16, g * 10);
        st.addBlock({ id: blockId, type: "create" as const, mode: "video", x: p.x, y: p.y, width: g * 16, height: g * 10, data: { url, mime: att.mime || "video/mp4", name: att.name || "Video" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
      } else if (type === "audio") {
        const p = mediaPos(g * 14, g * 4);
        st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 14, height: g * 4, data: { url, mime: att.mime || "audio/mpeg", name: att.name || "Audio", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
      } else if (type === "pdf") {
        const p = mediaPos(g * 16, g * 14);
        st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 16, height: g * 14, data: { url, mime: "application/pdf", name: att.name || "PDF", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
      } else {
        const p = mediaPos(g * 14, g * 6);
        st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 14, height: g * 6, data: { url, name: att.name || note.title || "File", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
      }
      pulled++;
    }

    console.log("[LYKN] Media pull: embedded", pulled, "items from", pulls.length, "markers");
    return { cleanText, pulled };
  }, []);

  const addAiResponseBlock = useCallback((initialContent = "") => {
    const st = useCanvasStore.getState();
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || viewportWidth || 1280;
    const vh = window.innerHeight || 800;

    const initialW = g * 8;
    const initialH = g * 3;

    const allBlocks = Object.values(st.blocks || {}).filter(Boolean) as any[];
    const pos = findSmartPlacement({
      blockW: initialW,
      blockH: initialH,
      gridSize: g,
      camera: st.camera,
      viewportW: vw,
      viewportH: vh,
      railWidth: getChatRailWidthPx(vw),
      existingBlocks: allBlocks,
    });

    const id = addTextBlockAt(
      { x: pos.x, y: pos.y },
      { width: initialW, height: initialH, content: initialContent, format: "rich" }
    );
    st.updateBlock(id as any, { data: { ...((st.blocks as any)?.[id]?.data || {}), aiResponseBubble: true } } as any);
    return id;
  }, [addTextBlockAt, getChatRailWidthPx, viewportWidth]);

  const retireExistingAiBlocks = useCallback(() => {
    const st = useCanvasStore.getState() as any;
    const order = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const existingAiIds = order.filter((id: string) =>
      Boolean(st.blocks?.[id]?.data?.aiResponseBubble)
    );
    if (!existingAiIds.length) return;

    for (const id of existingAiIds) {
      const block = st.blocks?.[id];
      if (!block) continue;
      const curData = (block as any).data && typeof (block as any).data === "object" ? { ...(block as any).data } : {};
      delete curData.aiResponseBubble;
      updateBlock(id as any, { data: curData } as any);
    }
  }, [updateBlock]);

  const normalizeAiTextForBlock = useCallback((text: string) => {
    return String(text || "").replace(/\r\n?/g, "\n");
  }, []);

  const calcAiBubbleSize = useCallback((text: string) => {
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const screenW = window.innerWidth || 1280;
    const maxWidthPx = Math.max(g * 10, Math.floor(screenW * 0.9));
    const horizontalPad = 16;
    const charWidthPx = 7.8;
    const lineHeightPx = g;
    const verticalPad = 8;

    const lines = String(text || "").split("\n");
    const longest = lines.reduce((m, l) => Math.max(m, String(l || "").length), 0);
    const naturalWidth = Math.ceil(longest * charWidthPx + horizontalPad);
    const singleColWidth = Math.max(g * 8, Math.min(maxWidthPx, naturalWidth));

    const usableWidth = Math.max(1, singleColWidth - horizontalPad);
    const charsPerLine = Math.max(1, Math.floor(usableWidth / charWidthPx));
    let wrappedLines = 0;
    for (const line of lines) {
      wrappedLines += Math.max(1, Math.ceil((line.length || 1) / charsPerLine));
    }

    const contentHeight = wrappedLines * lineHeightPx + verticalPad;
    const heightPx = Math.max(g * 2, Math.ceil(contentHeight / g) * g);

    return { width: singleColWidth, height: heightPx };
  }, []);

  const addChatResponseToGrid = useCallback((text: string, dropClientX?: number, dropClientY?: number) => {
    const content = String(text || "").trim();
    if (!content) return;
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const size = calcAiBubbleSize(content);
    let posX: number, posY: number;
    if (dropClientX != null && dropClientY != null) {
      const cam = st.camera || { x: 0, y: 0, zoom: 1 };
      const z = Math.max(0.1, cam.zoom || 1);
      posX = Math.round(((dropClientX - (cam.x || 0)) / z) / g) * g;
      posY = Math.round(((dropClientY - (cam.y || 0)) / z) / g) * g;
    } else {
      const pos = findSmartPlacement({
        blockW: size.width, blockH: size.height, gridSize: g,
        camera: st.camera || { x: 0, y: 0, zoom: 1 },
        viewportW: vw, viewportH: vh,
        railWidth: getChatRailWidthPx(vw),
        existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[],
      });
      posX = pos.x;
      posY = pos.y;
    }
    const id = addTextBlockAt(
      { x: posX, y: posY },
      { width: size.width, height: size.height, content, format: "rich" }
    );
    if (id) {
      st.updateBlock(id as any, { data: { ...((st.blocks as any)?.[id]?.data || {}), aiResponseBubble: true } } as any);
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id } }));
      });
      setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
    }
  }, [addTextBlockAt, calcAiBubbleSize, getChatRailWidthPx]);

  const typeIntoAiResponseBlock = useCallback(
    async (blockId: string, fullText: string) => {
      const runId = ++aiTypingRunRef.current;
      const text = normalizeAiTextForBlock(fullText);
      let shown = "";

      while (shown.length < text.length && aiTypingRunRef.current === runId) {
        const nextChar = text.charAt(shown.length);
        const step = nextChar === "\n" ? 10 : 7;
        const delay = nextChar === "\n" ? 12 : /[.,!?]/.test(nextChar) ? 14 : 8;
        const nextLen = Math.min(text.length, shown.length + step);
        shown = text.slice(0, nextLen);
        const cur: any = useCanvasStore.getState().blocks?.[blockId];
        const userResized = cur?.data?.userResized;
        if (userResized) {
          updateBlock(blockId as any, { content: shown } as any);
        } else {
          const size = calcAiBubbleSize(shown);
          updateBlock(blockId as any, { content: shown, width: size.width, height: size.height } as any);
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }

      if (aiTypingRunRef.current === runId) {
        const cur: any = useCanvasStore.getState().blocks?.[blockId];
        const userResized = cur?.data?.userResized;
        if (userResized) {
          updateBlock(blockId as any, { content: text } as any);
        } else {
          const size = calcAiBubbleSize(text);
          updateBlock(blockId as any, { content: text, width: size.width, height: size.height } as any);
        }
      }
    },
    [calcAiBubbleSize, normalizeAiTextForBlock, updateBlock]
  );

  const replaySavedPromptResponse = useCallback(
    (msg: PromptMessage) => {
      if ((msg as any).aiImageUrl) {
        const imageUrl = String((msg as any).aiImageUrl);
        const st = useCanvasStore.getState() as any;
        const order: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
        const existingImg = order.find((id: string) => {
          const blk = st.blocks?.[id];
          return blk?.type === "create" && (blk as any).mode === "image" && (blk as any).data?.src === imageUrl;
        });
        if (existingImg) {
          window.dispatchEvent(new CustomEvent("omnia_expand_blocks", { detail: { ids: [existingImg] } }));
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id: existingImg } }));
          });
          return;
        }
        const g = Math.max(1, Math.floor(st.gridSize || 24));
        const cam = st.camera || { x: 0, y: 0 };
        const cx = cam.x + Math.floor((window.innerWidth || 1280) * 0.35);
        const cy = cam.y + Math.floor((window.innerHeight || 720) * 0.4);
        st.addBlock({
          id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: "create",
          mode: "image",
          x: cx,
          y: cy,
          width: g * 12,
          height: g * 12,
          data: { src: imageUrl },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if ((msg as any).aiVideoUrl) {
        const videoUrl = String((msg as any).aiVideoUrl);
        const st = useCanvasStore.getState() as any;
        const order: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
        const existingVid = order.find((id: string) => {
          const blk = st.blocks?.[id];
          return blk?.type === "create" && (blk as any).mode === "video" && (blk as any).data?.url === videoUrl;
        });
        if (existingVid) {
          window.dispatchEvent(new CustomEvent("omnia_expand_blocks", { detail: { ids: [existingVid] } }));
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id: existingVid } }));
          });
          return;
        }
        const g = Math.max(1, Math.floor(st.gridSize || 24));
        const cam = st.camera || { x: 0, y: 0 };
        const cx = cam.x + Math.floor((window.innerWidth || 1280) * 0.35);
        const cy = cam.y + Math.floor((window.innerHeight || 720) * 0.4);
        st.addBlock({
          id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: "create",
          mode: "video",
          x: cx,
          y: cy,
          width: g * 16,
          height: g * 10,
          data: { url: videoUrl, mime: "video/mp4" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      const saved = String(msg?.aiResponse || "").trim();
      if (!saved) return;
      addChatResponseToGrid(saved);
    },
    [addChatResponseToGrid, calcAiBubbleSize, normalizeAiTextForBlock, updateBlock]
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
      setChatRailOpen(true);
      setChatRailVisible(true);
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

      // AI responses are shown in the chat rail; no grid blocks to retire.
    }

    if (importedTodoLists.length) {
      const st = useCanvasStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const iVw = window.innerWidth || 1280;
      const iVh = window.innerHeight || 800;

      importedTodoLists.forEach((todoList) => {
        const itemCount = Array.isArray(todoList.items) ? todoList.items.length : 0;
        const estH = g * Math.max(3, itemCount + 2);
        const cur = useCanvasStore.getState() as any;
        const pos = findSmartPlacement({
          blockW: g * 12,
          blockH: estH,
          gridSize: g,
          camera: cur.camera || { x: 0, y: 0, zoom: 1 },
          viewportW: iVw,
          viewportH: iVh,
          railWidth: 0,
          existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
        });
        const listId = addListBlockAt({ x: pos.x, y: pos.y }, { listType: "todo", width: g * 12 });
        setListItems(listId as any, todoList.items as any, "todo");
      });
    }

    const importedAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (importedAttachments.length) {
      const st = useCanvasStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const aVw = window.innerWidth || 1280;
      const aVh = window.innerHeight || 800;

      const attPos = (bw: number, bh: number) => {
        const cur = useCanvasStore.getState() as any;
        return findSmartPlacement({
          blockW: bw,
          blockH: bh,
          gridSize: g,
          camera: cur.camera || { x: 0, y: 0, zoom: 1 },
          viewportW: aVw,
          viewportH: aVh,
          railWidth: 0,
          existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
        });
      };

      for (const att of importedAttachments) {
        const url = String(att.url || "").trim();
        const attType = String(att.type || "").toLowerCase();
        const videoId = att.videoId || (attType === "youtube" ? (extractYouTubeVideoId(url) || "") : "");

        if (attType === "youtube" && (videoId || url)) {
          const ytUrl = url || `https://www.youtube.com/watch?v=${videoId}`;
          const p = attPos(g * 12, g * 8);
          st.addYouTubeBlockAt({ x: p.x, y: p.y }, { url: ytUrl, videoId });
        } else if (attType === "image" && url) {
          const p = attPos(g * 12, g * 12);
          if (url.startsWith("data:image/")) {
            const parts = url.split(",");
            const mm = parts[0]?.match(/:(.*?);/);
            if (mm && parts[1]) {
              try {
                const bstr = atob(parts[1]);
                const u8 = new Uint8Array(bstr.length);
                for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
                const file = new File([u8], att.name || "image.png", { type: mm[1] });
                window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX: p.x, clientY: p.y } }));
              } catch { /* ignore */ }
            }
          } else {
            window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
          }
        } else if (attType === "video" && url) {
          const p = attPos(g * 16, g * 10);
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
        } else if (attType === "pdf") {
          const pdfText = String(att.pdfText || att.extractedText || "").trim();
          if (pdfText) {
            const title = String(att.name || att.memoryTitle || "PDF").trim();
            const combined = `# ${title}\n\n${pdfText}`;
            const charsPerLine = Math.max(1, Math.floor((g * 16 * 0.85) / 8));
            const wrappedLines = combined.split("\n").reduce((sum: number, line: string) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
            const height = Math.max(g * 6, Math.min(g * 30, wrappedLines * 22 + 32));
            const p = attPos(g * 16, height);
            st.addTextBlockAt({ x: p.x, y: p.y }, { width: g * 16, height, content: combined, format: "plain" });
          } else if (url) {
            const pdfName = String(att.name || att.memoryTitle || "document.pdf").trim();
            const pdfUrl = url;
            const p = attPos(g * 16, g * 10);
            (async () => {
              try {
                const resp = await fetch(pdfUrl);
                if (resp.ok) {
                  const blob = await resp.blob();
                  const file = new File([blob], pdfName.endsWith(".pdf") ? pdfName : `${pdfName}.pdf`, { type: "application/pdf" });
                  window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX: p.x, clientY: p.y } }));
                  return;
                }
              } catch { /* fetch failed, fall through */ }
              window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: pdfUrl, clientX: p.x, clientY: p.y } }));
            })();
          }
        } else if (attType === "memory" && att.memoryContent) {
          const content = att.memoryTitle ? `# ${att.memoryTitle}\n\n${att.memoryContent}` : att.memoryContent;
          const p = attPos(g * 12, g * 6);
          st.addTextBlockAt({ x: p.x, y: p.y }, { width: g * 12, height: g * 6, content, format: "rich" });
        } else if (url) {
          const p = attPos(g * 10, g * 6);
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
        }
      }
    }
  }, [addListBlockAt, boardId, setListItems, user?.id]);

  const applyProjectActions = useCallback((actions: CreateAction[]) => {
    const list = Array.isArray(actions) ? actions : [];
    if (!list.length) return { created: 0, failures: [] as string[] };
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    let created = 0;
    const failures: string[] = [];
    const makeId = (prefix = "b") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const getPos = (bw: number, bh: number) => {
      const cur = useCanvasStore.getState() as any;
      return findSmartPlacement({
        blockW: bw,
        blockH: bh,
        gridSize: g,
        camera: cur.camera || { x: 0, y: 0, zoom: 1 },
        viewportW: vw,
        viewportH: vh,
        railWidth: 0,
        existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
      });
    };

    for (const raw of list) {
      try {
        const type = String(raw?.type || "").trim().toLowerCase();
        const nextId = (_id: string) => {
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
          const extraData = rawAction?.data && typeof rawAction.data === "object" ? rawAction.data : {};
          const contentText = String((extraData as any)?.content || (extraData as any)?.body || "");
          const textVariant = String((extraData as any)?.textVariant || "body").toLowerCase();
          const listType = String((extraData as any)?.listType || "none").toLowerCase();
          const isHeading = textVariant === "h1" || textVariant === "h2";
          const isList = listType !== "none";
          const lineCount = contentText.split("\n").filter(Boolean).length;

          const defaultW = Number(definition?.defaultSize?.w || 8);
          const width = g * Math.max(1, isHeading ? Math.max(defaultW, 12) : isList ? Math.max(defaultW, 10) : defaultW);
          const defaultH = isHeading ? (textVariant === "h1" ? 3 : 2) : isList ? Math.max(4, lineCount + 2) : Number(definition?.defaultSize?.h || 4);
          const height = g * Math.max(1, defaultH);

          const pos = getPos(width, height);
          const createdId = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width, height, content: contentText, format: "plain" } as any);
          if (textVariant !== "body" || listType !== "none" || (extraData as any)?.brickColor || (extraData as any)?.textColor) {
            const block = st.blocks?.[createdId];
            const curData = block && (block as any).data && typeof (block as any).data === "object" ? { ...(block as any).data } : {};
            st.updateBlock(createdId, {
              data: {
                ...curData,
                ...(textVariant !== "body" ? { textVariant } : {}),
                ...(listType !== "none" ? { listType } : {}),
                ...((extraData as any)?.brickColor ? { brickColor: (extraData as any).brickColor } : {}),
                ...((extraData as any)?.textColor ? { textColor: (extraData as any).textColor } : {}),
              },
            } as any);
          }
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

        if (type === "delete_block") {
          const ids: string[] = [];
          if ((raw as any)?.blockId) ids.push(String((raw as any).blockId));
          if (Array.isArray((raw as any)?.blockIds)) {
            for (const bid of (raw as any).blockIds) ids.push(String(bid));
          }
          const validIds = ids.filter((bid) => Boolean(st.blocks?.[bid]));
          if (validIds.length) {
            st.deleteBlocks(validIds as any);
            created += validIds.length;
          } else {
            failures.push("delete_block: no matching block IDs found on the Grid");
          }
          continue;
        }

        if (type === "update_text_block") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block || block.type !== "text") {
            failures.push("update_text_block: block not found or not a text block");
            continue;
          }
          const patch: any = {};
          if ((raw as any)?.content != null) {
            patch.content = String((raw as any).content);
          } else if (typeof (raw as any)?.append === "string") {
            const cur = String(block?.content || "");
            patch.content = cur + (cur.endsWith("\n") ? "" : "\n") + (raw as any).append;
          }
          if ((raw as any)?.data && typeof (raw as any).data === "object") {
            patch.data = { ...(block?.data || {}), ...(raw as any).data };
          }
          if (Object.keys(patch).length) {
            st.updateBlock(blockId, patch);
            created += 1;
          }
          continue;
        }

        if (type !== "create_universal_block" && type !== "create_youtube_block") {
          failures.push(`Skipped legacy action in brick mode: ${type}`);
          continue;
        }

        if (type === "create_youtube_block") {
          const rawUrl = String((raw as any)?.url || "").trim();
          const videoId = extractYouTubeVideoId(rawUrl) || "";
          if (rawUrl || videoId) {
            const ytUrl = rawUrl || `https://www.youtube.com/watch?v=${videoId}`;
            const ytPos = getPos(g * 12, g * 8);
            const createdId = st.addYouTubeBlockAt({ x: ytPos.x, y: ytPos.y }, { url: ytUrl, videoId });
            nextId(createdId);
          } else {
            failures.push("create_youtube_block: missing url");
          }
          continue;
        }

        if (false && (type === "create_sheet" || type === "paper_outline" || type === "create_paper")) {
          const title = String((raw as any)?.title || "").trim();
          const body = String((raw as any)?.content || (raw as any)?.outline || "").trim();
          const content = [title ? `# ${title}` : "", body].filter(Boolean).join("\n\n");
          const sheetPos = getPos(g * 14, g * 10);
          const id = st.addSheetBlockAt({ x: sheetPos.x, y: sheetPos.y }, { content });
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
          const tbPos = getPos(boardW, boardH);
          const boardId = makeId("create");
          st.addBlock({
            id: boardId,
            type: "create",
            x: tbPos.x,
            y: tbPos.y,
            width: boardW,
            height: boardH,
            mode: "taskboard",
            data: { kind: "taskboard", title, columns },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as any);
          created += 1;
          continue;
        }
        if (type === "create_design_board" || type === "brainstorm") {
          const width = g * 20;
          const height = g * 14;
          const dbPos = getPos(width, height);
          const id = makeId("create");
          const seedText = String((raw as any)?.seedText || (raw as any)?.content || "").trim();
          st.addBlock({
            id,
            type: "create",
            x: dbPos.x,
            y: dbPos.y,
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
          created += 1;
          continue;
        }
        if (type === "create_spreadsheet") {
          const rows = Math.max(1, Math.min(1000, Number((raw as any)?.rows || 30)));
          const cols = Math.max(1, Math.min(100, Number((raw as any)?.cols || 20)));
          const ssPos = getPos(g * 14, g * 10);
          const id = st.addSpreadsheetBlockAt({ x: ssPos.x, y: ssPos.y }, { rows, cols });
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
          const codePos = getPos(g * 14, g * 7);
          const id = st.addCodeBlockAt({ x: codePos.x, y: codePos.y }, { width: g * 14, height: g * 7, language, content });
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
          const listPos = getPos(g * 10, g * 6);
          const id = st.addListBlockAt({ x: listPos.x, y: listPos.y }, { listType });
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

  const isBoardEmpty = useCallback(() => {
    if (chatMessages.length > 0) return false;
    if (aiThreadRef.current.length > 0) return false;
    const st = useCanvasStore.getState();
    const blockIds = st.blockOrder || [];
    const blocksMap = st.blocks || {};
    const meaningful = blockIds.filter((id: string) => {
      const b = blocksMap[id];
      if (!b) return false;
      const data = (b as any)?.data && typeof (b as any).data === "object" ? (b as any).data : {};
      const content = String(data.content ?? data.body ?? (b as any)?.content ?? "").trim();
      const fmt = String((b as any)?.format || data.format || "").toLowerCase();
      if (fmt === "media" || fmt === "table" || fmt === "button") return true;
      if (content.length > 0) return true;
      return false;
    });
    return meaningful.length === 0;
  }, [chatMessages.length]);

  const sanitizeSnapshotForDb = useCallback((raw: any) => {
    const BASE64_RE = /^data:[^;]+;base64,/;
    const SIGNED_URL_RE = /supabase\.co\/storage\//;
    const MAX_BLOCK_CONTENT_BYTES = 10_240;

    const cleanBlocks: Record<string, any> = {};
    const blocks = raw.blocks || {};
    for (const [id, block] of Object.entries(blocks)) {
      const b = { ...(block as any) };

      if (b.data && typeof b.data === "object") {
        const d = { ...b.data };
        for (const key of ["src", "url", "dataUrl", "audioData", "pdfData"] as const) {
          const val = d[key];
          if (typeof val === "string" && (BASE64_RE.test(val) || (SIGNED_URL_RE.test(val) && d.storagePath))) {
            d[key] = "";
          }
        }
        if (typeof d.content === "string" && d.content.length > MAX_BLOCK_CONTENT_BYTES) {
          d.content = d.content.slice(0, MAX_BLOCK_CONTENT_BYTES);
        }
        b.data = d;
      }
      if (typeof b.dataUrl === "string" && BASE64_RE.test(b.dataUrl)) b.dataUrl = "";

      delete b.aiAnswers;
      delete b.universal;

      // Strip empty/default fields that waste bytes
      if (b.zIndex === undefined || b.zIndex === 0) delete b.zIndex;
      if (b.locked === false) delete b.locked;
      if (b.collapsed === false) delete b.collapsed;

      cleanBlocks[id] = b;
    }

    const { history: _h, future: _f, ...rest } = raw;

    const MAX_DB_CHAT = 50;
    const sanitizedChat = Array.isArray(rest.chatMessages)
      ? rest.chatMessages.slice(-MAX_DB_CHAT).map((m: any) => {
          const cleaned = { ...m };
          if (Array.isArray(cleaned.attachments)) {
            cleaned.attachments = cleaned.attachments.map((a: any) => {
              const c = { ...a };
              if (typeof c.url === "string" && SIGNED_URL_RE.test(c.url)) c.url = "";
              delete c.transcript;
              return c;
            });
          }
          if (typeof cleaned.content === "string" && cleaned.content.length > 3000) {
            cleaned.content = cleaned.content.slice(0, 3000);
          }
          if (typeof cleaned.aiResponse === "string" && cleaned.aiResponse.length > 10_000) {
            cleaned.aiResponse = cleaned.aiResponse.slice(0, 10_000);
          }
          return cleaned;
        })
      : [];

    const sanitizedThread = Array.isArray(rest.aiThread)
      ? rest.aiThread.slice(-MAX_DB_CHAT)
      : [];

    return {
      ...rest,
      blocks: cleanBlocks,
      chatMessages: sanitizedChat,
      aiThread: sanitizedThread,
    };
  }, []);

  const saveSnapshot = useCallback(async () => {
    if (!user?.id || !boardId || savingRef.current || !hydratedRef.current) return;
    savingRef.current = true;
    try {
      const raw = buildSnapshot();
      const savedTitle = (raw.title && String(raw.title).trim()) ? String(raw.title).trim() : "New Board";
      raw.title = savedTitle;
      const snapshot = sanitizeSnapshotForDb(raw);
      const now = new Date().toISOString();

      const updatePromise = supabase
        .from("omnia_boards")
        .update({ title: savedTitle, updated_at: now })
        .eq("id", boardId);

      const upsertPromise = supabase
        .from("omnia_board_states")
        .upsert(
          { board_id: boardId, state: snapshot, version: raw.version || SNAPSHOT_VERSION, user_id: user.id, updated_at: now },
          { onConflict: "board_id" }
        );

      await Promise.all([updatePromise, upsertPromise]);

      lastSavedTitleRef.current = savedTitle;
      titleFromSaveRef.current = true;
      try { localStorage.removeItem(`omnia_draft_${boardId}`); } catch { /* ignore */ }
      window.dispatchEvent(new Event("lykinsai_boards_changed"));
    } catch {
      // ignore
    } finally {
      savingRef.current = false;
    }
  }, [boardId, buildSnapshot, isBoardEmpty, user?.id]);

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
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
  }, [boardId, title, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const loadBoard = async () => {
      hydratedRef.current = false;
      let id: string | null = null;
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
      setChatMessages([]);
      aiThreadRef.current = [];
      try {
        // Check for unsaved localStorage draft (crash recovery)
        let draft: any = null;
        try {
          const raw = localStorage.getItem(`omnia_draft_${id}`);
          if (raw) draft = JSON.parse(raw);
        } catch { /* ignore */ }

        if (draft && draft.blocks && Object.keys(draft.blocks).length > 0) {
          applySnapshotRef.current(draft);
        } else {
          const { data } = await supabase
            .from("omnia_board_states")
            .select("state, version")
            .eq("board_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (data?.state) {
            const snap = { ...(data.state || {}), version: (data as any)?.version || (data.state as any)?.version || 1 };
            try {
              const lsCam = localStorage.getItem(`omnia_camera_${id}`);
              if (lsCam) {
                const parsed = JSON.parse(lsCam);
                if (parsed && typeof parsed === "object" && Number.isFinite(parsed.zoom)) {
                  snap.camera = { ...(snap.camera || {}), ...parsed };
                }
              }
            } catch { /* ignore */ }
            applySnapshotRef.current(snap);
          }
        }
      } catch {
        // ignore
      }
      hydratedRef.current = true;

      // updated_at is set during saveSnapshot — no need to bump it on open
      if (id) window.dispatchEvent(new Event("lykinsai_boards_changed"));
    };
    loadBoard();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBoardId, user?.id]);

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
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useCanvasStore.subscribe(() => {
      if (projectId) markProjectDirty(projectId);
      if (draftTimer) return;
      draftTimer = setTimeout(() => {
        draftTimer = null;
        try {
          const st = useCanvasStore.getState();
          localStorage.setItem(`omnia_camera_${boardId}`, JSON.stringify(st.camera));
          const snapshot = buildSnapshot();
          localStorage.setItem(`omnia_draft_${boardId}`, JSON.stringify(snapshot));
        } catch { /* quota */ }
      }, 2000);
    });
    return () => {
      unsubscribe();
      if (draftTimer) clearTimeout(draftTimer);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (chatTypingTimerRef.current) window.clearInterval(chatTypingTimerRef.current);
      chatTypingTimerRef.current = null;
    };
  }, [boardId, buildSnapshot, markProjectDirty, projectId, user?.id]);

  // Persist chat to localStorage as a fast local cache (debounced).
  // Chat is also saved to the DB via the board snapshot for durable cross-device persistence.
  useEffect(() => {
    if (!boardId) return;
    const timer = setTimeout(() => {
      try {
        const MAX_LOCAL_CHAT = 30;
        const SIGNED_URL_RE = /supabase\.co\/storage\//;
        const trimmed = chatMessages.slice(-MAX_LOCAL_CHAT).map((m: any) => {
          const cleaned = { ...m };
          if (Array.isArray(cleaned.attachments)) {
            cleaned.attachments = cleaned.attachments.map((a: any) => {
              const c = { ...a };
              if (typeof c.url === "string" && SIGNED_URL_RE.test(c.url)) c.url = "";
              delete c.transcript;
              return c;
            });
          }
          return cleaned;
        });
        const thread = (aiThreadRef.current || []).slice(-MAX_LOCAL_CHAT);
        localStorage.setItem(`omnia_chat_${boardId}`, JSON.stringify({ chatMessages: trimmed, aiThread: thread }));
      } catch { /* quota */ }
    }, 1500);
    return () => clearTimeout(timer);
  }, [boardId, chatMessages]);

  useEffect(() => {
    if (!projectId) return;
    refreshKnowledgeBase(projectId);
    if (user?.id) {
      refreshWorkspaceSummary(user.id, boardId || undefined);
    }
  }, [projectId, boardId, user?.id, refreshKnowledgeBase, refreshWorkspaceSummary]);

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
    if (!showConnectionCard || connectionCards.length === 0) return;
    if (connectionDismissTimerRef.current) window.clearTimeout(connectionDismissTimerRef.current);
    connectionDismissTimerRef.current = window.setTimeout(() => {
      setShowConnectionCard(false);
      connectionDismissTimerRef.current = null;
    }, 8000);
    return () => {
      if (connectionDismissTimerRef.current) window.clearTimeout(connectionDismissTimerRef.current);
    };
  }, [showConnectionCard, connectionCards]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    const onBeforeUnload = () => {
      try {
        const snapshot = buildSnapshot();
        localStorage.setItem(`omnia_draft_${boardId}`, JSON.stringify(snapshot));
      } catch { /* quota */ }
      savingRef.current = false;
      saveSnapshot();
    };
    const onFlushSave = () => {
      savingRef.current = false;
      saveSnapshot();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("omnia_flush_save", onFlushSave);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("omnia_flush_save", onFlushSave);
    };
  }, [boardId, buildSnapshot, saveSnapshot, user?.id]);

  useEffect(() => {
    if (!boardId || !user?.id) return;
    const currentBoardId = boardId;
    const currentUserId = user.id;
    return () => {
      savingRef.current = false;
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

  // Sync model picker with settings changes (same-tab + cross-tab), like the old Create panel.
  useEffect(() => {
    const sync = () => {
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
    window.addEventListener("lykinsai_settings_changed", sync as any);
    window.addEventListener("storage", sync as any);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync as any);
      window.removeEventListener("storage", sync as any);
    };
  }, []);

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

  useEffect(() => {
    const openSidebar = () => setShowMemorySidebar(true);
    window.addEventListener("omnia_open_memory_sidebar", openSidebar);
    return () => window.removeEventListener("omnia_open_memory_sidebar", openSidebar);
  }, []);

  useEffect(() => {
    const handleDropAttachments = (e: Event) => {
      const ce = e as CustomEvent<{ attachments: FocusedChatAttachment[] }>;
      const atts = Array.isArray(ce.detail?.attachments) ? ce.detail.attachments : [];
      if (!atts.length) return;
      const msgId = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const dropMsg: PromptMessage = {
        id: msgId,
        role: "user",
        content: atts.length === 1 ? `Dropped ${atts[0].name || "file"}` : `Dropped ${atts.length} files`,
        attachments: atts,
      };
      setChatMessages((prev) => [...prev, dropMsg]);
      if (!chatRailVisible && !chatMode) {
        setChatRailVisible(true);
        setChatRailOpen(true);
      }
    };
    window.addEventListener("omnia_chat_drop_attachments", handleDropAttachments);
    return () => window.removeEventListener("omnia_chat_drop_attachments", handleDropAttachments);
  }, [chatRailVisible, chatMode]);

  const pendingAiBrickActionRef = useRef(false);
  const pendingBrickActionDataRef = useRef<{ imageUrl?: string; videoId?: string } | null>(null);
  useEffect(() => {
    const handleAiBrickAction = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.prompt) return;
      setChatInput(detail.prompt);
      pendingBrickActionDataRef.current = {
        imageUrl: detail.imageUrl || undefined,
        videoId: detail.videoId || undefined,
      };
      if (!chatMode && !chatRailVisible) {
        setChatRailVisible(true);
        setChatRailOpen(true);
      }
      pendingAiBrickActionRef.current = true;
    };
    window.addEventListener("omnia_ai_brick_action", handleAiBrickAction);
    return () => window.removeEventListener("omnia_ai_brick_action", handleAiBrickAction);
  }, [chatMode, chatRailVisible]);

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

  const typeResponseIntoChat = useCallback((promptId: string, fullText: string): Promise<void> => {
    return new Promise((resolve) => {
      if (chatTypingTimerRef.current) {
        window.clearInterval(chatTypingTimerRef.current);
        chatTypingTimerRef.current = null;
      }
      const words = fullText.split(/(\s+)/);
      let idx = 0;
      const WORDS_PER_TICK = 3;
      const TICK_MS = 30;
      setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));
      chatTypingTimerRef.current = window.setInterval(() => {
        idx += WORDS_PER_TICK;
        const partial = words.slice(0, idx).join("");
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: partial } : m)));
        if (!chatUserScrolledUpRef.current) {
          const el = chatScrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }
        if (idx >= words.length) {
          if (chatTypingTimerRef.current) window.clearInterval(chatTypingTimerRef.current);
          chatTypingTimerRef.current = null;
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: fullText } : m)));
          resolve();
        }
      }, TICK_MS);
    });
  }, []);

  const saveAiImageToMedia = useCallback(async (imageUrl: string, promptText?: string) => {
    if (!user?.id || !imageUrl) return;

    let ext = "jpg";
    let fileUrl = imageUrl;
    let fileId = crypto.randomUUID();
    let storagePath = "";
    let fileSize = 0;
    let mimeType = "image/jpeg";
    let uploaded = false;

    try {
      const res = await fetch(imageUrl);
      if (res.ok) {
        const blob = await res.blob();
        ext = blob.type.includes("png") ? "png" : "jpg";
        mimeType = blob.type || `image/${ext}`;
        storagePath = `${user.id}/${fileId}/original.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("user-files")
          .upload(storagePath, blob, { cacheControl: "3600", upsert: false });
        if (!uploadError) {
          fileSize = blob.size;
          const { data: signedData } = await supabase.storage
            .from("user-files")
            .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
          fileUrl = signedData?.signedUrl || imageUrl;
          uploaded = true;
        } else {
          console.warn("[LYKN] Failed to upload AI image to storage:", uploadError.message);
        }
      }
    } catch (err) {
      console.warn("[LYKN] Could not download AI image for re-upload, saving with direct URL:", err);
    }

    try {
      const filename = `AI Generated ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.${ext}`;
      const attachment = [{
        type: "image",
        url: fileUrl,
        name: filename,
        fileId,
        ...(uploaded ? { storagePath, storageBucket: "user-files", size: fileSize } : {}),
        mimeType,
      }];
      const noteContent = `AI-generated image${promptText ? ` — "${promptText.slice(0, 100)}"` : ""}\n\n[View Image](${fileUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;

      const { error } = await supabase.from("notes").insert({
        user_id: user.id,
        title: filename,
        content: noteContent,
      });
      if (error) console.warn("[LYKN] Failed to save AI image note:", error.message);
      else console.log(`[LYKN] AI image saved to media: ${filename} (${uploaded ? "uploaded to storage" : "direct URL"})`);
    } catch (err) {
      console.warn("[LYKN] Error saving AI image note to media:", err);
    }
  }, [user?.id]);

  const saveAiVideoToMedia = useCallback(async (videoUrl: string, promptText?: string) => {
    if (!user?.id || !videoUrl) return;
    const filename = `AI Generated Video ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.mp4`;

    let fileUrl = videoUrl;
    let fileId = crypto.randomUUID();
    let storagePath = "";
    let fileSize = 0;
    let uploaded = false;

    try {
      const res = await fetch(videoUrl);
      if (res.ok) {
        const blob = await res.blob();
        storagePath = `${user.id}/${fileId}/original.mp4`;
        const { error: uploadError } = await supabase.storage
          .from("user-files")
          .upload(storagePath, blob, { cacheControl: "3600", upsert: false, contentType: "video/mp4" });
        if (!uploadError) {
          fileSize = blob.size;
          const { data: signedData } = await supabase.storage
            .from("user-files")
            .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
          fileUrl = signedData?.signedUrl || videoUrl;
          uploaded = true;
        } else {
          console.warn("[LYKN] Failed to upload AI video to storage:", uploadError.message);
        }
      }
    } catch (err) {
      console.warn("[LYKN] Could not download AI video for re-upload, saving with direct URL:", err);
    }

    try {
      const attachment = [{
        type: "video",
        url: fileUrl,
        name: filename,
        fileId,
        ...(uploaded ? { storagePath, storageBucket: "user-files", size: fileSize } : {}),
        mimeType: "video/mp4",
      }];
      const noteContent = `AI-generated video${promptText ? ` — "${promptText.slice(0, 100)}"` : ""}\n\n[View Video](${fileUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;

      const { error } = await supabase.from("notes").insert({
        user_id: user.id,
        title: filename,
        content: noteContent,
      });
      if (error) console.warn("[LYKN] Failed to save AI video note:", error.message);
      else console.log(`[LYKN] AI video saved to media: ${filename} (${uploaded ? "uploaded to storage" : "direct URL"})`);
    } catch (err) {
      console.warn("[LYKN] Error saving AI video note to media:", err);
    }
  }, [user?.id]);

  const saveYouTubeToMedia = useCallback(async (videoId: string, url: string) => {
    if (!user?.id || !videoId) return;
    const title = `YouTube Video — ${videoId}`;
    const watchUrl = url || `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    try {
      const attachment = [{
        type: "youtube",
        url: watchUrl,
        videoId,
        name: title,
        thumbnail,
      }];
      const noteContent = `${title}\n\n[Watch on YouTube](${watchUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { error } = await supabase.from("notes").insert({
        user_id: user.id,
        title,
        content: noteContent,
      });
      if (error) console.warn("[LYKN] Failed to save YouTube note:", error.message);
    } catch (err) {
      console.warn("[LYKN] Error saving YouTube to media:", err);
    }
  }, [user?.id]);

  const saveLinkToMedia = useCallback(async (linkUrl: string) => {
    if (!user?.id || !linkUrl) return;
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(linkUrl)}`);
      const meta = res.ok ? await res.json() : { url: linkUrl, title: linkUrl, description: "", image: "", siteName: "", favicon: "", articleText: "" };
      const attachment = [{
        type: "bookmark",
        url: meta.url || linkUrl,
        name: meta.title || linkUrl,
        title: meta.title || "",
        description: meta.description || "",
        image: meta.image || "",
        favicon: meta.favicon || "",
        siteName: meta.siteName || "",
        articleText: meta.articleText || "",
        oembedType: meta.oembedType || "",
        oembedHtml: meta.oembedHtml || "",
        authorName: meta.authorName || "",
        authorHandle: meta.authorHandle || "",
      }];
      const noteContent = `${meta.title || linkUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { error } = await supabase.from("notes").insert({
        user_id: user.id,
        title: meta.title || linkUrl,
        content: noteContent,
      });
      if (error) console.warn("[LYKN] Failed to save link note:", error.message);
      else console.log(`[LYKN] Link saved to media: ${meta.title || linkUrl}`);
    } catch (err) {
      console.warn("[LYKN] Error saving link to media:", err);
    }
  }, [user?.id]);

  const saveAttachmentToMedia = useCallback(async (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => {
    if (!user?.id || !url) return;
    const fileId = crypto.randomUUID();
    let fileUrl = url;
    let storagePath = "";
    let fileSize = 0;
    let uploaded = false;
    const ext = mediaType === "image" ? "jpg" : mediaType === "video" ? "mp4" : mediaType === "audio" ? "mp3" : "bin";
    const mimeMap: Record<string, string> = { image: "image/jpeg", video: "video/mp4", audio: "audio/mpeg", file: "application/octet-stream" };
    let mimeType = mimeMap[mediaType] || "application/octet-stream";

    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type) mimeType = blob.type;
        const blobExt = blob.type?.split("/")?.[1]?.replace("jpeg", "jpg") || ext;
        storagePath = `${user.id}/${fileId}/original.${blobExt}`;
        const { error: uploadError } = await supabase.storage
          .from("user-files")
          .upload(storagePath, blob, { cacheControl: "3600", upsert: false, contentType: mimeType });
        if (!uploadError) {
          fileSize = blob.size;
          const { data: signedData } = await supabase.storage
            .from("user-files")
            .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
          fileUrl = signedData?.signedUrl || url;
          uploaded = true;
        }
      }
    } catch { /* save with direct URL */ }

    try {
      const filename = name || `Saved ${mediaType} ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.${ext}`;
      const attachment = [{
        type: mediaType,
        url: fileUrl,
        name: filename,
        fileId,
        ...(uploaded ? { storagePath, storageBucket: "user-files", size: fileSize } : {}),
        mimeType,
      }];
      const noteContent = `${filename}\n\n[View](${fileUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      await supabase.from("notes").insert({
        user_id: user.id,
        title: filename,
        content: noteContent,
      });
    } catch { /* ignore */ }
  }, [user?.id]);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading || isSendingRef.current) return;
    chatUserScrolledUpRef.current = false;
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);

    const now = Date.now();
    const sig = text.length > 100 ? text.slice(0, 100) : text;
    if (lastSendSigRef.current.text === sig && now - lastSendSigRef.current.at < 900) return;
    lastSendSigRef.current = { text: sig, at: now };

    activeAiAbortRef.current?.abort();
    activeAiAbortRef.current = new AbortController();
    const sendAbort = activeAiAbortRef.current;

    isSendingRef.current = true;
    const sentAttachments = [...focusedChatAttachments];
    const brickActionData = pendingBrickActionDataRef.current;
    pendingBrickActionDataRef.current = null;
    const isBrickAction = Boolean(brickActionData);

    if (brickActionData?.videoId && !sentAttachments.some((a: any) => a.videoId === brickActionData.videoId)) {
      sentAttachments.push({
        type: "youtube",
        videoId: brickActionData.videoId,
        url: `https://www.youtube.com/watch?v=${brickActionData.videoId}`,
        name: `YouTube ${brickActionData.videoId}`,
      } as any);
    }

    setChatInput("");
    setFocusedChatAttachments([]);
    setIsChatLoading(true);
    setChatStatusText("");
    setChatFlowMode("idle");
    const promptId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    // Whisper-transcribe video/audio/YouTube attachments that have no transcript yet
    const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
    for (const att of sentAttachments) {
      if (att.transcript) continue;
      const attType = (att.type || "").toLowerCase();

      // YouTube attachments: fetch transcript (captions first, then Whisper via yt-dlp)
      if (attType === "youtube" && att.videoId) {
        try {
          if (sendAbort.signal.aborted) break;
          setChatStatusText(isBrickAction ? "Transcribing video..." : "Fetching video transcript...");
          const attTimeout = setTimeout(() => { if (!sendAbort.signal.aborted) sendAbort.abort(); }, 120000);
          const tRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}`, { signal: sendAbort.signal });
          clearTimeout(attTimeout);
          if (tRes.ok) {
            const tData = await tRes.json();
            const t = String(tData?.transcript || "").trim();
            if (t) att.transcript = t;
          }
        } catch { /* continue without transcript */ }
        continue;
      }

      // Uploaded video/audio: send to Whisper for transcription
      if (attType === "video" || attType === "audio") {
        try {
          setChatStatusText(`Transcribing ${att.name || attType}...`);
          const formData = new FormData();
          if (att.rawFile) {
            formData.append("file", att.rawFile, att.name || "upload");
          } else if (att.url && (att.url.startsWith("data:video/") || att.url.startsWith("data:audio/"))) {
            const base64 = att.url.split(",")[1];
            if (base64) {
              const binaryStr = atob(base64);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
              const mimeType = att.mime || att.url.split(";")[0].split(":")[1] || "audio/webm";
              const ext = mimeType.split("/")[1] || "webm";
              formData.append("file", new Blob([bytes], { type: mimeType }), att.name || `upload.${ext}`);
            }
          }
          if (formData.has("file") && !sendAbort.signal.aborted) {
            const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, { method: "POST", body: formData, signal: sendAbort.signal });
            if (wRes.ok) {
              const wData = await wRes.json();
              const t = String(wData?.transcript || "").trim();
              if (t) att.transcript = t;
            }
          }
        } catch { /* continue without transcript */ }
        continue;
      }
    }

    const attachmentContext = sentAttachments.length > 0
      ? "\n\n[Attached content]\n" + sentAttachments.map((a) => {
          const t = (a.type || "").toLowerCase();
          const label = a.name || a.memoryTitle || "Untitled";
          const parts: string[] = [];
          if (a.memoryContent) parts.push(String(a.memoryContent).slice(0, 1500));
          if (a.pdfText) parts.push(String(a.pdfText).slice(0, 1500));
          if (a.extractedText) parts.push(String(a.extractedText).slice(0, 1500));
          if (a.transcript) parts.push(String(a.transcript).slice(0, 8000));
          if (t === "memory" || t === "note") {
            return `${t === "note" ? "Note" : "Memory"} "${label}": ${parts.join("\n") || "(empty)"}`;
          }
          if (t === "pdf") return `PDF "${label}": ${parts.join("\n") || `(PDF at ${a.url})`}`;
          if (t === "document") {
            return `Document "${label}": ${parts.join("\n") || "(could not extract text)"}`;
          }
          const safeUrl = a.url && !a.url.startsWith("data:") ? a.url : "";
          if (t === "youtube") {
            const ctx = parts.length ? parts.join("\n") : "";
            return `YouTube video "${label}"${a.videoId ? ` (${a.videoId})` : ""}${safeUrl ? ` — ${safeUrl}` : ""}${ctx ? `\nTranscript: ${ctx}` : ""}`;
          }
          if (t === "video" || t === "audio") {
            return `${t === "video" ? "Video" : "Audio"} "${label}"${parts.length ? `\nTranscript: ${parts.join("\n")}` : " (no transcript available)"}`;
          }
          if (t === "image") return `Image "${label}"${safeUrl ? ` — ${safeUrl}` : ""}`;
          if (t === "link") return `Link "${label}"${safeUrl ? ` — ${safeUrl}` : ""}${parts.length ? `\nContent: ${parts.join("\n")}` : ""}`;
          if (parts.length) return `${label}: ${parts.join("\n")}`;
          if (safeUrl) return `${t || "File"} "${label}" — ${safeUrl}`;
          return `${t || "File"}: ${label}`;
        }).join("\n\n")
      : "";

    const displayText = text.length > 500 ? text.slice(0, 500) + "…" : text;
    setChatMessages((prev) => [...prev, {
      id: promptId, role: "user", content: displayText, kind: "prompt",
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    }]);

    // AI text responses now appear only in the chat rail — users drag them onto the grid.
    // Images, videos, and structural blocks (lists, sheets, etc.) still auto-place on the grid.
    let responseBlockId: string | null = null;

    try {
      const cappedText = text.length > 3000 ? text.slice(0, 3000) : text;
      aiThreadRef.current.push({ role: "user", content: cappedText + (attachmentContext ? attachmentContext.slice(0, 1000) : "") });
      if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);

      const recentThread = aiThreadRef.current.slice(-16);
      const history = recentThread
        .map((m) => {
          const label = m.role === "user" ? "User" : "Assistant";
          const trimmed = m.content.length > 1200 ? m.content.slice(0, 1200) + "…" : m.content;
          return `${label}: ${trimmed}`;
        })
        .join("\n");

      // Build a proper conversation array from chatMessages so the server
      // can include the full thread in [CONVERSATION] for the system prompt.
      const conversationArray: Array<{ role: string; content: string }> = [];
      for (const cm of chatMessages) {
        if (cm.role === "user" && cm.content) {
          conversationArray.push({ role: "user", content: cm.content });
          if (cm.aiResponse) {
            conversationArray.push({ role: "assistant", content: cm.aiResponse });
          }
        } else if (cm.role !== "user" && cm.content) {
          conversationArray.push({ role: "assistant", content: cm.content });
        }
      }
      conversationArray.push({ role: "user", content: cappedText });

      const canvasContext = buildCanvasContext();
      const kbText = getKnowledgeBaseContext();

      const wantsMediaPull = /\b(pull\s*in|bring\s*in|fetch|grab|get|show\s*me|add)\b.*\b(from\s*(my\s*)?(media|saved|library|files)|that\s*(image|photo|video|pdf|file|doc|link|note)\s*(i|I)\s*saved|saved\s*(content|files|media|stuff)|from\s*media)\b/i.test(text)
        || /\b(my\s*saved|my\s*media|from\s*media\s*page|media\s*page)\b/i.test(text);
      let mediaContext = "";
      if (wantsMediaPull) {
        const ws = getCachedWorkspaceSummary();
        mediaContext = ws?.media || "";
        console.log("[LYKN] Media pull requested — using cached", mediaContext.length, "chars");
      }
      console.log("[LYKN] Context sizes — canvas:", canvasContext.length, "kb:", kbText.length, "mediaPull:", mediaContext.length);
      const API_BASE_URL = apiBase;
      const asksAboutVideo = !isBrickAction && isVideoQuestion(text);
      // Find ALL YouTube videos on the board (not just visible ones) + chat attachments
      const boardVideos = getAllYouTubeBlocks();
      const attachedYouTubeVideos = sentAttachments
        .filter((a) => a.type?.toLowerCase() === "youtube" && a.videoId)
        .map((a) => ({ videoId: a.videoId!, url: a.url, title: a.name || `YouTube ${a.videoId}` }));
      const seen = new Set<string>();
      const allYouTubeVideos: Array<{ videoId: string; url: string; title: string }> = [];
      for (const v of [...attachedYouTubeVideos, ...boardVideos]) {
        if (seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        allYouTubeVideos.push(v);
      }
      // YouTube transcript fetching
      let youtubeGrounding = "";
      const needsFullTranscript = asksAboutVideo || isBrickAction;
      console.log("[LYKN] Video detection:", { asksAboutVideo, isBrickAction, needsFullTranscript, boardVideos: boardVideos.length, attachedYT: attachedYouTubeVideos.length, allYT: allYouTubeVideos.length, videoIds: allYouTubeVideos.map(v => v.videoId) });
      if (needsFullTranscript && allYouTubeVideos.length > 0 && !sendAbort.signal.aborted) {
        const targetVideo = allYouTubeVideos[0];
        setChatStatusText("Fetching video transcript...");
        try {
          const tTimeout = setTimeout(() => { if (!sendAbort.signal.aborted) sendAbort.abort(); }, 120000);
          const tRes = await fetch(
            `${API_BASE_URL}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}`,
            { signal: sendAbort.signal }
          ).catch(() => null);
          clearTimeout(tTimeout);
          const tJson = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
          const fullTranscript = String((tJson as any)?.transcript || "").trim();
          if (fullTranscript) {
            youtubeTranscriptCacheRef.current[targetVideo.videoId] = {
              fetchedAt: Date.now(),
              title: targetVideo.title || `YouTube ${targetVideo.videoId}`,
              url: targetVideo.url,
              transcript: fullTranscript,
              segments: Array.isArray((tJson as any)?.segments) ? (tJson as any).segments : [],
            };
            const safeTranscript =
              fullTranscript.length > 3000
                ? fullTranscript.slice(0, 1000) + "...[truncated transcript]"
                : fullTranscript;
            youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\nFull transcript:\n${safeTranscript}`;
            setChatStatusText("Transcript ready — generating response...");
          } else {
            setChatStatusText("No transcript available — answering from metadata...");
            youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(No transcript available)`;
          }
        } catch {
          if (!sendAbort.signal.aborted) {
            setChatStatusText("Transcript fetch failed — answering from metadata...");
            youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(Transcript fetch failed)`;
          }
        }
      } else if (!isBrickAction && allYouTubeVideos.length > 0 && !sendAbort.signal.aborted) {
        setChatStatusText("Analyzing visible YouTube videos...");
        youtubeGrounding = await buildYouTubeGrounding(API_BASE_URL, text, sendAbort.signal);
      }
      const userTextCapped = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
      const videoTranscriptBlock = youtubeGrounding
        ? (youtubeGrounding.includes("Full transcript:")
            ? `[VIDEO TRANSCRIPT — Use this to answer the user's question about the video. Do NOT say you cannot access the video. The transcript below IS the video's content.]\n${youtubeGrounding}`
            : `YouTube transcript context:\n${youtubeGrounding}`)
        : "";
      const prompt = [
        history ? `Conversation so far:\n${history}` : "",
        videoTranscriptBlock,
        `Latest user message:\n${userTextCapped}${attachmentContext}`,
      ].filter(Boolean).join("\n\n");
      const attachedImageUrls = sentAttachments
        .filter((a) => a.type?.toLowerCase() === "image" && a.url)
        .map((a) => a.url);
      if (brickActionData?.imageUrl && !attachedImageUrls.includes(brickActionData.imageUrl)) {
        attachedImageUrls.push(brickActionData.imageUrl);
      }

      if (sendAbort.signal.aborted) return;
      setChatStatusText("");
      setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));

      const st = useCanvasStore.getState();
      const hasFocusedBricks = (st.focusedBrickIds || []).length > 0;

      let editImageUrl = "";
      const focusedIds: string[] = Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [];

      const isImgBlock = (blk: any) =>
        blk?.type === "image" ||
        (blk?.type === "create" && (blk.mode === "image" || blk.mode === "generated"));
      const getImgSrc = (blk: any) => {
        const src = String(blk?.src || blk?.data?.src || "").trim();
        return (src && (src.startsWith("http") || src.startsWith("data:image/"))) ? src : "";
      };

      // Collect focused image URLs first
      const visionImageUrls: string[] = [];
      for (const fid of focusedIds) {
        const blk = (st.blocks as any)?.[fid];
        if (!isImgBlock(blk)) continue;
        const src = getImgSrc(blk);
        if (src) {
          if (!editImageUrl) editImageUrl = src;
          if (!visionImageUrls.includes(src)) visionImageUrls.push(src);
        }
      }

      // Collect remaining board images sorted by proximity to viewport center
      const MAX_VISION_IMAGES = 6;
      if (visionImageUrls.length < MAX_VISION_IMAGES) {
        const cam = (st as any).camera || { x: 0, y: 0 };
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const cx = (cam.x || 0) + vw / 2;
        const cy = (cam.y || 0) + vh / 2;
        const allIds = Array.isArray(st.blockOrder) ? st.blockOrder : [];
        const focusedSet = new Set(focusedIds);
        const boardImages = allIds
          .filter((id) => !focusedSet.has(id) && (st.blocks as any)?.[id] && isImgBlock((st.blocks as any)[id]))
          .map((id) => {
            const blk = (st.blocks as any)[id];
            const bx = (blk.x || 0) + (blk.width || 0) / 2;
            const by = (blk.y || 0) + (blk.height || 0) / 2;
            return { id, src: getImgSrc(blk), dist: Math.hypot(bx - cx, by - cy) };
          })
          .filter((e) => e.src)
          .sort((a, b) => a.dist - b.dist);
        for (const img of boardImages) {
          if (visionImageUrls.length >= MAX_VISION_IMAGES) break;
          if (!visionImageUrls.includes(img.src)) visionImageUrls.push(img.src);
        }
      }

      // Merge into attachedImageUrls for the request
      for (const url of visionImageUrls) {
        if (!attachedImageUrls.includes(url)) attachedImageUrls.push(url);
      }

      if (editImageUrl) {
        console.log("[OmniaCanvas] Found image for editing:", editImageUrl.slice(0, 80) + "...");
      }
      if (visionImageUrls.length) {
        console.log("[OmniaCanvas] Sending", visionImageUrls.length, "image(s) for vision analysis (focused:", focusedIds.filter((id) => isImgBlock((st.blocks as any)?.[id])).length, "board:", visionImageUrls.length - focusedIds.filter((id) => isImgBlock((st.blocks as any)?.[id])).length, ")");
      }

      let editVideoUrl = "";
      for (const fid of focusedIds) {
        const blk = (st.blocks as any)?.[fid];
        if (blk?.type === "create" && String(blk.mode || "").toLowerCase() === "video") {
          const src = String(blk.data?.url || blk.data?.src || "").trim();
          if (src && src.startsWith("http")) {
            editVideoUrl = src;
            break;
          }
        }
      }
      if (editVideoUrl) {
        console.log("[OmniaCanvas] Found video for editing/regeneration:", editVideoUrl.slice(0, 80) + "...");
      }

      const hasVideoTranscript = Boolean(youtubeGrounding && youtubeGrounding.includes("Full transcript:"));
      console.log("[LYKN] Prompt being sent:", { promptLen: prompt.length, hasVideoTranscript, youtubeGroundingLen: youtubeGrounding.length, videoTranscriptBlockLen: videoTranscriptBlock.length, promptPreview: prompt.slice(0, 300) });
      // Send the full prompt (with transcript) as BOTH `prompt` and `text` when we have video context.
      // The server's buildLyknStreamPrompt uses `text` for the user message — if we only send
      // the raw question as `text`, the server throws away the transcript.
      const textForServer = hasVideoTranscript ? prompt.slice(0, 16000) : cappedText;
      const truncatedConversation = conversationArray.slice(-8).map((m) => ({
        ...m,
        content: m.content.length > 1500 ? m.content.slice(0, 1500) + "…" : m.content,
      }));
      const wsContext = getCachedWorkspaceSummary();
      const requestBody = {
        model: selectedModel,
        prompt: prompt.slice(0, 16000),
        text: textForServer,
        intent: "ask",
        context: (canvasContext || "").slice(0, 14000),
        knowledgeBase: (kbText || "").slice(0, 2000),
        conversation: truncatedConversation,
        workspaceContext: (wsContext?.full || "").slice(0, 2000),
        projectId,
        boardId: routeBoardId || boardId || undefined,
        hasFocusedBricks,
        skipWebSearch: hasVideoTranscript,
        ...(mediaContext ? { mediaContext: mediaContext.slice(0, 8000) } : {}),
        ...(editImageUrl ? { editImageUrl } : {}),
        ...(editVideoUrl ? { editVideoUrl } : {}),
        ...(attachedImageUrls.length ? { imageUrls: attachedImageUrls } : {}),
        ...getAiPrefs(),
      };

      const hasFocusedTextBricks = focusedIds.some((fid) => {
        const blk = (st.blocks as any)?.[fid];
        return blk?.type === "text" && !isImgBlock(blk);
      });

      if (hasFocusedTextBricks && !editImageUrl && !editVideoUrl) {
        setChatStatusText("Editing bricks...");
        try {
          const invokeTimeout = setTimeout(() => sendAbort.abort(), 120000);
          const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, returnActions: true, text: cappedText }),
            signal: sendAbort.signal,
          });
          clearTimeout(invokeTimeout);
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            const assistantText = sanitizeAssistantResponse(
              String((data as any)?.response || (data as any)?.assistant || "").trim()
            ) || "Done.";
            const actions = Array.isArray((data as any)?.actions) ? (data as any).actions : [];
            if (actions.length) {
              applyProjectActions(actions);
            }
            await typeResponseIntoChat(promptId, assistantText);
            aiThreadRef.current.push({ role: "assistant", content: assistantText });
            if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
            if (responseBlockId && typeof updateBlock === "function") {
              const normalized = normalizeAiTextForBlock(assistantText);
              const curBlk2: any = useCanvasStore.getState().blocks?.[responseBlockId];
              if (curBlk2?.data?.userResized) {
                updateBlock(String(responseBlockId), { content: normalized } as any);
              } else {
                const size = calcAiBubbleSize(normalized);
                updateBlock(String(responseBlockId), { content: normalized, width: size.width, height: size.height } as any);
              }
            }
            setChatStatusText(actions.length ? "Bricks updated" : "Answered");
          } else {
            const errText = "This model isn\u2019t working properly right now \u2014 try another model.";
            setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errText } : m)));
            aiThreadRef.current.push({ role: "assistant", content: errText });
            if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), errText);
            setChatStatusText("Error");
          }
        } catch (err: any) {
          const errMsg = "This model isn\u2019t working properly right now \u2014 try another model.";
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errMsg } : m)));
          if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), errMsg);
          setChatStatusText("Error");
        }
        setIsChatLoading(false);
        isSendingRef.current = false;
        return;
      }

      let streamRes: Response | null = null;
      let useStreaming = false;
      try {
        const timeout = setTimeout(() => sendAbort.abort(), 120000);
        streamRes = await fetch(`${API_BASE_URL}/api/ai/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: sendAbort.signal,
        });
        clearTimeout(timeout);
        if (streamRes.ok && streamRes.headers.get("content-type")?.includes("text/event-stream")) {
          useStreaming = true;
        }
      } catch {
        streamRes = null;
      }

      if (useStreaming && streamRes) {
        const reader = streamRes.body?.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstToken = true;
        let sseBuffer = "";
        const isVideoReq = /\b(?:generate|create|make|produce|render)\b.{0,20}\b(?:video|clip|animation|footage|cinematic)\b/i.test(text) || /\b(?:animate|film)\b.{0,30}\b(?:me|a|an|the|of|for)\b/i.test(text);
        const STREAM_INACTIVITY_MS = isVideoReq ? 11 * 60 * 1000 : 60000;

        if (reader) {
          let inactivityTimer = setTimeout(() => { reader.cancel(); sendAbort.abort(); }, STREAM_INACTIVITY_MS);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              clearTimeout(inactivityTimer);
              inactivityTimer = setTimeout(() => { reader.cancel(); sendAbort.abort(); }, STREAM_INACTIVITY_MS);
              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() || "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;
                const payload = trimmed.slice(6);
                if (payload === "[DONE]") break;
                try {
                  const parsed = JSON.parse(payload);
                  if (parsed.error) {
                    accumulated = String(parsed.error);
                    break;
                  }
                  if (parsed.status) {
                    setChatStatusText(String(parsed.status));
                    continue;
                  }
                  if (parsed.image) {
                    setChatStatusText("Image generated");
                    const imageUrl = String(parsed.image);
                    setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: `[Generated Image]`, aiImageUrl: imageUrl } : m)));
                    {
                      const stImg = useCanvasStore.getState() as any;
                      const gImg = Math.max(1, Math.floor(stImg.gridSize || 24));
                      let imgX: number, imgY: number;
                      if (responseBlockId && stImg.blocks?.[responseBlockId]) {
                        imgX = stImg.blocks[responseBlockId].x ?? 100;
                        imgY = stImg.blocks[responseBlockId].y ?? 100;
                        try { deleteBlock(responseBlockId as any); } catch {}
                      } else {
                        const imgPos = findSmartPlacement({ blockW: gImg * 12, blockH: gImg * 12, gridSize: gImg, camera: stImg.camera || { x: 0, y: 0, zoom: 1 }, viewportW: window.innerWidth || 1280, viewportH: window.innerHeight || 800, railWidth: 0, existingBlocks: Object.values(stImg.blocks || {}).filter(Boolean) as any[] });
                        imgX = imgPos.x;
                        imgY = imgPos.y;
                      }
                      stImg.addBlock({
                        id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                        type: "create" as const, mode: "image",
                        x: imgX, y: imgY, width: gImg * 12, height: gImg * 12,
                        data: { src: imageUrl },
                        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                      });
                      responseBlockId = null;
                    }
                    accumulated = `[Generated Image](${imageUrl})`;
                    break;
                  }
                  if (parsed.video) {
                    setChatStatusText("Video generated");
                    const videoUrl = String(parsed.video);
                    setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: `[Generated Video]`, aiVideoUrl: videoUrl } : m)));
                    {
                      const stVid = useCanvasStore.getState() as any;
                      const gVid = Math.max(1, Math.floor(stVid.gridSize || 24));
                      let vidX: number, vidY: number;
                      if (responseBlockId && stVid.blocks?.[responseBlockId]) {
                        vidX = stVid.blocks[responseBlockId].x ?? 100;
                        vidY = stVid.blocks[responseBlockId].y ?? 100;
                        try { deleteBlock(responseBlockId as any); } catch {}
                      } else {
                        const vidPos = findSmartPlacement({ blockW: gVid * 16, blockH: gVid * 10, gridSize: gVid, camera: stVid.camera || { x: 0, y: 0, zoom: 1 }, viewportW: window.innerWidth || 1280, viewportH: window.innerHeight || 800, railWidth: 0, existingBlocks: Object.values(stVid.blocks || {}).filter(Boolean) as any[] });
                        vidX = vidPos.x;
                        vidY = vidPos.y;
                      }
                      stVid.addBlock({
                        id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                        type: "create" as const, mode: "video",
                        x: vidX, y: vidY, width: gVid * 16, height: gVid * 10,
                        data: { url: videoUrl, mime: "video/mp4" },
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      });
                      responseBlockId = null;
                    }
                    accumulated = `[Generated Video](${videoUrl})`;
                    break;
                  }
                  if (parsed.t) {
                    if (firstToken) {
                      setChatStatusText("Responding...");
                      firstToken = false;
                    }
                    accumulated += parsed.t;
                    const visibleText = accumulated.replace(/\n*(?:Sources?|References?):?\s*\n[\s\S]*$/i, "").trimEnd();
                    setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: visibleText } : m)));
                    if (responseBlockId && typeof updateBlock === "function") {
                      const normalized = normalizeAiTextForBlock(visibleText);
                      const curBlk: any = useCanvasStore.getState().blocks?.[responseBlockId];
                      if (curBlk?.data?.userResized) {
                        updateBlock(String(responseBlockId), { content: normalized } as any);
                      } else {
                        const size = calcAiBubbleSize(normalized);
                        updateBlock(String(responseBlockId), { content: normalized, width: size.width, height: size.height } as any);
                      }
                    }
                    if (!chatUserScrolledUpRef.current) {
                      const el = chatScrollRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                    }
                  }
                } catch {}
              }
            }
          } catch {
            if (!accumulated.trim()) accumulated = "This model isn\u2019t working properly right now \u2014 try another model.";
          } finally {
            clearTimeout(inactivityTimer);
          }
        }

        let aiText = sanitizeAssistantResponse(accumulated.trim());
        const hasYTG = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
        if (asksAboutVideo && hasYTG) {
          const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
          if (fallback && (!aiText || looksLikeDeflectingQuestion(aiText))) aiText = fallback;
        }
        const finalText = aiText || "I'm not sure how to answer that. Could you rephrase?";
        const { connections: aiConnections, cleanText: textWithoutConnections } = extractAiConnections(finalText);
        if (aiConnections.length > 0) {
          const boardConns = aiConnections.filter((c) => c.sourceType === "board");
          const mediaConns = aiConnections.filter((c) => c.sourceType === "media");
          if (boardConns.length > 0) {
            setConnectionCards(boardConns);
            setShowConnectionCard(true);
          }
          if (mediaConns.length > 0) {
            const cached = getCachedWorkspaceSummary()?.full || "";
            const resolved = mediaConns.map((mc) => {
              const m = cached.match(new RegExp(`"${mc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
              return m?.[1] ? { title: mc.title, reason: mc.reason, noteId: m[1] } : null;
            }).filter(Boolean) as Array<{ title: string; reason: string; noteId: string }>;
            if (resolved.length > 0) {
              setMediaSuggestions(resolved);
              setSelectedMediaIds(new Set());
              setShowMediaSuggestion(true);
            }
          }
        }
        const { cleanText: displayText, sources } = extractSourceLinks(textWithoutConnections);
        const ytResult = extractAndEmbedYouTubeUrls(displayText, promptId, responseBlockId);
        const mediaResult = await extractAndEmbedMediaItems(displayText, responseBlockId);
        const finalDisplayText = mediaResult.pulled > 0 ? mediaResult.cleanText : displayText;
        const webLinks1 = extractWebLinksFromText(finalDisplayText);
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalDisplayText, sources, aiYouTubeUrls: ytResult.urls.length ? ytResult.urls : undefined, aiWebLinks: webLinks1.length ? webLinks1 : undefined } : m)));
        aiThreadRef.current.push({ role: "assistant", content: textWithoutConnections });
        if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
        if (responseBlockId && typeof updateBlock === "function") {
          const normalized = normalizeAiTextForBlock(finalDisplayText);
          const curBlk3: any = useCanvasStore.getState().blocks?.[responseBlockId];
          if (curBlk3?.data?.userResized) {
            updateBlock(String(responseBlockId), { content: normalized } as any);
          } else {
            const size = calcAiBubbleSize(normalized);
            updateBlock(String(responseBlockId), { content: normalized, width: size.width, height: size.height } as any);
          }
          if (sources.length > 0) attachSourcesToBlock(String(responseBlockId), sources);
        }
        setChatStatusText(mediaResult.pulled > 0 ? "Media added to board" : ytResult.urls.length ? "Video embedded" : aiConnections.length > 0 ? "Connection found" : "Answered");
      } else {
        const invokeTimeout = setTimeout(() => sendAbort.abort(), 120000);
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, returnActions: false }),
          signal: sendAbort.signal,
        });
        clearTimeout(invokeTimeout);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const finalText = "This model isn\u2019t working properly right now \u2014 try another model.";
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
          aiThreadRef.current.push({ role: "assistant", content: finalText });
          if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
          if (responseBlockId) await typeIntoAiResponseBlock(String(responseBlockId), finalText);
          setChatStatusText("Answered");
          return;
        }
        if ((data as any)?.type === "image" && (data as any)?.url) {
          const imageUrl = String((data as any).url);
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "[Generated Image]", aiImageUrl: imageUrl } : m)));
          aiThreadRef.current.push({ role: "assistant", content: `[Generated Image](${imageUrl})` });
          if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
          {
            const stImg2 = useCanvasStore.getState() as any;
            const gImg2 = Math.max(1, Math.floor(stImg2.gridSize || 24));
            let imgX2: number, imgY2: number;
            if (responseBlockId && stImg2.blocks?.[responseBlockId]) {
              imgX2 = stImg2.blocks[responseBlockId].x ?? 100;
              imgY2 = stImg2.blocks[responseBlockId].y ?? 100;
              try { deleteBlock(responseBlockId as any); } catch {}
            } else {
              const imgPos2 = findSmartPlacement({ blockW: gImg2 * 12, blockH: gImg2 * 12, gridSize: gImg2, camera: stImg2.camera || { x: 0, y: 0, zoom: 1 }, viewportW: window.innerWidth || 1280, viewportH: window.innerHeight || 800, railWidth: 0, existingBlocks: Object.values(stImg2.blocks || {}).filter(Boolean) as any[] });
              imgX2 = imgPos2.x;
              imgY2 = imgPos2.y;
            }
            stImg2.addBlock({
              id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              type: "create", mode: "image",
              x: imgX2, y: imgY2, width: gImg2 * 12, height: gImg2 * 12,
              data: { src: imageUrl },
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            });
          }
          setChatStatusText("Image generated");
          return;
        }
        if ((data as any)?.type === "video" && (data as any)?.url) {
          const videoUrl = String((data as any).url);
          setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "[Generated Video]", aiVideoUrl: videoUrl } : m)));
          aiThreadRef.current.push({ role: "assistant", content: `[Generated Video](${videoUrl})` });
          if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
          {
            const stVid2 = useCanvasStore.getState() as any;
            const gVid2 = Math.max(1, Math.floor(stVid2.gridSize || 24));
            let vidX2: number, vidY2: number;
            if (responseBlockId && stVid2.blocks?.[responseBlockId]) {
              vidX2 = stVid2.blocks[responseBlockId].x ?? 100;
              vidY2 = stVid2.blocks[responseBlockId].y ?? 100;
              try { deleteBlock(responseBlockId as any); } catch {}
            } else {
              const vidPos2 = findSmartPlacement({ blockW: gVid2 * 16, blockH: gVid2 * 10, gridSize: gVid2, camera: stVid2.camera || { x: 0, y: 0, zoom: 1 }, viewportW: window.innerWidth || 1280, viewportH: window.innerHeight || 800, railWidth: 0, existingBlocks: Object.values(stVid2.blocks || {}).filter(Boolean) as any[] });
              vidX2 = vidPos2.x;
              vidY2 = vidPos2.y;
            }
            stVid2.addBlock({
              id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              type: "create", mode: "video",
              x: vidX2, y: vidY2, width: gVid2 * 16, height: gVid2 * 10,
              data: { url: videoUrl, mime: "video/mp4" },
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            });
          }
          setChatStatusText("Video generated");
          return;
        }
        let aiText = String(data?.response || data?.answer || data?.text || "").trim();
        const hasYTG = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
        aiText = sanitizeAssistantResponse(aiText);
        if (asksAboutVideo && hasYTG) {
          const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
          if (fallback && (!aiText || looksLikeDeflectingQuestion(aiText))) aiText = fallback;
        }
        const finalText = aiText || "I'm not sure how to answer that. Could you rephrase?";
        const { connections: aiConnections2, cleanText: textWithoutConnections2 } = extractAiConnections(finalText);
        if (aiConnections2.length > 0) {
          const boardConns2 = aiConnections2.filter((c) => c.sourceType === "board");
          const mediaConns2 = aiConnections2.filter((c) => c.sourceType === "media");
          if (boardConns2.length > 0) {
            setConnectionCards(boardConns2);
            setShowConnectionCard(true);
          }
          if (mediaConns2.length > 0) {
            const cached2 = getCachedWorkspaceSummary()?.full || "";
            const resolved2 = mediaConns2.map((mc) => {
              const m = cached2.match(new RegExp(`"${mc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
              return m?.[1] ? { title: mc.title, reason: mc.reason, noteId: m[1] } : null;
            }).filter(Boolean) as Array<{ title: string; reason: string; noteId: string }>;
            if (resolved2.length > 0) {
              setMediaSuggestions(resolved2);
              setSelectedMediaIds(new Set());
              setShowMediaSuggestion(true);
            }
          }
        }
        const { cleanText: displayText2, sources: sources2 } = extractSourceLinks(textWithoutConnections2);
        const ytResult2 = extractAndEmbedYouTubeUrls(displayText2, promptId, responseBlockId);
        const mediaResult2 = await extractAndEmbedMediaItems(displayText2, responseBlockId);
        const finalDisplayText2 = mediaResult2.pulled > 0 ? mediaResult2.cleanText : displayText2;
        await typeResponseIntoChat(promptId, finalDisplayText2);
        const webLinks2 = extractWebLinksFromText(finalDisplayText2);
        setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, sources: sources2, aiYouTubeUrls: ytResult2.urls.length ? ytResult2.urls : undefined, aiWebLinks: webLinks2.length ? webLinks2 : undefined } : m)));
        aiThreadRef.current.push({ role: "assistant", content: textWithoutConnections2 });
        if (aiThreadRef.current.length > 40) aiThreadRef.current = aiThreadRef.current.slice(-40);
        if (responseBlockId) {
          await typeIntoAiResponseBlock(String(responseBlockId), finalDisplayText2);
          if (sources2.length > 0) attachSourcesToBlock(String(responseBlockId), sources2);
        }
        setChatStatusText(mediaResult2.pulled > 0 ? "Media added to board" : ytResult2.urls.length ? "Video embedded" : aiConnections2.length > 0 ? "Connection found" : "Answered");
      }
    } catch (err: any) {
      if (err?.name === "AbortError" && sendAbort !== activeAiAbortRef.current) {
        setChatStatusText("");
        return;
      }
      console.error("[LYKN] handleChatSend error:", err);
      setChatFlowMode("idle");
      const errMsg = "This model isn\u2019t working properly right now \u2014 try another model.";
      setChatStatusText(errMsg);
      setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errMsg } : m)));
      if (responseBlockId) {
        updateBlock(String(responseBlockId) as any, { content: chatErr } as any);
      }
    } finally {
      setIsChatLoading(false);
      isSendingRef.current = false;
      setChatFlowMode("idle");
      window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    }
  };

  const handleStopAi = useCallback(() => {
    activeAiAbortRef.current?.abort();
    activeAiAbortRef.current = null;
    setIsChatLoading(false);
    isSendingRef.current = false;
    setChatFlowMode("idle");
    setChatStatusText("Stopped");
  }, []);

  const handleCenterAskSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading || isSendingRef.current) return;
    setChatRailOpen(true);
    setChatRailVisible(true);
    setCenterChatLeaving(false);
    await handleChatSend();
  }, [chatInput, handleChatSend, isChatLoading]);

  const handleChatPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const html = e.clipboardData.getData("text/html");
    if (!html.trim()) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = getStructuredPasteFromEvent(e);
    setChatInput((prev) => prev.slice(0, start) + text + prev.slice(end));
    const newCaret = start + text.length;
    setTimeout(() => {
      ta.selectionStart = ta.selectionEnd = newCaret;
      ta.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (pendingAiBrickActionRef.current && chatInput.trim()) {
      pendingAiBrickActionRef.current = false;
      handleChatSend();
    }
  }, [chatInput, handleChatSend]);

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
  }, [chatMode, chatRailVisible, chatIsNearBottom]);

  useEffect(() => {
    if (!chatMode && !chatRailVisible) return;
    if (chatUserScrolledUpRef.current) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading, chatMode, chatRailVisible]);

  useEffect(() => {
    if (!chatMode) return;
    const t = window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [chatMode]);

  const chatTransitionTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const handleCanvasInteract = () => {
      if (chatMode || chatRailOpen || chatMessages.length > 0) return;
      setCenterChatLeaving(true);
      if (chatTransitionTimerRef.current) window.clearTimeout(chatTransitionTimerRef.current);
      chatTransitionTimerRef.current = window.setTimeout(() => {
        setChatRailOpen(true);
        setChatRailVisible(true);
        setCenterChatLeaving(false);
        chatTransitionTimerRef.current = null;
      }, 400);
    };
    window.addEventListener("omnia_canvas_interact", handleCanvasInteract);
    return () => {
      window.removeEventListener("omnia_canvas_interact", handleCanvasInteract);
      if (chatTransitionTimerRef.current) window.clearTimeout(chatTransitionTimerRef.current);
    };
  }, [chatMode, chatRailOpen, chatMessages.length]);

  useEffect(() => {
    const handleSourceToggled = async (e: Event) => {
      const ce = e as CustomEvent<{ blockId: string; sources: { title: string; url: string; enabled: boolean }[] }>;
      const { blockId, sources } = ce.detail || {};
      if (!blockId || !Array.isArray(sources)) return;

      const enabledSources = sources.filter((s) => s.enabled !== false);
      const disabledTitles = sources.filter((s) => s.enabled === false).map((s) => s.title);
      if (disabledTitles.length === 0) return;

      const msg = chatMessages.find((m) => m.aiResponse && m.sources?.some((s) => sources.some((ns) => ns.url === s.url)));
      if (!msg) return;
      const userPrompt = msg.content;
      if (!userPrompt) return;

      const st = useCanvasStore.getState();
      const blk = st.blocks[blockId];
      if (!blk) return;

      setChatStatusText("Re-generating without disabled sources...");
      setIsChatLoading(true);

      try {
        const sourceContext = enabledSources.length > 0
          ? `[WEB_SEARCH_RESULTS]\nUse ONLY these sources (the user has disabled the others):\n${enabledSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`
          : "";
        const regenPrompt = sourceContext
          ? `${userPrompt}\n\n${sourceContext}\n\nIMPORTANT: Do NOT use or reference these disabled sources: ${disabledTitles.join(", ")}. Re-answer using only the enabled sources above.`
          : `${userPrompt}\n\nIMPORTANT: The user has disabled all web sources. Answer this question using only your own knowledge, without citing any web sources.`;

        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: selectedModel,
            prompt: regenPrompt,
            text: userPrompt,
            intent: "ask",
            boardId: routeBoardId || boardId || undefined,
            ...getAiPrefs(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        let aiText = String(data?.response || data?.answer || data?.text || "").trim();
        if (!res.ok) aiText = String(data?.error || "Regeneration failed.").trim();

        const { cleanText } = extractSourceLinks(aiText);
        const normalized = normalizeAiTextForBlock(cleanText);

        const existingData = (blk as any).data && typeof (blk as any).data === "object" ? { ...(blk as any).data } : {};
        const sourceRowHeight = Math.ceil(sources.length / 2) * 32 + 24;
        const g = Math.max(1, Math.floor(st.gridSize || 24));
        const extraHeight = Math.ceil(sourceRowHeight / g) * g;
        if (existingData.userResized) {
          updateBlock(blockId as any, {
            content: normalized,
            data: { ...existingData, sources },
          } as any);
        } else {
          const size = calcAiBubbleSize(normalized);
          updateBlock(blockId as any, {
            content: normalized,
            width: size.width,
            height: size.height + extraHeight,
            data: { ...existingData, sources },
          } as any);
        }

        setChatMessages((prev) => prev.map((m) =>
          m.id === msg.id ? { ...m, aiResponse: cleanText, sources } : m
        ));
        aiThreadRef.current = aiThreadRef.current.map((t) =>
          t.role === "assistant" && t.content === msg.aiResponse ? { ...t, content: cleanText } : t
        );
        setChatStatusText("Answered");
      } catch {
        setChatStatusText("Regeneration failed.");
      } finally {
        setIsChatLoading(false);
      }
    };

    window.addEventListener("omnia_source_toggled", handleSourceToggled);
    return () => window.removeEventListener("omnia_source_toggled", handleSourceToggled);
  }, [chatMessages, selectedModel, calcAiBubbleSize, extractSourceLinks, normalizeAiTextForBlock, updateBlock]);

  const resizeChatInput = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const maxHeight = 220;
    el.style.height = "auto";
    const minH = el.dataset.minH ? Number(el.dataset.minH) : 36;
    const nextHeight = Math.min(maxHeight, Math.max(minH, el.scrollHeight));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  const canvasFileBlocks = useMemo(() => {
    if (!chatMode) return [];
    const st = useCanvasStore.getState();
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const items: { id: string; type: string; name: string; url: string; thumbUrl: string; videoId?: string; content?: string; isAi?: boolean }[] = [];
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
        if (b.data?.extractedText && b.data?.sourceFileName) {
          items.push({ id, type: "document", name: String(b.data.sourceFileName), url: "", thumbUrl: "", content: String(b.data.extractedText) });
          continue;
        }
        if (content) {
          const isAi = Boolean(b.data?.aiResponseBubble);
          const label = isAi ? "AI Response" : (content.split("\n")[0].slice(0, 40) || "Note");
          items.push({ id, type: "note", name: label, url: "", thumbUrl: "", content, isAi });
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
            const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
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
          ...(hasContent && itemType === "document" ? { extractedText: item.content } : {}),
          ...(hasContent && !["note", "memory", "pdf", "document"].includes(itemType) ? { memoryContent: item.content } : {}),
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
          const trimmedUrl = u.trim();
          const urlType = inferUrlAttachmentType(trimmedUrl);
          const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
          addFocusedAttachment({
            id: makeAttId(),
            type: urlType,
            url: trimmedUrl,
            name: trimmedUrl,
            mime: "",
            size: 0,
            ...(videoId ? { videoId } : {}),
          });
        }
      } else {
        addFocusedAttachment({ id: makeAttId(), type: "memory", url: "", name: "Dropped text", mime: "", size: 0, memoryTitle: "Dropped text", memoryContent: text });
      }
    }
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const file = f;
      const mime = file.type || "";
      const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
      const isDoc = DOCUMENT_EXTS.has(ext);
      if (isDoc) {
        (async () => {
          try {
            const { extractTextFromFile } = await import("@/lib/extract-text");
            const { API_BASE_URL } = await import("@/lib/api-config");
            const result = await extractTextFromFile(file, API_BASE_URL);
            addFocusedAttachment({
              id: makeAttId(), type: "document", url: "", name: file.name, mime, size: file.size,
              extractedText: result?.text || "",
            });
          } catch {
            addFocusedAttachment({ id: makeAttId(), type: "document", url: "", name: file.name, mime, size: file.size });
          }
        })();
        continue;
      }
      const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
      const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);
      const isAudio = mime.startsWith("audio/") || AUDIO_EXTS.has(ext);
      const isVideo = mime.startsWith("video/") || VIDEO_EXTS.has(ext);
      if (isAudio || isVideo) {
        addFocusedAttachment({
          id: makeAttId(), type: isAudio ? "audio" : "video",
          url: "", name: file.name, mime, size: file.size, rawFile: file,
        });
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        let type = "file";
        if (mime.startsWith("image/")) type = "image";
        else if (mime === "application/pdf" || ext === "pdf") type = "pdf";
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
      if (dictationTimerRef.current) {
        window.clearInterval(dictationTimerRef.current);
        dictationTimerRef.current = null;
      }
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch { /* ignore */ }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      } catch { /* ignore */ }
    
    };
  }, []);

  const handleOpenAttachments = useCallback(() => {
    setShowAttachMenu(true);
  }, []);

  const handleDictateToggle = useCallback(() => {
    if (isDictating) {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch { /* ignore */ }
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = async () => {
          try {
            mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
          } catch { /* ignore */ }
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          setIsDictating(false);

          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          audioChunksRef.current = [];
          if (blob.size < 2000) return;

          setIsTranscribing(true);
          try {
            const { API_BASE_URL } = await import("@/lib/api-config");
            const formData = new FormData();
            formData.append("audio", blob, "dictation.webm");
            formData.append("model", "whisper-1");
            formData.append("language", "en");
            const currentText = String(chatInput || "").trim();
            if (currentText) {
              formData.append("prompt", currentText.split(/\s+/).slice(-12).join(" "));
            }
            const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, {
              method: "POST",
              body: formData,
            });
            const data = await res.json().catch(() => ({}));
            const transcript = String(data?.text || "").trim();
            if (res.ok && transcript) {
              setChatInput((prev) => {
                const cur = String(prev || "").trim();
                return cur ? `${cur} ${transcript}` : transcript;
              });
            }
          } catch { /* ignore */ }
          setIsTranscribing(false);
        };

        recorder.onerror = () => {
          setIsDictating(false);
          setIsTranscribing(false);
        };

        recorder.start();
        setIsDictating(true);
      })
      .catch(() => {
        setIsDictating(false);
      });
  }, [chatInput, isDictating]);

  return (
    <div className="w-full h-[100svh] relative overflow-hidden bg-transparent">
      {/* Match BrickEditor layout: minimal chrome + floating controls */}
      {/* Heading panel (matches Create view top pill) */}
      {/* Board title — fixed next to Signed-in pill; does not move when sidebar expands */}
      <div className="fixed top-[1.1rem] z-[75] pointer-events-auto" style={{ left: "11.5rem" }}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitBoardTitle()}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          placeholder="New Board"
          className="bg-transparent text-[0.8125rem] font-medium text-black/80 placeholder:text-black/30 outline-none border-none w-[14rem] truncate px-1.5 py-0.5 rounded-md hover:bg-black/5 focus:bg-black/5 transition-colors"
        />
      </div>

      <div className="fixed top-3 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none" style={{ left: "var(--sidebar-offset, 0px)", transition: "left 200ms ease" }}>
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
              {/* AI model selector */}
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
                  setChatMode((v) => {
                    if (!v) setChatRailVisible(false);
                    return !v;
                  });
                }}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${chatMode ? "bg-blue-500/15" : ""}`}
                title={chatMode ? "Exit chat" : "Open chat"}
              >
                <MessageSquare className={`w-4 h-4 ${chatMode ? "text-blue-500" : ""}`} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setChatRailVisible((v) => {
                    if (!v) {
                      setChatRailOpen(true);
                      setChatMode(false);
                    }
                    return !v;
                  });
                  setCenterChatLeaving(false);
                }}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${chatRailVisible ? "bg-blue-500/15" : ""}`}
                title={chatRailVisible ? "Hide side chat" : "Show side chat"}
              >
                {chatRailVisible
                  ? <PanelRightClose className="w-4 h-4 text-blue-500" />
                  : <PanelRight className="w-4 h-4" />}
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowMemorySidebar((v) => !v)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={showMemorySidebar ? "Hide vault sidebar" : "Open vault sidebar"}
              >
                {showMemorySidebar ? <PanelRightClose className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
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
        <Canvas liveAIMode={false} isAiThinking={isChatLoading} thinkingStatusText={thinkingStatus} />
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
            window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
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
              a.type === "image" || (a.url && /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:image/"))
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
        className={`fixed top-[4.9rem] bottom-0 right-0 z-[65] w-[23.75rem] max-w-[92vw] border-l border-white/20 dark:border-white/10 bg-white/40 dark:bg-[rgba(20,20,24,0.55)] shadow-[0_18px_60px_rgba(0,0,0,0.22)] backdrop-blur-[40px] backdrop-saturate-[1.6] transition-transform duration-300 ${
          showMemorySidebar ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
        }`}
      >
        <div className="h-full flex flex-col">
          <div className="px-4 py-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-black dark:text-white">The Vault</h2>
              <p className="text-xs opacity-70">Files, images & media</p>
            </div>
            <button
              type="button"
              onClick={() => setShowMemorySidebar(false)}
              className="h-8 w-8 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
              title="Close vault sidebar"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 relative">
            {showMemorySidebar && (
              <iframe
                src="/memory?embedded=1"
                title="The Vault"
                className="absolute inset-0 w-full h-full border-0 bg-transparent"
              />
            )}
          </div>
        </div>
      </aside>

      {/* Center welcome prompt (no messages yet, not in chat mode) */}
      {!chatMode && chatMessages.length === 0 && (!chatRailOpen || centerChatLeaving) && (
        <div
          className={`fixed top-0 bottom-0 right-0 z-[85] pointer-events-none flex items-center justify-center px-4 ease-out ${centerChatLeaving ? "opacity-0 translate-x-[40vw] scale-[0.85]" : "opacity-100 translate-x-0 scale-100"}`}
          style={{ left: "var(--sidebar-offset, 0px)", transition: "all 400ms cubic-bezier(0.22,1,0.36,1)" }}
        >
          <div className="w-full max-w-2xl space-y-6">
            <p
              className={`pointer-events-none text-center text-3xl font-semibold tracking-tight min-h-[44px] text-black ${centerChatLeaving ? "opacity-0" : ""}`}
              style={{ transition: "opacity 400ms ease-out" }}
            >
              {typedWelcome}
            </p>
            <div className="pointer-events-auto glass-control rounded-2xl p-2 w-full transition-all duration-300">
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleOpenAttachments} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10" title="Add attachments">
                  <Plus className="w-4 h-4" />
                </button>
                {isDictating || isTranscribing ? (
                  <div className="w-full min-h-[44px] rounded-xl border border-blue-400/40 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
                    {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-sm text-blue-500 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 16, height: 16 }} /><span className="text-sm text-black/60">Transcribing...</span></>)}
                  </div>
                ) : (
                  <textarea
                    ref={centerChatInputRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onPaste={handleChatPaste}
                    onInput={(e) => resizeChatInput(e.currentTarget)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleCenterAskSend(); } }}
                    placeholder="Ask me anything..."
                    rows={1}
                    className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                  />
                )}
                <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${isDictating ? "bg-blue-500/15" : "hover:bg-black/10"}`} title={isDictating ? "Stop recording" : "Dictate"}>
                  <Mic className={`w-4 h-4 ${isDictating ? "text-blue-500" : ""}`} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Side rail chat (canvas mode — toggled open via button or canvas interaction) */}
      {!chatMode && chatRailVisible && (
        <div
          className={`fixed top-[4.9rem] bottom-0 z-[64] flex flex-col bg-white/40 backdrop-blur-sm border-l border-black/10 transition-[right] duration-300 ${showMemorySidebar ? "right-[380px]" : "right-0"}`}
          style={{
            width: `${chatRailWidthPx}px`,
            animation: "chatRailSlideIn 350ms cubic-bezier(0.22,1,0.36,1) both",
          }}
        >
          <div className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize z-[70] pointer-events-auto" onPointerDown={handleStartChatResize} title="Drag to resize chat" />
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-3">
            {isChatLoading && (<div className="text-[0.6875rem] text-black/60 px-1 flex items-center gap-2" aria-live="polite"><div className="brick-spinner" />{thinkingStatus}</div>)}
            {chatMessages.map((msg, idx) => (
              <div key={msg.id || idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                {msg.role === "user" && msg.attachments && msg.attachments.length > 0 && (
                  <div className="max-w-[94%] flex flex-wrap gap-1.5 justify-end mb-1.5">
                    {msg.attachments.map((att) => {
                      const at = (att.type || "").toLowerCase();
                      const attUrl = att.url || "";
                      const attKey = att.videoId || attUrl;
                      const isSaved = att.videoId ? savedYouTubeIds.has(att.videoId) : savedMediaUrls.has(attUrl);
                      const saveBtn = attKey ? (
                        <button type="button" className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`} disabled={isSaved} onClick={(e) => { e.stopPropagation(); if (att.videoId) { void saveYouTubeToMedia(att.videoId, attUrl); setSavedYouTubeIds((p) => new Set(p).add(att.videoId!)); } else { void saveAttachmentToMedia(attUrl, att.name || "File", at === "image" ? "image" : at === "video" ? "video" : at === "audio" ? "audio" : "file"); setSavedMediaUrls((p) => new Set(p).add(attUrl)); } }}>
                          {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                        </button>
                      ) : null;
                      if (at === "youtube" && att.videoId) {
                        return <div key={att.id}><div className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} /></div>{saveBtn}</div>;
                      }
                      if (at === "image" && att.url) return <div key={att.id}><img src={att.url} alt={att.name || "Image"} className="max-w-[11.25rem] max-h-[120px] rounded-lg border border-white/30 object-cover" />{saveBtn}</div>;
                      if (at === "video" && att.url) return <div key={att.id}><div className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><video src={att.url} controls className="w-full" preload="metadata" /></div>{saveBtn}</div>;
                      return <div key={att.id}><div className="flex items-center gap-1 rounded-lg border border-white/30 bg-white/20 px-2 py-1 text-[0.625rem]"><FileText className="w-3 h-3 opacity-60" /><span className="truncate max-w-[7.5rem]">{att.name || "File"}</span></div>{saveBtn}</div>;
                    })}
                  </div>
                )}
                {msg.role === "user" ? (
                  <button type="button" onClick={() => { void replaySavedPromptResponse(msg); }} disabled={!msg.aiResponse} className="group relative text-left max-w-[94%] disabled:cursor-default" title={msg.aiResponse ? "Show saved AI response" : "Waiting for AI response"}>
                    {msg.aiResponse ? (<span className="pointer-events-none absolute -top-6 right-0 rounded-md bg-black/70 px-2 py-1 text-[0.625rem] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 whitespace-nowrap">{(msg as any).aiImageUrl ? "Tap to view generated image" : (msg as any).aiVideoUrl ? "Tap to view generated video" : "Tap to view AI response"}</span>) : null}
                    <div className="w-full rounded-2xl rounded-br-md px-3 py-2 text-xs leading-relaxed text-black/90 border border-white/55 bg-[linear-gradient(135deg,rgba(255,255,255,0.32),rgba(255,255,255,0.16))] backdrop-blur-xl shadow-[0_10px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.35)] [&_table]:text-[0.6875rem] [&_td]:py-1 [&_th]:py-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>{normalizeChecklistSyntax(msg.content || "")}</ReactMarkdown>
                    </div>
                    {(msg as any).aiImageUrl && (
                      <div className="mt-1">
                        <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-lg shadow-md" style={{ maxHeight: "160px" }} />
                        <button type="button" className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={(e) => { e.stopPropagation(); void saveAiImageToMedia((msg as any).aiImageUrl, msg.content); setSavedMediaUrls((p) => new Set(p).add((msg as any).aiImageUrl)); }}>
                          {savedMediaUrls.has((msg as any).aiImageUrl) ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                        </button>
                      </div>
                    )}
                    {(msg as any).aiVideoUrl && (
                      <div className="mt-1">
                        <video src={(msg as any).aiVideoUrl} controls preload="metadata" className="max-w-full rounded-lg shadow-md" style={{ maxHeight: "160px" }} />
                        <button type="button" className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${savedMediaUrls.has((msg as any).aiVideoUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`} disabled={savedMediaUrls.has((msg as any).aiVideoUrl)} onClick={(e) => { e.stopPropagation(); void saveAiVideoToMedia((msg as any).aiVideoUrl, msg.content); setSavedMediaUrls((p) => new Set(p).add((msg as any).aiVideoUrl)); }}>
                          {savedMediaUrls.has((msg as any).aiVideoUrl) ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                        </button>
                      </div>
                    )}
                    {(msg as any).aiYouTubeUrls && (msg as any).aiYouTubeUrls.length > 0 && (
                      <div className="mt-1.5 space-y-1.5">
                        {(msg as any).aiYouTubeUrls.map((yt: { url: string; videoId: string }) => (
                          <div key={yt.videoId}>
                            <div className="rounded-lg overflow-hidden border border-white/30 shadow-md">
                              <iframe
                                src={`https://www.youtube-nocookie.com/embed/${yt.videoId}`}
                                className="w-full aspect-video"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                                title={`YouTube ${yt.videoId}`}
                              />
                            </div>
                            <button
                              type="button"
                              className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${savedYouTubeIds.has(yt.videoId) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                              disabled={savedYouTubeIds.has(yt.videoId)}
                              onClick={(e) => {
                                e.stopPropagation();
                                void saveYouTubeToMedia(yt.videoId, yt.url);
                                setSavedYouTubeIds((prev) => new Set(prev).add(yt.videoId));
                              }}
                            >
                              {savedYouTubeIds.has(yt.videoId) ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(msg as any).aiWebLinks.map((link: string) => {
                          const isSaved = savedMediaUrls.has(link);
                          let domain = "";
                          try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                          return (
                            <div key={link} className="inline-flex items-center gap-1 rounded-md border border-white/40 bg-white/50 px-1.5 py-0.5">
                              <Globe className="w-2.5 h-2.5 text-black/40 flex-shrink-0" />
                              <span className="text-[0.5625rem] text-black/60 truncate max-w-[5rem]">{domain}</span>
                              <button
                                type="button"
                                disabled={isSaved}
                                className={`inline-flex items-center gap-0.5 px-1 py-0.5 text-[0.5rem] rounded border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70"}`}
                                onClick={(e) => { e.stopPropagation(); void saveLinkToMedia(link); setSavedMediaUrls((p) => new Set(p).add(link)); }}
                              >
                                {isSaved ? <Check className="w-2 h-2" /> : <Save className="w-2 h-2" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </button>
                ) : (
                  <div className="max-w-[94%] rounded-2xl rounded-bl-md px-3 py-2 text-xs leading-relaxed break-words border bg-white/70 border-white/70 text-black/85">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                      {normalizeChecklistSyntax(msg.content || "")}
                    </ReactMarkdown>
                  </div>
                )}
                {msg.role === "user" && msg.aiResponse && (
                  <div className="self-start max-w-[94%] mt-1.5 space-y-1">
                    {(msg as any).aiImageUrl ? (
                      <div className="rounded-2xl rounded-bl-md px-3 py-2 border bg-white/70 border-white/70">
                        <img src={(msg as any).aiImageUrl} alt="Generated" className="max-w-full rounded-lg" style={{ maxHeight: "120px" }} />
                      </div>
                    ) : (msg as any).aiVideoUrl ? (
                      <div className="rounded-2xl rounded-bl-md px-3 py-2 border bg-white/70 border-white/70">
                        <video src={(msg as any).aiVideoUrl} controls preload="metadata" className="max-w-full rounded-lg" style={{ maxHeight: "120px" }} />
                      </div>
                    ) : (() => {
                      const chunks = splitResponseIntoChunks(msg.aiResponse || "");
                      const isSingle = chunks.length <= 1;
                      return (
                        <>
                          {chunks.map((chunk, ci) => (
                            <div key={`${msg.id}-chunk-${ci}`} className="group/chunk relative">
                              <div
                                draggable
                                onDragStart={(e) => {
                                  const sel = window.getSelection()?.toString()?.trim();
                                  const text = sel || chunk;
                                  e.dataTransfer.effectAllowed = "copy";
                                  e.dataTransfer.setData("application/x-omnia-chat-response", text);
                                  e.dataTransfer.setData("text/plain", text);
                                  try {
                                    const ghost = document.createElement("div");
                                    ghost.textContent = text.length > 60 ? text.slice(0, 57) + "…" : text;
                                    ghost.style.cssText = "position:fixed;top:-9999px;padding:6px 10px;border-radius:8px;background:rgba(59,130,246,0.15);font-size:11px;max-width:200px;overflow:hidden;white-space:nowrap";
                                    document.body.appendChild(ghost);
                                    e.dataTransfer.setDragImage(ghost, 0, 0);
                                    requestAnimationFrame(() => ghost.remove());
                                  } catch {}
                                }}
                                className={`rounded-xl px-3 py-1.5 text-xs leading-relaxed break-words border text-black/85 cursor-grab active:cursor-grabbing transition-all ${isSingle ? "bg-white/70 border-white/70 rounded-2xl rounded-bl-md" : "bg-white/50 border-white/40 hover:bg-white/70 hover:border-blue-300/40 hover:shadow-sm"}`}
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
                                  title="Add this section to grid"
                                  className="absolute -right-1 top-0.5 opacity-0 group-hover/chunk:opacity-100 transition-opacity p-0.5 rounded text-blue-400/70 hover:text-blue-500 hover:bg-blue-500/10"
                                  onClick={() => addChatResponseToGrid(chunk)}
                                >
                                  <LayoutGrid className="w-2.5 h-2.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </>
                      );
                    })()}
                    <div className="flex items-center gap-0.5 px-1">
                      <button type="button" title="Add full response to grid" className="p-1 rounded-md text-black/30 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                        <LayoutGrid className="w-3 h-3" />
                      </button>
                      <button type="button" title="Copy" className={`p-1 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/30 hover:text-black/60 hover:bg-black/5"}`} onClick={() => { void navigator.clipboard.writeText(msg.aiResponse || ""); setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId((cur) => cur === msg.id ? null : cur), 2000); }}>
                        {copiedMsgId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="p-2 pb-2">
            <div className="glass-control rounded-2xl px-2 py-1.5 w-full">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={handleOpenAttachments} className="h-8 w-8 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 shrink-0" title="Add attachments">
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {isDictating || isTranscribing ? (
                  <div className="w-full min-h-[32px] rounded-xl border border-blue-400/40 bg-blue-500/5 px-3 py-1.5 flex items-center gap-2">
                    {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-500 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60">Transcribing...</span></>)}
                  </div>
                ) : (
                  <textarea
                    ref={chatPanelInputRef}
                    data-min-h="32"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onPaste={handleChatPaste}
                    onInput={(e) => resizeChatInput(e.currentTarget)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                    placeholder="Ask me anything..."
                    rows={1}
                    className="w-full min-h-[32px] max-h-[220px] rounded-xl bg-white/12 border border-white/30 px-3 py-1.5 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                  />
                )}
                {isChatLoading ? (
                  <button type="button" onClick={handleStopAi} className="h-8 w-8 rounded-full flex items-center justify-center transition-colors bg-red-500/15 hover:bg-red-500/25" title="Stop generating">
                    <Square className="w-3 h-3 text-red-500" fill="currentColor" />
                  </button>
                ) : (
                  <button type="button" onClick={handleDictateToggle} className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${isDictating ? "bg-blue-500/15" : "hover:bg-black/10"}`} title={isDictating ? "Stop recording" : "Dictate"}>
                    <Mic className={`w-3.5 h-3.5 ${isDictating ? "text-blue-500" : ""}`} />
                  </button>
                )}
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
            <div className="fixed top-[4.2rem] bottom-0 z-[66] w-[13.75rem] overflow-y-auto scrollbar-hide p-3 space-y-2 bg-white/20 backdrop-blur-sm border-r border-black/5 transition-all duration-300" style={{ left: "var(--sidebar-offset, 0px)" }}>
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
                      <>
                        <div className="glass-text-card relative rounded-lg p-2.5 min-h-[3rem]">
                          {item.isAi && <div className="pointer-events-none absolute inset-0 rounded-lg" style={{ background: "rgba(0,0,0,0.035)" }} />}
                          <p className="relative text-[0.6875rem] leading-relaxed text-black/80 whitespace-pre-wrap break-words" style={{ display: "-webkit-box", WebkitLineClamp: 8, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.content || ""}</p>
                        </div>
                        <div className="px-1.5 py-1">
                          <span className="text-[9px] text-black/50 leading-tight line-clamp-1 break-all">{item.isAi ? "AI Response" : item.name}</span>
                        </div>
                      </>
                    ) : (
                      <div className="aspect-square flex items-center justify-center bg-white/30">
                        <Link2 className="w-5 h-5 text-black/40" />
                      </div>
                    )}
                    {item.type !== "note" && (
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3">
                        <span className="text-[9px] text-white leading-tight line-clamp-2 break-all">{item.name}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {chatMessages.length === 0 ? (
            /* Empty state: identical to the canvas first-render welcome */
            <div
              className={`fixed top-0 bottom-0 right-0 z-[65] flex items-center justify-center px-4 transition-all duration-300 ${canvasFileBlocks.length > 0 ? "pl-[232px]" : ""}`}
              style={{ left: "var(--sidebar-offset, 0px)" }}
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
                    {isDictating || isTranscribing ? (
                      <div className="w-full min-h-[44px] rounded-xl border border-blue-400/40 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
                        {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-sm text-blue-500 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 16, height: 16 }} /><span className="text-sm text-black/60">Transcribing...</span></>)}
                      </div>
                    ) : (
                      <textarea
                        ref={chatPanelInputRef}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onPaste={handleChatPaste}
                        onInput={(e) => resizeChatInput(e.currentTarget)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                        placeholder="Ask me anything..."
                        rows={1}
                        className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                      />
                    )}
                    {isChatLoading ? (
                      <button type="button" onClick={handleStopAi} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors bg-red-500/15 hover:bg-red-500/25" title="Stop generating">
                        <Square className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                      </button>
                    ) : (
                      <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${isDictating ? "bg-blue-500/15" : "hover:bg-black/10"}`} title={isDictating ? "Stop recording" : "Dictate"}>
                        <Mic className={`w-4 h-4 ${isDictating ? "text-blue-500" : ""}`} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Active conversation: messages scrollable, input pinned to bottom */
            <div
              className="fixed top-[4.2rem] bottom-0 right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300"
              style={{ left: canvasFileBlocks.length > 0 ? `calc(220px + var(--sidebar-offset, 0px))` : "var(--sidebar-offset, 0px)" }}
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
                              const attUrl = att.url || "";
                              const attKey = att.videoId || attUrl;
                              const isSaved = att.videoId ? savedYouTubeIds.has(att.videoId) : savedMediaUrls.has(attUrl);
                              const saveBtn = attKey ? (
                                <button type="button" className={`mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/60 backdrop-blur-md text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={isSaved} onClick={() => { if (att.videoId) { void saveYouTubeToMedia(att.videoId, attUrl); setSavedYouTubeIds((p) => new Set(p).add(att.videoId!)); } else { void saveAttachmentToMedia(attUrl, att.name || "File", at === "image" ? "image" : at === "video" ? "video" : at === "audio" ? "audio" : "file"); setSavedMediaUrls((p) => new Set(p).add(attUrl)); } }}>
                                  {isSaved ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                                </button>
                              ) : null;
                              if (at === "youtube" && att.videoId) {
                                return (
                                  <div key={att.id}>
                                    <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm">
                                      <iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} />
                                    </div>
                                    {saveBtn}
                                  </div>
                                );
                              }
                              if (at === "image" && att.url) {
                                return <div key={att.id}><img src={att.url} alt={att.name || "Image"} className="max-w-[16.25rem] max-h-[200px] rounded-xl border border-white/30 object-cover shadow-sm" />{saveBtn}</div>;
                              }
                              if (at === "video" && att.url) {
                                return (
                                  <div key={att.id}>
                                    <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm"><video src={att.url} controls className="w-full" preload="metadata" /></div>
                                    {saveBtn}
                                  </div>
                                );
                              }
                              if (at === "audio" && att.url) {
                                return (
                                  <div key={att.id}>
                                    <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><Music className="w-4 h-4 opacity-60" /><audio src={att.url} controls className="h-8" preload="metadata" /><span className="text-[0.625rem] truncate max-w-[7.5rem]">{att.name || "Audio"}</span></div>
                                    {saveBtn}
                                  </div>
                                );
                              }
                              if (at === "pdf") {
                                return (
                                  <div key={att.id}>
                                    <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><FileText className="w-4 h-4 opacity-60" /><span className="text-xs truncate max-w-[12.5rem]">{att.name || "PDF"}</span></div>
                                    {saveBtn}
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
                                <div key={att.id}>
                                  <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><FileText className="w-4 h-4 opacity-60" /><span className="text-xs truncate max-w-[12.5rem]">{att.name || att.url || "File"}</span></div>
                                  {saveBtn}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-black/90 border border-white/55 bg-[linear-gradient(135deg,rgba(255,255,255,0.32),rgba(255,255,255,0.16))] backdrop-blur-xl shadow-[0_10px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.35)] [&_table]:my-2 [&_td]:px-2 [&_th]:px-2">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>{normalizeChecklistSyntax(msg.content || "")}</ReactMarkdown>
                        </div>
                      </div>
                    )}
                    {msg.role === "user" && msg.aiResponse && (
                      <div className="flex justify-start group/aifocused">
                        <div className="max-w-[80%]">
                          {(msg as any).aiImageUrl ? (
                            <div className="px-4 py-3">
                              <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-xl shadow-lg" style={{ maxHeight: "320px" }} />
                              <button type="button" className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/60 backdrop-blur-md text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={() => { void saveAiImageToMedia((msg as any).aiImageUrl, msg.content); setSavedMediaUrls((p) => new Set(p).add((msg as any).aiImageUrl)); }}>
                                {savedMediaUrls.has((msg as any).aiImageUrl) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                              </button>
                            </div>
                          ) : (msg as any).aiVideoUrl ? (
                            <div className="px-4 py-3">
                              <video src={(msg as any).aiVideoUrl} controls preload="metadata" className="max-w-full rounded-xl shadow-lg" style={{ maxHeight: "320px" }} />
                              <button type="button" className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedMediaUrls.has((msg as any).aiVideoUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/60 backdrop-blur-md text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={savedMediaUrls.has((msg as any).aiVideoUrl)} onClick={() => { void saveAiVideoToMedia((msg as any).aiVideoUrl, msg.content); setSavedMediaUrls((p) => new Set(p).add((msg as any).aiVideoUrl)); }}>
                                {savedMediaUrls.has((msg as any).aiVideoUrl) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                              </button>
                            </div>
                          ) : (() => {
                            const chunks = splitResponseIntoChunks(msg.aiResponse || "");
                            const isSingle = chunks.length <= 1;
                            return (
                              <div className="px-4 py-3 space-y-2">
                                {chunks.map((chunk, ci) => (
                                  <div key={`${msg.id}-fchunk-${ci}`} className="group/fchunk relative">
                                    <div
                                      draggable
                                      onDragStart={(e) => {
                                        const sel = window.getSelection()?.toString()?.trim();
                                        const text = sel || chunk;
                                        e.dataTransfer.effectAllowed = "copy";
                                        e.dataTransfer.setData("application/x-omnia-chat-response", text);
                                        e.dataTransfer.setData("text/plain", text);
                                        try {
                                          const ghost = document.createElement("div");
                                          ghost.textContent = text.length > 80 ? text.slice(0, 77) + "…" : text;
                                          ghost.style.cssText = "position:fixed;top:-9999px;padding:8px 12px;border-radius:10px;background:rgba(59,130,246,0.15);font-size:12px;max-width:260px;overflow:hidden;white-space:nowrap";
                                          document.body.appendChild(ghost);
                                          e.dataTransfer.setDragImage(ghost, 0, 0);
                                          requestAnimationFrame(() => ghost.remove());
                                        } catch {}
                                      }}
                                      className={`text-sm leading-relaxed break-words text-black/85 cursor-grab active:cursor-grabbing transition-all rounded-xl ${isSingle ? "" : "px-3 py-2 hover:bg-white/40 hover:ring-1 hover:ring-blue-400/20"}`}
                                    >
                                      <div className={`absolute -left-6 top-1/2 -translate-y-1/2 opacity-0 group-hover/fchunk:opacity-100 transition-opacity ${isSingle ? "hidden" : ""}`}>
                                        <GripVertical className="w-3.5 h-3.5 text-blue-400/60" />
                                      </div>
                                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                                        {normalizeChecklistSyntax(chunk)}
                                      </ReactMarkdown>
                                    </div>
                                    {!isSingle && (
                                      <button
                                        type="button"
                                        title="Add this section to grid"
                                        className="absolute -right-2 top-1 opacity-0 group-hover/fchunk:opacity-100 transition-opacity p-1 rounded-md text-blue-400/70 hover:text-blue-500 hover:bg-blue-500/10"
                                        onClick={() => addChatResponseToGrid(chunk)}
                                      >
                                        <LayoutGrid className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                          {(msg as any).aiYouTubeUrls && (msg as any).aiYouTubeUrls.length > 0 && (
                            <div className="px-4 pb-3 space-y-3">
                              {(msg as any).aiYouTubeUrls.map((yt: { url: string; videoId: string }) => (
                                <div key={yt.videoId}>
                                  <div className="rounded-xl overflow-hidden border border-white/30 shadow-lg">
                                    <iframe
                                      src={`https://www.youtube-nocookie.com/embed/${yt.videoId}`}
                                      className="w-full aspect-video"
                                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                      allowFullScreen
                                      referrerPolicy="strict-origin-when-cross-origin"
                                      title={`YouTube ${yt.videoId}`}
                                    />
                                  </div>
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <button
                                      type="button"
                                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedYouTubeIds.has(yt.videoId) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/60 backdrop-blur-md text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`}
                                      disabled={savedYouTubeIds.has(yt.videoId)}
                                      onClick={() => {
                                        void saveYouTubeToMedia(yt.videoId, yt.url);
                                        setSavedYouTubeIds((prev) => new Set(prev).add(yt.videoId));
                                      }}
                                    >
                                      {savedYouTubeIds.has(yt.videoId) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                                    </button>
                                    <a href={yt.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-white/40 bg-white/60 backdrop-blur-md text-black/70 hover:border-black/30 hover:shadow-sm transition-all">
                                      <Play className="w-3 h-3" /> Open on YouTube
                                    </a>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                              {(msg as any).sources.map((src: { title: string; url: string }, i: number) => (
                                <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/40 dark:border-white/10 bg-white/60 dark:bg-white/5 backdrop-blur-md text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all">
                                  <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6h6m0 0v6m0-6L9.75 14.25" /></svg>
                                  <span className="truncate max-w-[10rem]">{src.title}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                              {(msg as any).aiWebLinks.map((link: string) => {
                                const isSaved = savedMediaUrls.has(link);
                                let domain = "";
                                try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                                return (
                                  <div key={link} className="inline-flex items-center gap-1 rounded-lg border border-white/40 bg-white/50 backdrop-blur-md px-2 py-1">
                                    <Globe className="w-3 h-3 text-black/40 flex-shrink-0" />
                                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-black/70 hover:text-black truncate max-w-[8rem]">{domain}</a>
                                    <button
                                      type="button"
                                      disabled={isSaved}
                                      className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                                      onClick={() => { void saveLinkToMedia(link); setSavedMediaUrls((p) => new Set(p).add(link)); }}
                                    >
                                      {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save</>}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                            <button type="button" title="Add to grid" className="p-1.5 rounded-md text-black/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                              <LayoutGrid className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { const text = msg.aiResponse || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void navigator.clipboard.writeText(text); } }}>
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Download" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { const text = msg.aiResponse || ""; const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "response.txt"; a.click(); URL.revokeObjectURL(url); }}>
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => { void navigator.clipboard.writeText(msg.aiResponse || ""); setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId((cur) => cur === msg.id ? null : cur), 2000); }}>
                              {copiedMsgId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                            <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { setChatMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, aiResponse: undefined, aiImageUrl: undefined, aiVideoUrl: undefined, sources: undefined } : m)); pendingAiBrickActionRef.current = true; setChatInput(msg.content); }}>
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            <div className="w-px h-3.5 bg-black/10 mx-1" />
                            <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => setChatReactions((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "like" ? null : "like" }))}>
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => setChatReactions((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "dislike" ? null : "dislike" }))}>
                              <ThumbsDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {msg.role !== "user" && (
                      <div className="flex justify-start">
                        <div className="max-w-[80%]">
                          <div className="px-4 py-3 text-sm leading-relaxed break-words text-black/85">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                              {normalizeChecklistSyntax(msg.content || "")}
                            </ReactMarkdown>
                          </div>
                          {Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                              {(msg as any).sources.map((src: { title: string; url: string }, i: number) => (
                                <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/40 dark:border-white/10 bg-white/60 dark:bg-white/5 backdrop-blur-md text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all">
                                  <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6h6m0 0v6m0-6L9.75 14.25" /></svg>
                                  <span className="truncate max-w-[10rem]">{src.title}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                              {(msg as any).aiWebLinks.map((link: string) => {
                                const isSaved = savedMediaUrls.has(link);
                                let domain = "";
                                try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                                return (
                                  <div key={link} className="inline-flex items-center gap-1 rounded-lg border border-white/40 bg-white/50 backdrop-blur-md px-2 py-1">
                                    <Globe className="w-3 h-3 text-black/40 flex-shrink-0" />
                                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-black/70 hover:text-black truncate max-w-[8rem]">{domain}</a>
                                    <button
                                      type="button"
                                      disabled={isSaved}
                                      className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                                      onClick={() => { void saveLinkToMedia(link); setSavedMediaUrls((p) => new Set(p).add(link)); }}
                                    >
                                      {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save</>}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                            <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { const text = (msg as any).content || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void navigator.clipboard.writeText(text); } }}>
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Download" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { const text = (msg as any).content || ""; const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "response.txt"; a.click(); URL.revokeObjectURL(url); }}>
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => { void navigator.clipboard.writeText((msg as any).content || ""); setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId((cur) => cur === msg.id ? null : cur), 2000); }}>
                              {copiedMsgId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                            <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 hover:text-black/70 hover:bg-black/5 transition-colors" onClick={() => { const prevUserMsg = chatMessages.slice(0, idx).reverse().find((m) => m.role === "user"); if (prevUserMsg) { setChatMessages((prev) => prev.filter((m) => m.id !== msg.id)); pendingAiBrickActionRef.current = true; setChatInput(prevUserMsg.content); } }}>
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            <div className="w-px h-3.5 bg-black/10 mx-1" />
                            <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => setChatReactions((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "like" ? null : "like" }))}>
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 hover:text-black/70 hover:bg-black/5"}`} onClick={() => setChatReactions((prev) => ({ ...prev, [msg.id]: prev[msg.id] === "dislike" ? null : "dislike" }))}>
                              <ThumbsDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                ))}
                {isChatLoading && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed border bg-white/80 border-white/70 text-black/60 backdrop-blur-md flex items-center gap-3">
                      <div className="brick-spinner" />
                      {thinkingStatus}
                    </div>
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
                    {isDictating || isTranscribing ? (
                      <div className="w-full min-h-[44px] rounded-xl border border-blue-400/40 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
                        {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-sm text-blue-500 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 16, height: 16 }} /><span className="text-sm text-black/60">Transcribing...</span></>)}
                      </div>
                    ) : (
                      <textarea
                        ref={chatPanelInputRef}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onPaste={handleChatPaste}
                        onInput={(e) => resizeChatInput(e.currentTarget)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
                        placeholder="Ask me anything..."
                        rows={1}
                        className="w-full min-h-[44px] max-h-[220px] rounded-xl bg-transparent border border-white/30 px-4 py-3 text-sm text-black placeholder:text-black/55 outline-none resize-none leading-5 scrollbar-hide"
                      />
                    )}
                    {isChatLoading ? (
                      <button type="button" onClick={handleStopAi} className="h-10 w-10 rounded-full flex items-center justify-center transition-colors bg-red-500/15 hover:bg-red-500/25" title="Stop generating">
                        <Square className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                      </button>
                    ) : (
                      <button type="button" onClick={handleDictateToggle} className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${isDictating ? "bg-blue-500/15" : "hover:bg-black/10"}`} title={isDictating ? "Stop recording" : "Dictate"}>
                        <Mic className={`w-4 h-4 ${isDictating ? "text-blue-500" : ""}`} />
                      </button>
                    )}
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
            accept="*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (!files.length) { e.target.value = ""; return; }
              if (chatMode) {
                for (const file of files) {
                  const mime = file.type || "";
                  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
                  const AUDIO_EXTS_LOCAL = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
                  const VIDEO_EXTS_LOCAL = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);
                  const isAudio = mime.startsWith("audio/") || AUDIO_EXTS_LOCAL.has(ext);
                  const isVideo = mime.startsWith("video/") || VIDEO_EXTS_LOCAL.has(ext);
                  if (isAudio || isVideo) {
                    addFocusedAttachment({
                      id: makeAttId(), type: isAudio ? "audio" : "video",
                      url: "", name: file.name, mime, size: file.size, rawFile: file,
                    });
                  } else if (DOCUMENT_EXTS.has(ext)) {
                    (async () => {
                      try {
                        const { extractTextFromFile } = await import("@/lib/extract-text");
                        const { API_BASE_URL } = await import("@/lib/api-config");
                        const result = await extractTextFromFile(file, API_BASE_URL);
                        addFocusedAttachment({
                          id: makeAttId(), type: "document", url: "", name: file.name, mime, size: file.size,
                          extractedText: result?.text || "",
                        });
                      } catch {
                        addFocusedAttachment({ id: makeAttId(), type: "document", url: "", name: file.name, mime, size: file.size });
                      }
                    })();
                  } else {
                    const reader = new FileReader();
                    reader.onload = () => {
                      const dataUrl = reader.result as string;
                      let type = "file";
                      if (mime.startsWith("image/")) type = "image";
                      else if (mime === "application/pdf" || ext === "pdf") type = "pdf";
                      addFocusedAttachment({ id: makeAttId(), type, url: dataUrl, name: file.name, mime, size: file.size });
                    };
                    reader.readAsDataURL(file);
                  }
                }
              } else {
                window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files } }));
              }
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

      {connectionCards.length > 0 && (
        <div
          className={`fixed right-6 z-[86] w-[22rem] rounded-2xl border border-blue-200/60 bg-white/95 backdrop-blur-lg shadow-2xl shadow-blue-500/10 p-4 text-black transition-all duration-300 ${
            showConnectionCard ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
          style={{ bottom: aiSuggestions.length > 0 && showAiSuggestionToast ? "calc(1.5rem + 12rem)" : "1.5rem" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-semibold text-blue-600">AI Connection Found</span>
            </div>
            <button
              type="button"
              onClick={() => setShowConnectionCard(false)}
              className="rounded-full w-5 h-5 flex items-center justify-center hover:bg-black/8 transition-colors"
            >
              <X className="w-3 h-3 text-black/40" />
            </button>
          </div>
          <ul className="space-y-2">
            {connectionCards.map((conn, i) => (
              <li
                key={`${conn.title}-${i}`}
                className="rounded-xl border border-blue-100 bg-white px-3 py-2.5 cursor-pointer hover:bg-blue-50/60 transition-colors"
                onClick={async () => {
                  if (conn.sourceType === "board") {
                    const cached = getCachedWorkspaceSummary()?.full || "";
                    const boardMatch = cached.match(new RegExp(`"${conn.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
                    const connBoardId = boardMatch?.[1];
                    if (connBoardId) {
                      try {
                        const { data } = await supabase
                          .from("omnia_board_states")
                          .select("state")
                          .eq("board_id", connBoardId)
                          .order("created_at", { ascending: false })
                          .limit(1)
                          .maybeSingle();
                        const snapshot = data?.state as any;
                        if (snapshot?.blocks && snapshot?.blockOrder) {
                          const st = useCanvasStore.getState();
                          const g = Math.max(1, Math.floor(st.gridSize || 24));
                          const existingIds = st.blockOrder || [];
                          let maxY = 0;
                          for (const eid of existingIds) {
                            const eb = (st.blocks || {})[eid] as any;
                            if (eb) maxY = Math.max(maxY, (eb.y || 0) + (eb.height || g));
                          }
                          const startY = maxY + g * 2;
                          const sourceBlocks = snapshot.blocks;
                          const sourceOrder: string[] = snapshot.blockOrder;
                          let minSourceY = Infinity;
                          for (const sid of sourceOrder) {
                            const sb = sourceBlocks[sid] as any;
                            if (sb) minSourceY = Math.min(minSourceY, sb.y || 0);
                          }
                          if (!isFinite(minSourceY)) minSourceY = 0;
                          for (const sid of sourceOrder) {
                            const sb = sourceBlocks[sid] as any;
                            if (!sb) continue;
                            const newId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                            const imported = { ...sb, id: newId, y: startY + ((sb.y || 0) - minSourceY) };
                            st.addBlock(imported as any);
                          }
                        }
                      } catch { /* ignore fetch errors */ }
                    }
                  } else {
                    savingRef.current = false;
                    saveSnapshot().then(() => nav("/memory"));
                  }
                  setShowConnectionCard(false);
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    conn.sourceType === "board"
                      ? "bg-blue-100 text-blue-600"
                      : "bg-green-100 text-green-600"
                  }`}>
                    {conn.sourceType}
                  </span>
                  <span className="text-xs font-medium text-black/80 truncate">{conn.title}</span>
                </div>
                <p className="text-[11px] text-black/55 leading-snug">{conn.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mediaSuggestions.length > 0 && (
        <div
          className={`fixed right-6 z-[87] w-[22rem] rounded-2xl border border-blue-200/60 bg-white/95 backdrop-blur-lg shadow-2xl shadow-blue-500/10 p-4 text-black transition-all duration-300 ${
            showMediaSuggestion ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
          style={{ bottom: showConnectionCard && connectionCards.length > 0 ? "calc(1.5rem + 14rem)" : aiSuggestions.length > 0 && showAiSuggestionToast ? "calc(1.5rem + 12rem)" : "1.5rem" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-semibold text-blue-600">Related Media Found</span>
            </div>
            <button
              type="button"
              onClick={() => { setShowMediaSuggestion(false); setMediaSuggestions([]); }}
              className="rounded-full w-5 h-5 flex items-center justify-center hover:bg-black/8 transition-colors"
            >
              <X className="w-3 h-3 text-black/40" />
            </button>
          </div>
          <p className="text-[11px] text-black/45 mb-2">Select media to import onto this board</p>
          <ul className="space-y-1.5 max-h-[200px] overflow-y-auto scrollbar-hide">
            {mediaSuggestions.map((item) => {
              const isSelected = selectedMediaIds.has(item.noteId);
              return (
                <li
                  key={item.noteId}
                  className={`rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                    isSelected
                      ? "border-blue-400 bg-blue-50/80"
                      : "border-blue-100 bg-white hover:bg-blue-50/40"
                  }`}
                  onClick={() => {
                    setSelectedMediaIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.noteId)) next.delete(item.noteId);
                      else next.add(item.noteId);
                      return next;
                    });
                  }}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected ? "bg-blue-500 border-blue-500" : "border-black/20 bg-white"
                    }`}>
                      {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                    </div>
                    <span className="text-xs font-medium text-black/80 truncate">{item.title}</span>
                  </div>
                  <p className="text-[11px] text-black/50 leading-snug pl-6">{item.reason}</p>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={selectedMediaIds.size === 0 || importingMedia}
            className="mt-3 w-full py-2 rounded-xl text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-500 text-white hover:bg-blue-600"
            onClick={async () => {
              if (selectedMediaIds.size === 0) return;
              setImportingMedia(true);
              try {
                const noteIds = [...selectedMediaIds];
                const { data: notes } = await supabase
                  .from("notes")
                  .select("id, title, content")
                  .in("id", noteIds);
                if (!notes || notes.length === 0) return;

                const parseNoteAtts = (content: string): any[] => {
                  const marker = "[ATTACHMENTS_JSON:";
                  const start = (content || "").indexOf(marker);
                  if (start === -1) return [];
                  const jsonStart = start + marker.length;
                  let bc = 0, jsonEnd = jsonStart;
                  for (let i = jsonStart; i < content.length; i++) {
                    if (content[i] === "[") bc++;
                    if (content[i] === "]") { bc--; if (bc === 0) { jsonEnd = i + 1; break; } }
                  }
                  if (jsonEnd <= jsonStart) return [];
                  try { return Array.isArray(JSON.parse(content.slice(jsonStart, jsonEnd))) ? JSON.parse(content.slice(jsonStart, jsonEnd)) : []; }
                  catch { return []; }
                };
                const resolveType = (att: any): string => {
                  const url = String(att?.url || "");
                  const name = String(att?.name || "");
                  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
                  const explicit = att?.type;
                  if (explicit && explicit !== "file") return explicit;
                  const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
                  const ext = extMatch ? extMatch[1].toLowerCase() : "";
                  if (["jpg","jpeg","png","gif","webp","svg","heic","heif"].includes(ext)) return "image";
                  if (["mp4","mov","webm"].includes(ext)) return "video";
                  if (["mp3","wav","ogg","m4a"].includes(ext)) return "audio";
                  if (ext === "pdf") return "pdf";
                  return url ? "link" : "text";
                };

                const st = useCanvasStore.getState() as any;
                const g = Math.max(1, Math.floor(st.gridSize || 24));
                const niVw = window.innerWidth || 1280;
                const niVh = window.innerHeight || 800;

                const niPos = (bw: number, bh: number) => {
                  const cur = useCanvasStore.getState() as any;
                  return findSmartPlacement({
                    blockW: bw,
                    blockH: bh,
                    gridSize: g,
                    camera: cur.camera || { x: 0, y: 0, zoom: 1 },
                    viewportW: niVw,
                    viewportH: niVh,
                    railWidth: 0,
                    existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[],
                  });
                };

                for (const note of notes) {
                  const atts = parseNoteAtts(note.content || "");
                  if (atts.length === 0) {
                    const ytMatch = (note.content || "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
                    if (ytMatch) {
                      const p = niPos(g * 12, g * 8);
                      st.addYouTubeBlockAt({ x: p.x, y: p.y }, { url: ytMatch[0], videoId: ytMatch[1] });
                    } else {
                      const p = niPos(g * 10, g * 4);
                      const blockId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                      st.addBlock({ id: blockId, type: "text" as const, x: p.x, y: p.y, width: g * 10, height: g * 4, content: (note.content || "").replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, "").trim(), format: "rich", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    }
                    continue;
                  }
                  for (const att of atts) {
                    const url = String(att.url || "").trim();
                    if (!url) continue;
                    const type = resolveType(att);
                    const blockId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                    if (type === "youtube") {
                      const vid = att.videoId || (url.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1] || "";
                      const p = niPos(g * 12, g * 8);
                      st.addYouTubeBlockAt({ x: p.x, y: p.y }, { url, videoId: vid });
                    } else if (type === "image") {
                      const p = niPos(g * 12, g * 12);
                      st.addBlock({ id: blockId, type: "create" as const, mode: "image", x: p.x, y: p.y, width: g * 12, height: g * 12, data: { src: url, name: att.name || "Image" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    } else if (type === "video") {
                      const p = niPos(g * 16, g * 10);
                      st.addBlock({ id: blockId, type: "create" as const, mode: "video", x: p.x, y: p.y, width: g * 16, height: g * 10, data: { url, mime: att.mime || "video/mp4", name: att.name || "Video" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    } else if (type === "audio") {
                      const p = niPos(g * 14, g * 4);
                      st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 14, height: g * 4, data: { url, mime: att.mime || "audio/mpeg", name: att.name || "Audio", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    } else if (type === "pdf") {
                      const p = niPos(g * 16, g * 14);
                      st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 16, height: g * 14, data: { url, mime: "application/pdf", name: att.name || "PDF", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    } else {
                      const p = niPos(g * 14, g * 6);
                      st.addBlock({ id: blockId, type: "create" as const, mode: "embed", x: p.x, y: p.y, width: g * 14, height: g * 6, data: { url, name: att.name || note.title || "File", dataUrl: url }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
                    }
                  }
                }
              } catch { /* ignore */ }
              finally {
                setImportingMedia(false);
                setShowMediaSuggestion(false);
                setMediaSuggestions([]);
              }
            }}
          >
            {importingMedia ? "Importing…" : `Import ${selectedMediaIds.size > 0 ? selectedMediaIds.size : ""} Selected`}
          </button>
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

