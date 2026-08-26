import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { supabase } from "@/lib/supabase";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import {
  looksLikeDeflectingQuestion,
  isVideoQuestion,
  buildDirectVideoAnswerFromGrounding,
  extractSourceLinks,
  extractAiConnections,
  extractWebLinksFromText,
} from "@/lib/chat/chatResponseExtractors";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { resizeChatInputEl } from "@/lib/chat/resizeChatInput";
import { isDeviceLocalUrl } from "@/lib/chat/deviceLocalImages";
import { detectSocialPlatform, isSocialEmbedType } from "@/lib/media/socialEmbed";
import {
  orchestrateChatSend,
  buildAttachmentContext,
  type ChatSendParams,
} from "@/lib/ai/chatSendOrchestrator";
import type {
  PromptMessage,
  FocusedChatAttachment,
  CreateAction,
  OrchestratorResult,
} from "@/lib/lyknChat/chatTurnTypes";
import { type ChatArtifact, toArtifactEditContext } from "@/lib/ai/chatArtifacts";
import { resolveArtifactSendPlan } from "@/lib/ai/artifactSendPlan";
import { detectImageAsk, imagineSwitchNotice } from "@/lib/ai/studioModeIntent";
import { useChatDictation } from "@/hooks/useChatDictation";
import { useChatMarkdownComponents } from "@/components/lyknChat/chatMarkdownComponents";
import { AI_TEMPORARY_FAILURE_TEXT, AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import { forgetAppEdit } from "@/lib/apps/editApp";
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
  chatMode: boolean;
  chatRailVisible: boolean;

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
  replaySavedPromptResponse: (msg: PromptMessage) => void;
  applyProjectActions: (actions: CreateAction[]) => { created: number; failures: string[] };

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
    notesPagesRef, projectId, scopedProjectId, scopedProjectName, chatMode, chatRailVisible,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    getCachedKbText, getCachedWorkspaceSummary,
    setChatRailOpen, setChatRailVisible: setRailVisible, setChatMode: setMode,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setNotesOpen, setShowAttachMenu,
    studioModeInstructionsRef,
    researchSourcePrefsRef,
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
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  // Active "+" menu capability mode for the NEXT send. Steers the model to
  // use a specific tool (image gen / web search / deep research) for this
  // turn, then auto-clears once the message is sent.
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
      // Drop untagged / wrong-chat leftovers so a new board never inherits
      // another chat's open game.
      const restoredRaw = snap?.activeArtifact ?? null;
      const restoredSrc = String(restoredRaw?.sourceChatId || "").trim();
      const restored =
        restoredRaw && restoredSrc && restoredSrc === incoming ? restoredRaw : null;
      activeArtifactRef.current = restored;
      setActiveArtifactState(restored);
      if (restoredRaw && !restored) {
        patchThreadSnapshot(incoming, { activeArtifact: null });
      }

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

  // Typing/speech cleanup on unmount (dictation cleans itself up inside
  // useChatDictation)
  useEffect(() => () => {
    aiTypingRunRef.current += 1;
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

  // Working memory: refresh often enough that goals/open questions stick
  // across mid-length chats without summarizing every turn.
  const SUMMARIZE_EVERY_N_TURNS = 4;
  const maybeRunConversationSummary = useCallback(async (targetChatId?: string | null) => {
    // Operate on the stream's own board snapshot so summaries don't mix
    // conversation history across chats in a thread.
    const bid = targetChatId ? String(targetChatId) : null;
    const snap = bid ? ensureThreadSnapshot(bid) : null;
    if (snap) {
      snap.convoTurnsSinceSummary += 1;
      if (snap.convoTurnsSinceSummary < SUMMARIZE_EVERY_N_TURNS) return;
      if (snap.aiThread.length < 6) return;
      snap.convoTurnsSinceSummary = 0;
    } else {
      convoTurnsSinceSummaryRef.current += 1;
      if (convoTurnsSinceSummaryRef.current < SUMMARIZE_EVERY_N_TURNS) return;
      if (aiThreadRef.current.length < 6) return;
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

  // Markdown component config + per-msgId cache live in
  // chatMarkdownComponents.ts — identity/caching semantics are preserved
  // there (a fresh components object per render would break ReactMarkdown's
  // memoization).
  const buildChatMarkdownComponents = useChatMarkdownComponents(assistantTaskChecks, updateTaskCheck);

  const buildLyknChatContext = useCallback(() => "", []);
  const buildActionLyknChatContext = useCallback(() => "", []);

  const getAllYouTubeBlocks = useCallback(() => [] as Array<{ videoId: string; url: string; title: string }>, []);

  const buildYouTubeGrounding = useCallback(
    async (_apiBaseUrl: string, _userText: string, _parentSignal?: AbortSignal) => "",
    [],
  );

  const sanitizeAssistantResponse = useCallback((s: string) => String(s || "").trim(), []);

  const getKnowledgeBaseContext = useCallback(() => getCachedKbText(), [getCachedKbText]);

  const attachSourcesToBlock = useCallback((_responseBlockId: string, _sources: { title: string; url: string }[]) => {
    /* Canvas is gone — citations stay inline in the chat message. */
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

  const extractAndEmbedYouTubeUrls = useCallback(async (aiText: string, promptId: string, _responseBlockId: string | null): Promise<{ urls: { url: string; videoId: string }[]; cleanText: string }> => {
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
    setChatMessages((prev) => prev.map((m2) => m2.id === promptId ? { ...m2, aiYouTubeUrls: urls } : m2));
    return { urls, cleanText };
  }, [validateYouTubeVideoId]);

  const extractAndEmbedMediaItems = useCallback(async (aiText: string, _responseBlockId: string | null): Promise<{ cleanText: string; pulled: number }> => {
    const cleanText = aiText.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "").trimEnd();
    return { cleanText, pulled: 0 };
  }, []);

  const typeIntoAiResponseBlock = useCallback(async (_blockId: string, _fullText: string) => {
    /* Canvas is gone — streaming writes only to the chat thread. */
  }, []);

  const replaySavedPromptResponse = useCallback((_msg: PromptMessage) => {
    /* Replay used to drop the saved reply onto the grid. Chat already has it. */
  }, []);

  const applyProjectActions = useCallback((_actions: CreateAction[]) => {
    return { created: 0, failures: [] as string[] };
  }, []);

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
        canvas: {
          getCanvasState: () => ({ blocks: {}, blockOrder: [], focusedBrickIds: [], camera: { x: 0, y: 0, zoom: 1 }, gridSize: 24, wireConnections: [] }),
          updateBlock: () => {},
          deleteBlock: () => {},
          normalizeAiTextForBlock: (t: string) => String(t || "").replace(/\r\n?/g, "\n"),
          calcAiBubbleSize: () => ({ width: 0, height: 0 }),
          applyProjectActions,
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
    getAllYouTubeBlocks, buildYouTubeGrounding,
    sanitizeAssistantResponse,
    extractAndApplyTagActions,
    extractAndEmbedYouTubeUrls, extractAndEmbedMediaItems, attachSourcesToBlock,
    applyProjectActions,
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
        if (att.type === "folder" && ex.type === "folder" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
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
        // Bytes already on this device have no bucket to sign against — their
        // `lykn-blob://` url is already loadable, and the send path swaps it
        // for inline bytes so the model can see it too.
        if (!isDeviceLocalUrl(url) && (!url || (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube"))) {
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
        addFocusedAttachment({ id: makeAttId(), type: attType || inferUrlAttachmentType(url), url, name: String(att?.name || att?.title || title2 || url).trim(), mime: String(att?.mime || att?.mimeType || ""), size: Number(att?.size || 0), vaultTitle: title2, ...(videoId ? { videoId } : {}), ...(transcript ? { transcript } : {}), ...(pdfText ? { pdfText } : {}), ...storageMeta });
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
    activeArtifact, setActiveArtifact, linkArtifactApp,
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
    typeResponseIntoChat,
    replaySavedPromptResponse, applyProjectActions,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    cleanupDraftTimers,
  };
}
