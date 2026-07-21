import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import { useLyknChatStore } from "@/store/lyknChatStore";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { supabase } from "@/lib/supabase";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { ChatCodeBlock } from "@/components/lyknChat/ChatCodeBlock";
import { buildTieredLyknChatContext, buildActionLyknChatContext } from "@/lib/ai/buildLyknChatContext";
import { getVaultSidebarWidth } from "@/hooks/useViewportTier";
import { getBlockDefinition } from "@/lyknChat/blockSystem/definitions";
import type { UniversalBlockType } from "@/lyknChat/blockSystem/types";
import { createDatabaseBlockData } from "@/lyknChat/blockSystem/notionModel";
import { detectSocialPlatform, isSocialEmbedType } from "@/lib/media/socialEmbed";
import {
  orchestrateChatSend,
  buildAttachmentContext,
  type PromptMessage,
  type FocusedChatAttachment,
  type CreateAction,
  type OrchestratorResult,
  type ChatSendParams,
} from "@/lib/ai/chatSendOrchestrator";
import { type ChatArtifact, toArtifactEditContext, isEditableArtifact } from "@/lib/ai/chatArtifacts";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { isDemoLyknChatId } from "@/lib/demoLyknChats";
import { toast } from "@/components/ui/use-toast";
import { parseAttachmentsFromContent } from "@/lib/vault/attachmentsMarker";
import { AI_TEMPORARY_FAILURE_TEXT, AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import {
  addOpenThread,
  bindThreadStateCallbacks,
  ensureThreadSnapshot,
  getActiveThreadChatId,
  getThreadSnapshot,
  hydrateActiveThreadToReact,
  patchThreadSnapshot,
  registerStreamAbortController,
  setActiveThreadChatId,
  snapshotActiveThreadFromReact,
} from "@/lib/chat/chatThreadRuntime";

export type { PromptMessage, FocusedChatAttachment, CreateAction, OrchestratorResult };

/** "+" menu capability mode applied to the next chat send. */
// Artifact kinds buildable from the "+" → Create submenu (claude.ai-style).
export type ArtifactKind = "deck" | "study" | "document" | "worksheet" | "spreadsheet" | "chart" | "diagram" | "webapp";
export type ComposerMode = "none" | "image" | "web" | "research" | `create:${ArtifactKind}`;

/* ------------------------------------------------------------------ */
/*  Shared utility functions (moved from LyknChat.tsx top-level)      */
/* ------------------------------------------------------------------ */

function resizeChatInputEl(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const maxH = 180;
  el.style.height = "auto";
  const minH = el.dataset.minH ? Number(el.dataset.minH) : 36;
  const nextH = Math.min(maxH, Math.max(minH, el.scrollHeight));
  el.style.height = `${nextH}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}

const flattenNodeText = (node: any): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join("");
  if (React.isValidElement(node)) return flattenNodeText((node.props as any)?.children);
  return "";
};

/* ------------------------------------------------------------------ */
/*  Hook dependency interface                                          */
/* ------------------------------------------------------------------ */

export interface UseChatEngineDeps {
  chatId: string | null;
  routeChatId: string | undefined;
  user: { id?: string; token?: string; email?: string; user_metadata?: any } | null;
  title: string;
  titleRef: React.MutableRefObject<string>;
  selectedModel: string;
  customModelId?: string | null;
  notesPagesRef: React.MutableRefObject<Array<{ id: string; title: string; content: any }>>;
  projectId: string | null;
  /** LYKN project the user explicitly scoped the chat to via the "+" menu. */
  scopedProjectId?: string | null;
  /** Display name of the scoped project, surfaced to the model verbatim. */
  scopedProjectName?: string | null;
  gridSize: number;
  viewportWidth: number;
  chatMode: boolean;
  chatRailVisible: boolean;

  /* Shared state (lifted up to avoid circular dep with useLyknChatPersistence) */
  chatMessages: PromptMessage[];
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  convoSummaryRef: React.MutableRefObject<string>;
  convoTurnsSinceSummaryRef: React.MutableRefObject<number>;

  /* Canvas store selectors passed in to avoid internal provider calls */
  updateBlock: (id: any, patch: any) => void;
  deleteBlock: (id: any) => void;
  addTextBlockAt: (pos: { x: number; y: number }, opts: any) => string;
  addListBlockAt: (pos: { x: number; y: number }, opts: any) => string;
  setListItems: (id: any, items: any, listType?: string) => void;

  /* AI store selectors */
  getCachedKbText: () => string;
  getCachedWorkspaceSummary: () => { full?: string; media?: string; boards?: string } | null;

  /* Board persistence helpers */
  setChatRailOpen: Dispatch<SetStateAction<boolean>>;
  setChatRailVisible: Dispatch<SetStateAction<boolean>>;
  setChatMode: Dispatch<SetStateAction<boolean>>;

  /* Toast/overlay state setters that live in LyknChat */
  setConnectionCards: Dispatch<SetStateAction<Array<{ title: string; sourceType: "board" | "media"; reason: string }>>>;
  setShowConnectionCard: Dispatch<SetStateAction<boolean>>;
  setMediaSuggestions: Dispatch<SetStateAction<Array<{ title: string; reason: string; noteId: string }>>>;
  setSelectedMediaIds: Dispatch<SetStateAction<Set<string>>>;
  setShowMediaSuggestion: Dispatch<SetStateAction<boolean>>;
  setNotesOpen: Dispatch<SetStateAction<boolean>>;
  setShowAttachMenu: Dispatch<SetStateAction<boolean>>;
}

/* ------------------------------------------------------------------ */
/*  Return type                                                        */
/* ------------------------------------------------------------------ */

export interface UseChatEngineReturn {
  /* State */
  chatMessages: PromptMessage[];
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  chatInputRef: React.MutableRefObject<string>;
  chatInputHasText: boolean;
  setChatInput: (valOrFn: string | ((prev: string) => string)) => void;
  handleChatInputChange: (value: string) => void;
  isChatLoading: boolean;
  setIsChatLoading: Dispatch<SetStateAction<boolean>>;
  chatFlowMode: "idle" | "clarifying" | "generating";
  chatStatusText: string;
  setChatStatusText: Dispatch<SetStateAction<string>>;
  focusedChatAttachments: FocusedChatAttachment[];
  setFocusedChatAttachments: Dispatch<SetStateAction<FocusedChatAttachment[]>>;
  expandedAiMsgIds: Set<string>;
  expandedUserPromptIds: Set<string>;
  chatReactions: Record<string, "like" | "dislike" | null>;
  setChatReactions: Dispatch<SetStateAction<Record<string, "like" | "dislike" | null>>>;
  copiedMsgId: string | null;
  setCopiedMsgId: Dispatch<SetStateAction<string | null>>;
  assistantTaskChecks: Record<string, Record<string, boolean>>;
  isDictating: boolean;
  isTranscribing: boolean;
  /* Voice Mode: full-screen hands-free voice conversation overlay. */
  voiceModeOn: boolean;
  /* "+" menu capability mode applied to the next send (auto-clears on send). */
  composerMode: ComposerMode;
  setComposerMode: (mode: ComposerMode) => void;

  /* Artifact open in the side panel (Claude-style pullout). The model refines
   * THIS artifact in place when the user sends an edit request. */
  activeArtifact: ChatArtifact | null;
  setActiveArtifact: (artifact: ChatArtifact | null) => void;

  /* Refs (exposed for child component prop-passing) */
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  chatScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  chatPanelInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  centerChatInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  chatUserScrolledUpRef: React.MutableRefObject<boolean>;
  chatProgrammaticScrollRef: React.MutableRefObject<boolean>;
  pendingAiBrickActionRef: React.MutableRefObject<boolean>;
  pendingBrickActionDataRef: React.MutableRefObject<{ imageUrl?: string; videoId?: string } | null>;
  youtubeTranscriptCacheRef: React.MutableRefObject<Record<string, any>>;

  /* Callbacks */
  handleChatSend: () => Promise<void>;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
  /* Voice Mode controls. */
  toggleVoiceMode: () => void;
  setVoiceMode: (on: boolean) => void;
  /**
   * Send a voice-originated turn through the normal chat pipeline and
   * resolve with the assistant's final reply text (for the voice overlay
   * to speak). Returns "" if nothing came back.
   */
  sendVoiceTurn: (text: string) => Promise<string>;
  handleChatPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleOpenAttachments: () => void;
  removeFocusedAttachment: (id: string) => void;
  addFocusedAttachment: (att: FocusedChatAttachment) => void;
  updateFocusedAttachment: (id: string, patch: Record<string, unknown>) => void;
  applyVaultDropToChat: (payload: any) => Promise<void>;
  resizeChatInput: (el: HTMLTextAreaElement | null) => void;
  toggleAiExpanded: (msgId: string) => void;
  toggleUserPromptExpanded: (msgId: string) => void;
  getCollapsedPreview: (text: string) => string;
  updateTaskCheck: (msgId: string, taskKey: string, checked: boolean) => void;
  buildChatMarkdownComponents: (msgId: string) => Record<string, React.ComponentType<any>>;
  typeResponseIntoChat: (promptId: string, fullText: string) => Promise<void>;
  addChatResponseToGrid: (text: string, dropClientX?: number, dropClientY?: number) => void;
  replaySavedPromptResponse: (msg: PromptMessage) => void;
  applyProjectActions: (actions: CreateAction[]) => { created: number; failures: string[] };

  /* Helpers for board persistence */
  convoSummaryRef: React.MutableRefObject<string>;
  convoTurnsSinceSummaryRef: React.MutableRefObject<number>;

  /** Call in onDraftEffectCleanup to clear typing timers owned by the hook */
  cleanupDraftTimers: () => void;
}

/* ------------------------------------------------------------------ */
/*  findSmartPlacement (copied from LyknChat for self-containment)    */
/* ------------------------------------------------------------------ */

function findSmartPlacement(opts: {
  blockW: number; blockH: number; gridSize: number;
  camera: { x: number; y: number; zoom: number };
  viewportW: number; viewportH: number; railWidth: number;
  existingBlocks: Array<{ x: number; y: number; width: number; height: number }>;
}): { x: number; y: number } {
  const { blockW, blockH, gridSize: g, camera, viewportW, viewportH, railWidth, existingBlocks } = opts;
  const z = Math.max(0.1, camera.zoom || 1);
  const boardVW = Math.max(g * 8, (viewportW - railWidth) / z);
  const boardVH = Math.max(g * 8, viewportH / z);
  const camX = camera.x; const camY = camera.y;
  const rects = existingBlocks.map((b) => ({ x: Number(b.x || 0), y: Number(b.y || 0), w: Number(b.width || g), h: Number(b.height || g) }));
  const defaultGap = g * 2;
  let gapX = defaultGap, gapY = defaultGap;
  if (rects.length >= 2) {
    const hGaps: number[] = [], vGaps: number[] = [];
    const sorted = rects.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]; let bestR = Infinity, bestB = Infinity;
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue; const b = sorted[j];
        const hD = b.x - (a.x + a.w); if (hD > 0 && hD < g * 20 && Math.abs(b.y - a.y) < Math.max(a.h, b.h) && hD < bestR) bestR = hD;
        const vD = b.y - (a.y + a.h); if (vD > 0 && vD < g * 20 && Math.abs(b.x - a.x) < Math.max(a.w, b.w) && vD < bestB) bestB = vD;
      }
      if (bestR < Infinity) hGaps.push(bestR);
      if (bestB < Infinity) vGaps.push(bestB);
    }
    const median = (arr: number[]) => { if (!arr.length) return defaultGap; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
    if (hGaps.length) gapX = Math.max(g, Math.round(median(hGaps) / g) * g);
    if (vGaps.length) gapY = Math.max(g, Math.round(median(vGaps) / g) * g);
  }
  const padX = Math.max(g, Math.floor(gapX / 2)), padY = Math.max(g, Math.floor(gapY / 2));
  const overlaps = (px: number, py: number, pw: number, ph: number) => rects.some((r) => px < r.x + r.w + padX && px + pw > r.x - padX && py < r.y + r.h + padY && py + ph > r.y - padY);
  const vL = camX + g, vT = camY + g, vR = camX + boardVW - blockW - g, vB = camY + boardVH - blockH - g * 4;
  const cx = Math.round(((vL + vR) / 2) / g) * g, cy = Math.round(((vT + vB) / 2) / g) * g;
  let placed = false, wX = cx, wY = cy;
  const maxR = Math.max(boardVW, boardVH);
  for (let r = 0; r <= maxR && !placed; r += g) {
    if (r === 0) { if (cx >= vL && cx <= vR && cy >= vT && cy <= vB && !overlaps(cx, cy, blockW, blockH)) { wX = cx; wY = cy; placed = true; } continue; }
    for (let dx = -r; dx <= r && !placed; dx += g) for (const dy of [-r, r]) { const px = Math.round((cx + dx) / g) * g, py = Math.round((cy + dy) / g) * g; if (px >= vL && px <= vR && py >= vT && py <= vB && !overlaps(px, py, blockW, blockH)) { wX = px; wY = py; placed = true; break; } }
    if (placed) break;
    for (let dy = -r + g; dy <= r - g && !placed; dy += g) for (const dx of [-r, r]) { const px = Math.round((cx + dx) / g) * g, py = Math.round((cy + dy) / g) * g; if (px >= vL && px <= vR && py >= vT && py <= vB && !overlaps(px, py, blockW, blockH)) { wX = px; wY = py; placed = true; break; } }
  }
  if (!placed) {
    let maxBottom = camY;
    for (const r of rects) { const b = r.y + r.h; if (b > maxBottom) maxBottom = b; }
    wX = Math.max(g, Math.round((camX + boardVW * 0.5 - blockW / 2) / g) * g);
    wY = Math.max(g, Math.round((maxBottom + gapY) / g) * g);
  }
  return { x: Math.max(g, wX), y: Math.max(g, wY) };
}

/* ------------------------------------------------------------------ */
/*  The hook                                                           */
/* ------------------------------------------------------------------ */

export function useChatEngine(deps: UseChatEngineDeps): UseChatEngineReturn {
  const {
    chatId, routeChatId, user, title, titleRef, selectedModel, customModelId,
    notesPagesRef, projectId, scopedProjectId, scopedProjectName, gridSize, viewportWidth, chatMode, chatRailVisible,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    updateBlock, deleteBlock, addTextBlockAt, addListBlockAt, setListItems,
    getCachedKbText, getCachedWorkspaceSummary,
    setChatRailOpen, setChatRailVisible: setRailVisible, setChatMode: setMode,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setNotesOpen, setShowAttachMenu,
  } = deps;

  /* ---------- State (hook-local) ---------- */
  const chatInputRef = useRef("");
  const [chatInputHasText, setChatInputHasText] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatFlowMode, setChatFlowMode] = useState<"idle" | "clarifying" | "generating">("idle");
  const [chatStatusText, setChatStatusText] = useState("");
  const [focusedChatAttachments, setFocusedChatAttachments] = useState<FocusedChatAttachment[]>([]);
  const [expandedAiMsgIds, setExpandedAiMsgIds] = useState<Set<string>>(new Set());
  const [expandedUserPromptIds, setExpandedUserPromptIds] = useState<Set<string>>(new Set());
  const [chatReactions, setChatReactions] = useState<Record<string, "like" | "dislike" | null>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState<Record<string, Record<string, boolean>>>({});
  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  // Active "+" menu capability mode for the NEXT send. Steers the model to
  // use a specific tool (image gen / web search / deep research) for this
  // turn, then auto-clears once the message is sent.
  const [activeArtifact, setActiveArtifactState] = useState<ChatArtifact | null>(null);
  const activeArtifactRef = useRef<ChatArtifact | null>(null);
  const setActiveArtifact = useCallback((artifact: ChatArtifact | null) => {
    const bid = String(chatId || routeChatId || "").trim();
    // Tag + persist per board so Smash Arena in chat A never rides along on chat B.
    const next = artifact
      ? { ...artifact, sourceChatId: bid || artifact.sourceChatId || undefined }
      : null;
    activeArtifactRef.current = next;
    setActiveArtifactState(next);
    if (bid) patchThreadSnapshot(bid, { activeArtifact: next });
  }, [chatId, routeChatId]);

  const [composerMode, setComposerModeState] = useState<ComposerMode>("none");
  const composerModeRef = useRef<ComposerMode>("none");
  const setComposerMode = useCallback((mode: ComposerMode) => {
    composerModeRef.current = mode;
    setComposerModeState(mode);
  }, []);

  /* ---------- Refs (hook-local) ---------- */
  const voiceModeOnRef = useRef(false);
  const activeAiAbortRef = useRef<AbortController | null>(null);
  const streamChatIdRef = useRef<string | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const isSendingRef = useRef(false);
  // Per-board concurrency tracking so chats in a thread can stream
  // independently without sharing a single send-lock or stream cursor.
  const sendingBoardsRef = useRef<Set<string>>(new Set());
  const streamRuntimeRef = useRef<Map<string, {
    streamTargetTextRef: { current: string };
    streamDisplayedLenRef: { current: number };
    streamTypingRafRef: { current: number | null };
    streamPromptIdRef: { current: string | null };
  }>>(new Map());
  const lastSendSigRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const clarificationSessionRef = useRef({ active: false, basePromptId: "", baseRequest: "", questions: [] as string[], answers: [] as string[], askedCount: 0 });
  const streamTargetTextRef = useRef("");
  const streamDisplayedLenRef = useRef(0);
  const streamTypingRafRef = useRef<number | null>(null);
  const streamPromptIdRef = useRef<string | null>(null);
  // Per-board typewriter state (non-streaming invoke fallback). Keyed by
  // chat id so two chats animating at once never clear each other's timer.
  const chatTypingTimersRef = useRef<Map<string, number>>(new Map());
  const chatTypingPendingsRef = useRef<Map<string, { promptId: string; fullText: string; resolve: () => void; chatId: string | null }>>(new Map());
  const aiTypingRunRef = useRef(0);
  const lastAiResponseBlockRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const dictationTimerRef = useRef<number | null>(null);
  const pendingAiBrickActionRef = useRef(false);
  const pendingBrickActionDataRef = useRef<{ imageUrl?: string; videoId?: string } | null>(null);
  const youtubeTranscriptCacheRef = useRef<Record<string, { fetchedAt: number; title: string; url: string; transcript: string; segments: Array<{ startSec: number; endSec: number; text: string }>; source?: string }>>({});
  const youtubeTranscriptFailRef = useRef<Record<string, number>>({});
  const prevLastMsgIdRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatUserScrolledUpRef = useRef(false);
  const chatProgrammaticScrollRef = useRef(false);
  const chatPanelInputRef = useRef<HTMLTextAreaElement | null>(null);
  const centerChatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const setChatInput = useCallback((valOrFn: string | ((prev: string) => string)) => {
    const newVal = typeof valOrFn === "function" ? valOrFn(chatInputRef.current) : valOrFn;
    chatInputRef.current = newVal;
    setChatInputHasText(prev => {
      const has = !!newVal.trim();
      return prev === has ? prev : has;
    });
    if (chatPanelInputRef.current) {
      chatPanelInputRef.current.value = newVal;
      resizeChatInputEl(chatPanelInputRef.current);
    }
    if (centerChatInputRef.current) {
      centerChatInputRef.current.value = newVal;
      resizeChatInputEl(centerChatInputRef.current);
    }
  }, []);

  const handleChatInputChange = useCallback((value: string) => {
    chatInputRef.current = value;
    setChatInputHasText(prev => {
      const has = !!value.trim();
      return prev === has ? prev : has;
    });
  }, []);

  /* ---------- Effects ---------- */

  // Abort cleanup on unmount — stop only the active thread's stream
  useEffect(() => () => {
    activeAiAbortRef.current?.abort();
  }, []);

  const patchThreadMessages = useCallback((
    updater: (prev: PromptMessage[]) => PromptMessage[],
    targetChatId?: string | null,
  ) => {
    const bid = targetChatId || streamChatIdRef.current || chatId || routeChatId;
    if (!bid) {
      setChatMessages(updater);
      return;
    }
    const snap = ensureThreadSnapshot(String(bid));
    snap.chatMessages = updater(snap.chatMessages);
    snap.updatedAt = Date.now();
    if (getActiveThreadChatId() === String(bid)) {
      setChatMessages(() => snap.chatMessages);
    }
    chatMessagesRef.current = snap.chatMessages;
  }, [chatId, routeChatId, setChatMessages]);

  // Switch threads without aborting background streams
  useEffect(() => {
    const incoming = chatId ? String(chatId) : null;
    const outgoing = prevChatIdRef.current;

    if (outgoing && outgoing !== incoming) {
      const outSnap = getThreadSnapshot(outgoing);
      // If the outgoing chat has a stream in flight, the orchestrator is
      // the source of truth for its snapshot — DON'T overwrite its
      // messages from the shared React refs. (Board navigation resets
      // those refs to [] before this effect runs, which would otherwise
      // wipe the in-flight prompt/response from the snapshot.)
      const outStreaming = !!outSnap?.isChatLoading;
      const refMessages = chatMessagesRef.current;
      const snapHasMore = (outSnap?.chatMessages?.length ?? 0) > (refMessages?.length ?? 0);

      const patch: Parameters<typeof snapshotActiveThreadFromReact>[1] = {
        chatStatusText: chatStatusText,
        chatFlowMode: chatFlowMode,
        chatInput: chatInputRef.current,
        // Park the open panel on the outgoing board (null for closed).
        activeArtifact: activeArtifactRef.current,
      };
      if (!outStreaming) {
        // Only persist React-side messages when they aren't a stale/empty
        // reset that would clobber a more complete snapshot.
        if (!snapHasMore) {
          patch.chatMessages = refMessages;
          patch.aiThread = [...aiThreadRef.current];
          patch.convoSummary = convoSummaryRef.current;
          patch.convoTurnsSinceSummary = convoTurnsSinceSummaryRef.current;
        }
        patch.isChatLoading = isChatLoading;
        patch.abortController = activeAiAbortRef.current;
      }
      snapshotActiveThreadFromReact(outgoing, patch);
    }

    if (incoming) {
      setActiveThreadChatId(incoming);
      addOpenThread(incoming);
      const snap = getThreadSnapshot(incoming);
      activeAiAbortRef.current = snap?.abortController ?? null;
      streamChatIdRef.current = snap?.isChatLoading ? incoming : null;

      // Always sync the lightweight status flags to the board we're
      // switching to — these are per-chat and must NEVER inherit the
      // outgoing chat's "thinking" state. Message hydration stays
      // conditional below (so a fresh board doesn't clobber a DB load),
      // but loading/status/flow always reflect the incoming board.
      setIsChatLoading(snap?.isChatLoading ?? false);
      setChatStatusText(snap?.chatStatusText ?? "");
      setChatFlowMode(snap?.chatFlowMode ?? "idle");

      // Restore THIS board's panel artifact (or close it on a fresh chat).
      // Do not go through setActiveArtifact — that would re-patch the snap.
      const restored = snap?.activeArtifact ?? null;
      activeArtifactRef.current = restored;
      setActiveArtifactState(restored);

      requestAnimationFrame(() => {
        hydrateActiveThreadToReact(
          incoming,
          {
            setChatMessages,
            setIsChatLoading,
            setChatStatusText,
            setChatFlowMode,
            setChatInput,
          },
          {
            chatMessagesRef,
            aiThreadRef,
            convoSummaryRef,
            convoTurnsSinceSummaryRef,
            chatInputRef,
            activeAiAbortRef,
          },
          chatMessagesRef.current,
        );
      });
    } else {
      setActiveThreadChatId(null);
      activeArtifactRef.current = null;
      setActiveArtifactState(null);
    }

    prevChatIdRef.current = incoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on board switch
  }, [chatId]);

  // Persist composer draft per thread when typing
  useEffect(() => {
    if (!chatId) return;
    patchThreadSnapshot(String(chatId), { chatInput: chatInputRef.current });
  }, [chatId, chatInputHasText]);

  // Sync ref
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);

  // Auto-expand the latest message — but ONLY collapse the others when the
  // last message is genuinely NEW (a fresh user turn or a switch to a
  // different chat). Keying on the last message *id* instead of the array
  // length means background re-hydrations (per-board snapshot restores,
  // attachment re-signing, thread routing) that re-set `chatMessages` to an
  // array ending in the SAME message no longer collapse the response the user
  // is currently reading. The open response now stays open until the user
  // actually writes another prompt.
  useEffect(() => {
    const count = chatMessages.length;
    if (count === 0) { prevLastMsgIdRef.current = null; return; }
    const latestId = chatMessages[count - 1]?.id ?? null;
    if (latestId && latestId !== prevLastMsgIdRef.current) {
      setExpandedAiMsgIds(new Set([latestId]));
    }
    prevLastMsgIdRef.current = latestId;
  }, [chatMessages]);

  // Brick action events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.prompt) return;
      setChatInput(detail.prompt);
      pendingBrickActionDataRef.current = { imageUrl: detail.imageUrl || undefined, videoId: detail.videoId || undefined };
      if (!chatMode && !chatRailVisible) { setRailVisible(true); setChatRailOpen(true); }
      pendingAiBrickActionRef.current = true;
    };
    window.addEventListener("lyknchat_ai_brick_action", handler);
    return () => window.removeEventListener("lyknchat_ai_brick_action", handler);
  }, [chatMode, chatRailVisible, setChatInput, setChatRailOpen, setRailVisible]);

  // Dictation cleanup on unmount
  useEffect(() => () => {
    aiTypingRunRef.current += 1;
    if (dictationTimerRef.current) { window.clearInterval(dictationTimerRef.current); dictationTimerRef.current = null; }
    try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop(); } catch {}
    try { mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
    void import("@/lib/ai/speakText").then(({ stopSpeaking }) => stopSpeaking()).catch(() => {});
  }, []);

  // Drop-to-chat attachments
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ attachments: FocusedChatAttachment[] }>;
      const atts = Array.isArray(ce.detail?.attachments) ? ce.detail.attachments : [];
      if (!atts.length) return;
      const msgId = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const dropMsg: PromptMessage = { id: msgId, role: "user", content: atts.length === 1 ? `Dropped ${atts[0].name || "file"}` : `Dropped ${atts.length} files`, attachments: atts };
      setChatMessages((prev) => [...prev, dropMsg]);
      if (!chatRailVisible && !chatMode) { setRailVisible(true); setChatRailOpen(true); }
    };
    window.addEventListener("lyknchat_chat_drop_attachments", handler);
    return () => window.removeEventListener("lyknchat_chat_drop_attachments", handler);
  }, [chatRailVisible, chatMode, setChatRailOpen, setRailVisible]);

  // When a canvas file finishes uploading to storage, back-fill the chat
  // attachment with storagePath + a durable signed URL so the image survives
  // page reloads (blob: URLs die when the session ends).
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ fileName: string; fileUrl: string; storagePath: string; storageBucket: string }>;
      const { fileName, fileUrl, storagePath, storageBucket } = ce.detail || {};
      if (!fileName || !storagePath) return;
      setChatMessages((prev) =>
        prev.map((m: any) => {
          if (!Array.isArray(m.attachments)) return m;
          let changed = false;
          const updated = m.attachments.map((a: any) => {
            if (a.name === fileName && !a.storagePath) {
              changed = true;
              return { ...a, url: fileUrl, storagePath, storageBucket: storageBucket || "user-files" };
            }
            return a;
          });
          return changed ? { ...m, attachments: updated } : m;
        })
      );
    };
    window.addEventListener("lyknchat_file_stored", handler);
    return () => window.removeEventListener("lyknchat_file_stored", handler);
  }, []);

  // Resize chat input on mode switch
  useEffect(() => {
    resizeChatInputEl(chatPanelInputRef.current);
    resizeChatInputEl(centerChatInputRef.current);
  }, [chatMode]);

  /* ---------- Callbacks ---------- */

  const SUMMARIZE_EVERY_N_TURNS = 8;
  const maybeRunConversationSummary = useCallback(async (targetChatId?: string | null) => {
    // Operate on the stream's own board snapshot so summaries don't mix
    // conversation history across chats in a thread.
    const bid = targetChatId ? String(targetChatId) : null;
    const snap = bid ? ensureThreadSnapshot(bid) : null;
    if (snap) {
      snap.convoTurnsSinceSummary += 1;
      if (snap.convoTurnsSinceSummary < SUMMARIZE_EVERY_N_TURNS) return;
      if (snap.aiThread.length < 8) return;
      snap.convoTurnsSinceSummary = 0;
    } else {
      convoTurnsSinceSummaryRef.current += 1;
      if (convoTurnsSinceSummaryRef.current < SUMMARIZE_EVERY_N_TURNS) return;
      if (aiThreadRef.current.length < 8) return;
      convoTurnsSinceSummaryRef.current = 0;
    }
    const thread = snap ? snap.aiThread : aiThreadRef.current;
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/summarize-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: thread.slice(0, -4) }),
      });
      if (res.ok) {
        const { summary } = await res.json();
        if (summary) {
          if (snap) snap.convoSummary = summary;
          if (!bid || getActiveThreadChatId() === bid) convoSummaryRef.current = summary;
        }
      }
    } catch {}
  }, []);

  const toggleAiExpanded = useCallback((msgId: string) => {
    setExpandedAiMsgIds((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; });
  }, []);

  const toggleUserPromptExpanded = useCallback((msgId: string) => {
    setExpandedUserPromptIds((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; });
  }, []);

  const getCollapsedPreview = useCallback((text: string) => {
    const clean = text.replace(/[#*_`~>\[\]()!|]/g, "").replace(/\n+/g, " ").trim();
    return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  }, []);

  const updateTaskCheck = useCallback((msgId: string, taskKey: string, checked: boolean) => {
    setAssistantTaskChecks((prev) => ({ ...prev, [msgId]: { ...(prev[msgId] || {}), [taskKey]: checked } }));
  }, []);

  // Static, identity-stable markdown components shared across every message.
  // Previously this object was recreated on every `buildChatMarkdownComponents`
  // call (which fires per-message inside the chat render loop, which itself
  // re-runs on every streaming token). A new components object causes
  // ReactMarkdown to drop its memoization and re-walk the AST from scratch
  // — for a 50-message chat that was thousands of wasted markdown re-parses
  // per second during streaming.
  const STATIC_MD_COMPONENTS = useMemo(() => ({
    h1: ({ children }: any) => React.createElement("h1", { className: "text-xl font-semibold mt-6 mb-2.5 tracking-tight" }, children),
    h2: ({ children }: any) => React.createElement("h2", { className: "text-lg font-semibold mt-5 mb-2 tracking-tight" }, children),
    h3: ({ children }: any) => React.createElement("h3", { className: "text-base font-semibold mt-4 mb-1.5 tracking-tight" }, children),
    p: ({ children }: any) => React.createElement("p", { className: "mb-4 last:mb-0 leading-[1.65] whitespace-pre-wrap" }, children),
    ul: ({ children }: any) => React.createElement("ul", { className: "my-3 list-disc pl-5 space-y-1.5" }, children),
    ol: ({ children }: any) => React.createElement("ol", { className: "my-3 list-decimal pl-5 space-y-1.5" }, children),
    strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
    blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 dark:border-white/20 pl-3 my-2 text-black/70 dark:text-white/70 italic" }, children),
    code: (props: any) => React.createElement(ChatCodeBlock, props),
    pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
    table: ({ children }: any) => React.createElement("div", { className: "my-3 overflow-x-auto" }, React.createElement("table", { className: "w-full border-collapse text-sm" }, children)),
    thead: ({ children }: any) => React.createElement("thead", { className: "border-b border-black/20" }, children),
    tbody: ({ children }: any) => React.createElement("tbody", null, children),
    tr: ({ children }: any) => React.createElement("tr", { className: "border-b border-black/10" }, children),
    th: ({ children }: any) => React.createElement("th", { className: "text-left px-3 py-2 font-semibold" }, children),
    td: ({ children }: any) => React.createElement("td", { className: "px-3 py-2" }, children),
  }), []);

  // Per-msgId components cache. The only msg-dependent component is `li`
  // (because it reads `assistantTaskChecks[msgId]` for checkbox state).
  // We cache the assembled object per msgId and only invalidate the entry
  // whose `assistantTaskChecks[msgId]` reference changed — every other
  // message keeps a referentially-stable components object across renders.
  const componentsCacheRef = useRef<Map<string, { checks: any; comps: Record<string, React.ComponentType<any>> }>>(new Map());
  const buildChatMarkdownComponents = useCallback((msgId: string): Record<string, React.ComponentType<any>> => {
    const checks = assistantTaskChecks[msgId];
    const cached = componentsCacheRef.current.get(msgId);
    if (cached && cached.checks === checks) return cached.comps;
    const comps: Record<string, React.ComponentType<any>> = {
      ...STATIC_MD_COMPONENTS,
      li: ({ children }: any) => {
        const raw = flattenNodeText(children).trim();
        const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
        if (!match) return React.createElement("li", { className: "leading-relaxed" }, children);
        const defaultChecked = String(match[1]).toLowerCase() === "x";
        const taskText = match[2];
        const taskKey = raw;
        const isChecked = checks?.[taskKey] ?? defaultChecked;
        return React.createElement("li", { className: `list-none ml-[-1.25rem] flex items-start gap-2 leading-relaxed ${isChecked ? "opacity-60" : ""}` },
          React.createElement("input", { type: "checkbox", className: "mt-[0.28rem] shrink-0 accent-blue-500", checked: isChecked, onChange: (e: any) => updateTaskCheck(msgId, taskKey, e.target.checked) }),
          React.createElement("span", { className: isChecked ? "line-through" : "" }, taskText),
        );
      },
    };
    componentsCacheRef.current.set(msgId, { checks, comps });
    return comps;
  }, [STATIC_MD_COMPONENTS, assistantTaskChecks, updateTaskCheck]);

  const getChatRailWidthPx = useCallback((vw: number) => {
    if (chatMode) return 0;
    const w = Math.max(0, Math.floor(vw || 0));
    if (w <= 900) return Math.max(200, Math.min(260, Math.floor(w * 0.30)));
    if (w <= 1100) return Math.max(220, Math.min(280, Math.floor(w * 0.26)));
    if (w <= 1366) return Math.max(240, Math.min(310, Math.floor(w * 0.25)));
    if (w <= 1600) return Math.max(260, Math.min(340, Math.floor(w * 0.25)));
    return Math.min(380, Math.floor(w * 0.30));
  }, [chatMode]);

  const buildLyknChatContext = useCallback(() => {
    const st = useLyknChatStore.getState();
    const cam = (st as any).camera || { x: 0, y: 0 };
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    return buildTieredLyknChatContext({
      blocks: st.blocks as Record<string, any>,
      blockOrder: Array.isArray(st.blockOrder) ? st.blockOrder : [],
      focusedBrickIds: Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [],
      viewportCenter: { x: (cam.x || 0) + vw / 2, y: (cam.y || 0) + vh / 2 },
      wireConnections: Array.isArray(st.wireConnections) ? st.wireConnections : [],
      recentlyDeleted: Array.isArray((st as any).recentlyDeleted) ? (st as any).recentlyDeleted : [],
    });
  }, []);

  const getAllYouTubeBlocks = useCallback(() => {
    const st = useLyknChatStore.getState() as any;
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
      out.push({ videoId, url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`, title: String(b?.data?.title || b?.data?.name || "").trim() });
    }
    return out.slice(0, 5);
  }, []);

  const getVisibleYouTubeBlocks = useCallback(() => {
    const all = getAllYouTubeBlocks();
    if (!all.length) return [];
    const st = useLyknChatStore.getState() as any;
    const cam = st.camera || { x: 0, y: 0 };
    const vw = window.innerWidth || viewportWidth || 1280;
    const vh = window.innerHeight || 800;
    const rightRail = getChatRailWidthPx(vw);
    const boardViewportWidth = Math.max(gridSize * 8, vw - rightRail);
    const vL = Number(cam.x || 0), vT = Number(cam.y || 0), vR = vL + boardViewportWidth, vB = vT + vh;
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const out: Array<{ videoId: string; url: string; title: string; visibleScore: number }> = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const b: any = st.blocks?.[id]; if (!b) continue;
      const type = String(b.type || "").toLowerCase();
      const isYT = type === "youtube" || (type === "create" && String(b.mode || "").toLowerCase() === "video");
      if (!isYT) continue;
      const bx = Number(b.x || 0), by = Number(b.y || 0), bw = Math.max(1, Number(b.width || gridSize)), bh = Math.max(1, Number(b.height || gridSize));
      const oW = Math.max(0, Math.min(bx + bw, vR) - Math.max(bx, vL));
      const oH = Math.max(0, Math.min(by + bh, vB) - Math.max(by, vT));
      if (oW * oH <= 0) continue;
      const rawVid = String((type === "youtube" ? b.videoId : b?.data?.videoId) || "");
      const rawUrl = String((type === "youtube" ? b.url : b?.data?.url) || "");
      const vid = rawVid || extractYouTubeVideoId(rawUrl) || "";
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      out.push({ videoId: vid, url: rawUrl || `https://www.youtube.com/watch?v=${vid}`, title: String((b?.data?.title || b?.data?.name || "").trim()), visibleScore: oW * oH });
    }
    out.sort((a, b) => b.visibleScore - a.visibleScore);
    return out.slice(0, 2);
  }, [getAllYouTubeBlocks, getChatRailWidthPx, gridSize, viewportWidth]);

  const formatSec = (n: number) => { const sec = Math.max(0, Math.floor(Number(n || 0))); const m = Math.floor(sec / 60); const s = sec % 60; return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`; };

  const buildYouTubeGrounding = useCallback(
    async (apiBaseUrl: string, userText: string, parentSignal?: AbortSignal) => {
      const visible = getVisibleYouTubeBlocks();
      if (!visible.length) return "";
      const tokenSet = new Set(String(userText || "").toLowerCase().split(/[^a-z0-9]+/g).map((t) => t.trim()).filter((t) => t.length >= 4));
      const sections: string[] = [];
      for (const video of visible) {
        const failedAt = youtubeTranscriptFailRef.current[video.videoId];
        if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) continue;
        const cached = youtubeTranscriptCacheRef.current[video.videoId];
        let data = cached;
        if (!data || Date.now() - data.fetchedAt > 30 * 60 * 1000) {
          if (parentSignal?.aborted) continue;
          const ga = new AbortController();
          const gt = setTimeout(() => ga.abort(), 15000);
          if (parentSignal) parentSignal.addEventListener("abort", () => ga.abort(), { once: true });
          const [tRes, vRes] = await Promise.all([
            fetch(`${apiBaseUrl}/api/youtube/transcript?id=${encodeURIComponent(video.videoId)}&fast=1`, { signal: ga.signal }).catch(() => null),
            fetch(`${apiBaseUrl}/api/youtube/video?id=${encodeURIComponent(video.videoId)}`, { signal: ga.signal }).catch(() => null),
          ]);
          clearTimeout(gt);
          const tJ = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
          const vJ = vRes && vRes.ok ? await vRes.json().catch(() => ({})) : {};
          if (!tRes || !tRes.ok) youtubeTranscriptFailRef.current[video.videoId] = Date.now();
          const desc = String((vJ as any)?.description || "").trim();
          const segRaw = Array.isArray((tJ as any)?.segments) ? (tJ as any).segments : [];
          const segs = segRaw.map((s: any) => { const st2 = Number(s?.offset ?? s?.start ?? s?.startSec ?? 0); const dur = Number(s?.duration ?? s?.dur ?? s?.length ?? 0); return { startSec: Number.isFinite(st2) ? st2 : 0, endSec: Number.isFinite(st2 + dur) ? st2 + dur : st2, text: String(s?.text || "").trim() }; }).filter((s: any) => s.text).slice(0, 900);
          const tSrc = String((tJ as any)?.source || "").toLowerCase();
          const tTxt = String((tJ as any)?.transcript || "").trim();
          const isReal = Boolean((tTxt || segs.length) && tSrc !== "description_fallback");
          const effT = isReal ? tTxt : (tTxt || desc).slice(0, 4000);
          const effS = isReal || !desc ? segs : desc.split(/\n+/).map((x: string) => x.trim()).filter(Boolean).slice(0, 8).map((text: string, i: number) => ({ startSec: i * 30, endSec: i * 30 + 29, text }));
          data = { fetchedAt: Date.now(), title: String((vJ as any)?.title || video.title || `YouTube ${video.videoId}`), url: video.url, transcript: effT, segments: effS, source: isReal ? tSrc : "description_fallback" };
          youtubeTranscriptCacheRef.current[video.videoId] = data;
        }
        if (!data || (!data.transcript && !data.segments.length)) continue;
        const cands = data.segments.length ? data.segments : [{ startSec: 0, endSec: 0, text: String(data.transcript || "").slice(0, 3000) }];
        const scored = cands.map((c) => { const lt = c.text.toLowerCase(); let sc = 0; for (const tok of tokenSet) if (lt.includes(tok)) sc++; return { ...c, score: sc }; }).sort((a, b) => b.score - a.score || a.startSec - b.startSec);
        const matched = tokenSet.size ? scored.filter((x) => x.score > 0) : scored;
        const picked = (matched.length ? matched : scored).slice(0, 8);
        const lines = picked.map((p2) => `- [${formatSec(p2.startSec)}-${formatSec(p2.endSec)}] ${p2.text}`);
        const isDesc = data.source === "description_fallback";
        const header = isDesc ? `Video: ${data.title} (${video.videoId}) [description only — no transcript available]` : `Video: ${data.title} (${video.videoId})`;
        sections.push(`${header}\n${lines.join("\n")}`);
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
    const hasVideoWord = /\b(video|youtube|clip|short|reel|transcript|watch|recording)\b/i.test(t);
    if (hasVideoWord) return true;
    if (/transcri(?:be|pt|ption)/i.test(t)) return true;
    const hasPronouns = /\b(he|she|they|speaker|narrator|host|presenter)\b/i.test(t);
    if (hasPronouns && /\b(say(?:s|ing)?|said|talk(?:s|ing)?|mention|discuss|explain|point)\b/i.test(t)) return true;
    return false;
  }, []);

  const sanitizeAssistantResponse = useCallback((s: string) => String(s || "").trim(), []);

  const buildDirectVideoAnswerFromGrounding = useCallback((grounding: string) => {
    const raw = String(grounding || "").trim();
    if (!raw || raw === "(none)") return "";
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => /^\-\s*\[\d{2}:\d{2}\-\d{2}:\d{2}\]\s+/.test(l)).slice(0, 8).map((l) => l.replace(/^\-\s*/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!lines.length) return "";
    const keyPoints = lines.slice(0, 5).map((l) => `- ${l}`);
    return [`From the on-board video transcript:`, `Answer: ${lines[0]}`, `Key grounded points:\n${keyPoints.join("\n")}`].join("\n\n");
  }, []);

  const getKnowledgeBaseContext = useCallback(() => getCachedKbText(), [getCachedKbText]);

  const extractSourceLinks = useCallback((text: string): { cleanText: string; sources: { title: string; url: string }[] } => {
    // Require at least one newline before the header so we don't grab the word
    // "sources:" or "references:" when the model uses it in the middle of a
    // sentence (case-insensitive match previously chopped off the rest of a
    // long response whenever prose like "The main sources:\n..." appeared).
    const sm = text.match(/\n+(?:Sources?|References?):?[ \t]*\n([\s\S]*?)$/i);
    if (!sm) return { cleanText: text, sources: [] };
    const block = sm[1].trim();
    const sources: { title: string; url: string }[] = [];
    const lr = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = lr.exec(block)) !== null) sources.push({ title: m[1], url: m[2] });
    if (!sources.length) { const br = /(?:^|\n)\s*\d+\.\s*(https?:\/\/[^\s]+)/g; while ((m = br.exec(block)) !== null) { try { const u = new URL(m[1]); sources.push({ title: u.hostname.replace(/^www\./, ""), url: m[1] }); } catch {} } }
    // Only strip the trailing block when we actually extracted real citation
    // links. Otherwise the match was likely a false positive (e.g. the AI used
    // "Sources:" as an inline list header) and we'd silently delete the rest
    // of the response.
    if (!sources.length) return { cleanText: text, sources: [] };
    const ct = text.slice(0, sm.index).trimEnd();
    return { cleanText: ct, sources };
  }, []);

  const attachSourcesToBlock = useCallback((responseBlockId: string, sources: { title: string; url: string }[]) => {
    if (!sources.length || !responseBlockId) return;
    const st = useLyknChatStore.getState();
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const rb = st.blocks[responseBlockId];
    if (!rb) return;
    const curData = (rb as any).data && typeof (rb as any).data === "object" ? { ...(rb as any).data } : {};
    const sourcesWithState = sources.map((s) => ({ ...s, enabled: true }));
    const sourceRowHeight = Math.ceil(sources.length / 2) * 32 + 24;
    const extraHeight = Math.ceil(sourceRowHeight / g) * g;
    updateBlock(responseBlockId, { data: { ...curData, sources: sourcesWithState }, height: Number(rb.height || 0) + extraHeight });
  }, [updateBlock]);

  const extractAiConnections = useCallback((responseText: string) => {
    const re = /\[AI_CONNECTION:(.+?)\|(.+?)\|(.+?)\]/g;
    const conns: Array<{ title: string; sourceType: "board" | "media"; reason: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(responseText)) !== null) { const title = m[1].trim(); const rt = m[2].trim().toLowerCase(); const reason = m[3].trim(); if (title && reason) conns.push({ title, sourceType: rt === "board" ? "board" : "media", reason }); }
    return { connections: conns.slice(0, 3), cleanText: responseText.replace(/\s*\[AI_CONNECTION:[^\]]*\]/g, "").trimEnd() };
  }, []);

  const extractAndApplyTagActions = useCallback(async (responseText: string): Promise<string> => {
    const re = /\[TAG_NOTES:([^|\]]+)\|([^\]]+)\]/g;
    const actions: Array<{ noteId: string; tags: string[] }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(responseText)) !== null) { const noteId = m[1].trim(); const rawTags = m[2].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean); if (noteId && rawTags.length) actions.push({ noteId, tags: rawTags }); }
    if (actions.length > 0 && user?.id) {
      for (const action of actions) {
        try {
          const { data: existing } = await supabase.from("vault_items").select("tags").eq("id", action.noteId).eq("user_id", user.id).single();
          const currentTags: string[] = Array.isArray(existing?.tags) ? existing.tags : [];
          await supabase.from("vault_items").update({ tags: [...new Set([...currentTags, ...action.tags])] }).eq("id", action.noteId).eq("user_id", user.id);
        } catch {}
      }
    }
    return responseText.replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "").trimEnd();
  }, [user?.id]);

  const validateYouTubeVideoId = useCallback(async (videoId: string) => {
    try { const res = await fetch(`/api/youtube/video?id=${encodeURIComponent(videoId)}`, { headers: user?.token ? { Authorization: `Bearer ${user.token}` } : {}, signal: AbortSignal.timeout(5000) }); return res.ok; } catch { return true; }
  }, [user?.token]);

  const extractAndEmbedYouTubeUrls = useCallback(async (aiText: string, promptId: string, responseBlockId: string | null): Promise<{ urls: { url: string; videoId: string }[]; cleanText: string }> => {
    const re = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/g;
    const cands: { url: string; videoId: string }[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(aiText)) !== null) { const vid = m[1]; if (vid && !seen.has(vid)) { seen.add(vid); cands.push({ url: m[0], videoId: vid }); } }
    if (!cands.length) return { urls: [], cleanText: aiText };
    const validResults = await Promise.all(cands.map(async (c) => ({ ...c, valid: await validateYouTubeVideoId(c.videoId) })));
    const urls = validResults.filter((r) => r.valid);
    const invalidIds = new Set(validResults.filter((r) => !r.valid).map((r) => r.videoId));
    let cleanText = aiText;
    if (invalidIds.size > 0) { for (const badId of invalidIds) cleanText = cleanText.replace(new RegExp(`https?://(?:www\\.)?(?:youtube\\.com/watch\\?v=|youtu\\.be/|youtube\\.com/embed/|youtube\\.com/shorts/)${badId.replace(/[-]/g, '\\-')}[^\\s]*`, 'g'), ''); cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim(); }
    if (!urls.length) return { urls: [], cleanText };
    const st = useLyknChatStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    for (const ytEntry of urls) {
      const exists = (Array.isArray(st.blockOrder) ? st.blockOrder : []).some((bid: string) => { const blk = st.blocks?.[bid]; return blk && String(blk.videoId || blk.data?.videoId || "") === ytEntry.videoId; });
      if (exists) continue;
      const cur = useLyknChatStore.getState() as any;
      const pos = findSmartPlacement({ blockW: g * 12, blockH: g * 8, gridSize: g, camera: cur.camera || { x: 0, y: 0, zoom: 1 }, viewportW: window.innerWidth || 1280, viewportH: window.innerHeight || 800, railWidth: 0, existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[] });
      st.addYouTubeBlockAt({ x: pos.x, y: pos.y }, { url: ytEntry.url, videoId: ytEntry.videoId });
    }
    setChatMessages((prev) => prev.map((m2) => m2.id === promptId ? { ...m2, aiYouTubeUrls: urls } : m2));
    return { urls, cleanText };
  }, [validateYouTubeVideoId]);

  const extractWebLinksFromText = useCallback((text: string): string[] => {
    const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
    const ytHosts = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
    const seen = new Set<string>(); const links: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) { const raw = m[0].replace(/[.,;:!?)]+$/, ""); try { const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); if (ytHosts.some((h) => host.includes(h))) continue; if (!seen.has(raw)) { seen.add(raw); links.push(raw); } } catch {} }
    return links.slice(0, 5);
  }, []);

  const extractAndEmbedMediaItems = useCallback(async (aiText: string, _responseBlockId: string | null): Promise<{ cleanText: string; pulled: number }> => {
    const re = /\[PULL_MEDIA:([^\]|]+?)(?:\|(\d+))?\]/g;
    const pulls: { noteId: string; attIndex: number }[] = [];
    const seenKeys = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(aiText)) !== null) {
      // Models sometimes wrap the id with leftovers from the source listing, e.g.
      // "{noteId:abc}" or "id=abc". Strip any surrounding decoration and keep only
      // the UUID-ish core so the Supabase lookup still succeeds.
      let nid = String(m[1] || "").trim();
      nid = nid.replace(/^[{(\s"']+|[)}\s"']+$/g, "");
      const prefixMatch = nid.match(/^(?:noteId\s*[:=]\s*|id\s*[:=]\s*)(.+)$/i);
      if (prefixMatch) nid = prefixMatch[1].trim();
      nid = nid.replace(/^[{(\s"']+|[)}\s"']+$/g, "");
      const ai = m[2] !== undefined ? parseInt(m[2], 10) : 0;
      if (!nid) continue;
      const key = `${nid}|${ai}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      pulls.push({ noteId: nid, attIndex: ai });
    }
    if (!pulls.length) return { cleanText: aiText, pulled: 0 };
    const cleanText = aiText.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "").trimEnd();

    let pulled = 0;
    const initial = useLyknChatStore.getState() as any;
    const g = Math.max(1, Math.floor(initial.gridSize || 24));
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const userId = user?.id;

    const seenNotes = new Map<string, Record<string, unknown>>();
    const youtubeUrlInBody = (body: string): string | null => {
      const m2 = String(body || "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})[^\s<>"')]*/i);
      return m2 ? m2[0] : null;
    };

    for (const pull of pulls) {
      try {
        let note = seenNotes.get(pull.noteId);
        if (!note) {
          // Defense-in-depth: even though RLS enforces the same constraint,
          // explicitly scoping the query to the current user gives a clearer
          // failure mode if RLS is ever misconfigured.
          let q = supabase.from("vault_items").select("id, title, content, source").eq("id", pull.noteId);
          if (userId) q = q.eq("user_id", userId);
          const { data, error } = await q.single();
          if (error || !data) continue;
          note = data as Record<string, unknown>;
          seenNotes.set(pull.noteId, note);
        }

        const rawAtts: unknown[] = [];
        if (Array.isArray(note.attachments)) rawAtts.push(...note.attachments);
        else if (typeof note.attachments === "string") { try { const p = JSON.parse(note.attachments as string); if (Array.isArray(p)) rawAtts.push(...p); } catch {} }
        if (rawAtts.length === 0 && note.content) {
          // Use the canonical attachments-marker parser (handles brackets
          // inside JSON strings) instead of a naive bracket counter that
          // mis-parses filenames like "weird]name.png".
          const parsed = parseAttachmentsFromContent(String(note.content));
          if (parsed.length > 0) rawAtts.push(...parsed);
        }

        const att = rawAtts[pull.attIndex] as Record<string, unknown> | undefined;
        // Snapshot the current canvas state for THIS iteration so each pull's
        // smart placement sees the bricks we just added in earlier iterations.
        const st = useLyknChatStore.getState() as any;

        if (!att) {
          // Vault notes whose body holds only a YouTube URL (no real
          // attachments) get prompted to the model with `pull=...|0`. Honor
          // that by routing through addYouTubeBlockAt instead of dropping a
          // text brick the user didn't ask for.
          const sourceUrl = String(note.source || "").trim();
          const noteContent = String(note.content || "").trim();
          const ytUrl = (sourceUrl && extractYouTubeVideoId(sourceUrl) ? sourceUrl : null) || youtubeUrlInBody(noteContent);
          if (ytUrl) {
            const ytId = extractYouTubeVideoId(ytUrl);
            if (ytId) {
              const exists = (Array.isArray(st.blockOrder) ? st.blockOrder : []).some((bid: string) => {
                const blk = (st.blocks as any)?.[bid];
                return blk && String(blk.videoId || blk.data?.videoId || "") === ytId;
              });
              if (!exists) {
                const pos = findSmartPlacement({ blockW: g * 12, blockH: g * 8, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
                const newId = st.addYouTubeBlockAt({ x: pos.x, y: pos.y }, { url: ytUrl, videoId: ytId });
                if (newId) pulled++;
              } else {
                pulled++;
              }
              continue;
            }
          }

          const noteTitle = String(note.title || "Quick Note").trim();
          if (!noteContent) continue;
          const content = noteTitle ? `# ${noteTitle}\n\n${noteContent}` : noteContent;
          const bw = g * 12; const bh = g * 6;
          const pos = findSmartPlacement({ blockW: bw, blockH: bh, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
          const id = addTextBlockAt({ x: pos.x, y: pos.y }, { width: bw, height: bh, content, format: "rich", data: { vaultPulled: true } });
          if (id) pulled++;
          continue;
        }

        const attUrl = String(att.url || "").trim();
        const storagePath = String(att.storagePath || "").trim();
        const bucket = String(att.storageBucket || "user-files").trim() || "user-files";
        const attName = String(att.name || note.title || "Vault item").trim();

        let resolvedUrl = attUrl;
        if (storagePath) {
          try {
            const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 60 * 60 * 24 * 7);
            if (signed?.signedUrl) resolvedUrl = signed.signedUrl;
          } catch {}
        } else if (attUrl && !attUrl.startsWith("http") && !attUrl.startsWith("data:")) {
          try {
            const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(attUrl, 60 * 60 * 24 * 7);
            if (signed?.signedUrl) resolvedUrl = signed.signedUrl;
          } catch {}
        }

        const ext = ((resolvedUrl.split("/").pop() || attName).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";
        const imgExts = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff"];
        const vidExts = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"];
        const isImage = att.type === "image" || imgExts.includes(ext) || resolvedUrl.startsWith("data:image/");
        const isVideo = att.type === "video" || vidExts.includes(ext) || resolvedUrl.startsWith("data:video/");
        const isYouTube = resolvedUrl.includes("youtube.com") || resolvedUrl.includes("youtu.be");
        const isBookmark = att.type === "bookmark" || att.type === "link" || !!att.siteName || !!att.articleText;

        if (isYouTube) {
          const vidId = extractYouTubeVideoId(resolvedUrl);
          if (vidId) {
            const pos = findSmartPlacement({ blockW: g * 12, blockH: g * 8, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
            const ytId = st.addYouTubeBlockAt({ x: pos.x, y: pos.y }, { url: resolvedUrl, videoId: vidId });
            if (ytId) pulled++;
          }
        } else if (isImage && resolvedUrl) {
          const pos = findSmartPlacement({ blockW: g * 12, blockH: g * 10, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
          const bid = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const ok = st.addBlock({ id: bid, type: "create", mode: "image", x: pos.x, y: pos.y, width: g * 12, height: g * 10, data: { src: resolvedUrl, url: resolvedUrl, name: attName, storagePath, storageBucket: bucket, vaultPulled: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          if (ok) pulled++;
        } else if (isVideo && resolvedUrl) {
          const pos = findSmartPlacement({ blockW: g * 12, blockH: g * 10, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
          const bid = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const ok = st.addBlock({ id: bid, type: "create", mode: "video", x: pos.x, y: pos.y, width: g * 12, height: g * 10, data: { src: resolvedUrl, url: resolvedUrl, name: attName, storagePath, storageBucket: bucket, vaultPulled: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          if (ok) pulled++;
        } else if (isBookmark) {
          const title = String(att.name || att.siteName || note.title || "Bookmark").trim();
          const articleText = String(att.articleText || "").trim();
          const desc = String(att.description || "").trim();
          const content = articleText ? `# ${title}\n\n${articleText}` : desc ? `# ${title}\n\n${desc}` : `# ${title}\n\n${resolvedUrl}`;
          const bw = g * 12; const bh = g * 6;
          const pos = findSmartPlacement({ blockW: bw, blockH: bh, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
          const id = addTextBlockAt({ x: pos.x, y: pos.y }, { width: bw, height: bh, content, format: "rich", data: { vaultPulled: true } });
          if (id) pulled++;
        } else if (resolvedUrl) {
          const pos = findSmartPlacement({ blockW: g * 10, blockH: g * 6, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
          // pos.{x,y} are WORLD coords (from findSmartPlacement); dispatch
          // them as worldX/worldY so Canvas's onLink doesn't double-transform
          // them through clientToWorld and place the brick off-screen.
          // lyknchat_attach_link goes through Canvas's addUrlAsBlock which
          // itself gates on the cap; we can't observe that here, so
          // attribute to the attempt. The real cap-block is reported via
          // the lykn:block-limit window event for upgrade UX.
          window.dispatchEvent(new CustomEvent("lyknchat_attach_link", { detail: { url: resolvedUrl, worldX: pos.x, worldY: pos.y } }));
          pulled++;
        }
      } catch {
        // Individual pull failed; continue with others
      }
    }

    if (pulled > 0) {
      setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 500);
    }
    return { cleanText, pulled };
  }, [addTextBlockAt]);

  const normalizeAiTextForBlock = useCallback((text: string) => String(text || "").replace(/\r\n?/g, "\n"), []);

  const calcAiBubbleSize = useCallback((text: string) => {
    const st = useLyknChatStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const screenW = window.innerWidth || 1280;
    const maxWidthPx = Math.max(g * 10, Math.floor(screenW * 0.9));
    const charWidthPx = 7.8; const lineHeightPx = g; const hPad = 16; const vPad = 8;
    const lines = String(text || "").split("\n");
    const longest = lines.reduce((m2, l) => Math.max(m2, String(l || "").length), 0);
    const naturalWidth = Math.ceil(longest * charWidthPx + hPad);
    const w = Math.max(g * 8, Math.min(maxWidthPx, naturalWidth));
    const usable = Math.max(1, w - hPad);
    const cpl = Math.max(1, Math.floor(usable / charWidthPx));
    let wl = 0;
    for (const line of lines) wl += Math.max(1, Math.ceil((line.length || 1) / cpl));
    const h = Math.max(g * 2, Math.ceil((wl * lineHeightPx + vPad) / g) * g);
    return { width: w, height: h };
  }, []);

  const addChatResponseToGrid = useCallback((text: string, dropClientX?: number, dropClientY?: number) => {
    const content = String(text || "").trim();
    if (!content) return;
    const st = useLyknChatStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280; const vh = window.innerHeight || 800;
    const size = calcAiBubbleSize(content);
    let posX: number, posY: number;
    if (dropClientX != null && dropClientY != null) {
      // Canonical client→world: use the canvas element's scroll position
      // (NOT camera.x/y, which can be momentarily stale during pan/zoom
      // animations). Matches Canvas.tsx clientToWorld (scrollLeft + localX
      // / zoom − SURFACE_ORIGIN_PAD). Mirror Canvas.tsx SURFACE_ORIGIN_PAD_WORLD.
      const SURFACE_ORIGIN_PAD = 10000;
      const z = Math.max(0.1, Number(st.camera?.zoom) || 1);
      const canvasEl = document.querySelector<HTMLElement>("[data-lykn-chat-canvas]");
      const rect = canvasEl?.getBoundingClientRect();
      const localX = rect ? dropClientX - rect.left : dropClientX;
      const localY = rect ? dropClientY - rect.top : dropClientY;
      const scrollLeft = canvasEl?.scrollLeft || 0;
      const scrollTop = canvasEl?.scrollTop || 0;
      const worldX = (scrollLeft + localX) / z - SURFACE_ORIGIN_PAD;
      const worldY = (scrollTop + localY) / z - SURFACE_ORIGIN_PAD;
      posX = Math.round(worldX / g) * g;
      posY = Math.round(worldY / g) * g;
    } else {
      const pos = findSmartPlacement({ blockW: size.width, blockH: size.height, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: getChatRailWidthPx(vw), existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
      posX = pos.x; posY = pos.y;
    }
    const id = addTextBlockAt({ x: posX, y: posY }, {
      width: size.width,
      height: size.height,
      content,
      format: "rich",
      data: { aiResponseBubble: true },
    });
    if (id) {
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("lyknchat_fit_block", { detail: { id } })));
      setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 500);
    }
  }, [addTextBlockAt, calcAiBubbleSize, getChatRailWidthPx]);

  const typeIntoAiResponseBlock = useCallback(async (blockId: string, fullText: string) => {
    const runId = ++aiTypingRunRef.current;
    const text = normalizeAiTextForBlock(fullText);
    let shown = "";
    while (shown.length < text.length && aiTypingRunRef.current === runId) {
      const nc = text.charAt(shown.length);
      const step = nc === "\n" ? 10 : 7;
      const delay = nc === "\n" ? 12 : /[.,!?]/.test(nc) ? 14 : 8;
      const nextLen = Math.min(text.length, shown.length + step);
      shown = text.slice(0, nextLen);
      const cur: any = useLyknChatStore.getState().blocks?.[blockId];
      if (cur?.data?.userResized) { updateBlock(blockId, { content: shown }); }
      else { const size = calcAiBubbleSize(shown); updateBlock(blockId, { content: shown, width: size.width, height: size.height }); }
      await new Promise<void>((res) => window.setTimeout(res, delay));
    }
    if (aiTypingRunRef.current === runId) {
      const cur: any = useLyknChatStore.getState().blocks?.[blockId];
      if (cur?.data?.userResized) updateBlock(blockId, { content: text });
      else { const size = calcAiBubbleSize(text); updateBlock(blockId, { content: text, width: size.width, height: size.height }); }
    }
  }, [calcAiBubbleSize, normalizeAiTextForBlock, updateBlock]);

  const typeResponseIntoChat = useCallback((promptId: string, fullText: string, targetChatId?: string | null): Promise<void> => {
    return new Promise((resolve) => {
      // Pin every write for this animation to the board that owns the
      // stream. Without this, switching chat tabs mid-stream reroutes the
      // typewriter into whatever board is now active (cross-chat bleed).
      const bid = targetChatId ?? streamChatIdRef.current ?? chatId ?? routeChatId ?? null;
      const key = String(bid || "");
      // Only supersede a previous animation on the SAME board — a second
      // chat starting its own typewriter must not cut off the first.
      const prevTimer = chatTypingTimersRef.current.get(key);
      if (prevTimer) { window.clearInterval(prevTimer); chatTypingTimersRef.current.delete(key); }
      const prev = chatTypingPendingsRef.current.get(key);
      if (prev) {
        patchThreadMessages((msgs) => msgs.map((m) => (m.id === prev.promptId ? { ...m, aiResponse: prev.fullText } : m)), prev.chatId);
        prev.resolve();
        chatTypingPendingsRef.current.delete(key);
      }
      const isActiveBoard = () => getActiveThreadChatId() === String(bid);
      const words = fullText.split(/(\s+)/);
      let idx = 0;
      chatTypingPendingsRef.current.set(key, { promptId, fullText, resolve, chatId: bid });
      patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)), bid);
      const timer = window.setInterval(() => {
        idx += 3;
        const partial = words.slice(0, idx).join("");
        patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: partial } : m)), bid);
        if (isActiveBoard() && !chatUserScrolledUpRef.current) {
          const el = chatScrollRef.current;
          if (el) { chatProgrammaticScrollRef.current = true; el.scrollTop = el.scrollHeight; }
        }
        if (idx >= words.length) {
          window.clearInterval(timer);
          if (chatTypingTimersRef.current.get(key) === timer) chatTypingTimersRef.current.delete(key);
          if (chatTypingPendingsRef.current.get(key)?.promptId === promptId) chatTypingPendingsRef.current.delete(key);
          patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: fullText } : m)), bid);
          resolve();
        }
      }, 30);
      chatTypingTimersRef.current.set(key, timer);
    });
  }, [patchThreadMessages, chatId, routeChatId]);

  const replaySavedPromptResponse = useCallback((msg: PromptMessage) => {
    if ((msg as any).aiImageUrl) {
      const imageUrl = String((msg as any).aiImageUrl);
      const st = useLyknChatStore.getState() as any;
      const order: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const existing = order.find((id: string) => { const blk = st.blocks?.[id]; return blk?.type === "create" && (blk as any).mode === "image" && (blk as any).data?.src === imageUrl; });
      if (existing) { window.dispatchEvent(new CustomEvent("lyknchat_expand_blocks", { detail: { ids: [existing] } })); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("lyknchat_fit_block", { detail: { id: existing } }))); return; }
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const cam = st.camera || { x: 0, y: 0 };
      const cx = cam.x + Math.floor((window.innerWidth || 1280) * 0.35);
      const cy = cam.y + Math.floor((window.innerHeight || 720) * 0.4);
      st.addBlock({ id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, type: "create", mode: "image", x: cx, y: cy, width: g * 12, height: g * 12, data: { src: imageUrl }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return;
    }
    const saved = String(msg?.aiResponse || "").trim();
    if (!saved) return;
    addChatResponseToGrid(saved);
  }, [addChatResponseToGrid]);

  const applyProjectActions = useCallback((actions: CreateAction[]) => {
    const list = Array.isArray(actions) ? actions : [];
    if (!list.length) return { created: 0, failures: [] as string[] };
    const st = useLyknChatStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280; const vh = window.innerHeight || 800;
    let created = 0; const failures: string[] = [];
    const gap = g * 2;

    // Sequential placement cursor: first create block finds a good start,
    // subsequent creates flow downward so multi-block batches stay grouped.
    let cursorX: number | null = null;
    let cursorY: number | null = null;
    let cursorColMaxW = 0;
    let cursorStartX: number | null = null;
    const maxColHeight = vh * 0.8;
    let cursorColTop: number | null = null;

    // Track all created block IDs so we can scroll to show them afterward
    const createdBlockIds: string[] = [];

    // Map AI-supplied placeholder IDs (e.g. "text-mokav5-header" from invented
    // `<add_blocks>` / `<add_wires>` markup) to the real block IDs the store
    // assigns at creation time, so connect_blocks/move_block/etc actions can
    // reference siblings that were just created in the same batch.
    const placeholderToId = new Map<string, string>();
    const recordPlaceholder = (raw: any, realId: string | null | undefined) => {
      if (!realId) return;
      const ph = String(raw?.placeholderId || raw?.placeholder || raw?.id || "").trim();
      if (ph && !placeholderToId.has(ph)) placeholderToId.set(ph, realId);
    };
    const resolveId = (rawId: any): string => {
      const s = String(rawId || "").trim();
      if (!s) return s;
      return placeholderToId.get(s) || s;
    };

    // Estimate block height accounting for word-wrap (no DOM context available)
    const estimateHeight = (content: string, widthPx: number, variant: "h1" | "h2" | "body" = "body"): number => {
      if (!content || !content.trim()) return g * 2;
      const charW = variant === "h1" ? 19 : variant === "h2" ? 12 : 6.5;
      const lineH = variant === "h1" ? 3 : variant === "h2" ? 2 : 1;
      const pad = 16;
      const availW = Math.max(charW * 4, widthPx - pad);
      const lines = content.split("\n");
      let wrapped = 0;
      for (const line of lines) {
        if (!line.trim()) { wrapped += 1; continue; }
        const estW = line.length * charW;
        wrapped += Math.max(1, Math.ceil(estW / availW));
      }
      const rows = wrapped * lineH;
      return Math.max(g * 2, (rows + 1) * g);
    };

    const getPos = (bw: number, bh: number, explicitX?: number, explicitY?: number) => {
      if (explicitX != null && explicitY != null) {
        const px = Math.round(explicitX / g) * g;
        const py = Math.round(explicitY / g) * g;
        return { x: px, y: py };
      }
      if (cursorX != null && cursorY != null) {
        const px = cursorX;
        const py = cursorY;
        cursorColMaxW = Math.max(cursorColMaxW, bw);
        cursorY = py + bh + gap;
        if (cursorColTop != null && cursorY - cursorColTop > maxColHeight) {
          cursorX = (cursorStartX ?? px) + cursorColMaxW + gap;
          cursorY = cursorColTop;
          cursorColMaxW = 0;
        }
        return { x: px, y: py };
      }

      // First block: anchor to the user's current viewport center
      const cur = useLyknChatStore.getState() as any;
      const cam = cur.camera || { x: 0, y: 0, zoom: 1 };
      const z = Math.max(0.1, cam.zoom || 1);
      const vpCenterX = (cam.x || 0) + (vw / z) / 2;
      const vpCenterY = (cam.y || 0) + (vh / z) / 2;
      // Start slightly above center so the batch flows into view naturally
      const startX = Math.round((vpCenterX - bw / 2) / g) * g;
      const startY = Math.round((vpCenterY - vh / z * 0.3) / g) * g;

      // Nudge away from direct overlaps with existing blocks
      const existingBlocks = Object.values(cur.blocks || {}).filter(Boolean) as any[];
      const overlaps = (px: number, py: number, pw: number, ph: number) =>
        existingBlocks.some((r: any) => px < (r.x || 0) + (r.width || g) + gap && px + pw > (r.x || 0) - gap && py < (r.y || 0) + (r.height || g) + gap && py + ph > (r.y || 0) - gap);

      let posX = startX, posY = startY;
      if (overlaps(posX, posY, bw, bh)) {
        // Try shifting right, then below, staying near viewport center
        const nudges = [
          { dx: bw + gap, dy: 0 }, { dx: -(bw + gap), dy: 0 },
          { dx: 0, dy: bh + gap }, { dx: bw + gap, dy: bh + gap },
          { dx: -(bw + gap), dy: bh + gap }, { dx: 0, dy: -(bh + gap) },
        ];
        let found = false;
        for (const { dx, dy } of nudges) {
          const nx = Math.round((startX + dx) / g) * g;
          const ny = Math.round((startY + dy) / g) * g;
          if (!overlaps(nx, ny, bw, bh)) { posX = nx; posY = ny; found = true; break; }
        }
        if (!found) {
          // Fall back to findSmartPlacement but it should be rare
          const pos = findSmartPlacement({ blockW: bw, blockH: bh, gridSize: g, camera: cam, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks });
          posX = pos.x; posY = pos.y;
        }
      }

      cursorX = posX;
      cursorY = posY + bh + gap;
      cursorStartX = posX;
      cursorColTop = posY;
      cursorColMaxW = bw;
      return { x: posX, y: posY };
    };
    for (const raw of list) {
      try {
        const type = String(raw?.type || "").trim().toLowerCase();
        if (type === "update_notes" || type === "append_notes") {
          const rawContent = (raw as any)?.content;
          if (!rawContent) { failures.push(`${type}: missing content`); continue; }
          setNotesOpen(true);
          setTimeout(() => {
            let tiptapDoc: any;
            if (typeof rawContent === "string") {
              tiptapDoc = markdownToTiptap(rawContent);
            } else if (rawContent?.type === "doc") { tiptapDoc = rawContent; }
            else { tiptapDoc = markdownToTiptap(String(rawContent)); }
            window.dispatchEvent(new CustomEvent("lyknchat_notes_ai_update", { detail: { action: type === "append_notes" ? "append" : "set", tiptapDoc, stream: true } }));
          }, 200);
          created += 1; continue;
        }
        if (type === "delete_block") {
          const ids: string[] = [];
          if ((raw as any)?.blockId) ids.push(String((raw as any).blockId));
          if (Array.isArray((raw as any)?.blockIds)) for (const bid of (raw as any).blockIds) ids.push(String(bid));
          const valid = ids.filter((bid) => Boolean(st.blocks?.[bid]));
          if (valid.length) { st.deleteBlocks(valid); created += valid.length; }
          else failures.push("delete_block: no matching block IDs found");
          continue;
        }
        const rawX = Number.isFinite((raw as any)?.x) ? Number((raw as any).x) : undefined;
        const rawY = Number.isFinite((raw as any)?.y) ? Number((raw as any).y) : undefined;
        if (type === "create_sheet" || type === "paper_outline" || type === "create_paper") {
          const t2 = String((raw as any)?.title || "").trim();
          const body = String((raw as any)?.content || (raw as any)?.outline || "").trim();
          const content = [t2 ? `# ${t2}` : "", body].filter(Boolean).join("\n\n");
          const w = g * 14;
          const h = Math.max(g * 8, estimateHeight(content, w));
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addSheetBlockAt({ x: pos.x, y: pos.y }, { content, width: w, height: h });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_spreadsheet") {
          const rows = Math.max(1, Math.min(1000, Number((raw as any)?.rows || 30)));
          const cols = Math.max(1, Math.min(100, Number((raw as any)?.cols || 20)));
          const pos = getPos(g * 14, g * 10, rawX, rawY);
          const bid = st.addSpreadsheetBlockAt({ x: pos.x, y: pos.y }, { rows, cols });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_table") {
          const colCount = Math.max(2, Math.min(10, Number((raw as any)?.cols || (raw as any)?.columns || 3)));
          const headers = Array.isArray((raw as any)?.headers)
            ? (raw as any).headers.map((h: any) => String(h || "").trim())
            : Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
          const rowData = Array.isArray((raw as any)?.rows) ? (raw as any).rows : [];
          const headerRow = "| " + headers.join(" | ") + " |";
          const dividerRow = "| " + headers.map(() => "----------").join(" | ") + " |";
          const dataRows = rowData.length
            ? rowData.map((row: any) => {
                const cells = Array.isArray(row) ? row : [String(row || "")];
                while (cells.length < headers.length) cells.push("");
                return "| " + cells.map((c: any) => String(c || "")).join(" | ") + " |";
              }).join("\n")
            : "| " + headers.map(() => "").join(" | ") + " |";
          const mdTable = [headerRow, dividerRow, dataRows].join("\n");
          // Match EditableMarkdownTable.autoGrow sizing so bricks render the full table without excess empty space.
          const COL_MIN_WIDTH = 120;
          const ROW_HEIGHT_EST = 36;
          const HEIGHT_PADDING = 48; // add-row button (24) + wrapper my-3 margins (24)
          const WIDTH_PADDING = 24; // brick horizontal padding + small buffer
          const snapUp = (n: number) => Math.ceil(n / g) * g;
          const rowCount = Math.max(1, rowData.length);
          const w = Math.max(g * 12, snapUp(headers.length * COL_MIN_WIDTH + WIDTH_PADDING));
          const h = Math.max(g * 5, snapUp((rowCount + 1) * ROW_HEIGHT_EST + HEIGHT_PADDING));
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, content: mdTable, format: "rich", data: { textVariant: "body", listType: "none" } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_list" || type === "todo_list" || type === "bulleted_list" || type === "numbered_list" || type === "create_checklist") {
          const requested = String((raw as any)?.listType || "");
          const listType = requested === "numbered" || type === "numbered_list" ? "numbered"
            : requested === "bulleted" || type === "bulleted_list" ? "bullet"
            : "todo";
          const items: string[] = Array.isArray((raw as any)?.items)
            ? (raw as any).items.map((it: any) => typeof it === "string" ? it : String(it?.text || ""))
            : String((raw as any)?.content || "").split(/\n+/).map((s: string) => s.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+\.\s*/, "").replace(/^\s*\[.?\]\s*/, "").trim()).filter(Boolean);
          if (!items.length) items.push("");
          const content = listType === "todo"
            ? items.map((t: string) => `[ ] ${t}`).join("\n")
            : listType === "bullet"
            ? items.map((t: string) => `• ${t}`).join("\n")
            : items.map((t: string, i: number) => `${i + 1}. ${t}`).join("\n");
          const w = g * 10;
          const blockH = estimateHeight(content, w);
          const pos = getPos(w, blockH, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: blockH, content, format: "rich", data: { textVariant: "body", listType } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_code_block" || type === "create_code_project") {
          const lang = String((raw as any)?.language || "plaintext").trim().toLowerCase() || "plaintext";
          const content = String((raw as any)?.content || "").trim();
          const w = g * 14;
          const h = Math.max(g * 4, estimateHeight(content, w));
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addCodeBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, language: lang, content });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_youtube_block") {
          const rawUrl = String((raw as any)?.url || "").trim();
          const videoId = extractYouTubeVideoId(rawUrl) || "";
          if (rawUrl || videoId) {
            const pos = getPos(g * 12, g * 8, rawX, rawY);
            const bid = st.addYouTubeBlockAt({ x: pos.x, y: pos.y }, { url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`, videoId });
            if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
            created++;
          } else failures.push("create_youtube_block: missing url");
          continue;
        }
        if (type === "create_heading" || type === "create_h1" || type === "create_h2" || type === "create_h3") {
          const level = type === "create_h3" || (raw as any)?.level === 3 ? 3 : type === "create_h2" || (raw as any)?.level === 2 ? 2 : 1;
          const content = String((raw as any)?.content || (raw as any)?.text || "").trim();
          const variant = level <= 1 ? "h1" : "h2";
          const w = g * 10;
          const h = estimateHeight(content, w, variant);
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, content, format: "rich", data: { textVariant: variant, listType: "none" } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_quote" || type === "create_callout") {
          const content = String((raw as any)?.content || (raw as any)?.text || "").trim();
          const cleanContent = content.split("\n").map((l: string) => l.replace(/^>\s*/, "")).join("\n");
          const w = g * 10;
          const h = estimateHeight(cleanContent, w);
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, content: cleanContent, format: "rich", data: { textVariant: "body", listType: "quote" } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_text" || type === "create_brick" || type === "create_text_block" || type === "create_card" || type === "create_sticky") {
          const content = String((raw as any)?.content || (raw as any)?.text || "").trim();
          const w = Number.isFinite((raw as any)?.width) ? Math.round(Number((raw as any).width) / g) * g : g * 8;
          const h = Number.isFinite((raw as any)?.height) ? Math.round(Number((raw as any).height) / g) * g : estimateHeight(content, w);
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, content, format: "rich", data: { textVariant: "body", listType: "none" } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_toggle" || type === "create_toggle_list") {
          const rawContent = String((raw as any)?.content || (raw as any)?.text || "").trim();
          const items: string[] = Array.isArray((raw as any)?.items)
            ? (raw as any).items.map((it: any) => typeof it === "string" ? it : String(it?.text || ""))
            : rawContent.split("\n").filter(Boolean);
          const content = items.map((t: string) => {
            if (/^[▶▼▸▾▷▽]/.test(t)) return t;
            return `▷\uFE0E ${t}`;
          }).join("\n");
          const w = g * 10;
          const h = estimateHeight(content, w);
          const pos = getPos(w, h, rawX, rawY);
          const bid = st.addTextBlockAt({ x: pos.x, y: pos.y }, { width: w, height: h, content, format: "rich", data: { textVariant: "body", listType: "toggle" } });
          if (bid) { createdBlockIds.push(bid); recordPlaceholder(raw, bid); }
          created++; continue;
        }
        if (type === "create_design_board") {
          const title = String((raw as any)?.title || "").trim();
          const seedText = String((raw as any)?.seedText || (raw as any)?.content || "").trim();
          const pos = getPos(g * 16, g * 12, rawX, rawY);
          const bid = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const b: any = {
            id: bid,
            type: "create", mode: "design",
            x: pos.x, y: pos.y, width: g * 16, height: g * 12,
            data: { title, board: { elements: [] }, seedText },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          st.addBlock(b);
          createdBlockIds.push(bid);
          recordPlaceholder(raw, bid);
          created++; continue;
        }
        if (type === "create_task_board" || type === "create_kanban") {
          const title = String((raw as any)?.title || "Task Board").trim();
          const columns = Array.isArray((raw as any)?.columns)
            ? (raw as any).columns
            : [{ title: "To Do", tasks: [] }, { title: "In Progress", tasks: [] }, { title: "Done", tasks: [] }];
          const pos = getPos(g * 18, g * 12, rawX, rawY);
          const bid = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const b: any = {
            id: bid,
            type: "create", mode: "taskboard",
            x: pos.x, y: pos.y, width: g * 18, height: g * 12,
            data: { title, columns },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          st.addBlock(b);
          createdBlockIds.push(bid);
          recordPlaceholder(raw, bid);
          created++; continue;
        }
        if (
          type === "create_media" ||
          type === "create_embed" ||
          type === "create_image_block" ||
          type === "create_video_block" ||
          type === "create_link" ||
          type === "create_website" ||
          type === "create_bookmark"
        ) {
          const rawUrl = String((raw as any)?.url || (raw as any)?.src || "").trim();
          // Models often emit bare domains ("google.com") instead of fully
          // qualified URLs. Promote them to https:// so the iframe / link
          // actually points somewhere navigable. We leave http:// and https://
          // and data: / blob: schemes alone.
          const url = rawUrl && !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)
            ? `https://${rawUrl.replace(/^\/+/, "")}`
            : rawUrl;
          // Pick the right rendering mode for the action variant. Old default
          // was "image" for everything-not-video/-image, which silently broke
          // embeds (the iframe-mode renderer never fired). Now create_embed /
          // create_website default to "embed", and create_link / create_bookmark
          // default to "link" (a tappable bookmark preview).
          let mode: string;
          if (type === "create_video_block") mode = "video";
          else if (type === "create_image_block") mode = "image";
          else if (type === "create_embed" || type === "create_website") mode = String((raw as any)?.mode || "embed");
          else if (type === "create_link" || type === "create_bookmark") mode = String((raw as any)?.mode || "link");
          else mode = String((raw as any)?.mode || "image");
          // Embedded websites get the og:image preview-card treatment via
          // LinkBlock + LinkPreview. Use modest "preview card" dimensions
          // (16:9-ish) instead of the giant viewer-surface size we'd want for
          // a true iframe — most sites block iframe embedding anyway, so the
          // preview card is what actually shows up.
          const isWebsiteEmbed = mode === "embed" && Boolean(url) && !/^data:/i.test(url);
          const isVideoEmbed = mode === "video";
          const defaultW = isVideoEmbed ? g * 16 : isWebsiteEmbed ? g * 14 : g * 12;
          const defaultH = isVideoEmbed ? g * 12 : isWebsiteEmbed ? g * 10 : g * 10;
          const pos = getPos(defaultW, defaultH, rawX, rawY);
          const bid = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const initialName = String((raw as any)?.name || (raw as any)?.title || "").trim();
          const b: any = {
            id: bid,
            type: "create", mode,
            x: pos.x, y: pos.y, width: defaultW, height: defaultH,
            data: { src: url, url, name: initialName },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          st.addBlock(b);
          createdBlockIds.push(bid);
          recordPlaceholder(raw, bid);
          created++;

          // For website embeds and bookmark links, fire off a background
          // unfurl so the brick picks up og:image / title / favicon. Without
          // this the brick renders as the gradient-monogram fallback (no
          // hero image), which is what the user sees as "not loading the
          // website's image". Fire-and-forget — failures are non-fatal,
          // the brick keeps the monogram as the fallback.
          const shouldUnfurl = url && /^https?:\/\//i.test(url) && (mode === "embed" || mode === "link");
          if (shouldUnfurl) {
            (async () => {
              try {
                const [{ API_BASE_URL }, { supabase }] = await Promise.all([
                  import("@/lib/api-config"),
                  import("@/lib/supabase").catch(() => ({ supabase: null as any })),
                ]);
                const headers: Record<string, string> = {};
                try {
                  const sess = await supabase?.auth?.getSession?.();
                  const token = sess?.data?.session?.access_token;
                  if (token) headers.Authorization = `Bearer ${token}`;
                } catch { /* anonymous request */ }
                const res = await fetch(
                  `${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`,
                  { headers }
                );
                if (!res.ok) return;
                const meta: any = await res.json();
                const cur: any = (useLyknChatStore.getState() as any).blocks?.[bid];
                if (!cur) return;
                const curData = cur?.data && typeof cur.data === "object" ? cur.data : {};
                useLyknChatStore.getState().updateBlock(bid, {
                  data: {
                    ...curData,
                    name: curData.name || meta.title || initialName,
                    ogTitle: meta.title || "",
                    ogDescription: meta.description || "",
                    ogImage: meta.image || "",
                    ogSiteName: meta.siteName || "",
                    ogFavicon: meta.favicon || "",
                    ...(meta.oembedType ? { oembedType: meta.oembedType } : {}),
                    ...(meta.oembedHtml ? { oembedHtml: meta.oembedHtml } : {}),
                    ...(meta.authorName ? { authorName: meta.authorName } : {}),
                    ...(meta.authorHandle ? { authorHandle: meta.authorHandle } : {}),
                  },
                } as any);
              } catch {
                // unfurl is best-effort — brick still works without preview
              }
            })();
          }
          continue;
        }
        if (type === "organize_grid" || type === "auto_organize" || type === "auto_layout") {
          const allBlocks = Object.values(st.blocks || {}).filter(Boolean) as any[];
          if (!allBlocks.length) { failures.push("organize_grid: no blocks on grid"); continue; }
          const strategy = String((raw as any)?.strategy || "grid").toLowerCase();
          const gap = g * 2;
          const colWidth = g * 14;
          const sorted = [...allBlocks].sort((a: any, b: any) => {
            const typeOrder: Record<string, number> = { text: 0, create: 1 };
            const ta = typeOrder[a.type] ?? 2;
            const tb = typeOrder[b.type] ?? 2;
            if (ta !== tb) return ta - tb;
            return String(a.content || a.data?.title || "").localeCompare(String(b.content || b.data?.title || ""));
          });
          const cam = st.camera || { x: 0, y: 0, zoom: 1 };
          const startX = Math.round(((cam.x || 0) + 100) / g) * g;
          const startY = Math.round(((cam.y || 0) + 100) / g) * g;
          if (strategy === "column" || strategy === "vertical") {
            let curY = startY;
            sorted.forEach((blk: any, i: number) => {
              setTimeout(() => {
                st.updateBlock(blk.id, { x: startX, y: curY });
              }, i * 30);
              curY += Math.max(g * 2, Math.floor(blk.height || g)) + gap;
            });
          } else {
            const maxCols = Math.max(1, (raw as any)?.columns || Math.ceil(Math.sqrt(sorted.length)));
            let curX = startX;
            let curY = startY;
            let colIdx = 0;
            let colMaxH = 0;
            sorted.forEach((blk: any, i: number) => {
              const bw = Math.max(g, Math.floor(blk.width || g));
              const bh = Math.max(g, Math.floor(blk.height || g));
              setTimeout(() => {
                st.updateBlock(blk.id, { x: curX, y: curY });
              }, i * 30);
              colMaxH = Math.max(colMaxH, bh);
              colIdx++;
              if (colIdx >= maxCols) {
                colIdx = 0;
                curX = startX;
                curY += colMaxH + gap;
                colMaxH = 0;
              } else {
                curX += Math.max(colWidth, bw) + gap;
              }
            });
          }
          created += allBlocks.length; continue;
        }
        if (type === "move_block" || type === "move_blocks") {
          const moves: Array<{ blockId: string; x?: number; y?: number; dx?: number; dy?: number }> = [];
          if ((raw as any)?.blockId) moves.push({ blockId: String((raw as any).blockId), x: (raw as any)?.x, y: (raw as any)?.y, dx: (raw as any)?.dx, dy: (raw as any)?.dy });
          if (Array.isArray((raw as any)?.moves)) for (const mv of (raw as any).moves) if (mv?.blockId) moves.push({ blockId: String(mv.blockId), x: mv?.x, y: mv?.y, dx: mv?.dx, dy: mv?.dy });
          moves.forEach((mv, i) => { setTimeout(() => { const block = (useLyknChatStore.getState() as any).blocks?.[mv.blockId] as any; if (!block) return; let nx = Math.floor(block.x || 0), ny = Math.floor(block.y || 0); if (mv.x != null) nx = Math.round(Number(mv.x) / g) * g; if (mv.y != null) ny = Math.round(Number(mv.y) / g) * g; if (mv.dx != null) nx += Math.round(Number(mv.dx) / g) * g; if (mv.dy != null) ny += Math.round(Number(mv.dy) / g) * g; st.updateBlock(mv.blockId, { x: nx, y: ny }); }, i * 35); created++; });
          continue;
        }
        if (type === "resize_block") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block) { failures.push(`resize_block: block not found`); continue; }
          const patch: any = {};
          if ((raw as any)?.width != null) patch.width = Math.round(Number((raw as any).width) / g) * g;
          if ((raw as any)?.height != null) patch.height = Math.round(Number((raw as any).height) / g) * g;
          if (Object.keys(patch).length) { st.updateBlock(blockId, patch); created++; }
          continue;
        }
        if (type === "update_text_block" || type === "update_block" || type === "edit_block") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block) { failures.push("update_text_block: block not found"); continue; }
          const patch: any = {};
          const existingData = block?.data && typeof block.data === "object" ? { ...block.data } : {};
          let contentChanged = false;
          let dataChanged = false;
          if ((raw as any)?.content != null) {
            patch.content = String((raw as any).content);
            contentChanged = true;
          } else if (typeof (raw as any)?.append === "string") {
            const cur2 = String(block?.content || "");
            patch.content = cur2 + (cur2.endsWith("\n") ? "" : "\n") + (raw as any).append;
            contentChanged = true;
          }
          if ((raw as any)?.data && typeof (raw as any).data === "object") {
            const d = (raw as any).data;
            if (d.textVariant) { existingData.textVariant = d.textVariant; dataChanged = true; }
            if (d.listType) { existingData.listType = d.listType; dataChanged = true; }
            if (d.brickColor !== undefined) { existingData.brickColor = d.brickColor || undefined; dataChanged = true; }
            if (d.textColor !== undefined) { existingData.textColor = d.textColor || undefined; dataChanged = true; }
            if (dataChanged) patch.data = existingData;
          }
          if (!contentChanged && !dataChanged) {
            failures.push("update_text_block: no content or data changes provided");
            continue;
          }
          if ((contentChanged || dataChanged) && !existingData.userResized) {
            const finalContent = patch.content ?? String(block.content || "");
            const variant = (existingData.textVariant || "body") as "h1" | "h2" | "body";
            const blockW = Math.max(g * 4, Number(block.width || g * 8));
            patch.height = estimateHeight(finalContent, blockW, variant);
          }
          st.updateBlock(blockId, patch);
          created++;
          continue;
        }
        if (type === "update_list") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block) { failures.push("update_list: block not found"); continue; }
          const existingData = block?.data && typeof block.data === "object" ? { ...block.data } : {};
          const listType = String(existingData.listType || (raw as any)?.listType || "bullet");
          let items: string[] = [];
          if (Array.isArray((raw as any)?.items)) {
            items = (raw as any).items.map((it: any) => typeof it === "string" ? it : String(it?.text || ""));
          }
          if (Array.isArray((raw as any)?.append)) {
            const existing = String(block.content || "").split("\n").map((l: string) => l.replace(/^\s*[-•*]\s*/, "").replace(/^\s*\d+\.\s*/, "").replace(/^\s*\[.?\]\s*/, "").trim()).filter(Boolean);
            const appended = (raw as any).append.map((it: any) => typeof it === "string" ? it : String(it?.text || ""));
            items = [...existing, ...appended];
          }
          if (!items.length) { failures.push("update_list: no items"); continue; }
          const content = listType === "todo"
            ? items.map((t: string) => `[ ] ${t}`).join("\n")
            : listType === "bullet"
            ? items.map((t: string) => `• ${t}`).join("\n")
            : items.map((t: string, i: number) => `${i + 1}. ${t}`).join("\n");
          const blockW = Math.max(g * 4, Number(block.width || g * 10));
          const h = estimateHeight(content, blockW);
          const patch: any = { content, height: h };
          if (!existingData.listType) patch.data = { ...existingData, listType, textVariant: "body" };
          st.updateBlock(blockId, patch);
          created++; continue;
        }
        if (type === "update_spreadsheet") {
          const blockId = String((raw as any)?.blockId || (raw as any)?.target === "last" ? Object.keys(st.blocks || {}).reverse().find((id) => { const b = (st.blocks as any)?.[id]; return b?.format === "table"; }) : "");
          const block = st.blocks?.[blockId] as any;
          if (!block) { failures.push("update_spreadsheet: block not found"); continue; }
          try {
            const sheetData = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
            const cells = sheetData?.cells || {};
            if ((raw as any)?.cells && typeof (raw as any).cells === "object") {
              for (const [key, val] of Object.entries((raw as any).cells)) {
                cells[key] = String(val ?? "");
              }
            }
            if (Array.isArray((raw as any)?.cells2d)) {
              const startRow = Number((raw as any)?.startRow || 0);
              const startCol = Number((raw as any)?.startCol || 0);
              (raw as any).cells2d.forEach((row: any[], ri: number) => {
                if (!Array.isArray(row)) return;
                row.forEach((val: any, ci: number) => {
                  cells[`${startRow + ri},${startCol + ci}`] = String(val ?? "");
                });
              });
            }
            sheetData.cells = cells;
            st.updateBlock(blockId, { content: JSON.stringify(sheetData) });
            created++;
          } catch { failures.push("update_spreadsheet: parse error"); }
          continue;
        }
        if (type === "update_code_block") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block) { failures.push("update_code_block: block not found"); continue; }
          const patch: any = {};
          if ((raw as any)?.content != null) patch.content = String((raw as any).content);
          else if (typeof (raw as any)?.append === "string") {
            const cur2 = String(block?.content || "");
            patch.content = cur2 + (cur2.endsWith("\n") ? "" : "\n") + (raw as any).append;
          }
          if ((raw as any)?.language) {
            const data = block?.data && typeof block.data === "object" ? { ...block.data } : {};
            data.language = String((raw as any).language);
            patch.data = data;
          }
          const finalContent = patch.content ?? String(block.content || "");
          const blockW = Math.max(g * 4, Number(block.width || g * 14));
          patch.height = Math.max(g * 4, estimateHeight(finalContent, blockW));
          if (Object.keys(patch).length) { st.updateBlock(blockId, patch); created++; }
          continue;
        }
        if (type === "color_block" || type === "set_color" || type === "color_brick") {
          const ids: string[] = [];
          if ((raw as any)?.blockId) ids.push(String((raw as any).blockId));
          if (Array.isArray((raw as any)?.blockIds)) for (const bid of (raw as any).blockIds) ids.push(String(bid));
          if (!ids.length) { failures.push("color_block: missing blockId"); continue; }
          const brickColor = (raw as any)?.brickColor ?? (raw as any)?.backgroundColor ?? (raw as any)?.background ?? undefined;
          const textColor = (raw as any)?.textColor ?? (raw as any)?.color ?? (raw as any)?.fontColor ?? undefined;
          for (const blockId of ids) {
            const block = st.blocks?.[blockId] as any;
            if (!block) continue;
            const data = block?.data && typeof block.data === "object" ? { ...block.data } : {};
            if (brickColor !== undefined) data.brickColor = brickColor || undefined;
            if (textColor !== undefined) data.textColor = textColor || undefined;
            st.updateBlock(blockId, { data } as any);
            created++;
          }
          continue;
        }
        if (type === "connect_blocks" || type === "add_wire" || type === "create_connection") {
          const fromId = resolveId((raw as any)?.fromId ?? (raw as any)?.from ?? (raw as any)?.fromPlaceholder);
          const toId = resolveId((raw as any)?.toId ?? (raw as any)?.to ?? (raw as any)?.toPlaceholder);
          if (!fromId || !toId) { failures.push("connect_blocks: missing fromId or toId"); continue; }
          const fromBlock = st.blocks?.[fromId] as any;
          const toBlock = st.blocks?.[toId] as any;
          if (!fromBlock) { failures.push(`connect_blocks: fromId "${fromId}" not found`); continue; }
          if (!toBlock) { failures.push(`connect_blocks: toId "${toId}" not found`); continue; }
          const validSides = ["top", "right", "bottom", "left"];
          const aiFromSide = String((raw as any)?.fromSide || (raw as any)?.fromAnchor || "");
          const aiToSide = String((raw as any)?.toSide || (raw as any)?.toAnchor || "");
          let fromSide: string;
          let toSide: string;
          if (validSides.includes(aiFromSide) && validSides.includes(aiToSide)) {
            fromSide = aiFromSide;
            toSide = aiToSide;
          } else {
            const fCx = (fromBlock.x || 0) + (fromBlock.width || 0) / 2;
            const fCy = (fromBlock.y || 0) + (fromBlock.height || 0) / 2;
            const tCx = (toBlock.x || 0) + (toBlock.width || 0) / 2;
            const tCy = (toBlock.y || 0) + (toBlock.height || 0) / 2;
            const dx = tCx - fCx;
            const dy = tCy - fCy;
            if (Math.abs(dx) >= Math.abs(dy)) {
              fromSide = dx >= 0 ? "right" : "left";
              toSide = dx >= 0 ? "left" : "right";
            } else {
              fromSide = dy >= 0 ? "bottom" : "top";
              toSide = dy >= 0 ? "top" : "bottom";
            }
          }
          st.addWireConnection({ fromId, toId, fromSide: fromSide as any, toSide: toSide as any });
          created++; continue;
        }
        if (type === "remove_connection" || type === "remove_wire" || type === "disconnect_blocks") {
          const fromId = String((raw as any)?.fromId || (raw as any)?.from || "");
          const toId = String((raw as any)?.toId || (raw as any)?.to || "");
          const wireId = String((raw as any)?.wireId || (raw as any)?.connectionId || "");
          if (wireId) {
            st.removeWireConnection(wireId);
            created++; continue;
          }
          if (fromId && toId) {
            const wire = st.wireConnections.find((w: any) => (w.fromId === fromId && w.toId === toId) || (w.fromId === toId && w.toId === fromId));
            if (wire) { st.removeWireConnection(wire.id); created++; }
            else failures.push("disconnect_blocks: no matching connection found");
            continue;
          }
          if (fromId) { st.clearWireConnectionsForBlock(fromId); created++; continue; }
          failures.push("disconnect_blocks: missing fromId/toId or wireId"); continue;
        }
        // Fallback for unknown types
        failures.push(`Unsupported action: ${type || "unknown"}`);
      } catch { failures.push(`Failed action: ${String((raw as any)?.type || "unknown")}`); }
    }

    // Pan (and softly zoom out if needed) so the user sees what was just built.
    // For a single block the legacy fit-and-scale handler still works best;
    // for a multi-block batch (e.g. an AI-generated column of shots) we need a
    // bounding-box fit so the camera doesn't end up parked on just the first
    // brick with the rest off-screen.
    if (createdBlockIds.length === 1) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("lyknchat_fit_block", { detail: { id: createdBlockIds[0] } }));
      });
      setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 500);
    } else if (createdBlockIds.length > 1) {
      // Wait two frames so any pending block additions have laid out their
      // measured size before we compute the bounding box.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("lyknchat_fit_blocks", { detail: { ids: createdBlockIds } }));
        });
      });
      setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 500);
    }

    // Demo grids never persist (see useLyknChatPersistence: every save path
    // bails on isDemoLyknChatId). If the AI just put real work onto a demo
    // grid, warn the user once per session so they don't lose it on
    // refresh — past confusion came from the AI confidently creating
    // bricks here that silently vanished on next page load.
    if (createdBlockIds.length > 0) {
      const activeChatId = routeChatId || chatId || "";
      if (isDemoLyknChatId(activeChatId)) {
        const flagKey = `lyknchat_demo_warned_${activeChatId}`;
        let alreadyWarned = false;
        try { alreadyWarned = sessionStorage.getItem(flagKey) === "1"; } catch { /* ignore */ }
        if (!alreadyWarned) {
          try { sessionStorage.setItem(flagKey, "1"); } catch { /* ignore */ }
          toast({
            title: "This is a demo chat",
            description: "Changes here aren't saved. Refresh and they're gone. Sign in and start a new chat to keep this work.",
            duration: 8000,
          });
        }
      }
    }

    return { created, failures };
  }, [setNotesOpen, chatId, routeChatId]);

  /* ---------- handleChatSend (delegates to orchestrator) ---------- */

  const handleChatSend = useCallback(async () => {
    const text = chatInputRef.current.trim();
    // Allow sending with no text as long as something else is attached
    // (vault drops / files / a pending brick action). Mirrors ChatGPT,
    // where an image/file alone is a valid turn.
    const hasAttachment =
      focusedChatAttachments.length > 0 ||
      Boolean(pendingBrickActionDataRef.current?.videoId);
    if (!text && !hasAttachment) return;

    const sendMode = composerModeRef.current;
    const streamChatId = String(routeChatId || chatId || "");
    // Per-board guard: block a second send for THIS chat only. Other
    // chats in the thread can stream at the same time.
    if (sendingBoardsRef.current.has(streamChatId)) return;
    const targetSnap = streamChatId ? getThreadSnapshot(streamChatId) : null;
    if (targetSnap?.isChatLoading) return;

    chatUserScrolledUpRef.current = false;
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    const now = Date.now();
    // Scope the dupe-send signature to the target chat — a single global
    // signature silently swallowed sends of the same text into a different
    // chat within the debounce window.
    const sig = `${streamChatId}|${text.length > 100 ? text.slice(0, 100) : text}`;
    if (lastSendSigRef.current.text === sig && now - lastSendSigRef.current.at < 900) return;
    lastSendSigRef.current = { text: sig, at: now };

    streamChatIdRef.current = streamChatId;
    const priorSnap = getThreadSnapshot(streamChatId);
    priorSnap?.abortController?.abort();
    const sendAbort = new AbortController();
    activeAiAbortRef.current = sendAbort;
    registerStreamAbortController(streamChatId, sendAbort);

    // Fresh, per-send stream cursor so concurrent chats never share a
    // typing position / prompt id (which caused responses to bleed or
    // get deleted across chats). Registered per board so handleStopAi
    // can flush the right stream.
    const sendStreamRefs = {
      streamTargetTextRef: { current: "" },
      streamDisplayedLenRef: { current: 0 },
      streamTypingRafRef: { current: null as number | null },
      streamPromptIdRef: { current: null as string | null },
    };
    streamRuntimeRef.current.set(streamChatId, sendStreamRefs);

    const threadState = bindThreadStateCallbacks(streamChatId, {
      setChatStatusText,
      setChatMessages,
      setIsChatLoading,
      setChatFlowMode,
    });
    isSendingRef.current = true;
    sendingBoardsRef.current.add(streamChatId);
    const sentAttachments = [...focusedChatAttachments];
    const brickActionData = pendingBrickActionDataRef.current;
    pendingBrickActionDataRef.current = null;
    if (brickActionData?.videoId && !sentAttachments.some((a: any) => a.videoId === brickActionData.videoId)) {
      sentAttachments.push({ type: "youtube", videoId: brickActionData.videoId, url: `https://www.youtube.com/watch?v=${brickActionData.videoId}`, name: `YouTube ${brickActionData.videoId}` } as any);
    }
    setChatInput("");
    setComposerMode("none");
    setFocusedChatAttachments([]);
    threadState.setIsChatLoading(true);
    threadState.setChatStatusText("");
    threadState.setChatFlowMode("idle");

    // Reconcile out-of-band React appends into this board's snapshot BEFORE we
    // rebuild from it. Voice turns and drag-drops are pushed straight to the
    // React message list (bypassing the snapshot the send reads from + rebuilds
    // React from), so without this they'd be wiped from the chat window on send
    // AND never reach the model. We derive the model thread from the messages
    // themselves rather than aiThreadRef, which the orchestrator leaves stale
    // after typed turns (it mutates only the snapshot's aiThread).
    try {
      const reconcileSnap = ensureThreadSnapshot(streamChatId);
      const reactMsgs = chatMessagesRef.current || [];
      if (reactMsgs.length > reconcileSnap.chatMessages.length) {
        const missing = reactMsgs.slice(reconcileSnap.chatMessages.length);
        reconcileSnap.chatMessages = [...reconcileSnap.chatMessages, ...missing];
        for (const m of missing) {
          const atts = Array.isArray((m as PromptMessage).attachments) ? (m as PromptMessage).attachments || [] : [];
          const attCtx = atts.length ? buildAttachmentContext(atts as FocusedChatAttachment[]) : "";
          const userContent = `${String(m.content || "").trim()}${attCtx}`.trim();
          if (userContent) reconcileSnap.aiThread.push({ role: "user", content: userContent });
          if (m.aiResponse) reconcileSnap.aiThread.push({ role: "assistant", content: String(m.aiResponse) });
        }
        if (reconcileSnap.aiThread.length > 40) reconcileSnap.aiThread.splice(0, reconcileSnap.aiThread.length - 40);
        reconcileSnap.updatedAt = Date.now();
      }
    } catch { /* reconciliation is best-effort; never block a send */ }

    const promptId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // Keep the FULL prompt as the message content. The bubble UI handles
    // long-prompt collapse + "show more" affordance via expandedUserPromptIds
    // — the user must always be able to read back what they actually sent.
    threadState.setChatMessages((prev) => [...prev, {
      id: promptId,
      role: "user",
      content: text,
      kind: "prompt",
      createdAt: new Date().toISOString(),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    }]);
    const sendSnap = ensureThreadSnapshot(streamChatId);
    chatMessagesRef.current = sendSnap.chatMessages;

    try {
      const editArtifact = activeArtifactRef.current;
      const artifactChatId = String(editArtifact?.sourceChatId || "").trim();
      const thisChatId = String(streamChatId || "").trim();
      // Only refine artifacts tagged to THIS board. Untagged / other-chat
      // panel state must not force edits or strip Build on a fresh chat.
      const artifactBelongsHere =
        !!editArtifact && !!thisChatId && artifactChatId === thisChatId;
      const isBuildMode = sendMode === "create:webapp";
      const hasAttachedImage = sentAttachments.some(
        (a) => (a.type || "").toLowerCase() === "image" && !!a.url,
      );
      // Short tweak while Build is still armed → surgical. Otherwise Build
      // mode is a FRESH coded artifact (reference-image games, new apps) —
      // never strip Create or ship Smash Arena as activeArtifact.
      const looksLikeSurgicalTweak =
        text.trim().length < 140 &&
        /\b(?:fix|change|update|tweak|adjust|add|rename|remove|delete|patch|bug|typo|font|colou?r|theme)\b/i.test(
          text,
        );
      const buildModeFresh =
        isBuildMode && (hasAttachedImage || !looksLikeSurgicalTweak);
      const refiningOpenArtifact =
        artifactBelongsHere &&
        isEditableArtifact(editArtifact) &&
        !buildModeFresh;
      // Other Create kinds (deck/doc/…) still defer to surgical refine when
      // an artifact from THIS chat is open. Build mode does not.
      const effectiveComposerMode =
        refiningOpenArtifact &&
        typeof sendMode === "string" &&
        sendMode.startsWith("create:") &&
        !isBuildMode
          ? "none"
          : sendMode;
      if (buildModeFresh && editArtifact) {
        console.log(
          `🧑‍💻 Build mode: starting fresh (ignoring open "${String(editArtifact.title || "").slice(0, 60)}")`,
        );
      }
      await orchestrateChatSend({
        text,
        promptId,
        composerMode: effectiveComposerMode,
        // Thread the open panel artifact for surgical edits — same chat only.
        // Build-mode fresh turns send null so the server cannot force edits.
        activeArtifact: refiningOpenArtifact
          ? toArtifactEditContext(editArtifact as ChatArtifact)
          : null,
        sentAttachments,
        brickActionData,
        // Pull conversation context from THIS board's snapshot so chats
        // in a thread never share message history (no merging/bleed).
        chatMessages: sendSnap.chatMessages,
        aiThread: sendSnap.aiThread,
        conversationSummary: sendSnap.convoSummary,
        abortController: sendAbort,
        identity: {
          selectedModel,
          customModelId: customModelId ?? null,
          chatId,
          routeChatId,
          projectId,
          scopedProjectId: scopedProjectId ?? null,
          scopedProjectName: scopedProjectName ?? null,
          userId: user?.id,
        },
        context: {
          buildLyknChatContext,
          buildActionLyknChatContext,
          getKnowledgeBaseContext,
          getCachedWorkspaceSummary,
          tiptapJsonToPlainText: (node: any) => {
            const fn = (n: any): string => {
              if (!n || typeof n !== "object") return "";
              let t = "";
              if (n.type === "text") return n.text || "";
              if (n.type === "youtube" && n.attrs?.src) return `\n[YouTube: ${n.attrs.src}]\n`;
              if (n.type === "webEmbed" && n.attrs?.src) return `\n[Embedded link: ${n.attrs.src}]\n`;
              if (n.type === "image" && n.attrs?.src) return `\n[Image: ${n.attrs.alt || ""} ${n.attrs.src}]\n`;
              if (Array.isArray(n.content)) for (const child of n.content) t += fn(child);
              const block = n.type === "paragraph" || n.type === "heading" || n.type === "listItem" || n.type === "taskItem" || n.type === "blockquote";
              if (block) t += "\n";
              return t;
            };
            return fn(node);
          },
          notesContent: (() => {
            const pages = notesPagesRef.current;
            if (!pages || pages.length === 0) return { type: "doc", content: [{ type: "paragraph" }] };
            if (pages.length === 1) return pages[0].content;
            const merged: any[] = [];
            for (const p of pages) {
              merged.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: p.title }] });
              if (p.content?.content) merged.push(...p.content.content);
            }
            return { type: "doc", content: merged };
          })(),
          titleRef,
        },
        youtube: {
          youtubeTranscriptCache: youtubeTranscriptCacheRef.current,
          youtubeTranscriptFails: youtubeTranscriptFailRef.current,
          getAllYouTubeBlocks,
          buildYouTubeGrounding,
        },
        analysis: { isVideoQuestion, looksLikeDeflectingQuestion, sanitizeAssistantResponse, buildDirectVideoAnswerFromGrounding },
        postProcessing: { extractSourceLinks, extractAiConnections, extractAndApplyTagActions, extractAndEmbedYouTubeUrls, extractAndEmbedMediaItems, extractWebLinksFromText, attachSourcesToBlock },
        canvas: { getCanvasState: () => useLyknChatStore.getState(), updateBlock, deleteBlock, normalizeAiTextForBlock, calcAiBubbleSize, applyProjectActions },
        state: {
          ...threadState,
          setConnectionCards,
          setShowConnectionCard,
          setMediaSuggestions,
          setSelectedMediaIds,
          setShowMediaSuggestion,
        },
        streamRefs: { ...sendStreamRefs, chatScrollRef, chatUserScrolledUpRef, chatProgrammaticScrollRef },
        typing: {
          typeResponseIntoChat: (pid: string, full: string) => typeResponseIntoChat(pid, full, streamChatId),
          typeIntoAiResponseBlock,
          maybeRunConversationSummary: () => maybeRunConversationSummary(streamChatId),
        },
        supabaseClient: supabase,
      });
    } catch (err: any) {
      if (err?.name === "AbortError" && sendAbort !== activeAiAbortRef.current) { threadState.setChatStatusText(""); return; }
      threadState.setChatFlowMode("idle");
      const errMsg = user?.id
        ? AI_TEMPORARY_FAILURE_TEXT
        : AI_GUEST_TEMPORARY_FAILURE_TEXT;
      threadState.setChatStatusText(errMsg);
      threadState.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errMsg } : m)));
    } finally {
      threadState.setIsChatLoading(false);
      patchThreadSnapshot(streamChatId, { abortController: null, isChatLoading: false });
      sendingBoardsRef.current.delete(streamChatId);
      streamRuntimeRef.current.delete(streamChatId);
      isSendingRef.current = sendingBoardsRef.current.size > 0;
      threadState.setChatFlowMode("idle");
      window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
      if (user?.id) {
        setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 300);
      }
    }
  }, [
    focusedChatAttachments, selectedModel, customModelId, chatId, routeChatId, projectId, scopedProjectId, scopedProjectName, user?.id, setChatInput, setComposerMode,
    buildLyknChatContext, getKnowledgeBaseContext, getCachedWorkspaceSummary,
    getAllYouTubeBlocks, buildYouTubeGrounding, isVideoQuestion, looksLikeDeflectingQuestion,
    sanitizeAssistantResponse, buildDirectVideoAnswerFromGrounding,
    extractSourceLinks, extractAiConnections, extractAndApplyTagActions,
    extractAndEmbedYouTubeUrls, extractAndEmbedMediaItems, extractWebLinksFromText, attachSourcesToBlock,
    updateBlock, deleteBlock, normalizeAiTextForBlock, calcAiBubbleSize, applyProjectActions,
    setConnectionCards, setShowConnectionCard, setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    typeResponseIntoChat, typeIntoAiResponseBlock, maybeRunConversationSummary,
  ]);

  const handleStopAi = useCallback(() => {
    // Stop only the chat the user is currently viewing — other chats in
    // the thread keep streaming.
    const bid = String(getActiveThreadChatId() || streamChatIdRef.current || chatId || routeChatId || "");
    const snap = bid ? getThreadSnapshot(bid) : null;
    (snap?.abortController || activeAiAbortRef.current)?.abort();
    activeAiAbortRef.current = null;
    if (bid) registerStreamAbortController(bid, null);
    const sr = bid ? streamRuntimeRef.current.get(bid) : null;
    if (sr) {
      if (sr.streamTypingRafRef.current) { clearTimeout(sr.streamTypingRafRef.current); sr.streamTypingRafRef.current = null; }
      if (sr.streamPromptIdRef.current && sr.streamDisplayedLenRef.current < sr.streamTargetTextRef.current.length) {
        patchThreadMessages((prev) => prev.map((m) => (m.id === sr.streamPromptIdRef.current ? { ...m, aiResponse: sr.streamTargetTextRef.current } : m)), bid);
      }
      sr.streamTargetTextRef.current = ""; sr.streamDisplayedLenRef.current = 0; sr.streamPromptIdRef.current = null;
    }
    const stoppedTimer = chatTypingTimersRef.current.get(bid);
    if (stoppedTimer) { window.clearInterval(stoppedTimer); chatTypingTimersRef.current.delete(bid); }
    const pending = chatTypingPendingsRef.current.get(bid);
    if (pending) {
      patchThreadMessages((prev) => prev.map((m) => (m.id === pending.promptId ? { ...m, aiResponse: pending.fullText } : m)), pending.chatId);
      pending.resolve();
      chatTypingPendingsRef.current.delete(bid);
    }
    if (bid) {
      sendingBoardsRef.current.delete(bid);
      streamRuntimeRef.current.delete(bid);
      patchThreadSnapshot(bid, { isChatLoading: false });
    }
    isSendingRef.current = sendingBoardsRef.current.size > 0;
    setIsChatLoading(false);
    setChatFlowMode("idle");
    setChatStatusText("Stopped");
  }, [chatId, routeChatId, patchThreadMessages]);

  const handleDictateToggle = useCallback(() => {
    if (isDictating) {
      try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop(); } catch {}
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size > 0) audioChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        try { mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
        mediaStreamRef.current = null; mediaRecorderRef.current = null; setIsDictating(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        if (blob.size < 2000) return;
        setIsTranscribing(true);
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const formData = new FormData();
          formData.append("audio", blob, "dictation.webm");
          formData.append("model", "whisper-1"); formData.append("language", "en");
          const cur = String(chatInputRef.current || "").trim();
          if (cur) formData.append("prompt", cur.split(/\s+/).slice(-12).join(" "));
          const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, { method: "POST", body: formData });
          const data = await res.json().catch(() => ({}));
          const transcript = String(data?.text || "").trim();
          if (res.ok && transcript) setChatInput((prev) => { const c = String(prev || "").trim(); return c ? `${c} ${transcript}` : transcript; });
        } catch {}
        setIsTranscribing(false);
      };
      recorder.onerror = () => { setIsDictating(false); setIsTranscribing(false); };
      recorder.start(); setIsDictating(true);
    }).catch(() => setIsDictating(false));
  }, [isDictating, setChatInput]);

  /* ---------- Voice Mode ---------- */

  const setVoiceMode = useCallback((on: boolean) => {
    voiceModeOnRef.current = on;
    setVoiceModeOn(on);
    if (!on) {
      // Leaving voice mode: cut off any audio still playing.
      void import("@/lib/ai/speakText").then(({ stopSpeaking }) => stopSpeaking()).catch(() => {});
    }
  }, []);

  const toggleVoiceMode = useCallback(() => {
    setVoiceMode(!voiceModeOnRef.current);
  }, [setVoiceMode]);

  // Drive one voice conversation turn through the normal chat pipeline and
  // hand the assistant's final reply text back to the voice overlay so it
  // can speak it. The full reply lands on the prompt message in the thread
  // snapshot once the orchestrator resolves.
  const sendVoiceTurn = useCallback(async (text: string): Promise<string> => {
    const clean = String(text || "").trim();
    if (!clean) return "";
    const streamChatId = String(routeChatId || chatId || "");
    setChatInput(clean);
    const before = getThreadSnapshot(streamChatId)?.chatMessages?.length ?? 0;
    await handleChatSend();
    const after = getThreadSnapshot(streamChatId);
    const msgs = after?.chatMessages ?? [];
    // The turn we just sent is the most recent prompt; its aiResponse holds
    // the post-processed reply.
    const last = msgs.length >= before ? msgs[msgs.length - 1] : undefined;
    return String(last?.aiResponse || "").trim();
  }, [routeChatId, chatId, setChatInput, handleChatSend]);

  const removeFocusedAttachment = useCallback((id: string) => {
    setFocusedChatAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Declared before `handleChatPaste` (which lists it in its deps array) so the
  // const is initialized by the time React evaluates that dependency at render.
  const addFocusedAttachment = useCallback((att: FocusedChatAttachment) => {
    setFocusedChatAttachments((prev) => {
      const isDup = prev.some((ex) => {
        if (att.url && ex.url && att.url === ex.url) return true;
        if (att.videoId && ex.videoId && att.videoId === ex.videoId) return true;
        if (att.type === "vault" && ex.type === "vault" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
        if (att.type === "note" && ex.type === "note" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
        return false;
      });
      return isDup ? prev : [...prev, att];
    });
  }, []);

  // Patch an existing composer attachment in place (e.g. to backfill a durable
  // storagePath once a background upload lands). Keyed by attachment id.
  const updateFocusedAttachment = useCallback((id: string, patch: Record<string, unknown>) => {
    setFocusedChatAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  }, []);

  const handleChatPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Branch on HTML, a file payload (pasted screenshots / copied files), or
    // neither. When only plain text is present we let the browser paste it
    // natively — that path also preserves default textarea behaviour (undo,
    // IME, etc).
    const ta = e.currentTarget;
    const html = e.clipboardData.getData("text/html");
    // Materialize the FileList synchronously: it is tied to the event and
    // becomes unusable once the handler returns (the File objects survive).
    const pastedFiles = e.clipboardData.files ? Array.from(e.clipboardData.files) : [];
    const hasFiles = pastedFiles.length > 0;
    if (!html.trim() && !hasFiles) return;

    // Pasted files (screenshots, copied images, file copies) become chat
    // attachments via the same pipeline as the composer file picker.
    if (hasFiles) {
      e.preventDefault();
      void ingestChatFiles(pastedFiles, addFocusedAttachment, {
        userId: user?.id,
        updateAttachment: updateFocusedAttachment,
      });
    }

    const text = getStructuredPasteFromEvent(e);
    // Image-only pastes have no text/html or text/plain → nothing to insert.
    if (!text) {
      if (hasFiles) setTimeout(() => ta?.focus?.(), 0);
      return;
    }

    e.preventDefault();
    const start = ta.selectionStart; const end = ta.selectionEnd;
    const prev = chatInputRef.current;
    const newVal = prev.slice(0, start) + text + prev.slice(end);
    chatInputRef.current = newVal;
    ta.value = newVal;
    setChatInputHasText(!!newVal.trim());
    resizeChatInputEl(ta);
    const nc = start + text.length;
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = nc; ta.focus(); }, 0);
  }, [addFocusedAttachment, updateFocusedAttachment, user?.id]);

  const handleOpenAttachments = useCallback(() => setShowAttachMenu(true), [setShowAttachMenu]);

  const makeAttId = () => (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) || `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inferUrlAttachmentType = useCallback((url: string) => {
    const trimmed = String(url || "").trim();
    if (!trimmed) return "link";
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) return "youtube";
    const ext = (() => { try { const p = new URL(trimmed); const fn = decodeURIComponent(p.pathname.split("/").pop() || ""); return fn.includes(".") ? fn.split(".").pop()?.toLowerCase() || "" : ""; } catch { return ""; } })();
    if (["png","jpg","jpeg","gif","webp","svg","bmp","avif","heic","heif"].includes(ext)) return "image";
    if (["mp4","mov","webm","mkv","avi"].includes(ext)) return "video";
    if (["mp3","wav","m4a","ogg","aac","flac"].includes(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    return "link";
  }, []);

  const applyVaultDropToChat = useCallback(async (payload: any) => {
    if (!payload) return;
    const title2 = String(payload.title || "Vault item").trim();
    const content = String(payload.content || "").trim();
    const payloadAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (payloadAttachments.length > 0) {
      for (const att of payloadAttachments) {
        const attType = String(att?.type || "").toLowerCase();
        let url = String(att?.url || "").trim();
        let videoId = String(att?.videoId || "").trim();
        if (!videoId && attType === "youtube") videoId = extractYouTubeVideoId(url) || "";
        if (!url && videoId) url = `https://www.youtube.com/watch?v=${videoId}`;
        const pathOnly = String(att?.storagePath || "").trim();
        const bucket = String(att?.storageBucket || "user-files").trim() || "user-files";
        if (!url || (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube")) {
          try { const path = pathOnly || url; if (path) { const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7); if (data?.signedUrl) url = data.signedUrl; } } catch {}
        }
        // Carry the durable storagePath onto the chat attachment. The signed
        // `url` above is stripped when the chat is persisted (signed URLs are
        // short-lived); keeping storagePath lets reSignChatAttachments mint a
        // fresh URL on reload so the image doesn't break after leaving/returning.
        const storageMeta = pathOnly ? { storagePath: pathOnly, storageBucket: bucket } : {};
        const transcript = String(att?.transcript || "").trim();
        const pdfText = String(att?.pdfText || att?.extractedText || "").trim();
        if (!url && pdfText) { addFocusedAttachment({ id: makeAttId(), type: "pdf", url: "", name: String(att?.name || att?.title || title2 || "PDF").trim(), mime: String(att?.mime || "application/pdf"), size: Number(att?.size || 0), vaultTitle: title2, pdfText, ...storageMeta }); continue; }
        if (!url) continue;
        addFocusedAttachment({ id: makeAttId(), type: attType || inferUrlAttachmentType(url), url, name: String(att?.name || att?.title || title2 || url).trim(), mime: String(att?.mime || ""), size: Number(att?.size || 0), vaultTitle: title2, ...(videoId ? { videoId } : {}), ...(transcript ? { transcript } : {}), ...(pdfText ? { pdfText } : {}), ...storageMeta });
      }
    } else if (content) {
      addFocusedAttachment({ id: makeAttId(), type: "vault", url: "", name: title2 || "Vault item", mime: "", size: 0, vaultTitle: title2, vaultContent: content });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment, inferUrlAttachmentType]);

  const resizeChatInput = useCallback(resizeChatInputEl, []);

  // Auto-send effect for brick actions
  useEffect(() => {
    if (pendingAiBrickActionRef.current && chatInputRef.current.trim()) {
      pendingAiBrickActionRef.current = false;
      handleChatSend();
    }
  }, [chatInputHasText, handleChatSend]);

  const cleanupDraftTimers = useCallback(() => {
    for (const timer of chatTypingTimersRef.current.values()) window.clearInterval(timer);
    chatTypingTimersRef.current.clear();
    chatTypingPendingsRef.current.clear();
    if (streamTypingRafRef.current) { clearTimeout(streamTypingRafRef.current); streamTypingRafRef.current = null; }
    for (const sr of streamRuntimeRef.current.values()) {
      if (sr.streamTypingRafRef.current) { clearTimeout(sr.streamTypingRafRef.current); sr.streamTypingRafRef.current = null; }
    }
  }, []);

  return {
    chatMessages, setChatMessages,
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading,
    chatFlowMode, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, expandedUserPromptIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    assistantTaskChecks,
    isDictating, isTranscribing,
    voiceModeOn,
    composerMode, setComposerMode,
    activeArtifact, setActiveArtifact,
    chatMessagesRef, aiThreadRef,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    toggleVoiceMode, setVoiceMode, sendVoiceTurn,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment, updateFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat, addChatResponseToGrid,
    replaySavedPromptResponse, applyProjectActions,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    cleanupDraftTimers,
  };
}
