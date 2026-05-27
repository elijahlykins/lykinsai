import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  hasPrototypeNeurons,
  PROTO_GRID_INTRO_SS_KEY,
  readPrototypeStep,
  writePrototypeStep,
} from "@/lib/prototypeHandoff";
import { Canvas } from "@/canvas/Canvas";
import { useCanvasStore } from "@/store/canvasStore";
import type { Block } from "@/canvas/types";
import { ChevronDown, ChevronUp, ChevronRight, Plus, Link as LinkIcon, Image as ImageIcon, MessageSquare, Mic, BookOpen, X, Clock, Edit2, Folder as FolderIcon, Link2, MoreHorizontal, PanelRightClose, PanelRight, StickyNote, Play, FileText, Music, Video, Share2, Download, Copy, Check, RefreshCw, ThumbsUp, ThumbsDown, Square, Sparkles, Save, Globe, GripVertical, ArrowUp } from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import ModelSelectOptions from "@/components/ModelSelectOptions";
import { toast } from "@/components/ui/use-toast";
import { useUserPlan } from "@/lib/useUserPlan";
import { isModelAllowedForPlan, defaultModelForTier } from "@/lib/modelTiers";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { supabase } from "@/lib/supabase";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import RichTextRenderer from "@/components/notes/RichTextRenderer";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";
import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import { createDatabaseBlockData } from "@/canvas/blockSystem/notionModel";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import { detectSocialPlatform, isSocialEmbedType } from "@/canvas/utils/socialEmbed";
import { promptFileDropMode } from "@/lib/fileDropModePrompt";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { getAiPrefs } from "@/lib/ai-prefs";
import { buildTieredCanvasContext, buildActionCanvasContext } from "@/lib/ai/buildCanvasContext";
import { getVaultSidebarWidth, useIsTouchOnlyDevice, getIsTouchOnlyDevice } from "@/hooks/useViewportTier";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { fetchNotesForVaultAi, buildVaultDetailForGridAi, type VaultAiNoteRow } from "@/lib/vault/vaultContentsForAi";
import { CONTEXT_BUDGETS } from "@/lib/ai/promptBuilder";
import NotesPanel from "@/components/notes/NotesPanel";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { snapshotToSynthesisText } from "@/lib/synthesis/sourceText";
import { fetchLoadInUpdatesMessage } from "@/lib/synthesis/loadInUpdates";
import { useProjectFiles } from "@/hooks/useProjectFiles";
import OmniaToolbar from "@/components/omnia/OmniaToolbar";
import OmniaCenterWelcome from "@/components/omnia/OmniaCenterWelcome";
import OmniaToasts from "@/components/omnia/OmniaToasts";
import OmniaVaultOverlay from "@/components/omnia/OmniaVaultOverlay";
import FileDropModeDialog from "@/components/omnia/FileDropModeDialog";
import OmniaSideRail from "@/components/omnia/OmniaSideRail";
import OmniaFocusedChat from "@/components/omnia/OmniaFocusedChat";
import VaultAppDock from "@/components/connections/VaultAppDock";
import LoadInBriefingPanel from "@/components/omnia/LoadInBriefingPanel";
import MobileFocusedChatGrids from "@/components/omnia/MobileFocusedChatGrids";
import GridShareDialog from "@/components/omnia/GridShareDialog";
import { useBoardPersistence, makeDefaultNotesPages } from "@/hooks/useBoardPersistence";
import { useChatEngine } from "@/hooks/useChatEngine";

// Feature flag — the LYKN Grid canvas surface is temporarily unplugged.
// Keep this `true` to make the focused chat the main interface across `/app`,
// `/grid/:boardId`, and `/omnia`. Flip back to `false` to re-enable the
// canvas + mode-toggle UX without any other code changes. All grid logic,
// state, and components remain wired up — they just never become visible
// while this flag is on.
const GRID_DISABLED = true;

// Module-level "first mount of this page load" sentinel — reset on
// every hard page load (since the JS module re-evaluates) and flipped
// to false the first time OmniaGrid mounts. We use it to decide
// whether to bounce a `/grid/<id>` URL back to `/app` so the load-in
// greeting trigger can mint a fresh chat with the latest updates.
// Without this, reloading the tab while parked at `/grid/<id>` would
// leave the user staring at the same stale conversation forever —
// the trigger only fires when `routeBoardId` is absent (i.e. on
// `/app`), so the URL needs to drop back there to re-arm it.
let omniaGridDidConsumeFirstLoad = false;

const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;

function tiptapJsonToPlainText(node: any): string {
  if (!node || typeof node !== "object") return "";
  let text = "";
  if (node.type === "text") return node.text || "";
  if (node.type === "youtube" && node.attrs?.src) return `\n[YouTube: ${node.attrs.src}]\n`;
  if (node.type === "webEmbed" && node.attrs?.src) return `\n[Embedded link: ${node.attrs.src}]\n`;
  if (node.type === "image" && node.attrs?.src) return `\n[Image: ${node.attrs.alt || ""} ${node.attrs.src}]\n`;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      text += tiptapJsonToPlainText(child);
    }
  }
  const block = node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "taskItem" || node.type === "blockquote";
  if (block) text += "\n";
  return text;
}

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
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
  kind?: "prompt" | "load-in-greeting";
  attachments?: FocusedChatAttachment[];
  // Action buttons rendered below the assistant bubble. Populated only
  // by the load-in greeting today. Optional / ignored otherwise.
  aiResponseActions?: Array<{
    label: string;
    href: string;
    description?: string;
    tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    /** Optional brand-mark URL for "Connect <Platform>" prompts. */
    iconUrl?: string;
  }>;
  // Structured sections for the load-in greeting: heading per topic,
  // each row carrying its own inline CTA button. When present the
  // renderer prefers this over the flat `aiResponseActions` strip.
  aiResponseSections?: Array<{
    id: string;
    heading: string;
    intro?: string;
    items: Array<{
      title: string;
      subtitle?: string;
      iconUrl?: string;
      action?: {
        label: string;
        href: string;
        description?: string;
        tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
        iconUrl?: string;
      };
    }>;
    summary?: string;
    groups?: Array<{
      id: string;
      label: string;
      iconUrl?: string;
      domain?: string;
      count: number;
      latestTitle?: string;
      latestRelative?: string;
      items: Array<{
        id: string;
        title: string;
        subtitle?: string;
        href?: string;
      }>;
    }>;
    chips?: Array<{
      id: string;
      label: string;
      iconUrl: string;
      href: string;
      tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    }>;
    /**
     * When present, identifies this section as user-authored (a row in
     * `lykn_load_in_user_sections`). The chat renderer attaches inline
     * edit / delete affordances to sections that carry this id.
     */
    userSectionId?: string;
  }>;
  /**
   * Roll-up counts + 7-day activity series for the at-a-glance
   * dashboard panel rendered next to the load-in greeting. Pulled
   * verbatim from `LoadInUpdatesPayload.stats`. Optional so the
   * field is harmless for non-greeting turns.
   */
  aiResponseStats?: import("@/lib/synthesis/loadInUpdates").LoadInUpdatesStats;
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
  | { type: "update_notes"; content: string | object }
  | { type: "append_notes"; content: string | object }
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
  vaultTitle?: string;
  vaultContent?: string;
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
  vaultTitle?: string;
  vaultContent?: string;
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


/** Shared model list for top panel and chat-bar selectors. Thin wrapper
 * around the canonical `<ModelSelectOptions>` so existing call sites that
 * pass a JSX node prop don't need to import the shared component directly.
 *
 * `modelTier` gates which models are selectable:
 *   - "basic"     (Free / guest)   → only non-thinking fast models
 *   - "top"       (Studio)          → all text LLMs, no media gen
 *   - "top+media" (Studio Pro/Max) → everything
 * Locked models are shown greyed out with a lock badge so users can see the
 * upgrade path instead of hiding the tier entirely.
 */
function OmniaGridModelSelectMenuBody({ modelTier = "basic" }: { modelTier?: string }) {
  return <ModelSelectOptions modelTier={modelTier} />;
}

const OmniaChatBarToolbar = React.memo(function OmniaChatBarToolbar({
  compact, onSend, chatInputHasText, isChatLoading, isDictating, isTranscribing,
  selectedModel, persistSelectedModel, modelTier,
  handleOpenAttachments, handleStopAi, handleDictateToggle,
}: {
  compact?: boolean;
  onSend: () => void | Promise<void>;
  chatInputHasText: boolean;
  isChatLoading: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  selectedModel: string;
  persistSelectedModel: (v: string) => void;
  modelTier?: string;
  handleOpenAttachments: () => void;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
}) {
  const sendDisabled = !chatInputHasText || isChatLoading || isDictating || isTranscribing;
  const modelTriggerCls = compact
    ? "omnia-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden [&>span]:truncate [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0"
    : "omnia-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";
  const dropdownCls = "glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md";

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      <Select value={selectedModel} onValueChange={persistSelectedModel}>
        <SelectTrigger className={modelTriggerCls}>
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent
          side="top"
          align="start"
          className={`${dropdownCls} max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]`}
        >
          <OmniaGridModelSelectMenuBody modelTier={modelTier} />
        </SelectContent>
      </Select>
      <div className="flex-1 min-w-[4px]" aria-hidden />
      <button
        type="button"
        onClick={handleOpenAttachments}
        className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0`}
        title="Add attachments"
      >
        <Plus className={iconSm} />
      </button>
      {isChatLoading ? (
        <button
          type="button"
          onClick={handleStopAi}
          className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center shrink-0`}
          title="Stop generating"
        >
          <Square className={`${compact ? "w-2.5 h-2.5" : "w-3 h-3"} text-red-600 dark:text-red-400`} fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center shrink-0 ${isDictating ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
          title={isDictating ? "Stop recording" : "Dictate"}
        >
          <Mic className={`${iconSm} text-black/75 dark:text-white/80 ${isDictating ? "text-blue-600 dark:text-blue-400" : ""}`} />
        </button>
      )}
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendDisabled}
        className={`${iconBtn} omnia-neu-chat-send-btn flex items-center justify-center shrink-0 ${sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`}
        title="Send"
      >
        <ArrowUp className={iconSm} strokeWidth={2.25} />
      </button>
    </div>
  );
});

export default function OmniaGridPage() {
  const nav = useNavigate();
  const location = useLocation();
  const { boardId: routeBoardId } = useParams<{ boardId?: string }>();
  const { user, signInWithOAuth } = useAuth();

  // (Removed: an old effect here used to auto-write `step="done"` on
  // mount of `/app`, which was the final beat of the walkthrough back
  // when /app was the literal end of the tour. Now the chat card's
  // Finish button is the authoritative "done" signal — auto-writing
  // on mount silently released the walkthrough lock the moment the
  // visitor arrived, unmounted the chrome guard, and made the chat
  // intro card's gate flip from "step === grid" → "step === done"
  // before the chat-intro effect could even read it. The Finish
  // button at the bottom of the card now handles the transition.)

  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const requireSignIn = useCallback((what: string = "save your work") => {
    try {
      toast({
        title: "Sign in to continue",
        description: `You need an account to ${what} — it's free.`,
        action: (
          <button
            type="button"
            onClick={() => nav("/login")}
            className="inline-flex items-center rounded-md bg-white text-black text-[12px] font-semibold px-3 py-1.5 hover:bg-white/90"
          >
            Sign in
          </button>
        ),
      });
    } catch { /* toast unavailable — non-critical */ }
  }, [nav]);
  const { checkVaultLimit, incrementVaultCount, upgradeModal, dismissUpgradeModal, limits: planLimits } = useUsageGate();
  const setBlockLimit = useCanvasStore((s) => s.setBlockLimit);
  // Push the plan's blocks-per-grid cap into the store so every addBlock
  // call path (drag-drop, paste, AI actions, toolbars, etc.) gets gated for
  // free.
  useEffect(() => {
    const raw = planLimits?.blocksPerGrid;
    const cap = raw == null || !isFinite(raw) ? null : raw;
    setBlockLimit(cap);
    // Don't clear on unmount — the store is module-scoped and the next mount
    // will set it again from the latest plan.
  }, [planLimits?.blocksPerGrid, setBlockLimit]);
  const blockCount = useCanvasStore((s) => s.blockOrder.length);
  const blockUrlSignature = useCanvasStore((s) =>
    s.blockOrder.map((id) => {
      const b = s.blocks[id] as any;
      if (!b) return "";
      return (b.src || "") + (b.url || "") + (b.data?.src || "") + (b.data?.url || "");
    }).join("\n")
  );
  const addTextBlockAt = useCanvasStore((s) => s.addTextBlockAt);
  const addListBlockAt = useCanvasStore((s) => s.addListBlockAt);
  const setListItems = useCanvasStore((s) => s.setListItems);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const undo = useCanvasStore((s) => s.undo);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const loadBlocks = useCanvasStore((s) => s.loadBlocks);
  const reset = useCanvasStore((s) => s.reset);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  // Collapse the top panel on every chat page load / switch. React-Router
  // reuses the same OmniaGrid instance when navigating between `/grid/:id`
  // boards, so without this effect a panel the user opened on one chat
  // would stay open when they jumped to another.
  useEffect(() => {
    setTopPanelOpen(false);
  }, [routeBoardId]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showVaultSidebar, setShowVaultSidebar] = useState(false);
  const [vaultDragActive, setVaultDragActive] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 1280);
  const [chatRailWidthManual, setChatRailWidthManual] = useState<number | null>(null);
  // We only flip into the phone/compact shells on actual touch-only devices.
  // A laptop or desktop in split-screen / narrow-window mode keeps the full
  // desktop UI even when the viewport drops under our width thresholds —
  // otherwise users were getting bumped into the phone-only chat shell just
  // by snapping a window to half the screen.
  const isTouchOnlyDevice = useIsTouchOnlyDevice();
  const isMobileGrid = viewportWidth < 640 && isTouchOnlyDevice;
  // Phone-class viewport: hide the grid canvas entirely and run chat-only.
  const isMobilePhone = viewportWidth < 768 && isTouchOnlyDevice;
  const vaultSidebarWidthPx = useMemo(() => getVaultSidebarWidth(viewportWidth), [viewportWidth]);
  const DialogAny = Dialog as any;
  const DialogContentAny = DialogContent as any;
  const DialogHeaderAny = DialogHeader as any;
  const DialogTitleAny = DialogTitle as any;
  const DialogDescriptionAny = DialogDescription as any;
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
    return "lykn-lite";
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
  const persistSelectedModel = useCallback((value: string) => {
    // Refuse to persist a model the current plan can't use. Radix will already
    // prevent selection of disabled items, but this guards against stale saved
    // preferences and any programmatic callers.
    if (!isModelAllowedForPlan(value, modelTier)) {
      toast({
        title: "Upgrade required",
        description: "That model isn't available on your current plan.",
        action: (
          <button
            type="button"
            onClick={() => nav(isGuest ? "/login" : "/billing")}
            className="inline-flex items-center rounded-md bg-white text-black text-[12px] font-semibold px-3 py-1.5 hover:bg-white/90"
          >
            {isGuest ? "Sign in" : "Upgrade"}
          </button>
        ),
      });
      return;
    }
    setSelectedModel(value);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {
      /* ignore */
    }
  }, [modelTier, nav, isGuest]);

  // Auto-downgrade the saved model once the plan resolves. Keeps behaviour
  // deterministic for users who had a premium model picked before downgrading.
  useEffect(() => {
    if (planLoading) return;
    if (isModelAllowedForPlan(selectedModel, modelTier)) return;
    const fallback = defaultModelForTier(modelTier);
    setSelectedModel(fallback);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = fallback;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [modelTier, planLoading, selectedModel]);

  // Allow callers (e.g. the Skills page) to deep-link directly into the
  // grid in chat-focused mode by appending `?chat=1` to the URL. We read
  // the flag once on mount, then strip it from the URL so it doesn't
  // linger across reloads or shares.
  // Phones default to chat-only (no canvas) regardless of the URL flag.
  // Note: we require an actual touch-only device here so that a laptop in
  // split-screen mode (narrow viewport, but still mouse + hover) doesn't
  // start up in the phone shell.
  const [chatMode, setChatMode] = useState(() => {
    // Grid is unplugged — focused chat is the only experience.
    if (GRID_DISABLED) return true;
    if (typeof window === "undefined") return false;
    if ((window.innerWidth || 1280) < 768 && getIsTouchOnlyDevice()) return true;
    const params = new URLSearchParams(window.location.search);
    return params.get("chat") === "1";
  });

  // Force chat mode on whenever the viewport drops to phone size (e.g. user
  // rotates a tablet, or resizes the browser). This is the safety net so the
  // canvas can never be exposed on a phone.
  useEffect(() => {
    if (isMobilePhone && !chatMode) setChatMode(true);
  }, [isMobilePhone, chatMode]);
  useEffect(() => {
    if (!location.search) return;
    const params = new URLSearchParams(location.search);
    if (params.has("chat")) {
      params.delete("chat");
      const cleaned = params.toString();
      nav(
        { pathname: location.pathname, search: cleaned ? `?${cleaned}` : "" },
        { replace: true }
      );
    }
    // Only run on initial mount; later URL changes are handled elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [notesOpen, setNotesOpenRaw] = useState(false);
  const [notesGridFilesHidden, setNotesGridFilesHidden] = useState(false);
  const setNotesOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setNotesOpenRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next && !prev) setNotesGridFilesHidden(false);
      return next;
    });
  }, []);
  const defaultPages = useRef(makeDefaultNotesPages()).current;
  const notesPagesRef = useRef(defaultPages);
  const [notesPages, setNotesPages] = useState(defaultPages);
  const [activeNotePageId, setActiveNotePageId] = useState(defaultPages[0].id);
  const handleNotesPagesChange = useCallback((pages: typeof defaultPages) => {
    notesPagesRef.current = pages;
    setNotesPages(pages);
  }, []);
  const [chatRailOpen, setChatRailOpen] = useState(false);
  const [chatRailVisible, setChatRailVisible] = useState(false);
  const [centerChatLeaving, setCenterChatLeaving] = useState(false);
  const [savedYouTubeIds, setSavedYouTubeIds] = useState<Set<string>>(new Set());
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set());
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const chatImportAppliedRef = useRef<string | null>(null);

  /* Shared chat state (lifted here so both useBoardPersistence and useChatEngine can use them) */
  const [chatMessages, setChatMessages] = useState<PromptMessage[]>([]);
  const chatMessagesRef = useRef<PromptMessage[]>([]);
  const aiThreadRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const convoSummaryRef = useRef<string>("");
  const convoTurnsSinceSummaryRef = useRef(0);
  const [typedWelcome, setTypedWelcome] = useState("");
  const [showAiSuggestionToast, setShowAiSuggestionToast] = useState(false);
  const lastSuggestionKeyRef = useRef<string>("");
  const [connectionCards, setConnectionCards] = useState<Array<{ title: string; sourceType: "board" | "media"; reason: string }>>([]);
  const [showConnectionCard, setShowConnectionCard] = useState(false);
  const [mediaSuggestions, setMediaSuggestions] = useState<Array<{ title: string; reason: string; noteId: string }>>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [showMediaSuggestion, setShowMediaSuggestion] = useState(false);
  const [importingMedia, setImportingMedia] = useState(false);

  // Final beat of the landing-prototype guided tour: after the typed
  // "what is the grid" intro finishes, we *arm* the sign-in wall. The
  // next click anywhere on the canvas surface (or the next chat send)
  // will surface the prompt so the user can save what they've made
  // (their first neuron, first conversation, first grid). The wall is
  // sticky — dismissing it re-arms instead of going away — so guests
  // can't trivially keep poking around the empty grid for free.
  const [prototypeSignInArmed, setPrototypeSignInArmed] = useState(false);
  const [prototypeSignInOpen, setPrototypeSignInOpen] = useState(false);
  // `triggered` flips true the very first time we open the modal and
  // never flips back. We use it to gate the chat send path so any
  // attempt to keep chatting after the tour also funnels through the
  // wall, not just clicking on the canvas.
  const [prototypeSignInTriggered, setPrototypeSignInTriggered] = useState(false);
  const [prototypeSignInEmail, setPrototypeSignInEmail] = useState("");

  // Chat walkthrough card (final beat of the guided tour). Mirrors the
  // synthesis-layer / vault / connections welcome cards: typewriter
  // text + a "Finish" button at the bottom. The button closes the
  // card, marks the walkthrough done, and arms the sign-in wall so
  // the next interaction with the chat surface funnels the visitor
  // into creating an account.
  const [chatIntroShown, setChatIntroShown] = useState(false);
  const [chatIntroText, setChatIntroText] = useState("");
  const [chatIntroDone, setChatIntroDone] = useState(false);
  const typingCancelRef = useRef(false);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Landing-prototype handoff (final beat): on first load of the chat
  // surface (`/app`) for a guest who came through the walkthrough,
  // open the chat rail and have LYKN type out a short orientation
  // message about what this surface is. With the canvas unplugged
  // (GRID_DISABLED), `/app` is just the chat — every conversation
  // routes through the synthesis layer + connections we set up in
  // the prior beats. Only fires once per session; LandingPrototype
  // clears the flag whenever a brand-new walkthrough kicks off so a
  // fresh first neuron re-arms it.
  useEffect(() => {
    if (user?.id) return;
    if (routeBoardId) return; // only on /app, not on a specific /grid/<id>
    // Two-stage gate:
    //   1. If the walkthrough step is "grid" (Connections' advance arrow
    //      just bumped us here), ALWAYS show the card. This is the
    //      authoritative signal that the visitor is mid-walkthrough,
    //      regardless of any stale sessionStorage state. Without this
    //      override, a visitor who already hit Finish earlier in the
    //      session (then refreshed back to landing → restarted the
    //      tour) would silently skip the chat card because the
    //      session-scoped stamp was still set.
    //   2. Otherwise (no walkthrough running — e.g. a guest who came
    //      straight to /app without going through the tour), fall
    //      back to the sessionStorage one-shot so we don't spam them
    //      with the card on every /app load.
    // The Finish button stamps `PROTO_GRID_INTRO_SS_KEY` only on
    // explicit click; refreshes mid-typing replay from the top.
    const stepNow = readPrototypeStep();
    if (stepNow !== "grid") {
      let alreadyFinished = false;
      try {
        alreadyFinished = sessionStorage.getItem(PROTO_GRID_INTRO_SS_KEY) === "1";
      } catch {
        // private mode etc.
      }
      if (alreadyFinished) return;
    } else {
      // Walkthrough is live: clear any stale stamp so future replays
      // (i.e. visitor restarts the tour from the landing page) get
      // the card again without needing to close the tab.
      try {
        sessionStorage.removeItem(PROTO_GRID_INTRO_SS_KEY);
      } catch {
        // private mode etc.
      }
    }

    // Final beat of the walkthrough: orientation card matched to the
    // synthesis-layer / vault / connections cards (same dark glass,
    // same right-edge pinning, same typewriter cadence). The earlier
    // iteration injected a fake "What's chat for?" prompt + typed
    // assistant response directly into the chat rail. The fake
    // exchange read like LYKN talking to itself before the visitor
    // ever sent a message, which set up the wrong mental model for
    // the surface they're about to use. Rendering the orientation as
    // a card keeps the tour consistent end-to-end and leaves the
    // chat rail empty + ready for the visitor's first real message.

    const fullText =
      "And this is chat, where you actually talk to your synthetic intelligence.\n\n" +
      "Every reply you get here is grounded in you: the neurons in your synthesis layer, the files in your vault, and the AI tools you wire up under connections. Ask anything, and LYKN answers as something custom-built for you, not a stranger trained on everyone.";

    const timeouts: number[] = [];
    typingCancelRef.current = false;

    timeouts.push(window.setTimeout(() => {
      setChatIntroShown(true);
      setChatIntroText("");
      setChatIntroDone(false);
    }, 600));

    timeouts.push(window.setTimeout(() => {
      const words = fullText.split(" ").filter(Boolean);
      let i = 0;
      let current = "";
      const tick = () => {
        if (typingCancelRef.current) {
          setChatIntroText(fullText);
          setChatIntroDone(true);
          return;
        }
        current += (i === 0 ? "" : " ") + words[i];
        i += 1;
        setChatIntroText(current);
        if (i < words.length) {
          timeouts.push(window.setTimeout(tick, 28));
        } else {
          setChatIntroDone(true);
        }
      };
      tick();
    }, 1100));

    return () => {
      for (const t of timeouts) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------
  // Guest chat persistence (sessionStorage)
  // --------------------------------------------------------------------
  // For unauthenticated visitors on `/app` (no `routeBoardId`), we want
  // chats to survive React Router navigation within the SPA — e.g. a
  // guest sends a message, clicks over to the synthesis layer to peek
  // at a neuron, and returns to `/app` — without persisting across
  // tab close / new visits. localStorage would over-promise (the
  // visitor hasn't signed in, so we shouldn't anchor anything to
  // their browser long-term); in-memory React state under-delivers
  // (OmniaGrid unmounts on every route change and the chat resets to
  // []). sessionStorage is the only tier that maps to "save while
  // you're on this page; gone when you exit and come back."
  //
  // Cleared automatically the moment the visitor signs in so their
  // real Supabase-backed chats take over without a stale local copy
  // shadowing them.
  const GUEST_CHAT_SS_KEY = "lykn_guest_chat_v1";
  const guestChatRestoredRef = useRef(false);
  const guestChatPersistTimerRef = useRef<number | null>(null);

  // One-shot restore on initial mount. Gated on `!user?.id` so a
  // sign-in mid-session doesn't pull the guest copy back over the
  // real one; and on `!routeBoardId` so opening a specific
  // `/grid/<id>` lets the existing snapshot/localStorage path
  // hydrate that board normally.
  useEffect(() => {
    if (guestChatRestoredRef.current) return;
    if (user?.id) return;
    if (routeBoardId) return;
    guestChatRestoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(GUEST_CHAT_SS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.chatMessages) && parsed.chatMessages.length > 0) {
        setChatMessages(parsed.chatMessages);
        chatMessagesRef.current = parsed.chatMessages;
        setChatRailOpen(true);
        setChatRailVisible(true);
        if (Array.isArray(parsed?.aiThread) && parsed.aiThread.length > 0) {
          aiThreadRef.current = parsed.aiThread;
        }
      }
    } catch {
      // corrupt sessionStorage / private mode — fall back to empty.
    }
  }, [user?.id, routeBoardId]);

  // Persist on every chat change. Debounced by 600ms so AI token
  // streaming doesn't hammer sessionStorage on every progressive
  // update — the chat surface mutates `chatMessages` per token while
  // a reply streams in.
  useEffect(() => {
    if (user?.id) return;
    if (routeBoardId) return;
    if (guestChatPersistTimerRef.current != null) {
      window.clearTimeout(guestChatPersistTimerRef.current);
    }
    guestChatPersistTimerRef.current = window.setTimeout(() => {
      try {
        if (chatMessages.length === 0) {
          sessionStorage.removeItem(GUEST_CHAT_SS_KEY);
          return;
        }
        sessionStorage.setItem(
          GUEST_CHAT_SS_KEY,
          JSON.stringify({
            chatMessages,
            aiThread: aiThreadRef.current || [],
          }),
        );
      } catch {
        // quota / private mode — surfacing this would be louder than
        // the broken promise of in-memory chat persistence we'd be
        // covering.
      }
    }, 600);
    return () => {
      if (guestChatPersistTimerRef.current != null) {
        window.clearTimeout(guestChatPersistTimerRef.current);
      }
    };
  }, [user?.id, routeBoardId, chatMessages]);

  // Clear the guest copy the moment the visitor signs in. Their
  // real chats live in Supabase + the existing localStorage cache,
  // and the now-stale guest snapshot would otherwise sit around
  // until the tab closes.
  useEffect(() => {
    if (!user?.id) return;
    try {
      sessionStorage.removeItem(GUEST_CHAT_SS_KEY);
    } catch {
      // ignore
    }
  }, [user?.id]);

  // --------------------------------------------------------------------
  // Initial-load chat (signed-in users)
  // --------------------------------------------------------------------
  // Every signed-in user should land in a fresh blank chat — same as
  // clicking the sidebar "New chat" button. The previous behavior here
  // seeded an "opening message" (load-in greeting) recap chat that
  // pulled in awaiting approvals, project updates, etc., but those
  // greeting boards were not persisting reliably, so we've unplugged
  // that path. The greeting-specific consume/refresh/graduation effects
  // below all gate on `kind === "load-in-greeting"` and therefore
  // become silent no-ops with no greeting ever seeded.
  //
  // Fires whenever OmniaGrid mounts at `/app` (no `routeBoardId`) or
  // on the very first mount of the JS runtime regardless of URL — the
  // first-mount branch covers hard reloads sitting at a stale
  // `/grid/<old>` or transient `/app` redirects (e.g. Privacy → / →
  // `GuestOnly` → `/app`). Without this nudge, `useBoardPersistence`
  // would auto-hydrate the user's previous board from
  // `localStorage.omnia_board_id`, dropping them mid-chat instead of a
  // blank slate.
  //
  // Prototype/guest users are intentionally skipped: their grid URLs
  // are demo content, not Supabase-backed boards, and the walkthrough
  // intro owns the chat surface for that flow.
  const loadInGreetingSeededRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.id) return;
    if (planLoading) return;
    if (hasPrototypeNeurons()) return;

    const isFirstLoadOfRuntime = !omniaGridDidConsumeFirstLoad;
    const onApp = !routeBoardId;
    if (!isFirstLoadOfRuntime && !onApp) return;
    omniaGridDidConsumeFirstLoad = true;

    // Clear any leftover greeting pointers from the retired load-in
    // greeting flow so we don't accidentally route a returning user
    // back to a stale dashboard board.
    try {
      localStorage.removeItem("lykn:lastLoadInGreetingBoardId");
      sessionStorage.removeItem("lykn:loadInGreetingMintedThisSession");
    } catch {
      // ignore
    }

    // Mint a fresh blank chat — equivalent to the sidebar "New chat"
    // button. `useBoardPersistence` will create the row in
    // `omnia_boards` on hydration.
    const targetId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    nav(`/grid/${targetId}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, planLoading, routeBoardId]);

  // The matching "graduation" effect (clears the saved dashboard
  // pointer once a user types into a load-in greeting board) and the
  // "consume" half (inflates a stashed greeting payload into a chat
  // message) live below. They both gate on the load-in greeting flow
  // that this trigger no longer seeds, so they're effectively dormant.

  const createWelcomeText = useMemo(() => {
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const preferredName = String(firstName || emailName || "").trim();
    return preferredName ? `Welcome back, ${preferredName}` : "Start a new chat";
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


  const reSignChatAttachments = useCallback(() => {
    (async () => {
      const msgs = chatMessagesRef.current;
      const attachJobs: { msgId: string; attIdx: number; storagePath: string; bucket: string }[] = [];
      const imageJobs: { msgId: string; storagePath: string }[] = [];

      for (const m of msgs) {
        if (Array.isArray((m as any).attachments)) {
          (m as any).attachments.forEach((a: any, idx: number) => {
            if (a.storagePath && (!a.url || a.url === "" || a.url.startsWith("blob:"))) {
              attachJobs.push({ msgId: m.id, attIdx: idx, storagePath: a.storagePath, bucket: a.storageBucket || "user-files" });
            }
          });
        }
        if ((m as any).aiImageStoragePath) {
          imageJobs.push({ msgId: m.id, storagePath: (m as any).aiImageStoragePath });
        }
      }

      if (attachJobs.length === 0 && imageJobs.length === 0) return;

      const allResults = await Promise.allSettled([
        ...attachJobs.map((job) =>
          supabase.storage
            .from(job.bucket)
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "att" as const, ...job, url: data?.signedUrl || "" }))
        ),
        ...imageJobs.map((job) =>
          supabase.storage
            .from("user-files")
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "img" as const, ...job, url: data?.signedUrl || "" }))
        ),
      ]);

      const attUrlMap = new Map<string, Map<number, string>>();
      const imgUrlMap = new Map<string, string>();

      for (const r of allResults) {
        if (r.status !== "fulfilled" || !r.value.url) continue;
        if (r.value.type === "att") {
          const v = r.value as { type: "att"; msgId: string; attIdx: number; url: string };
          if (!attUrlMap.has(v.msgId)) attUrlMap.set(v.msgId, new Map());
          attUrlMap.get(v.msgId)!.set(v.attIdx, v.url);
        } else {
          imgUrlMap.set(r.value.msgId, r.value.url);
        }
      }

      if (attUrlMap.size === 0 && imgUrlMap.size === 0) return;

      setChatMessages((prev) =>
        prev.map((m: any) => {
          const attMap = attUrlMap.get(m.id);
          const imgUrl = imgUrlMap.get(m.id);
          if (!attMap && !imgUrl) return m;
          const patched = { ...m };
          if (attMap && Array.isArray(patched.attachments)) {
            patched.attachments = patched.attachments.map((a: any, idx: number) => {
              const newUrl = attMap.get(idx);
              return newUrl ? { ...a, url: newUrl } : a;
            });
          }
          if (imgUrl) patched.aiImageUrl = imgUrl;
          return patched;
        })
      );
    })();
  }, []);

  const restoreSavedToVaultState = useCallback((bid: string | null) => {
    if (!bid) return;
    try {
      const raw = localStorage.getItem(`omnia_vault_saved_${bid}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0) {
        setSavedMediaUrls(new Set(data.mediaUrls));
      }
      if (Array.isArray(data.youtubeIds) && data.youtubeIds.length > 0) {
        setSavedYouTubeIds(new Set(data.youtubeIds));
      }
    } catch { /* ignore */ }
  }, []);

  /* ------------------------------------------------------------------ */
  /*  Board persistence hook                                             */
  /* ------------------------------------------------------------------ */
  const projectIdRef = useRef<string | null>(null);
  const onCanvasChange = useCallback(() => {
    if (projectIdRef.current) markProjectDirty(projectIdRef.current);
  }, [markProjectDirty]);
  const draftCleanupRef = useRef<(() => void) | null>(null);
  const onDraftEffectCleanup = useCallback(() => { draftCleanupRef.current?.(); }, []);

  const {
    boardId,
    title,
    setTitle,
    titleRef,
    savingRef,
    saveSnapshot,
    commitBoardTitle,
  } = useBoardPersistence({
    routeBoardId,
    userId: user?.id,
    gridSize,
    loadBlocks,
    reset,
    chatMessages,
    chatMessagesRef,
    aiThreadRef,
    notesPagesRef,
    setNotesPages: handleNotesPagesChange,
    setActiveNotePageId: setActiveNotePageId,
    setChatMessages,
    setChatRailOpen,
    setChatRailVisible,
    setChatMode,
    reSignChatAttachments,
    restoreSavedToVaultState,
    onCanvasChange,
    onDraftEffectCleanup,
    savedMediaUrls,
    savedYouTubeIds,
  });

  const {
    projectId,
    projectName,
    projectFolders,
    projectFiles,
    resolveProjectFileToFile,
  } = useProjectFiles(boardId, user?.id);
  projectIdRef.current = projectId ?? null;

  // Load-in greeting (consume half — paired with the trigger effect
  // further up). Once useBoardPersistence has hydrated the brand-new
  // board, look for a sessionStorage entry stashed by the trigger and
  // seed the chat with LYKN's "what's been happening / approvals /
  // project updates" recap.
  useEffect(() => {
    if (!routeBoardId) return;
    if (!user?.id) return;
    // `boardId === routeBoardId` is the cleanest signal we have for
    // "hydration of this board is complete and chatMessages was just
    // reset to []" — `useBoardPersistence` sets boardId synchronously
    // alongside the reset, so observing the match means we're safe to
    // append without racing the reset.
    if (boardId !== routeBoardId) return;
    if (loadInGreetingSeededRef.current.has(routeBoardId)) return;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(`lykn:loadInGreeting:${routeBoardId}`);
    } catch {
      // ignore
    }
    if (!raw) return;

    type LoadInAction = NonNullable<PromptMessage["aiResponseActions"]>[number];
    type LoadInSection = NonNullable<PromptMessage["aiResponseSections"]>[number];
    type LoadInStats = PromptMessage["aiResponseStats"];
    let parsed: {
      message?: string;
      actions?: LoadInAction[];
      sections?: LoadInSection[];
      stats?: LoadInStats;
      greetingName?: string;
    } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const message = String(parsed?.message || "").trim();
    const actions: LoadInAction[] = Array.isArray(parsed?.actions)
      ? parsed.actions
      : [];
    const sections: LoadInSection[] = Array.isArray(parsed?.sections)
      ? parsed.sections
      : [];
    const stats: LoadInStats = parsed?.stats || undefined;
    const greetingNameForPanel = String(parsed?.greetingName || "").trim() || undefined;
    try {
      sessionStorage.removeItem(`lykn:loadInGreeting:${routeBoardId}`);
    } catch {
      // ignore
    }
    if (!message) return;
    loadInGreetingSeededRef.current.add(routeBoardId);

    // Match the existing prototype-intro pattern: a tiny synthetic
    // "Catch me up" user prompt sits above LYKN's recap as the
    // `aiResponse` of that prompt (PromptMessage.role is hard-typed to
    // "user", every reply belongs to a prompt). We then progressively
    // populate `aiResponse` word-by-word so the user sees LYKN typing
    // out the update in real time — same cadence as the other in-app
    // intros. Action buttons (`aiResponseActions`) are attached at the
    // end of the type-out so they don't pop in mid-stream.
    const promptId = `loadin-intro-${Date.now()}`;
    const timeouts: number[] = [];

    // Tokenise on whitespace BUT keep the whitespace tokens in the
    // array so spaces / newlines accumulate naturally as we slice.
    const words = message.split(/(\s+)/);
    // Bigger messages need to type a touch faster so the user isn't
    // staring at a half-rendered list for 20s. We scale step time
    // inversely to length, clamped to a tight band.
    // Cadence scales with length so multi-category recaps don't take
    // forever. Bands roughly target a 6–10s total type-out regardless
    // of how rich the user's day was.
    const baseStepMs =
      words.length > 600
        ? 6
        : words.length > 400
          ? 9
          : words.length > 220
            ? 14
            : words.length > 120
              ? 20
              : 26;

    timeouts.push(
      window.setTimeout(() => {
        setChatRailOpen(true);
        setChatRailVisible(true);
        setChatMessages((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  id: promptId,
                  role: "user",
                  // No synthetic user prompt — the load-in greeting is
                  // an unprompted assistant briefing. `kind` flags this
                  // turn so the renderer hides the user bubble and
                  // skips the "AI Response" collapsible wrapper.
                  content: "",
                  aiResponse: "",
                  kind: "load-in-greeting",
                  // Attach the dashboard stats immediately so the
                  // right-side briefing panel animates in alongside the
                  // type-out, not as a last-tick pop-in.
                  aiResponseStats: stats,
                  ...(greetingNameForPanel
                    ? ({ greetingName: greetingNameForPanel } as any)
                    : {}),
                },
              ],
        );

        let i = 0;
        const tick = () => {
          i += 1;
          const partial = words.slice(0, i).join("");
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === promptId ? { ...m, aiResponse: partial } : m,
            ),
          );
          if (i < words.length) {
            timeouts.push(window.setTimeout(tick, baseStepMs));
          } else if (sections.length > 0 || actions.length > 0) {
            // Reveal the section blocks (and the legacy flat action
            // strip, for any consumer that still reads it) one tick
            // after the last word lands so the transition reads as
            // "LYKN finished, here's what you can do next" rather
            // than buttons popping in simultaneously with the final
            // period.
            timeouts.push(
              window.setTimeout(() => {
                setChatMessages((prev) =>
                  prev.map((m) =>
                    m.id === promptId
                      ? {
                          ...m,
                          aiResponseSections:
                            sections.length > 0 ? sections : undefined,
                          aiResponseActions:
                            sections.length > 0
                              ? undefined
                              : actions.length > 0
                                ? actions
                                : undefined,
                        }
                      : m,
                  ),
                );
              }, 240),
            );
          }
        };
        tick();
      }, 250),
    );

    return () => {
      for (const t of timeouts) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBoardId, user?.id, boardId]);

  // Stale-greeting refresh: any time we land on a board whose ONLY
  // chat turn is a `load-in-greeting` (i.e. the user hasn't typed
  // anything yet — they just came back to a board that was minted
  // purely to host the welcome recap), re-fetch the load-in payload
  // and rewrite the assistant turn in place. The URL stays stable,
  // but the user always sees up-to-the-minute activity instead of
  // whatever was persisted on the previous visit.
  //
  // We guard tightly to avoid clobbering legitimate state:
  //   • `boardId === routeBoardId` — wait for hydration to settle.
  //   • Exactly one message, role=user, kind="load-in-greeting".
  //   • One refresh per board id per session (ref-tracked).
  //   • `mintedThisSession` flag short-circuits the freshly-minted
  //     case so we don't double-fetch right after the trigger seeds
  //     a brand-new board.
  const loadInGreetingRefreshedRef = useRef<Set<string>>(new Set());

  // Reusable refresher used by both the on-mount effect below and the
  // inline user-sections composer in the chat surface. Re-fetches the
  // greeting payload and overlays it onto the single load-in-greeting
  // message in-place (no remount, no URL change). Returns a no-op if
  // the chat isn't currently sitting on a load-in greeting.
  //
  // When the current message is the "Catching you up…" placeholder
  // (i.e. we're upgrading a freshly-minted greeting board on first
  // load, not refreshing an already-shown one), we replay the same
  // word-by-word type-out animation the consume effect uses so the
  // briefing fades into view instead of snapping in all at once.
  const refreshLoadInGreetingInPlace = useCallback(async () => {
    if (!user?.id) return;
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(
      user?.user_metadata?.full_name || user?.user_metadata?.name || "",
    ).trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const greetingName = firstName || emailName || null;
    let payload: Awaited<ReturnType<typeof fetchLoadInUpdatesMessage>> | null =
      null;
    try {
      payload = await fetchLoadInUpdatesMessage({ greetingName });
    } catch {
      payload = null;
    }
    if (!payload) return;

    // Sniff whether we're overlaying a placeholder vs. refreshing a
    // briefing the user has already been reading. Placeholder text is
    // always "Catching you up…" / "Catching you up, <name>…" — short
    // and ends in an ellipsis.
    let isPlaceholder = false;
    let targetMsgId: string | null = null;
    setChatMessages((prev) => {
      if (prev.length === 1 && prev[0].kind === "load-in-greeting") {
        const cur = prev[0];
        const txt = String(cur.aiResponse || "").trim();
        isPlaceholder = txt.startsWith("Catching you up") && txt.endsWith("…");
        targetMsgId = cur.id;
      }
      return prev;
    });

    if (!isPlaceholder) {
      // Already-shown briefing → instant overlay, no animation.
      setChatMessages((prev) => {
        if (prev.length !== 1) return prev;
        const cur = prev[0];
        if (cur.kind !== "load-in-greeting") return prev;
        return [
          {
            ...cur,
            aiResponse: payload!.message,
            aiResponseSections:
              (payload!.sections && payload!.sections.length > 0)
                ? payload!.sections
                : undefined,
            aiResponseActions:
              (!payload!.sections || payload!.sections.length === 0) &&
              payload!.actions && payload!.actions.length > 0
                ? payload!.actions
                : undefined,
            aiResponseStats: payload!.stats,
            ...(greetingName ? ({ greetingName } as any) : {}),
          },
        ];
      });
      return;
    }

    // Placeholder upgrade → clear the placeholder, attach the
    // dashboard stats immediately, then type out the real message
    // word-by-word using the same cadence as the consume effect.
    if (!targetMsgId) return;
    const words = payload.message.split(/(\s+)/);
    const baseStepMs =
      words.length > 600
        ? 6
        : words.length > 400
          ? 9
          : words.length > 220
            ? 14
            : words.length > 120
              ? 20
              : 26;
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === targetMsgId
          ? {
              ...m,
              aiResponse: "",
              aiResponseSections: undefined,
              aiResponseActions: undefined,
              aiResponseStats: payload!.stats,
              ...(greetingName ? ({ greetingName } as any) : {}),
            }
          : m,
      ),
    );
    let i = 0;
    const tick = () => {
      i += 1;
      const partial = words.slice(0, i).join("");
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === targetMsgId ? { ...m, aiResponse: partial } : m,
        ),
      );
      if (i < words.length) {
        window.setTimeout(tick, baseStepMs);
      } else if (
        (payload!.sections && payload!.sections.length > 0) ||
        (payload!.actions && payload!.actions.length > 0)
      ) {
        window.setTimeout(() => {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === targetMsgId
                ? {
                    ...m,
                    aiResponseSections:
                      payload!.sections && payload!.sections.length > 0
                        ? payload!.sections
                        : undefined,
                    aiResponseActions:
                      payload!.sections && payload!.sections.length > 0
                        ? undefined
                        : payload!.actions && payload!.actions.length > 0
                          ? payload!.actions
                          : undefined,
                  }
                : m,
            ),
          );
        }, 240);
      }
    };
    tick();
  }, [user?.id, user?.email, user?.user_metadata]);

  useEffect(() => {
    if (!routeBoardId) return;
    if (!user?.id) return;
    if (boardId !== routeBoardId) return;
    if (chatMessages.length !== 1) return;
    const only = chatMessages[0];
    if (!only || only.kind !== "load-in-greeting") return;
    let mintedThisSession = false;
    try {
      mintedThisSession =
        sessionStorage.getItem("lykn:loadInGreetingMintedThisSession") === "1";
    } catch {
      /* ignore */
    }
    if (mintedThisSession && loadInGreetingSeededRef.current.has(routeBoardId)) {
      // The trigger+consume pair already populated this board with
      // fresh data on the mint cycle — don't double-fetch.
      return;
    }
    if (loadInGreetingRefreshedRef.current.has(routeBoardId)) return;
    loadInGreetingRefreshedRef.current.add(routeBoardId);
    void refreshLoadInGreetingInPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBoardId, user?.id, boardId, chatMessages]);

  // Dashboard graduation: as soon as the user types into a dashboard
  // board (chatMessages grows past the single load-in-greeting turn),
  // forget the saved pointer. The board now belongs to a real
  // conversation, and the next page reload should mint a fresh
  // dashboard rather than drop the user back into mid-chat.
  useEffect(() => {
    if (!boardId) return;
    if (chatMessages.length <= 1) return;
    const first = chatMessages[0] as any;
    if (!first || first.kind !== "load-in-greeting") return;
    try {
      if (
        localStorage.getItem("lykn:lastLoadInGreetingBoardId") === boardId
      ) {
        localStorage.removeItem("lykn:lastLoadInGreetingBoardId");
      }
    } catch {
      /* ignore */
    }
  }, [boardId, chatMessages]);

  // Keep the in-memory grid title in sync when a peer surface (mobile
  // grids drawer, sidebar menu, etc.) renames the active board out of
  // band. Without this, the next autosave round-trips the snapshot with
  // the stale local title and silently undoes the rename.
  useEffect(() => {
    const onRenamed = (e: Event) => {
      const detail = (e as CustomEvent<{ boardId?: string; title?: string }>)?.detail;
      if (!detail) return;
      if (String(detail.boardId || "") !== String(boardId || "")) return;
      const next = String(detail.title || "").trim() || "New Chat";
      setTitle(next);
    };
    window.addEventListener("omnia_board_renamed", onRenamed as EventListener);
    return () => window.removeEventListener("omnia_board_renamed", onRenamed as EventListener);
  }, [boardId, setTitle]);

  /* ------------------------------------------------------------------ */
  /*  Chat engine hook                                                    */
  /* ------------------------------------------------------------------ */
  const chatEngine = useChatEngine({
    boardId, routeBoardId, user, title, titleRef, selectedModel,
    notesPagesRef, projectId: projectId ?? null, gridSize, viewportWidth,
    chatMode, chatRailVisible,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    updateBlock, deleteBlock, addTextBlockAt, addListBlockAt, setListItems,
    getCachedKbText, getCachedWorkspaceSummary,
    setChatRailOpen, setChatRailVisible, setChatMode,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setNotesOpen, setShowAttachMenu,
  });
  draftCleanupRef.current = chatEngine.cleanupDraftTimers;
  const {
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading, chatFlowMode, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, expandedUserPromptIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    assistantTaskChecks, isDictating, isTranscribing,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat, addChatResponseToGrid,
    replaySavedPromptResponse, applyProjectActions,
  } = chatEngine;
  const thinkingStatus = useThinkingStatus(isChatLoading, chatStatusText);

  const clampChatRailWidth = useCallback((raw: number, vw: number) => {
    const width = Math.max(0, Math.floor(vw || 0));
    if (width < 640) return width;
    const minW = width <= 900 ? 200 : 220;
    const maxW = Math.max(minW + 20, Math.floor(width * 0.9));
    return Math.max(minW, Math.min(maxW, Math.floor(raw || minW)));
  }, []);


  const getChatRailWidthPx = useCallback(
    (vw: number) => {
      if (chatMode) return 0;
      const width = Math.max(0, Math.floor(vw || 0));
      if (width <= 900) return Math.max(200, Math.min(260, Math.floor(width * 0.30)));
      if (width <= 1100) return Math.max(220, Math.min(280, Math.floor(width * 0.26)));
      if (width <= 1366) return Math.max(240, Math.min(310, Math.floor(width * 0.25)));
      if (width <= 1600) return Math.max(260, Math.min(340, Math.floor(width * 0.25)));
      return Math.min(380, Math.floor(width * 0.30));
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

      let rafId = 0;
      let lastNext = startWidth;
      const onMove = (ev: PointerEvent) => {
        const dx = startX - ev.clientX;
        const vw = window.innerWidth || viewportWidth || 1280;
        lastNext = clampChatRailWidth(startWidth + dx, vw);
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            setChatRailWidthManual(lastNext);
          });
        }
      };
      const onUp = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        setChatRailWidthManual(lastNext);
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
    // GRID_DISABLED short-circuit. With the canvas surface unplugged the
    // store contains no blocks for the user, so iterating it just to
    // serialise an empty tiered context is pure overhead — and it used to
    // ship a 14k-char "[CANVAS_CONTEXT]" payload to every chat request
    // describing a grid the user can't see. Returning "" here makes the
    // shared chat orchestrator skip the canvas branch entirely.
    if (GRID_DISABLED) return "";
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
      wireConnections: Array.isArray(st.wireConnections) ? st.wireConnections : [],
      recentlyDeleted: Array.isArray((st as any).recentlyDeleted) ? (st as any).recentlyDeleted : [],
    });
  }, []);

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
            const title = String(att.name || att.vaultTitle || "PDF").trim();
            const combined = `# ${title}\n\n${pdfText}`;
            const charsPerLine = Math.max(1, Math.floor((g * 16 * 0.85) / 8));
            const wrappedLines = combined.split("\n").reduce((sum: number, line: string) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
            const height = Math.max(g * 6, Math.min(g * 30, wrappedLines * 22 + 32));
            const p = attPos(g * 16, height);
            st.addTextBlockAt({ x: p.x, y: p.y }, { width: g * 16, height, content: combined, format: "plain" });
          } else if (url) {
            const pdfName = String(att.name || att.vaultTitle || "document.pdf").trim();
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
        } else if (attType === "vault" && att.vaultContent) {
          const content = att.vaultTitle ? `# ${att.vaultTitle}\n\n${att.vaultContent}` : att.vaultContent;
          const p = attPos(g * 12, g * 6);
          st.addTextBlockAt({ x: p.x, y: p.y }, { width: g * 12, height: g * 6, content, format: "rich" });
        } else if (url) {
          const p = attPos(g * 10, g * 6);
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
        }
      }
    }
  }, [addListBlockAt, boardId, setListItems, user?.id]);

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


  // Knowledge base is project-scoped; workspace summary (vault + other boards) must load even without a project.
  const kbBoardId = routeBoardId || boardId;
  useEffect(() => {
    if (!projectId) return;
    refreshKnowledgeBase(projectId, { excludeBoardId: kbBoardId || undefined });
  }, [projectId, kbBoardId, refreshKnowledgeBase]);

  useEffect(() => {
    if (!user?.id) return;
    refreshWorkspaceSummary(user.id, boardId || undefined);
  }, [user?.id, boardId, refreshWorkspaceSummary]);


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
    if (isQuickNoteSaving) return;
    if (!user?.id) { requireSignIn("save notes"); return; }
    const content = quickNoteContent.trim();
    if (!content) return;
    if (!(await checkVaultLimit())) return;
    setIsQuickNoteSaving(true);
    try {
      const { error } = await supabase
        .from("notes")
        .insert({ user_id: user.id, title: "Quick Note", content, source: "quick_note" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) {
          return;
        }
        const { error: fallbackError } = await supabase
          .from("notes")
          .insert({ user_id: user.id, title: "Quick Note", content })
          .select("id")
          .single();
        if (fallbackError && notifyVaultCapIfApplicable(fallbackError)) {
          return;
        }
      }
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch { /* ignore */ } finally {
      setIsQuickNoteSaving(false);
    }
  }, [user?.id, isQuickNoteSaving, quickNoteContent, requireSignIn]);

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
    const openSidebar = () => setShowVaultSidebar(true);
    window.addEventListener("omnia_open_vault_sidebar", openSidebar);
    return () => window.removeEventListener("omnia_open_vault_sidebar", openSidebar);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "omnia-vault-drag-start" && e.data.data) {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-start received");
        (window as any).__omnia_pending_vault = { ...e.data.data, timestamp: Date.now() };
        setVaultDragActive(true);
      }
      if (e.data.type === "omnia-vault-drag-end") {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-end received");
        setVaultDragActive(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const saveAiImageToMedia = useCallback(async (imageUrl: string, promptText?: string) => {
    if (!imageUrl) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;

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
          if (import.meta.env.DEV) console.warn("[LYKN] Failed to upload AI image to storage:", uploadError.message);
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Could not download AI image for re-upload:", err);
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
      const noteContent = `AI-generated image${promptText ? ` — "${promptText.slice(0, 100)}"` : ""}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;

      const { data: ins, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: filename,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.warn("[LYKN] Failed to save AI image note:", error.message);
      } else {
        if (import.meta.env.DEV) console.log("[LYKN] AI image saved to media");
        if (ins?.id) {
          afterVaultNoteSaved(user.id, ins.id, { title: filename, content: noteContent }, {
            excludeBoardId: routeBoardId || boardId || undefined,
          });
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving AI image note:", err);
    }
  }, [user?.id, routeBoardId, boardId, requireSignIn]);

  const saveYouTubeToMedia = useCallback(async (videoId: string, url: string) => {
    if (!videoId) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
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
      const { data: ins, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.warn("[LYKN] Failed to save YouTube note:", error.message);
      } else if (ins?.id) {
        afterVaultNoteSaved(user.id, ins.id, { title, content: noteContent }, {
          excludeBoardId: routeBoardId || boardId || undefined,
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving YouTube to media:", err);
    }
  }, [user?.id, routeBoardId, boardId, requireSignIn]);

  const saveLinkToMedia = useCallback(async (linkUrl: string) => {
    if (!linkUrl) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
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
      const { data: ins, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: meta.title || linkUrl,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.warn("[LYKN] Failed to save link note:", error.message);
      } else {
        if (import.meta.env.DEV) console.log("[LYKN] Link saved to media");
        if (ins?.id) {
          afterVaultNoteSaved(user.id, ins.id, {
            title: meta.title || linkUrl,
            content: noteContent,
          }, { excludeBoardId: routeBoardId || boardId || undefined });
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving link to media:", err);
    }
  }, [user?.id, routeBoardId, boardId, requireSignIn]);

  const saveAttachmentToMedia = useCallback(async (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => {
    if (!url) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
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
      const noteContent = `${filename}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: ins, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: filename,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
      } else if (ins?.id) {
        afterVaultNoteSaved(user.id, ins.id, { title: filename, content: noteContent }, {
          excludeBoardId: routeBoardId || boardId || undefined,
        });
      }
    } catch { /* ignore */ }
  }, [user?.id, routeBoardId, boardId, requireSignIn]);


  // Gate the underlying chat-send for guests once the prototype tour
  // has surfaced the sign-in wall. Any further send attempt re-opens
  // the wall instead of firing another LLM call. This pairs with the
  // canvas mousedown trap above so neither click-to-create nor the
  // chat input can be used to keep poking around the grid for free.
  const gatedHandleChatSend = useCallback(async () => {
    if (!user?.id && (prototypeSignInTriggered || prototypeSignInArmed)) {
      setPrototypeSignInOpen(true);
      setPrototypeSignInTriggered(true);
      return;
    }
    await handleChatSend();
  }, [user?.id, prototypeSignInTriggered, prototypeSignInArmed, handleChatSend]);

  const handleCenterAskSend = useCallback(async () => {
    if (!chatInputRef.current.trim() || isChatLoading) return;
    setChatRailOpen(true);
    setChatRailVisible(true);
    setCenterChatLeaving(false);
    await gatedHandleChatSend();
  }, [gatedHandleChatSend, isChatLoading]);


  const chatIsNearBottom = useCallback((threshold = 80) => {
    const el = chatScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const markScrolledUp = () => { chatUserScrolledUpRef.current = true; };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) markScrolledUp();
    };
    const onTouchStart = () => { markScrolledUp(); };
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowUp" || k === "PageUp" || k === "Home") markScrolledUp();
    };
    const onScroll = () => {
      if (chatProgrammaticScrollRef.current) {
        chatProgrammaticScrollRef.current = false;
        return;
      }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
      chatUserScrolledUpRef.current = !atBottom;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scroll", onScroll);
    };
  }, [chatMode, chatRailVisible, chatIsNearBottom]);

  useEffect(() => {
    if (!chatMode && !chatRailVisible) return;
    if (chatUserScrolledUpRef.current) return;
    // The load-in greeting is an unprompted briefing meant to be read
    // from the top — auto-scrolling to the bottom as the message types
    // out would yank the salutation and the first few bullets out of
    // view. Skip the stick-to-bottom behaviour while the chat is a
    // standalone greeting and let the user start at the top.
    const onlyGreeting =
      chatMessages.length === 1 &&
      chatMessages[0]?.kind === "load-in-greeting";
    if (onlyGreeting) return;
    const el = chatScrollRef.current;
    if (!el) return;
    chatProgrammaticScrollRef.current = true;
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

  const extractSourceLinksLocal = useCallback((text: string): { cleanText: string; sources: { title: string; url: string }[] } => {
    const sm = text.match(/\n*(?:Sources?|References?):?\s*\n([\s\S]*?)$/i);
    if (!sm) return { cleanText: text, sources: [] };
    const ct = text.slice(0, sm.index).trimEnd();
    const block = sm[1].trim();
    const sources: { title: string; url: string }[] = [];
    const lr = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = lr.exec(block)) !== null) sources.push({ title: m[1], url: m[2] });
    if (!sources.length) { const br = /(?:^|\n)\s*\d+\.\s*(https?:\/\/[^\s]+)/g; while ((m = br.exec(block)) !== null) { try { const u = new URL(m[1]); sources.push({ title: u.hostname.replace(/^www\./, ""), url: m[1] }); } catch {} } }
    return { cleanText: ct, sources };
  }, []);

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
        if (!res.ok) {
          if (import.meta.env.DEV) console.error('Regen API error:', data?.error);
          aiText = "Regeneration failed. Please try again.";
        }

        const { cleanText } = extractSourceLinksLocal(aiText);
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
  }, [chatMessages, selectedModel, calcAiBubbleSize, extractSourceLinksLocal, normalizeAiTextForBlock, updateBlock]);


  const canvasFileBlocks = useMemo(() => {
    if (!chatMode && !notesOpen) return [];
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
  }, [chatMode, notesOpen, blockCount, blockUrlSignature, focusedChatAttachments]);



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
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.vaultTitle || att.name || "YouTube Video"}</span>
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
            <div className="w-9 h-7 bg-white/55 rounded-lg flex items-center justify-center shadow-sm"><Play className="w-3.5 h-3.5 text-black ml-0.5" fill="black" /></div>
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.vaultTitle || att.name || "Video"}</span>
        </div>
      );
    }
    if (t === "audio") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <Music className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "Audio"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "vault") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-violet-300/40 bg-violet-100/40 px-3 py-2 max-w-[16.25rem] group">
          <BookOpen className="w-4 h-4 flex-shrink-0 text-violet-500" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.vaultTitle || "Vault item"}</span>
            {att.vaultContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "pdf") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "PDF"}</span>
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
            {att.vaultContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
        <Link2 className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[12.5rem] truncate text-xs">{att.vaultTitle || att.name || att.url || "Attachment"}</span>
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

    const vaultRaw = e.dataTransfer.getData("application/x-omnia-vault");
    if (vaultRaw) {
      try {
        const payload = JSON.parse(vaultRaw) as Record<string, unknown>;
        (window as any).__omnia_pending_vault = null;
        void applyVaultDropToChat(payload);
        return;
      } catch { /* fall through */ }
    }

    // Grid file collage item
    const canvasFileRaw = e.dataTransfer.getData("application/x-grid-file");
    if (canvasFileRaw) {
      try {
        const item = JSON.parse(canvasFileRaw);
        const itemType = String(item.type || "link").toLowerCase();
        const hasContent = Boolean(item.content);
        addFocusedAttachment({
          id: makeAttId(),
          type: itemType,
          url: item.url || "",
          name: item.name || "Grid file",
          mime: "",
          size: 0,
          ...(item.videoId ? { videoId: item.videoId } : {}),
          ...(hasContent && (itemType === "note" || itemType === "vault") ? { vaultContent: item.content } : {}),
          ...(hasContent && itemType === "pdf" ? { pdfText: item.content } : {}),
          ...(hasContent && itemType === "document" ? { extractedText: item.content } : {}),
          ...(hasContent && !["note", "vault", "pdf", "document"].includes(itemType) ? { vaultContent: item.content } : {}),
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
        addFocusedAttachment({ id: makeAttId(), type: "vault", url: "", name: "Dropped text", mime: "", size: 0, vaultTitle: "Dropped text", vaultContent: text });
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
  }, [addFocusedAttachment, applyVaultDropToChat]);


  const chatBarToolbarProps = useMemo(() => ({
    chatInputHasText, isChatLoading, isDictating, isTranscribing,
    selectedModel, persistSelectedModel, modelTier,
    handleOpenAttachments, handleStopAi, handleDictateToggle,
  }), [chatInputHasText, isChatLoading, isDictating, isTranscribing, selectedModel, persistSelectedModel, modelTier, handleOpenAttachments, handleStopAi, handleDictateToggle]);

  const handleCloseSideRail = useCallback(() => {
    setChatRailVisible(false);
    setChatRailOpen(false);
  }, []);

  const handleSideRailSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleSideRailSaveAttachment = useCallback((url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => {
    void saveAttachmentToMedia(url, name, mediaType);
    setSavedMediaUrls((p) => new Set(p).add(url));
  }, [saveAttachmentToMedia]);

  const handleSideRailSaveAiImage = useCallback((imageUrl: string, promptText?: string) => {
    void saveAiImageToMedia(imageUrl, promptText);
    setSavedMediaUrls((p) => new Set(p).add(imageUrl));
  }, [saveAiImageToMedia]);

  const handleSideRailSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleSideRailReplay = useCallback((msg: Parameters<typeof replaySavedPromptResponse>[0]) => {
    void replaySavedPromptResponse(msg);
  }, [replaySavedPromptResponse]);

  const handleSideRailCopyMessage = useCallback((msgId: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

  const handleFocusedChatSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleFocusedChatSaveAttachment = useCallback((url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => {
    void saveAttachmentToMedia(url, name, mediaType);
    setSavedMediaUrls((p) => new Set(p).add(url));
  }, [saveAttachmentToMedia]);

  const handleFocusedChatSaveAiImage = useCallback((imageUrl: string, promptText?: string) => {
    void saveAiImageToMedia(imageUrl, promptText);
    setSavedMediaUrls((p) => new Set(p).add(imageUrl));
  }, [saveAiImageToMedia]);

  const handleFocusedChatSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleFocusedChatCopyMessage = useCallback((msgId: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

  const handleFocusedChatReaction = useCallback((msgId: string, kind: "like" | "dislike") => {
    setChatReactions((prev) => ({ ...prev, [msgId]: prev[msgId] === kind ? null : kind }));
  }, []);

  const handleFocusedChatRegenerate = useCallback((msgId: string, content: string) => {
    setChatMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, aiResponse: undefined, aiImageUrl: undefined, sources: undefined } : m));
    pendingAiBrickActionRef.current = true;
    setChatInput(content);
  }, []);

  const handleFocusedChatRegenerateNonUser = useCallback((msgId: string, idx: number) => {
    const prevUserMsg = chatMessages.slice(0, idx).reverse().find((m) => m.role === "user");
    if (prevUserMsg) {
      setChatMessages((prev) => prev.filter((m) => m.id !== msgId));
      pendingAiBrickActionRef.current = true;
      setChatInput(prevUserMsg.content);
    }
  }, [chatMessages]);

  const handleVaultOverlayDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setVaultDragActive(false);
    window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
    const pending = (window as any).__omnia_pending_vault;
    if (import.meta.env.DEV) console.log("[VAULT-DROP] overlay onDrop fired");
    if (!pending || typeof pending !== "object") { if (import.meta.env.DEV) console.log("[VAULT-DROP] no pending data"); return; }
    (window as any).__omnia_pending_vault = null;

    const rawAttachments = Array.isArray(pending.attachments) ? pending.attachments : [];
    // Honor an explicit per-tile attachment selector so multi-attachment
    // notes drop the file the user dragged, not "the first attachment
    // whose mime matches" — same behavior as Canvas.tsx processVaultDrop.
    let attachments: any[] = rawAttachments;
    if ((pending as any).attachment && typeof (pending as any).attachment === "object") {
      attachments = [(pending as any).attachment];
    } else if (
      Number.isInteger((pending as any).attachmentIndex)
      && (pending as any).attachmentIndex >= 0
      && (pending as any).attachmentIndex < rawAttachments.length
    ) {
      attachments = [rawAttachments[(pending as any).attachmentIndex]];
    }

    let dropOverNotes = false;
    if (notesOpen) {
      const overlayEl = e.currentTarget as HTMLElement;
      overlayEl.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      overlayEl.style.pointerEvents = "";
      dropOverNotes = !!(under && (under as Element).closest("[data-omnia-notes-root]"));
    }

    if (dropOverNotes) {
      window.dispatchEvent(
        new CustomEvent("omnia_notes_insert_vault", {
          detail: { payload: pending, clientX: e.clientX, clientY: e.clientY },
        })
      );
      return;
    }

    if (chatMode) {
      void applyVaultDropToChat(pending);
      return;
    }

    if (import.meta.env.DEV) console.log("[VAULT-DROP] attachments count:", attachments.length);
    const youtubeAttach = attachments.find((a: any) =>
      a.type === "youtube" || a.videoId || (a.url && (a.url.includes("youtube.com") || a.url.includes("youtu.be")))
    );
    if (import.meta.env.DEV) console.log("[VAULT-DROP] youtubeAttach:", !!youtubeAttach);
    const imageAttach = attachments.find((a: any) =>
      a.type === "image" || (a.url && /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:image/"))
    );
    const videoAttach = attachments.find((a: any) =>
      a.type === "video" || (a.url && /\.(mp4|mov|webm|avi)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:video/"))
    );
    const linkAttach = attachments.find((a: any) => a.url && a.type !== "file");
    const cx = e.clientX;
    const cy = e.clientY;

    // Convert client (screen) coords to snapped world coords. This MUST
    // match Canvas.tsx `clientToWorld` so that drag-from-vault drops land
    // exactly where the cursor pointed. The previous selector
    // ".overflow-auto.overscroll-contain" matched nothing, so rect was
    // undefined and drops landed at world coords offset by the canvas'
    // viewport position. Now we look up the canonical `[data-omnia-canvas]`
    // node and use the scroll-based formula directly (no dependence on
    // possibly-stale camera.x/y).
    const SURFACE_ORIGIN_PAD = 10000; // mirrors Canvas.tsx SURFACE_ORIGIN_PAD_WORLD
    const worldFromClient = (clientX: number, clientY: number) => {
      const st = useCanvasStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const z = Number(st.camera?.zoom) || 1;
      const canvasEl = document.querySelector<HTMLElement>("[data-omnia-canvas]");
      const rect = canvasEl?.getBoundingClientRect();
      const localX = rect ? clientX - rect.left : clientX;
      const localY = rect ? clientY - rect.top : clientY;
      const scrollLeft = canvasEl?.scrollLeft || 0;
      const scrollTop = canvasEl?.scrollTop || 0;
      const worldX = (scrollLeft + localX) / z - SURFACE_ORIGIN_PAD;
      const worldY = (scrollTop + localY) / z - SURFACE_ORIGIN_PAD;
      return {
        wx: Math.round(worldX / g) * g,
        wy: Math.round(worldY / g) * g,
        g,
      };
    };

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
      if (import.meta.env.DEV) console.log("[VAULT-DROP] YouTube processing");
      if (ytUrl && extractedVid) {
        const st = useCanvasStore.getState();
        const existingIds = Array.isArray(st.blockOrder) ? st.blockOrder : [];
        const alreadyOnCanvas = existingIds.some((bid: string) => {
          const blk = (st.blocks as any)?.[bid];
          return blk && (blk.videoId === extractedVid || blk.data?.videoId === extractedVid || blk.url === ytUrl || blk.data?.url === ytUrl);
        });
        if (alreadyOnCanvas) { if (import.meta.env.DEV) console.log("[VAULT-DROP] YouTube duplicate, skipping"); return; }
        const { wx, wy } = worldFromClient(cx, cy);
        if (import.meta.env.DEV) console.log("[VAULT-DROP] Creating YouTube block");
        st.addYouTubeBlockAt({ x: wx, y: wy }, { url: ytUrl, videoId: extractedVid });
      } else {
        if (import.meta.env.DEV) console.log("[VAULT-DROP] YouTube: no valid URL or videoId");
      }
      return;
    }

    const socialAttach = attachments.find((a: any) =>
      isSocialEmbedType(a.oembedType) || isSocialEmbedType(a.type) || detectSocialPlatform(String(a.url || ""))
    );
    if (socialAttach?.url) {
      window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: socialAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    if (imageAttach?.url) {
      if (imageAttach.url.startsWith("data:image/")) {
        const f = toFile(imageAttach.url, imageAttach.name || "image.png");
        if (f) { window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
      }
      window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: imageAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    if (videoAttach?.url) {
      if (videoAttach.url.startsWith("data:video/")) {
        const f = toFile(videoAttach.url, videoAttach.name || "video.mp4");
        if (f) { window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
      }
      window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: videoAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    const pdfAttach = attachments.find((a: any) =>
      a.type === "pdf" || (a.url && /\.pdf(\?|$)/i.test(a.url)) || (a.mime && a.mime === "application/pdf")
    );
    if (pdfAttach) {
      const pdfText = String(pdfAttach.pdfText || pdfAttach.extractedText || "").trim();
      const pdfTitle = String(pdfAttach.name || pdfAttach.title || "PDF").trim();
      const pdfUrl = String(pdfAttach.url || "").trim();
      if (pdfUrl) {
        (async () => {
          const dropMode = await promptFileDropMode(pdfTitle, "pdf");
          const st = useCanvasStore.getState();
          const { wx, wy, g } = worldFromClient(cx, cy);

          // Every block needs a stable id — addBlock uses it as the key in
          // state.blocks and blockOrder, so passing undefined here used to
          // overwrite the "undefined" slot and wreak havoc on re-renders.
          const newId = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const nowIso = new Date().toISOString();

          if (dropMode === "link") {
            // Regular link brick — same shape as a pasted URL. Omit mime so
            // the render path routes through LinkBlock; displayMode="link"
            // prevents the PDF-extension check from swapping back to an
            // iframe viewer.
            st.addBlock({
              id: newId,
              type: "create", mode: "embed", x: wx, y: wy, width: g * 12, height: g * 8, content: "",
              data: { url: pdfUrl, name: pdfTitle, displayMode: "link", extractedText: pdfText || undefined },
              createdAt: nowIso,
              updatedAt: nowIso,
            } as any);
          } else {
            // Full view — embedded PDF viewer on the grid.
            st.addBlock({
              id: newId,
              type: "create", mode: "embed", x: wx, y: wy, width: g * 12, height: g * 16, content: "",
              data: { url: pdfUrl, mime: "application/pdf", name: pdfTitle, extractedText: pdfText || undefined },
              createdAt: nowIso,
              updatedAt: nowIso,
            } as any);
          }
        })();
        return;
      }
    }

    if (linkAttach?.url) {
      window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: linkAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    const content = String(pending.content || "");
    const urlMatch = content.match(/https?:\/\/[^\s<>"')]+/i);
    if (urlMatch) {
      window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: urlMatch[0], clientX: cx, clientY: cy } }));
      return;
    }

    window.dispatchEvent(
      new CustomEvent("omnia_attach_vault_text", { detail: { title: pending.title, content: pending.content, clientX: cx, clientY: cy } })
    );
  }, [notesOpen, chatMode, applyVaultDropToChat]);

  const handleConnectionCardClick = useCallback(async (conn: { title: string; sourceType: "board" | "media"; reason: string }) => {
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
        } catch { /* ignore */ }
      }
    } else {
      savingRef.current = false;
      saveSnapshot().then(() => nav("/vault"));
    }
    setShowConnectionCard(false);
  }, [getCachedWorkspaceSummary, nav, saveSnapshot]);

  const handleImportMedia = useCallback(async () => {
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
  }, [selectedMediaIds]);

  const handleToggleMedia = useCallback((noteId: string) => {
    setSelectedMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const handleDismissMedia = useCallback(() => {
    setShowMediaSuggestion(false);
    setMediaSuggestions([]);
  }, []);

  const handleTopPanelUndo = useCallback(() => {
    const selectedIds = (useCanvasStore.getState().selectedIds || []).map((x) => String(x));
    const detail: { handled?: boolean; selectedIds: string[] } = { selectedIds };
    window.dispatchEvent(new CustomEvent("omnia_grid_undo_request", { detail }));
    if (!detail.handled) {
      undo();
    }
  }, [undo]);

  return (
    <div className="w-full h-[100svh] relative overflow-hidden omnia-grid-bg">
      {/* Match BrickEditor layout: minimal chrome + floating controls */}
      <OmniaToolbar
        title={title}
        onTitleChange={setTitle}
        onTitleCommit={commitBoardTitle}
        topPanelOpen={topPanelOpen}
        onTopPanelToggle={() => setTopPanelOpen((v) => !v)}
        selectedModel={selectedModel}
        onModelChange={persistSelectedModel}
        chatMode={chatMode}
        isMobilePhone={isMobilePhone}
        gridDisabled={GRID_DISABLED}
        onChatModeToggle={() => {
          // Grid is unplugged — chat mode is permanent, this toggle is a
          // no-op. The corresponding button is hidden by the toolbar via
          // `gridDisabled`.
          if (GRID_DISABLED) return;
          if (isMobilePhone) return; // Phones are chat-only — toggle is a no-op.
          setChatMode((v) => {
            if (!v) setChatRailVisible(false);
            return !v;
          });
        }}
        chatRailVisible={chatRailVisible}
        onChatRailToggle={() => {
          // Grid is unplugged — the side rail only renders when chatMode is
          // false, so this toggle is meaningless right now.
          if (GRID_DISABLED) return;
          if (isMobilePhone) return; // No side rail on phones (it's an overlay-only chat).
          setChatRailVisible((v) => {
            if (!v) {
              setChatRailOpen(true);
              setChatMode(false);
            }
            return !v;
          });
          setCenterChatLeaving(false);
        }}
        showVaultSidebar={showVaultSidebar}
        onVaultToggle={() => setShowVaultSidebar((v) => !v)}
        notesOpen={notesOpen}
        modelSelectMenu={<OmniaGridModelSelectMenuBody modelTier={modelTier} />}
        onShareGrid={() => setShowShareDialog(true)}
        onUndo={handleTopPanelUndo}
      />

      <GridShareDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        gridTitle={title}
        boardId={boardId}
        notesPages={notesPages}
        onEnsureSaved={async () => {
          const start = Date.now();
          while (savingRef.current && Date.now() - start < 4000) {
            await new Promise((r) => setTimeout(r, 50));
          }
          await saveSnapshot();
        }}
      />

      {!isMobilePhone && (
        <div
          className={`h-full transition-[margin-right] duration-300 ${chatMode ? "invisible pointer-events-none" : ""}`}
          style={{
            marginRight: isMobileGrid ? 0 : `${chatRailWidthPx + (showVaultSidebar ? vaultSidebarWidthPx : 0)}px`,
          }}
          onMouseDownCapture={(e) => {
            // Landing-prototype handoff (final beat): once the typed
            // grid intro has finished, any click on the canvas surface
            // is intercepted to surface the sign-in wall. We swallow
            // the mousedown so no quick note, selection, or block
            // creation slips through underneath. The wall is sticky —
            // it stays armed for guests until they actually sign in.
            if (prototypeSignInArmed && !user?.id) {
              e.stopPropagation();
              e.preventDefault();
              setPrototypeSignInOpen(true);
              setPrototypeSignInTriggered(true);
            }
          }}
        >
          <Canvas liveAIMode={false} isAiThinking={isChatLoading} thinkingStatusText={thinkingStatus} hidden={GRID_DISABLED || chatMode} />
        </div>
      )}

      {vaultDragActive && (
        <OmniaVaultOverlay
          onDrop={handleVaultOverlayDrop}
          onDeactivate={() => setVaultDragActive(false)}
        />
      )}

      {showVaultSidebar && isMobileGrid && (
        <div
          className={`fixed inset-0 bg-black/20 backdrop-blur-[2px] ${notesOpen ? "z-[228]" : "z-[64]"}`}
          onClick={() => setShowVaultSidebar(false)}
        />
      )}
      <aside
        className={`fixed bottom-0 right-0 max-w-[92vw] border-l border-white/12 dark:border-white/8 bg-white/28 dark:bg-[rgba(20,20,24,0.40)] shadow-lg backdrop-blur-[16px] backdrop-saturate-[1.15] transition-transform duration-300 ${
          showVaultSidebar ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
        } ${
          notesOpen
            ? isMobileGrid
              ? "z-[231] inset-x-0 border-l-0 max-w-none"
              : "z-[231]"
            : chatMode && showVaultSidebar
              ? isMobileGrid
                ? "z-[100] inset-x-0 border-l-0 max-w-none"
                : "z-[100]"
              : isMobileGrid
                ? "z-[80] inset-x-0 border-l-0 max-w-none"
                : "z-[65]"
        }`}
        style={{ top: isMobileGrid ? 0 : "var(--header-height, 4.9rem)", width: isMobileGrid ? undefined : `${vaultSidebarWidthPx}px` }}
      >
        <div className="h-full flex flex-col">
          <div className="px-4 py-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-black dark:text-white">The Vault</h2>
              <p className="text-xs opacity-70">Files, images & media</p>
            </div>
            <button
              type="button"
              onClick={() => setShowVaultSidebar(false)}
              className="h-8 w-8 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
              title="Close vault sidebar"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 relative">
            {showVaultSidebar && (
              <iframe
                src="/vault?embedded=1"
                title="The Vault"
                className="absolute inset-0 w-full h-full border-0 bg-transparent"
              />
            )}
          </div>
        </div>
      </aside>

      {/* Center welcome prompt (no messages yet, not in chat mode) */}
      {!chatMode && chatMessages.length === 0 && (!chatRailOpen || centerChatLeaving) && (
        <OmniaCenterWelcome
          chatInputRef={chatInputRef}
          onChatInputChange={handleChatInputChange}
          onPaste={handleChatPaste}
          onResizeInput={resizeChatInput}
          onSend={handleCenterAskSend}
          centerChatLeaving={centerChatLeaving}
          isDictating={isDictating}
          isTranscribing={isTranscribing}
          centerChatInputRef={centerChatInputRef}
          chatBarToolbar={<OmniaChatBarToolbar onSend={handleCenterAskSend} {...chatBarToolbarProps} />}
          typedWelcome={typedWelcome}
        />
      )}

      {/* Mobile backdrop for side rail */}
      {!chatMode && chatRailVisible && isMobileGrid && (
        <div
          className={`fixed inset-0 bg-black/20 backdrop-blur-[2px] ${notesOpen ? "z-[227]" : "z-[63]"}`}
          onClick={handleCloseSideRail}
        />
      )}
      {/* Side rail chat (canvas mode) */}
      {!chatMode && chatRailVisible && (
        <OmniaSideRail
          chatMessages={chatMessages}
          isChatLoading={isChatLoading}
          thinkingStatus={thinkingStatus}
          chatInputRef={chatInputRef}
          onChatInputChange={handleChatInputChange}
          onSend={gatedHandleChatSend}
          chatRailWidthPx={chatRailWidthPx}
          isMobileGrid={isMobileGrid}
          notesOpen={notesOpen}
          showVaultSidebar={showVaultSidebar}
          vaultSidebarWidthPx={vaultSidebarWidthPx}
          onClose={handleCloseSideRail}
          onStartResize={handleStartChatResize}
          buildChatMarkdownComponents={buildChatMarkdownComponents}
          isDictating={isDictating}
          isTranscribing={isTranscribing}
          onPaste={handleChatPaste}
          onResizeInput={resizeChatInput}
          chatScrollRef={chatScrollRef}
          chatPanelInputRef={chatPanelInputRef}
          savedMediaUrls={savedMediaUrls}
          savedYouTubeIds={savedYouTubeIds}
          onSaveYouTube={handleSideRailSaveYouTube}
          onSaveAttachment={handleSideRailSaveAttachment}
          onSaveAiImage={handleSideRailSaveAiImage}
          onSaveLink={handleSideRailSaveLink}
          onReplay={handleSideRailReplay}
          expandedAiMsgIds={expandedAiMsgIds}
          toggleAiExpanded={toggleAiExpanded}
          expandedUserPromptIds={expandedUserPromptIds}
          toggleUserPromptExpanded={toggleUserPromptExpanded}
          getCollapsedPreview={getCollapsedPreview}
          copiedMsgId={copiedMsgId}
          onCopyMessage={handleSideRailCopyMessage}
          addChatResponseToGrid={addChatResponseToGrid}
          chatBarToolbar={<OmniaChatBarToolbar compact onSend={gatedHandleChatSend} {...chatBarToolbarProps} />}
        />
      )}

      {/* Phone-only grids drawer for focused chat. Lets users browse and
          create grids without leaving chat-only mobile mode. */}
      {chatMode && isMobilePhone && <MobileFocusedChatGrids />}

      {/* Focused chat mode — centered, below top panel, no overlay */}
      {chatMode && (
        <OmniaFocusedChat
          chatMessages={chatMessages}
          isChatLoading={isChatLoading}
          thinkingStatus={thinkingStatus}
          chatInputRef={chatInputRef}
          onChatInputChange={handleChatInputChange}
          onSend={gatedHandleChatSend}
          typedWelcome={typedWelcome}
          isMobileGrid={isMobileGrid}
          isMobilePhone={isMobilePhone}
          isDictating={isDictating}
          isTranscribing={isTranscribing}
          canvasFileBlocks={canvasFileBlocks}
          focusedChatAttachments={focusedChatAttachments}
          onPaste={handleChatPaste}
          onResizeInput={resizeChatInput}
          chatPanelInputRef={chatPanelInputRef}
          chatScrollRef={chatScrollRef}
          buildChatMarkdownComponents={buildChatMarkdownComponents}
          savedMediaUrls={savedMediaUrls}
          savedYouTubeIds={savedYouTubeIds}
          onSaveYouTube={handleFocusedChatSaveYouTube}
          onSaveAttachment={handleFocusedChatSaveAttachment}
          onSaveAiImage={handleFocusedChatSaveAiImage}
          onSaveLink={handleFocusedChatSaveLink}
          expandedAiMsgIds={expandedAiMsgIds}
          toggleAiExpanded={toggleAiExpanded}
          expandedUserPromptIds={expandedUserPromptIds}
          toggleUserPromptExpanded={toggleUserPromptExpanded}
          getCollapsedPreview={getCollapsedPreview}
          copiedMsgId={copiedMsgId}
          onCopyMessage={handleFocusedChatCopyMessage}
          addChatResponseToGrid={addChatResponseToGrid}
          gridDisabled={GRID_DISABLED}
          renderFocusedAttachmentPreview={renderFocusedAttachmentPreview}
          onDragOver={handleFocusedChatDragOver}
          onDrop={handleFocusedChatDrop}
          chatBarToolbar={<OmniaChatBarToolbar onSend={gatedHandleChatSend} {...chatBarToolbarProps} />}
          chatReactions={chatReactions}
          onReaction={handleFocusedChatReaction}
          onRegenerate={handleFocusedChatRegenerate}
          onRegenerateNonUser={handleFocusedChatRegenerateNonUser}
          onLoadInGreetingRefresh={refreshLoadInGreetingInPlace}
        />
      )}

      {/* Vertical app launcher on the left edge of the chat surface.
          Same connected-apps dock that sits at the bottom of the Vault,
          flipped to a stacked column so it lives alongside the chat
          column without crowding it. Desktop-only — the phone layout
          already uses every pixel of horizontal space for the chat
          bubbles, and the bottom tab bar covers the launcher's job
          there. */}
      {chatMode && !isMobilePhone && !isMobileGrid && (
        <VaultAppDock user={user} orientation="vertical" />
      )}

      {/* Floating load-in briefing panel — anchored to the far right
          of the viewport, outside the chat column. Visible only while
          the user is sitting on a fresh load-in greeting (single
          unprompted assistant message) on a screen wide enough to
          fit the panel without crowding the chat surface. */}
      {chatMode && !isMobilePhone && !isMobileGrid && (() => {
        const greeting =
          chatMessages.length === 1 && chatMessages[0]?.kind === "load-in-greeting"
            ? chatMessages[0]
            : null;
        if (!greeting?.aiResponseStats) return null;
        return (
          <div
            className="hidden lg:block fixed right-4 xl:right-8 top-20 z-[80]"
            style={{
              maxHeight: "calc(100vh - 6rem)",
              width: "20rem",
            }}
          >
            <LoadInBriefingPanel
              stats={greeting.aiResponseStats}
              greetingName={(greeting as any).greetingName}
            />
          </div>
        );
      })()}

      <DialogAny open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContentAny className="rounded-2xl border border-white/30 bg-[#f2f2f7]/65 backdrop-blur-md text-black shadow-lg">
          <DialogHeaderAny>
            <DialogTitleAny className="text-black">Add Attachment</DialogTitleAny>
            <DialogDescriptionAny className="text-black/60">
              Add links or upload files to your chat
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
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
            >
              <LinkIcon className="w-5 h-5" />
              Add Link
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
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
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
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
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
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

      <OmniaToasts
        aiSuggestions={aiSuggestions}
        showAiSuggestionToast={showAiSuggestionToast}
        onSetShowAiSuggestionToast={setShowAiSuggestionToast}
        lastSuggestionKeyRef={lastSuggestionKeyRef}
        connectionCards={connectionCards}
        showConnectionCard={showConnectionCard}
        onDismissConnectionCard={() => setShowConnectionCard(false)}
        onConnectionCardClick={handleConnectionCardClick}
        mediaSuggestions={mediaSuggestions}
        showMediaSuggestion={showMediaSuggestion}
        selectedMediaIds={selectedMediaIds}
        onToggleMedia={handleToggleMedia}
        onImportMedia={handleImportMedia}
        onDismissMedia={handleDismissMedia}
        importingMedia={importingMedia}
      />

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => { void handleCloseQuickNote(); }}
        />
      )}

      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />

      {/* Chat walkthrough card (final beat). Matches the synthesis-layer,
          vault, and connections cards — same dark glass, same right-edge
          pinning, same typewriter cadence — so the four cards read as
          one continuous tour. The "Finish" button closes the card,
          stamps the walkthrough as done, and arms the sign-in wall.
          We intentionally don't open the wall here; the visitor's
          next click on the canvas or chat-send is what surfaces it,
          which keeps the wall feeling like a natural consequence of
          trying to use the app rather than an interrupt mid-typing. */}
      {chatIntroShown && (
        <div className="fixed right-6 top-20 z-[9995] w-[min(88vw,18rem)]">
          <div
            className="pointer-events-auto relative rounded-2xl bg-[rgba(15,15,18,0.78)] backdrop-blur-md border border-white/10 px-4 py-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
            style={{
              animation:
                "vaultIntroCardIn 360ms cubic-bezier(0.22,1,0.36,1) both",
            }}
          >
            {/* Dismiss button intentionally removed — the walkthrough
                is a forced flow for guests, and the only way past the
                chat card is the Finish button below (which also arms
                the sign-in wall) or signing in directly. See the
                matching comment on the synthesis-layer welcome card. */}
            <p className="text-[0.8rem] leading-relaxed text-white/80 whitespace-pre-wrap min-h-[7rem] pr-4">
              {chatIntroText}
              {!chatIntroDone && (
                <span aria-hidden="true" className="lykn-wake-cursor">
                  |
                </span>
              )}
            </p>
            {chatIntroDone && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    typingCancelRef.current = true;
                    setChatIntroShown(false);
                    // Stamp the one-shot here (not on effect entry) so
                    // refreshes during the typing don't accidentally
                    // consume the tour beat — only an explicit Finish
                    // counts as "the visitor saw it."
                    try {
                      sessionStorage.setItem(PROTO_GRID_INTRO_SS_KEY, "1");
                    } catch {
                      // private mode etc.
                    }
                    const step = readPrototypeStep();
                    if (step === "synthesis" || step === "vault" || step === "grid") {
                      writePrototypeStep("done");
                    }
                    setPrototypeSignInArmed(true);
                  }}
                  className="rounded-full bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/40 text-blue-100 hover:text-white px-3 py-1 text-[0.75rem] font-medium transition-colors"
                  aria-label="Finish walkthrough"
                  title="Finish walkthrough"
                >
                  Finish
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Landing-prototype handoff (final beat): surfaces after the typed
          grid intro finishes for guests who came through the walkthrough.
          The wall is sticky — closing it re-arms the canvas trap and
          chat-send guard so the next interaction reopens it, until the
          guest actually signs in. */}
      <Dialog
        open={prototypeSignInOpen}
        onOpenChange={(next) => {
          setPrototypeSignInOpen(next);
          if (!next && !user?.id) {
            // Re-arm so any subsequent canvas click or chat send
            // re-opens the wall instead of slipping through.
            setPrototypeSignInArmed(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-md border-white/10 bg-[#1a1a1a]/95 backdrop-blur-xl text-white p-7">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              That's the tour — sign in to keep going.
            </DialogTitle>
            <DialogDescription className="text-sm text-white/60 leading-relaxed pt-2">
              Create a free account to save your first neuron, your conversation, and the grid you're standing in. Everything you've made so far comes with you.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => { void signInWithOAuth?.("google"); }}
              className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-white/10 bg-white text-black px-3 py-2.5 text-sm font-medium hover:bg-white/90 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
          </div>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-[0.625rem]">
              <span className="px-2 text-white/40 font-medium uppercase tracking-wider bg-[#1a1a1a]">
                or
              </span>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = prototypeSignInEmail.trim();
              setPrototypeSignInOpen(false);
              nav("/login", { state: trimmed ? { email: trimmed } : undefined });
            }}
            className="flex flex-col gap-2"
          >
            <input
              type="email"
              value={prototypeSignInEmail}
              onChange={(e) => setPrototypeSignInEmail(e.target.value)}
              placeholder="Enter your email"
              autoComplete="email"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white/90 placeholder:text-white/35 outline-none focus:border-blue-400/40 focus:bg-white/10 transition-colors"
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 px-3 py-2.5 text-sm font-semibold transition-colors"
            >
              Continue with email
            </button>
          </form>

          <p className="mt-1 text-center text-[10px] text-white/35 leading-relaxed">
            Free forever. No credit card. Takes 10 seconds.
          </p>
        </DialogContent>
      </Dialog>

      <FileDropModeDialog />

      {/* Notes panel — bottom drawer */}
      {!chatMode && (
        <NotesPanel
          key={boardId || "__no_board"}
          open={notesOpen}
          onOpenChange={setNotesOpen}
          pages={notesPages}
          activePageId={activeNotePageId}
          onActivePageChange={setActiveNotePageId}
          onPagesChange={handleNotesPagesChange}
          hasLeftRail={canvasFileBlocks.length > 0 && !isMobileGrid && !notesGridFilesHidden}
        />
      )}

      {/* Left “Grid Files” rail when notes open — same geometry + drag as focused chat */}
      {notesOpen && !chatMode && canvasFileBlocks.length > 0 && !isMobileGrid && !notesGridFilesHidden && (
        <div
          className="fixed bottom-0 z-[221] w-[13.75rem] overflow-y-auto scrollbar-hide px-3 pb-3 pt-4 space-y-2 bg-white/80 dark:bg-[#1e1e1e]/90 backdrop-blur-md border-r border-black/8 dark:border-white/8 transition-all duration-300"
          style={{
            top: "calc(44px + 2.75rem)",
            left: "var(--sidebar-offset, 0px)",
          }}
        >
          <div className="flex items-center justify-between px-1 mb-1">
            <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40">Grid Files</p>
            <button
              type="button"
              onClick={() => setNotesGridFilesHidden(true)}
              className="h-6 w-6 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
              title="Close grid files"
            >
              <PanelRightClose className="w-3.5 h-3.5 text-black/40 dark:text-white/40" />
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {canvasFileBlocks.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("application/x-grid-file", JSON.stringify(item));
                  e.dataTransfer.setData("text/plain", item.url || "");
                }}
                className="relative rounded-xl overflow-hidden bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-400/50 transition-all group"
                title={`Drag to chat or notes: ${item.name}`}
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
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <Music className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                ) : item.type === "pdf" ? (
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <FileText className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                ) : item.type === "note" ? (
                  <>
                    <div className="glass-text-card relative rounded-lg p-2.5 min-h-[3rem]">
                      {item.isAi && <div className="pointer-events-none absolute inset-0 rounded-lg" style={{ background: "rgba(0,0,0,0.035)" }} />}
                      <p className="relative text-[0.6875rem] leading-relaxed text-black/80 dark:text-white/80 whitespace-pre-wrap break-words" style={{ display: "-webkit-box", WebkitLineClamp: 8, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.content || ""}</p>
                    </div>
                    <div className="px-1.5 py-1">
                      <span className="text-[9px] text-black/50 dark:text-white/50 leading-tight line-clamp-1 break-all">{item.isAi ? "AI Response" : item.name}</span>
                    </div>
                  </>
                ) : (
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <Link2 className="w-5 h-5 text-black/40 dark:text-white/40" />
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
    </div>
  );
}

