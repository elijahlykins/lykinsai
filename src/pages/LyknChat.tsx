import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import ChatSendIcon from "@/lib/chatSendIcon";
import { readEmbeddedPreviewParams } from "@/lib/embeddedPreview";
import { useLyknChatStore } from "@/store/lyknChatStore";
import type { Block } from "@/lyknChat/types";
import { ChevronDown, ChevronUp, ChevronRight, Code, Link as LinkIcon, Image as ImageIcon, ImagePlus, MessageCircle, Mic, BookOpen, X, Clock, Edit2, Folder as FolderIcon, FolderKanban, Link2, MoreHorizontal, PanelRightClose, PanelRight, StickyNote, Play, FileText, Music, Video, Share2, Download, Copy, Check, RefreshCw, Telescope, ThumbsUp, ThumbsDown, Square, Save, SquarePen, Globe, GripVertical, Layers, GraduationCap, Newspaper, Users, TrendingUp, type LucideIcon } from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RESEARCH_SOURCE_OPTIONS,
  normalizeResearchSourcePref,
  type ResearchSourcePref,
} from "@/lib/ai/researchSourcePrefs";

const RESEARCH_SOURCE_ICONS: Record<ResearchSourcePref, LucideIcon> = {
  all: Layers,
  web: Globe,
  academic: GraduationCap,
  news: Newspaper,
  social: Users,
  finance: TrendingUp,
};
import ModelSelectOptions from "@/components/ModelSelectOptions";
import { toast } from "@/components/ui/use-toast";
import { useUserPlan } from "@/lib/useUserPlan";
import { isModelAllowedForPlan, defaultModelForTier } from "@/lib/modelTiers";
import { useAssistantName } from "@/hooks/useAssistantName";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { openInStudioBrowser } from "@/lib/lyknChat/openInStudioBrowser";
import { supabase } from "@/lib/supabase";
import { localBlobUrl } from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";
import { getBlockDefinition } from "@/lyknChat/blockSystem/definitions";
import type { UniversalBlockType } from "@/lyknChat/blockSystem/types";
import { createDatabaseBlockData } from "@/lyknChat/blockSystem/notionModel";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import LinkPreview from "@/components/LinkPreview";
import { SiteFavicon } from "@/components/SiteFavicon";
import { detectSocialPlatform, isSocialEmbedType } from "@/lib/media/socialEmbed";
import { promptFileDropMode } from "@/lib/fileDropModePrompt";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { copyMarkdownAsRich } from "@/lib/copyRichClipboard";
import { getAiPrefs } from "@/lib/ai-prefs";
import { buildTieredLyknChatContext, buildActionLyknChatContext } from "@/lib/ai/buildLyknChatContext";
import { maybeAutoNameChat, buildAttachmentContext } from "@/lib/ai/chatSendOrchestrator";
import { ocrImageAttachments } from "@/lib/ai/imageOcr";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import {
  fileNameFromPath,
  filesFromMacPaths,
  setPendingHomeChatFiles,
  setPendingHomeChatFolders,
  snapshotMacFolders,
  takePendingHomeChatFiles,
  takePendingHomeChatFolders,
} from "@/lib/homeChatFiles";
import {
  VAULT_PICK_ITEMS_EVENT,
  VAULT_PICK_PATHS_EVENT,
  openVaultPicker,
} from "@/lib/vault/vaultPicker";
import { persistMessageFeedback } from "@/lib/chat/messageFeedback";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { addOpenThread } from "@/lib/chat/chatThreadRuntime";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { getVaultSidebarWidth, useIsTouchOnlyDevice, getIsTouchOnlyDevice } from "@/hooks/useViewportTier";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { saveFileToVault, saveGeneratedImageToVault } from "@/lib/saveToVault";
import { createVaultWrites } from "@/lib/vault/repository";
import { insertWithSchemaFallback } from "@/lib/vault/insertWithSchemaFallback";
import {
  chatAttachmentFileType,
  chatAttachmentFilename,
  chatAttachmentKind,
  chatAttachmentSaveKeys,
  chatAttachmentText,
  fetchChatAttachmentBlob,
} from "@/lib/chat/chatAttachmentFile";
import { fetchNotesForVaultAi, buildVaultDetailForGridAi, type VaultAiNoteRow } from "@/lib/vault/vaultContentsForAi";
import { stripAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import { CONTEXT_BUDGETS } from "@/lib/ai/promptBuilder";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { snapshotToSynthesisText } from "@/lib/synthesis/sourceText";
import { fetchLoadInUpdatesMessage } from "@/lib/synthesis/loadInUpdates";
import { useProjectFiles } from "@/hooks/useProjectFiles";
import LyknChatToolbar from "@/components/lyknChat/LyknChatToolbar";
import LyknChatToasts from "@/components/lyknChat/LyknChatToasts";
import LyknChatVaultOverlay from "@/components/lyknChat/LyknChatVaultOverlay";
import FileDropModeDialog from "@/components/lyknChat/FileDropModeDialog";
import LyknChatView from "@/components/lyknChat/LyknChatView";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import {
  appEditArtifactById,
  forgetAppEdit,
  isAppEditSeed,
  recallAppEdit,
  rememberAppEdit,
  takePendingAppEdit,
} from "@/lib/apps/editApp";
import AppSourceStrip, {
  publishAppSourceStrip,
  subscribeDismissAppEdit,
} from "@/components/lyknChat/AppSourceStrip";
import LyknChatVoiceMode from "@/components/lyknChat/LyknChatVoiceMode";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import SubAgentTasksStrip from "@/components/lyknChat/SubAgentTasksStrip";
import MobileLyknChat from "@/components/lyknChat/MobileLyknChat";
import { useLyknChatPersistence, makeDefaultNotesPages } from "@/hooks/useLyknChatPersistence";
import { fetchMostRecentLyknChat } from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { useChatEngine, type ComposerMode, type ArtifactKind } from "@/hooks/useChatEngine";
import { detectStudioModeRedirect } from "@/lib/ai/studioModeIntent";
import StudioImagineMode, {
  IMAGINE_CLEAR_EVENT,
  imagineBatchesFromTurns,
  type ImagineCommit,
  type ImagineGenerateInput,
  type StudioImagineHandle,
} from "@/components/lyknChat/StudioImagineMode";
import { fetchPublishedCustomModels } from "@/lib/modelBuilder/customModelsClient";
import {
  loadActiveCustomModelId,
  saveActiveCustomModelId,
} from "@/lib/modelBuilder/activeCustomModelStorage";
import {
  customModelSelectValue,
  parseCustomModelSelectValue,
} from "@/lib/modelBuilder/customModelSelect";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { fromChatModelKey, toChatModelKey } from "@/lib/lyknChat/chatModelKey";
import { patchThreadSnapshot } from "@/lib/chat/chatThreadRuntime";
import LyknChatPlusMenu from "@/components/lyknChat/LyknChatPlusMenu";
import LyknChatProjectPicker, { type LyknChatScopedProject } from "@/components/lyknChat/LyknChatProjectPicker";
import AddLinkDialog, { type AddLinkPreview } from "@/components/AddLinkDialog";
// Feature flag — the LYKN Grid canvas surface is temporarily unplugged.
// Keep this `true` to make the focused chat the main interface across `/app`,
// `/chat/:chatId`, and `/omnia`. Flip back to `false` to re-enable the
// canvas + mode-toggle UX without any other code changes. All grid logic,
// state, and components remain wired up — they just never become visible
// while this flag is on.
const GRID_DISABLED = true;

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

const CHAT_TO_BOARD_IMPORT_KEY = "lyknchat_chat_import_v1";

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
  chatId?: string;
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

function chatAttachmentsToImagineInput(
  text: string,
  atts: FocusedChatAttachment[],
): ImagineGenerateInput {
  const referenceUrls: string[] = [];
  const documents: { name: string; text: string }[] = [];
  for (const a of atts || []) {
    const isImg = a.type === "image" || String(a.mime || "").startsWith("image/");
    const src = String(a.url || "");
    if (isImg && src) {
      referenceUrls.push(src);
      continue;
    }
    const body = [a.extractedText, a.pdfText, a.transcript, a.vaultContent]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (body) documents.push({ name: a.name || a.vaultTitle || "attachment", text: body });
  }
  return { text, referenceUrls, documents };
}

const makeAttId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;


/** Shared model list for top panel and chat-bar selectors. Thin wrapper
 * around the canonical `<ModelSelectOptions>` so existing call sites that
 * pass a JSX node prop don't need to import the shared component directly.
 *
 * `modelTier` gates which models are selectable:
 *   - "basic"     (Free / guest)   → LYKN only
 *   - "top+media" (Pro)            → LYKN + frontier picks
 * Locked models are shown greyed out with a lock badge so users can see the
 * upgrade path instead of hiding the tier entirely.
 */
function LyknChatModelSelectMenuBody({
  modelTier = "basic",
  publishedCustomModels = [],
  lyknLabel,
}: {
  modelTier?: string;
  publishedCustomModels?: { id: string; name: string }[];
  lyknLabel?: string;
}) {
  return (
    <ModelSelectOptions
      modelTier={modelTier}
      publishedCustomModels={publishedCustomModels}
      lyknLabel={lyknLabel}
    />
  );
}

const CREATE_MODE_LABELS: Record<ArtifactKind, string> = {
  deck: "Pitch deck",
  study: "Study guide",
  document: "Document",
  worksheet: "Worksheet",
  spreadsheet: "Spreadsheet",
  chart: "Chart",
  diagram: "Diagram",
  webapp: "Interactive page",
};

function composerModeLabel(mode: ComposerMode): string {
  if (mode === "image") return "Generate image";
  if (mode === "web") return "Web search";
  if (mode === "research") return "Deep research";
  if (mode.startsWith("create:")) {
    const kind = mode.slice("create:".length) as ArtifactKind;
    // "webapp" is surfaced in the menu as Build mode (AI codes it out live).
    if (kind === "webapp") return "Build mode";
    return CREATE_MODE_LABELS[kind] ? `Create: ${CREATE_MODE_LABELS[kind]}` : "Create";
  }
  return "";
}

// Studio glass mode selector — Chat / Build / Imagine / Research. Floats at
// the top of the glass chat page (inside LYKN Studio). Each mode segment is
// its own page view: a fresh centered composer with a mode headline, the
// composer mode armed silently (no blue chip). The mode rides through the
// same pipeline as the "+" menu (Build = live React artifact, Imagine =
// image gen, Research = deep-research report).
type StudioView = "chat" | "build" | "imagine" | "research";

const STUDIO_VIEW_MODES: Record<Exclude<StudioView, "chat">, ComposerMode> = {
  build: "create:webapp",
  imagine: "image",
  research: "research",
};

const STUDIO_VIEW_HEADLINES: Record<Exclude<StudioView, "chat">, string> = {
  build: "What would you like to build?",
  imagine: "Generate any image",
  research: "What should LYKN research?",
};

const STUDIO_VIEW_SUBTITLES: Record<Exclude<StudioView, "chat">, string> = {
  build:
    "Pitch decks, presentations, and polished visual docs. Describe what you need and LYKN builds it live.",
  imagine: "Describe any image and LYKN generates a set of variations you can refine.",
  research:
    "Give a topic or question and LYKN digs into current sources, then writes a structured research report.",
};

// Per-mode system prompt, injected server-side into the stream system prompt
// ([ACTIVE_MODE] section) on every turn while the mode page is active. The
// pages are sticky sessions: the whole conversation stays in-lane.
// Every mode prompt ends with the same out-of-lane rule: if the ask belongs
// to a different mode, do NOT produce this mode's deliverable — point the
// user at the mode pills at the top of the page (never the "+" menu).
const STUDIO_MODE_SWITCH_RULE =
  " Ordinary questions are always in-lane: answer them directly without telling the user to " +
  "switch to Chat. If the user explicitly asks for a deliverable this mode can't create (e.g. an image in Build/Research, a " +
  "research report in Build/Imagine, or an app/deck in Imagine/Research), do NOT produce this " +
  "mode's deliverable as a substitute. Instead reply briefly telling them to switch modes using " +
  "the pills at the top of the page (Chat / Build / Imagine / Research) and resend their " +
  "request there. Never tell them to use the \"+\" menu for this.";

const STUDIO_VIEW_SYSTEM_PROMPTS: Record<Exclude<StudioView, "chat">, string> = {
  build:
    "The user is in Build mode — a dedicated session for designing and building artifacts " +
    "(interactive pages, apps, tools, games, decks, documents, charts, diagrams). Act as their " +
    "build partner: answer ordinary questions normally, help shape ideas, and propose concrete " +
    "directions without building unless the user clearly asks you to create, change, fix, or " +
    "refine an artifact. A question about an idea or an open artifact is not an edit request. When " +
    "an artifact is already open in the panel and they ask to add, change, fix, or extend it, " +
    "ALWAYS patch that artifact in place with targeted `edits` — never rebuild from scratch " +
    "unless they clearly ask to redesign, start over, or build something entirely new. If a " +
    "tool call returns a compile_error or edits_required, fix it silently and retry before " +
    "telling the user you're done. COLOR DEFAULT: stay in a quiet earthy-neutral palette — black, " +
    "white, gray, muted dark/sage greens, dark/slate blues, beige, and browns. Do not invent " +
    "bright candy accents (orange, rose, cyan, neon, purple) unless the user explicitly asks " +
    "for vivid color / a chromatic style, OR they show you a reference idea (attached image, " +
    "screenshot, mood board) — then match that idea." +
    STUDIO_MODE_SWITCH_RULE,
  imagine:
    "The user is in Imagine mode — a session for image creation and visual exploration. Answer " +
    "ordinary questions normally and discuss ideas, styles, composition, or an existing image " +
    "without generating anything unless the user clearly asks you to create or modify an image. " +
    "When they do ask to create or refine one, turn the request into a vivid, detailed image " +
    "prompt, generate it, and iterate on style, composition, lighting, and details as they react." +
    STUDIO_MODE_SWITCH_RULE,
  research:
    "The user is in Research mode — a dedicated session for producing deep research reports. " +
    "Treat each request as a research brief: investigate thoroughly using current sources and " +
    "deliver a structured, well-organized report. Ask a short clarifying question first only " +
    "when the scope is genuinely unclear; otherwise research and write. Follow-up messages " +
    "refine or extend the report — keep the session focused on the research topic." +
    STUDIO_MODE_SWITCH_RULE,
};

const STUDIO_MODE_OPTIONS: {
  id: StudioView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "build", label: "Build", icon: Code },
  { id: "imagine", label: "Imagine", icon: ImagePlus },
  { id: "research", label: "Research", icon: Telescope },
];

const StudioModePill = React.memo(function StudioModePill({
  activeView,
  onSelect,
  onNewChat,
}: {
  activeView: StudioView;
  onSelect: (view: StudioView) => void;
  onNewChat?: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-[70] flex items-center justify-center gap-2">
      {onNewChat && (
        <button
          type="button"
          onClick={onNewChat}
          title="New chat"
          aria-label="New chat"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-white/55 text-black/60 shadow-lg backdrop-blur-2xl transition-colors hover:text-black dark:border-white/15 dark:bg-black/35 dark:text-white/65 dark:hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      )}
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-black/10 bg-white/55 p-1 shadow-lg backdrop-blur-2xl dark:border-white/15 dark:bg-black/35">
        {STUDIO_MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
          const active = id === activeView;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] font-medium transition-all ${
                active
                  ? "bg-black/85 text-white shadow dark:bg-white dark:text-black"
                  : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

// Per-mode composer identity: each Studio page gets its own placeholder and
// a strip of quick-start chips above the chat bar, so the bar itself signals
// which page you're on. (Imagine has its own dedicated bar and skips this.)
const STUDIO_COMPOSER_PLACEHOLDERS: Record<StudioView, string> = {
  chat: "Ask me anything...",
  build: "Describe what you want to build...",
  imagine: "Describe the image you want...",
  research: "What should LYKN research?",
};

const STUDIO_COMPOSER_CHIPS: Record<
  Exclude<StudioView, "imagine" | "chat">,
  { label: string; insert: string }[]
> = {
  build: [
    { label: "Pitch deck", insert: "Make a pitch deck about " },
    { label: "Slide deck", insert: "Create a slide deck that covers " },
    { label: "One-pager", insert: "Design a one-pager for " },
    { label: "Investor deck", insert: "Build an investor deck for " },
    { label: "App", insert: "Build me an app that " },
    { label: "Game", insert: "Create an interactive game where " },
    { label: "Study guide", insert: "Make a study guide for " },
    { label: "Dashboard", insert: "Design a dashboard for " },
  ],
  research: [
    {
      label: "Tesla stock performance",
      insert: "Research Tesla stock: recent performance, valuation, and analyst outlook",
    },
    {
      label: "AI chip market",
      insert: "Give me a market overview of the AI semiconductor industry in 2026",
    },
    {
      label: "Sleep and memory",
      insert: "Do an academic research report on how sleep affects memory consolidation, citing recent studies",
    },
    {
      label: "Global EV trends",
      insert: "Write a trend report on the global electric vehicle market",
    },
    {
      label: "CRISPR research",
      insert: "Research the latest advances and debates in CRISPR gene editing",
    },
  ],
};

const StudioComposerStrip = React.memo(function StudioComposerStrip({
  view,
  onInsert,
}: {
  view: Exclude<StudioView, "imagine" | "chat">;
  onInsert: (text: string) => void;
}) {
  return (
    <div className="lykn-studio-chips mb-1 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-1">
      {STUDIO_COMPOSER_CHIPS[view].map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={() => onInsert(chip.insert)}
          className="shrink-0 whitespace-nowrap rounded-full border border-black/10 bg-white/40 px-2.5 py-1 text-[11px] font-medium text-black/55 backdrop-blur-sm transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:border-white/12 dark:bg-white/[0.05] dark:text-white/55 dark:hover:bg-white/[0.1] dark:hover:text-white/85"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
});

/** Short topic phrase for post-report suggestion labels ("Brainstorm …"). */
function researchSuggestionTopic(raw: string, maxLen = 42): string {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t.replace(
    /^(please\s+)?(?:do\s+)?(?:an?\s+)?(?:deep\s+)?(?:research|investigate|look into|analyze|study|explore|write|give me)\s+(?:(?:a|an|the)\s+)?(?:academic\s+)?(?:research\s+)?(?:report|overview|brief|summary)?\s*(?:on|about|into|regarding|for)?\s+/i,
    "",
  );
  t = t.replace(/[.?!]+$/, "").trim();
  if (!t) return "these findings";
  if (t.length > maxLen) t = `${t.slice(0, Math.max(12, maxLen - 1)).replace(/\s+\S*$/, "")}…`;
  return t;
}

type StudioSuggestionItem = {
  key: string;
  view: StudioView;
  label: string;
  prompt: string;
  icon: React.ComponentType<{ className?: string }>;
};

// Shared strip above the chat bar: three one-tap next steps after a
// Research report finishes. Each switches Studio mode (when needed) and
// immediately starts the turn. Build keeps the composer clean — no
// follow-up chips sitting above the bar.
const StudioFollowUpSuggestions = React.memo(function StudioFollowUpSuggestions({
  items,
  disabled,
  onSelect,
}: {
  items: StudioSuggestionItem[];
  disabled?: boolean;
  onSelect: (view: StudioView, prompt: string) => void;
}) {
  return (
    <div className="mb-1.5 px-1">
      <p className="mb-1.5 px-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-black/40 dark:text-white/40">
        Suggestions
      </p>
      <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
        {items.map(({ key, view, label, prompt, icon: Icon }) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(view, prompt)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-black/10 bg-white/50 px-3 py-2 text-left text-[12px] font-medium leading-snug text-black/70 backdrop-blur-sm transition-colors hover:bg-black/[0.06] hover:text-black/90 disabled:pointer-events-none disabled:opacity-40 dark:border-white/12 dark:bg-white/[0.06] dark:text-white/70 dark:hover:bg-white/[0.1] dark:hover:text-white/90"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="min-w-0">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

function researchFollowUpItems(topic: string): StudioSuggestionItem[] {
  const blank = researchSuggestionTopic(topic, 42);
  const fullTopic = researchSuggestionTopic(topic, 160);
  return [
    {
      key: "build",
      view: "build",
      label: "Build · Turn this into an interactive presentation",
      prompt: "Turn this research report into an interactive presentation",
      icon: Code,
    },
    {
      key: "brainstorm",
      view: "chat",
      label: `Chat · Brainstorm ${blank}`,
      prompt: `Brainstorm ideas, angles, and next steps around ${fullTopic}`,
      icon: MessageCircle,
    },
    {
      key: "deeper",
      view: "research",
      label: "Dive deeper",
      prompt: `Dive deeper into ${fullTopic}`,
      icon: Telescope,
    },
  ];
}

// Studio Research page: right rail listing every link the deep-research
// pipeline searched/read (streamed from the server before the report text),
// plus a Save report action that writes the finished report into the vault.
function researchLinkHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const StudioResearchSidebar = React.memo(function StudioResearchSidebar({
  sources,
  canSave,
  saving,
  onSave,
}: {
  sources: { title: string; url: string }[];
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const openLink = (url: string) => {
    if (openInStudioBrowser(url)) return;
    const lykn = (window as any).lykn;
    if (lykn?.openExternal) lykn.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };
  // Shared blur glass so the report underneath is frosted, not readable.
  return (
    <div className="lg-desktop-surface flex h-full flex-col rounded-none pt-14">
      <div className="flex items-center justify-between px-4 pb-2.5">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-black/55 dark:text-white/60">
          Research links
        </p>
        {sources.length > 0 && (
          <span className="rounded-full border border-black/10 bg-black/[0.05] px-2 py-0.5 text-[0.62rem] font-medium text-black/65 dark:border-white/10 dark:bg-white/[0.07] dark:text-white/70">
            {sources.length}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 scrollbar-hide">
        {sources.length === 0 ? (
          <p className="px-3 py-8 text-center text-[0.7rem] leading-relaxed text-black/40 dark:text-white/40">
            No sources were captured for this report.
          </p>
        ) : (
          sources.map((s, i) => (
            <button
              key={`${s.url}-${i}`}
              type="button"
              onClick={() => openLink(s.url)}
              title={s.url}
              className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <SiteFavicon url={s.url} className="mt-0.5 h-3.5 w-3.5" />
              <span className="min-w-0">
                <span className="block truncate text-[0.74rem] text-black/85 dark:text-white/85">
                  {s.title || "Source"}
                </span>
                <span className="block truncate text-[0.62rem] text-black/40 dark:text-white/40">
                  {researchLinkHostname(s.url)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      <div className="p-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave || saving}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-black/85 py-2 text-[0.75rem] font-semibold text-white shadow transition-opacity hover:bg-black/75 dark:bg-white dark:text-black dark:hover:bg-white/90 disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save report"}
        </button>
      </div>
    </div>
  );
});

const LyknChatBarToolbar = React.memo(function LyknChatBarToolbar({
  compact, onSend, chatInputHasText, hasAttachments, isChatLoading, isDictating, isTranscribing,
  modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
  handleStopAi, handleDictateToggle,
  handlePickFiles, handleAddLinkClick, handlePullFromVault,
  handleSelectProjectClick, scopedProjectName, handleClearScopedProject,
  composerMode, setComposerMode,
  hideComposerModeChip,
  showResearchSourceSelect,
  researchSourcePref,
  onResearchSourcePrefChange,
}: {
  compact?: boolean;
  onSend: () => void | Promise<void>;
  chatInputHasText: boolean;
  hasAttachments?: boolean;
  isChatLoading: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  modelSelectValue: string;
  persistSelectedModel: (v: string) => void;
  modelTier?: string;
  modelSelectMenu: React.ReactNode;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
  handlePickFiles: () => void;
  handleAddLinkClick: () => void;
  handlePullFromVault: () => void;
  handleSelectProjectClick: () => void;
  scopedProjectName: string | null;
  handleClearScopedProject: () => void;
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;
  /** Studio mode pages (Build / Imagine / Research) surface the mode in the
   *  top pill instead of a blue chip inside the chat bar. */
  hideComposerModeChip?: boolean;
  showResearchSourceSelect?: boolean;
  researchSourcePref?: ResearchSourcePref;
  onResearchSourcePrefChange?: (v: ResearchSourcePref) => void;
}) {
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
  const sendDisabled = (!chatInputHasText && !hasAttachments) || isChatLoading || isDictating || isTranscribing;
  const modelTriggerCls = compact
    ? "lykn-chat-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0"
    : "lykn-chat-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const sourceTriggerCls = compact
    ? "lykn-chat-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7.5rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-1.5 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>span]:pr-0.5 [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0 [&>svg]:ml-0.5"
    : "lykn-chat-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[8.5rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-1.5 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>span]:pr-0.5 [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0 [&>svg]:ml-0.5";
  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";
  const dropdownCls = "lykn-chat-bar-menu lg-menu p-1.5";

  const blurModelTrigger = React.useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".lykn-chat-neu-chat-toolbar-select-trigger")
        .forEach((el) => el.blur());
    });
  }, []);

  const handleModelOpenChange = React.useCallback(
    (open: boolean) => {
      setModelMenuOpen(open);
      if (!open) blurModelTrigger();
    },
    [blurModelTrigger],
  );

  const handleModelChange = React.useCallback(
    (value: string) => {
      setModelMenuOpen(false);
      persistSelectedModel(value);
      blurModelTrigger();
    },
    [persistSelectedModel, blurModelTrigger],
  );

  const handleSourceOpenChange = React.useCallback(
    (open: boolean) => {
      setSourceMenuOpen(open);
      if (!open) blurModelTrigger();
    },
    [blurModelTrigger],
  );

  const handleSourceChange = React.useCallback(
    (value: string) => {
      setSourceMenuOpen(false);
      onResearchSourcePrefChange?.(normalizeResearchSourcePref(value));
      blurModelTrigger();
    },
    [onResearchSourcePrefChange, blurModelTrigger],
  );

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      <Select
        modal={false}
        open={modelMenuOpen}
        onOpenChange={handleModelOpenChange}
        value={modelSelectValue}
        onValueChange={handleModelChange}
      >
        <SelectTrigger className={modelTriggerCls}>
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent
          side="top"
          align="start"
          className={`${dropdownCls} max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]`}
        >
          {modelSelectMenu}
        </SelectContent>
      </Select>
      {composerMode !== "none" && !hideComposerModeChip && (
        <button
          type="button"
          onClick={() => setComposerMode("none")}
          className="inline-flex items-center gap-1 rounded-full border border-blue-400/40 bg-blue-500/12 px-2 h-7 text-[0.6875rem] font-medium text-blue-700 dark:text-blue-300 shrink-0 hover:bg-blue-500/20 transition-colors"
          title="Turn off"
        >
          {composerModeLabel(composerMode)}
          <X className="w-3 h-3" />
        </button>
      )}
      {scopedProjectName && (
        <button
          type="button"
          onClick={handleClearScopedProject}
          className="inline-flex items-center gap-1 rounded-full border border-blue-400/40 bg-blue-500/12 px-2 h-7 max-w-[10rem] text-[0.6875rem] font-medium text-blue-700 dark:text-blue-300 shrink-0 hover:bg-blue-500/20 transition-colors"
          title="Stop chatting about this project"
        >
          <FolderKanban className="w-3 h-3 shrink-0" />
          <span className="truncate">{scopedProjectName}</span>
          <X className="w-3 h-3 shrink-0" />
        </button>
      )}
      <div className="flex-1 min-w-[4px]" aria-hidden />
      {showResearchSourceSelect ? (
        <Select
          modal={false}
          open={sourceMenuOpen}
          onOpenChange={handleSourceOpenChange}
          value={researchSourcePref || "all"}
          onValueChange={handleSourceChange}
        >
          <SelectTrigger className={sourceTriggerCls} title="Sources to pull from">
            <SelectValue placeholder="Sources">
              {(() => {
                const pref = researchSourcePref || "all";
                const opt = RESEARCH_SOURCE_OPTIONS.find((o) => o.value === pref);
                const Icon = RESEARCH_SOURCE_ICONS[pref] || Layers;
                return (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Icon className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0 opacity-70`} />
                    <span className="truncate">{opt?.shortLabel || "Sources"}</span>
                  </span>
                );
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="end"
            className={`${dropdownCls} w-[min(92vw,14rem)]`}
          >
            {RESEARCH_SOURCE_OPTIONS.map((opt) => {
              const Icon = RESEARCH_SOURCE_ICONS[opt.value];
              return (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    {opt.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : null}
      <LyknChatPlusMenu
        iconBtnCls={iconBtn}
        iconSmCls={iconSm}
        onAddFiles={handlePickFiles}
        onAddLink={handleAddLinkClick}
        onPullVault={handlePullFromVault}
        onProjects={handleSelectProjectClick}
      />
      {isChatLoading ? (
        <button
          type="button"
          onClick={handleStopAi}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0`}
          title="Stop generating"
        >
          <Square className={`${compact ? "w-2.5 h-2.5" : "w-3 h-3"} text-red-600 dark:text-red-400`} fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0 ${isDictating ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
          title={isDictating ? "Stop recording" : "Dictate"}
        >
          <Mic className={`${iconSm} text-black/75 dark:text-white/80 ${isDictating ? "text-blue-600 dark:text-blue-400" : ""}`} />
        </button>
      )}
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendDisabled}
        className={`${iconBtn} lykn-chat-neu-chat-send-btn flex items-center justify-center shrink-0 ${sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`}
        title="Send"
      >
        <ChatSendIcon className={iconSm} strokeWidth={2.25} />
      </button>
    </div>
  );
});

// `studioSurface` — the page is mounted IN-DOCUMENT inside the LYKN Studio
// panel (its own MemoryRouter, no iframe). It behaves like the glass Studio
// chat (mode pill, panel-sized layout) without any embedded=1 URL params.
export default function LyknChat({ studioSurface = false }: { studioSurface?: boolean } = {}) {
  const nav = useNavigate();
  const location = useLocation();
  const { chatId: routeChatId } = useParams<{ chatId?: string }>();
  const { user } = useAuth();
  const isEmbeddedMode =
    (readEmbeddedPreviewParams(location.search).isEmbedded || studioSurface) && !routeChatId;
  // Inside LYKN Studio (glass=1 iframe embed, or mounted in-document via
  // studioSurface) the page shows the Chat / Build / Imagine / Research
  // selector pill up top.
  const isGlassChat = readEmbeddedPreviewParams(location.search).isGlass || studioSurface;
  // Which studio page view is active. Build / Imagine / Research are sticky
  // mode sessions: the chat stays in that mode (forced tool lane + mode
  // system prompt) until the user switches the pill back.
  const [studioView, setStudioView] = useState<StudioView>("chat");
  const editAppChatRef = useRef<string | null>(null);
  // Named while an app opened from the dock is still loading its source, so
  // the surface says what it is doing instead of looking like a blank chat.
  const [editingAppName, setEditingAppName] = useState<string | null>(null);
  // Read by the re-attach below without making it depend on the panel.
  const openArtifactRef = useRef<ChatArtifact | null>(null);
  // Build / Research empty-state demo chips — hide after a chip click or
  // the first send, then come back on a new chat or mode switch.
  const [studioChipsDismissed, setStudioChipsDismissed] = useState(false);
  // Read at send-time by useChatEngine → orchestrator so every turn in a
  // mode session ships the mode's system prompt. Assigned during render so
  // it can never lag the state.
  const studioModeInstructionsRef = useRef("");
  const [researchSourcePref, setResearchSourcePref] = useState<ResearchSourcePref>("all");
  const researchSourcePrefsRef = useRef<string>("all");
  researchSourcePrefsRef.current = researchSourcePref;
  studioModeInstructionsRef.current =
    isGlassChat && studioView !== "chat" ? STUDIO_VIEW_SYSTEM_PROMPTS[studioView] : "";
  // The chat's Studio mode tag, persisted inside the chat snapshot so
  // pulling the chat back up reopens the matching page view. In the Studio
  // it mirrors the live pill; other surfaces keep whatever the snapshot
  // hydrated so saves there don't strip the tag.
  const studioModeSaveRef = useRef<string | null>(null);
  if (isGlassChat) studioModeSaveRef.current = studioView === "chat" ? null : studioView;
  // Hydration hook-up happens below once the chat engine provides
  // setComposerMode; the persistence hook calls through this ref.
  const studioModeHydratedCbRef = useRef<(mode: string | null) => void>(() => {});
  const imagineRef = useRef<StudioImagineHandle | null>(null);

  useEffect(() => {
    // Only for true iframe embeds — the in-document Studio surface must not
    // strip the Studio document's own backgrounds.
    if (!isEmbeddedMode || studioSurface) return;
    document.documentElement.classList.add("embedded-transparent");
    return () => document.documentElement.classList.remove("embedded-transparent");
  }, [isEmbeddedMode, studioSurface]);

  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const requireSignIn = useCallback((what: string = "save your work") => {
    try {
      toast({
        title: "Sign in to continue",
        description: `You need an account to ${what}. It's free.`,
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
  const setBlockLimit = useLyknChatStore((s) => s.setBlockLimit);
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
  const blockCount = useLyknChatStore((s) => s.blockOrder.length);
  const blockUrlSignature = useLyknChatStore((s) =>
    s.blockOrder.map((id) => {
      const b = s.blocks[id] as any;
      if (!b) return "";
      return (b.src || "") + (b.url || "") + (b.data?.src || "") + (b.data?.url || "");
    }).join("\n")
  );
  const addTextBlockAt = useLyknChatStore((s) => s.addTextBlockAt);
  const addListBlockAt = useLyknChatStore((s) => s.addListBlockAt);
  const setListItems = useLyknChatStore((s) => s.setListItems);
  const deleteBlock = useLyknChatStore((s) => s.deleteBlock);
  const setCamera = useLyknChatStore((s) => s.setCamera);
  const loadBlocks = useLyknChatStore((s) => s.loadBlocks);
  const reset = useLyknChatStore((s) => s.reset);
  const gridSize = useLyknChatStore((s) => s.gridSize);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showAddLinkDialog, setShowAddLinkDialog] = useState(false);
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
    return "lykn";
  });
  const [activeCustomModelId, setActiveCustomModelId] = useState<string | null>(() =>
    loadActiveCustomModelId(),
  );
  const chatModelKeyRef = useRef<string | null>(
    toChatModelKey(
      (() => {
        try {
          const saved = localStorage.getItem("lykinsai_settings");
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.aiModel) return parsed.aiModel;
          }
        } catch {
          // ignore
        }
        return "lykn";
      })(),
      loadActiveCustomModelId(),
    ),
  );
  // When true, ignore global settings → picker sync so a hydrated board key
  // isn't immediately overwritten by localStorage / cross-tab events.
  const applyingChatModelKeyRef = useRef(false);
  // Must be declared BEFORE useLyknChatPersistence — passing it in the
  // persistence args below would hit the const TDZ and crash /app for everyone.
  const onChatModelKeyHydrated = useCallback((key: string | null) => {
    if (!key) return;
    const { selectedModel: nextModel, customModelId } = fromChatModelKey(key);
    applyingChatModelKeyRef.current = true;
    chatModelKeyRef.current = key;
    if (customModelId) {
      setActiveCustomModelId(customModelId);
      setSelectedModel(nextModel || "lykn");
    } else {
      setActiveCustomModelId(null);
      setSelectedModel(nextModel || "lykn");
    }
    // Release after paint so the selectedModel effect doesn't clobber the
    // hydrated key, and later user/settings changes resume normal sync.
    requestAnimationFrame(() => {
      applyingChatModelKeyRef.current = false;
    });
  }, []);
  const [publishedCustomModels, setPublishedCustomModels] = useState<
    { id: string; name: string; baseModelId?: string }[]
  >([]);
  const refreshPublishedCustomModels = useCallback(async () => {
    if (!CUSTOM_MODELS_ENABLED || !user?.id) {
      setPublishedCustomModels([]);
      if (!CUSTOM_MODELS_ENABLED) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
      return;
    }
    try {
      const list = await fetchPublishedCustomModels();
      setPublishedCustomModels(list || []);
      const stored = loadActiveCustomModelId();
      if (stored && !(list || []).some((m) => m.id === stored)) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
    } catch {
      setPublishedCustomModels([]);
    }
  }, [user?.id]);
  useEffect(() => {
    void refreshPublishedCustomModels();
  }, [refreshPublishedCustomModels]);
  useEffect(() => {
    if (!CUSTOM_MODELS_ENABLED) return undefined;
    const onRefresh = () => void refreshPublishedCustomModels();
    window.addEventListener("lykn_custom_models_changed", onRefresh);
    window.addEventListener("lykn_active_custom_model_changed", onRefresh);
    return () => {
      window.removeEventListener("lykn_custom_models_changed", onRefresh);
      window.removeEventListener("lykn_active_custom_model_changed", onRefresh);
    };
  }, [refreshPublishedCustomModels]);
  const assistantName = useAssistantName();
  const modelSelectValue = useMemo(
    () =>
      activeCustomModelId
        ? customModelSelectValue(activeCustomModelId)
        : selectedModel,
    [activeCustomModelId, selectedModel],
  );
  const isMainAgentChat = useMemo(() => {
    if (!activeCustomModelId) return false;
    const model = publishedCustomModels.find((m) => m.id === activeCustomModelId);
    return !!(model as { isMainAgent?: boolean } | undefined)?.isMainAgent;
  }, [activeCustomModelId, publishedCustomModels]);
  const modelSelectMenu = useMemo(
    () => (
      <LyknChatModelSelectMenuBody
        modelTier={modelTier}
        publishedCustomModels={publishedCustomModels}
        lyknLabel={assistantName}
      />
    ),
    [modelTier, publishedCustomModels, assistantName],
  );
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
    const customId = parseCustomModelSelectValue(value);
    if (customId) {
      saveActiveCustomModelId(customId);
      setActiveCustomModelId(customId);
      const custom = publishedCustomModels.find((m) => m.id === customId);
      const base = custom?.baseModelId;
      if (base && isModelAllowedForPlan(base, modelTier)) {
        setSelectedModel(base);
      }
      chatModelKeyRef.current = toChatModelKey(base || selectedModel || "lykn", customId);
      return;
    }
    saveActiveCustomModelId(null);
    setActiveCustomModelId(null);
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
    chatModelKeyRef.current = toChatModelKey(value, null);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {
      /* ignore */
    }
  }, [modelTier, nav, isGuest, publishedCustomModels, selectedModel]);

  // Auto-downgrade the saved model once the plan resolves. Keeps behaviour
  // deterministic for users who had a premium model picked before downgrading.
  useEffect(() => {
    if (planLoading) return;
    if (activeCustomModelId) return;
    if (isModelAllowedForPlan(selectedModel, modelTier)) return;
    const fallback = defaultModelForTier(modelTier);
    setSelectedModel(fallback);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = fallback;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [modelTier, planLoading, selectedModel, activeCustomModelId]);

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
  const updateBlock = useLyknChatStore((s) => s.updateBlock);
  const chatImportAppliedRef = useRef<string | null>(null);

  /* Shared chat state (lifted here so both useLyknChatPersistence and useChatEngine can use them) */
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

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --------------------------------------------------------------------
  // Resume last chat (signed-in users landing on /app)
  // --------------------------------------------------------------------
  // Login and sidebar "Chat" both route to `/app` with no board id.
  // Bounce to the user's most recent conversation instead of minting a
  // fresh blank chat every time — empty "New Chat" shells stay hidden
  // from sidebars until they have real content. Hard reloads at
  // `/chat/<id>` are left alone so the URL the user bookmarked wins.
  const loadInGreetingSeededRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.id) return;
    if (planLoading) return;
    if (routeChatId) return;

    let cancelled = false;

    // Navigate immediately so `/chat/:id` exists before the user can send
    // a first message. The async Supabase round-trip below may reconcile to
    // a different board for cross-device resume — useLyknChatPersistence keeps
    // any in-flight chat when that happens.
    //
    // Studio always lands on a fresh empty chat ("Welcome back") — don't
    // reuse the last active id or we'd hydrate the previous conversation.
    let provisionalId: string | null = null;
    if (!studioSurface) {
      try {
        provisionalId = localStorage.getItem("lyknchat_active_id");
      } catch {
        // ignore
      }
    }
    if (!provisionalId) {
      provisionalId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    nav(`/chat/${provisionalId}`, { replace: true });

    if (studioSurface) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        localStorage.removeItem("lykn:lastLoadInGreetingChatId");
        sessionStorage.removeItem("lykn:loadInGreetingMintedThisSession");
      } catch {
        // ignore
      }

      // Cross-device resume: pick the board with the newest `updated_at`
      // from Supabase, not stale per-device localStorage. Phone and laptop
      // each keep their own `lyknchat_active_id`; without this, opening /app on
      // a second device resurrects an old laptop chat instead of the phone
      // conversation the user just had.
      let targetId: string | null = null;
      let remoteBoard: { id: string; updated_at?: string | null } | null = null;
      let storedBoard: { id: string; updated_at?: string | null } | null = null;

      try {
        const recent = await fetchMostRecentLyknChat(user.id);
        if (recent?.id) remoteBoard = recent;
      } catch {
        // ignore
      }

      try {
        const stored = localStorage.getItem("lyknchat_active_id");
        if (stored) {
          const { data } = await supabase
            .from("lykn_chats")
            .select("id, updated_at")
            .eq("id", stored)
            .eq("user_id", user.id)
            .maybeSingle();
          if (data?.id) storedBoard = data;
        }
      } catch {
        // ignore
      }

      if (remoteBoard?.id && storedBoard?.id) {
        const remoteTs = remoteBoard.updated_at ? new Date(remoteBoard.updated_at).getTime() : 0;
        const storedTs = storedBoard.updated_at ? new Date(storedBoard.updated_at).getTime() : 0;
        targetId = remoteTs >= storedTs ? remoteBoard.id : storedBoard.id;
      } else {
        targetId = remoteBoard?.id || storedBoard?.id || null;
      }

      if (!targetId) {
        targetId = provisionalId;
      }

      if (!cancelled && targetId !== provisionalId) {
        nav(`/chat/${targetId}`, { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, planLoading, routeChatId, nav, studioSurface]);

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


  const reSignChatAttachments = useCallback((messages?: any[]) => {
    (async () => {
      // Prefer the messages handed in by the loader. At load time the
      // chatMessagesRef is still stale (it's synced from state via an effect
      // that hasn't run yet), so reading the ref here would find nothing and
      // silently skip re-signing — leaving storage-backed images broken.
      const msgs = Array.isArray(messages) && messages.length ? messages : chatMessagesRef.current;
      const attachJobs: { msgId: string; attIdx: number; storagePath: string; bucket: string }[] = [];
      const imageJobs: { msgId: string; storagePath: string }[] = [];
      // Imagine writes a batch of variations per turn, so its images are
      // re-signed per slot rather than one to a message.
      const batchJobs: { msgId: string; imgIdx: number; storagePath: string }[] = [];
      // Local-first attachments need no round trip at all — the blob protocol
      // serves them off disk — so they're resolved inline here rather than
      // asked of a bucket that doesn't exist.
      const localAttachments: { msgId: string; attIdx: number; url: string }[] = [];

      for (const m of msgs) {
        if (Array.isArray((m as any).attachments)) {
          (m as any).attachments.forEach((a: any, idx: number) => {
            if (a.storagePath && (!a.url || a.url === "" || a.url.startsWith("blob:"))) {
              const bucket = a.storageBucket || "user-files";
              if (bucket === LOCAL_BUCKET) {
                const url = localBlobUrl(a.storagePath);
                if (url) localAttachments.push({ msgId: m.id, attIdx: idx, url });
                return;
              }
              attachJobs.push({ msgId: m.id, attIdx: idx, storagePath: a.storagePath, bucket });
            }
          });
        }
        if ((m as any).aiImageStoragePath) {
          imageJobs.push({ msgId: m.id, storagePath: (m as any).aiImageStoragePath });
        }
        if (Array.isArray((m as any).aiImages)) {
          (m as any).aiImages.forEach((img: any, idx: number) => {
            if (img?.storagePath) {
              batchJobs.push({ msgId: m.id, imgIdx: idx, storagePath: img.storagePath });
            }
          });
        }
      }

      if (
        attachJobs.length === 0 &&
        imageJobs.length === 0 &&
        batchJobs.length === 0 &&
        localAttachments.length === 0
      ) {
        return;
      }

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
        ...batchJobs.map((job) =>
          supabase.storage
            .from("user-files")
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "batch" as const, ...job, url: data?.signedUrl || "" }))
        ),
      ]);

      const attUrlMap = new Map<string, Map<number, string>>();
      const imgUrlMap = new Map<string, string>();
      const batchUrlMap = new Map<string, Map<number, string>>();

      for (const local of localAttachments) {
        if (!attUrlMap.has(local.msgId)) attUrlMap.set(local.msgId, new Map());
        attUrlMap.get(local.msgId)!.set(local.attIdx, local.url);
      }

      for (const r of allResults) {
        if (r.status !== "fulfilled" || !r.value.url) continue;
        if (r.value.type === "att") {
          const v = r.value as { type: "att"; msgId: string; attIdx: number; url: string };
          if (!attUrlMap.has(v.msgId)) attUrlMap.set(v.msgId, new Map());
          attUrlMap.get(v.msgId)!.set(v.attIdx, v.url);
        } else if (r.value.type === "batch") {
          const v = r.value as { type: "batch"; msgId: string; imgIdx: number; url: string };
          if (!batchUrlMap.has(v.msgId)) batchUrlMap.set(v.msgId, new Map());
          batchUrlMap.get(v.msgId)!.set(v.imgIdx, v.url);
        } else {
          imgUrlMap.set(r.value.msgId, r.value.url);
        }
      }

      if (attUrlMap.size === 0 && imgUrlMap.size === 0 && batchUrlMap.size === 0) return;

      setChatMessages((prev) =>
        prev.map((m: any) => {
          const attMap = attUrlMap.get(m.id);
          const imgUrl = imgUrlMap.get(m.id);
          const batchMap = batchUrlMap.get(m.id);
          if (!attMap && !imgUrl && !batchMap) return m;
          const patched = { ...m };
          if (attMap && Array.isArray(patched.attachments)) {
            patched.attachments = patched.attachments.map((a: any, idx: number) => {
              const newUrl = attMap.get(idx);
              return newUrl ? { ...a, url: newUrl } : a;
            });
          }
          if (imgUrl) patched.aiImageUrl = imgUrl;
          if (batchMap && Array.isArray(patched.aiImages)) {
            patched.aiImages = patched.aiImages.map((img: any, idx: number) => {
              const newUrl = batchMap.get(idx);
              return newUrl ? { ...img, url: newUrl } : img;
            });
          }
          return patched;
        })
      );
    })();
  }, []);

  const restoreSavedToVaultState = useCallback((bid: string | null) => {
    if (!bid) return;
    try {
      const raw = localStorage.getItem(`lyknchat_vault_saved_${bid}`);
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
    chatId,
    title,
    setTitle,
    titleRef,
    savingRef,
    saveSnapshot,
    commitBoardTitle,
  } = useLyknChatPersistence({
    routeChatId,
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
    chatModelKeyRef,
    onChatModelKeyHydrated,
    studioModeRef: studioModeSaveRef,
    onStudioModeHydrated: (mode) => studioModeHydratedCbRef.current(mode),
  });

  const {
    projectId,
    projectName,
    projectFolders,
    projectFiles,
    resolveProjectFileToFile,
  } = useProjectFiles(chatId, user?.id);
  projectIdRef.current = projectId ?? null;

  // Load-in greeting (consume half — paired with the trigger effect
  // further up). Once useLyknChatPersistence has hydrated the brand-new
  // board, look for a sessionStorage entry stashed by the trigger and
  // seed the chat with LYKN's "what's been happening / approvals /
  // project updates" recap.
  useEffect(() => {
    if (!routeChatId) return;
    if (!user?.id) return;
    // `chatId === routeChatId` is the cleanest signal we have for
    // "hydration of this board is complete and chatMessages was just
    // reset to []" — `useLyknChatPersistence` sets chatId synchronously
    // alongside the reset, so observing the match means we're safe to
    // append without racing the reset.
    if (chatId !== routeChatId) return;
    if (loadInGreetingSeededRef.current.has(routeChatId)) return;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(`lykn:loadInGreeting:${routeChatId}`);
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
      sessionStorage.removeItem(`lykn:loadInGreeting:${routeChatId}`);
    } catch {
      // ignore
    }
    if (!message) return;
    loadInGreetingSeededRef.current.add(routeChatId);

    // Match the existing typewriter-intro pattern: a tiny synthetic
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
  }, [routeChatId, user?.id, chatId]);

  // Stale-greeting refresh: any time we land on a board whose ONLY
  // chat turn is a `load-in-greeting` (i.e. the user hasn't typed
  // anything yet — they just came back to a board that was minted
  // purely to host the welcome recap), re-fetch the load-in payload
  // and rewrite the assistant turn in place. The URL stays stable,
  // but the user always sees up-to-the-minute activity instead of
  // whatever was persisted on the previous visit.
  //
  // We guard tightly to avoid clobbering legitimate state:
  //   • `chatId === routeChatId` — wait for hydration to settle.
  //   • Exactly one message, role=user, kind="load-in-greeting".
  //   • One refresh per board id per session (ref-tracked).
  //   • `mintedThisSession` flag short-circuits the freshly-minted
  //     case so we don't double-fetch right after the trigger seeds
  //     a brand-new board.
  const loadInGreetingRefreshedRef = useRef<Set<string>>(new Set());

  // Timeout ids for the in-place greeting refresh typewriter. Mirrors the
  // consume effect's cleanup: without this, switching chats (or leaving the
  // page) mid-animation keeps firing setChatMessages against the wrong board.
  const greetingRefreshTimeoutsRef = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      for (const t of greetingRefreshTimeoutsRef.current) window.clearTimeout(t);
      greetingRefreshTimeoutsRef.current = [];
    };
  }, [routeChatId]);

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
    {
      // Read via the ref instead of a side-effecting setState updater —
      // updaters must stay pure (StrictMode runs them twice), and by this
      // point (post-await) the ref mirrors the latest committed state.
      const currentMsgs = chatMessagesRef.current || [];
      if (currentMsgs.length === 1 && currentMsgs[0].kind === "load-in-greeting") {
        const cur = currentMsgs[0];
        const txt = String(cur.aiResponse || "").trim();
        isPlaceholder = txt.startsWith("Catching you up") && txt.endsWith("…");
        targetMsgId = cur.id;
      }
    }

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
        greetingRefreshTimeoutsRef.current.push(
          window.setTimeout(tick, baseStepMs),
        );
      } else if (
        (payload!.sections && payload!.sections.length > 0) ||
        (payload!.actions && payload!.actions.length > 0)
      ) {
        greetingRefreshTimeoutsRef.current.push(
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
          }, 240),
        );
      }
    };
    tick();
  }, [user?.id, user?.email, user?.user_metadata]);

  useEffect(() => {
    if (!routeChatId) return;
    if (!user?.id) return;
    if (chatId !== routeChatId) return;
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
    if (mintedThisSession && loadInGreetingSeededRef.current.has(routeChatId)) {
      // The trigger+consume pair already populated this board with
      // fresh data on the mint cycle — don't double-fetch.
      return;
    }
    if (loadInGreetingRefreshedRef.current.has(routeChatId)) return;
    loadInGreetingRefreshedRef.current.add(routeChatId);
    void refreshLoadInGreetingInPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeChatId, user?.id, chatId, chatMessages]);

  // Dashboard graduation: as soon as the user types into a dashboard
  // board (chatMessages grows past the single load-in-greeting turn),
  // forget the saved pointer. The board now belongs to a real
  // conversation, and the next page reload should mint a fresh
  // dashboard rather than drop the user back into mid-chat.
  useEffect(() => {
    if (!chatId) return;
    if (chatMessages.length <= 1) return;
    const first = chatMessages[0] as any;
    if (!first || first.kind !== "load-in-greeting") return;
    try {
      if (
        localStorage.getItem("lykn:lastLoadInGreetingChatId") === chatId
      ) {
        localStorage.removeItem("lykn:lastLoadInGreetingChatId");
      }
    } catch {
      /* ignore */
    }
  }, [chatId, chatMessages]);

  // Keep the in-memory grid title in sync when a peer surface (mobile
  // grids drawer, sidebar menu, etc.) renames the active board out of
  // band. Without this, the next autosave round-trips the snapshot with
  // the stale local title and silently undoes the rename.
  useEffect(() => {
    const onRenamed = (e: Event) => {
      const detail = (e as CustomEvent<{ chatId?: string; title?: string }>)?.detail;
      if (!detail) return;
      if (String(detail.chatId || "") !== String(chatId || "")) return;
      const next = String(detail.title || "").trim() || "New Chat";
      setTitle(next);
    };
    window.addEventListener("lyknchat_renamed", onRenamed as EventListener);
    return () => window.removeEventListener("lyknchat_renamed", onRenamed as EventListener);
  }, [chatId, setTitle]);

  /* ------------------------------------------------------------------ */
  /*  Chat engine hook                                                    */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
      setActiveCustomModelId(loadActiveCustomModelId());
    };
    window.addEventListener("lykn_active_custom_model_changed", sync);
    return () => window.removeEventListener("lykn_active_custom_model_changed", sync);
  }, []);
  useEffect(() => {
    if (applyingChatModelKeyRef.current) return;
    chatModelKeyRef.current = toChatModelKey(selectedModel, activeCustomModelId);
  }, [selectedModel, activeCustomModelId]);

  // Chat "+" → Projects: when the user scopes the chat to a specific LYKN
  // project, it overrides the board-derived Omnia project id so the server
  // loads that project's neurons / working memory / activity for the chat.
  const [chatScopedProject, setChatScopedProject] = useState<LyknChatScopedProject | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const effectiveChatProjectId = chatScopedProject?.id ?? projectId ?? null;

  const chatEngine = useChatEngine({
    chatId, routeChatId, user, title, titleRef, selectedModel,
    customModelId: activeCustomModelId,
    notesPagesRef, projectId: effectiveChatProjectId, scopedProjectId: chatScopedProject?.id ?? null, scopedProjectName: chatScopedProject?.name ?? null, gridSize, viewportWidth,
    chatMode, chatRailVisible,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    updateBlock, deleteBlock, addTextBlockAt, addListBlockAt, setListItems,
    getCachedKbText, getCachedWorkspaceSummary,
    setChatRailOpen, setChatRailVisible, setChatMode,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setNotesOpen, setShowAttachMenu,
    studioModeInstructionsRef,
    researchSourcePrefsRef,
  });
  draftCleanupRef.current = chatEngine.cleanupDraftTimers;
  const {
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading, chatFlowMode, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, expandedUserPromptIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    assistantTaskChecks, isDictating, isTranscribing,
    voiceModeOn, setVoiceMode, toggleVoiceMode,
    composerMode, setComposerMode,
    activeArtifact, setActiveArtifact, linkArtifactApp,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment, updateFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat, addChatResponseToGrid,
    replaySavedPromptResponse, applyProjectActions,
  } = chatEngine;
  const keepBuildThinking =
    studioView === "build" ||
    (typeof composerMode === "string" && composerMode.startsWith("create:"));
  const thinkingStatus = useThinkingStatus(isChatLoading, chatStatusText, keepBuildThinking);

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

  const buildLyknChatContext = useCallback(() => {
    // GRID_DISABLED short-circuit. With the canvas surface unplugged the
    // store contains no blocks for the user, so iterating it just to
    // serialise an empty tiered context is pure overhead — and it used to
    // ship a 14k-char "[CANVAS_CONTEXT]" payload to every chat request
    // describing a grid the user can't see. Returning "" here makes the
    // shared chat orchestrator skip the canvas branch entirely.
    if (GRID_DISABLED) return "";
    const st = useLyknChatStore.getState();
    const cam = (st as any).camera || { x: 0, y: 0 };
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    return buildTieredLyknChatContext({
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
    const st = useLyknChatStore.getState() as any;
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
    if (!chatId || !user?.id) return;
    if (chatImportAppliedRef.current === chatId) return;

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

    if (!payload || String(payload.chatId || "") !== String(chatId)) return;

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
    chatImportAppliedRef.current = String(chatId);

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
      const st = useLyknChatStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const iVw = window.innerWidth || 1280;
      const iVh = window.innerHeight || 800;

      importedTodoLists.forEach((todoList) => {
        const itemCount = Array.isArray(todoList.items) ? todoList.items.length : 0;
        const estH = g * Math.max(3, itemCount + 2);
        const cur = useLyknChatStore.getState() as any;
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
      const st = useLyknChatStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const aVw = window.innerWidth || 1280;
      const aVh = window.innerHeight || 800;

      const attPos = (bw: number, bh: number) => {
        const cur = useLyknChatStore.getState() as any;
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
                window.dispatchEvent(new CustomEvent("lyknchat_attach_files", { detail: { files: [file], clientX: p.x, clientY: p.y } }));
              } catch { /* ignore */ }
            }
          } else {
            window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
          }
        } else if (attType === "video" && url) {
          const p = attPos(g * 16, g * 10);
          window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
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
                  window.dispatchEvent(new CustomEvent("lyknchat_attach_files", { detail: { files: [file], clientX: p.x, clientY: p.y } }));
                  return;
                }
              } catch { /* fetch failed, fall through */ }
              window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: pdfUrl, clientX: p.x, clientY: p.y } }));
            })();
          }
        } else if (attType === "vault" && att.vaultContent) {
          const content = att.vaultTitle ? `# ${att.vaultTitle}\n\n${att.vaultContent}` : att.vaultContent;
          const p = attPos(g * 12, g * 6);
          st.addTextBlockAt({ x: p.x, y: p.y }, { width: g * 12, height: g * 6, content, format: "rich" });
        } else if (url) {
          const p = attPos(g * 10, g * 6);
          window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url, clientX: p.x, clientY: p.y } }));
        }
      }
    }
  }, [addListBlockAt, chatId, setListItems, user?.id]);

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
  const kbChatId = routeChatId || chatId;
  useEffect(() => {
    if (!projectId) return;
    refreshKnowledgeBase(projectId, { excludeChatId: kbChatId || undefined });
  }, [projectId, kbChatId, refreshKnowledgeBase]);

  useEffect(() => {
    if (!user?.id) return;
    refreshWorkspaceSummary(user.id, chatId || undefined);
  }, [user?.id, chatId, refreshWorkspaceSummary]);


  // Sync model picker with settings changes (same-tab + cross-tab), like the old Create panel.
  // Skip while applying a per-chat hydrated key so reopen doesn't snap back to global.
  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
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
        .from("vault_items")
        .insert({ user_id: user.id, title: "Quick Note", content, source: "quick_note" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) {
          return;
        }
        const { error: fallbackError } = await supabase
          .from("vault_items")
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
    const handler = (e: MessageEvent) => {
      // The embedded vault sidebar is same-origin; reject cross-origin
      // messages so an external page (e.g. one that window.open()'d us) can't
      // inject attachments into the composer or drive storage-signing calls.
      if (e.origin !== window.location.origin) return;
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "lykn-chat-vault-drag-start" && e.data.data) {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-start received");
        (window as any).__lyknchat_pending_vault = { ...e.data.data, timestamp: Date.now() };
        setVaultDragActive(true);
      }
      if (e.data.type === "lykn-chat-vault-drag-end") {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-end received");
        setVaultDragActive(false);
      }
      // Click-to-add from the embedded vault sidebar: the iframe posts the
      // same payload it would send on drag, and we run the exact drop-to-chat
      // logic so a single click attaches the item to the chat composer.
      if (e.data.type === "lykn-chat-vault-add" && e.data.data) {
        void applyVaultDropToChat({ ...e.data.data, timestamp: Date.now() });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyVaultDropToChat]);

  // A pick from the vault window. That window is a real Finder now rather than
  // an iframe inside this page, so the choice arrives as an event instead of a
  // postMessage — as AI Drive items, or as paths when the pick came from a
  // folder on the Mac. Imagine shares the chat composer, so picks land here
  // in every mode.
  useEffect(() => {
    const onItems = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> | null;
      if (!detail || typeof detail !== "object") return;
      void applyVaultDropToChat({ ...detail, timestamp: Date.now() });
    };

    const onPaths = (e: Event) => {
      const picked = (e as CustomEvent).detail?.paths;
      if (!Array.isArray(picked) || !picked.length) return;
      void (async () => {
        const files = await filesFromMacPaths(picked);
        if (files.length) {
          await ingestChatFiles(files, addFocusedAttachment, {
            userId: user?.id,
            updateAttachment: updateFocusedAttachment,
          });
        }
        // Folders have no bytes to read, so they come in as a listing the
        // model can answer "what's in this" from.
        const folders = await snapshotMacFolders(
          picked.filter((p: string) => !files.some((f) => f.name === fileNameFromPath(p))),
        );
        for (const folder of folders) {
          addFocusedAttachment({
            id: makeAttId(),
            type: "vault",
            url: "",
            name: folder.name,
            mime: "",
            size: 0,
            vaultTitle: folder.name,
            vaultContent: folder.listing,
          });
        }
      })();
    };

    window.addEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
    window.addEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    return () => {
      window.removeEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
      window.removeEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    };
  }, [applyVaultDropToChat, addFocusedAttachment, updateFocusedAttachment, user?.id]);

  // Vault page "Chat" on a pulled-up card: stash payload, navigate here, then
  // attach it with the same path as embedded click-to-add.
  useEffect(() => {
    let raw = "";
    try {
      raw = sessionStorage.getItem("lykn_pending_vault_chat_add") || "";
      if (raw) sessionStorage.removeItem("lykn_pending_vault_chat_add");
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        void applyVaultDropToChat({ ...data, timestamp: Date.now() });
      }
    } catch {
      /* ignore bad payload */
    }
  }, [applyVaultDropToChat]);

  const saveAiImageToMedia = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ): Promise<boolean> => {
    if (!imageUrl) return false;
    if (!user?.id) { requireSignIn("save to the vault"); return false; }
    if (!(await checkVaultLimit())) return false;

    const result = await saveGeneratedImageToVault({
      userId: user.id,
      imageUrl,
      storagePath: meta?.storagePath,
      mimeType: meta?.mimeType,
      promptText,
      source: "studio_imagine",
      folder: "Generated",
    });

    if (!result.ok) {
      if (result.reason === "duplicate") {
        // Already in vault — treat as success so the UI shows Saved.
        return true;
      }
      if (result.reason !== "cap" && result.reason !== "rate") {
        toast({
          title: "Couldn't save to vault",
          description: result.message || "Please try again.",
        });
      }
      return false;
    }

    incrementVaultCount();
    if (import.meta.env.DEV) console.log("[LYKN] AI image saved to media", result.id);
    try {
      const { queryClientInstance } = await import("@/lib/query-client");
      void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
    } catch { /* vault will refresh on next visit */ }
    return true;
  }, [user?.id, requireSignIn, checkVaultLimit, incrementVaultCount]);

  const saveYouTubeToMedia = useCallback(async (videoId: string, url: string) => {
    if (!videoId) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
    const title = `YouTube Video: ${videoId}`;
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
        .from("vault_items")
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
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving YouTube to media:", err);
    }
  }, [user?.id, routeChatId, chatId, requireSignIn]);

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
        .from("vault_items")
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
          }, { excludeChatId: routeChatId || chatId || undefined });
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving link to media:", err);
    }
  }, [user?.id, routeChatId, chatId, requireSignIn]);

  // Add a URL as a focused chat attachment. Shows the chip instantly, then
  // unfurls Open Graph metadata in the background (unless the Add Link
  // dialog already provided a preview) so the sent message renders the
  // same rich LinkPreview card the Vault shows.
  const addLinkToChat = useCallback((rawUrl: string, preview?: AddLinkPreview | null) => {
    const trimmedUrl = String(rawUrl || preview?.url || "").trim();
    if (!trimmedUrl) return;
    const urlType = inferUrlAttachmentType(trimmedUrl);
    const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
    const attId = makeAttId();
    const hasPreviewMeta = Boolean(
      preview && (preview.title || preview.description || preview.image || preview.siteName),
    );
    addFocusedAttachment({
      id: attId,
      type: urlType,
      url: trimmedUrl,
      name: preview?.title || trimmedUrl,
      mime: "",
      size: 0,
      ...(videoId ? { videoId } : {}),
      ...(hasPreviewMeta
        ? {
            linkTitle: preview?.title || "",
            linkDescription: preview?.description || "",
            linkImage: preview?.image || "",
            linkSiteName: preview?.siteName || "",
            linkFavicon: preview?.favicon || "",
            oembedType: preview?.oembedType || "",
            authorName: preview?.authorName || "",
            authorHandle: preview?.authorHandle || "",
          }
        : {}),
    });
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    if (urlType === "link" && !hasPreviewMeta) {
      void (async () => {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(trimmedUrl)}`);
          if (!res.ok) return;
          const meta = await res.json();
          setFocusedChatAttachments((prev) =>
            prev.map((a) =>
              a.id === attId
                ? {
                    ...a,
                    name: meta?.title || a.name,
                    linkTitle: meta?.title || "",
                    linkDescription: meta?.description || "",
                    linkImage: meta?.image || "",
                    linkSiteName: meta?.siteName || "",
                    linkFavicon: meta?.favicon || "",
                    oembedType: meta?.oembedType || "",
                    authorName: meta?.authorName || "",
                    authorHandle: meta?.authorHandle || "",
                  }
                : a
            )
          );
        } catch { /* unfurl is best-effort; the URL-only card still renders */ }
      })();
    }
  }, [addFocusedAttachment, inferUrlAttachmentType, setFocusedChatAttachments]);

  // --- Chat-bar "+" menu handlers ---------------------------------------
  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAddLinkClick = useCallback(() => {
    // Same panel as Vault → Add link. Electron blocks window.prompt().
    setShowAddLinkDialog(true);
  }, []);

  const handleConfirmAddLink = useCallback((preview: AddLinkPreview) => {
    const url = String(preview?.url || "").trim();
    if (!url) return;
    if (chatMode) {
      addLinkToChat(url, preview);
    } else {
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url, preview } }));
    }
    setShowAddLinkDialog(false);
  }, [chatMode, addLinkToChat]);

  // The vault is the Finder window, so picking from it opens that rather than
  // an embedded copy of the old Vault page. "thread" is what brings the choice
  // back to this chat instead of pushing it at the desktop bar.
  const handlePullFromVault = useCallback(() => {
    openVaultPicker("thread");
  }, []);

  // Open the project picker so the user can scope the chat to a LYKN project.
  const handleSelectProjectClick = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleClearScopedProject = useCallback(() => {
    setChatScopedProject(null);
  }, []);

  // Studio glass pill: each segment is a page view. Switching modes NEVER
  // starts a new chat — the current conversation and its context carry over
  // so the user can e.g. research a topic, then flip to Build and turn the
  // findings into something. Only the armed lane (and the mode tag the next
  // save writes into the snapshot) changes. A fresh empty chat still shows
  // the mode's centered composer + headline; an in-progress chat just keeps
  // going in the new mode.
  const handleStudioModeSelect = useCallback((view: StudioView) => {
    if (view === studioView) return;
    setStudioView(view);
    setComposerMode(view === "chat" ? "none" : STUDIO_VIEW_MODES[view]);
    if (view === "chat") return;
    window.setTimeout(
      () => (chatPanelInputRef.current || centerChatInputRef.current)?.focus(),
      0,
    );
  }, [studioView, setComposerMode, chatPanelInputRef, centerChatInputRef]);

  // Studio "New chat" (top-left icon): same flow as the app sidebar — create
  // the chat row immediately, then navigate this surface to it. The current
  // mode session (Build / Imagine / Research) carries over. Imagine's canvas
  // is cleared up front so it blanks immediately rather than lingering on the
  // old generations until the navigation remounts it.
  const handleStudioNewChat = useCallback(async () => {
    if (studioView === "imagine") {
      window.dispatchEvent(new CustomEvent(IMAGINE_CLEAR_EVENT));
    }
    if (!user?.id) return;
    try {
      const { chatId: freshChatId } = await createNewChat(user.id);
      addOpenThread(freshChatId);
      notifyLyknChatsChanged();
      nav(`/chat/${encodeURIComponent(freshChatId)}`);
    } catch {
      /* chat row creation failed — stay put */
    }
  }, [studioView, user?.id, nav]);

  // Quick-start chip → drop the template into the composer, cursor at the
  // end, ready for the user to finish the sentence. Picking one dismisses
  // the demo strip so it doesn't sit under a prompt that's already started.
  const handleComposerChipInsert = useCallback((text: string) => {
    setStudioChipsDismissed(true);
    setChatInput(text);
    // Hosted on Home the page's own composer is hidden — the desktop's
    // rounded bar listens for this and takes the text instead.
    window.dispatchEvent(
      new CustomEvent("lykn-home-compose-insert", { detail: { text } }),
    );
    window.setTimeout(() => {
      const el = chatPanelInputRef.current || centerChatInputRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* selection is cosmetic */
      }
    }, 0);
  }, [setChatInput, chatPanelInputRef, centerChatInputRef]);

  // Post-report / post-build suggestion: flip to the target Studio mode,
  // arm its lane, and send immediately so the user lands mid-task.
  // Uses handleChatSend (not studioGuardedSend) because we intentionally left
  // the prior lane — the mode-redirect guard would otherwise block the turn.
  // Refs are patched sync before send so the orchestrator and snapshot tag
  // see the new mode even though React state hasn't re-rendered yet.
  const handleStudioFollowUp = useCallback((
    view: StudioView,
    prompt: string,
    opts?: { allowEmptyText?: boolean },
  ) => {
    if (isChatLoading) return;
    const text = String(prompt || "").trim();
    // An attachment-only turn from the home bar arrives with no words;
    // handleChatSend still requires text or an attachment.
    if (!text && !opts?.allowEmptyText) return;
    setStudioView(view);
    setComposerMode(view === "chat" ? "none" : STUDIO_VIEW_MODES[view]);
    studioModeInstructionsRef.current =
      view === "chat" ? "" : STUDIO_VIEW_SYSTEM_PROMPTS[view];
    studioModeSaveRef.current = view === "chat" ? null : view;
    if (view === "imagine") {
      // Attachment-only: keep chips on the shared bar until there's a prompt.
      if (!text) {
        setChatInput("");
        return;
      }
      const ok = imagineRef.current?.generate(
        chatAttachmentsToImagineInput(text, focusedChatAttachments),
      );
      if (ok) {
        setChatInput("");
        setFocusedChatAttachments([]);
      } else {
        setChatInput(text);
      }
      return;
    }
    setChatInput(text);
    void handleChatSend();
  }, [
    isChatLoading,
    setComposerMode,
    setChatInput,
    handleChatSend,
    focusedChatAttachments,
    setFocusedChatAttachments,
  ]);

  // A mode picked from the home desktop must survive chat hydration: the
  // settled chat's saved mode (usually plain "chat") hydrates asynchronously
  // and would otherwise stomp the just-picked page (e.g. Imagine) right
  // before the user's send resolves against it. Recent-only so a stale
  // override can't hijack a chat opened later from the dock popover.
  const homeModeOverrideRef = useRef<{ view: StudioView; at: number } | null>(null);

  // A home-bar send that carried attachments: uploads/text extraction run
  // async and the send reads attachments from state, so the turn is armed here
  // and fired by the effect below once React has committed the chips.
  const pendingHomeAttachSendRef = useRef<
    { view: StudioView; text: string; ready: boolean } | null
  >(null);
  const [homeAttachSendTick, setHomeAttachSendTick] = useState(0);

  // Home-screen chat bar: the Studio desktop stashes {view, text} and flips
  // to this tab. Consume on mount (cold surface) or via the DOM event (warm
  // surface): arm the picked mode and send immediately. Imagine is special —
  // its page owns generation, so re-stash the prompt for it and just switch.
  //
  // IMPORTANT: /app immediately navigates (remounts) to /chat/:id — a send
  // fired before that settles streams into the unmounted instance and never
  // renders. Hold the stash until this instance owns a chat route.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fallback: {
      view?: string;
      text?: string;
      researchSourcePref?: string;
      vaultPayloads?: Record<string, unknown>[];
    } = {}) => {
      let view = String(fallback.view || "");
      let text = String(fallback.text || "");
      let sourcePref = String(fallback.researchSourcePref || "");
      let vaultPayloads = Array.isArray(fallback.vaultPayloads) ? fallback.vaultPayloads : [];
      try {
        const raw = sessionStorage.getItem("lykn_pending_home_chat");
        if (raw) {
          sessionStorage.removeItem("lykn_pending_home_chat");
          const p = JSON.parse(raw) as {
            view?: string;
            text?: string;
            researchSourcePref?: string;
            vaultPayloads?: Record<string, unknown>[];
          };
          view = String(p?.view || view);
          text = String(p?.text || text);
          sourcePref = String(p?.researchSourcePref || sourcePref);
          if (Array.isArray(p?.vaultPayloads)) vaultPayloads = p.vaultPayloads;
        }
      } catch {
        /* storage blocked — fall back to the event payload */
      }
      if (sourcePref) {
        const pref = normalizeResearchSourcePref(sourcePref);
        researchSourcePrefsRef.current = pref;
        setResearchSourcePref(pref);
      }
      text = text.trim();
      // Claimed before the empty-prompt bail so files/folders can't linger
      // and reappear on a later send. A file with no words is a valid turn.
      const homeFiles = takePendingHomeChatFiles();
      const homeFolders = takePendingHomeChatFolders();
      if (!text && !homeFiles.length && !homeFolders.length && !vaultPayloads.length) return;
      // Empty view = follow-up from the home bar mid-conversation: keep
      // whatever mode this surface is currently in (its pill owns it).
      const resolved: StudioView =
        view === "build" || view === "research" || view === "imagine" || view === "chat"
          ? (view as StudioView)
          : ((studioModeSaveRef.current as StudioView) || "chat");
      homeModeOverrideRef.current = { view: resolved, at: Date.now() };
      if (homeFiles.length || homeFolders.length || vaultPayloads.length) {
        pendingHomeAttachSendRef.current = { view: resolved, text, ready: false };
        for (const snap of homeFolders) {
          addFocusedAttachment({
            id: makeAttId(),
            type: "folder",
            url: "",
            name: snap.name,
            mime: "",
            size: 0,
            vaultTitle: snap.name,
            vaultContent: snap.listing,
          });
        }
        const attachmentTasks: Promise<unknown>[] = [];
        if (homeFiles.length) {
          attachmentTasks.push(
            ingestChatFiles(homeFiles, addFocusedAttachment, {
              userId: user?.id,
              updateAttachment: updateFocusedAttachment,
            }),
          );
        }
        for (const vaultPayload of vaultPayloads) {
          attachmentTasks.push(applyVaultDropToChat(vaultPayload));
        }
        if (attachmentTasks.length) {
          void Promise.all(attachmentTasks).finally(() => {
            if (pendingHomeAttachSendRef.current) pendingHomeAttachSendRef.current.ready = true;
            setHomeAttachSendTick((t) => t + 1);
          });
        } else {
          pendingHomeAttachSendRef.current.ready = true;
          setHomeAttachSendTick((t) => t + 1);
        }
        return;
      }
      handleStudioFollowUp(resolved, text);
    };
    consume();
    const onSend = (e: Event) =>
      consume(((e as CustomEvent).detail || {}) as {
        view?: string;
        text?: string;
        researchSourcePref?: string;
        vaultPayloads?: Record<string, unknown>[];
      });
    window.addEventListener("lykn-home-chat-send", onSend);
    return () => window.removeEventListener("lykn-home-chat-send", onSend);
  }, [
    routeChatId, handleStudioFollowUp, setComposerMode,
    addFocusedAttachment, updateFocusedAttachment, user?.id,
    applyVaultDropToChat,
  ]);

  // The armed home-bar send, fired on the render that commits the last
  // attachment so handleChatSend's closure includes it. Same shape as the
  // brick-action auto-send in useChatEngine.
  useEffect(() => {
    const pending = pendingHomeAttachSendRef.current;
    if (!pending?.ready) return;
    pendingHomeAttachSendRef.current = null;
    handleStudioFollowUp(pending.view, pending.text, { allowEmptyText: true });
  }, [homeAttachSendTick, focusedChatAttachments.length, handleStudioFollowUp]);

  // Home-pill mode click (no send yet): flip this surface straight to the
  // picked mode page so its elements show immediately. Storage covers a
  // cold mount, the event covers the warm surface. Same /app→/chat/:id
  // settling rule as sends — a view set pre-remount would be lost.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fallback = "") => {
      let view = fallback;
      try {
        const raw = sessionStorage.getItem("lykn_pending_home_view") || "";
        if (raw) {
          sessionStorage.removeItem("lykn_pending_home_view");
          view = raw;
        }
      } catch {
        /* storage blocked — fall back to the event payload */
      }
      if (view === "chat" || view === "build" || view === "imagine" || view === "research") {
        homeModeOverrideRef.current = { view: view as StudioView, at: Date.now() };
        handleStudioModeSelect(view as StudioView);
      }
    };
    consume();
    const onView = (e: Event) =>
      consume(String((e as CustomEvent).detail?.view || ""));
    window.addEventListener("lykn-home-view", onView);
    return () => window.removeEventListener("lykn-home-view", onView);
  }, [routeChatId, handleStudioModeSelect]);

  useEffect(() => {
    openArtifactRef.current = activeArtifact;
  }, [activeArtifact]);

  // Which app installing would update, read off the build on screen rather than
  // held per chat: a chat that goes on to build something else produces an
  // untagged artifact, and offering to update the old app there is how a new
  // app once overwrote a different one.
  const editingAppId = activeArtifact?.installedAppId || null;

  const appSourceStrip = useMemo(() => {
    if (voiceModeOn) return null;
    if (editingAppName) {
      return { appName: editingAppName, paths: [] as string[], loading: true };
    }
    if (editingAppId && activeArtifact) {
      const paths = (Array.isArray(activeArtifact.files) ? activeArtifact.files : [])
        .map((f) => String((f as { path?: string })?.path || ""))
        .filter(Boolean);
      return {
        appName: String(activeArtifact.title || "this app"),
        paths,
        loading: false,
      };
    }
    return null;
  }, [voiceModeOn, editingAppName, editingAppId, activeArtifact]);

  // Switching to Build re-renders `handleStudioModeSelect`, which would restart
  // the effect below — the one that just asked for it. Through a ref so the
  // effect depends on the chat and nothing else.
  const studioModeSelectRef = useRef(handleStudioModeSelect);
  studioModeSelectRef.current = handleStudioModeSelect;
  useEffect(() => () => { editAppChatRef.current = null; }, []);

  // Chat + app this surface has already read the source for, so the extra runs
  // that come with hydration don't each fire their own rebuild.
  const appEditLoadRef = useRef<string>("");

  // "Edit in Build mode" on an installed app: attach its real source so the
  // next message patches the app rather than starting a new one. The preview
  // panel stays closed — Edit is Build mode, not pulling the live app up.
  // The dock stashes the app id before opening chat; this is the surface
  // that mounts afterwards and picks it up.
  useEffect(() => {
    if (!routeChatId) return;
    editAppChatRef.current = routeChatId;
    // Liveness is the chat this ran for, held in a ref: an effect-scoped flag
    // would be tripped by the surface's own re-renders and strand a load that
    // is still perfectly valid.
    const stillOurs = () => editAppChatRef.current === routeChatId;

    const enterBuild = (appId: string) => {
      homeModeOverrideRef.current = { view: "build", at: Date.now() };
      studioModeSelectRef.current("build");
      // Claimed before the source arrives, so a build that lands in the
      // meantime is recognised as this app's next version rather than a
      // second copy of it.
      linkArtifactApp(routeChatId, appId);
    };
    const attach = (appId: string, artifact: ChatArtifact) => {
      enterBuild(appId);
      setActiveArtifact(artifact);
    };

    /**
     * Read an app's current source and attach it for Build mode to edit.
     *
     * Reading is a store round-trip, so Build mode and the "Opening …" strip
     * go up first: until this, the click spent that whole time looking like
     * it had done nothing at all. The live app is not opened.
     */
    const load = (appId: string, name: string, announce: boolean) => {
      const key = `${routeChatId}:${appId}`;
      if (appEditLoadRef.current === key) return;
      appEditLoadRef.current = key;
      if (announce) setEditingAppName(name || "this app");
      void appEditArtifactById(appId)
        .then((artifact) => {
          if (!stillOurs()) return;
          if (appEditLoadRef.current !== key) return;
          setEditingAppName(null);
          if (artifact) {
            // A build already on screen is newer than what was installed —
            // reopening must not throw away work not yet installed.
            if (!announce && openArtifactRef.current) return;
            attach(appId, artifact);
            return;
          }
          // Uninstalled, or no source saved for it. Either way this is an
          // ordinary Build chat now — installing must not aim at an app that
          // is not there.
          appEditLoadRef.current = "";
          forgetAppEdit(routeChatId);
          linkArtifactApp(routeChatId, null);
          if (announce) {
            toast({
              title: "Couldn't open that app",
              description: `${name || "That app"} has no source saved on this device.`,
            });
          }
        })
        .catch(() => {
          // Left retryable: reopening the chat should have another go rather
          // than treating one failed read as the app being unopenable.
          if (appEditLoadRef.current !== key) return;
          appEditLoadRef.current = "";
          if (!stillOurs()) return;
          setEditingAppName(null);
          if (announce) {
            toast({
              title: "Couldn't open that app",
              description: "Reading its source failed. Please try again.",
            });
          }
        });
    };

    const pending = takePendingAppEdit();
    if (pending) {
      rememberAppEdit(routeChatId, pending.appId);
      if (pending.artifact) {
        attach(pending.appId, pending.artifact);
      } else {
        enterBuild(pending.appId);
        load(pending.appId, pending.name || "", true);
      }
      return;
    }

    // Reopening the chat later: the handoff is long gone, so read the app's
    // current source back off disk. Whatever it says now is the truth to edit,
    // including changes made from another chat.
    const linked = recallAppEdit(routeChatId);
    if (linked) {
      linkArtifactApp(routeChatId, linked);
      load(linked, "", false);
    }
  }, [routeChatId, setActiveArtifact, linkArtifactApp]);

  const handleDismissAppEdit = useCallback(() => {
    const chatId = String(routeChatId || "").trim();
    appEditLoadRef.current = "";
    setEditingAppName(null);
    if (chatId) {
      forgetAppEdit(chatId);
      linkArtifactApp(chatId, null);
    }
    const current = openArtifactRef.current;
    if (!current) return;
    if (isAppEditSeed(current) || current.installedAppId) {
      if (isAppEditSeed(current)) {
        setActiveArtifact(null);
      } else {
        const next = { ...current };
        delete next.installedAppId;
        setActiveArtifact(next);
      }
    }
  }, [routeChatId, linkArtifactApp, setActiveArtifact]);

  useEffect(() => subscribeDismissAppEdit(handleDismissAppEdit), [handleDismissAppEdit]);

  // Home-bar voice button: turn Voice Mode on. Storage covers a cold mount,
  // the event covers the warm surface (turning voice OFF happens inside the
  // voice overlay itself). Waits out the /app→/chat/:id settle like sends.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fromEvent = false) => {
      let pending = fromEvent;
      try {
        if (sessionStorage.getItem("lykn_pending_voice_mode") === "1") {
          sessionStorage.removeItem("lykn_pending_voice_mode");
          pending = true;
        }
      } catch {
        /* storage blocked — the event alone still turns voice on */
      }
      if (pending) setVoiceMode(true);
    };
    consume();
    const onVoice = () => consume(true);
    window.addEventListener("lykn-home-voice-toggle", onVoice);
    return () => window.removeEventListener("lykn-home-voice-toggle", onVoice);
  }, [routeChatId, setVoiceMode]);

  // Home-bar Research sources dropdown: apply before send so the
  // orchestrator reads the picked focus (academic / news / markets…).
  useEffect(() => {
    const apply = (raw: unknown) => {
      const pref = normalizeResearchSourcePref(raw);
      researchSourcePrefsRef.current = pref;
      setResearchSourcePref(pref);
    };
    const consume = (fallback = "") => {
      let next = fallback;
      try {
        const stored = sessionStorage.getItem("lykn_pending_research_sources");
        if (stored) {
          sessionStorage.removeItem("lykn_pending_research_sources");
          next = stored;
        }
      } catch {
        /* storage blocked — the event payload still applies */
      }
      if (next) apply(next);
    };
    consume();
    const onPref = (e: Event) =>
      consume(String((e as CustomEvent).detail?.pref || ""));
    window.addEventListener("lykn-home-research-sources", onPref);
    return () => window.removeEventListener("lykn-home-research-sources", onPref);
  }, []);

  // Let the Studio shell react to voice mode (it hides the home desktop's
  // rounded bar while the voice overlay is up).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("lykn-voice-mode-changed", { detail: { on: voiceModeOn } }),
    );
  }, [voiceModeOn]);

  // Tell the Studio shell which mode page is up — on the Imagine page the
  // desktop's rounded bar steps aside for Imagine's own full prompt bar.
  useEffect(() => {
    if (!isGlassChat) return;
    window.dispatchEvent(
      new CustomEvent("lykn-studio-view-changed", { detail: { view: studioView } }),
    );
  }, [studioView, isGlassChat]);

  // Home pill lives outside this page, so the editing chips have to be
  // published for it — the in-page composer is hidden while hosted.
  useEffect(() => {
    publishAppSourceStrip(appSourceStrip);
  }, [appSourceStrip]);
  useEffect(() => () => publishAppSourceStrip(null), []);

  // Tell the Studio shell whether a conversation is actually under way —
  // the home desktop's rounded bar stays centered on fresh pages and only
  // docks to the bottom once turns exist. Imagine shares this thread, so
  // the same signal covers every mode. Editing an installed app is still
  // a fresh Build page until the first message.
  const hasChatTurns = chatMessages.length > 0;
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("lykn-chat-activity-changed", {
        detail: { active: hasChatTurns },
      }),
    );
  }, [hasChatTurns]);

  useEffect(() => {
    setStudioChipsDismissed(false);
  }, [studioView]);

  useEffect(() => {
    if (!hasChatTurns) setStudioChipsDismissed(false);
  }, [hasChatTurns]);

  // Mode sessions are sticky: useChatEngine auto-clears composerMode after
  // every send, so while a mode page is active re-arm it — each turn keeps
  // the forced tool lane (build / image / research) until the user switches
  // the pill. Armed "+"-menu modes (e.g. web) are respected and not overridden;
  // once they clear on send, the page's own mode re-arms.
  useEffect(() => {
    if (studioView === "chat" || composerMode !== "none") return;
    setComposerMode(STUDIO_VIEW_MODES[studioView]);
  }, [studioView, composerMode, setComposerMode]);

  // Chats remember their Studio mode session: when a saved build / imagine /
  // research chat hydrates, reopen the matching page view (pill, headline,
  // armed lane); plain chats land back on the normal Chat view. Assigned
  // every render so the persistence hook always calls the fresh closure.
  studioModeHydratedCbRef.current = (mode: string | null) => {
    if (!isGlassChat) return;
    // A mode just picked on the home desktop wins over the chat's saved
    // mode — hydration lands moments after the pick and would stomp it.
    const override = homeModeOverrideRef.current;
    if (override && Date.now() - override.at < 15000) {
      homeModeOverrideRef.current = null;
      setStudioView(override.view);
      setComposerMode(
        override.view === "chat" ? "none" : STUDIO_VIEW_MODES[override.view],
      );
      return;
    }
    homeModeOverrideRef.current = null;
    const m: StudioView =
      mode === "build" || mode === "imagine" || mode === "research" ? mode : "chat";
    setStudioView(m);
    setComposerMode(m === "chat" ? "none" : STUDIO_VIEW_MODES[m]);
  };

  // Voice mode is always a regular chat conversation: entering it from a
  // Build / Imagine / Research page drops the mode page and disarms the
  // pill-armed composer mode so the voice session behaves like plain chat.
  useEffect(() => {
    if (!voiceModeOn || studioView === "chat") return;
    setStudioView("chat");
    setComposerMode("none");
  }, [voiceModeOn, studioView, setComposerMode]);

  // Latest research turn in this chat: report text + the source links the
  // deep-research pipeline streamed (the rail fills in live mid-stream).
  const latestResearch = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i] as any;
      const report = String(m.aiResponse || "").trim();
      if (!report) continue;
      const sources = Array.isArray(m?.sources)
        ? (m.sources as { title: string; url: string }[])
        : [];
      // On the Research page, the latest finished reply owns the rail even
      // when live search returned nothing — otherwise hideMessageSources
      // leaves the report with no citations UI at all.
      if (sources.length || studioView === "research") {
        return {
          sources,
          report,
          topic: String(m.content || "").trim(),
        };
      }
    }
    return null;
  }, [chatMessages, studioView]);

  const [researchReportSaving, setResearchReportSaving] = useState(false);
  const handleSaveResearchReport = useCallback(async () => {
    if (researchReportSaving) return;
    const research = latestResearch;
    if (!research?.report) return;
    if (!user?.id) { requireSignIn("save the report"); return; }
    if (!(await checkVaultLimit())) return;
    setResearchReportSaving(true);
    try {
      const topic = research.topic.replace(/\s+/g, " ").slice(0, 80);
      const title = topic ? `Research report — ${topic}` : "Research report";
      const sourcesBlock = research.sources.length
        ? `\n\nSources:\n${research.sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}`
        : "";
      const content = `${research.report}${sourcesBlock}`;
      let noteId: string | null = null;
      const { data: ins, error } = await supabase
        .from("vault_items")
        .insert({ user_id: user.id, title, content, source: "research_report" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) return;
        // Older schema without a `source` column — retry plain.
        const { data: ins2, error: err2 } = await supabase
          .from("vault_items")
          .insert({ user_id: user.id, title, content })
          .select("id")
          .single();
        if (err2) {
          if (!notifyVaultCapIfApplicable(err2)) {
            toast({ title: "Couldn't save report", description: "Please try again." });
          }
          return;
        }
        noteId = ins2?.id ?? null;
      } else {
        noteId = ins?.id ?? null;
      }
      if (noteId) {
        afterVaultNoteSaved(user.id, noteId, { title, content }, {
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
      toast({ title: "Report saved to vault", description: title });
    } catch {
      toast({ title: "Couldn't save report", description: "Please try again." });
    } finally {
      setResearchReportSaving(false);
    }
  }, [researchReportSaving, latestResearch, user?.id, requireSignIn, checkVaultLimit, routeChatId, chatId]);

  /**
   * Save a file the user attached to a chat turn into the vault as its own
   * downloaded copy: pull the bytes from wherever they currently live (data
   * URL, signed URL, device blob, or the original File still in memory), write
   * them to a fresh `{userId}/{fileId}/original.{ext}` object, and hand the
   * result to the shared upload path so the card looks and behaves like any
   * other file in the vault — right type, tags, extracted text, embedding.
   *
   * The chat attachment keeps pointing at its own copy, so deleting the vault
   * card can never blank an image out of the transcript.
   */
  const saveAttachmentToMedia = useCallback(async (
    att: FocusedChatAttachment,
    opts?: { source?: string; quiet?: boolean },
  ) => {
    if (!att) return false;
    if (!user?.id) { requireSignIn("save to the vault"); return false; }
    if (!(await checkVaultLimit())) return false;
    // Background saves (voice paste) report nothing — the user didn't ask for
    // this one and a toast per pasted file would bury the conversation.
    const say = opts?.quiet
      ? () => {}
      : (title: string, description?: string) => toast({ title, description });

    const kind = chatAttachmentKind(att);
    if (kind === "link") {
      const linkUrl = String(att.url || "").trim();
      if (!linkUrl) return false;
      await saveLinkToMedia(linkUrl);
      return true;
    }

    const filename = chatAttachmentFilename(att);
    const blob = await fetchChatAttachmentBlob(att);
    if (!blob) {
      say("Couldn't save to vault", "This file's contents are no longer available.");
      return false;
    }

    const mimeType = blob.type || String(att.mime || "") || "application/octet-stream";
    const ext =
      filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ||
      mimeType.split("/")[1]?.replace("jpeg", "jpg") ||
      "bin";
    const storagePath = `${user.id}/${crypto.randomUUID()}/original.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("user-files")
      .upload(storagePath, blob, { cacheControl: "3600", upsert: false, contentType: mimeType });
    if (uploadError) {
      notifyVaultCapIfApplicable(uploadError);
      say("Couldn't save to vault", "The upload didn't finish. Please try again.");
      return false;
    }
    const { data: signedData } = await supabase.storage
      .from("user-files")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

    const fileType = chatAttachmentFileType(att);
    const result = await saveFileToVault({
      userId: user.id,
      filename,
      fileType,
      fileUrl: signedData?.signedUrl || "",
      storagePath,
      storageBucket: "user-files",
      fileSize: blob.size,
      mimeType,
      extractedText: chatAttachmentText(att),
      source: opts?.source || "chat_attachment",
      tags: [fileType, "uploaded"],
    });

    if (!result.ok) {
      if (result.reason === "duplicate") return true;
      if (result.reason !== "cap" && result.reason !== "rate") {
        say("Couldn't save to vault", result.message || "Please try again.");
      }
      return false;
    }

    incrementVaultCount();
    say("Saved to vault", filename);
    try {
      const { queryClientInstance } = await import("@/lib/query-client");
      void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
    } catch { /* vault will refresh on next visit */ }
    return true;
  }, [user?.id, requireSignIn, checkVaultLimit, incrementVaultCount, saveLinkToMedia]);

  // Save an AI-built artifact (deck / document / chart / file) from the side
  // panel into the vault. Documents & decks save the human-friendly PDF when
  // one exists; charts/images save the image; websites / React artifacts prefer
  // the in-memory srcDoc (avoids cross-origin fetch failures on branded /f/
  // proxy URLs that still work as <a download> navigations). The bytes are
  // copied into the user's own storage so the vault note keeps a permanent,
  // re-signable copy instead of a 7-day proxy link.
  //
  // Called only on explicit user intent (Save button). Refines and code edits
  // upsert the same vault note (keyed by chat + tool + title) so only the
  // latest version is kept instead of stacking every intermediate edit.
  type SavedArtifactVault = {
    noteId: string;
    fileId: string;
    storagePath: string;
    ext: string;
    contentKey: string;
  };
  const savedArtifactVaultRef = useRef<Map<string, SavedArtifactVault>>(new Map());
  const artifactVaultChatKeyRef = useRef<string>("");
  useEffect(() => {
    const key = chatId || routeChatId || "";
    if (artifactVaultChatKeyRef.current === key) return;
    artifactVaultChatKeyRef.current = key;
    savedArtifactVaultRef.current.clear();
  }, [chatId, routeChatId]);

  const saveArtifactToVault = useCallback(async (
    artifact: ChatArtifact,
    opts?: { auto?: boolean },
  ): Promise<boolean> => {
    if (!artifact) return false;
    if (!user?.id) {
      if (!opts?.auto) requireSignIn("save to the vault");
      return false;
    }

    const title = (artifact.title || "Artifact").trim() || "Artifact";
    const chatScope = chatId || routeChatId || "local";
    const lineageKey = `${chatScope}:${artifact.toolName || "artifact"}:${title.toLowerCase()}`;
    const existing = savedArtifactVaultRef.current.get(lineageKey);

    // Cap check only for new inserts — updates replace an existing card.
    if (!existing && !(await checkVaultLimit())) return false;

    // Generated images already live in user-files — reuse the path so Vault
    // gets a durable card without re-downloading the proxy URL.
    if (artifact.kind === "image" && !existing) {
      const imageUrl = artifact.previewUrl || artifact.downloadUrl || "";
      const path = typeof artifact.storagePath === "string" ? artifact.storagePath.trim() : "";
      if (imageUrl || path) {
        const result = await saveGeneratedImageToVault({
          userId: user.id,
          imageUrl: imageUrl || path,
          storagePath: path || undefined,
          promptText: title,
          source: "ai_artifact",
          folder: "Generated",
        });
        if (result.ok) {
          incrementVaultCount();
          savedArtifactVaultRef.current.set(lineageKey, {
            noteId: result.id,
            fileId: path.split("/")[1] || result.id,
            storagePath: path || "",
            ext: (artifact.format || "png").toLowerCase(),
            contentKey: `image|${path || imageUrl}`,
          });
          try {
            const { queryClientInstance } = await import("@/lib/query-client");
            void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
          } catch { /* vault will refresh on next visit */ }
          if (!opts?.auto) {
            toast({ title: "Saved to vault", description: title });
          }
          return true;
        }
        if (result.reason === "duplicate") {
          if (!opts?.auto) toast({ title: "Already in vault", description: title });
          return true;
        }
        if (!opts?.auto && result.reason !== "cap" && result.reason !== "rate") {
          toast({ title: "Couldn't save", description: result.message || "Please try again." });
        }
        return false;
      }
    }

    const downloads = artifact.downloads || [];
    const pdf = downloads.find((d) => String(d.format).toLowerCase() === "pdf");
    const htmlDownload = downloads.find((d) => String(d.format).toLowerCase() === "html");

    let blob: Blob | null = null;
    let filename = "";
    let mimeType = "";

    const useSrcDoc = () => {
      if (!artifact.srcDoc) return false;
      blob = new Blob([artifact.srcDoc], { type: "text/html;charset=utf-8" });
      filename = artifact.filename || `${title}.html`;
      if (!/\.html?$/i.test(filename)) filename = `${filename}.html`;
      mimeType = "text/html;charset=utf-8";
      return true;
    };

    try {
      if (artifact.kind !== "image" && pdf) {
        const res = await fetch(pdf.url);
        if (res.ok) blob = await res.blob();
        filename = pdf.filename || `${title}.pdf`;
        mimeType = "application/pdf";
      }
      // Prefer inline HTML for website / deck / React artifacts — no network,
      // immune to CORS on the API file proxy. Only skip when we already have a PDF.
      if (!blob && artifact.kind === "html" && artifact.srcDoc) {
        useSrcDoc();
      }
      if (!blob) {
        const url =
          artifact.previewUrl ||
          artifact.downloadUrl ||
          htmlDownload?.url ||
          downloads[0]?.url ||
          "";
        if (url) {
          try {
            const res = await fetch(url);
            if (res.ok) blob = await res.blob();
          } catch { /* CORS / network — fall through to srcDoc */ }
          if (blob?.size) {
            const fmt = String(
              artifact.format || htmlDownload?.format || downloads[0]?.format || "",
            ).toLowerCase();
            const ext = fmt || (blob.type?.split("/")[1]) || "bin";
            filename =
              artifact.filename ||
              htmlDownload?.filename ||
              downloads[0]?.filename ||
              `${title}.${ext}`;
            mimeType = blob.type || "";
          }
        }
      }
      // URL fetch failed or missing — still have the live preview markup.
      if (!blob?.size) useSrcDoc();
      // React artifacts: last resort save the component source.
      if (!blob?.size && typeof artifact.code === "string" && artifact.code.trim()) {
        const base = (artifact.filename || title).replace(/\.[a-z0-9]+$/i, "");
        blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
        filename = `${base}.jsx`;
        mimeType = "text/plain;charset=utf-8";
      }
    } catch { /* network/CORS — handled below */ }

    if (!blob || !blob.size) {
      if (!opts?.auto) {
        toast({ title: "Couldn't save", description: "Try the Download button instead." });
      }
      return false;
    }
    if (!mimeType) mimeType = blob.type || "application/octet-stream";

    // Skip no-op re-saves of the exact same bytes (e.g. StrictMode double-mount).
    const contentKey = [
      blob.size,
      mimeType,
      filename,
      (artifact.srcDoc || artifact.code || "").length,
      artifact.previewUrl || artifact.downloadUrl || "",
      artifact.toolCallId || artifact.id || "",
    ].join("|");
    if (existing && existing.contentKey === contentKey) return true;

    // Classify the attachment so the vault renders the right card.
    // HTML/React artifacts must be "html" (iframe preview), not generic "file".
    const m = mimeType.toLowerCase().split(";")[0].trim();
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isHtmlArtifact =
      (["html", "htm"].includes(ext) || m === "text/html") &&
      !["jsx", "tsx", "js", "ts"].includes(ext);
    const fileType = isHtmlArtifact
      ? "html"
      : m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
        ? "image"
        : m === "application/pdf" || ext === "pdf"
          ? "pdf"
          : m.includes("spreadsheetml") || m === "text/csv" || ["xlsx", "csv", "xls"].includes(ext)
            ? "spreadsheet"
            : "file";

    try {
      const safeExt = ext || "bin";
      const fileId = existing && existing.ext === safeExt ? existing.fileId : crypto.randomUUID();
      const storagePath =
        existing && existing.ext === safeExt
          ? existing.storagePath
          : `${user.id}/${fileId}/artifact.${safeExt}`;
      const { error: uploadError } = await supabase.storage
        .from("user-files")
        .upload(storagePath, blob, {
          cacheControl: "3600",
          upsert: Boolean(existing && existing.ext === safeExt),
          contentType: mimeType,
        });
      if (uploadError) {
        notifyVaultCapIfApplicable(uploadError);
        if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
        return false;
      }
      const { data: signedData } = await supabase.storage
        .from("user-files")
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      let fileUrl = signedData?.signedUrl || "";
      // HTML artifacts preview in a sandboxed iframe — mint a branded
      // file-proxy URL so Content-Type / frame-ancestors are correct
      // (raw Supabase signed URLs often blank the vault preview).
      if (fileType === "html") {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const session = (await supabase.auth.getSession())?.data?.session;
          const token = session?.access_token;
          if (token) {
            const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                storagePath,
                bucket: "user-files",
                filename,
              }),
            });
            if (resp.ok) {
              const { url } = await resp.json();
              if (url) fileUrl = url;
            }
          }
        } catch {
          /* keep Supabase signed URL fallback */
        }
      }

      const attachment = [{
        type: fileType,
        url: fileUrl,
        name: filename,
        fileId,
        storagePath,
        storageBucket: "user-files",
        size: blob.size,
        mimeType,
      }];
      const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;

      // Through the repository rather than straight at Supabase: an artifact
      // written past it lands somewhere AI Drive never reads once the user has
      // moved their vault onto this device.
      const writes = createVaultWrites(user.id);
      // `folder` and `source` are re-stamped on update as well as insert, so
      // an artifact saved over a row that predates them gets filed properly
      // the first time it changes.
      const filing = {
        source: "ai_artifact",
        folder: "Generated",
        tags: [fileType, "generated"],
      };

      let noteId = existing?.noteId || "";
      if (existing?.noteId) {
        const { error } = await writes.update(existing.noteId, {
          title,
          content: noteContent,
          ...filing,
          updated_at: new Date().toISOString(),
        });
        if (error) {
          if (notifyVaultCapIfApplicable(error)) return false;
          if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
          return false;
        }
      } else {
        const { data: ins, error } = await insertWithSchemaFallback(
          (row) => writes.insert(row),
          { title, content: noteContent, ...filing },
          ["title", "content"],
        );
        if (error) {
          if (notifyVaultCapIfApplicable(error)) return false;
          if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
          return false;
        }
        noteId = ins?.id || "";
      }

      if (noteId) {
        savedArtifactVaultRef.current.set(lineageKey, {
          noteId,
          fileId,
          storagePath,
          ext: safeExt,
          contentKey,
        });
        afterVaultNoteSaved(user.id, noteId, { title, content: noteContent }, {
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
      if (!opts?.auto) {
        toast({
          title: existing ? "Updated in vault" : "Saved to vault",
          description: title,
        });
      }
      return true;
    } catch {
      if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
      return false;
    }
  }, [user?.id, routeChatId, chatId, requireSignIn, checkVaultLimit, incrementVaultCount]);


  // Sticky-mode lane guard: explicit deliverable requests on the Build /
  // Imagine / Research pages route down that page's pipeline, so a clearly
  // out-of-lane commission (e.g. "generate an image of a dog" on Research)
  // could run the wrong pipeline before the model could object. Catch
  // it before dispatch and answer instantly with a pointer to the mode
  // pills at the top of the page instead of wasting a full pipeline run.
  const studioGuardedSend = useCallback(async () => {
    if (isGlassChat && studioView !== "chat") {
      const text = chatInputRef.current.trim();
      const redirect = text ? detectStudioModeRedirect(text, studioView) : null;
      if (redirect) {
        const CURRENT_LABEL: Record<string, string> = { build: "Build", imagine: "Imagine", research: "Research" };
        const LANE_DESC: Record<string, string> = {
          build: "builds apps and artifacts",
          imagine: "generates images",
          research: "writes research reports",
        };
        const ASK_KIND: Record<string, string> = {
          build: "a build request",
          imagine: "an image request",
          research: "a research request",
        };
        const notice =
          `That looks like ${ASK_KIND[redirect.target]}, and this ${CURRENT_LABEL[studioView]} page only ` +
          `${LANE_DESC[studioView]}. Switch to **${redirect.label}** using the pills at the top of the page ` +
          `and send it again — I'll take it from there.`;
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `mode-guard-${Date.now().toString(36)}`;
        setChatMessages((prev) => [
          ...prev,
          { id, role: "user", content: text, aiResponse: notice, kind: "prompt" } as unknown as PromptMessage,
        ]);
        try {
          aiThreadRef.current = [
            ...(aiThreadRef.current || []),
            { role: "user", content: text },
            { role: "assistant", content: notice },
          ];
        } catch { /* ignore */ }
        setChatInput("");
        return;
      }
      if (studioView === "imagine") {
        if (!text) return;
        const ok = imagineRef.current?.generate(
          chatAttachmentsToImagineInput(text, focusedChatAttachments),
        );
        if (ok) {
          setChatInput("");
          setFocusedChatAttachments([]);
        }
        return;
      }
    }
    await handleChatSend();
  }, [
    isGlassChat,
    studioView,
    chatInputRef,
    setChatMessages,
    aiThreadRef,
    setChatInput,
    handleChatSend,
    focusedChatAttachments,
    setFocusedChatAttachments,
  ]);

  const handleCenterAskSend = useCallback(async () => {
    if ((!chatInputRef.current.trim() && focusedChatAttachments.length === 0) || isChatLoading) return;
    setChatRailOpen(true);
    setChatRailVisible(true);
    setCenterChatLeaving(false);
    await studioGuardedSend();
  }, [studioGuardedSend, isChatLoading, chatInputRef, focusedChatAttachments.length]);


  const chatIsNearBottom = useCallback((threshold = 80) => {
    const el = chatScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  // The scroll container only exists in the conversation branch of the view —
  // it mounts when the first message arrives (and remounts after any switch
  // through an empty thread). Re-run the listener effect on that transition,
  // otherwise the detach listeners never bind and the streaming stick-to-bottom
  // fights the user's scroll for the entire response.
  const chatHasMessages = chatMessages.length > 0;

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
    // Detach/re-attach must be ASYMMETRIC. Detaching is handled eagerly by
    // the intent events above (wheel up, touch, keys) and by scrollbar drags
    // below. Re-attaching only happens when the user deliberately scrolls
    // DOWN and reaches the bottom. The previous handler recomputed
    // "scrolled up = distance > 120" on EVERY scroll event, so the first few
    // pixels of an upward scroll (still within 120px of the bottom) flipped
    // the flag back to "attached" and the 30ms streaming tick snapped the
    // thread to the bottom — making it impossible to scroll while the AI
    // was typing.
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const goingDown = top > lastScrollTop;
      lastScrollTop = top;
      const distance = el.scrollHeight - top - el.clientHeight;
      if (chatProgrammaticScrollRef.current) {
        chatProgrammaticScrollRef.current = false;
        // Our stick-to-bottom always lands at the very bottom; if this scroll
        // ended anywhere else it was actually the user (e.g. scrollbar drag
        // racing a streaming tick), so fall through and treat it as theirs.
        if (distance <= 4) return;
      }
      if (chatUserScrolledUpRef.current) {
        if (goingDown && distance <= 60) chatUserScrolledUpRef.current = false;
      } else if (distance > 120) {
        // Catches scrollbar drags, which emit no wheel/touch/key events.
        chatUserScrolledUpRef.current = true;
      }
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
  }, [chatMode, chatRailVisible, chatIsNearBottom, chatHasMessages]);

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
    // Land the user directly in the composer (ChatGPT/Claude-style) with no
    // extra tap. The composer can mount a frame or two after chatMode flips
    // (especially on mobile entry), so retry focus briefly until it's there.
    // Note: iOS Safari only raises the soft keyboard from a user gesture, so
    // on iOS this places the cursor; Android/installed PWAs open the keyboard.
    const timers: number[] = [];
    const tryFocus = (attempt: number) => {
      const el = chatPanelInputRef.current;
      if (el) {
        el.focus();
        return;
      }
      if (attempt < 6) {
        timers.push(window.setTimeout(() => tryFocus(attempt + 1), 50));
      }
    };
    timers.push(window.setTimeout(() => tryFocus(0), 0));
    return () => timers.forEach((t) => window.clearTimeout(t));
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
    window.addEventListener("lyknchat_interact", handleCanvasInteract);
    return () => {
      window.removeEventListener("lyknchat_interact", handleCanvasInteract);
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

      const st = useLyknChatStore.getState();
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
            chatId: routeChatId || chatId || undefined,
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

    window.addEventListener("lyknchat_source_toggled", handleSourceToggled);
    return () => window.removeEventListener("lyknchat_source_toggled", handleSourceToggled);
  }, [chatMessages, selectedModel, calcAiBubbleSize, extractSourceLinksLocal, normalizeAiTextForBlock, updateBlock]);


  const canvasFileBlocks = useMemo(() => {
    if (!chatMode && !notesOpen) return [];
    const st = useLyknChatStore.getState();
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
    if (t === "folder") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <FolderIcon className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "Folder"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if ((t === "link" || t === "bookmark") && att.url) {
      return (
        <div className="relative w-44 group">
          <LinkPreview
            url={att.url}
            title={att.linkTitle || att.name || ""}
            description={att.linkDescription || ""}
            image={att.linkImage || ""}
            siteName={att.linkSiteName || ""}
            favicon={att.linkFavicon || ""}
            authorName={att.authorName || ""}
            authorHandle={att.authorHandle || ""}
            oembedType={att.oembedType || ""}
            variant="vault"
          />
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"><X className="w-3 h-3" /></button>
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

    const vaultRaw = e.dataTransfer.getData("application/x-lykn-chat-vault");
    if (vaultRaw) {
      try {
        const payload = JSON.parse(vaultRaw) as Record<string, unknown>;
        (window as any).__lyknchat_pending_vault = null;
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
    // Materialized synchronously: the FileList dies with the event.
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      void ingestChatFiles(files, addFocusedAttachment, {
        userId: user?.id,
        updateAttachment: updateFocusedAttachment,
      });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment, applyVaultDropToChat, updateFocusedAttachment, user?.id]);


  // Voice Mode is only offered on "main model agents": the default LYKN
  // model (no custom model active) or the user's main-agent orchestrator.
  // Model-Builder custom/sub agents are excluded for the MVP.
  const voiceModeEligible = !activeCustomModelId || isMainAgentChat;

  // Switching to an ineligible model while voice mode is on silently exits
  // voice mode so the chat can't get stuck speaking on an unsupported agent.
  useEffect(() => {
    if (!voiceModeEligible && voiceModeOn) setVoiceMode(false);
  }, [voiceModeEligible, voiceModeOn, setVoiceMode]);

  // Assemble the LYKN-grounded system instructions for a realtime voice
  // session from the same workspace/KB context the text chat uses, plus the
  // recent conversation so voice picks up where the user left off.
  const buildVoiceInstructions = useCallback(async (): Promise<string> => {
    // The server caps the whole client grounding at 8000 chars. We budget here
    // so the WRITTEN CHAT conversation is guaranteed to survive: it used to be
    // appended last and got truncated away entirely behind a long workspace
    // summary, so voice couldn't actually "see" the chat the user was having.
    const MAX = 7800;
    const parts: string[] = [];
    let used = 0;
    const push = (s: string) => {
      const text = String(s || "").trim();
      if (!text) return;
      const remaining = MAX - used;
      if (remaining <= 0) return;
      const clipped = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text;
      parts.push(clipped);
      used += clipped.length + 2; // +2 for the "\n\n" join separator
    };

    // User preferences (custom assistant name + voice feel) ride along in the
    // session grounding, which is appended after the base instructions so a
    // rename / tone directive here overrides the default "you are LYKN" persona.
    const voicePrefs = getAiPrefs() as { aiName?: string; voicePrompt?: string };
    const aiName = voicePrefs.aiName || "LYKN";
    if (voicePrefs.aiName) {
      push(`Your name is now "${voicePrefs.aiName}". Always refer to yourself as "${voicePrefs.aiName}" instead of "LYKN".`);
    }
    if (voicePrefs.voicePrompt) {
      push(`How the user wants you to sound and behave in voice conversations — follow this:\n${String(voicePrefs.voicePrompt).slice(0, 1500)}`);
    }
    const boardTitle = String(titleRef.current || title || "").trim();
    if (boardTitle) push(`The user's current workspace is titled "${boardTitle}".`);

    // Conversation FIRST among the large blocks (after prefs): this is the chat
    // the user was just having, and the whole point of voice is to continue it
    // seamlessly. Pushed before workspace/KB so the budget can never starve it.
    try {
      const recent = (chatMessagesRef.current || []).slice(-24);
      const convo = recent
        .map((m) => {
          const atts = Array.isArray((m as { attachments?: { name?: string; type?: string }[] }).attachments)
            ? (m as { attachments?: { name?: string; type?: string }[] }).attachments || []
            : [];
          const attNote = atts.length
            ? ` [shared: ${atts.map((a) => a?.name || a?.type || "file").slice(0, 5).join(", ")}]`
            : "";
          const lines: string[] = [];
          if (m.content || attNote) lines.push(`User: ${String(m.content || "").slice(0, 800)}${attNote}`);
          if (m.aiResponse) lines.push(`${aiName}: ${String(m.aiResponse).slice(0, 800)}`);
          return lines.join("\n");
        })
        .filter(Boolean)
        .join("\n");
      if (convo) {
        push(`The written chat conversation in this workspace so far (oldest first, most recent last) — pick it up naturally and reference earlier points when relevant:\n${convo.slice(0, 5000)}`);
      }
    } catch { /* ignore */ }

    // Workspace + KB fill whatever budget the conversation left. Generous caps;
    // the running budget trims them down (and gives them MORE room on a fresh
    // chat with little/no conversation yet).
    try {
      const ws = getCachedWorkspaceSummary()?.full;
      if (ws) push(`Workspace & memory summary:\n${String(ws).slice(0, 6000)}`);
    } catch { /* ignore */ }
    try {
      const kb = typeof getCachedKbText === "function" ? getCachedKbText() : "";
      const kbText = typeof kb === "string" ? kb : String((kb as { text?: string })?.text || "");
      if (kbText) push(`Relevant saved knowledge:\n${kbText.slice(0, 4000)}`);
    } catch { /* ignore */ }

    return parts.join("\n\n");
  }, [title, getCachedWorkspaceSummary, getCachedKbText]);

  // Voice Mode persists each finalized turn into the chat thread so the full
  // conversation is waiting in the text chat when the user switches back. The
  // live transcript is intentionally NOT shown in the voice UI; this is the
  // single source of truth for what was said.
  const voiceTurnIdRef = useRef<string | null>(null);
  const lastVoiceUserTextRef = useRef<string>("");
  const newMsgId = useCallback(
    () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `voice-${Date.now().toString(36)}`),
    [],
  );

  // A vault document the voice agent pulled up on screen (display_document).
  // Rendered in the embedded reader above the voice overlay; null when closed.
  const handleVoiceDisplayDocument = useCallback((payload: unknown) => {
    const p = payload as { ok?: boolean; kind?: string } | null;
    if (p && p.ok && p.kind === "vault") {
      openLyknMediaPop({ type: "vault-payload", payload: p });
    }
  }, []);

  const handleVoiceUserTranscript = useCallback((text: string) => {
    const content = String(text || "").trim();
    if (!content) return;
    const id = newMsgId();
    voiceTurnIdRef.current = id;
    lastVoiceUserTextRef.current = content;
    const msg = { id, role: "user", content, kind: "prompt", viaVoice: true } as unknown as PromptMessage;
    setChatMessages((prev) => [...prev, msg]);
    try { aiThreadRef.current = [...(aiThreadRef.current || []), { role: "user", content }]; } catch { /* ignore */ }
  }, [newMsgId, setChatMessages, aiThreadRef]);

  const handleVoiceAssistantReply = useCallback((text: string) => {
    const reply = String(text || "").trim();
    if (!reply) return;
    const pendingId = voiceTurnIdRef.current;
    setChatMessages((prev) => {
      const target = pendingId ? prev.find((m) => m.id === pendingId) : null;
      // Attach the reply to the pending user turn when it has none yet;
      // otherwise (assistant spoke first, or a follow-up) start a fresh turn.
      if (target && !target.aiResponse) {
        return prev.map((m) => (m.id === pendingId ? { ...m, aiResponse: reply } : m));
      }
      const id = newMsgId();
      return [...prev, { id, role: "user", content: "", aiResponse: reply, kind: "prompt", viaVoice: true } as unknown as PromptMessage];
    });
    voiceTurnIdRef.current = null;
    try { aiThreadRef.current = [...(aiThreadRef.current || []), { role: "assistant", content: reply }]; } catch { /* ignore */ }
    // Auto-name the chat from this voice exchange exactly like a typed turn
    // would, so voice-only conversations show a real title in history
    // instead of being stuck on "New Chat".
    try {
      maybeAutoNameChat({
        chatId: routeChatId || chatId,
        userId: user?.id,
        currentTitle: titleRef.current,
        userMessage: lastVoiceUserTextRef.current,
        assistantReply: reply,
      });
    } catch { /* auto-name is cosmetic */ }
  }, [newMsgId, setChatMessages, aiThreadRef, routeChatId, chatId, titleRef, user?.id]);

  // Paste / attach from Voice Mode. The voice overlay captures the clipboard
  // (or a file pick / drop / link) and hands us the raw inputs. We run them
  // through the SAME ingestion the typed composer uses, mirror the result into
  // the written chat as a `viaVoice` turn (so the conversation stays in sync),
  // and return a text summary the caller injects into the live voice session
  // as a contextual update — that's how the agent gets to "see" the paste.
  const handleVoiceAttach = useCallback(async (
    input: { files?: File[]; text?: string },
  ): Promise<string> => {
    const collected: FocusedChatAttachment[] = [];
    const add = (att: FocusedChatAttachment) => { collected.push(att); };
    const update = (id: string, patch: Record<string, unknown>) => {
      const i = collected.findIndex((a) => a.id === id);
      if (i >= 0) collected[i] = { ...collected[i], ...patch };
    };

    const rawText = String(input?.text || "").trim();
    const isBareUrl = /^https?:\/\/\S+$/i.test(rawText) && !/\s/.test(rawText);
    let noteText = isBareUrl ? "" : rawText;

    // Files → attachments (images/pdf/docs/spreadsheets/audio/video), reusing
    // the shared picker/paste pipeline (text extraction + background upload).
    try {
      if (input?.files?.length) {
        await ingestChatFiles(input.files, add as never, {
          userId: user?.id,
          updateAttachment: update as never,
        });
      }
    } catch { /* ingestion is best-effort */ }

    // A pasted URL becomes a link/youtube/media attachment, unfurled for the
    // agent so it gets the page title + description, not just a bare URL.
    if (isBareUrl) {
      const urlType = inferUrlAttachmentType(rawText);
      const videoId = urlType === "youtube" ? (extractYouTubeVideoId(rawText) || "") : "";
      const linkAtt: FocusedChatAttachment = {
        id: makeAttId(), type: urlType, url: rawText, name: rawText, mime: "", size: 0,
        ...(videoId ? { videoId } : {}),
      };
      if (urlType === "link") {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(rawText)}`);
          if (res.ok) {
            const meta = await res.json();
            linkAtt.name = meta?.title || linkAtt.name;
            (linkAtt as Record<string, unknown>).linkTitle = meta?.title || "";
            (linkAtt as Record<string, unknown>).linkDescription = meta?.description || "";
            (linkAtt as Record<string, unknown>).linkImage = meta?.image || "";
            (linkAtt as Record<string, unknown>).linkSiteName = meta?.siteName || "";
            (linkAtt as Record<string, unknown>).linkFavicon = meta?.favicon || "";
          }
        } catch { /* unfurl is best-effort */ }
      }
      collected.push(linkAtt);
    }

    if (!collected.length && !noteText) return "";

    // OCR pasted images so the voice agent can read text inside them (the live
    // voice LLM is text-only; the image itself still rides into the written
    // chat where the vision model can see it on the next typed turn).
    try {
      await ocrImageAttachments(collected as never, new AbortController().signal, () => {});
    } catch { /* OCR is additive, never blocking */ }

    // Describe pasted IMAGES with a vision model. The realtime voice LLM is
    // text-only and can't fetch the image url, so without a written
    // description a photo (no OCR text) is completely invisible to it — the
    // agent would say it "can't see images". We hand each image's data url to
    // /api/ai/describe-image and stash the 2-3 sentence result on the
    // attachment so buildAttachmentContext can fold it into what the agent
    // "sees" this turn.
    try {
      const imageAtts = collected.filter(
        (a) => (a.type || "").toLowerCase() === "image" && !a.aiDescription && a.url,
      );
      if (imageAtts.length) {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const { supabase } = await import("@/lib/supabase");
        let authHeader: Record<string, string> = {};
        try {
          const sess = await supabase?.auth?.getSession?.();
          const token = sess?.data?.session?.access_token;
          if (token) authHeader = { Authorization: `Bearer ${token}` };
        } catch { /* anonymous — endpoint may still allow */ }
        await Promise.all(
          imageAtts.map(async (att) => {
            try {
              const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeader },
                body: JSON.stringify({ imageUrl: att.url, fileType: "image", fileName: att.name }),
              });
              if (!res.ok) return;
              const data = await res.json().catch(() => null);
              const description = String(data?.description || "").trim();
              if (description) att.aiDescription = description;
            } catch { /* description is additive, never blocking */ }
          }),
        );
      }
    } catch { /* vision description is best-effort */ }

    // Mirror into the written chat as a shared (no-response) user turn so the
    // pasted content shows up in the conversation exactly like a typed attach.
    const id = newMsgId();
    const fallbackLabel = collected.length === 1
      ? `Shared ${collected[0].name || "a file"}`
      : collected.length > 1
        ? `Shared ${collected.length} files`
        : "";
    const mirrorMsg = {
      id,
      role: "user",
      content: noteText || fallbackLabel,
      kind: "prompt",
      viaVoice: true,
      ...(collected.length ? { attachments: collected } : {}),
    } as unknown as PromptMessage;
    setChatMessages((prev) => [...prev, mirrorMsg]);
    try {
      const threadNote = [noteText, buildAttachmentContext(collected)].filter(Boolean).join("\n");
      aiThreadRef.current = [...(aiThreadRef.current || []), { role: "user", content: threadNote || fallbackLabel }];
    } catch { /* ignore */ }

    // Auto-save everything pasted into the voice paste bar to the vault,
    // reusing the same side-rail "Save to Vault" helpers so pasted files and
    // links persist permanently instead of living only inside this voice
    // conversation. Fire-and-forget: it must not block the contextual update
    // the agent is waiting on, and each item is best-effort on its own.
    if (user?.id && collected.length) {
      void (async () => {
        for (const att of collected) {
          const t = (att.type || "").toLowerCase();
          try {
            if (t === "youtube" && att.videoId) {
              await saveYouTubeToMedia(att.videoId, att.url || "");
            } else if (t === "link" || t === "bookmark") {
              if (att.url) await saveLinkToMedia(att.url);
            } else {
              // Images already carry a downscaled data URL; documents/audio/
              // video have no URL, so fall back to the original File bytes.
              const rawFile =
                att.rawFile || (input?.files || []).find((file) => file.name === att.name);
              // Keep the voice source tag: the voice `add_to_project` tool
              // resolves "add this to my <project>" by looking up the most
              // recent vault row saved with it.
              await saveAttachmentToMedia(rawFile ? { ...att, rawFile } : att, {
                source: "lykn-voice-attachment",
                quiet: true,
              });
            }
          } catch { /* per-item best-effort */ }
        }
      })();
    }

    // Context the voice agent "sees": a note + extracted/ocr/link text.
    const parts: string[] = [];
    if (noteText) parts.push(`The user pasted this into the chat: ${noteText}`);
    const attachCtx = buildAttachmentContext(collected);
    if (attachCtx) {
      parts.push(
        `The user just shared the following in the chat. Treat it as context for the conversation.${attachCtx}`,
      );
    }
    return parts.join("\n\n");
  }, [user?.id, newMsgId, setChatMessages, aiThreadRef, saveYouTubeToMedia, saveLinkToMedia, saveAttachmentToMedia]);

  const chatBarToolbarProps = useMemo(() => ({
    chatInputHasText, hasAttachments: focusedChatAttachments.length > 0,
    isChatLoading, isDictating, isTranscribing,
    modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
    handleOpenAttachments, handleStopAi, handleDictateToggle,
    handlePickFiles, handleAddLinkClick, handlePullFromVault,
    handleSelectProjectClick, scopedProjectName: chatScopedProject?.name ?? null, handleClearScopedProject,
    composerMode, setComposerMode,
    // Studio mode pages announce the mode in the top pill + headline; the
    // in-bar blue chip only shows for modes armed outside the pill (e.g. web).
    hideComposerModeChip:
      isGlassChat &&
      studioView !== "chat" &&
      composerMode === STUDIO_VIEW_MODES[studioView],
    showResearchSourceSelect:
      (isGlassChat && studioView === "research") || composerMode === "research",
    researchSourcePref,
    onResearchSourcePrefChange: setResearchSourcePref,
  }), [
    chatInputHasText, focusedChatAttachments.length,
    isChatLoading, isDictating, isTranscribing,
    modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
    handleOpenAttachments, handleStopAi, handleDictateToggle,
    handlePickFiles, handleAddLinkClick, handlePullFromVault,
    handleSelectProjectClick, chatScopedProject, handleClearScopedProject,
    composerMode, setComposerMode,
    isGlassChat, studioView,
    researchSourcePref,
  ]);

  const handleCloseSideRail = useCallback(() => {
    setChatRailVisible(false);
    setChatRailOpen(false);
  }, []);

  const handleSideRailSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleSideRailSaveAttachment = useCallback((att: FocusedChatAttachment) => {
    void saveAttachmentToMedia(att);
    setSavedMediaUrls((p) => new Set([...p, ...chatAttachmentSaveKeys(att)]));
  }, [saveAttachmentToMedia]);

  const handleSideRailSaveAiImage = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => {
    const ok = await saveAiImageToMedia(imageUrl, promptText, meta);
    if (ok) setSavedMediaUrls((p) => new Set(p).add(imageUrl));
    return ok;
  }, [saveAiImageToMedia]);

  const handleSideRailSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleSideRailReplay = useCallback((msg: Parameters<typeof replaySavedPromptResponse>[0]) => {
    void replaySavedPromptResponse(msg);
  }, [replaySavedPromptResponse]);

  const handleSideRailCopyMessage = useCallback((msgId: string, text: string) => {
    void copyMarkdownAsRich(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

  // Imagine finished a batch. It becomes an ordinary turn in this chat, which
  // is what lets its images survive a reload and lets the conversation read as
  // one thread no matter which mode produced each turn.
  const handleImagineBatchCommit = useCallback((commit: ImagineCommit) => {
    if (!commit.images.length) return;
    const current = chatMessagesRef.current || [];
    // Switching Imagine ↔ Chat remounts the canvas; skip a batch already
    // written into this thread so the turn is not appended again.
    const already = current.some((m) => {
      const batchId = (m as { imagine?: { batchId?: string } }).imagine?.batchId;
      if (batchId && batchId === commit.id) return true;
      const imgs = Array.isArray((m as { aiImages?: { url?: string }[] }).aiImages)
        ? (m as { aiImages: { url?: string }[] }).aiImages
        : [];
      if (!imgs.length) return false;
      const samePrompt = String(m.content || "").trim() === String(commit.prompt || "").trim();
      const sameImages =
        imgs.length === commit.images.length &&
        imgs.every((img, i) => img?.url && img.url === commit.images[i]?.url);
      return samePrompt && sameImages;
    });
    if (already) return;
    const count = commit.images.length;
    const verb =
      commit.kind === "refine" ? "Refined" : commit.kind === "variations" ? "Varied" : "Generated";
    const note = `${verb} ${count} image${count === 1 ? "" : "s"}.`;
    const stamp = new Date().toISOString();
    const turn = {
      id: newMsgId(),
      role: "user",
      content: commit.prompt,
      kind: "prompt",
      createdAt: stamp,
      aiResponse: note,
      aiCompletedAt: stamp,
      aiImages: commit.images,
      imagine: {
        aspect: commit.aspectRatio,
        kind: commit.kind,
        batchId: commit.id,
        ...(commit.concept && commit.concept !== commit.prompt
          ? { concept: commit.concept }
          : {}),
      },
    } as unknown as PromptMessage;

    const next = [...(chatMessagesRef.current || []), turn];
    chatMessagesRef.current = next;
    setChatMessages(next);
    // Model-facing history, so a later chat turn can refer back to what was
    // drawn here rather than treating the images as if they never happened.
    const rebuilt = [
      ...(aiThreadRef.current || []),
      { role: "user" as const, content: commit.prompt },
      { role: "assistant" as const, content: note },
    ];
    aiThreadRef.current = rebuilt.length > 40 ? rebuilt.slice(rebuilt.length - 40) : rebuilt;
    // The send path reads history from the per-chat runtime snapshot rather
    // than React state, so it has to be told separately.
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, { chatMessages: next, aiThread: [...aiThreadRef.current] });
    }
    try {
      window.dispatchEvent(new Event("lyknchat_flush_save"));
    } catch { /* the debounced autosave still covers this */ }
  }, [newMsgId, setChatMessages, chatMessagesRef, aiThreadRef, routeChatId, chatId]);

  /** Past Imagine turns in this chat, replayed onto the canvas after a reload. */
  const imagineSeedBatches = useMemo(
    () => imagineBatchesFromTurns(chatMessages as unknown as Parameters<typeof imagineBatchesFromTurns>[0]),
    [chatMessages],
  );

  // Earlier Imagine remounts wrote the same batch into the thread again.
  // Drop those copies the next time the conversation is shown as chat.
  useEffect(() => {
    if (studioView === "imagine") return;
    const msgs = chatMessagesRef.current || [];
    const seen = new Set<string>();
    const next = msgs.filter((m) => {
      const imgs = Array.isArray((m as { aiImages?: { url?: string }[] }).aiImages)
        ? (m as { aiImages: { url?: string }[] }).aiImages.filter((i) => i?.url)
        : [];
      if (!imgs.length) return true;
      const sig = `${String(m.content || "").trim()}\n${imgs.map((i) => i.url).join("\n")}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    if (next.length === msgs.length) return;
    chatMessagesRef.current = next;
    setChatMessages(next);
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, { chatMessages: next, aiThread: [...(aiThreadRef.current || [])] });
    }
    try {
      window.dispatchEvent(new Event("lyknchat_flush_save"));
    } catch { /* autosave still covers this */ }
  }, [studioView, chatMessages, setChatMessages, chatMessagesRef, aiThreadRef, routeChatId, chatId]);

  const handleFocusedChatSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleFocusedChatSaveAttachment = useCallback((att: FocusedChatAttachment) => {
    void (async () => {
      const ok = await saveAttachmentToMedia(att);
      if (!ok) return;
      // Keyed by storage path first: signed URLs are re-minted on every reload,
      // so a url-only key would forget the save and offer it again.
      setSavedMediaUrls((p) => new Set([...p, ...chatAttachmentSaveKeys(att)]));
    })();
  }, [saveAttachmentToMedia]);

  const handleFocusedChatSaveAiImage = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => {
    const ok = await saveAiImageToMedia(imageUrl, promptText, meta);
    if (ok) setSavedMediaUrls((p) => new Set(p).add(imageUrl));
    return ok;
  }, [saveAiImageToMedia]);

  const handleFocusedChatSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleFocusedChatCopyMessage = useCallback((msgId: string, text: string) => {
    void copyMarkdownAsRich(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

  const handleFocusedChatReaction = useCallback((msgId: string, kind: "like" | "dislike") => {
    const nextRating = chatReactions[msgId] === kind ? null : kind;
    setChatReactions((prev) => ({ ...prev, [msgId]: nextRating }));
    const msg: any = chatMessages.find((m) => m.id === msgId);
    void persistMessageFeedback({
      messageId: msgId,
      rating: nextRating,
      chatId: routeChatId || null,
      model: msg?.model || selectedModel || null,
      prompt: msg?.content || msg?.prompt || null,
      response: msg?.aiResponse || null,
    });
  }, [chatReactions, chatMessages, routeChatId, selectedModel]);

  // Edit a sent prompt: drop the edited turn and everything after it, rebuild
  // the model-facing thread from the surviving history, then re-send the
  // edited text as a fresh turn (edit-and-resend; no version tree yet).
  const handleFocusedChatEditResend = useCallback((msgId: string, newText: string) => {
    const next = String(newText || "").trim();
    if (!next) return;
    const current = chatMessagesRef.current || [];
    const idx = current.findIndex((m) => m.id === msgId);
    const truncated = idx >= 0 ? current.slice(0, idx) : current;
    chatMessagesRef.current = truncated;
    setChatMessages(truncated);
    // Rebuild aiThread from the surviving turns so the model context matches
    // the visible history (mirrors the import rebuild above), capped at 40.
    const rebuilt = truncated.flatMap((p) =>
      p.aiResponse
        ? [
            { role: "user" as const, content: p.content },
            { role: "assistant" as const, content: p.aiResponse },
          ]
        : [{ role: "user" as const, content: p.content }],
    );
    aiThreadRef.current = rebuilt.length > 40 ? rebuilt.slice(rebuilt.length - 40) : rebuilt;
    // CRITICAL: the send path reads history from the per-chat runtime
    // snapshot, not from React state — and its reconcile pass only merges
    // when React is LONGER than the snapshot. Without patching the snapshot
    // here, the pre-edit turns come back on the next send and the model
    // still sees the full un-truncated conversation.
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, {
        chatMessages: truncated,
        aiThread: [...aiThreadRef.current],
      });
    }
    pendingAiBrickActionRef.current = true;
    setChatInput(next);
  }, [setChatMessages, setChatInput, routeChatId, chatId]);

  // Regenerate = truncate at the regenerated turn and re-send the same
  // prompt. Going through the edit-resend path keeps React state, the
  // model-facing thread, AND the runtime snapshot in sync — the previous
  // React-only clear left the old answer in the snapshot, so the send
  // appended a duplicate user bubble and the model still saw the old reply.
  const handleFocusedChatRegenerate = useCallback((msgId: string, content: string) => {
    handleFocusedChatEditResend(msgId, content);
  }, [handleFocusedChatEditResend]);

  const handleFocusedChatRegenerateNonUser = useCallback((msgId: string, idx: number) => {
    const prevUserMsg = chatMessages.slice(0, idx).reverse().find((m) => m.role === "user");
    if (prevUserMsg) {
      handleFocusedChatEditResend(prevUserMsg.id, prevUserMsg.content);
    }
  }, [chatMessages, handleFocusedChatEditResend]);

  const handleVaultOverlayDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setVaultDragActive(false);
    window.dispatchEvent(new CustomEvent("lyknchat_interact"));
    const pending = (window as any).__lyknchat_pending_vault;
    if (import.meta.env.DEV) console.log("[VAULT-DROP] overlay onDrop fired");
    if (!pending || typeof pending !== "object") { if (import.meta.env.DEV) console.log("[VAULT-DROP] no pending data"); return; }
    (window as any).__lyknchat_pending_vault = null;

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
      dropOverNotes = !!(under && (under as Element).closest("[data-lykn-chat-notes-root]"));
    }

    if (dropOverNotes) {
      window.dispatchEvent(
        new CustomEvent("lyknchat_notes_insert_vault", {
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
    // viewport position. Now we look up the canonical `[data-lykn-chat-canvas]`
    // node and use the scroll-based formula directly (no dependence on
    // possibly-stale camera.x/y).
    const SURFACE_ORIGIN_PAD = 10000; // mirrors Canvas.tsx SURFACE_ORIGIN_PAD_WORLD
    const worldFromClient = (clientX: number, clientY: number) => {
      const st = useLyknChatStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const z = Number(st.camera?.zoom) || 1;
      const canvasEl = document.querySelector<HTMLElement>("[data-lykn-chat-canvas]");
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
        const st = useLyknChatStore.getState();
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
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: socialAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    if (imageAttach?.url) {
      if (imageAttach.url.startsWith("data:image/")) {
        const f = toFile(imageAttach.url, imageAttach.name || "image.png");
        if (f) { window.dispatchEvent(new CustomEvent("lyknchat_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
      }
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: imageAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    if (videoAttach?.url) {
      if (videoAttach.url.startsWith("data:video/")) {
        const f = toFile(videoAttach.url, videoAttach.name || "video.mp4");
        if (f) { window.dispatchEvent(new CustomEvent("lyknchat_attach_files", { detail: { files: [f], clientX: cx, clientY: cy } })); return; }
      }
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: videoAttach.url, clientX: cx, clientY: cy } }));
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
          const st = useLyknChatStore.getState();
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
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: linkAttach.url, clientX: cx, clientY: cy } }));
      return;
    }

    const content = String(pending.content || "");
    const urlMatch = content.match(/https?:\/\/[^\s<>"')]+/i);
    if (urlMatch) {
      window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: urlMatch[0], clientX: cx, clientY: cy } }));
      return;
    }

    window.dispatchEvent(
      new CustomEvent("lyknchat_attach_vault_text", { detail: { title: pending.title, content: pending.content, clientX: cx, clientY: cy } })
    );
  }, [notesOpen, chatMode, applyVaultDropToChat]);

  const handleConnectionCardClick = useCallback(async (conn: { title: string; sourceType: "board" | "media"; reason: string }) => {
    if (conn.sourceType === "board") {
      const cached = getCachedWorkspaceSummary()?.full || "";
      const boardMatch = cached.match(new RegExp(`"${conn.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
      const connChatId = boardMatch?.[1];
      if (connChatId) {
        try {
          const { data } = await supabase
            .from("lykn_chat_states")
            .select("state")
            .eq("chat_id", connChatId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const snapshot = data?.state as any;
          if (snapshot?.blocks && snapshot?.blockOrder) {
            const st = useLyknChatStore.getState();
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
        .from("vault_items")
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

      const st = useLyknChatStore.getState() as any;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const niVw = window.innerWidth || 1280;
      const niVh = window.innerHeight || 800;

      const niPos = (bw: number, bh: number) => {
        const cur = useLyknChatStore.getState() as any;
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
            st.addBlock({ id: blockId, type: "text" as const, x: p.x, y: p.y, width: g * 10, height: g * 4, content: stripAttachmentsMarker(note.content || ""), format: "rich", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
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

  return (
    <div className={`w-full relative overflow-hidden lykn-chat-grid-bg ${isEmbeddedMode || studioSurface ? "h-full min-h-0" : "h-[100svh]"}`}>
      {/* Match BrickEditor layout: minimal chrome + floating controls. */}
      {!isEmbeddedMode && (
      <LyknChatToolbar
        isMobilePhone={isMobilePhone}
        notesOpen={notesOpen}
        voiceModeEligible={voiceModeEligible}
        voiceModeOn={voiceModeOn}
        onVoiceModeToggle={toggleVoiceMode}
      />
      )}

      {/* Studio glass shell: mode selector pill pinned top-center with the
          New-chat button right beside it. Hidden while the voice overlay is
          up — voice is always plain chat. */}
      {isGlassChat && !voiceModeOn && (
        <StudioModePill
          activeView={studioView}
          onSelect={handleStudioModeSelect}
          onNewChat={handleStudioNewChat}
        />
      )}

      <LyknChatVoiceMode
        open={voiceModeOn}
        onClose={() => setVoiceMode(false)}
        chatId={chatId}
        buildInstructions={buildVoiceInstructions}
        onUserTranscript={handleVoiceUserTranscript}
        onAssistantReply={handleVoiceAssistantReply}
        onDisplayDocument={handleVoiceDisplayDocument}
        onAttach={handleVoiceAttach}
      />

      {vaultDragActive && (
        <LyknChatVaultOverlay
          onDrop={handleVaultOverlayDrop}
          onDeactivate={() => setVaultDragActive(false)}
        />
      )}

      {/* Phone-only grids drawer for focused chat. Lets users browse and
          create grids without leaving chat-only mobile mode. */}
      {chatMode && isMobilePhone && <MobileLyknChat />}

      {/* Studio Imagine overlay — mask editor, empty-page showcase, and
          in-flight 4-ups. The conversation and composer stay on LyknChatView
          so switching modes keeps both. */}
      {chatMode && isGlassChat && !voiceModeOn && (
        <StudioImagineMode
          ref={imagineRef}
          chatKey={String(routeChatId || chatId || "")}
          seedBatches={imagineSeedBatches}
          onCommitBatch={handleImagineBatchCommit}
          onPullVault={handlePullFromVault}
          onSaveImage={handleFocusedChatSaveAiImage}
          savedUrls={savedMediaUrls}
          sharedThread
          hasThread={hasChatTurns}
          visible={studioView === "imagine"}
          onAttachReference={(dataUrl, name) => {
            addFocusedAttachment({
              id: makeAttId(),
              type: "image",
              url: dataUrl,
              name,
              mime: "image/png",
              size: 0,
            });
          }}
        />
      )}

      {/* Focused chat mode — centered, below top panel, no overlay */}
      {chatMode && (
        <LyknChatView
          chatMessages={chatMessages}
          isChatLoading={isChatLoading}
          thinkingStatus={thinkingStatus}
          keepThinkingWhileLoading={keepBuildThinking}
          chatInputRef={chatInputRef}
          onChatInputChange={handleChatInputChange}
          onSend={studioGuardedSend}
          typedWelcome={
            isGlassChat && studioView !== "chat"
              ? STUDIO_VIEW_HEADLINES[studioView]
              : typedWelcome
          }
          welcomeSubtitle={
            isGlassChat && studioView !== "chat"
              ? STUDIO_VIEW_SUBTITLES[studioView]
              : undefined
          }
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
          onOpenGeneratedImage={
            studioView === "imagine"
              ? (img) => imagineRef.current?.openEdit(img)
              : undefined
          }
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
          chatBarToolbar={
            <LyknChatBarToolbar
              onSend={studioGuardedSend}
              {...chatBarToolbarProps}
            />
          }
          chatReactions={chatReactions}
          onReaction={handleFocusedChatReaction}
          onRegenerate={handleFocusedChatRegenerate}
          onEditResend={handleFocusedChatEditResend}
          onRegenerateNonUser={handleFocusedChatRegenerateNonUser}
          onLoadInGreetingRefresh={refreshLoadInGreetingInPlace}
          // Research page shows the source links in the right rail, so the
          // per-message chips under the report would be duplicates.
          hideMessageSources={isGlassChat && studioView === "research"}
          researchSidebar={
            // Appears once the report has finished streaming — not while
            // LYKN is still researching/writing.
            isGlassChat &&
            studioView === "research" &&
            !isChatLoading &&
            !!latestResearch?.report ? (
              <StudioResearchSidebar
                sources={latestResearch.sources}
                canSave={!!latestResearch.report}
                saving={researchReportSaving}
                onSave={handleSaveResearchReport}
              />
            ) : null
          }
          activeArtifact={activeArtifact}
          onActiveArtifactChange={setActiveArtifact}
          onSaveArtifact={saveArtifactToVault}
          editingAppId={editingAppId}
          chatKey={chatId || routeChatId || ""}
          onFactNeuronChange={(msgId, next) => {
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, factNeuron: next || undefined }
                  : m,
              ),
            );
          }}
          composerInside={
            appSourceStrip ? (
              <AppSourceStrip
                compact
                appName={appSourceStrip.appName}
                paths={appSourceStrip.paths}
                loading={appSourceStrip.loading}
                onDismiss={handleDismissAppEdit}
              />
            ) : null
          }
          composerAbove={
            (isGlassChat && studioView === "research" && !voiceModeOn) ||
            (isGlassChat &&
              studioView === "build" &&
              !voiceModeOn &&
              !hasChatTurns &&
              !studioChipsDismissed &&
              !appSourceStrip) ||
            (chatMode && isMainAgentChat && CUSTOM_MODELS_ENABLED) ? (
              <>
                {isGlassChat &&
                studioView === "research" &&
                !voiceModeOn &&
                !isChatLoading &&
                !!latestResearch?.report ? (
                  <StudioFollowUpSuggestions
                    items={researchFollowUpItems(latestResearch.topic)}
                    disabled={isChatLoading}
                    onSelect={handleStudioFollowUp}
                  />
                ) : isGlassChat &&
                  (studioView === "research" || studioView === "build") &&
                  !voiceModeOn &&
                  !hasChatTurns &&
                  !studioChipsDismissed &&
                  !appSourceStrip ? (
                  <StudioComposerStrip
                    view={studioView}
                    onInsert={handleComposerChipInsert}
                  />
                ) : null}
                {chatMode && isMainAgentChat && CUSTOM_MODELS_ENABLED ? (
                  <SubAgentTasksStrip chatId={chatId} enabled={isMainAgentChat} />
                ) : null}
              </>
            ) : null
          }
          composerPlaceholder={
            isGlassChat ? STUDIO_COMPOSER_PLACEHOLDERS[studioView] : undefined
          }
        />
      )}

      <AddLinkDialog
        open={showAddLinkDialog}
        onClose={() => setShowAddLinkDialog(false)}
        title="Add link to chat"
        confirmLabel="Add to chat"
        confirmingLabel="Adding..."
        onConfirm={handleConfirmAddLink}
      />

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
                setShowAttachMenu(false);
                setShowAddLinkDialog(true);
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
                                if (chatMode) {
                                  addLinkToChat(file.url);
                                } else {
                                  window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: file.url } }));
                                }
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                window.dispatchEvent(
                                  new CustomEvent("lyknchat_attach_files", {
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
                                if (chatMode) {
                                  addLinkToChat(file.url);
                                } else {
                                  window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: file.url } }));
                                }
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                window.dispatchEvent(
                                  new CustomEvent("lyknchat_attach_files", {
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
        </DialogContentAny>
      </DialogAny>

      {/* Hidden file input — kept OUTSIDE the attach dialog so the "+" menu's
          "Add photos & files" can trigger it directly without opening a modal. */}
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
            void ingestChatFiles(files, addFocusedAttachment, {
              userId: user?.id,
              updateAttachment: updateFocusedAttachment,
            });
          } else {
            window.dispatchEvent(new CustomEvent("lyknchat_attach_files", { detail: { files } }));
          }
          e.target.value = "";
          setShowAttachMenu(false);
        }}
      />

      <LyknChatToasts
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

      <FileDropModeDialog />

      <LyknChatProjectPicker
        open={projectPickerOpen}
        onOpenChange={setProjectPickerOpen}
        userId={user?.id}
        activeProjectId={chatScopedProject?.id ?? null}
        onSelect={setChatScopedProject}
      />

    </div>
  );
}

