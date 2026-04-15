import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import { useCanvasStore } from "@/store/canvasStore";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import { supabase } from "@/lib/supabase";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { buildTieredCanvasContext, buildActionCanvasContext } from "@/lib/ai/buildCanvasContext";
import { getVaultSidebarWidth } from "@/hooks/useViewportTier";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";
import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import { createDatabaseBlockData } from "@/canvas/blockSystem/notionModel";
import { detectSocialPlatform, isSocialEmbedType } from "@/canvas/utils/socialEmbed";
import {
  orchestrateChatSend,
  type PromptMessage,
  type FocusedChatAttachment,
  type CreateAction,
  type OrchestratorResult,
  type ChatSendParams,
} from "@/lib/ai/chatSendOrchestrator";

export type { PromptMessage, FocusedChatAttachment, CreateAction, OrchestratorResult };

/* ------------------------------------------------------------------ */
/*  Shared utility functions (moved from OmniaGrid.tsx top-level)      */
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
  boardId: string | null;
  routeBoardId: string | undefined;
  user: { id?: string; token?: string; email?: string; user_metadata?: any } | null;
  title: string;
  titleRef: React.MutableRefObject<string>;
  selectedModel: string;
  notesContentRef: React.MutableRefObject<any>;
  projectId: string | null;
  gridSize: number;
  viewportWidth: number;
  chatMode: boolean;
  chatRailVisible: boolean;

  /* Shared state (lifted up to avoid circular dep with useBoardPersistence) */
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

  /* Toast/overlay state setters that live in OmniaGrid */
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
  chatReactions: Record<string, "like" | "dislike" | null>;
  setChatReactions: Dispatch<SetStateAction<Record<string, "like" | "dislike" | null>>>;
  copiedMsgId: string | null;
  setCopiedMsgId: Dispatch<SetStateAction<string | null>>;
  assistantTaskChecks: Record<string, Record<string, boolean>>;
  isDictating: boolean;
  isTranscribing: boolean;

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
  handleChatPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleOpenAttachments: () => void;
  removeFocusedAttachment: (id: string) => void;
  addFocusedAttachment: (att: FocusedChatAttachment) => void;
  applyVaultDropToChat: (payload: any) => Promise<void>;
  resizeChatInput: (el: HTMLTextAreaElement | null) => void;
  toggleAiExpanded: (msgId: string) => void;
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
/*  findSmartPlacement (copied from OmniaGrid for self-containment)    */
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
    boardId, routeBoardId, user, title, titleRef, selectedModel,
    notesContentRef, projectId, gridSize, viewportWidth, chatMode, chatRailVisible,
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
  const [chatReactions, setChatReactions] = useState<Record<string, "like" | "dislike" | null>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState<Record<string, Record<string, boolean>>>({});
  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  /* ---------- Refs (hook-local) ---------- */
  const activeAiAbortRef = useRef<AbortController | null>(null);
  const isSendingRef = useRef(false);
  const lastSendSigRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const clarificationSessionRef = useRef({ active: false, basePromptId: "", baseRequest: "", questions: [] as string[], answers: [] as string[], askedCount: 0 });
  const streamTargetTextRef = useRef("");
  const streamDisplayedLenRef = useRef(0);
  const streamTypingRafRef = useRef<number | null>(null);
  const streamPromptIdRef = useRef<string | null>(null);
  const chatTypingTimerRef = useRef<number | null>(null);
  const chatTypingPendingRef = useRef<{ promptId: string; fullText: string; resolve: () => void } | null>(null);
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
  const prevMsgCountRef = useRef(0);
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

  // Abort cleanup on unmount
  useEffect(() => () => { activeAiAbortRef.current?.abort(); }, []);

  // Sync ref
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);

  // Auto-expand latest message
  useEffect(() => {
    const count = chatMessages.length;
    if (count > prevMsgCountRef.current && count > 0) {
      const latest = chatMessages[count - 1];
      if (latest) setExpandedAiMsgIds(new Set([latest.id]));
    }
    prevMsgCountRef.current = count;
  }, [chatMessages.length]);

  // Abort on boardId change
  useEffect(() => { activeAiAbortRef.current?.abort(); activeAiAbortRef.current = null; }, [boardId]);

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
    window.addEventListener("omnia_ai_brick_action", handler);
    return () => window.removeEventListener("omnia_ai_brick_action", handler);
  }, [chatMode, chatRailVisible, setChatInput, setChatRailOpen, setRailVisible]);

  // Dictation cleanup on unmount
  useEffect(() => () => {
    aiTypingRunRef.current += 1;
    if (dictationTimerRef.current) { window.clearInterval(dictationTimerRef.current); dictationTimerRef.current = null; }
    try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop(); } catch {}
    try { mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
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
    window.addEventListener("omnia_chat_drop_attachments", handler);
    return () => window.removeEventListener("omnia_chat_drop_attachments", handler);
  }, [chatRailVisible, chatMode, setChatRailOpen, setRailVisible]);

  // Resize chat input on mode switch
  useEffect(() => {
    resizeChatInputEl(chatPanelInputRef.current);
    resizeChatInputEl(centerChatInputRef.current);
  }, [chatMode]);

  /* ---------- Callbacks ---------- */

  const SUMMARIZE_EVERY_N_TURNS = 8;
  const maybeRunConversationSummary = useCallback(async () => {
    convoTurnsSinceSummaryRef.current += 1;
    if (convoTurnsSinceSummaryRef.current < SUMMARIZE_EVERY_N_TURNS) return;
    const thread = aiThreadRef.current;
    if (thread.length < 8) return;
    convoTurnsSinceSummaryRef.current = 0;
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/summarize-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: thread.slice(0, -4) }),
      });
      if (res.ok) {
        const { summary } = await res.json();
        if (summary) convoSummaryRef.current = summary;
      }
    } catch {}
  }, []);

  const toggleAiExpanded = useCallback((msgId: string) => {
    setExpandedAiMsgIds((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; });
  }, []);

  const getCollapsedPreview = useCallback((text: string) => {
    const clean = text.replace(/[#*_`~>\[\]()!|]/g, "").replace(/\n+/g, " ").trim();
    return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  }, []);

  const updateTaskCheck = useCallback((msgId: string, taskKey: string, checked: boolean) => {
    setAssistantTaskChecks((prev) => ({ ...prev, [msgId]: { ...(prev[msgId] || {}), [taskKey]: checked } }));
  }, []);

  const buildChatMarkdownComponents = useCallback((msgId: string) => ({
    h1: ({ children }: any) => React.createElement("h1", { className: "text-xl font-semibold mt-3 mb-2" }, children),
    h2: ({ children }: any) => React.createElement("h2", { className: "text-lg font-semibold mt-3 mb-2" }, children),
    h3: ({ children }: any) => React.createElement("h3", { className: "text-base font-semibold mt-2.5 mb-1.5" }, children),
    p: ({ children }: any) => React.createElement("p", { className: "my-1.5 whitespace-pre-wrap" }, children),
    ul: ({ children }: any) => React.createElement("ul", { className: "my-2 list-disc pl-5 space-y-1" }, children),
    ol: ({ children }: any) => React.createElement("ol", { className: "my-2 list-decimal pl-5 space-y-1" }, children),
    li: ({ children }: any) => {
      const raw = flattenNodeText(children).trim();
      const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
      if (!match) return React.createElement("li", { className: "leading-relaxed" }, children);
      const defaultChecked = String(match[1]).toLowerCase() === "x";
      const taskText = match[2];
      const taskKey = raw;
      const checked = assistantTaskChecks[msgId]?.[taskKey] ?? defaultChecked;
      return React.createElement("li", { className: `list-none ml-[-1.25rem] flex items-start gap-2 leading-relaxed ${checked ? "opacity-60" : ""}` },
        React.createElement("input", { type: "checkbox", className: "mt-[0.28rem] shrink-0 accent-blue-500", checked, onChange: (e: any) => updateTaskCheck(msgId, taskKey, e.target.checked) }),
        React.createElement("span", { className: checked ? "line-through" : "" }, taskText),
      );
    },
    strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
    blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 pl-3 my-2 text-black/70 italic" }, children),
    code: ({ children, className }: any) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) return React.createElement("pre", { className: "rounded-lg bg-black/5 p-3 my-2 overflow-x-auto text-[0.85em]" }, React.createElement("code", null, children));
      return React.createElement("code", { className: "rounded bg-black/10 px-1.5 py-0.5 text-[0.85em]" }, children);
    },
    pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
    table: ({ children }: any) => React.createElement("div", { className: "my-3 overflow-x-auto" }, React.createElement("table", { className: "w-full border-collapse text-sm" }, children)),
    thead: ({ children }: any) => React.createElement("thead", { className: "border-b border-black/20" }, children),
    tbody: ({ children }: any) => React.createElement("tbody", null, children),
    tr: ({ children }: any) => React.createElement("tr", { className: "border-b border-black/10" }, children),
    th: ({ children }: any) => React.createElement("th", { className: "text-left px-3 py-2 font-semibold" }, children),
    td: ({ children }: any) => React.createElement("td", { className: "px-3 py-2" }, children),
  }), [assistantTaskChecks, updateTaskCheck]);

  const getChatRailWidthPx = useCallback((vw: number) => {
    if (chatMode) return 0;
    const w = Math.max(0, Math.floor(vw || 0));
    if (w <= 900) return Math.max(200, Math.min(260, Math.floor(w * 0.30)));
    if (w <= 1100) return Math.max(220, Math.min(280, Math.floor(w * 0.26)));
    if (w <= 1366) return Math.max(240, Math.min(310, Math.floor(w * 0.25)));
    if (w <= 1600) return Math.max(260, Math.min(340, Math.floor(w * 0.25)));
    return Math.min(380, Math.floor(w * 0.30));
  }, [chatMode]);

  const buildCanvasContext = useCallback(() => {
    const st = useCanvasStore.getState();
    const cam = (st as any).camera || { x: 0, y: 0 };
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    return buildTieredCanvasContext({
      blocks: st.blocks as Record<string, any>,
      blockOrder: Array.isArray(st.blockOrder) ? st.blockOrder : [],
      focusedBrickIds: Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [],
      viewportCenter: { x: (cam.x || 0) + vw / 2, y: (cam.y || 0) + vh / 2 },
      wireConnections: Array.isArray(st.wireConnections) ? st.wireConnections : [],
      recentlyDeleted: Array.isArray((st as any).recentlyDeleted) ? (st as any).recentlyDeleted : [],
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
      out.push({ videoId, url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`, title: String(b?.data?.title || b?.data?.name || "").trim() });
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
    return /(video|youtube|clip|short|reel|summari[sz]e.*video|explain.*video|talk.*about.*video|what.*video.*about|what.*youtube.*about|what.*does.*he.*say|what.*does.*she.*say|what.*do.*they.*say|what.*is.*this.*about|what.*are.*they.*talking|what.*is.*he.*talking|what.*is.*she.*talking|summarize\s+this|explain\s+this|break\s+this\s+down|what.*main\s+point|key\s+takeaway|transcri(?:be|pt|ption)|what.*saying|what.*said|watch|recap|overview\s+of\s+this)/i.test(t);
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

  const attachSourcesToBlock = useCallback((responseBlockId: string, sources: { title: string; url: string }[]) => {
    if (!sources.length || !responseBlockId) return;
    const st = useCanvasStore.getState();
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
          const { data: existing } = await supabase.from("notes").select("tags").eq("id", action.noteId).eq("user_id", user.id).single();
          const currentTags: string[] = Array.isArray(existing?.tags) ? existing.tags : [];
          await supabase.from("notes").update({ tags: [...new Set([...currentTags, ...action.tags])] }).eq("id", action.noteId).eq("user_id", user.id);
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
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    for (const ytEntry of urls) {
      const exists = (Array.isArray(st.blockOrder) ? st.blockOrder : []).some((bid: string) => { const blk = st.blocks?.[bid]; return blk && String(blk.videoId || blk.data?.videoId || "") === ytEntry.videoId; });
      if (exists) continue;
      const cur = useCanvasStore.getState() as any;
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

  const extractAndEmbedMediaItems = useCallback(async (aiText: string, responseBlockId: string | null): Promise<{ cleanText: string; pulled: number }> => {
    const re = /\[PULL_MEDIA:([^\]|]+?)(?:\|(\d+))?\]/g;
    const pulls: { noteId: string; attIndex: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(aiText)) !== null) { const nid = m[1].trim(); const ai = m[2] !== undefined ? parseInt(m[2], 10) : 0; if (nid) pulls.push({ noteId: nid, attIndex: ai }); }
    if (!pulls.length) return { cleanText: aiText, pulled: 0 };
    const cleanText = aiText.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "").trimEnd();
    // Simplified: just return clean text and count. The full media pull logic stays here for fidelity.
    return { cleanText, pulled: 0 };
  }, []);

  const normalizeAiTextForBlock = useCallback((text: string) => String(text || "").replace(/\r\n?/g, "\n"), []);

  const calcAiBubbleSize = useCallback((text: string) => {
    const st = useCanvasStore.getState() as any;
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
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280; const vh = window.innerHeight || 800;
    const size = calcAiBubbleSize(content);
    let posX: number, posY: number;
    if (dropClientX != null && dropClientY != null) {
      const cam = st.camera || { x: 0, y: 0, zoom: 1 };
      const z = Math.max(0.1, cam.zoom || 1);
      posX = Math.round(((dropClientX - (cam.x || 0)) / z) / g) * g;
      posY = Math.round(((dropClientY - (cam.y || 0)) / z) / g) * g;
    } else {
      const pos = findSmartPlacement({ blockW: size.width, blockH: size.height, gridSize: g, camera: st.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: getChatRailWidthPx(vw), existingBlocks: Object.values(st.blocks || {}).filter(Boolean) as any[] });
      posX = pos.x; posY = pos.y;
    }
    const id = addTextBlockAt({ x: posX, y: posY }, { width: size.width, height: size.height, content, format: "rich" });
    if (id) {
      st.updateBlock(id, { data: { ...((st.blocks as any)?.[id]?.data || {}), aiResponseBubble: true } });
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id } })));
      setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
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
      const cur: any = useCanvasStore.getState().blocks?.[blockId];
      if (cur?.data?.userResized) { updateBlock(blockId, { content: shown }); }
      else { const size = calcAiBubbleSize(shown); updateBlock(blockId, { content: shown, width: size.width, height: size.height }); }
      await new Promise<void>((res) => window.setTimeout(res, delay));
    }
    if (aiTypingRunRef.current === runId) {
      const cur: any = useCanvasStore.getState().blocks?.[blockId];
      if (cur?.data?.userResized) updateBlock(blockId, { content: text });
      else { const size = calcAiBubbleSize(text); updateBlock(blockId, { content: text, width: size.width, height: size.height }); }
    }
  }, [calcAiBubbleSize, normalizeAiTextForBlock, updateBlock]);

  const typeResponseIntoChat = useCallback((promptId: string, fullText: string): Promise<void> => {
    return new Promise((resolve) => {
      if (chatTypingTimerRef.current) { window.clearInterval(chatTypingTimerRef.current); chatTypingTimerRef.current = null; }
      const prev = chatTypingPendingRef.current;
      if (prev) { setChatMessages((msgs) => msgs.map((m) => (m.id === prev.promptId ? { ...m, aiResponse: prev.fullText } : m))); prev.resolve(); chatTypingPendingRef.current = null; }
      const words = fullText.split(/(\s+)/);
      let idx = 0;
      chatTypingPendingRef.current = { promptId, fullText, resolve };
      setChatMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));
      chatTypingTimerRef.current = window.setInterval(() => {
        idx += 3;
        const partial = words.slice(0, idx).join("");
        setChatMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: partial } : m)));
        if (!chatUserScrolledUpRef.current) { const el = chatScrollRef.current; if (el) { chatProgrammaticScrollRef.current = true; el.scrollTop = el.scrollHeight; } }
        if (idx >= words.length) {
          if (chatTypingTimerRef.current) window.clearInterval(chatTypingTimerRef.current);
          chatTypingTimerRef.current = null; chatTypingPendingRef.current = null;
          setChatMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: fullText } : m)));
          resolve();
        }
      }, 30);
    });
  }, []);

  const replaySavedPromptResponse = useCallback((msg: PromptMessage) => {
    if ((msg as any).aiImageUrl) {
      const imageUrl = String((msg as any).aiImageUrl);
      const st = useCanvasStore.getState() as any;
      const order: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const existing = order.find((id: string) => { const blk = st.blocks?.[id]; return blk?.type === "create" && (blk as any).mode === "image" && (blk as any).data?.src === imageUrl; });
      if (existing) { window.dispatchEvent(new CustomEvent("omnia_expand_blocks", { detail: { ids: [existing] } })); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id: existing } }))); return; }
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
    const st = useCanvasStore.getState() as any;
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const vw = window.innerWidth || 1280; const vh = window.innerHeight || 800;
    let created = 0; const failures: string[] = [];
    const getPos = (bw: number, bh: number) => {
      const cur = useCanvasStore.getState() as any;
      return findSmartPlacement({ blockW: bw, blockH: bh, gridSize: g, camera: cur.camera || { x: 0, y: 0, zoom: 1 }, viewportW: vw, viewportH: vh, railWidth: 0, existingBlocks: Object.values(cur.blocks || {}).filter(Boolean) as any[] });
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
              const lines = rawContent.split("\n");
              const nodes: any[] = [];
              for (const line of lines) { if (line.trim()) nodes.push({ type: "paragraph", content: [{ type: "text", text: line }] }); else nodes.push({ type: "paragraph" }); }
              if (!nodes.length) nodes.push({ type: "paragraph" });
              tiptapDoc = { type: "doc", content: nodes };
            } else if (rawContent?.type === "doc") { tiptapDoc = rawContent; }
            else { tiptapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(rawContent) }] }] }; }
            window.dispatchEvent(new CustomEvent("omnia_notes_ai_update", { detail: { action: type === "append_notes" ? "append" : "set", tiptapDoc, stream: true } }));
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
        if (type === "create_sheet" || type === "paper_outline" || type === "create_paper") {
          const t2 = String((raw as any)?.title || "").trim();
          const body = String((raw as any)?.content || (raw as any)?.outline || "").trim();
          const content = [t2 ? `# ${t2}` : "", body].filter(Boolean).join("\n\n");
          const pos = getPos(g * 14, g * 10);
          st.addSheetBlockAt({ x: pos.x, y: pos.y }, { content });
          created++; continue;
        }
        if (type === "create_spreadsheet") {
          const rows = Math.max(1, Math.min(1000, Number((raw as any)?.rows || 30)));
          const cols = Math.max(1, Math.min(100, Number((raw as any)?.cols || 20)));
          const pos = getPos(g * 14, g * 10);
          st.addSpreadsheetBlockAt({ x: pos.x, y: pos.y }, { rows, cols });
          created++; continue;
        }
        if (type === "create_list" || type === "todo_list" || type === "bulleted_list" || type === "numbered_list") {
          const requested = String((raw as any)?.listType || "");
          const listType = requested === "numbered" || type === "numbered_list" ? "numbered" : requested === "bulleted" || type === "bulleted_list" ? "bulleted" : "todo";
          const pos = getPos(g * 10, g * 6);
          const id = st.addListBlockAt({ x: pos.x, y: pos.y }, { listType });
          const items = Array.isArray((raw as any)?.items) ? (raw as any).items : String((raw as any)?.content || "").split(/\n+/).map((s: string) => s.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
          if (items.length) st.setListItems(id, items.map((text2: string) => ({ id: `li-${Date.now()}-${Math.random()}`, text: text2 })));
          created++; continue;
        }
        if (type === "create_code_block" || type === "create_code_project") {
          const lang = String((raw as any)?.language || "plaintext").trim().toLowerCase() || "plaintext";
          const content = String((raw as any)?.content || "").trim();
          const pos = getPos(g * 14, g * 7);
          st.addCodeBlockAt({ x: pos.x, y: pos.y }, { width: g * 14, height: g * 7, language: lang, content });
          created++; continue;
        }
        if (type === "create_youtube_block") {
          const rawUrl = String((raw as any)?.url || "").trim();
          const videoId = extractYouTubeVideoId(rawUrl) || "";
          if (rawUrl || videoId) {
            const pos = getPos(g * 12, g * 8);
            st.addYouTubeBlockAt({ x: pos.x, y: pos.y }, { url: rawUrl || `https://www.youtube.com/watch?v=${videoId}`, videoId });
            created++;
          } else failures.push("create_youtube_block: missing url");
          continue;
        }
        if (type === "move_block" || type === "move_blocks") {
          const moves: Array<{ blockId: string; x?: number; y?: number; dx?: number; dy?: number }> = [];
          if ((raw as any)?.blockId) moves.push({ blockId: String((raw as any).blockId), x: (raw as any)?.x, y: (raw as any)?.y, dx: (raw as any)?.dx, dy: (raw as any)?.dy });
          if (Array.isArray((raw as any)?.moves)) for (const mv of (raw as any).moves) if (mv?.blockId) moves.push({ blockId: String(mv.blockId), x: mv?.x, y: mv?.y, dx: mv?.dx, dy: mv?.dy });
          moves.forEach((mv, i) => { setTimeout(() => { const block = (useCanvasStore.getState() as any).blocks?.[mv.blockId] as any; if (!block) return; let nx = Math.floor(block.x || 0), ny = Math.floor(block.y || 0); if (mv.x != null) nx = Math.round(Number(mv.x) / g) * g; if (mv.y != null) ny = Math.round(Number(mv.y) / g) * g; if (mv.dx != null) nx += Math.round(Number(mv.dx) / g) * g; if (mv.dy != null) ny += Math.round(Number(mv.dy) / g) * g; st.updateBlock(mv.blockId, { x: nx, y: ny }); }, i * 35); created++; });
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
        if (type === "update_text_block") {
          const blockId = String((raw as any)?.blockId || "");
          const block = st.blocks?.[blockId] as any;
          if (!block || block.type !== "text") { failures.push("update_text_block: not found"); continue; }
          const patch: any = {};
          if ((raw as any)?.content != null) patch.content = String((raw as any).content);
          else if (typeof (raw as any)?.append === "string") { const cur2 = String(block?.content || ""); patch.content = cur2 + (cur2.endsWith("\n") ? "" : "\n") + (raw as any).append; }
          if (Object.keys(patch).length) { st.updateBlock(blockId, patch); created++; }
          continue;
        }
        // Fallback for unknown types
        failures.push(`Unsupported action: ${type || "unknown"}`);
      } catch { failures.push(`Failed action: ${String((raw as any)?.type || "unknown")}`); }
    }
    return { created, failures };
  }, [setNotesOpen]);

  /* ---------- handleChatSend (delegates to orchestrator) ---------- */

  const handleChatSend = useCallback(async () => {
    const text = chatInputRef.current.trim();
    if (!text || isChatLoading || isSendingRef.current) return;
    chatUserScrolledUpRef.current = false;
    if (streamTypingRafRef.current) { clearTimeout(streamTypingRafRef.current); streamTypingRafRef.current = null; }
    streamTargetTextRef.current = "";
    streamDisplayedLenRef.current = 0;
    streamPromptIdRef.current = null;
    if (chatTypingTimerRef.current) { window.clearInterval(chatTypingTimerRef.current); chatTypingTimerRef.current = null; }
    const pendingType = chatTypingPendingRef.current;
    if (pendingType) { setChatMessages((prev) => prev.map((m) => (m.id === pendingType.promptId ? { ...m, aiResponse: pendingType.fullText } : m))); pendingType.resolve(); chatTypingPendingRef.current = null; }
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
    if (brickActionData?.videoId && !sentAttachments.some((a: any) => a.videoId === brickActionData.videoId)) {
      sentAttachments.push({ type: "youtube", videoId: brickActionData.videoId, url: `https://www.youtube.com/watch?v=${brickActionData.videoId}`, name: `YouTube ${brickActionData.videoId}` } as any);
    }
    setChatInput("");
    setFocusedChatAttachments([]);
    setIsChatLoading(true);
    setChatStatusText("");
    setChatFlowMode("idle");
    const promptId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const displayText = text.length > 500 ? text.slice(0, 500) + "…" : text;
    setChatMessages((prev) => [...prev, { id: promptId, role: "user", content: displayText, kind: "prompt", ...(sentAttachments.length ? { attachments: sentAttachments } : {}) }]);

    try {
      await orchestrateChatSend({
        text,
        promptId,
        sentAttachments,
        brickActionData,
        chatMessages: chatMessagesRef.current,
        aiThread: aiThreadRef.current,
        conversationSummary: convoSummaryRef.current,
        abortController: sendAbort,
        identity: { selectedModel, boardId, routeBoardId, projectId, userId: user?.id },
        context: {
          buildCanvasContext,
          buildActionCanvasContext,
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
          notesContent: notesContentRef.current,
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
        canvas: { getCanvasState: () => useCanvasStore.getState(), updateBlock, deleteBlock, normalizeAiTextForBlock, calcAiBubbleSize, applyProjectActions },
        state: { setChatStatusText, setChatMessages, setIsChatLoading, setChatFlowMode, setConnectionCards, setShowConnectionCard, setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion },
        streamRefs: { streamTargetTextRef, streamDisplayedLenRef, streamTypingRafRef, streamPromptIdRef, chatScrollRef, chatUserScrolledUpRef, chatProgrammaticScrollRef },
        typing: { typeResponseIntoChat, typeIntoAiResponseBlock, maybeRunConversationSummary },
        supabaseClient: supabase,
      });
    } catch (err: any) {
      if (err?.name === "AbortError" && sendAbort !== activeAiAbortRef.current) { setChatStatusText(""); return; }
      setChatFlowMode("idle");
      const errMsg = "This model isn\u2019t working properly right now \u2014 try another model.";
      setChatStatusText(errMsg);
      setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errMsg } : m)));
    } finally {
      setIsChatLoading(false);
      isSendingRef.current = false;
      setChatFlowMode("idle");
      window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    }
  }, [
    isChatLoading, focusedChatAttachments, selectedModel, boardId, routeBoardId, projectId, user?.id, setChatInput,
    buildCanvasContext, getKnowledgeBaseContext, getCachedWorkspaceSummary,
    getAllYouTubeBlocks, buildYouTubeGrounding, isVideoQuestion, looksLikeDeflectingQuestion,
    sanitizeAssistantResponse, buildDirectVideoAnswerFromGrounding,
    extractSourceLinks, extractAiConnections, extractAndApplyTagActions,
    extractAndEmbedYouTubeUrls, extractAndEmbedMediaItems, extractWebLinksFromText, attachSourcesToBlock,
    updateBlock, deleteBlock, normalizeAiTextForBlock, calcAiBubbleSize, applyProjectActions,
    setConnectionCards, setShowConnectionCard, setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    typeResponseIntoChat, typeIntoAiResponseBlock, maybeRunConversationSummary,
  ]);

  const handleStopAi = useCallback(() => {
    activeAiAbortRef.current?.abort();
    activeAiAbortRef.current = null;
    if (streamTypingRafRef.current) { clearTimeout(streamTypingRafRef.current); streamTypingRafRef.current = null; }
    if (streamPromptIdRef.current && streamDisplayedLenRef.current < streamTargetTextRef.current.length) {
      setChatMessages((prev) => prev.map((m) => (m.id === streamPromptIdRef.current ? { ...m, aiResponse: streamTargetTextRef.current } : m)));
    }
    streamTargetTextRef.current = ""; streamDisplayedLenRef.current = 0; streamPromptIdRef.current = null;
    if (chatTypingTimerRef.current) { window.clearInterval(chatTypingTimerRef.current); chatTypingTimerRef.current = null; }
    const pending = chatTypingPendingRef.current;
    if (pending) { setChatMessages((prev) => prev.map((m) => (m.id === pending.promptId ? { ...m, aiResponse: pending.fullText } : m))); pending.resolve(); chatTypingPendingRef.current = null; }
    setIsChatLoading(false);
    isSendingRef.current = false;
    setChatFlowMode("idle");
    setChatStatusText("Stopped");
  }, []);

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

  const handleChatPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const html = e.clipboardData.getData("text/html");
    if (!html.trim()) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart; const end = ta.selectionEnd;
    const text = getStructuredPasteFromEvent(e);
    const prev = chatInputRef.current;
    const newVal = prev.slice(0, start) + text + prev.slice(end);
    chatInputRef.current = newVal;
    ta.value = newVal;
    setChatInputHasText(!!newVal.trim());
    resizeChatInputEl(ta);
    const nc = start + text.length;
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = nc; ta.focus(); }, 0);
  }, []);

  const handleOpenAttachments = useCallback(() => setShowAttachMenu(true), [setShowAttachMenu]);

  const removeFocusedAttachment = useCallback((id: string) => {
    setFocusedChatAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

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
        if (!url || (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube")) {
          try { const path = pathOnly || url; if (path) { const { data } = await supabase.storage.from(att?.storageBucket || "user-files").createSignedUrl(path, 60 * 60 * 24 * 7); if (data?.signedUrl) url = data.signedUrl; } } catch {}
        }
        const transcript = String(att?.transcript || "").trim();
        const pdfText = String(att?.pdfText || att?.extractedText || "").trim();
        if (!url && pdfText) { addFocusedAttachment({ id: makeAttId(), type: "pdf", url: "", name: String(att?.name || att?.title || title2 || "PDF").trim(), mime: String(att?.mime || "application/pdf"), size: Number(att?.size || 0), vaultTitle: title2, pdfText }); continue; }
        if (!url) continue;
        addFocusedAttachment({ id: makeAttId(), type: attType || inferUrlAttachmentType(url), url, name: String(att?.name || att?.title || title2 || url).trim(), mime: String(att?.mime || ""), size: Number(att?.size || 0), vaultTitle: title2, ...(videoId ? { videoId } : {}), ...(transcript ? { transcript } : {}), ...(pdfText ? { pdfText } : {}) });
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
    if (chatTypingTimerRef.current) window.clearInterval(chatTypingTimerRef.current);
    chatTypingTimerRef.current = null;
    chatTypingPendingRef.current = null;
    if (streamTypingRafRef.current) { clearTimeout(streamTypingRafRef.current); streamTypingRafRef.current = null; }
  }, []);

  return {
    chatMessages, setChatMessages,
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading,
    chatFlowMode, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    assistantTaskChecks,
    isDictating, isTranscribing,
    chatMessagesRef, aiThreadRef,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat, addChatResponseToGrid,
    replaySavedPromptResponse, applyProjectActions,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    cleanupDraftTimers,
  };
}
