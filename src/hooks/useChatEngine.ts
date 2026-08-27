// useChatEngine — the chat engine facade. Owns the canonical Chat engine API
// the UI consumes: send/stop, per-thread stream state, composer
// input, voice-mode flag, artifact panel state, and message-list projections.
// Focused subsystems it composes:
//   • useChatComposerAttachments — staged-attachment state + paste/drop ingress
//   • useChatDictation           — mic → Whisper → composer
//   • useChatThreadProjection    — chatThreadRuntime snapshots → React + typewriter
//   • chatThreadRuntime          — per-board snapshots for background streams
//   • chatSendOrchestrator       — the send pipeline (stage modules under lib/ai)
// Client-side stream state has ONE owner: the per-send stream cursor minted
// in handleChatSend (registered in streamRuntimeRef per board so handleStopAi
// can flush the right stream).
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { resizeChatInputEl } from "@/lib/chat/resizeChatInput";
import {
  orchestrateChatSend,
  buildAttachmentContext,
} from "@/lib/ai/chatSendOrchestrator";
import type {
  PromptMessage,
  FocusedChatAttachment,
  CreateAction,
  OrchestratorResult,
} from "@/lib/lyknChat/chatTurnTypes";
import type { CachedYouTubeTranscript } from "@/lib/ai/chatTranscription";
import { type ChatArtifact, toArtifactEditContext } from "@/lib/ai/chatArtifacts";
import { resolveArtifactSendPlan } from "@/lib/ai/artifactSendPlan";
import { detectImageAsk, imagineSwitchNotice } from "@/lib/ai/studioModeIntent";
import { useChatDictation } from "@/hooks/useChatDictation";
import { useChatComposerAttachments } from "@/hooks/useChatComposerAttachments";
import { useChatThreadProjection } from "@/hooks/useChatThreadProjection";
import { useChatMarkdownComponents } from "@/components/lyknChat/chatMarkdownComponents";
import { AI_TEMPORARY_FAILURE_TEXT, AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import { forgetAppEdit } from "@/lib/apps/editApp";
import {
  bindThreadStateCallbacks,
  ensureThreadSnapshot,
  getActiveThreadChatId,
  getThreadSnapshot,
  patchThreadSnapshot,
  registerStreamAbortController,
} from "@/lib/chat/chatThreadRuntime";

export type { PromptMessage, FocusedChatAttachment, CreateAction, OrchestratorResult };

/** "+" menu capability mode applied to the next chat send. */
// Artifact kinds buildable from the "+" → Create submenu (claude.ai-style).
export type ArtifactKind = "deck" | "study" | "document" | "worksheet" | "spreadsheet" | "chart" | "diagram" | "webapp";
export type ComposerMode = "none" | "image" | "web" | "research" | `create:${ArtifactKind}`;

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
  projectId: string | null;
  /** LYKN project the user explicitly scoped the chat to via the "+" menu. */
  scopedProjectId?: string | null;
  /** Display name of the scoped project, surfaced to the model verbatim. */
  scopedProjectName?: string | null;

  /* Shared state (lifted up to avoid circular dep with useLyknChatPersistence) */
  chatMessages: PromptMessage[];
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  convoSummaryRef: React.MutableRefObject<string>;
  convoTurnsSinceSummaryRef: React.MutableRefObject<number>;

  /* AI store selectors */
  getCachedKbText: () => string;
  getCachedWorkspaceSummary: () => { full?: string; media?: string; boards?: string } | null;

  /* Toast/overlay state setters that live in LyknChat */
  setConnectionCards: Dispatch<SetStateAction<Array<{ title: string; sourceType: "board" | "media"; reason: string }>>>;
  setShowConnectionCard: Dispatch<SetStateAction<boolean>>;
  setMediaSuggestions: Dispatch<SetStateAction<Array<{ title: string; reason: string; noteId: string }>>>;
  setSelectedMediaIds: Dispatch<SetStateAction<Set<string>>>;
  setShowMediaSuggestion: Dispatch<SetStateAction<boolean>>;
  setShowAttachMenu: Dispatch<SetStateAction<boolean>>;

  /** Studio mode pages (Build / Imagine / Research): mode system prompt to
   *  ship with every send while the mode session is active. Read at
   *  send-time so it always reflects the current pill selection. */
  studioModeInstructionsRef?: React.MutableRefObject<string>;
  /** Studio Research source dropdown — read at send-time. */
  researchSourcePrefsRef?: React.MutableRefObject<string>;
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

  /* Artifact open in the preview popup. The model refines
   * THIS artifact in place when the user sends an edit request. */
  activeArtifact: ChatArtifact | null;
  setActiveArtifact: (artifact: ChatArtifact | null) => void;
  /** Mark a chat as editing an installed app, so its builds update that app. */
  linkArtifactApp: (chatId: string, appId: string | null) => void;

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
  youtubeTranscriptCacheRef: React.MutableRefObject<Record<string, CachedYouTubeTranscript>>;

  /* Callbacks */
  handleChatSend: () => Promise<void>;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
  /* Voice Mode controls. */
  toggleVoiceMode: () => void;
  setVoiceMode: (on: boolean) => void;
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

  /* Helpers for board persistence */
  convoSummaryRef: React.MutableRefObject<string>;
  convoTurnsSinceSummaryRef: React.MutableRefObject<number>;

  /** Call in onDraftEffectCleanup to clear typing timers owned by the hook */
  cleanupDraftTimers: () => void;
}

/* ------------------------------------------------------------------ */
/*  The hook                                                           */
/* ------------------------------------------------------------------ */

export function useChatEngine(deps: UseChatEngineDeps): UseChatEngineReturn {
  const {
    chatId, routeChatId, user, title, titleRef, selectedModel, customModelId,
    projectId, scopedProjectId, scopedProjectName,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    getCachedKbText, getCachedWorkspaceSummary,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setShowAttachMenu,
    studioModeInstructionsRef,
    researchSourcePrefsRef,
  } = deps;

  /* ---------- State (hook-local) ---------- */
  const chatInputRef = useRef("");
  const [chatInputHasText, setChatInputHasText] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatFlowMode, setChatFlowMode] = useState<"idle" | "clarifying" | "generating">("idle");
  const [chatStatusText, setChatStatusText] = useState("");
  const [expandedAiMsgIds, setExpandedAiMsgIds] = useState<Set<string>>(new Set());
  const [expandedUserPromptIds, setExpandedUserPromptIds] = useState<Set<string>>(new Set());
  const [chatReactions, setChatReactions] = useState<Record<string, "like" | "dislike" | null>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState<Record<string, Record<string, boolean>>>({});
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  const [activeArtifact, setActiveArtifactState] = useState<ChatArtifact | null>(null);
  const activeArtifactRef = useRef<ChatArtifact | null>(null);
  // Chats that are editing an installed app, so each new build for one is
  // recognisable as that app's next version. Cleared the moment a turn asks
  // for a different deliverable — see the send path.
  const artifactAppRef = useRef<Map<string, string>>(new Map());
  const setActiveArtifact = useCallback((artifact: ChatArtifact | null) => {
    const bid = String(chatId || routeChatId || "").trim();
    // Never open/persist an unscoped panel — untagged artifacts used to leak
    // into the next chat and force surgical-edit / "Sky Tower" narration.
    if (artifact && !bid) return;
    let next = artifact ? { ...artifact, sourceChatId: bid } : null;
    if (next) {
      // A rebuild comes back as a fresh object with no memory of the app it
      // came from. The chat carries that across for it, so the build that
      // lands after "add a dark mode" still installs over the same app.
      const app = next.installedAppId || artifactAppRef.current.get(bid) || "";
      if (app) {
        next = { ...next, installedAppId: app };
        artifactAppRef.current.set(bid, app);
      }
    }
    activeArtifactRef.current = next;
    setActiveArtifactState(next);
    if (bid) patchThreadSnapshot(bid, { activeArtifact: next });
  }, [chatId, routeChatId]);

  /**
   * Tie a chat to an installed app without opening anything.
   *
   * Reopening a conversation restores its last build from the messages, and
   * that copy has no idea it was an app — seeding here is what keeps the panel
   * offering to update the app rather than install a second copy of it.
   */
  const linkArtifactApp = useCallback((forChatId: string, appId: string | null) => {
    const bid = String(forChatId || "").trim();
    if (!bid) return;
    if (appId) artifactAppRef.current.set(bid, appId);
    else artifactAppRef.current.delete(bid);
  }, []);

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
  const pendingAiBrickActionRef = useRef(false);
  const pendingBrickActionDataRef = useRef<{ imageUrl?: string; videoId?: string } | null>(null);
  const youtubeTranscriptCacheRef = useRef<Record<string, CachedYouTubeTranscript>>({});
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

  /* ---------- Composer attachments (staged for the next send) ---------- */
  const {
    focusedChatAttachments,
    setFocusedChatAttachments,
    addFocusedAttachment,
    removeFocusedAttachment,
    updateFocusedAttachment,
    handleChatPaste,
    applyVaultDropToChat,
  } = useChatComposerAttachments({
    userId: user?.id,
    chatInputRef,
    setChatInputHasText,
    chatPanelInputRef,
  });

  /* ---------- Dictation (mic button → Whisper → composer) ---------- */
  const { isDictating, isTranscribing, handleDictateToggle } = useChatDictation({
    chatInputRef,
    setChatInput,
  });

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

  /* ---------- Thread projection (snapshots → React + typewriter) ---------- */
  const {
    patchThreadMessages,
    typeResponseIntoChat,
    maybeRunConversationSummary,
    cleanupDraftTimers: cleanupProjectionTimers,
    flushTypingForStop,
  } = useChatThreadProjection({
    chatId, routeChatId,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    chatInputRef, chatInputHasText, setChatInput,
    isChatLoading, setIsChatLoading,
    chatStatusText, setChatStatusText,
    chatFlowMode, setChatFlowMode,
    activeAiAbortRef, streamChatIdRef,
    activeArtifactRef, setActiveArtifactState,
    setExpandedAiMsgIds,
    chatScrollRef, chatUserScrolledUpRef, chatProgrammaticScrollRef,
  });

  // Brick action events (NotesPanel "ask AI about this brick")
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.prompt) return;
      setChatInput(detail.prompt);
      pendingBrickActionDataRef.current = { imageUrl: detail.imageUrl || undefined, videoId: detail.videoId || undefined };
      pendingAiBrickActionRef.current = true;
    };
    window.addEventListener("lyknchat_ai_brick_action", handler);
    return () => window.removeEventListener("lyknchat_ai_brick_action", handler);
  }, [setChatInput]);

  // Speech cleanup on unmount (dictation cleans itself up inside
  // useChatDictation)
  useEffect(() => () => {
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
    };
    window.addEventListener("lyknchat_chat_drop_attachments", handler);
    return () => window.removeEventListener("lyknchat_chat_drop_attachments", handler);
  }, [setChatMessages]);

  // When a file finishes uploading to storage, back-fill the chat
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

  // Size the composer inputs once they mount
  useEffect(() => {
    resizeChatInputEl(chatPanelInputRef.current);
    resizeChatInputEl(centerChatInputRef.current);
  }, []);

  /* ---------- Callbacks ---------- */

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

  // Markdown component config + per-msgId cache live in
  // chatMarkdownComponents.ts — identity/caching semantics are preserved
  // there (a fresh components object per render would break ReactMarkdown's
  // memoization).
  const buildChatMarkdownComponents = useChatMarkdownComponents(assistantTaskChecks, updateTaskCheck);

  const getKnowledgeBaseContext = useCallback(() => getCachedKbText(), [getCachedKbText]);

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

    // Browser work is the MODEL's call now, not a classifier's. The model sees
    // local_browser_agent (name + description) in its tool schemas and decides
    // for itself when a task belongs in the browser — no pre-send intercept,
    // no keyword walls, no offer round-trip. Chat answers everything else.

    // Chat (and any non-Imagine send) must not generate images. Instant
    // redirect so "make me a logo" never reaches the stream — Imagine
    // is the only lane that arms lykn_generate_image / the batch canvas.
    if (sendMode !== "image" && detectImageAsk(text)) {
      const notice = imagineSwitchNotice();
      setChatInput("");
      bindThreadStateCallbacks(streamChatId, {
        setChatStatusText,
        setChatMessages,
        setIsChatLoading,
        setChatFlowMode,
      }).setChatMessages((prev): PromptMessage[] => [...prev, {
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        content: text,
        kind: "prompt",
        createdAt: new Date().toISOString(),
        aiResponse: notice,
      }]);
      try {
        const snap = ensureThreadSnapshot(streamChatId);
        snap.aiThread.push({ role: "user", content: text });
        snap.aiThread.push({ role: "assistant", content: notice });
        if (snap.aiThread.length > 40) snap.aiThread.splice(0, snap.aiThread.length - 40);
      } catch { /* the thread is a convenience; never fail a send over it */ }
      return;
    }

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
          const atts = Array.isArray(m.attachments) ? m.attachments || [] : [];
          const attCtx = atts.length ? buildAttachmentContext(atts) : "";
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
      const thisChatId = String(streamChatId || "").trim();
      // Build/refine/discuss intent classification lives in
      // src/lib/ai/artifactSendPlan.ts (pure; extracted verbatim from this
      // block). The side effects driven by its outputs stay here below.
      const {
        createArmed,
        typedNewDeliverableAsk,
        insistFreshBuildAsk,
        createToolName,
        openTemplateRestyleAsk,
        buildModeFresh,
        refiningOpenArtifact,
        discussOpenArtifact,
        effectiveComposerMode,
      } = resolveArtifactSendPlan({
        text,
        sendMode,
        streamChatId,
        editArtifact,
        studioModeInstructions: studioModeInstructionsRef?.current,
        sentAttachments,
        aiThread: sendSnap.aiThread,
        linkedAppId: artifactAppRef.current.get(thisChatId),
      });
      // Commissioning something new, rather than the open build's next
      // version: whatever comes back is its own software, so it must not
      // install over the app this chat had been editing.
      if (createArmed && !refiningOpenArtifact && thisChatId) {
        artifactAppRef.current.delete(thisChatId);
        forgetAppEdit(thisChatId);
      }
      if (
        (buildModeFresh ||
          typedNewDeliverableAsk ||
          insistFreshBuildAsk ||
          (createToolName && !refiningOpenArtifact)) &&
        editArtifact &&
        !openTemplateRestyleAsk
      ) {
        console.log(
          `🧑‍💻 Create/Build: starting fresh (ignoring open "${String(editArtifact.title || "").slice(0, 60)}")`,
        );
      }
      await orchestrateChatSend({
        text,
        promptId,
        composerMode: effectiveComposerMode,
        // Studio mode session (Build / Imagine / Research): per-mode system
        // prompt injected server-side into [ACTIVE_MODE] on every turn.
        modeInstructions: studioModeInstructionsRef?.current || undefined,
        researchSourcePref: researchSourcePrefsRef?.current || undefined,
        // Thread the open panel for surgical edits while Create/Build is armed,
        // including clear follow-up mutations in a sticky Build session. Chat
        // mode sends a discuss-only stub so discussion cannot patch it.
        activeArtifact: refiningOpenArtifact
          ? toArtifactEditContext(editArtifact as ChatArtifact)
          : discussOpenArtifact
            ? {
                toolName: String(editArtifact.toolName || ""),
                title: String(editArtifact.title || "Untitled"),
                sourceChatId: String(editArtifact.sourceChatId || "").trim() || undefined,
                discussOnly: true,
                templateType:
                  typeof editArtifact.templateType === "string"
                    ? editArtifact.templateType
                    : undefined,
              }
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
          userToken: user?.token,
        },
        context: {
          getKnowledgeBaseContext,
          getCachedWorkspaceSummary,
          titleRef,
        },
        youtube: {
          youtubeTranscriptCache: youtubeTranscriptCacheRef.current,
        },
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
          maybeRunConversationSummary: () => maybeRunConversationSummary(streamChatId),
        },
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
      if (activeAiAbortRef.current && activeAiAbortRef.current !== sendAbort) {
        return;
      }
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
    focusedChatAttachments, setFocusedChatAttachments, selectedModel, customModelId, chatId, routeChatId, projectId, scopedProjectId, scopedProjectName, user?.id, user?.token, setChatInput, setComposerMode,
    getKnowledgeBaseContext, getCachedWorkspaceSummary,
    setConnectionCards, setShowConnectionCard, setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    typeResponseIntoChat, maybeRunConversationSummary,
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
    flushTypingForStop(bid);
    if (bid) {
      sendingBoardsRef.current.delete(bid);
      streamRuntimeRef.current.delete(bid);
      patchThreadSnapshot(bid, { isChatLoading: false });
    }
    isSendingRef.current = sendingBoardsRef.current.size > 0;
    setIsChatLoading(false);
    setChatFlowMode("idle");
    setChatStatusText("Stopped");
  }, [chatId, routeChatId, patchThreadMessages, flushTypingForStop]);

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

  const handleOpenAttachments = useCallback(() => setShowAttachMenu(true), [setShowAttachMenu]);

  const resizeChatInput = useCallback(resizeChatInputEl, []);

  // Auto-send effect for brick actions
  useEffect(() => {
    if (pendingAiBrickActionRef.current && chatInputRef.current.trim()) {
      pendingAiBrickActionRef.current = false;
      handleChatSend();
    }
  }, [chatInputHasText, handleChatSend]);

  const cleanupDraftTimers = useCallback(() => {
    cleanupProjectionTimers();
    for (const sr of streamRuntimeRef.current.values()) {
      if (sr.streamTypingRafRef.current) { clearTimeout(sr.streamTypingRafRef.current); sr.streamTypingRafRef.current = null; }
    }
  }, [cleanupProjectionTimers]);

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
    activeArtifact, setActiveArtifact, linkArtifactApp,
    chatMessagesRef, aiThreadRef,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    toggleVoiceMode, setVoiceMode,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment, updateFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    cleanupDraftTimers,
  };
}
